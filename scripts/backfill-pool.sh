#!/usr/bin/env bash
# One-shot ops backfill for the configured username list (current + next iso_week).
#
# Calls POST /admin/backfill-pool which queues prefillPoolWeek via ctx.waitUntil
# for each (user, iso_week) pair. The endpoint is admin-cookie protected; pass
# the session cookie via ADMIN_COOKIE env var (or argument 1).
#
# Usage:
#   ADMIN_COOKIE='session=...' bash scripts/backfill-pool.sh
#   bash scripts/backfill-pool.sh 'session=...'
#
# After the response returns, watch wrangler tail for [backfill-pool] log lines.

set -euo pipefail

URL="${BACKFILL_URL:-https://your-domain.example.com/admin/backfill-pool}"
COOKIE="${1:-${ADMIN_COOKIE:-}}"

if [ -z "$COOKIE" ]; then
  echo "error: admin session cookie required (ADMIN_COOKIE env or argv 1)" >&2
  echo "       e.g. ADMIN_COOKIE='session=<value>' bash $0" >&2
  exit 2
fi

echo "[backfill-pool] POST $URL"
curl -fsS -X POST "$URL" \
  -H "Cookie: $COOKIE" \
  -H "Accept: application/json" \
  | tee /dev/stderr | (command -v jq >/dev/null && jq . || cat)
echo
echo "[backfill-pool] queued. Watch wrangler tail for [backfill-pool] log lines."
