"""Build a lightweight PMTiles overview from the per-neighborhood chunks.

Emits web/public/data/parcels.pmtiles carrying only the fields the map needs to
color/pick a parcel at overview zooms: id, ratio, savings, transferType, cls.
Full history/detail stays in the per-neighborhood JSON chunks, loaded on click.

Requires tippecanoe on PATH (brew install tippecanoe). Run from repo root:
  python3 pipeline/tiles.py
"""
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import config

OUT = config.OUT_DIR
TMP = os.path.join(config.RAW_DIR, "parcels_slim.geojsonl")


def main():
    if not _have("tippecanoe"):
        print("tippecanoe not found on PATH — skipping PMTiles build.")
        return 1

    chunks = sorted(glob.glob(os.path.join(OUT, "nbhd", "*.json")))
    if not chunks:
        print("No neighborhood chunks found; run build.py first.")
        return 1

    n = 0
    with open(TMP, "w") as out:
        for path in chunks:
            fc = json.load(open(path))
            for feat in fc["features"]:
                p = feat["properties"]
                slim = {
                    "type": "Feature",
                    "geometry": feat["geometry"],
                    "properties": {
                        "id": p["id"],
                        "ratio": p["ratio"],
                        "savings": p["savings"],
                        "tt": p["transferType"],
                        "cls": p["cls"],
                    },
                }
                out.write(json.dumps(slim, separators=(",", ":")) + "\n")
                n += 1
    print(f"Wrote {n} slim features to {TMP}")

    pmtiles = os.path.join(OUT, "parcels.pmtiles")
    cmd = [
        "tippecanoe",
        "-o", pmtiles,
        "--force",
        "-l", "parcels",
        "-Z10", "-z16",            # overview zooms; detail comes from JSON chunks
        "--coalesce-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-size-limit",
        TMP,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    size = os.path.getsize(pmtiles)
    os.remove(TMP)
    print(f"Wrote {pmtiles} ({size / 1e6:.1f} MB)")
    return 0


def _have(binary):
    from shutil import which
    return which(binary) is not None


if __name__ == "__main__":
    sys.exit(main())
