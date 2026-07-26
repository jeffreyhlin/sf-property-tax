# Owner names & transfer data: where to get them without Regrid's leash

Research date: 2026-07-09/10. Claims marked ✓ were adversarially verified against
primary sources (3-vote panel); claims marked (unverified) died in verification due
to session limits and should be spot-checked before relying on them.

## The legal foundation (all ✓)

- **The named assessment roll is a public record statewide.** R&T Code §§ 601-602
  and Property Tax Rule 252 require every county assessor to prepare a roll whose
  statutory contents include the assessee's NAME and mailing address, and the BOE
  classifies the roll as open to public inspection. The BOE's own quick-reference
  list of PUBLIC assessor information includes: owner names, mailing address, situs,
  assessed values, transfer date/document number, transfer value, and
  transferor/transferee names.
  Sources: [BOE confidentiality guide](https://boe.ca.gov/proptaxes/pdf/confidentiality_of_county_assessors_records.pdf), [R&T 601-602](https://law.onecle.com/california/taxation/division-1/part-2/chapter-3/article-6/index.html)
- **Electronic production at duplication cost is a right, not a favor.**
  *Sierra Club v. Superior Court* (Cal. 2013, unanimous): a county's GIS parcel
  database is a public record and must be produced "in any electronic format in
  which it holds the information" at no more than the direct cost of duplication.
  Counties cannot substitute licensing fees. [Opinion](https://scocal.stanford.edu/opinion/sierra-club-v-super-ct-34241)
- **The hard stop: PCORs are confidential.** R&T §§ 451/481 make everything on a
  Preliminary Change of Ownership Report or Change in Ownership Statement secret,
  including the parent-child checkbox. The declared family relationship is NOT
  obtainable from any public source. Our behavioral inference stays necessary even
  with names. [BOE LTA 2021/053](https://www.boe.ca.gov/proptaxes/pdf/lta21053.pdf)
- **Homeowner exemption**: claim forms are confidential, but which properties GET
  the exemption is affirmatively public on the roll (§ 408(a) as amended by SB 824).
  Useful as an owner-occupancy signal we already have in DataSF.

## Ranked acquisition stack

### 1. R&T § 408.1 transfer list — the sleeper hit (✓, fee ≤ $10)
Counties over 50,000 population MUST maintain a public list of ALL property
transfers of the last 2 years: **transferor and transferee names**, APN, situs,
transfer date, recording reference, and consideration where known. The statutory
inspection fee is capped at actual cost or **$10, whichever is less**.
This is names + both sides of every transfer, updated quarterly, for pocket change.
Request it from the SF Assessor-Recorder quarterly and we build a permanent named
transfer database going forward. Action: add one paragraph to the existing PRA
letter (docs/pra-assessor-roll.md) citing § 408.1.

### 2. PRA the named secured roll (✓ legal basis; cost TBD)
The letter is drafted (docs/pra-assessor-roll.md). Precedent that counties really
do sell it: **Santa Clara County sells its named Secured Master File (~458k records)
to anyone for $495** ($2,485 with use codes), with signed use restrictions: no
resale, no posting the file on the internet "in the form received", no providing to
private parties (✓). Expect SF to offer similar terms or straight PRA production.
Note the tension worth arguing if SF attaches strings: PRA production under Sierra
Club cannot carry licensing conditions; a "data product purchase" can. Ask for PRA
production explicitly.

### 3. SF Recorder grantor-grantee index (✓ free online, bulk via PRA)
recorder.sfgov.org hosts a free index search, 1990-present, **no login required for
index searches** (guest account; document image preview requires ID-verified
registration; official copies $1.81/doc online). Searchable by grantor/grantee
name, document type, date range, and document number. Document types (trust
transfer deed, interspousal deed, affidavit of death of joint tenant, grant deed)
classify transfers authoritatively. (unverified: whether the index can be searched
by APN; whether bulk export is sold to title companies; pre-1990 records are
offline.) Bulk letter drafted: docs/pra-recorder-index.md.

### 4. Enrichment sources for relationships (names required first)
- SF Superior Court probate index (public; names decedents + petitioners).
- CA death indexes / SSDI public portions (death date ↔ transfer date joins).
- CA SOS bizfile for LLC officer/agent resolution (the Chronicle links to it
  directly from their map).
- Obituaries/genealogy: manual verification only; ToS-restricted for scraping.

### 5. Commercial shortcut: Regrid ($150-$500, license constraints)
SF county file with 91% owner-name coverage, self-serve. Constraints that matter
(full text: data/raw/regrid_data_store_license.md): no use with public AI services,
no making data available to third parties, geometry must not be bulk-downloadable
by users, attribution required, 1-year term. The SF Chronicle's statewide map is
built on licensed Regrid data (their methodology page confirms; their tiles carry
avg_tax_subsidy fields). Scraping their tiles = extracting Regrid's licensed
dataset; declined.

## Dead ends and cautions (✓ unless noted)

- **PCOR relationship declarations**: confidential by statute, full stop.
- **DataSF & LA County open GIS**: no owner names in any open-data parcel layer
  (probed directly; LA's public parcel MapServer has no owner field). Names travel
  by PRA/purchase, not open portals.
- **Safe at Home** participants (address confidentiality program) are redacted from
  public rolls; expect small gaps, don't try to fill them.
- **Defamation care**: keep "likely relational transfer" labeled as an inference
  until deed doc types confirm; publish named claims only from recorded documents.
- **Prior art**: Ian Webster's ca-property-tax (officialdata.org) scraped county
  tax portals per-county (✓); the Tax Fairness Project distributes county parcel
  data (unverified details).

## Recommended sequence

1. Send both PRA letters, adding the § 408.1 transfer-list request ($10 cap cite).
2. While waiting, spot-verify high-value leaderboard parcels manually in the free
   recorder index (doc type + names, one at a time, no scraping needed).
3. If PRA drags: buy Regrid CSV ($150) for internal analysis only, keep the public
   site on open data + PRA outputs.
4. When the named roll lands: same-owner + same-mailing-address clustering (the
   Chronicle's technique), then probate/death-index joins for inheritance
   confirmation.
