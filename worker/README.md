# Records worker — on-demand SF Recorder lookups

Fills the app's "Recorded documents" panel with **real** recorded deeds (document
type, date, grantor/grantee names) for the parcel a user is looking at, by querying
the county's public index (recorder.sfgov.org) directly over HTTP.

## How it works (no browser, no scraping)

The SF Recorder public index is genuinely open — searchable by block/lot, no login,
no CAPTCHA on search, and the terms don't prohibit automated access (they disclaim
liability and make you indemnify the county). Its Clearview "SearchService" JSON API
is callable by anyone; the search endpoint just wants two headers minted from a
companion endpoint:

1. `GET /SearchService/api/SearchConfiguration/GetSecureKey`
   → `{ "EncryptedKey": "...", "Password": "..." }` — a fresh, throwaway key.
2. `GET /SearchService/api/Search/GetSearchResults?Block=..&LowLot=..&DocumentClass=OfficialRecords&ProfileID=Public&Rows=1000&StartRow=0&...`
   with headers `EncryptedKey` and `Password`
   → `{ "ResultCount": N, "SearchResults": [ { PrimaryDocNumber, DocumentDate, FilingCode, Names, ... } ] }`

The server checks `Origin` / `Referer` / `User-Agent`, so the worker sends
browser-like ones. There is **no signup and no permanent API key** — you mint a
fresh throwaway key per request. Names come back as `(R) GRANTOR<br/>(E) GRANTEE`.

> This replaced an earlier Playwright/headless-Chromium version (kept as
> `records-worker.playwright.mjs.bak` for reference). The HTTP path is faster, has
> no browser dependency, returns clean structured JSON, and sidesteps two site
> quirks the browser version had to fight: the results-JSON-needs-a-key problem
> (solved by minting the key ourselves) and the buggy "Next page" control that
> drops the block/lot filter (avoided by controlling every query param directly).

## Strategy: pull once up front, refresh on view

- **Pre-seed once** (`node seed-cache.mjs`) warms the cache for the parcels people
  are most likely to open — the leaderboards (top savings + top relational, SFH and
  multi) plus the story hero. Rate-limited, cache-aware, safe to re-run.
- **Refresh on search** — every lookup is served cache-first. A fresh entry returns
  instantly; a stale one (older than `RECORDS_TTL_MS`, default 7 days) returns
  instantly too **and** triggers a background refresh (stale-while-revalidate). Only
  a never-seen parcel blocks on a live fetch (~1–2s).

It is deliberately **not** a bulk crawler. For every-parcel owner coverage, get the
data through the front door — the R&T §408.1 transfer list or the PRA'd named roll
(see `../docs/`) — and ingest it with `../pipeline/deeds.py`.

## Run

```bash
cd worker
node records-worker.mjs          # serves http://localhost:8788/records?apn=<blocklot>
node seed-cache.mjs              # (optional) warm the cache for the curated set first
```

Node 18+ (uses global `fetch`). No `npm install` needed — zero runtime dependencies.

The app already points at `http://localhost:8788/records` by default, so with the
worker running, selecting a parcel renders the full deed history with names. To point
at a deployed worker set `VITE_RECORDS_API`; set it to `""` to force the labeled demo
rows.

### Endpoints

- `GET /records?apn=<blocklot>` → `{ apn, cached, stale, refreshedAt, records: [...] }`
- `GET /records?apn=<blocklot>&refresh=1` → force a live refetch (bypasses cache)
- `GET /health` → `{ ok, cached: <#files>, ttlDays }`

### seed-cache.mjs

```bash
node seed-cache.mjs                 # story hero + top 40 of each leaderboard list
node seed-cache.mjs --limit 100     # top 100 of each list
node seed-cache.mjs --all           # every leaderboard parcel (~400)
node seed-cache.mjs 2992059 3705001 # just these APNs
node seed-cache.mjs --force ...     # refetch even if already cached & fresh
```

## Notes

- Respect the county's infrastructure: keep the rate limit (`MIN_INTERVAL_MS`,
  `SEED_DELAY_MS`) in place; don't loop it over every parcel. For scale, use the bulk
  front-door feed.
- The free index gives document TYPE and NAMES but not the sale price / transfer tax
  (that's on the paid document image). `$0` transfer tax as a relational signal comes
  from the §408.1 consideration field instead.
- Records are cached to `worker/cache/<apn>.json` as
  `{ apn, refreshedAt, source, records }`. Delete a file to force a refetch.
- The indemnification clause in the site's disclaimer applies to whoever runs this.
