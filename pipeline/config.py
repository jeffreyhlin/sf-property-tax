# Pipeline configuration.
# To go citywide, set NEIGHBORHOODS = None (expect ~200k parcels and a much
# larger download; consider switching the web app to vector tiles at that point).

# None = citywide (~240k parcels, ~3.9M roll rows, long download)
NEIGHBORHOODS = None

ROLL_YEAR = 2025          # latest closed roll year
HISTORY_START = 2007      # earliest year in the open dataset

# SF secured property tax rate (FY 2024-25 ~1.1805%). Good enough for
# estimates; parcel-level special assessments are not included.
TAX_RATE = 0.011805

# A parcel whose basis was reset within this many years is treated as a
# recent market sale and used to estimate neighborhood $/sqft.
MARKET_COMP_YEARS = 3

ROLL_URL = "https://data.sfgov.org/resource/wv5m-vpq2.csv"
PARCELS_URL = "https://data.sfgov.org/resource/acdm-wktn.geojson"

RAW_DIR = "data/raw"
OUT_DIR = "web/public/data"
