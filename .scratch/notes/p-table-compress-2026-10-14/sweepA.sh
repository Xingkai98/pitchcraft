#!/bin/bash
# 变体 A（对照）：压缩表 + FORM_CENTER_* 常量不动。
set -e
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/table-axis; N=$ROOT/.scratch/notes/p-table-compress-2026-10-14
cd $ROOT
python3 - <<'PY'
import re,io
p='engine/src/lib.rs'; s=open(p).read()
old = """    let center0 = if home {
        (1..=10).map(|i| st.lineup[i].0).sum::<f64>() / 10.0
    } else {
        (11..=20).map(|i| st.lineup[i].0).sum::<f64>() / 10.0
    };"""
new = "    let center0 = if home { FORM_CENTER_HOME } else { FORM_CENTER_AWAY }; // [变体 A 对照]"
assert old in s, "center0 块未找到"
open(p,'w').write(s.replace(old,new))
PY
for c in "$@"; do
  sed -i "s/^const TABLE_COMPRESS_C: f64 = .*/const TABLE_COMPRESS_C: f64 = $c;/" engine/src/lib.rs
  (cd engine && cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -E "^error" -A5 || true)
  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
  tag="A$(echo $c | tr -d '.')"
  cp viewer/engine.wasm $N/wasm/$tag.wasm
  libsha=$(sha256sum engine/src/lib.rs | cut -c1-16); wsha=$(sha256sum viewer/engine.wasm | cut -c1-16)
  echo "A c=$c lib=$libsha wasm=$wsha" >> $N/logs/fingerprints.txt
  node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12 > $N/logs/lf-$tag.txt 2>&1
  echo "=== 变体A c=$c lib=$libsha wasm=$wsha ==="
  grep -E "分边★|纵深\(主\)|纵深\(客\)|紧凑度|宽度|球距|位移/窗|横向占比|混队度|^\*\*距离|方向一致性" $N/logs/lf-$tag.txt
done
