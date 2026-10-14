#!/usr/bin/env bash
# 用法: run-point.sh <c> <C|A> <tag>
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/judge-table-axis
J=$ROOT/.scratch/notes/p-table-judge-2026-10-14
cd $ROOT
c=$1; variant=$2; tag=$3

python3 $J/mk.py "$c" "$variant" | tee $J/fp-$tag.txt
libsha=$(sha256sum engine/src/lib.rs | cut -c1-16)
(cd engine && cargo build --target wasm32-unknown-unknown --release > $J/build-$tag.log 2>&1)
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
cp viewer/engine.wasm $J/wasm/$tag.wasm
wsha=$(sha256sum viewer/engine.wasm | cut -c1-16)
echo "c=$c variant=$variant lib16=$libsha wasm16=$wsha" >> $J/fingerprints.txt

node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12 > $J/lf-$tag.txt 2>&1
node tools/spacing-sweep.mjs > $J/sp-$tag.txt 2>&1 || true
echo "POINT-$tag-DONE"
