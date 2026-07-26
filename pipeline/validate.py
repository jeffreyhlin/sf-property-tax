"""Validate the market-value comps model on held-out basis resets.

Every parcel whose Prop 13 basis reset via a market sale in EVAL_YEARS
(sale-date change followed by an assessed jump >25%, i.e. the same "reset"
event logic as build.analyze()) is a held-out observation: its post-reset
assessed value is treated as ground-truth market value.

Prediction uses the exact comps cell build.py would use for that
(neighborhood, reset year, class), but leave-one-out: the target parcel's
own contributions to the cell are excluded before taking the median $/sqft,
and the MIN_COMPS threshold is re-applied to the remaining comps.

Reports count evaluated, median absolute percentage error (MAPE) and median
signed error (bias) overall, by class, and for the 10 largest neighborhoods
(by eligible resets), plus coverage (fraction of eligible resets with a
usable comps cell). Writes docs/model-validation.json and prints a summary.

Run:  python3 pipeline/validate.py
"""
import datetime
import json
import os
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config
from build import MIN_COMPS, analyze, classify, comp_class, load_roll

EVAL_START, EVAL_END = 2022, 2025  # inclusive


def sale_reset_years(rec):
    """Years where the basis reset because of a sale-date change (>25% jump).

    Mirrors the first branch of build.analyze(); deliberately excludes the
    no-sale-change (growth > 0.5) resets, which are inferred rather than
    directly tied to a recorded sale, so ground truth stays clean.
    """
    out = []
    prev_assessed = None
    prev_sale = None
    for year, assessed, sale in rec["yrs"]:
        if prev_assessed is not None and sale != prev_sale and sale:
            growth = (assessed - prev_assessed) / prev_assessed if prev_assessed > 0 else 0
            if growth > 0.25:
                out.append(year)
        prev_assessed, prev_sale = assessed, sale
    return out


def summarize(errors):
    """errors: list of (pred - truth) / truth."""
    if not errors:
        return {"n": 0, "medianAPE": None, "medianError": None}
    return {
        "n": len(errors),
        "medianAPE": round(statistics.median(abs(e) for e in errors), 4),
        "medianError": round(statistics.median(errors), 4),
    }


