#!/usr/bin/env python3
"""For every cached parcel the app labeled 'relational', find the recorder transfer
doc nearest the inferred year and classify it by its actual PARTIES:
  - family: shared surname, or person->own-name/own-trust (a real excluded transfer)
  - market: company seller, foreclosure/REO, relocation nominee, or different surnames
Then list recorder-CONFIRMED family transfers (candidate story heroes) and the
apparent misclassifications."""
import json, os, re
from collections import Counter

CACHE = "/Users/jefflin/workspaces/sf-property-tax/worker/cache"
LEADER = "/Users/jefflin/workspaces/sf-property-tax/web/public/data/leaderboard.json"

lb = json.load(open(LEADER))
byid = {}
for cls in ("sfh", "multi"):
    for lst in ("topSavings", "topRelational"):
        for e in lb[cls][lst]:
            byid[e["id"].replace("-", "")] = e

COMPANY = re.compile(r"\b(INC|LLC|CORP|CO|LP|LLP|ENTERPRISE|BANK|ASSN|ASSOC|PARTNERS|PROPERTIES|HOLDINGS|FUND|GROUP|COMPANY|LTD|FOUNDATION|CHURCH|CITY|COUNTY|USA|NA|SVCS|SERVICES|NOMINEE|MGMNT|MANAGEMENT|REALTY|CAPITAL|INVESTMENTS?|VENTURES?)\b")
FORECLOSURE = re.compile(r"\b(LOAN|MORTGAGE|BANK|HUD|FANNIE|FREDDIE|REO|TRUSTEE|RECONVEY|FEDERAL|SECRETARY|WELLS FARGO|CHASE|CITIBANK)\b")

def sur(n):
    return n.strip().split()[0] if n and n.strip() else None
def is_co(n):
    return bool(n and COMPANY.search(n.upper()))

def classify(gr, ge):
    if not gr or not ge:
        return "unknown"
    # person -> a trust bearing the SAME surname = family/estate planning
    sg, se = sur(gr), sur(ge)
    if is_co(gr) and FORECLOSURE.search(gr.upper()):
        return "market"  # foreclosure/REO seller
    if not is_co(gr) and not is_co(ge) and sg and se and sg == se:
        return "family"
    # person -> "<SURNAME> ... TRUST/LIVING TRUST" same surname
    if sg and re.search(rf"\b{re.escape(sg)}\b.*(TRUST|LIVING|FAMILY|REVOCABLE)", ge.upper()):
        return "family"
    if se and re.search(rf"\b{re.escape(se)}\b.*(TRUST|LIVING|FAMILY|REVOCABLE)", gr.upper()):
        return "family"
    if is_co(gr) or is_co(ge):
        return "market"
    if sg and se and sg != se:
        return "market"
    return "unknown"

confirmed_family = []
misclassified_market = []
party_counts = Counter()
n_rel_checked = 0

for apn, e in byid.items():
    if e.get("transferType") not in ("relational", "excluded"):
        continue
    ty = e.get("transferYear")
    cf = os.path.join(CACHE, apn + ".json")
    if not ty or not os.path.exists(cf):
        continue
    doc = json.load(open(cf))
    recs = doc["records"] if isinstance(doc, dict) else doc
    transfers = [r for r in recs if r.get("kind") in ("market", "relational")]
    near = sorted(transfers, key=lambda r: abs(int((r.get("date") or "0")[:4] or 0) - ty))
    near = [r for r in near if abs(int((r.get("date") or "0")[:4] or 0) - ty) <= 2]
    if not near:
        continue
    n_rel_checked += 1
    top = near[0]
    verdict = classify(top.get("grantor"), top.get("grantee"))
    party_counts[verdict] += 1
    row = (apn, e.get("addr"), e.get("cls"), ty, e.get("savings"), round(e.get("estMarket", 0) / max(e.get("assessed", 1), 1), 2),
           top.get("date"), top.get("docType"), top.get("grantor"), top.get("grantee"))
    if verdict == "family":
        confirmed_family.append(row)
    elif verdict == "market":
        misclassified_market.append(row)

print(f"app-'relational' parcels with a recorder transfer near the inferred year: {n_rel_checked}")
print(f"  party verdict: {dict(party_counts)}")
tot = sum(party_counts.values())
if tot:
    print(f"  => recorder-CONFIRMED family/trust: {party_counts['family']} ({100*party_counts['family']//tot}%)")
    print(f"  => look like arm's-length MARKET sales (misclassified): {party_counts['market']} ({100*party_counts['market']//tot}%)")

print("\n=== recorder-CONFIRMED family/trust transfers (candidate story heroes, by savings) ===")
for r in sorted(confirmed_family, key=lambda x: -(x[4] or 0))[:12]:
    apn, addr, cls, ty, sav, ratio, dd, dt, gr, ge = r
    print(f"  {apn} {addr} ({cls}) ${sav:,}/yr ratio {ratio}: {dd} {dt} [{gr} > {ge}]")

print("\n=== app-'relational' that look like MARKET sales (misclassified), by savings ===")
for r in sorted(misclassified_market, key=lambda x: -(x[4] or 0))[:12]:
    apn, addr, cls, ty, sav, ratio, dd, dt, gr, ge = r
    print(f"  {apn} {addr} ({cls}) ${sav:,}/yr: {dd} {dt} [{gr} > {ge}]")
