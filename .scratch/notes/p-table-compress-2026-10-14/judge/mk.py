#!/usr/bin/env python3
"""判据镜自建轴：把 default_lineup 的 base.x 按 c 压向中线（门将豁免）。

用法: python3 mk.py <C> <variant>   variant ∈ {C, A}
  C  : 同时把 center0 换成新表队均（运行时算）
  A  : center0 保持 FORM_CENTER_HOME/AWAY 常量

只改两处；其余一律不碰。改完打印 lib.rs sha16。
"""
import hashlib, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
LIB = ROOT / "engine" / "src" / "lib.rs"

c = float(sys.argv[1])
variant = sys.argv[2].upper()
assert variant in ("C", "A"), variant

subprocess.run(["git", "checkout", "--", "engine/src/lib.rs"], cwd=ROOT, check=True)
src = LIB.read_text()

# ── 改动 1：default_lineup 的外场 x 压缩（i==0 是门将 → 豁免） ──
old_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        v.push(LineupPlayer { id: i as i32, x: *x, y: *y });
    }"""
new_home = """    for (i, (y, x)) in home_rows.iter().enumerate() {
        let xx = if i == 0 { *x } else { 0.5 + (*x - 0.5) * TABLE_COMPRESS_C };
        v.push(LineupPlayer { id: i as i32, x: xx, y: *y });
    }"""
assert src.count(old_home) == 1
src = src.replace(old_home, new_home)

old_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: *y });
    }"""
new_away = """    for (i, (y, x)) in away_rows.iter().enumerate() {
        let xx = if i == 0 { *x } else { 0.5 + (*x - 0.5) * TABLE_COMPRESS_C };
        v.push(LineupPlayer { id: 21 - i as i32, x: xx, y: *y });
    }"""
assert src.count(old_away) == 1
src = src.replace(old_away, new_away)

# 旋钮常量，插在 default_lineup 之前
anchor = "fn default_lineup() -> Vec<LineupPlayer> {"
assert src.count(anchor) == 1
src = src.replace(anchor, f"const TABLE_COMPRESS_C: f64 = {c!r};\n\n{anchor}")

# ── 改动 2：center0 的取法 ──
old_c0 = "    let center0 = if home { FORM_CENTER_HOME } else { FORM_CENTER_AWAY };"
assert src.count(old_c0) == 1
if variant == "C":
    new_c0 = """    let center0 = if TABLE_COMPRESS_C < 1.0 {
        // 变体 C：新表的队均（外场 id 1-10 / 11-20）
        let (lo, hi) = if home { (1, 10) } else { (11, 20) };
        let s: f64 = (lo..=hi).map(|i| st.lineup[i as usize].0).sum();
        s / 10.0
    } else if home { FORM_CENTER_HOME } else { FORM_CENTER_AWAY };"""
else:
    new_c0 = old_c0
src = src.replace(old_c0, new_c0)

LIB.write_text(src)
sha = hashlib.sha256(src.encode()).hexdigest()[:16]
print(f"c={c} variant={variant} lib.rs sha16={sha}")
