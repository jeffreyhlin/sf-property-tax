# What the real recorder data reveals about our transfer classification

_Analysis run 2026-07-16, after the worker became able to pull real recorded deeds
(grantor/grantee names) from the SF Recorder public index. Read-only finding — no
app numbers or classifications were changed. This is for a human to decide on._

## TL;DR

We now have real recorded-deed data (document type + party names) for ~140 of the
top parcels. Cross-checking it against the app's **inferred** transfer type surfaces
a serious problem:

- Of 52 parcels the app labels **"relational" (family/trust transfer)** that have a
  recorded transfer near the inferred year, only **~11% are actually family/trust
  transfers**. **~84% are arm's-length market events** — foreclosures, corporate
  relocations, affordable-housing partnership transfers, developer sales, or ordinary
  sales between unrelated people.
- The current **story hero, 247 Lansdale, is one of the misclassified ones**: its
  2011 "transfer" is `JAMES BONG ENTERPRISE INC → POWELL JENNIFER LYNNE` — a developer
  selling to a buyer, not a family passing property down.

The **tax-gap / savings numbers are not affected** — those come from assessed vs.
estimated market value and stand on their own. What's unreliable is the **attribution
of *why*** a parcel is under-assessed: specifically the "family/trust transfer
loophole" mechanism, which is the emotional core of the story.

## How the check works

For each parcel the app inferred as relational, we take the recorded ownership-transfer
document nearest the inferred transfer year (±2y) and classify it by its **parties**:

- **family** — grantor and grantee share a surname, or it's a person → their own name
  / their own family trust (an into-trust, parent-child, or spousal transfer).
- **market** — a company seller, a foreclosure/REO (bank/loan-servicer grantor), a
  relocation nominee, or simply two different surnames.

The parties are a much stronger signal than either the assessment heuristic or the raw
filing code (a generic "DEED" is used for both kinds of transfer).

Result on the 52 checkable relational parcels: **family 6 (11%), market 44 (84%),
unknown 2**.

## Why the heuristic over-labels "relational"

The app infers "excluded/relational" when a sale date changes but the assessed value
**doesn't reset up to our comp-based market estimate**. The failure mode: our market
estimate (neighborhood median $/sqft × area) frequently **exceeds the actual sale
price** for a specific home (older, smaller, needs work, worse position on the block).
So a genuine market purchase — where the assessment *did* reset, to the real, lower
price — looks like "no reset → must be an excluded family transfer."

247 Lansdale makes this concrete: bought Feb 2011 (`JAMES BONG ENTERPRISE INC →
POWELL`), the assessment sat at ~$2.0M and even dipped to $1.8M in 2012 (a Prop 8
decline). Our model thinks the home was worth ~$3.5M in 2011, so it reads "no reset."
But the buyer very likely paid ~$1.9M — the assessment *did* reset, to a price below
our estimate. It's a **long-held market purchase**, not a family transfer.

## The categories hiding inside "relational"

Concrete examples from the top-savings "relational" parcels (all real recorder rows):

| Parcel | Address | Recorded transfer | What it actually is |
|---|---|---|---|
| 0832067 | 375 Fell St | `… → GOUGH STREET HOUSING ASSOCS LP` | Affordable-housing partnership |
| 0344010 | 175 Jones St | `TURK STREET LP → TENDERLOIN FAMILY HOUSING LP` | Affordable-housing partnership |
| 0568004 | 1800 Broadway | `DEUTSCHE BANK NATL TR CO → NAIR` | Bank foreclosure / REO sale |
| 7067005 | 32 Minerva St | `AURORA LOAN SVCS LLC → CHEN` | Foreclosure / REO sale |
| 3078021 | 299 Santa Paula | `NATIONAL RESIDENTIAL NOMINEE SVCS INC → THONGTANG` | Corporate relocation sale |
| 2992059 | 247 Lansdale (hero) | `JAMES BONG ENTERPRISE INC → POWELL` | Developer sale |
| 0623001A | 1735 Van Ness | `REF SF PROPERTIES LLC → SPRECKELS MANSION 1735 VN LP` | LLC/LP portfolio sale |

The affordable-housing partnerships are especially worth flagging: their low
assessments are legitimate (regulatory restrictions / welfare exemptions), so counting
them as Prop-13-loophole beneficiaries is doubly wrong.

