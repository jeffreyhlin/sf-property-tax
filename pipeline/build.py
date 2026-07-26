"""Join the roll history with parcel geometry and compute tax-gap metrics.

Citywide-scale version: streams the roll into compact tuples (3.9M rows fit in
a few hundred MB), then emits the web payload chunked by neighborhood:

  web/public/data/meta.json           run metadata + per-neighborhood stats & trends
  web/public/data/leaderboard.json    top parcels by est. annual savings, by class
  web/public/data/search-index.json   columnar {id, addr, neighborhood, centroid} for all parcels
  web/public/data/nbhd/<slug>.json    GeoJSON chunk per neighborhood (lazy-loaded)

Classification logic (unchanged from the 3-neighborhood version)
-----------------------------------------------------------------
Prop 13 caps assessed growth at ~2%/yr until reassessment. At a new sale date:
  assessed jumped >25%      -> market sale (basis reset)
  assessed on trend (<=10%) -> reassessment-EXCLUDED transfer, i.e. the
    parent-child/grandparent/spousal/trust pattern -> "likely relational transfer"
Market value: median $/sqft of same (neighborhood, year, class) parcels whose
basis reset within the trailing MARKET_COMP_YEARS window, times building area.
"""
import csv
import datetime
import json
import os
import re
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
import config

RESIDENTIAL_KEYWORDS = ("DWELLING", "FLAT", "CONDOMINIUM", "APARTMENT", "RESIDENTIAL", "COOP")
# property-type buckets: sfh (single-family), multi (2+ units incl. condo/flat/
# apartment), commercial (everything else, no market estimate). Comps are only
# computed for the two residential buckets.
CLASSES = ("sfh", "multi")  # display/filter buckets
# Comps use a finer split so a 27-unit rental isn't valued against condo $/sqft:
# multi_small = condos + 2-4 unit flats (condo-like $/sqft), multi_large = 5+ unit
# apartment buildings (trade far lower per sqft). Display class stays sfh/multi.
COMP_CLASSES = ("sfh", "multi_small", "multi_large")
MIN_COMPS = {"sfh": 15, "multi_small": 10, "multi_large": 6}


def comp_class(cls, units):
    """Finer bucket used only for the market-value estimate (not the UI filter)."""
    if cls == "commercial":
        return None
    if cls == "sfh":
        return "sfh"
    return "multi_large" if units >= 5 else "multi_small"


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "unknown").lower()).strip("-")


def is_residential(use_def):
    u = (use_def or "").upper()
    return any(k in u for k in RESIDENTIAL_KEYWORDS)


def classify(latest):
    """Bucket a parcel into sfh | multi | commercial from assessor fields."""
    if not is_residential(latest["use"]):
        return "commercial"
    use = (latest["use"] or "").upper()
    cls_def = (latest["cls_def"] or "").upper()
    units = latest["units"]
    # single-family: exactly one dwelling, not a flat/condo/apartment
    single_words = ("SINGLE FAMILY", "SINGLE-FAMILY", "DWELLING")
    multi_words = ("FLAT", "DUPLEX", "APARTMENT", "MULTI", "CONDOMINIUM", "COOP", "COOPERATIVE")
    if any(w in use or w in cls_def for w in multi_words) or units >= 2:
        return "multi"
    if any(w in use or w in cls_def for w in single_words) or units == 1:
        return "sfh"
    return "sfh"


