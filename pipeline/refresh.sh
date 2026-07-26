#!/bin/bash
# Refresh the map's data from DataSF if the source has changed.
# Usage: ./pipeline/refresh.sh [--force]
# Safe to run on a schedule; exits 0 without rebuilding when data is unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP_FILE="data/raw/.last_data_as_of"
LOG_DIR="data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/refresh-$(date +%Y%m%d-%H%M%S).log"

current=$(curl -sf "https://data.sfgov.org/resource/wv5m-vpq2.json?\$select=max(data_loaded_at)" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['max_data_loaded_at'])")

previous=$(cat "$STAMP_FILE" 2>/dev/null || echo "none")

if [[ "$current" == "$previous" && "${1:-}" != "--force" ]]; then
  echo "Source unchanged (data_loaded_at=$current); skipping rebuild." | tee -a "$LOG"
  exit 0
fi

echo "Source changed: $previous -> $current. Rebuilding..." | tee -a "$LOG"
python3 pipeline/fetch.py 2>&1 | tee -a "$LOG"
python3 pipeline/build.py 2>&1 | tee -a "$LOG"
echo "$current" > "$STAMP_FILE"
echo "Refresh complete at $(date)." | tee -a "$LOG"