def main():
    roll_path = os.path.join(config.RAW_DIR, "roll.csv")
    print("Loading roll (streaming)...", flush=True)
    roll = load_roll(roll_path)
    print(f"  {len(roll)} parcels with history", flush=True)

    # Build the comps pool exactly as build.py does (all "reset" events),
    # but keep the contributing pid so we can leave the target out.
    comps_year = defaultdict(list)  # (nbhd, year, cls) -> [(pid, ppsf), ...]
    targets = []  # (pid, nbhd, cls, reset_year, truth_assessed, area)
    for pid, rec in roll.items():
        history, events, basis_year, last_transfer, reset_values = analyze(rec)
        cls = classify(rec)
        ccls = comp_class(cls, rec["units"])
        area = rec["area"]
        if ccls is None or area <= 200:
            continue
        assessed_by_year = dict((y, a) for y, a in history)
        for reset_year, kind in events:
            if kind != "reset":
                continue
            # reassessed value (market at sale), matching build.py's comps
            v = reset_values.get(reset_year, 0)
            if v <= 100000:
                continue
            for y in range(reset_year, min(reset_year + config.MARKET_COMP_YEARS, config.ROLL_YEAR + 1)):
                comps_year[(rec["nbhd"], y, ccls)].append((pid, v / area))
        # Held-out targets: sale-triggered resets in the eval window. Ground truth
        # is the reassessed value (the post-sale market basis), not the sale-year row.
        for reset_year in sale_reset_years(rec):
            if not (EVAL_START <= reset_year <= EVAL_END):
                continue
            v = reset_values.get(reset_year, assessed_by_year.get(reset_year, 0))
            if v <= 100000:
                continue
            targets.append((pid, rec["nbhd"], cls, ccls, reset_year, v, area))

    print(f"  comps cells: {len(comps_year)}; eligible resets {EVAL_START}-{EVAL_END}: {len(targets)}", flush=True)

    # Evaluate leave-one-out.
    overall_errors = []
    by_class_errors = defaultdict(list)
    by_nbhd_errors = defaultdict(list)
    eligible_total = len(targets)
    covered_total = 0
    eligible_by_class = defaultdict(int)
    covered_by_class = defaultdict(int)
    eligible_by_nbhd = defaultdict(int)
    covered_by_nbhd = defaultdict(int)

    for pid, nbhd, cls, ccls, reset_year, truth, area in targets:
        eligible_by_class[cls] += 1
        eligible_by_nbhd[nbhd] += 1
        cell = comps_year.get((nbhd, reset_year, ccls), [])
        others = [ppsf for cpid, ppsf in cell if cpid != pid]
        if len(others) < MIN_COMPS[ccls]:
            continue  # no usable comps cell without the target itself
        pred = statistics.median(others) * area
        err = (pred - truth) / truth
        covered_total += 1
        covered_by_class[cls] += 1
        covered_by_nbhd[nbhd] += 1
        overall_errors.append(err)
        by_class_errors[cls].append(err)
        by_nbhd_errors[nbhd].append(err)

    overall = summarize(overall_errors)
    overall["eligible"] = eligible_total
    overall["coverage"] = round(covered_total / eligible_total, 4) if eligible_total else None

    by_class = {}
    for cls in ("sfh", "multi"):
        s = summarize(by_class_errors[cls])
        s["eligible"] = eligible_by_class[cls]
        s["coverage"] = (
            round(covered_by_class[cls] / eligible_by_class[cls], 4)
            if eligible_by_class[cls] else None
        )
        by_class[cls] = s

    top_nbhds = sorted(eligible_by_nbhd, key=lambda n: -eligible_by_nbhd[n])[:10]
    by_nbhd = []
    for nbhd in top_nbhds:
        s = summarize(by_nbhd_errors[nbhd])
        s["name"] = nbhd or "Unknown"
        s["eligible"] = eligible_by_nbhd[nbhd]
        s["coverage"] = round(covered_by_nbhd[nbhd] / eligible_by_nbhd[nbhd], 4)
        by_nbhd.append(s)

    result = {
        "generated": datetime.date.today().isoformat(),
        "evalYears": [EVAL_START, EVAL_END],
        "method": (
            "Ground truth = post-reset assessed value for sale-triggered basis resets "
            f"({EVAL_START}-{EVAL_END}). Prediction = leave-one-out median $/sqft of the "
            "same (neighborhood, year, class) comps cell build.py uses (trailing "
            f"{config.MARKET_COMP_YEARS}-year reset window, MIN_COMPS re-applied after "
            "excluding the target parcel), times building area. Errors are "
            "(pred - truth) / truth; medianAPE = median absolute percentage error, "
            "medianError = median signed error (bias)."
        ),
        "filters": {
            "classes": ["home", "apartment"],
            "minArea": 200,
            "minAssessedAtReset": 100000,
            "minComps": MIN_COMPS,
        },
        "overall": overall,
        "byClass": by_class,
        "byNeighborhoodTop10": by_nbhd,
    }

    out_path = os.path.join("docs", "model-validation.json")
    os.makedirs("docs", exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=1)
    print(f"Wrote {out_path}", flush=True)

    def line(label, s):
        cov = f"{s['coverage'] * 100:.1f}%" if s.get("coverage") is not None else "n/a"
        if s["n"]:
            print(
                f"  {label:<28} n={s['n']:<6} MAPE={s['medianAPE'] * 100:6.1f}%  "
                f"bias={s['medianError'] * 100:+6.1f}%  coverage={cov} "
                f"({s['n']}/{s['eligible']})"
            )
        else:
            print(f"  {label:<28} n=0      (no covered resets; eligible={s['eligible']})")

    print(f"\nValidation on held-out resets {EVAL_START}-{EVAL_END} (leave-one-out comps):")
    line("overall", overall)
    for cls in ("sfh", "multi"):
        line(cls, by_class[cls])
    print("  -- 10 largest neighborhoods (by eligible resets) --")
    for s in by_nbhd:
        line(s["name"], s)


if __name__ == "__main__":
    main()
