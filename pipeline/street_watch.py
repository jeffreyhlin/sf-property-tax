"""Street-level watch: snapshot a street's parcels and alert on changes.

Reads the built neighborhood chunks in web/public/data/nbhd/. For each watch in
pipeline/watches.json, it snapshots the matching street's parcels (savings,
transfer type/year, taxed value) and diffs against the previous snapshot stored
in data/watch_state/. New transfers and material savings changes become an alert.

Usage:
  python3 pipeline/street_watch.py            # run all watches, print alerts
  python3 pipeline/street_watch.py --html OUT # also write an HTML alert digest

watches.json format:
  [{"email": "you@example.com", "neighborhood": "Noe Valley", "street": "ALVARADO ST"}]

This produces the alert CONTENT only. Delivery (email) is handled separately so
nothing is ever sent without review.
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import config

STATE_DIR = os.path.join("data", "watch_state")


def slugify(name):
    import re
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def load_street(neighborhood, street):
    path = os.path.join(config.OUT_DIR, "nbhd", f"{slugify(neighborhood)}.json")
    if not os.path.exists(path):
        return None
    fc = json.load(open(path))
    target = street.strip().upper()
    out = {}
    for feat in fc["features"]:
        p = feat["properties"]
        if (p.get("street") or "").strip().upper() == target:
            out[p["id"]] = {
                "addr": p["addr"],
                "savings": p["savings"],
                "transferType": p["transferType"],
                "transferYear": p["transferYear"],
                "assessed": p["assessed"],
                "ratio": p["ratio"],
            }
    return out


def diff(prev, cur):
    """Return a list of human-readable change lines."""
    changes = []
    for pid, now in cur.items():
        was = prev.get(pid)
        if was is None:
            continue  # brand-new parcel record; skip on first appearance
        if now["transferType"] != was["transferType"] and now["transferType"] != "none":
            changes.append(
                f"{now['addr']} changed hands ({label(now['transferType'])}"
                f"{', ' + str(now['transferYear']) if now['transferYear'] else ''})"
            )
        elif now["savings"] and was["savings"]:
            delta = now["savings"] - was["savings"]
            if abs(delta) >= 2000:
                dirn = "up" if delta > 0 else "down"
                changes.append(
                    f"{now['addr']} est. tax gap {dirn} {money(abs(delta))}/yr "
                    f"(now {money(now['savings'])}/yr)"
                )
    return changes


def label(tt):
    return {
        "relational": "likely family/trust transfer",
        "market": "market sale",
        "partial": "partial reassessment",
    }.get(tt, tt)


def money(n):
    return "$" + format(int(round(n)), ",")


def summarize(street, neighborhood, cur):
    vals = [p for p in cur.values() if p["ratio"] is not None]
    n = len(cur)
    relational = sum(1 for p in cur.values() if p["transferType"] == "relational")
    total_sav = sum(p["savings"] or 0 for p in cur.values())
    return {
        "street": street,
        "neighborhood": neighborhood,
        "parcels": n,
        "relational": relational,
        "totalSavings": total_sav,
        "withEstimate": len(vals),
    }


def run(write_html=None):
    watches_path = os.path.join(os.path.dirname(__file__), "watches.json")
    if not os.path.exists(watches_path):
        print("No watches.json; nothing to watch.")
        return []
    os.makedirs(STATE_DIR, exist_ok=True)
    watches = json.load(open(watches_path))
    alerts = []
    for w in watches:
        cur = load_street(w["neighborhood"], w["street"])
        if cur is None:
            print(f"  chunk for {w['neighborhood']} not found; skipping")
            continue
        key = f"{slugify(w['neighborhood'])}__{slugify(w['street'])}"
        state_path = os.path.join(STATE_DIR, key + ".json")
        prev = json.load(open(state_path)) if os.path.exists(state_path) else None
        changes = diff(prev, cur) if prev else []
        first_run = prev is None
        json.dump(cur, open(state_path, "w"))
        alerts.append({
            "email": w["email"],
            "summary": summarize(w["street"], w["neighborhood"], cur),
            "changes": changes,
            "firstRun": first_run,
        })
        tag = "baseline" if first_run else f"{len(changes)} change(s)"
        print(f"  {w['street']} / {w['neighborhood']}: {tag}")

    if write_html and alerts:
        with open(write_html, "w") as f:
            f.write(render_html(alerts[0]))
        print(f"Wrote HTML alert digest to {write_html}")
    return alerts


def render_html(alert):
    s = alert["summary"]
    rows = "".join(f"<li>{c}</li>" for c in alert["changes"])
    intro = (
        "This is your first digest, so here's the current picture. Future emails will "
        "flag what changed."
        if alert["firstRun"]
        else "Here's what changed on your street since the last update."
    )
    changed_block = (
        f"<h3 style='margin:18px 0 6px;color:#2c2418'>What changed</h3><ul>{rows}</ul>"
        if alert["changes"]
        else "<p style='color:#8a8070'>No changes since the last update.</p>"
    )
    return f"""<!doctype html>
<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#3a3226;background:#f7f3ea;padding:24px;border-radius:12px">
  <div style="height:6px;background:#b25007;border-radius:3px;margin-bottom:16px"></div>
  <h2 style="margin:0 0 4px;color:#2c2418">{s['street']} · {s['neighborhood']}</h2>
  <p style="color:#8a8070;margin:0 0 16px">SF Property Tax Gap · street watch</p>
  <p>{intro}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin:14px 0">
    <tr><td style="padding:6px 0;color:#8a8070">Properties on the street</td><td style="text-align:right;font-weight:600">{s['parcels']}</td></tr>
    <tr><td style="padding:6px 0;color:#8a8070">Likely family/trust transfers</td><td style="text-align:right;font-weight:600">{s['relational']}</td></tr>
    <tr><td style="padding:6px 0;color:#8a8070">Est. total annual tax savings</td><td style="text-align:right;font-weight:600;color:#b25007">{money(s['totalSavings'])}/yr</td></tr>
  </table>
  {changed_block}
  <p style="font-size:12px;color:#a89f8c;margin-top:20px">
    Estimates from DataSF open data. "Likely family/trust transfer" is inferred from
    assessment behavior, not recorded deeds. Reply STOP to unsubscribe.
  </p>
</div>"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", help="write an HTML alert digest to this path")
    args = ap.parse_args()
    run(write_html=args.html)
