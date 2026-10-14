#!/usr/bin/env bash
# 用法: run-l1.sh <c> <C|A|base> <tag>
# base = 完全 pristine（git checkout，不打补丁）
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/judge-table-axis
J=$ROOT/.scratch/notes/p-table-judge-2026-10-14
cd $ROOT
c=$1; variant=$2; tag=$3
if [ "$variant" = "base" ]; then
  git checkout -- engine/src/lib.rs
else
  python3 $J/mk.py "$c" "$variant"
fi
libsha=$(sha256sum engine/src/lib.rs | cut -c1-16)
echo "L1 tag=$tag lib16=$libsha"
(cd engine && cargo test --test realism --release -- --ignored --nocapture > $J/L1raw-$tag.txt 2>&1) || true
echo "L1-$tag-DONE"
