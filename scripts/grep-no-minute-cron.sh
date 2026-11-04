#!/usr/bin/env bash
# Static guard — no every-minute cron triggers.
#
# The per-minute drain-loop pattern is gone for good. This script
# prevents accidental regression by
# failing CI if wrangler.toml contains the literal every-minute cron
# trigger "* * * * *".
#
# Allowed patterns: anything more selective than every-minute, e.g.
#   "0 17 * * *"     (daily at UTC 17:00)
#   "*/10 * * * *"   (every 10 min)
#   "0 */2 * * *"    (every 2 hours)
#
# Forbidden: the bare "* * * * *" form.
#
# Usage:
#   bash scripts/grep-no-minute-cron.sh
#
# In pre-commit / package.json test hooks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER="$ROOT/wrangler.toml"

if [[ ! -f "$WRANGLER" ]]; then
  echo "[grep-no-minute-cron] FAIL — $WRANGLER not found"
  exit 1
fi

# Match the exact every-minute pattern: a quoted string whose content is
# exactly "* * * * *" (with single spaces, no fractions). Anchored quotes
# avoid false-positives on substrings like "*/10 * * * *".
# Strip TOML comments before matching so the prose in wrangler.toml that
# describes "the forbidden \"* * * * *\" pattern\" doesn't trip the guard.
stripped=$(sed -e 's/[[:space:]]*#.*$//' "$WRANGLER")
if printf '%s\n' "$stripped" | grep -nE '"\*[[:space:]]\*[[:space:]]\*[[:space:]]\*[[:space:]]\*"'; then
  echo
  echo "[grep-no-minute-cron] ❌ FAIL — every-minute cron trigger \"* * * * *\" is forbidden."
  echo "                              The per-minute drain loop was removed;"
  echo "                              refills are now nightlyPrefillGuard + prefill_queue."
  exit 1
fi

echo "[grep-no-minute-cron] OK — no every-minute cron trigger in wrangler.toml"
