// Export the warmed deed cache as static JSON so a public site needs no server.
//
// Under CACHE_ONLY the worker only ever reads files off disk, so for a public
// deployment there is nothing for it to compute. Copying the cache into
// web/public/records/ lets the built site fetch /records/<apn>.json directly:
// one static host, no backend, no CORS, and no traffic to the county.
//
//   node export-static.mjs            # write web/public/records/
//   node export-static.mjs --clean    # remove stale exports first
//
// Re-run after seeding to ship a fresher cache.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'cache');
const OUT = path.join(DIR, '..', 'web', 'public', 'records');

const clean = process.argv.includes('--clean');
if (clean && fs.existsSync(OUT)) {
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT, f));
}
fs.mkdirSync(OUT, { recursive: true });

let written = 0;
let records = 0;
let empty = 0;
const index = [];

for (const f of fs.readdirSync(CACHE)) {
  if (!f.endsWith('.json')) continue;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
  } catch {
    console.warn(`skipping unreadable ${f}`);
    continue;
  }
  const recs = Array.isArray(doc) ? doc : doc.records || [];
  const apn = (doc.apn || path.basename(f, '.json')).toUpperCase();
  // Same shape the app already handles from the worker, minus server-only fields.
  const payload = {
    apn,
    source: 'SF Assessor-Recorder public index',
    refreshedAt: doc.refreshedAt ?? null,
    static: true,
    records: recs,
  };
  fs.writeFileSync(path.join(OUT, `${apn}.json`), JSON.stringify(payload));
  written++;
  records += recs.length;
  if (!recs.length) empty++;
  index.push(apn);
}

// An index lets the UI distinguish "we looked and the county has nothing" from
// "this parcel was never seeded", without a request per parcel.
fs.writeFileSync(
  path.join(OUT, '_index.json'),
  JSON.stringify({ count: index.length, generatedFrom: 'worker/cache', apns: index.sort() }),
);

const mb = (fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0) / 1e6).toFixed(1);
console.log(`exported ${written} parcels (${records} records, ${empty} with none) to web/public/records, ${mb}MB`);
