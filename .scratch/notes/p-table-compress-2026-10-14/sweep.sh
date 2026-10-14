#!/bin/bash
# 站位表压缩轴 sweep：每点从本树源码重建 wasm，落 wasm/ 与 logs/。
set -e
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/table-axis; N=$ROOT/.scratch/notes/p-table-compress-2026-10-14
cd $ROOT
for c in "$@"; do
  sed -i "s/^const TABLE_COMPRESS_C: f64 = .*/const TABLE_COMPRESS_C: f64 = $c;/" engine/src/lib.rs
  grep -q "TABLE_COMPRESS_C: f64 = $c;" engine/src/lib.rs || { echo "sed 失败 c=$c"; exit 1; }
  (cd engine && cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -E "^error" -A5 && exit 1 || true)
  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
  tag="c$(echo $c | tr -d '.')"
  cp viewer/engine.wasm $N/wasm/$tag.wasm
  libsha=$(sha256sum engine/src/lib.rs | cut -c1-16); wsha=$(sha256sum viewer/engine.wasm | cut -c1-16)
  echo "$c lib=$libsha wasm=$wsha" >> $N/logs/fingerprints.txt
  node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12 > $N/logs/lf-$tag.txt 2>&1
  echo "=== c=$c lib=$libsha wasm=$wsha ==="
  grep -E "分边★|纵深\(主\)|纵深\(客\)|紧凑度|宽度|球距|位移/窗|横向占比|混队度|^\*\*距离|方向一致性|位移/真实比" $N/logs/lf-$tag.txt
done
