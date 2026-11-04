#!/usr/bin/env bash
# The command of the cells, one form for the runner and for a guest. Rule 3 of docs/S7.md pairs the
# two, thus a difference in this command must not exist.
# usage: cells.sh <regular expression of the cells> <folder of the records>
set -euo pipefail

export CELLS=1 CELLS_ONLY="$1" CELLS_SHARD=0/1 CELLS_OUT="$2"
# the catalogs' bands read the HZ of the kernel that the lab operates on
CELLS_HZ="$(sed -n 's/^CONFIG_HZ=//p' "/boot/config-$(uname -r)")"
if [ -z "$CELLS_HZ" ]; then echo "the configuration of $(uname -r) gives no CONFIG_HZ" >&2; exit 1; fi
export CELLS_HZ
cd "$(dirname "$0")/../../.."
mkdir -p "$CELLS_OUT"
pnpm --filter @systems/cells exec vitest run src/run.test.ts
