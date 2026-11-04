#!/usr/bin/env bash
# Forbid hardcoded LLM/IMG timeout values in src/.
#
# Rationale: every hardcoded `90_000` / `120_000` / `30_000` etc in src/ that
# isn't routed through parseLlmTimeout(env.LLM_TIMEOUT_MS) is a future incident.
# Root cause this guards against: a legacy 30s default leaked into error
# messages because some path defaulted to LLM_TIMEOUT_MS instead of threading
# the env value.
#
# Allowed:
#   • src/lib/menu-gen.ts: `DEFAULT_LLM_TIMEOUT_MS`, `LLM_TIMEOUT_MIN_MS`,
#     `LLM_TIMEOUT_MAX_MS`, `IMG_TIMEOUT_MS`, `BLOB_FETCH_TIMEOUT_MS`,
#     `STALE_RUNNING_MS` (cron tick boundary, not LLM)
#   • parseLlmTimeout()'s clamp arithmetic
#   • test/* files
#
# Forbidden anywhere else: literal numbers like `90_000`, `120_000`, `30_000`
# followed by a comment/usage hint of "timeout" / "abort" / "ms".
#
# Usage:
#   bash scripts/check-no-hardcoded-timeout.sh
#
# Wire as pre-commit hook (one-time):
#   ln -sf ../../scripts/check-no-hardcoded-timeout.sh .git/hooks/pre-commit
#
# Wire as CI step: add to package.json `scripts.lint` or workflow step.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1) Find suspicious literal timeout patterns in src/, excluding the allowed
#    constant declarations in menu-gen.ts and the parseLlmTimeout body.
#    Allowed false-positive sites: comments (// ...), retry_after backoff math
#    (5*60_000, 15*60_000), time-math like off*60_000.
SUSPICIOUS=$(
  grep -nE '\b(30|90|120|180|300|600)_?000\b' src/ -r \
    --include='*.ts' --include='*.tsx' \
    | grep -vE '^[^:]+:[0-9]+:\s*//' \
    | grep -vE '^src/lib/menu-gen\.ts:.*(DEFAULT_LLM_TIMEOUT_MS|LLM_TIMEOUT_MIN_MS|LLM_TIMEOUT_MAX_MS|IMG_TIMEOUT_MS|BLOB_FETCH_TIMEOUT_MS|STALE_RUNNING_MS|TRANSIENT_BACKOFF_MS|parseLlmTimeout)' \
    | grep -vE '^src/lib/drain-trigger\.ts:.*DRAIN_LOCK_TTL_MS' \
    || true
)

if [ -n "$SUSPICIOUS" ]; then
  echo "❌ hardcoded timeout literal in src/ (route via parseLlmTimeout)"
  echo "$SUSPICIOUS"
  exit 1
fi

# 2) Forbid the legacy `LLM_TIMEOUT_MS` symbol (renamed to DEFAULT_LLM_TIMEOUT_MS
#    inside menu-gen.ts; nothing else should reference it).
LEGACY=$(grep -nE '\bLLM_TIMEOUT_MS\b' src/ -r --include='*.ts' --include='*.tsx' \
         | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)' \
         | grep -vE '^src/(lib/menu-gen\.ts|lib/drain-trigger\.ts|index\.tsx):.*(env\.LLM_TIMEOUT_MS|parseLlmTimeout|LLM_TIMEOUT_MS\?:)' \
         || true)
if [ -n "$LEGACY" ]; then
  echo "❌ legacy LLM_TIMEOUT_MS reference outside allowed sites"
  echo "$LEGACY"
  exit 1
fi

# 3) Forbid `: number = LLM_TIMEOUT_MS` / `: number = DEFAULT_LLM_TIMEOUT_MS`
#    default values (timeouts must be required args, threaded from env).
DEFAULTS=$(grep -nE ':\s*number\s*=\s*(DEFAULT_)?LLM_TIMEOUT_MS' src/ -r \
           --include='*.ts' --include='*.tsx' \
           | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)' \
           || true)
if [ -n "$DEFAULTS" ]; then
  echo "❌ timeout default value (must be required arg)"
  echo "$DEFAULTS"
  exit 1
fi

echo "✅ no hardcoded LLM timeout in src/"
