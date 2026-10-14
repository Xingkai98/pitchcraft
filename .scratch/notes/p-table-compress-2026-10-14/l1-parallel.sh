#!/bin/bash
# 并行跑 L1 逐带探针：每个点一份独立 engine 拷贝（零依赖，构建快）。
# 用法: l1-parallel.sh <tag>:<variant A|C>:<c> ...
set -u
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/table-axis; N=$ROOT/.scratch/notes/p-table-compress-2026-10-14
for spec in "$@"; do
  IFS=: read -r tag var c <<<"$spec"
  d=/tmp/l1-$tag
  rm -rf $d; mkdir -p $d
  cp -r $ROOT/engine $d/engine
  rm -rf $d/engine/target
  cp $N/axis-$var.lib.rs $d/engine/src/lib.rs
  sed -i "s/^const TABLE_COMPRESS_C: f64 = .*/const TABLE_COMPRESS_C: f64 = $c;/" $d/engine/src/lib.rs
  cat $N/band-probe.rs.txt >> $d/engine/tests/realism.rs
  libsha=$(sha256sum $d/engine/src/lib.rs | cut -c1-16)
  echo "$tag (变体$var c=$c) lib=$libsha" > $N/logs/L1-$tag.txt
  ( cd $d/engine && cargo test --test realism --release -- --ignored --nocapture > $N/logs/L1-raw-$tag.txt 2>&1 ) &
done
wait
for spec in "$@"; do IFS=: read -r tag var c <<<"$spec"; echo "done $tag"; done
