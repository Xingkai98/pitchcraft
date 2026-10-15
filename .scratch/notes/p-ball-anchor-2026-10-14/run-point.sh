#!/usr/bin/env bash
# 用法: run-point.sh <tag> <anchor> [block_scale_y]
# 每点：从**本树源码**（engine/，含机制、ANCHOR=0）打点 → 独立拷贝构建 wasm → 拷 viewer/engine.wasm
#       → 指纹 → 机制三条+分箱 / like-football / spacing-sweep / e2e-v2 / 多窗轨迹 png
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/ball-anchor; N=$ROOT/.scratch/notes/p-ball-anchor-2026-10-14
tag=$1; anchor=$2; yscale=${3:-}
d=/tmp/ba-$tag
rm -rf $d; mkdir -p $d
cp -r $ROOT/engine $d/engine
rm -rf $d/engine/target
ln -sfn $ROOT/openspec $d/openspec

python3 $N/probe/patch.py $d/engine/src/lib.rs "$anchor" $yscale | tee $N/logs/fp-$tag.txt || { echo "PATCH-FAIL $tag"; exit 1; }
libsha=$(sha256sum $d/engine/src/lib.rs | cut -c1-16)

(cd $d/engine && cargo build --target wasm32-unknown-unknown --release > $N/logs/build-$tag.log 2>&1) \
  || { echo "BUILD-FAIL $tag"; exit 1; }
cp $d/engine/target/wasm32-unknown-unknown/release/fm_engine.wasm $N/wasm/$tag.wasm
cp $N/wasm/$tag.wasm $ROOT/viewer/engine.wasm
wsha=$(sha256sum $N/wasm/$tag.wasm | cut -c1-16)
echo "$tag anchor=$anchor yscale=${yscale:-same} lib16=$libsha wasm16=$wsha" | tee -a $N/logs/fingerprints.txt

node $N/probe/stream-hash.mjs $N/wasm/$tag.wasm 1 12 5400 > $N/logs/stream-$tag.txt 2>&1
node $N/probe/mechanism.mjs $N/wasm/$tag.wasm 5 5400 0.2 > $N/logs/mech-$tag.json 2>&1
echo "mech-$tag done"
node $ROOT/tools/visual-review/like-football.mjs $N/wasm/$tag.wasm 5 12 > $N/logs/lf-$tag.txt 2>&1
echo "lf-$tag done"
node $ROOT/tools/spacing-sweep.mjs > $N/logs/sp-$tag.txt 2>&1 || true
echo "sp-$tag done"
(cd $ROOT/viewer && node e2e-v2.mjs > $N/logs/e2e-$tag.txt 2>&1) || true
echo "e2e-$tag done"
for t0 in 600 1800 3600; do
  node $ROOT/tools/visual-review/trajectory.mjs $N/wasm/$tag.wasm $N/png/traj-$tag-w$t0.png 42 $t0 90 > /dev/null 2>&1
done
echo "traj-$tag done"
echo "POINT-$tag-DONE"