## What a *real* family transfer looks like here

Recorder-confirmed same-surname transfers do exist in the data — they're just a small
minority of what we call "relational":

- **1905 Pacific Ave** (0592015A): `ROSENAK THEODORE W → ROSENAK MAX WILLIAM` (2015,
  father → son), then into Max's trust (2018). Assessed $247K vs ~$7M est. **Caveat:**
  the same month, `BLASKO → ROSENAK THEODORE` — Theodore *bought* it at arm's length in
  2015, then moved it to his son. So even this one isn't a frozen-1970s-basis story; the
  low assessment may be a condo-APN/deed mismatch worth checking.
- **2584 Filbert St**, **2416 Gough St**, **127 Lakeshore Dr**: `NAME → SAME NAME` —
  owners putting their own house into a living trust. Routine estate planning, **not**
  the "pass it to the kids at a frozen basis" loophole.

The genuinely intergenerational, frozen-basis cases are rarer than the "relational"
label implies.

## What I did NOT change

Nothing in the app's data or classification. The only code change from this analysis is
in the **worker** itself: a record's transfer tag now uses the parties, so a generic
"DEED" between same-surname parties is tagged `family/trust` and one between a company
and a person stays `market`. That only affects the labels in the "Recorded documents"
panel — it does not touch the parcel-level classifier, the leaderboards, or any totals.

## Options (your call)

1. **Reframe, don't reclassify.** Keep the savings numbers; soften the "family/trust
   transfer" mechanism language to "a recorded transfer that didn't trigger
   reassessment," which is what we can actually defend from assessment data alone.
2. **Use recorder parties as the transfer-type signal** where we have them. Strong and
   verifiable, but only covers parcels we've fetched — scaling it citywide needs the
   bulk §408.1 / PRA feed (already scoped in `docs/`), not per-parcel lookups.
3. **Filter institutional owners** (LPs, LLCs, banks, housing partnerships) out of the
   "family transfer" framing regardless of source.
4. **Pick a verified hero.** If we keep a family-transfer hero, verify the chain in the
   recorder first (as 247 Lansdale shows, the inferred ones don't survive scrutiny).

My recommendation: **1 + 3 now** (cheap, makes the current claims defensible), and **2
via the §408.1 feed** as the real fix. I did not act on any of these — they change the
app's central narrative and are yours to decide.

---

## Follow-up: the surname match was matching almost nothing (2026-07-29)

The party-based check above only compared the **first token** of each name. That
works when the recorder writes both sides surname-first, and fails otherwise —
which turns out to be most into-trust transfers, because a trust's name rarely
leads with the settlor's surname.

Three shapes it missed, all from one parcel (4367 21ST ST, APN 2765001):

| grantor | grantee | first tokens compared | actually |
|---|---|---|---|
| `ABRECHT CHRISTOPHER RUSSELL` | `ABRECHT-VALDEZ FAMILY REVOC TRUST` | `ABRECHT` vs `ABRECHT-VALDEZ` | same person, hyphenated |
| `TAPADIA PAVAN` | `PR TAPADIA LIVING TRUST` | `TAPADIA` vs `PR` | same person, prefixed |
| `DOMINGO BARBARA J L` | `BARBARA J L DOMINGO DCLRTN OF TR` | `DOMINGO` vs `BARBARA` | same person, natural order |

All three read as arm's-length sales. Every ownership event on that parcel did.

`sharedSurname` now tokenizes both names, drops entity scaffolding (`TRUST`,
`LIVING`, `REVOC`, `DECL`, `FAMILY`, `SURVIVORS`, honorifics, bare initials) and
splits hyphens, then looks for any shared token of three characters or more.
Identical parties short-circuit to relational, since some deeds carry no personal
name at all (`DECLARATION OF TRUST 1998` on both sides).

**Effect on the published set:** 315 of 12,931 records reclassified, every one
`market -> relational`, no movement the other way. That is **23% of everything
previously labeled a sale** (315 of 1,356). The `other` bucket — liens, loans,
reconveyances — is untouched at 10,740.

Verified against a 14-case suite covering all three shapes plus genuine sales,
sales *out* of a trust (which must stay `market`), company-to-company, and names
that are entity words only.

This does not change any savings figure. It changes which recorded documents are
described as sales, which matters because the site's whole claim is about how
property changes hands without being reassessed.
