#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Fails if any Go module or web package uses a licence that doesn't sit well with Apache 2.0.
set -euo pipefail
cd "$(dirname "$0")/.."

allowed='^(Apache-2\.0|MIT|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|OFL-1\.1|MPL-2\.0|CC-BY-4\.0|Python-2\.0)$'
bad=0

while IFS=, read -r module _ licence; do
  if ! [[ "$licence" =~ $allowed ]]; then echo "Go: $module uses $licence"; bad=1; fi
done < <(go run github.com/google/go-licenses/v2@v2.0.1 report ./... 2>/dev/null)

while IFS=$'\t' read -r licence packages; do
  if ! [[ "$licence" =~ $allowed ]]; then echo "web: $licence in $packages"; bad=1; fi
done < <(pnpm --dir web licenses list --json 2>/dev/null | python3 -c '
import json, sys
for licence, packages in json.load(sys.stdin).items():
    print(licence + "\t" + ", ".join(p["name"] for p in packages))')

if [ "$bad" = 1 ]; then echo "licence check failed"; exit 1; fi
echo "licences ok"
