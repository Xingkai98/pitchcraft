#!/bin/bash
set -u
export PATH="$HOME/.cargo/bin:$PATH"
ROOT=/tmp/table-axis; N=$ROOT/.scratch/notes/p-table-compress-2026-10-14
for spec in "$@"; do
  IFS=: read -r tag var c <<<"$spec"
  d=/tmp/ct-$tag; rm -rf $d; mkdir -p $d; cp -r $ROOT/engine $d/engine; rm -rf $d/engine/target
  cp $N/axis-$var.lib.rs $d/engine/src/lib.rs
  ln -sfn $ROOT/openspec $d/openspec
  sed -i "s/^const TABLE_COMPRESS_C: f64 = .*/const TABLE_COMPRESS_C: f64 = $c;/" $d/engine/src/lib.rs
  ( cd $d/engine && cargo test --release --no-fail-fast > $N/logs/cargo-$tag.txt 2>&1 ) &
done
wait
