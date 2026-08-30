#!/usr/bin/env bash
# Type-check src/lib/rails only.
#
# tsc follows imports, so once the adapters import $lib/walletService the
# program also contains pre-existing errors from files we are not changing
# (EsploraClient.ts, secureStorage.ts — part of the ~185 repo-wide errors).
# Report only diagnostics whose file lives under src/lib/rails.
set -uo pipefail

out=$(./node_modules/.bin/tsc -p tsconfig.rails.json --pretty false 2>&1 || true)
ours=$(printf '%s\n' "$out" | grep -E '^src/lib/rails/' || true)

if [ -n "$ours" ]; then
  echo "Type errors in src/lib/rails:"
  printf '%s\n' "$ours"
  exit 1
fi

echo "src/lib/rails: no type errors"
exit 0
