#!/usr/bin/env bash
# Daily integrity check for menu_pool dead inventory.
#
# Invariant: menu_pool rows with image_blob IS NULL AND consumed=0
# are forbidden. Any non-zero count post-deploy = bug.
#
# Usage: run from a host with wrangler + CF_API_TOKEN env.
# Crontab suggestion:
#   30 3 * * *  cd /path/to/open-health && bash scripts/health-pool-integrity.sh
#
# Exit: 0 = clean, 1 = dead rows detected (caller can pipe into any alerting channel).
set -euo pipefail

cd "$(dirname "$0")/.."

JSON=$(npx wrangler d1 execute health_db --remote --command \
  "SELECT COUNT(*) AS dead FROM menu_pool WHERE image_blob IS NULL AND consumed=0" \
  --json 2>/dev/null)

DEAD=$(echo "$JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['dead'])")

if [ "$DEAD" -gt 0 ]; then
  echo "[ALERT] menu_pool invariant violated: $DEAD dead row(s) (image_blob IS NULL AND consumed=0)"
  # TODO: wire to your alerting channel (chat webhook, email, etc.). Placeholder
  # exits non-zero so the cron mail-on-failure path catches it in the meantime.
  exit 1
fi

echo "[OK] menu_pool integrity: 0 dead rows"
exit 0
