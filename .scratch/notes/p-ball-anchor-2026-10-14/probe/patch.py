#!/usr/bin/env python3
"""打点：把 FORM_BALL_ANCHOR（+ 面板 A 的 y 缩放）写进一份 lib.rs 拷贝。
用法: patch.py <lib.rs> <anchor> [block_scale_y]
只改这两行常量；**不动任何其它东西**（门禁/阈值/其它常量一律不动）。
"""
import hashlib
import pathlib
import sys

lib = pathlib.Path(sys.argv[1])
anchor = float(sys.argv[2])
yscale = sys.argv[3] if len(sys.argv) > 3 else None
src = lib.read_text()


def sub1(old, new):
    global src
    assert src.count(old) == 1, f"锚点不唯一/缺失: {old!r} (count={src.count(old)})"
    src = src.replace(old, new)


sub1("const FORM_BALL_ANCHOR: f64 = 0.0;", f"const FORM_BALL_ANCHOR: f64 = {anchor!r};")
if yscale is not None:
    sub1("const FORM_BALL_BLOCK_SCALE_Y: f64 = 0.472;",
         f"const FORM_BALL_BLOCK_SCALE_Y: f64 = {float(yscale)!r};")

lib.write_text(src)
print("patched anchor=", anchor, "yscale=", yscale, "sha16=",
      hashlib.sha256(src.encode()).hexdigest()[:16])
