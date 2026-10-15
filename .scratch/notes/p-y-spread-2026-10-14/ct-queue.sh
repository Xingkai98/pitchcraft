#!/bin/bash
N=/tmp/y-axis/.scratch/notes/p-y-spread-2026-10-14
export PATH="$HOME/.cargo/bin:$PATH"
# 等 L1 队列结束
while ! grep -q "L1-ALL-DONE" $N/logs/sweep.log 2>/dev/null; do sleep 20; done
for spec in "base 1.3" "p085 0.85" "p060 0.6"; do
  set -- $spec; tag=$1; val=$2
  d=/tmp/ct-$tag; rm -rf $d; mkdir -p $d
  cp -r /tmp/y-axis/engine $d/engine; rm -rf $d/engine/target
  ( git show HEAD:engine/src/lib.rs ) > $d/engine/src/lib.rs
  if [ "$val" != "1.3" ]; then
    sed -i "s/^const FORM_SPREAD_Y: f64 = 1.3;/const FORM_SPREAD_Y: f64 = $val;/" $d/engine/src/lib.rs
    grep -q "FORM_SPREAD_Y: f64 = $val;" $d/engine/src/lib.rs || { echo "FATAL $tag"; continue; }
  fi
  ln -sfn /tmp/y-axis/openspec $d/openspec
  sha256sum $d/engine/src/lib.rs | cut -c1-16 > $N/logs/ct-$tag.lib16.txt
  ( cd $d/engine && cargo test --release --no-fail-fast > $N/logs/cargo-$tag.txt 2>&1 )
  echo "cargo-$tag done"
done
echo CT-ALL-DONE >> $N/logs/sweep.log
