// On-demand SF Recorder lookup worker — pure HTTP, no browser.
//
// Sits behind the app's RECORDS_API hook. Given a parcel APN (block+lot), it
// queries the county's public index (recorder.sfgov.org) and returns every
// recorded document — type, date, grantor/grantee names — as JSON, caching the
// result per APN so each parcel is fetched at most once per refresh window.
//
// HOW IT TALKS TO THE COUNTY (no Playwright, no scraping):
// The Clearview "SearchService" JSON API is open to anonymous callers. Its search
// endpoint just wants two headers minted from a companion endpoint:
//   1. GET  /SearchService/api/SearchConfiguration/GetSecureKey
//        -> { EncryptedKey, Password }         (a fresh, throwaway per-call key)
//   2. GET  /SearchService/api/Search/GetSearchResults?Block=..&LowLot=..&...
//        headers: EncryptedKey, Password        -> { ResultCount, SearchResults }
// The server does check Origin/Referer/User-Agent, so we send browser-like ones.
// There is no signup and no permanent API key — we just mint a key per fetch.
//
// This is on-demand + cached, at human scale (rate-limited, serialized) — NOT a
// bulk crawler. For full-coverage owner data, ingest the §408.1 / PRA roll via
// pipeline/deeds.py instead of pointing this at all 207k parcels.
//
// Run:  cd worker && node records-worker.mjs   (Node 18+ for global fetch)
// Warm a curated set first:  node seed-cache.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(DIR, 'cache');
const PORT = process.env.PORT || 8788;
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 1200); // polite spacing between live fetches
const TTL_MS = Number(process.env.RECORDS_TTL_MS || 7 * 24 * 60 * 60 * 1000); // serve cache; refresh if older

// CACHE_ONLY=1 serves only what has already been fetched and never calls the
// county live. Set this for a public deployment: otherwise every visitor who
// opens an uncached parcel queues a request against recorder.sfgov.org, and a
// front page of traffic turns into a sustained load on a county server. Warm
// the cache deliberately with seed-cache.mjs instead.
const CACHE_ONLY = process.env.CACHE_ONLY === '1';
// The recorder client lives in recorder-api.mjs so the worker, the seed and
// export scripts, and the serverless function all share one implementation.
import { fetchRecords, parseNames, deedKind, refineKind } from './recorder-api.mjs';

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- cache ------------------------------------------------------------------
function cachePath(apn) {
  return path.join(CACHE_DIR, `${apn.replace(/[^0-9A-Za-z]/g, '')}.json`);
}
function readCache(apn) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(apn), 'utf8'));
    // legacy entries were a bare array; wrap them so old caches still work
    if (Array.isArray(j)) return { refreshedAt: 0, records: j };
    return j;
  } catch {
    return null;
  }
}
function writeCache(apn, records) {
  const payload = {
    apn: apn.replace(/[^0-9A-Za-z]/g, ''),
    refreshedAt: Date.now(),
    source: 'SF Assessor-Recorder public index',
    records,
  };
  fs.writeFileSync(cachePath(apn), JSON.stringify(payload));
  return payload;
}

// --- rate-limited, de-duplicated live fetching ------------------------------
let queue = Promise.resolve();
let lastFetch = 0;
const inflight = new Map(); // apn -> Promise, so concurrent callers share one fetch

function liveFetch(apn) {
  const key = apn.replace(/[^0-9A-Za-z]/g, '');
  if (inflight.has(key)) return inflight.get(key);
  const run = queue.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastFetch));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastFetch = Date.now();
    const records = await fetchRecords(apn);
    writeCache(apn, records);
    return records;
  });
  queue = run.catch(() => {}); // keep the chain alive on error
  const tracked = run.finally(() => inflight.delete(key));
  inflight.set(key, tracked);
  return tracked;
}

// Serve cache-first. Fresh cache returns immediately. Stale cache returns
// immediately too, and kicks off a background refresh (stale-while-revalidate).
// No cache means a blocking fetch. `force` always does a blocking live fetch.
async function lookup(apn, { force = false } = {}) {
  const cached = readCache(apn);

  // Public deployments run CACHE_ONLY: answer from disk, never call the county.
  // An unseeded parcel reports miss:true so the UI can offer the recorder link
  // instead of silently showing an empty record list.
  if (CACHE_ONLY) {
    if (cached) {
      return { cached: true, stale: false, cacheOnly: true,
               refreshedAt: cached.refreshedAt || null, records: cached.records };
    }
    return { cached: false, stale: false, cacheOnly: true, miss: true, refreshedAt: null, records: [] };
  }

  if (force) {
    const records = await liveFetch(apn);
    return { cached: false, stale: false, refreshedAt: Date.now(), records };
  }
  if (cached) {
    const stale = Date.now() - (cached.refreshedAt || 0) > TTL_MS;
    if (stale) liveFetch(apn).catch(() => {}); // refresh in background, serve what we have
    return { cached: true, stale, refreshedAt: cached.refreshedAt || null, records: cached.records };
  }
  const records = await liveFetch(apn);
  return { cached: false, stale: false, refreshedAt: Date.now(), records };
}

// --- exports for the seed script (and tests) --------------------------------
export { fetchRecords, lookup, readCache, writeCache, parseNames, deedKind, refineKind };

// --- HTTP server ------------------------------------------------------------
// Only run the server when invoked directly, not when imported by seed-cache.mjs.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/health') {
      let count = 0;
      try {
        count = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length;
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cached: count, ttlDays: TTL_MS / 86400000, cacheOnly: CACHE_ONLY }));
      return;
    }

    if (url.pathname !== '/records') {
      res.writeHead(404).end('not found');
      return;
    }
    const apn = url.searchParams.get('apn');
    if (!apn) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'apn required' }));
      return;
    }
    try {
      const force = url.searchParams.get('refresh') === '1';
      const { cached, stale, refreshedAt, records, cacheOnly, miss } = await lookup(apn, { force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apn, cached, stale, refreshedAt, cacheOnly: !!cacheOnly, miss: !!miss,
        source: 'SF Recorder public index', records,
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
  server.listen(PORT, () => console.log(`records-worker on http://localhost:${PORT}/records?apn=2992059`));
}
