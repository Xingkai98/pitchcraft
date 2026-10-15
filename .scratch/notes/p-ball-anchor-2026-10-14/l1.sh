#!/usr/bin/env bash
# L1 真实性统计套件（realism --ignored）。用法: l1.sh <tag> [anchor] [yscale]
# 每点独立 engine 拷贝（互不干扰）；打点只在拷贝上做，不碰主树工作文件。
set -u
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/ball-anchor; N=$ROOT/.scratch/notes/p-ball-anchor-2026-10-14
tag=$1; anchor=$2; yscale=${3:-}
d=/tmp/l1ba-$tag
rm -rf $d; mkdir -p $d
cp -r $ROOT/engine $d/engine
rm -rf $d/engine/target
# 一律从**主树 HEAD+机制**的工作文件打点——但绝不拷贝可能正被 sweep 打点的文件：
# 主树 lib.rs 是「机制 + ANCHOR=0」的源，patch.py 只改两个常量行。
cp $ROOT/engine/src/lib.rs $d/engine/src/lib.rs
ln -sfn $ROOT/openspec $d/openspec
if [ -n "${anchor:-}" ]; then
  python3 $N/probe/patch.py $d/engine/src/lib.rs "$anchor" $yscale > $N/logs/l1-fp-$tag.txt 2>&1 \
    || { echo "PATCH-FAIL $tag"; exit 1; }
fi
sha256sum $d/engine/src/lib.rs | cut -c1-16 > $N/logs/L1-$tag.lib16.txt
( cd $d/engine && cargo test --test realism --release -- --ignored --nocapture > $N/logs/L1-$tag.txt 2>&1 )
echo "L1-$tag exit=$?" | tee -a $N/logs/L1-status.txt
