# SF Property Tax Gap

Interactive map of every San Francisco parcel comparing its Prop 13 taxed value against an
estimated market value: who is locked into a decades-old tax basis, how the gap has compounded
since 2007, and which properties changed hands without triggering a reassessment.

Built with deck.gl + MapLibre on open data from [DataSF](https://datasf.org/opendata/), plus
recorded deeds from the SF Assessor-Recorder's public index.

## What the numbers say

Roll 2025, ~207,000 parcels, an estimated **$2.0B/yr** in Prop 13 savings relative to what new
buyers of the same homes would owe.

Where it sits matters more than the headline. Roughly three quarters belongs to owners who have
simply held since before 2007. Long tenure is the story; transfers that skipped a reassessment
are a small slice.

## An important caveat about "transfers"

This project originally labeled parcels "family/trust transfer" when a sale date changed but the
assessed value did not reset. That inference turns out to be mostly wrong.

Checking real recorded deeds against it for the top parcels, only about **11%** were genuine
family or trust transfers. About **84%** were arm's-length events: foreclosures, developer sales,
corporate relocation sales, affordable-housing partnership transfers, and ordinary sales between
unrelated people. The cause is that the market estimate often exceeds the actual sale price, so a
real purchase that *did* reset (to a lower real price) looks like it never reset at all.

The UI therefore says **"transferred without reassessment"**, which is what assessment data can
actually support, and flags the limitation on every affected parcel. The savings figures are
unaffected; they come from assessed vs. estimated market value and stand on their own.

Full analysis in [`docs/recorder-validation-findings.md`](docs/recorder-validation-findings.md),
reproducible via `pipeline/validate_recorder.py`.

## Data sources

| Dataset | ID | What we use |
|---|---|---|
| Assessor Historical Secured Property Tax Rolls | `wv5m-vpq2` | Assessed values 2007–2025, sale dates, sqft, units, exemptions |
| Parcels, Active and Retired | `acdm-wktn` | Parcel polygons, addresses |
| Analysis Neighborhoods | `j2bu-swwd` | 41 neighborhood boundaries (3D model) |
| SF Assessor-Recorder public index | — | Recorded deeds: type, date, grantor/grantee names |

Owner names and deed types are not in DataSF. They come from the county recorder's index, which
is open to anonymous search. `worker/` queries it per parcel and caches the result. See
[`worker/README.md`](worker/README.md) for how that works.

### How transfer type is inferred

Prop 13 caps assessed growth at about 2%/yr until a reassessment. At each change of sale date we
look ahead up to 2 rolls, since the assessor often reassesses a year or two late:

- assessed jumps >25% within the window → **market reset**
- assessed stays on the ~2% trend → **transferred without reassessment**
- safety net: a no-reset transfer taxed at >85% of estimated market has no preserved discount, so
  it is relabeled a market transfer

Market value = median $/sqft of same-neighborhood, same-size-class parcels whose basis reset in
the last 3 years, times building area. Comps split single-family / small-multi (condos and 2–4
units) / large apartment (5+ units) so a 27-unit rental is not valued at condo prices. Validated
leave-one-out against 2022–2025 sales: about 18% median error, slightly conservative.

## Run it

```bash
python3 pipeline/fetch.py            # pull roll + parcels from DataSF (~750MB)
python3 pipeline/build.py            # compute metrics -> web/public/data/*
cd web && npm install && npm run dev # http://localhost:5199
```

Optional, for recorded deeds with names:

```bash
cd worker && node seed-cache.mjs     # warm the cache for top parcels
node records-worker.mjs              # serves :8788, app picks it up automatically
```

`pipeline/validate.py` reports model accuracy. Coverage is set in `pipeline/config.py`.

## The app

- **Explore** — 3D neighborhoods (height = total savings, color = subsidy depth); zoom in for
  parcels colored by how far below market they are taxed. Click one for a plain-language
  breakdown, a per-year chart, who-benefited periods, street comparison, every recorded deed with
  names, and a shareable PNG.
- **Story** — scrollytelling intro; one step sweeps 2007→2025 with a live metric.
- **Breakdown** — Sankey of where the $2.0B sits: total → property type → how the low basis arose.
- **Compare** — neighborhood grid and top-parcels leaderboard.

Plus `#p=…` permalinks, `?embed=1`, CSV download, and a street-watch email digest.

Mobile: the rail becomes a bottom tab bar and panels become bottom sheets under 760px.

## Deploying

See [`docs/deploy.md`](docs/deploy.md). Two things matter most: the host must serve gzip (274MB
of map data compresses to about 46MB), and the records worker must run with `CACHE_ONLY=1` in
public so visitor traffic is never proxied onto county servers.

## Known limits

- **Transfer type is inferred, not read from deeds.** See the caveat above. Deed-level truth is
  only present for parcels that have been looked up in the recorder.
- Recent sales may be mislabeled until their reassessment lands in a later roll.
- Market estimates are $/sqft comps, not a hedonic model. Least reliable for unusual buildings
  and rent-controlled stock. Special assessments (Mello-Roos, bonds, parcel taxes) are excluded.
- Institutional owners (housing partnerships, LLCs, banks) appear alongside households. Their low
  assessments often reflect regulatory restrictions rather than Prop 13 carryover, so they should
  not be read as loophole beneficiaries.
- Names shown come from public county records. There is currently no takedown path for
  individuals; consider adding one before publishing widely.
