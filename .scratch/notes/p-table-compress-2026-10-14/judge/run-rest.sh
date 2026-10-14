#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/judge-table-axis; J=$ROOT/.scratch/notes/p-table-judge-2026-10-14
cd $ROOT
# 1) e2e smoke on 已建点
for t in base c070 c055 a060; do
  cp $J/wasm/$t.wasm viewer/engine.wasm
  (cd viewer && node e2e-v2.mjs > $J/e2e-$t.txt 2>&1); echo "e2e-$t done"
done
# 2) 自建 c=0.45 复现 e2e 红点
python3 $J/mk.py 0.45 C
(cd engine && cargo build --target wasm32-unknown-unknown --release > $J/build-c045.log 2>&1)
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
cp viewer/engine.wasm $J/wasm/c045.wasm
(cd viewer && node e2e-v2.mjs > $J/e2e-c045.txt 2>&1); echo "e2e-c045 done"
# 3) spacing 破点机制（c070, seed 42）
node zz_judge_spacing.mjs $J/wasm/c070.wasm 42 > $J/spacing-mech-c070.txt 2>&1; echo "spacing-mech done"
# 4) 瞬时形态：第二窗
for t in base c055 a060; do
  echo "== $t win1800 ==" >> $J/shape2.log
  node zz_judge_shape.mjs $J/wasm/$t.wasm 1800 90 >> $J/shape2.log 2>&1
  echo "== $t win3600 ==" >> $J/shape2.log
  node zz_judge_shape.mjs $J/wasm/$t.wasm 3600 90 >> $J/shape2.log 2>&1
done
echo REST-DONE
