# Deploying

Two pieces: a static site and a small records worker. The site works without the
worker (the deed panel just falls back to a link to the county index), so you can
ship the site first and add the worker later.

## Before you go public

Read `recorder-validation-findings.md` first. The short version: the app used to
label parcels "family/trust transfer" based on assessment behavior, and checking
real deeds showed roughly 84% of those were ordinary market events. The UI now says
"transferred without reassessment", which is what the data actually supports, and
each affected parcel carries a caveat. If you want the stronger claim back, it needs
the bulk §408.1 feed, not the current inference.

Also decide, deliberately, whether you are comfortable publishing residents' names.
The recorder index is public and the app only shows what the county publishes, but a
searchable map is more exposed than a county terminal. The SF Chronicle's comparable
project removes individuals on request while keeping companies. There is currently no
takedown path in this app.

## 1. Static site

```bash
cd web && npm ci && npm run build      # -> web/dist, about 276MB
```

Most of that is `public/data`. It compresses well (274MB drops to roughly 46MB over
the wire) so **the host must serve gzip or brotli**, which Netlify, Vercel, and
Cloudflare all do by default. Worst single asset is a 23MB neighborhood chunk that
gzips to about 5MB, and chunks load lazily by viewport.

Host notes:
- **Netlify / Vercel** work as-is. Point them at `web/`, build `npm run build`,
  publish `dist`.
- **Cloudflare Pages** rejects files over 25MB, and `parcels.pmtiles` is 28MB. Either
  skip Cloudflare or drop the pmtiles overview layer (it is not currently wired in).
- **GitHub Pages** works but is bandwidth-limited and not meant for 276MB.

Set the worker URL at build time, or leave it unset to run without live deeds:

```bash
VITE_RECORDS_API=https://your-worker.example.com/records npm run build
VITE_RECORDS_API= npm run build        # no worker; panel shows the county link
```

## 2. Records worker

Node 18+, no dependencies.

```bash
cd worker
CACHE_ONLY=1 node records-worker.mjs   # serves :8788
```

Or with Docker:

```bash
docker build -t sf-records worker/
docker run -p 8788:8788 sf-records
```

### CACHE_ONLY matters

`CACHE_ONLY=1` answers only from `worker/cache/` and never calls the county. **Use it
for anything public.** Without it, every visitor who opens an uncached parcel queues a
live request against `recorder.sfgov.org`, so a front page of traffic becomes sustained
load on a county server you do not own. The Dockerfile defaults it on.

Warm the cache deliberately instead, from your own machine:

```bash
cd worker
node seed-cache.mjs --limit 100        # top parcels per leaderboard list
node seed-cache.mjs --all              # every leaderboard parcel, about 400
```

Then rebuild the image so the warmed cache ships with it. A parcel that has not been
seeded returns `miss: true` and the UI invites the reader to search the county index
themselves rather than claiming the parcel has no records.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 8788 | listen port |
| `CACHE_ONLY` | off (on in Docker) | never call the county; serve cache only |
| `RECORDS_TTL_MS` | 7 days | age at which a cached parcel refreshes in the background |
| `MIN_INTERVAL_MS` | 1200 | minimum gap between live county calls |
| `SEED_DELAY_MS` | 1500 | gap between seed-script fetches |

### Endpoints

- `GET /records?apn=<blocklot>` → `{ apn, cached, stale, miss, cacheOnly, records[] }`
- `GET /records?apn=<blocklot>&refresh=1` → force a live refetch (ignored under CACHE_ONLY)
- `GET /health` → `{ ok, cached, ttlDays, cacheOnly }`

CORS is open (`Access-Control-Allow-Origin: *`). Tighten it to your site's origin
before going public if you would rather not have others use your worker.

## 3. Data refresh

The assessor publishes a new roll each year.

```bash
python3 pipeline/fetch.py       # re-download roll.csv and parcels.geojson
python3 pipeline/build.py       # rebuild web/public/data
python3 pipeline/validate.py    # check MAPE and bias before shipping
```

`data/raw/` is gitignored because those two source files are 612MB and 140MB, over
GitHub's per-file limit.
