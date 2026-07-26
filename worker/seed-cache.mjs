// Pre-seed the records cache for a curated set of parcels, so the parcels people
// are most likely to open (the leaderboards + the story hero) load instantly.
//
// This is the "pull it once up front" half of the strategy; the worker itself does
// the "refresh when someone searches" half (stale-while-revalidate) at request time.
//
// Usage:
//   node seed-cache.mjs                 # warm story hero + top leaderboard parcels
//   node seed-cache.mjs --limit 100     # cap per leaderboard list (default 40)
//   node seed-cache.mjs --all           # every leaderboard parcel (~400)
//   node seed-cache.mjs 2992059 3705001 # warm just these APNs
//   node seed-cache.mjs --force ...      # refetch even if already cached & fresh
//
// Rate-limited (SEED_DELAY_MS, default 1500ms) and cache-aware (skips fresh
// entries) so re-running is cheap and the county isn't hammered.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRecords, readCache, writeCache } from './records-worker.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LEADERBOARD = path.join(DIR, '..', 'web', 'public', 'data', 'leaderboard.json');
const STORY_HERO = ['2992059']; // 247 Lansdale, the story's family-transfer example
const SEED_DELAY_MS = Number(process.env.SEED_DELAY_MS || 1500);
const TTL_MS = Number(process.env.RECORDS_TTL_MS || 7 * 24 * 60 * 60 * 1000);

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const all = argv.includes('--all');
const limIdx = argv.indexOf('--limit');
const perList = all ? Infinity : limIdx >= 0 ? Number(argv[limIdx + 1]) : 40;
// APN args, excluding the value that follows --limit (else `--limit 100` reads 100 as an APN)
const explicitApns = argv.filter(
  (a, i) => /^[0-9]{3,}[0-9A-Za-z]*$/.test(a) && !(limIdx >= 0 && i === limIdx + 1),
);

function leaderboardApns(cap) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(LEADERBOARD, 'utf8'));
  } catch (e) {
    console.warn(`could not read ${LEADERBOARD}: ${e.message}`);
    return [];
  }
  const out = [];
  for (const cls of ['sfh', 'multi']) {
    for (const list of ['topSavings', 'topRelational']) {
      const arr = d?.[cls]?.[list] || [];
      for (const e of arr.slice(0, cap)) if (e?.id) out.push(e.id);
    }
  }
  return out;
}

const isFresh = (apn) => {
  const c = readCache(apn);
  return c && Date.now() - (c.refreshedAt || 0) < TTL_MS;
};

async function main() {
  // explicit APNs override the curated list
  const list = explicitApns.length ? explicitApns : [...STORY_HERO, ...leaderboardApns(perList)];
  const apns = [...new Set(list.map((a) => a.replace(/[^0-9A-Za-z]/g, '')))];

  console.log(`seeding ${apns.length} parcels (delay ${SEED_DELAY_MS}ms, ${force ? 'force' : 'skip-fresh'})`);
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let totalRecords = 0;

  for (let i = 0; i < apns.length; i++) {
    const apn = apns[i];
    const tag = `[${i + 1}/${apns.length}] ${apn}`;
    if (!force && isFresh(apn)) {
      skipped++;
      continue;
    }
    try {
      const records = await fetchRecords(apn);
      writeCache(apn, records);
      fetched++;
      totalRecords += records.length;
      console.log(`${tag}: ${records.length} records`);
    } catch (e) {
      failed++;
      console.warn(`${tag}: FAILED — ${e.message}`);
    }
    if (i < apns.length - 1) await new Promise((r) => setTimeout(r, SEED_DELAY_MS));
  }

  console.log(
    `\ndone — fetched ${fetched}, skipped ${skipped} (fresh), failed ${failed}; ${totalRecords} records cached.`,
  );
}

main();
