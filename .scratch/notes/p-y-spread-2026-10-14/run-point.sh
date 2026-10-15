#!/usr/bin/env bash
# 用法: run-point.sh <variant P|Q> <val> <tag>
# 每点：打点 → 从本树源码重建 wasm → 拷 viewer/engine.wasm → 指纹 → like-football / spacing / e2e / 轨迹 png
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/y-axis; N=$ROOT/.scratch/notes/p-y-spread-2026-10-14
cd $ROOT
variant=$1; val=$2; tag=$3

python3 $N/mk.py $variant $val | tee $N/logs/fp-$tag.txt
libsha=$(sha256sum engine/src/lib.rs | cut -c1-16)

(cd engine && cargo build --target wasm32-unknown-unknown --release > $N/logs/build-$tag.log 2>&1) || { echo "BUILD-FAIL $tag"; exit 1; }
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
cp viewer/engine.wasm $N/wasm/$tag.wasm
wsha=$(sha256sum viewer/engine.wasm | cut -c1-16)
echo "$tag variant=$variant val=$val lib16=$libsha wasm16=$wsha" | tee -a $N/logs/fingerprints.txt

node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12 > $N/logs/lf-$tag.txt 2>&1
echo "lf-$tag done"
node tools/spacing-sweep.mjs > $N/logs/sp-$tag.txt 2>&1 || true
echo "sp-$tag done"
(cd viewer && node e2e-v2.mjs > $N/logs/e2e-$tag.txt 2>&1) || true
echo "e2e-$tag done"
for t0 in 600 1800 3600; do
  node tools/visual-review/trajectory.mjs $N/wasm/$tag.wasm $N/png/traj-$tag-w$t0.png 42 $t0 90 > /dev/null 2>&1
done
echo "traj-$tag done"
echo "POINT-$tag-DONE"
