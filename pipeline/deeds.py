"""Ingest recorded-transfer data into a per-parcel deed overlay.

The overlay (web/public/data/deeds.json) is separate from the parcel build so it
can be refreshed independently — new deed data updates one small file, no citywide
rebuild. The frontend fetches it and joins by parcel id (blklot).

Primary source: the SF Assessor-Recorder R&T §408.1 public transfer list (a
lawful public-records product; see docs/pra-408.1-transfer-list.md). This script
does NOT scrape the recorder portal — it ingests a file the county provides.

Usage:
  python3 pipeline/deeds.py --input <408.1_file.csv>   # ingest a real file
  python3 pipeline/deeds.py --empty                     # honest empty store
  python3 pipeline/deeds.py --sample                    # labeled sample for UI demo

The input column names vary by county export; we match flexibly (see COLMAP).
"""
import argparse
import csv
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import config

OUT = os.path.join(config.OUT_DIR, "deeds.json")

# flexible header matching: normalized substring -> canonical field
COLMAP = {
    "apn": ["apn", "parcel", "blocklot", "block_lot", "blklot", "assessor"],
    "date": ["transfer_date", "recording_date", "recorded", "doc_date", "date"],
    "docnum": ["document_number", "doc_number", "docnum", "instrument", "recording_ref", "reference"],
    "doctype": ["document_type", "doc_type", "doctype", "instrument_type", "title"],
    "grantor": ["transferor", "grantor", "seller", "from"],
    "grantee": ["transferee", "grantee", "buyer", "to"],
    "consideration": ["consideration", "sale_price", "price", "amount", "transfer_tax", "documentary"],
}

# recorded document type -> our transfer kind. Names vary; match on keywords.
RELATIONAL_DOCS = ("trust transfer", "interspousal", "affidavit of death", "gift", "quitclaim")
MARKET_DOCS = ("grant deed", "warranty deed", "trustee", "corporation deed", "individual deed")


def norm(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")


def match_columns(header):
    """Map each canonical field to the best-matching column index, or None."""
    normed = [norm(h) for h in header]
    out = {}
    for field, keys in COLMAP.items():
        idx = None
        for k in keys:
            for i, h in enumerate(normed):
                if k in h:
                    idx = i
                    break
            if idx is not None:
                break
        out[field] = idx
    return out


def deed_kind(doctype, consideration):
    """Classify a recorded transfer from its document type + consideration.

    $0 documentary transfer tax / consideration is the classic exempt-transfer
    signal (family / trust); a real dollar amount means an arm's-length sale.
    """
    dt = (doctype or "").lower()
    if any(w in dt for w in RELATIONAL_DOCS):
        return "relational"
    if consideration is not None and consideration == 0 and "grant" not in dt:
        return "relational"
    if any(w in dt for w in MARKET_DOCS):
        return "market"
    if consideration and consideration > 0:
        return "market"
    return "other"


def to_blklot(apn):
    """Normalize an APN to our blklot key (block+lot, no separators)."""
    return re.sub(r"[^0-9A-Za-z]", "", (apn or "")).upper()


def fnum(v):
    try:
        return float(re.sub(r"[^0-9.\-]", "", str(v)))
    except (TypeError, ValueError):
        return None


def ingest(path):
    by_parcel = {}
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)
        cols = match_columns(header)
        if cols["apn"] is None:
            raise SystemExit(f"Could not find an APN/parcel column in: {header}")
        n = 0
        for row in reader:
            def get(field):
                i = cols[field]
                return row[i].strip() if (i is not None and i < len(row)) else ""
            blklot = to_blklot(get("apn"))
            if not blklot:
                continue
            cons = fnum(get("consideration"))
            rec = {
                "date": (get("date") or "")[:10],
                "docType": get("doctype") or None,
                "docNum": get("docnum") or None,
                "grantor": get("grantor") or None,
                "grantee": get("grantee") or None,
                "consideration": cons,
                "kind": deed_kind(get("doctype"), cons),
            }
            by_parcel.setdefault(blklot, {"verified": True, "transfers": []})
            by_parcel[blklot]["transfers"].append(rec)
            n += 1
    for p in by_parcel.values():
        p["transfers"].sort(key=lambda t: t["date"])
    return by_parcel, n


def sample_store():
    # Clearly-labeled sample so the "verified" UI state is demoable. NOT real data.
    return {
        "2771058": {  # 650 Alvarado
            "verified": True,
            "transfers": [
                {"date": "2012-06-08", "docType": "Trust Transfer Deed", "docNum": "SAMPLE-0001",
                 "grantor": "SAMPLE FAMILY TRUST", "grantee": "SAMPLE (GRANTEE)", "consideration": 0, "kind": "relational"},
            ],
        },
    }


def write(by_parcel, source):
    os.makedirs(config.OUT_DIR, exist_ok=True)
    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "source": source,
        "parcelCount": len(by_parcel),
        "byParcel": by_parcel,
    }
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {OUT}: {len(by_parcel)} parcels · source={source}")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--input", help="§408.1 transfer-list file (CSV) to ingest")
    g.add_argument("--empty", action="store_true", help="write an honest empty overlay")
    g.add_argument("--sample", action="store_true", help="write a labeled sample overlay (UI demo)")
    args = ap.parse_args()

    if args.input:
        by_parcel, n = ingest(args.input)
        write(by_parcel, f"SF Assessor-Recorder §408.1 transfer list ({n} records)")
    elif args.sample:
        write(sample_store(), "SAMPLE — labeled demo data, not real recorded deeds")
    else:
        write({}, "none yet — awaiting §408.1 transfer-list ingest")


if __name__ == "__main__":
    main()
