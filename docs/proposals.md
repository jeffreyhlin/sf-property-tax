# Feature proposals

Ideas the assistant is pitching for the SF Prop 13 tax-gap map. Each one is staged for a decision, mark Approve or Reject and I'll queue the approved ones. Effort: S = an afternoon, M = a few days, L = a week plus.

## Decisions (Jeff, 2026-07-10)

1. OG cards: **APPROVED**, and the card should also show how surrounding homes are affected (street/neighbor context).
2. Time slider: **APPROVED**, framed as landscape change over time (flooding/climate-style heatmap shift).
3. Embed mode: **APPROVED**.
4. Aggregate CSV: **APPROVED** with a soft gate: explain that aggregation costs money, sliding-scale donation prompt before download.
5. PMTiles: **APPROVED**. STATUS 2026-07-10: pipeline/tiles.py builds data/parcels.pmtiles (28MB, whole city z10-16, verified). Frontend wiring (src/pmtilesLayer.ts) is STAGED not shipped: deck.gl's MVTLayer needs an active data source to start its tiling pipeline, and the PMTiles-fed getTileData override didn't fire (blank overview band), so it was reverted to keep the bubble overview working. Remaining: feed MVTLayer a data source (or use a TileLayer + @loaders.gl MVTLoader reading from the PMTiles archive) and verify tiles render. ~half day.
6. A11y pass: **SKIPPED** for now.
7. Watch-my-street: **APPROVED**, and go beyond the stub: set up a real email alert and send a test campaign to Jeff's email.
8. Mailing-address clustering: **TBD** (parked, still blocked on names).
9. Permalinks/URL state: **APPROVED**.
10. Scrollytelling intro: **APPROVED**, NYT-parallax data-journalism style: a few key scrolls in simple terms, with a skip option and a search escape hatch.
11. Auto-refresh: **APPROVED**, include a "data last updated" indicator in the UI.

---

## 1. Shareable OG-image cards per parcel

**Pitch:** Every parcel gets a link that unfurls on social with a pre-rendered card, address, tax gap, and the dumbbell chart.

**Why:** The map only spreads if individual findings are shareable. A juicy card ("this Pac Heights home saves $41k/yr") is the viral unit.

**Effort:** M. Needs URL state per parcel plus a render step (satori or headless canvas at build time, or an edge function).

**Risk:** Could read as targeting specific households. Cards should show address and numbers, no editorializing.

**Decision:** [ ] Approve  [ ] Reject

---

## 2. Time-machine year slider (2007–2025)

**Pitch:** A slider that scrubs the whole map through 19 years of assessment history, watch gaps widen in real time.

**Why:** The story of Prop 13 is compounding. A static snapshot hides it; scrubbing from 2007 makes the drift visceral. Great for screen recordings too.

**Effort:** M. We already fetch per-year rolls; needs per-year values in the payload (bigger files) and a deck.gl transition on the color/height accessor.

**Risk:** Payload bloat, pairs badly with GeoJSON, better after idea 5.

**Decision:** [ ] Approve  [ ] Reject

---

## 3. Embed / iframe mode for journalists

**Pitch:** `?embed=1&parcel=...` or `&hood=...` renders a chrome-free map locked to one parcel or neighborhood, drop-in iframe for news sites.

**Why:** Local outlets (Chronicle, Standard, Mission Local) embed constantly. One good embed in a story drives more traffic than anything we'd do ourselves.

**Effort:** S. Mostly hiding panels, honoring URL params, and setting frame-ancestors headers.

**Risk:** Low. Just make sure embeds carry attribution and a methodology link so numbers aren't quoted context-free.

**Decision:** [ ] Approve  [ ] Reject

---

## 4. Aggregate CSV downloads (neighborhood stats only)

**Pitch:** A download button for neighborhood-level stats: total est. savings, relational-transfer counts, median gap, $/sqft trends. Deliberately no per-parcel dump.

**Why:** Researchers and reporters want the numbers in a spreadsheet. Aggregates give them that without us shipping a scrape-ready file of every household's inferred subsidy.

**Effort:** S. The build pipeline already computes these; write them to CSV and link it.

**Risk:** Basically none, that's the point of aggregates-only.

**Decision:** [ ] Approve  [ ] Reject

---

## 5. PMTiles / tippecanoe migration

**Pitch:** Replace the single GeoJSON payload with vector tiles so citywide (~200k parcels) loads fast on any connection.

