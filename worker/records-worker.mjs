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
const API = 'https://recorder.sfgov.org/SearchService/api';
const MIN_DATE = '12/28/1989'; // index starts 1990; a hair earlier to be safe
const PAGE_ROWS = 1000; // the API returns the whole result set in one page up to this

const HTTP_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://recorder.sfgov.org',
  Referer: 'https://recorder.sfgov.org/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- document-type classification -----------------------------------------
// Order matters: liens/loans/reconveyances first so "DEED OF TRUST" (a mortgage,
// which contains the word "deed") is never mistaken for an ownership transfer.
const NON_TRANSFER = /deed of trust|reconvey|\blien\b|release|notice|\bntc\b|assignment|substitution|subordinat|modificat|abstract|judgment|\bufc\b|financing/i;
const RELATIONAL = /trust transfer|interspousal|affidavit of death|quitclaim|\bgift\b|dissolution/i;
const MARKET = /grant deed|warranty deed|\bdeed\b|trustee|corporation deed|individual deed/i;
function deedKind(docType) {
  const t = (docType || '').toLowerCase();
  if (NON_TRANSFER.test(t)) return 'other';
  if (RELATIONAL.test(t)) return 'relational';
  if (MARKET.test(t)) return 'market';
  return 'other';
}

// A generic "DEED" filing code is used for BOTH arm's-length sales and family/trust
// transfers, so the doc type alone can't tell them apart — but the PARTIES can. When
// grantor and grantee share a surname (and neither is a company), it's an into-trust,
// parent/child, or spousal transfer, not a market sale. This is a far stronger signal
// than assessment behavior alone (see docs/recorder-validation-findings.md).
const COMPANY_RE = /\b(INC|LLC|CORP|CO|LP|LLP|ENTERPRISE|BANK|ASSN|ASSOC|PARTNERS?|PROPERTIES|HOLDINGS|FUND|GROUP|COMPANY|LTD|FOUNDATION|CHURCH|CITY|COUNTY|USA|NA|SVCS|SERVICES|NOMINEE|MGMNT|MANAGEMENT|REALTY|CAPITAL|VENTURES?|INVESTMENTS?)\b/i;
function sharedSurname(grantors, grantees) {
  const g = (grantors[0] || '').trim().toUpperCase();
  const e = (grantees[0] || '').trim().toUpperCase();
  if (!g || !e) return false;
  if (COMPANY_RE.test(g) && COMPANY_RE.test(e)) return false; // company↔company = arm's-length
  const sg = g.split(/\s+/)[0];
  const se = e.split(/\s+/)[0];
  // require a real surname token; a shared first token means same family/self
  return !!sg && sg.length >= 3 && sg === se;
}
// Refine a doc-type kind using the parties: promote a "market" DEED to relational
// when the parties share a surname (into-trust / parent-child / spousal).
function refineKind(kind, grantors, grantees) {
  if (kind === 'market' && sharedSurname(grantors, grantees)) return 'relational';
  return kind;
}

// "(R) FOO & BAR<br/>(E) BAZ" -> { grantors:["FOO & BAR"], grantees:["BAZ"] }
function parseNames(raw) {
  const grantors = [];
  const grantees = [];
  for (const seg of String(raw || '').split(/<br\s*\/?>/i)) {
    const m = seg.trim().match(/^\(([RE])\)\s*(.+)$/);
    if (!m) continue;
    const name = m[2].replace(/^"|"$/g, '').trim();
    if (m[1] === 'R') grantors.push(name);
    else grantees.push(name);
  }
  return { grantors, grantees };
}

function normDate(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : String(s || '').slice(0, 10);
}

function todayMDY() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

// --- county API -------------------------------------------------------------
async function mintKey() {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${API}/SearchConfiguration/GetSecureKey`, { headers: HTTP_HEADERS });
      const k = await r.json();
      if (k && k.EncryptedKey && k.Password) return k;
      lastErr = new Error(`GetSecureKey returned ${JSON.stringify(k)}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw lastErr || new Error('could not mint secure key');
}

async function searchPage(block, lot, startRow) {
  const key = await mintKey();
  const qs = new URLSearchParams({
    Block: block,
    LowLot: lot,
    DocumentClass: 'OfficialRecords',
    ProfileID: 'Public',
    NameTypeID: '0',
    MinRecordedDate: MIN_DATE,
    MaxRecordedDate: todayMDY(),
    Rows: String(PAGE_ROWS),
    StartRow: String(startRow),
  });
  const r = await fetch(`${API}/Search/GetSearchResults?${qs}`, {
    headers: { ...HTTP_HEADERS, EncryptedKey: key.EncryptedKey, Password: key.Password },
  });
  if (!r.ok) throw new Error(`GetSearchResults HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.SearchResults)) throw new Error('unexpected search response');
  return j; // { ResultCount, SearchResults, RefinementPanelData }
}

// APN -> normalized deed records (newest first), the full set for the parcel.
async function fetchRecords(apn) {
  const clean = apn.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const block = clean.slice(0, 4);
  const lot = clean.slice(4);
  const rows = [];
  let startRow = 0;
  let total = Infinity;
  // We control every query param, so the block/lot filter is applied on each page
  // (unlike the site's own Next-page control, which drops it). Loop only for the
  // rare parcel with more than PAGE_ROWS documents.
  for (let guard = 0; startRow < total && guard < 20; guard++) {
    const j = await searchPage(block, lot, startRow);
    total = Number(j.ResultCount) || j.SearchResults.length;
    rows.push(...j.SearchResults);
    if (j.SearchResults.length === 0) break;
    startRow += j.SearchResults.length;
  }
  const seen = new Set();
  const records = [];
  for (const d of rows) {
    const docNumber = String(d.PrimaryDocNumber || '').trim();
    if (!docNumber || seen.has(docNumber)) continue;
    seen.add(docNumber);
    const { grantors, grantees } = parseNames(d.Names);
    // One document can carry several filing codes, and the index joins them
    // with literal <br/> the way its own web UI wants them. Left raw, that
    // markup shows up verbatim as "SUBSTITUTION TRUSTEE<br/>RECONVEYANCE".
    const docType = String(d.FilingCode || '')
      .split(/<br\s*\/?>/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' · ');
    records.push({
      docNumber,
      date: normDate(d.DocumentDate),
      docType: docType || null,
      grantor: grantors.join('; ') || null,
      grantee: grantees.join('; ') || null,
      grantors,
      grantees,
      pages: Number(d.NumberOfPages) || null,
      transferTax: null, // only on the paid document image; the index omits it
      kind: refineKind(deedKind(docType), grantors, grantees),
    });
  }
  return records;
}

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
