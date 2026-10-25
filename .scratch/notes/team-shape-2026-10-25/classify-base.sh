#!/bin/bash
export PATH=$HOME/.cargo/bin:$PATH
cd /mnt/d/pitchcraft-exp1/engine || exit 1
for f in p5_ball_side_shift p31_liveness_stages_reachable_and_pulls_back p32_interception_self_consistency p30_foul_cooldown_decays_every_tick; do
  echo "=== $f (A-layer base 0fe2989) ==="
  cargo test --lib --release "$f" 2>&1 | grep -E "test tests::|test result:" | tail -3
done
