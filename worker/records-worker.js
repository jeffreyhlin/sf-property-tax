/**
 * SF recorded-documents lookup, by APN, for the property-tax-gap map.
 *
 * A Cloudflare Worker (adapts easily to a Vercel/Netlify function). The browser
 * can't call the county site directly (CORS + bot protection), so this proxies
 * the request, parses the result, and caches it in KV so each APN hits the
 * county index at most once, ever ("save it and update the record").
 *
 * Endpoint:  GET /records?apn=<blklot>   ->  { apn, records: DeedRecord[], cachedAt }
 *   DeedRecord = { date, docType, grantor?, grantee?, docNumber?, transferTax? }
 *
 * ── BEFORE POINTING THIS AT THE LIVE SITE ─────────────────────────────────────
 *   1. Read the SF Assessor-Recorder Public Index terms of use + robots.txt and
 *      confirm automated per-parcel querying is permitted. If unclear, ask them.
 *   2. Keep it cache-first + rate-limited (below). Do NOT bulk-crawl; only fetch
 *      APNs a real user opened, and never re-fetch a cached one.
 *   3. Identify the bot in the User-Agent with a contact URL.
 *   4. Privacy: the index returns individuals' names. Decide a display policy
 *      (e.g. show entities/LLCs, let natural persons request removal — the SF
 *      Chronicle model). Consider showing only doc type + transfer tax, not names.
 *
 * The exact search request below is a TEMPLATE. The SF index runs an ASP.NET
 * "Records Manager" whose search POST body (filters + tokens) must be confirmed
 * with one real capture from the site's network tab, then filled into search().
 */

const RECORDER_BASE = 'https://recorder.sfgov.org';
const UA = 'sf-tax-gap-bot/1.0 (+https://your-site.example/about)';
const RATE_MS = 1500; // min gap between live county requests (politeness)
let lastHit = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/records') return json({ error: 'not found' }, 404);
    const apn = (url.searchParams.get('apn') || '').trim();
    if (!/^[0-9A-Z]{3,12}$/i.test(apn)) return json({ error: 'bad apn' }, 400);

    const key = `apn:${apn}`;
    const hit = await env.RECORDS.get(key, 'json'); // KV binding named RECORDS
    if (hit) return json({ apn, records: hit.records, cachedAt: hit.cachedAt }, 200, true);

    // polite rate limit across concurrent invocations
    const wait = RATE_MS - (Date.now() - lastHit);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit = Date.now();

    let records;
    try {
      records = await search(apn);
    } catch (e) {
      return json({ error: 'lookup failed', detail: String(e) }, 502);
    }

    const payload = { records, cachedAt: new Date().toISOString() };
    await env.RECORDS.put(key, JSON.stringify(payload)); // permanent cache
    return json({ apn, records, cachedAt: payload.cachedAt }, 200);
  },
};

// ---- county integration (confirm the POST shape with one live capture) --------
async function search(apn) {
  // The SF Public Index accepts an APN (block+lot) filter. Typical flow:
  //   1) GET a search page to obtain any anti-forgery token / session cookie.
  //   2) POST the search with the APN filter -> JSON or HTML result grid.
  // Replace SEARCH_PATH + body with the confirmed request.
  const SEARCH_PATH = '/api/search'; // TODO: confirm real endpoint
  const res = await fetch(`${RECORDER_BASE}${SEARCH_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'application/json' },
    body: JSON.stringify({ apn, dateFrom: '1990-01-01', pageSize: 100 }),
  });
  if (!res.ok) throw new Error(`recorder ${res.status}`);
  const raw = await res.json();
  return parseResults(raw);
}

// Normalize the county grid into our DeedRecord shape. Adjust field names to the
// actual response once captured. Documentary transfer tax of $0 flags an exempt
// (family/trust) transfer; a nonzero amount is proportional to the sale price.
function parseResults(raw) {
  const rows = raw.results || raw.documents || [];
  return rows
    .map((r) => ({
      date: (r.recordDate || r.date || '').slice(0, 10),
      docType: r.documentType || r.docType || 'Document',
      grantor: r.grantor || r.grantorName,
      grantee: r.grantee || r.granteeName,
      docNumber: r.documentNumber || r.docNumber,
      transferTax: r.transferTax != null ? Number(r.transferTax) : null,
    }))
    .filter((r) => r.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function json(obj, status = 200, cached = false) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*', // lock to your site's origin in prod
      'cache-control': cached ? 'public, max-age=86400' : 'no-store',
    },
  });
}
