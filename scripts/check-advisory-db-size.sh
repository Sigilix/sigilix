#!/usr/bin/env bash
# ARC-186: enforce the 500 KB cap on the bundled advisory DB.
#
# CI wires this in via `npm run check:advisory-db-size` (see package.json
# + the lint workflow). Failing this check is intentional — the v1
# bundled DB is a partial snapshot, and we want explicit operator
# review before crossing the bundle-size budget.

set -euo pipefail

DB="src/data/dep-vulns.json"
LIMIT_BYTES=$((500 * 1024))

if [ ! -f "$DB" ]; then
  echo "dep-vulns: bundled DB not found at $DB" >&2
  exit 1
fi

# Cross-platform size: use `wc -c` (works on Linux + macOS).
SIZE=$(wc -c < "$DB" | tr -d ' ')

if [ "$SIZE" -gt "$LIMIT_BYTES" ]; then
  echo "dep-vulns: bundled DB size ${SIZE} bytes exceeds the ${LIMIT_BYTES}-byte cap" >&2
  echo "dep-vulns: trim the snapshot per spec §10a retention policy or raise the cap intentionally" >&2
  exit 1
fi

echo "dep-vulns: bundled DB size OK (${SIZE} / ${LIMIT_BYTES} bytes)"
