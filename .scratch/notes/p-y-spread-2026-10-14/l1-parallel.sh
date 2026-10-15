#!/usr/bin/env bash
# 每点一份独立 engine 拷贝（互不干扰），打点 + 追加只读探针 + 跑 realism 全量 --ignored。
# 用法: l1-parallel.sh "<variant> <val> <tag>" ...
set -u
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/y-axis; N=$ROOT/.scratch/notes/p-y-spread-2026-10-14
for spec in "$@"; do
  set -- $spec
  variant=$1; val=$2; tag=$3
  d=/tmp/l1y-$tag
  rm -rf $d; mkdir -p $d
  cp -r $ROOT/engine $d/engine
  rm -rf $d/engine/target
  # 一律从 git HEAD 取 pristine lib.rs -- 绝不拷贝可能正被 sweep 打点的工作树文件
  ( cd $ROOT && git show HEAD:engine/src/lib.rs ) > $d/engine/src/lib.rs
  grep -q 'const FORM_SPREAD_Y: f64 = 1.3;' $d/engine/src/lib.rs || { echo "FATAL: pristine lib.rs"; exit 1; }
  # 打点（直接在拷贝上做，不碰主树）
  python3 - "$d/engine/src/lib.rs" "$variant" "$val" <<'PY'
import hashlib, sys, pathlib
lib, variant, val = pathlib.Path(sys.argv[1]), sys.argv[2].upper(), float(sys.argv[3])
src = lib.read_text()
if variant == "P":
    old = "const FORM_SPREAD_Y: f64 = 1.3;"; new = f"const FORM_SPREAD_Y: f64 = {val!r};"
    assert src.count(old) == 1; src = src.replace(old, new)
else:
    old_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        v.push(LineupPlayer { id: i as i32, x: *x, y: *y });
    }"""
    new_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        let yy = if i == 0 { *y } else { 0.5 + (*y - 0.5) * TABLE_COMPRESS_C_Y };
        v.push(LineupPlayer { id: i as i32, x: *x, y: yy });
    }"""
    old_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: *y });
    }"""
    new_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        let yy = if i == 0 { *y } else { 0.5 + (*y - 0.5) * TABLE_COMPRESS_C_Y };
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: yy });
    }"""
    assert src.count(old_home) == 1 and src.count(old_away) == 1
    src = src.replace(old_home, new_home).replace(old_away, new_away)
    anchor = "fn default_lineup() -> Vec<LineupPlayer> {"
    assert src.count(anchor) == 1
    src = src.replace(anchor, f"const TABLE_COMPRESS_C_Y: f64 = {val!r};\n\n{anchor}")
lib.write_text(src)
print("patched", variant, val, hashlib.sha256(src.encode()).hexdigest()[:16])
PY
  [ $? -ne 0 ] && { echo "PATCH-FAIL $tag"; continue; }
  cat $N/band-probe.rs.txt >> $d/engine/tests/realism.rs
  ln -sfn $ROOT/openspec $d/openspec
  libsha=$(sha256sum $d/engine/src/lib.rs | cut -c1-16)
  echo "$tag variant=$variant val=$val lib16=$libsha" > $N/logs/L1-$tag.meta.txt
  ( cd $d/engine && cargo test --test realism --release -- --ignored --nocapture > $N/logs/L1-raw-$tag.txt 2>&1 ) &
  echo "launched $tag"
done
wait
echo "L1-BATCH-DONE"