def load_roll(path):
    """Stream the roll CSV into {pid: {'yrs': [(year, assessed, sale_date)...], latest fields}}."""
    parcels = {}
    with open(path, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        col = {name: i for i, name in enumerate(header)}
        ix = (
            col["parcel_number"], col["closed_roll_year"],
            col["assessed_land_value"], col["assessed_improvement_value"],
            col["current_sales_date"],
        )
        for row in reader:
            pid = row[ix[0]]
            year = int(row[ix[1]])
            assessed = fnum(row[ix[2]]) + fnum(row[ix[3]])
            sale = row[ix[4]] or ""
            rec = parcels.get(pid)
            if rec is None:
                rec = {"yrs": [], "latest_year": -1}
                parcels[pid] = rec
            rec["yrs"].append((year, assessed, sale))
            if year > rec["latest_year"]:
                rec["latest_year"] = year
                rec["use"] = row[col["use_definition"]]
                rec["cls_def"] = row[col["property_class_code_definition"]]
                rec["built"] = row[col["year_property_built"]]
                rec["units"] = int(fnum(row[col["number_of_units"]]))
                rec["area"] = fnum(row[col["property_area"]])
                rec["exemption"] = fnum(row[col["homeowner_exemption_value"]])
                rec["sale_date"] = sale
                rec["nbhd"] = row[col["analysis_neighborhood"]]
    for rec in parcels.values():
        rec["yrs"].sort(key=lambda t: t[0])
    return parcels


RESET_WINDOW = 2  # years to look ahead for a lagged reassessment after a sale


def analyze(rec):
    """Walk the year-by-year history.

    Returns (history, events, basis_year, last_transfer, reset_values), where
    events is a list of (sale_year, kind) and reset_values maps a reset's
    sale_year -> the REASSESSED value (used as the market comp, not the stale
    pre-reassessment basis).

    The reassessment often LAGS the sale by 1-2 rolls (the assessor processes it
    after the sale date first appears). At each sale-date change we look ahead up
    to RESET_WINDOW rolls (capped before the next sale) for the jump:
      - assessed jumps > ~25% within the window   -> market reset
      - assessed drops < 0.90x                     -> market reset (down-market)
      - assessed stays on the ~2%/yr trend         -> excluded (likely relational),
        unless the sale is too recent to have been reassessed yet -> partial
      - in between                                 -> partial
    Rows consumed by a sale's lookahead window are marked so the no-sale big-jump
    branch doesn't re-emit the same reassessment as a second reset.
    """
    yrs = rec["yrs"]  # sorted (year, assessed, sale)
    history = [[y, round(a)] for y, a, s in yrs]
    n = len(yrs)
    sale_idx = [i for i in range(1, n) if yrs[i][2] and yrs[i][2] != yrs[i - 1][2]]
    sale_set = set(sale_idx)
    events = []
    reset_values = {}  # sale_year -> reassessed value to feed comps
    consumed = set()   # rows already attributed to a preceding sale's lookahead
    for i in range(1, n):
        year, assessed, sale = yrs[i]
        prev_year, prev_assessed, _ = yrs[i - 1]
        gap = max(year - prev_year, 1)
        if i in sale_set:
            if prev_assessed <= 0:
                if assessed > 0:
                    events.append((year, "reset"))
                    reset_values[year] = assessed
                continue
            # window = this record through the next RESET_WINDOW rolls, capped
            # before the next sale so we don't attribute its reset to this one
            end = i
            while end + 1 < n and yrs[end + 1][0] - year <= RESET_WINDOW and (end + 1) not in sale_set:
                end += 1
            window_max = max(yrs[k][1] for k in range(i, end + 1))
            reset_hi = 1.25 * (1.02 ** (gap - 1))
            trend_hi = 1.10 * (1.02 ** (gap - 1))
            ratio_max = window_max / prev_assessed
            ratio_now = assessed / prev_assessed
            # too recent to have seen the reassessment yet? don't call it relational
            recent = (config.ROLL_YEAR - year) < RESET_WINDOW
            if ratio_max > reset_hi or ratio_now < 0.90:
                events.append((year, "reset"))
                reset_values[year] = window_max  # the reassessed value, not the stale basis
                for k in range(i + 1, end + 1):
                    consumed.add(k)  # rows the jump lives in — don't double-count below
            elif ratio_max <= trend_hi:
                events.append((year, "partial" if recent else "excluded"))
            else:
                events.append((year, "partial"))
        elif i not in consumed and prev_assessed > 50000 and assessed / prev_assessed > 1.5 * (1.02 ** (gap - 1)):
            # big jump without a sale: new construction or corrected roll
            events.append((year, "reset"))
            reset_values[year] = assessed
    resets = [y for y, k in events if k == "reset"]
    basis_year = resets[-1] if resets else None
    last_transfer = events[-1] if events else None
    return history, events, basis_year, last_transfer, reset_values


def feature_centroid(geom):
    ring = None
    if geom["type"] == "Polygon":
        ring = geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        ring = geom["coordinates"][0][0]
    if not ring:
        return None
    return (
        sum(c[0] for c in ring) / len(ring),
        sum(c[1] for c in ring) / len(ring),
    )


def round_coords(c):
    if isinstance(c, (int, float)):
        return round(c, 6)
    return [round_coords(x) for x in c]


def main():
    roll_path = os.path.join(config.RAW_DIR, "roll.csv")
    parcels_path = os.path.join(config.RAW_DIR, "parcels.geojson")
    out_dir = config.OUT_DIR
    nbhd_dir = os.path.join(out_dir, "nbhd")
    os.makedirs(nbhd_dir, exist_ok=True)

    print("Loading roll (streaming)...", flush=True)
    roll = load_roll(roll_path)
    print(f"  {len(roll)} parcels with history", flush=True)

    # Pass 1: analyze + collect comps per (nbhd, year, class)
    analyzed = {}
    comps_year = defaultdict(list)
    for pid, rec in roll.items():
        history, events, basis_year, last_transfer, reset_values = analyze(rec)
        cls = classify(rec)
        ccls = comp_class(cls, rec["units"])
        analyzed[pid] = (history, events, basis_year, last_transfer, cls, ccls)
        area = rec["area"]
        if ccls is None or area <= 200:
            continue
        for reset_year, kind in events:
            if kind != "reset":
                continue
            # use the REASSESSED value (market at sale), not the stale sale-year basis
            v = reset_values.get(reset_year, 0)
            if v <= 100000:
                continue
            for y in range(reset_year, min(reset_year + config.MARKET_COMP_YEARS, config.ROLL_YEAR + 1)):
                comps_year[(rec["nbhd"], y, ccls)].append(v / area)

    ppsf_year = {}
    for key, vals in comps_year.items():
        if len(vals) >= MIN_COMPS[key[2]]:
            ppsf_year[key] = statistics.median(vals)
    print(f"  comps cells with estimates: {len(ppsf_year)}", flush=True)

    # Neighborhood median assessed/market ratio per year (for hover verdicts)
    ratios_year = defaultdict(list)
    for pid, (history, events, basis_year, last_transfer, cls, ccls) in analyzed.items():
        rec = roll[pid]
        if ccls is None or rec["area"] <= 200:
            continue
        for year, assessed in history:
            est = ppsf_year.get((rec["nbhd"], year, ccls))
            if est and assessed > 0:
                ratios_year[(rec["nbhd"], year)].append(min(assessed / (est * rec["area"]), 1.0))
    median_ratio = defaultdict(dict)
    for (nbhd, year), vals in ratios_year.items():
        if len(vals) >= 50:
            median_ratio[nbhd][year] = round(statistics.median(vals), 3)
    del ratios_year

    print("Loading parcel geometry...", flush=True)
    with open(parcels_path) as f:
        geo = json.load(f)

    features_by_nbhd = defaultdict(list)
    leaderboard = []
    search_ids, search_addrs, search_nb, search_x, search_y = [], [], [], [], []
    nbhd_names = []
    nbhd_name_ix = {}
    nb = defaultdict(lambda: {
        "parcels": 0, "transfers": 0, "relational": 0,
        "totalSavings": 0.0, "relationalSavings": 0.0,
        "cx": 0.0, "cy": 0.0, "cn": 0, "ratios": [],
    })
    savings_by_year = defaultdict(float)
    nb_savings_by_year = defaultdict(lambda: defaultdict(float))
    est_count_by_year = defaultdict(int)
    # per (neighborhood, type) rollup for the 3D model + property-type filter.
    # type in {all, sfh, multi, commercial}. Each holds counts + per-year savings.
    def _type_stat():
        return {
            "parcels": 0, "relational": 0, "totalSavings": 0.0,
            "savingsByYear": defaultdict(float), "parcelsByYear": defaultdict(int),
        }
    nb_type = defaultdict(lambda: {t: _type_stat() for t in ("all", "sfh", "multi", "commercial")})
    sankey_flows = defaultdict(lambda: {"savings": 0.0, "count": 0})  # (cls, origin) -> flow
    matched = 0

    skipped_no_geom = 0
    for feat in geo["features"]:
        pid = feat["properties"].get("blklot")
        entry = analyzed.get(pid)
        if entry is None:
            continue
        if not feat.get("geometry") or not feat["geometry"].get("coordinates"):
            skipped_no_geom += 1
            continue
        history, events, basis_year, last_transfer, cls, ccls = entry
        rec = roll[pid]
        assessed = history[-1][1] if history else 0
        if assessed <= 0:
            continue
        matched += 1
        fp = feat["properties"]
        addr = " ".join(
            s for s in (fp.get("from_address_num"), fp.get("street_name"), fp.get("street_type")) if s
        ).strip() or None
        nbhd = rec["nbhd"] or "Unknown"
        area = rec["area"]

        # no current-year estimate for parcels whose roll history ended early
        # (retired/merged parcels still present in the parcels layer)
        est_now = ppsf_year.get((nbhd, config.ROLL_YEAR, ccls)) if rec["latest_year"] >= config.ROLL_YEAR else None
        est_market = max(est_now * area, assessed) if (est_now and area > 200) else None
        ratio = round(assessed / est_market, 3) if est_market else None
        tax_est = max(assessed - rec["exemption"], 0) * config.TAX_RATE
        savings = (est_market - assessed) * config.TAX_RATE if est_market else None

        transfer_type = "none"
        transfer_year = None
        if last_transfer:
            transfer_year = last_transfer[0]
            transfer_type = {"reset": "market", "excluded": "relational", "partial": "partial"}[last_transfer[1]]
            # A "relational" transfer only matters if it preserved a below-market
            # basis. If the parcel is taxed near market (ratio > 0.85), there is no
            # inherited discount, so it's not a beneficial relational transfer —
            # relabel as a market/neutral transfer. Guards against recent flips and
            # lagged reassessments that leave the property already at market.
            if transfer_type == "relational" and ratio is not None and ratio > 0.85:
                transfer_type = "market"

        hist = []
        tstat_all = nb_type[nbhd]["all"]
        tstat_cls = nb_type[nbhd][cls]
        for year, av in history:
            est_y = ppsf_year.get((nbhd, year, ccls))
            est_v = round(est_y * area) if (est_y and area > 200) else None
            hist.append([year, av, est_v])
            if est_v:
                gap_tax = max(est_v - av, 0) * config.TAX_RATE
                savings_by_year[year] += gap_tax
                nb_savings_by_year[nbhd][year] += gap_tax
                est_count_by_year[year] += 1
                tstat_all["savingsByYear"][year] += gap_tax
                tstat_cls["savingsByYear"][year] += gap_tax
                tstat_all["parcelsByYear"][year] += 1
                tstat_cls["parcelsByYear"][year] += 1

        avoided_since = None
        if transfer_year:
            tot, seen = 0.0, False
            for year, av, est in hist:
                if year >= transfer_year and est:
                    tot += max(est - av, 0) * config.TAX_RATE
                    seen = True
            avoided_since = round(tot) if seen else None

        # ownership periods: segment history at transfer events; per-period savings.
        # [startYear, endYear, howItBegan, estSavedInPeriod|null]
        kind_map = {"reset": "market", "excluded": "relational", "partial": "partial"}
        boundaries = [(hist[0][0], "initial")] + [(y, kind_map[k]) for y, k in events]
        periods = []
        for i, (start, kind) in enumerate(boundaries):
            end = boundaries[i + 1][0] - 1 if i + 1 < len(boundaries) else hist[-1][0]
            if end < start:
                continue
            tot, seen = 0.0, False
            for year, av, est in hist:
                if start <= year <= end and est:
                    tot += max(est - av, 0) * config.TAX_RATE
                    seen = True
            periods.append([start, end, kind, round(tot) if seen else None])

        props = {
            "id": pid,
            "addr": addr or f"parcel {pid}",
            "nbhd": nbhd,
            "use": rec["use"],
            "cls": cls,
            "built": rec["built"] or None,
            "units": rec["units"] or None,
            "area": round(area) or None,
            "assessed": round(assessed),
            "estMarket": round(est_market) if est_market else None,
            "ratio": ratio,
            "taxEst": round(tax_est),
            "savings": round(savings) if savings is not None else None,
            "basisYear": basis_year,
            "saleDate": (rec["sale_date"] or "")[:10] or None,
            "transferType": transfer_type,
            "transferYear": transfer_year,
            "avoidedSince": avoided_since,
            "events": [[y, k] for y, k in events],
            "periods": periods,
            "street": " ".join(s for s in (fp.get("street_name"), fp.get("street_type")) if s) or None,
            "hist": hist,
        }
        features_by_nbhd[nbhd].append({
            "type": "Feature",
            "geometry": {
                "type": feat["geometry"]["type"],
                "coordinates": round_coords(feat["geometry"]["coordinates"]),
            },
            "properties": props,
        })

        c = feature_centroid(feat["geometry"])
        if nbhd not in nbhd_name_ix:
            nbhd_name_ix[nbhd] = len(nbhd_names)
            nbhd_names.append(nbhd)
        if addr:
            search_ids.append(pid)
            search_addrs.append(addr)
            search_nb.append(nbhd_name_ix[nbhd])
            search_x.append(round(c[0], 5) if c else None)
            search_y.append(round(c[1], 5) if c else None)

        s = nb[nbhd]
        s["parcels"] += 1
        for tstat in (tstat_all, tstat_cls):
            tstat["parcels"] += 1
            if transfer_type == "relational":
                tstat["relational"] += 1
            if savings is not None and savings > 0:
                tstat["totalSavings"] += savings
        if transfer_type != "none":
            s["transfers"] += 1
        if transfer_type == "relational":
            s["relational"] += 1
        if c:
            s["cx"] += c[0]
            s["cy"] += c[1]
            s["cn"] += 1
        if ratio is not None:
            s["ratios"].append(ratio)
        if savings is not None and savings > 0:
            s["totalSavings"] += savings
            if transfer_type == "relational":
                s["relationalSavings"] += savings
            # Sankey flow: total gap -> property type -> how the low basis arose
            origin = (
                "relational" if transfer_type == "relational"
                else "market" if transfer_type in ("market", "partial")
                else "prehold"  # no transfer since 2007: pre-2007 basis, long-time owner
            )
            fl = sankey_flows[(cls, origin)]
            fl["savings"] += savings
            fl["count"] += 1
            leaderboard.append({
                "id": pid, "addr": props["addr"], "nbhd": nbhd, "cls": cls,
                "assessed": props["assessed"], "estMarket": props["estMarket"],
                "savings": props["savings"], "basisYear": basis_year,
                "transferType": transfer_type, "transferYear": transfer_year,
                "avoidedSince": avoided_since,
            })

    del geo, analyzed, roll

    # Write neighborhood chunks
    chunks = []
    for nbhd, feats in sorted(features_by_nbhd.items()):
        slug = slugify(nbhd)
        path = os.path.join(nbhd_dir, f"{slug}.json")
        with open(path, "w") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
        xs, ys = [], []
        for ft in feats:
            c = feature_centroid(ft["geometry"])
            if c:
                xs.append(c[0])
                ys.append(c[1])
        chunks.append({
            "slug": slug, "name": nbhd, "count": len(feats),
            "bbox": [round(min(xs), 5), round(min(ys), 5), round(max(xs), 5), round(max(ys), 5)] if xs else None,
            "bytes": os.path.getsize(path),
        })
    print(f"  wrote {len(chunks)} neighborhood chunks", flush=True)

    leaderboard.sort(key=lambda x: -x["savings"])
    boards = {}
    for cls in CLASSES:
        rows = [l for l in leaderboard if l["cls"] == cls]
        boards[cls] = {
            "topSavings": rows[:100],
            "topRelational": [l for l in rows if l["transferType"] == "relational"][:100],
        }
    with open(os.path.join(out_dir, "leaderboard.json"), "w") as f:
        json.dump(boards, f, separators=(",", ":"))

    with open(os.path.join(out_dir, "search-index.json"), "w") as f:
        json.dump({
            "nbhds": nbhd_names,
            "id": search_ids, "addr": search_addrs, "nb": search_nb,
            "x": search_x, "y": search_y,
        }, f, separators=(",", ":"))

    neighborhoods = []
    for nbhd, s in nb.items():
        ppsf_by_year = {
            str(y): round(v)
            for (n, y, c), v in ppsf_year.items()
            if n == nbhd and c == "sfh"
        }
        years = sorted(int(y) for y in ppsf_by_year)
        trend5 = None
        trend_span = None
        if years:
            last = years[-1]
            base = next((y for y in years if y >= last - 5), years[0])
            if base != last and ppsf_by_year[str(base)] > 0:
                trend_span = last - base
                trend5 = round(ppsf_by_year[str(last)] / ppsf_by_year[str(base)] - 1, 3)
        neighborhoods.append({
            "name": nbhd,
            "slug": slugify(nbhd),
            "center": [round(s["cx"] / s["cn"], 5), round(s["cy"] / s["cn"], 5)] if s["cn"] else None,
            "parcels": s["parcels"],
            "transfers": s["transfers"],
            "relational": s["relational"],
            "totalSavings": round(s["totalSavings"]),
            "relationalSavings": round(s["relationalSavings"]),
            "savingsPerParcel": round(s["totalSavings"] / s["parcels"]) if s["parcels"] else 0,
            "medianRatio": round(statistics.median(s["ratios"]), 3) if s["ratios"] else None,
            "ppsfByYear": ppsf_by_year,
            "savingsByYear": {str(y): round(v) for y, v in sorted(nb_savings_by_year[nbhd].items())},
            "trend5y": trend5,
            "trendYears": trend_span,
        })
    neighborhoods.sort(key=lambda x: -x["totalSavings"])

    # neighborhoods.geojson: boundary polygons + per-type per-year stats, for the
    # 3D extruded model and the property-type filter / timeline.
    def pack_type(ts):
        return {
            "parcels": ts["parcels"],
            "relational": ts["relational"],
            "totalSavings": round(ts["totalSavings"]),
            "savingsPerParcel": round(ts["totalSavings"] / ts["parcels"]) if ts["parcels"] else 0,
            "savingsByYear": {str(y): round(v) for y, v in sorted(ts["savingsByYear"].items())},
            "parcelsByYear": {str(y): n for y, n in sorted(ts["parcelsByYear"].items())},
        }

    bound_path = os.path.join(config.RAW_DIR, "neighborhoods.geojson")
    nb_features = []
    if os.path.exists(bound_path):
        boundaries = json.load(open(bound_path))
        stat_by_name = {n["name"]: n for n in neighborhoods}
        for feat in boundaries["features"]:
            name = feat["properties"].get("nhood")
            st = stat_by_name.get(name)
            if not st:
                continue
            nb_features.append({
                "type": "Feature",
                "geometry": {"type": feat["geometry"]["type"], "coordinates": round_coords(feat["geometry"]["coordinates"])},
                "properties": {
                    "name": name,
                    "slug": st["slug"],
                    "center": st["center"],
                    "medianRatio": st["medianRatio"],
                    "trend5y": st["trend5y"],
                    "byType": {t: pack_type(nb_type[name][t]) for t in ("all", "sfh", "multi", "commercial")},
                },
            })
        with open(os.path.join(out_dir, "neighborhoods.geojson"), "w") as f:
            json.dump({"type": "FeatureCollection", "features": nb_features}, f, separators=(",", ":"))
        print(f"  wrote {len(nb_features)} neighborhood boundary features", flush=True)
    else:
        print("  neighborhoods.geojson boundary source missing; skipping 3D data")

    # aggregate CSV for researchers/journalists (neighborhood level only)
    csv_path = os.path.join(out_dir, "neighborhoods.csv")
    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "neighborhood", "parcels", "transfers_since_2007", "likely_relational_transfers",
            "est_total_annual_savings_usd", "est_savings_per_parcel_usd",
            "est_relational_annual_savings_usd", "median_assessed_to_market_ratio",
            "home_ppsf_latest", "home_ppsf_trend", "trend_span_years",
        ])
        for n in neighborhoods:
            years_p = sorted(n["ppsfByYear"]) if n["ppsfByYear"] else []
            w.writerow([
                n["name"], n["parcels"], n["transfers"], n["relational"],
                n["totalSavings"], n["savingsPerParcel"], n["relationalSavings"],
                n["medianRatio"], n["ppsfByYear"][years_p[-1]] if years_p else "",
                n["trend5y"], n["trendYears"],
            ])

    stamp_path = os.path.join(config.RAW_DIR, ".last_data_as_of")
    source_as_of = None
    if os.path.exists(stamp_path):
        source_as_of = open(stamp_path).read().strip()

    total_savings = sum(l["savings"] for l in leaderboard)
    relational_total = sum(n["relational"] for n in neighborhoods)
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({
            "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
            "sourceDataAsOf": (source_as_of or "")[:10] or None,
            "rollYear": config.ROLL_YEAR,
            "taxRate": config.TAX_RATE,
            "neighborhoodsIncluded": config.NEIGHBORHOODS,
            "parcelCount": matched,
            "totalEstAnnualSavings": round(total_savings),
            "relationalTransferCount": relational_total,
            "medianRatio": median_ratio,
            "savingsByYear": {str(y): round(v) for y, v in sorted(savings_by_year.items())},
            "estimatedParcelsByYear": {str(y): c for y, c in sorted(est_count_by_year.items())},
            "sankey": [
                {"cls": cls, "origin": origin, "savings": round(fl["savings"]), "count": fl["count"]}
                for (cls, origin), fl in sorted(sankey_flows.items())
            ],
            "neighborhoods": neighborhoods,
            "chunks": chunks,
        }, f, indent=1)

    # Remove the old monolithic payload if present
    old = os.path.join(out_dir, "parcels.json")
    if os.path.exists(old):
        os.remove(old)

    print(f"Matched {matched} parcels; {len(leaderboard)} with savings; {relational_total} relational; "
          f"{skipped_no_geom} skipped (no geometry)", flush=True)
    print(f"Total est annual savings citywide: ${total_savings:,.0f}", flush=True)
    for n in neighborhoods[:5]:
        print(f"  {n['name']}: ${n['totalSavings']:,}/yr, {n['relational']} relational", flush=True)


if __name__ == "__main__":
    main()
