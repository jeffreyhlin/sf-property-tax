/**
 * The San Francisco Assessor-Recorder's public document index, as a plain
 * client. No filesystem, no server, no state: give it an APN, get back that
 * parcel's recorded documents, normalized and classified.
 *
 * Kept separate from records-worker.mjs so the same logic can run in three
 * places without drifting — the long-lived worker, the seed/export scripts,
 * and the serverless function that answers on-demand clicks from the live
 * site. Anything cache- or transport-specific belongs in the caller.
 *
 * The index is stateless and cookie-free. It does check Origin, Referer, and
 * User-Agent, and it hands out a short-lived key per search rather than
 * holding a session, so every call mints its own.
 */

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

export { fetchRecords, deedKind, refineKind, parseNames, normDate, sharedSurname };
