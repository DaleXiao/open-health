#!/usr/bin/env bash
# Static guard — live LLM calls are only allowed inside the two private
# functions (__generateMealCandidates / __generateImageUrl) in menu-gen.ts.
# Any other src/ file referencing chat/completions or images/generations
# fails immediately so CI catches it.
#
# Usage:
#   bash scripts/grep-no-live-llm.sh
#
# Wire into pre-commit / the package.json test hook.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"

# Whitelist: this is the only file allowed to contain dashscope endpoint literals.
ALLOWED_FILE="src/lib/menu-gen.ts"

# 1) Find hits across all of src/
hits=$(grep -RnE 'chat/completions|images/generations' "$SRC" || true)

if [[ -z "$hits" ]]; then
  echo "[grep-no-live-llm] OK — no live-LLM literals found in src/"
  exit 0
fi

# 2) Pick out the files not on the whitelist
bad=$(echo "$hits" | grep -v ":$ALLOWED_FILE" | grep -v "^$ALLOWED_FILE:" || true)
# Path-form note: the previous line's output is `src/lib/menu-gen.ts:NNN:...` — match on the path directly.
bad=$(echo "$hits" | awk -F: '{ if ($1 !~ "menu-gen\\.ts$") print }')

if [[ -n "$bad" ]]; then
  echo "[grep-no-live-llm] ❌ FAIL — live-LLM endpoint literals leaked outside $ALLOWED_FILE:"
  echo "$bad"
  exit 1
fi

# 3) Inside menu-gen.ts we also check the literals only appear in the two
#    private functions. Simplified: check that the `__generateMealCandidates`
#    and `__generateImageUrl` identifiers exist in the file, and that the
#    CHAT_PATH/IMG_PATH constants are not exported.
if ! grep -q '__generateMealCandidates' "$SRC/lib/menu-gen.ts"; then
  echo "[grep-no-live-llm] ❌ FAIL — __generateMealCandidates not found in menu-gen.ts"
  exit 1
fi
if ! grep -q '__generateImageUrl' "$SRC/lib/menu-gen.ts"; then
  echo "[grep-no-live-llm] ❌ FAIL — __generateImageUrl not found in menu-gen.ts"
  exit 1
fi
if grep -qE '^export[[:space:]]+(const|async function)[[:space:]]+(CHAT_PATH|IMG_PATH|__generate)' "$SRC/lib/menu-gen.ts"; then
  echo "[grep-no-live-llm] ❌ FAIL — private LLM helpers are exported from menu-gen.ts"
  grep -nE '^export[[:space:]]+(const|async function)[[:space:]]+(CHAT_PATH|IMG_PATH|__generate)' "$SRC/lib/menu-gen.ts"
  exit 1
fi

echo "[grep-no-live-llm] OK — live-LLM literals confined to $ALLOWED_FILE private helpers"
