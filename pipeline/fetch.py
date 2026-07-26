"""Download the assessor roll history and parcel geometries from DataSF.

Stdlib only. Writes data/raw/roll.csv and data/raw/parcels.geojson.
Run from the repo root: python3 pipeline/fetch.py
"""
import csv
import io
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import config

PAGE = 50000

ROLL_COLUMNS = [
    "parcel_number",
    "closed_roll_year",
    "property_location",
    "use_definition",
    "property_class_code_definition",
    "year_property_built",
    "number_of_units",
    "property_area",
    "lot_area",
    "homeowner_exemption_value",
    "current_sales_date",
    "assessed_land_value",
    "assessed_improvement_value",
    "analysis_neighborhood",
]


def soql_get(base_url, params):
    url = base_url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip
            body = gzip.decompress(body)
        return body.decode("utf-8")


def neighborhood_filter():
    if not config.NEIGHBORHOODS:
        return None
    quoted = ",".join("'" + n.replace("'", "''") + "'" for n in config.NEIGHBORHOODS)
    return f"analysis_neighborhood in({quoted})"


def fetch_roll(out_path):
    where = f"closed_roll_year >= {config.HISTORY_START}"
    nf = neighborhood_filter()
    if nf:
        where += " AND " + nf
    offset = 0
    total = 0
    with open(out_path, "w", newline="") as out:
        writer = None
        while True:
            text = soql_get(config.ROLL_URL, {
                "$select": ",".join(ROLL_COLUMNS),
                "$where": where,
                "$order": "parcel_number,closed_roll_year",
                "$limit": PAGE,
                "$offset": offset,
            })
            reader = csv.reader(io.StringIO(text))
            rows = list(reader)
            if not rows or len(rows) <= 1:
                break
            header, data = rows[0], rows[1:]
            if writer is None:
                writer = csv.writer(out)
                writer.writerow(header)
            writer.writerows(data)
            total += len(data)
            print(f"  roll: {total} rows", flush=True)
            if len(data) < PAGE:
                break
            offset += PAGE
    return total


def fetch_parcels(out_path):
    where = "active = true"
    nf = neighborhood_filter()
    if nf:
        where += " AND " + nf
    features = []
    offset = 0
    while True:
        text = soql_get(config.PARCELS_URL, {
            "$select": "blklot,from_address_num,street_name,street_type,analysis_neighborhood,shape",
            "$where": where,
            "$order": "blklot",
            "$limit": PAGE,
            "$offset": offset,
        })
        page = json.loads(text).get("features", [])
        features.extend(page)
        print(f"  parcels: {len(features)} features", flush=True)
        if len(page) < PAGE:
            break
        offset += PAGE
    with open(out_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    return len(features)


def main():
    os.makedirs(config.RAW_DIR, exist_ok=True)
    print("Fetching assessor roll history...")
    n = fetch_roll(os.path.join(config.RAW_DIR, "roll.csv"))
    print(f"Roll rows: {n}")
    print("Fetching parcel geometries...")
    n = fetch_parcels(os.path.join(config.RAW_DIR, "parcels.geojson"))
    print(f"Parcel features: {n}")


if __name__ == "__main__":
    main()
