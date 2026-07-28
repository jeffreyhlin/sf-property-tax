/**
 * On-demand deed lookup for a single parcel.
 *
 * The site pre-seeds a few hundred parcels as static JSON, which covers the
 * story and the leaderboards. Everything else — the other ~206,600 parcels a
 * reader might click — is fetched here, on the same origin, when they click it.
 *
 * Why a function rather than calling the county from the browser: the recorder
 * sends no CORS headers and checks Origin, Referer and User-Agent, so a page
 * script cannot read the response. This runs server-side, where those are ours
 * to set.
 *
 * Being the county's only visible caller carries an obligation. Three things
 * keep this from turning a front page of traffic into a load test:
 *
 *   1. Static files win first. The app only reaches this on a 404, so seeded
 *      parcels never touch the county at all.
 *   2. The CDN caches every answer for a day. A parcel that goes viral is one
 *      upstream request, not thousands.
 *   3. One in-flight lookup per instance, and a hard cap on how fast they can
 *      follow each other.
 */

import { fetchRecords } from '../../worker/recorder-api.mjs';

// Netlify may hold an instance warm between requests, so module scope is a
// real (if small) throttle rather than a no-op.
let lastFetchAt = 0;
let inflight = 0;
const MIN_GAP_MS = 900;
const MAX_INFLIGHT = 2;

const json = (status, body, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds
        ? // s-maxage is the CDN's copy; browsers revalidate sooner.
          `public, max-age=300, s-maxage=${cacheSeconds}, stale-while-revalidate=604800`
        : 'no-store',
    },
  });

/** SF APNs are a 4-digit block plus a 3-4 character lot. Reject anything else. */
function normalizeApn(raw) {
  const clean = String(raw || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return /^\d{4}[0-9A-Z]{3,4}$/.test(clean) ? clean : null;
}

export default async function handler(request) {
  const apn = normalizeApn(new URL(request.url).searchParams.get('apn'));
  if (!apn) return json(400, { error: 'pass ?apn=<blocklot>, e.g. 2992059' });

  if (inflight >= MAX_INFLIGHT) {
    // Better to send the reader to the county's own search than to queue up
    // behind other lookups and time out.
    return json(503, { apn, busy: true, records: [] });
  }
  // Claim the slot and the time window synchronously. Checking here and
  // incrementing after an await lets every concurrent caller past the check
  // while the count is still zero, which is no throttle at all.
  inflight++;
  const now = Date.now();
  const startAt = Math.max(now, lastFetchAt + MIN_GAP_MS);
  lastFetchAt = startAt;

  try {
    if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));
    const records = await fetchRecords(apn);
    // A parcel with genuinely no recorded documents since 1990 is a real
    // answer, not a miss, and worth caching as one.
    return json(200, {
      apn,
      source: 'SF Assessor-Recorder public index',
      refreshedAt: new Date().toISOString(),
      live: true,
      records,
    }, 86400);
  } catch (e) {
    // Do not cache a failure; the next reader should get a fresh attempt.
    return json(502, { apn, error: 'the county index did not answer', detail: String(e.message).slice(0, 200), records: [] });
  } finally {
    inflight--;
  }
}

export const config = { path: '/api/records' };