**Why:** It's the known blocker in the README, 26MB for three neighborhoods doesn't scale. Nearly every other idea here (slider, embeds, citywide leaderboards) wants this first.

**Effort:** M. tippecanoe in the build step, PMTiles + MVTLayer on the frontend, rewire click/hover to tile features.

**Risk:** Attribute size per tile needs care with 19 years of history; may need a split data scheme.

**Decision:** [ ] Approve  [ ] Reject

---

## 6. Accessibility pass

**Pitch:** Keyboard nav for search/panels/parcel selection, screen-reader labels on charts, and a color-blind-safe alternate ramp for the orange/yellow scale.

**Why:** It's a civic transparency tool, it should be usable by the public, all of it. Also matters if news orgs embed us; they have a11y standards.

**Effort:** M. The map canvas itself is the hard part; panels and leaderboard are straightforward ARIA work.

**Risk:** None. Worst case the map stays mouse-first while everything around it becomes accessible.

**Decision:** [ ] Approve  [ ] Reject

---

## 7. "Watch my street" email stub

**Pitch:** Enter an address, get notified when a nearby parcel changes hands or its gap moves. Ship the UI plus a signup capture now; actual sending comes later.

**Why:** Turns one-time visitors into repeat users and builds a list before we have a backend. The annual roll update is a natural send trigger.

**Effort:** S for the stub (form + hosted capture like Buttondown). Real notifications are M later.

**Risk:** Collecting emails means privacy policy obligations. Stub shouldn't overpromise cadence.

**Decision:** [ ] Approve  [ ] Reject

---

## 8. Same-mailing-address owner clustering — BLOCKED

**Pitch:** Chronicle-style clustering: group parcels whose tax bills go to the same mailing address to surface portfolio owners hiding behind LLCs.

**Why:** The single most requested angle in this genre, "who actually owns the neighborhood." Turns anecdotes into portfolios.

**Effort:** L, and **blocked**: mailing addresses ride with owner data DataSF removed. Needs the assessor scrape or purchased county records (see docs/pra-assessor-roll.md).

**Risk:** Highest of the list. Names/addresses of individuals raise real privacy questions; revisit only with a policy for natural persons vs entities.

**Decision:** [ ] Blocked, revisit when data lands

---

## 9. Permalinks + URL state (assistant pick)

**Pitch:** Every view state, selected parcel, active filters, year, camera, lives in the URL, so any view is copy-paste shareable.

**Why:** It's the substrate for ideas 1 and 3, and the cheapest sharing win on the list. "Look at this block" only works if the link reproduces the view.

**Effort:** S. Serialize view state to query params on change, hydrate on load.

**Risk:** None worth naming. Ship first.

**Decision:** [ ] Approve  [ ] Reject

---

## 10. Scrollytelling intro: "How Prop 13 works" (assistant pick)

**Pitch:** A guided scroll story before the free-explore map: two identical houses, one bought in 1978, one last year, animated on the real map with real parcels.

**Why:** The map assumes you already get Prop 13. Most visitors don't. A 60-second narrative converts confused bounces into people who explore, and it's the piece journalists will link.

**Effort:** M. Scroll-driven camera moves and staged layers; content is the hard part.

**Risk:** Tone. Keep it explanatory, not advocacy, or it undercuts the data's credibility.

**Decision:** [ ] Approve  [ ] Reject

---

## 11. Auto-refresh data pipeline (assistant pick)

**Pitch:** A scheduled GitHub Action that re-runs fetch + build when DataSF publishes the new roll, with a "data as of" badge in the UI.

**Why:** Stale civic data quietly kills trust. Automating the July roll drop keeps the site credible for years with zero manual effort, and the badge makes freshness legible.

**Effort:** S. Cron workflow, checksum the dataset, rebuild and deploy on change.

**Risk:** Schema drift in the DataSF dataset could break builds silently; add a validation step that fails loudly.

**Decision:** [ ] Approve  [ ] Reject

---

## Suggested order

Quick wins first: **9 (permalinks) → 4 (CSV) → 3 (embeds) → 11 (auto-refresh)**, then the platform bet **5 (PMTiles)**, which unlocks **2 (slider)** and citywide everything. **1 (OG cards)**, **6 (a11y)**, and **10 (scrollytelling)** slot in anytime after 9. **7** whenever, it's cheap. **8** stays parked until the records question is settled.
