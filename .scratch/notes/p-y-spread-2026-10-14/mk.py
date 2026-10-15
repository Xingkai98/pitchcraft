#!/usr/bin/env python3
"""y 轴 sweep 打点脚本：变体 P（改 FORM_SPREAD_Y 常数）/ 变体 Q（压站位表 y）。

用法: python3 mk.py P <S>        # FORM_SPREAD_Y = S
      python3 mk.py Q <c_y>      # base.y' = 0.5 + (base.y-0.5)*c_y（门将豁免）

只改这一处；其余一律不碰。改完打印 lib.rs sha16。
"""
import hashlib, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
LIB = ROOT / "engine" / "src" / "lib.rs"

variant = sys.argv[1].upper()
val = float(sys.argv[2])
assert variant in ("P", "Q"), variant

subprocess.run(["git", "checkout", "--", "engine/src/lib.rs"], cwd=ROOT, check=True)
src = LIB.read_text()

if variant == "P":
    old = "const FORM_SPREAD_Y: f64 = 1.3;"
    new = f"const FORM_SPREAD_Y: f64 = {val!r};"
    assert src.count(old) == 1, "FORM_SPREAD_Y 定义未找到/不唯一"
    src = src.replace(old, new)
else:
    # 变体 Q：压站位表的 y（门将 i==0 豁免）
    old_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        v.push(LineupPlayer { id: i as i32, x: *x, y: *y });
    }"""
    new_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        let yy = if i == 0 { *y } else { 0.5 + (*y - 0.5) * TABLE_COMPRESS_C_Y };
        v.push(LineupPlayer { id: i as i32, x: *x, y: yy });
    }"""
    assert src.count(old_home) == 1
    src = src.replace(old_home, new_home)

    old_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: *y });
    }"""
    new_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        let yy = if i == 0 { *y } else { 0.5 + (*y - 0.5) * TABLE_COMPRESS_C_Y };
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: yy });
    }"""
    assert src.count(old_away) == 1
    src = src.replace(old_away, new_away)

    anchor = "fn default_lineup() -> Vec<LineupPlayer> {"
    assert src.count(anchor) == 1
    src = src.replace(anchor, f"const TABLE_COMPRESS_C_Y: f64 = {val!r};\n\n{anchor}")

LIB.write_text(src)
sha = hashlib.sha256(src.encode()).hexdigest()[:16]
print(f"variant={variant} val={val} lib.rs sha16={sha}")
