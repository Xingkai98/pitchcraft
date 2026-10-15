#!/usr/bin/env python3
"""把 `[Y]` 探针行解析成「逐带实测值 + 余量」表。用法: python3 l1-table.py <L1-raw-TAG.txt> <标签>"""
import re, sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text()
tag = sys.argv[2] if len(sys.argv) > 2 else "?"

# (带名, 正则捕获组序号取自下方提取的字典, 下界, 上界)  —— 上界 None = 无上界
BANDS = [
    ("射门/场", "shots_pm", 14.0, 29.0),
    ("禁区内射门占比", "box_share", 0.45, 0.65),
    ("box goal", "bg", 0.10, 0.20),
    ("box saved", "bsv", 0.24, 0.36),
    ("box off", "bof", 0.48, 0.60),
    ("arc goal", "ag", 0.03, 0.12),
    ("arc saved", "asv", 0.14, 0.30),
    ("arc off", "aof", 0.61, 0.75),
    ("far goal", "fg", 0.0, 0.08),
    ("far saved", "fsv", 0.04, 0.18),
    ("far off", "fof", 0.78, 0.92),
    ("头球 chi2", "chi", None, 13.82),
    ("sot", "sot", 0.28, 0.39),
    ("conv", "conv", 0.08, 0.14),
    ("禁区内进球占比", "inside", 0.72, 0.92),
    ("抢断/场", "tackles_pm", 24.0, 50.0),
    ("抢断成功率", "tsucc", 0.42, 0.58),
    ("close 抢断成功率", "csucc", 0.42, 0.58),
    ("shot/tackle", "ratio", 0.50, 1.50),
    ("角球/场", "corner_pm", 1.0, 7.0),
    ("角球单场max", "corner_max", None, 15.0),
    ("界外球/场", "throw_pm", 15.0, 60.0),
    ("传球成功率", "pass_rate", 0.82, 0.90),
    ("拦截占失败比", "int_share", 0.55, 0.90),
    ("犯规/场", "foul_pm", 16.0, 30.0),
    ("黄牌/场", "yellow_pm", 2.0, 5.0),
    ("红牌/场", "red_pm", None, 0.80),
    ("主队进球/场", "gh_pm", 0.85, 1.60),
    ("客队进球/场", "ga_pm", 0.30, None),
    ("shot_far45", "far45", None, 0.0),
    ("抢断far", "tfar", None, 0.0),
]

d = {}
def g(pat, txt, cast=float):
    m = re.search(pat, txt)
    return cast(m.group(1)) if m else None

d["shots_pm"] = g(r"射门/场 = ([\d.]+)", src)
d["box_share"] = g(r"禁区内射门占比 = ([\d.]+)", src)
m = re.search(r"box g/sv/off = ([\d.]+)/([\d.]+)/([\d.]+)", src)
if m: d["bg"], d["bsv"], d["bof"] = map(float, m.groups())
m = re.search(r"arc g/sv/off = ([\d.]+)/([\d.]+)/([\d.]+)", src)
if m: d["ag"], d["asv"], d["aof"] = map(float, m.groups())
m = re.search(r"far g/sv/off = ([\d.]+)/([\d.]+)/([\d.]+)", src)
if m: d["fg"], d["fsv"], d["fof"] = map(float, m.groups())
d["chi"] = g(r"chi2 = ([\d.]+)", src)
d["sot"] = g(r"sot = ([\d.]+)", src)
d["conv"] = g(r"conv = ([\d.]+)", src)
d["inside"] = g(r"禁区内进球占比 = ([\d.]+)", src)
d["tackles_pm"] = g(r"抢断/场 = ([\d.]+)", src)
d["tsucc"] = g(r"成功率 = ([\d.]+)", src)
d["csucc"] = g(r"close_succ = ([\d.]+)", src)
d["ratio"] = g(r"shot/tackle = ([\d.]+)", src)
d["corner_pm"] = g(r"角球/场 = ([\d.]+)", src)
d["corner_max"] = g(r"单场max = (\d+)", src)
d["throw_pm"] = g(r"界外球/场 = ([\d.]+)", src)
d["pass_rate"] = g(r"传球成功率 = ([\d.]+)", src)
d["int_share"] = g(r"拦截占失败 = ([\d.]+)", src)
d["foul_pm"] = g(r"犯规/场 = ([\d.]+)", src)
d["yellow_pm"] = g(r"黄 = ([\d.]+)", src)
d["red_pm"] = g(r"红 = ([\d.]+)", src)
d["gh_pm"] = g(r"主/场 = ([\d.]+)", src)
d["ga_pm"] = g(r"客/场 = ([\d.]+)", src)
d["far45"] = g(r"shot_far45 = (\d+)", src)
d["tfar"] = g(r"far = (\d+) \(==0\)", src)

print(f"L1 逐带实测值 —— {tag}")
print(f"{'带名':<18}{'实测':>10}{'带下界':>10}{'带上界':>10}{'余量':>12}  判定")
print("-" * 78)
nbad = []
for name, key, lo, hi in BANDS:
    v = d.get(key)
    if v is None:
        print(f"{name:<18}{'—':>10}{'—':>10}{'—':>10}{'—':>12}  ? 未解析")
        continue
    marg = []
    if lo is not None: marg.append(v - lo)
    if hi is not None: marg.append(hi - v)
    m = min(marg)
    ok = all(x >= 0 for x in marg)
    if not ok: nbad.append(name)
    print(f"{name:<18}{v:>10.4f}{(lo if lo is not None else float('nan')):>10.2f}"
          f"{(hi if hi is not None else float('nan')):>10.2f}{m:>+12.4f}  {'✅' if ok else '❌ 破带'}")
print("-" * 78)
print(f"破带 {len(nbad)} 条：{', '.join(nbad) if nbad else '（无）'}")
