# Independent verification — continuous role-lane candidate R13 (experimental worktree)

- Worktree: `D:\pitchcraft-exp4` (detached HEAD, linked worktree of the main checkout)
- Date: 2026-10-25, 14:50–15:00 (+08:00)
- Candidate under test: A-layer team block law + continuous B4 role-lane layer (continuous ball-position
  ratio instead of 3×3 quantisation) + `EXP1_LATERAL_TRACK=0.70`, `B_LANE_STEP_M=6.5`,
  `EXP1_BALL_SMOOTH_ALPHA=1.0`, `BASE_DEF_TACKLE=−1.47`, in-box arc saved 23.
  Declared: formation criteria 8/8 (lateral sd 7.501, swarm 0.769), L1 9/9, p53 11/11,
  H/A ≈1.37 (120-seed estimate; 600 pending), wasm sha256 `6d250b1b…2f96a`.
- Scope note: neutral wording; no external product names, no references to external workspaces.
- Raw outputs: `verify4/*.txt`, `verify4/*.json`, `verify4/*.png`.

---

## 0. Provenance / tree state

| Item | Value |
|---|---|
| Commit under test | `1a53bb9d251d05ee5f9ee52e449252b9a740ca09` — `exp: continuous role-lane target layer` (detached HEAD) |
| Parent | `0fe2989` |
| Diff vs parent | `git diff --stat 0fe2989..HEAD` → `engine/src/lib.rs | 304 +…` (1 file, 297 insertions, 7 deletions); no other tracked file changed |
| Tree | clean; tracked `.scratch/` content untouched (nothing deleted); only `verify4/` added to the worktree-local exclude list, plus an ignored helper directory |
| Host / toolchain | Windows + PowerShell 5.1; Node `v24.22.1`; Ubuntu 24.04.4 WSL, `cargo/rustc 1.99.1`, target `wasm32-unknown-unknown` |

---

## 1. wasm rebuild

**Command**: `verify4/run-bg.sh` stage 1 (standard WSL build + copy).
**Result**: `build_exit=0` (`Finished release profile … in 4.4 s`).

| Artifact | Size (B) | sha256 | Time |
|---|---:|---|---|
| `viewer/engine.wasm` (rebuilt) | 285,124 | `6d250b1bf98a386b7b718160c5588aac581dcb37319a1d9359d68a53dfe2f96a` | 14:51:46 |
| `engine/src/lib.rs` | — | `3851a2b0287df383add1b6729c7c7a381c6a2e04c7f98685e571a85968349e39` | — |

✅ Rebuild reproduces the provided pre-rebuild hash exactly. Log: `verify4/build.txt`.

---

## 2. Formation criteria (P38)

**Command**: `node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs`
**Result**: exit 0 (report period); **8/8 pass** — every declared value reproduced exactly.

| Criterion | Reading | Target | Verdict |
|---|---:|---|---|
| depth (home) | 24.072 | [23.385, 28.385] | ✅ |
| compactness | 15.218 | [13.41, 17.01] | ✅ |
| centroid gap | 7.184 | [6.54, 10.14] | ✅ |
| **lateral displacement sd** | **7.501** | [7.015, 14.015] | ✅ (margin +0.486) |
| pairwise y-correlation (swarm) | 0.769 | [0.451, 0.891] | ✅ |
| line fault | 3.475 | [2.45, 7.45] | ✅ |
| line balance | 1.086 | [0.84, 1.28] | ✅ |
| regular shots/match | 12.800 | ≥ 5.5 | ✅ |

Evaluator JSON: `hd 24.072 / spread 15.218 / gap 7.184 / width 42.550 / latSd 7.501 / lonSd 15.532 /
swarm 0.769 / straight 0.131 / fault 3.475 / midBack 1.086 / shotsReg 12.800`; 10 seeds, 6 windows,
`crashedSeeds=0`. (These are the same values the motion-layer report calls its “kinematics disabled,
smoothed reference off” baseline row — consistent, since that configuration is this same code.)

---

## 3. Like-football loss table

**Command**: `node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12`
**Result**: exit 0; **distance 0.186** (8/8 rows; 9-row reporting caliber 0.184). Not part of the owner's
declared reading set; measured here for comparison.

| Metric | R13 | exp1 state (0fe2989) | R11 (lane tiers) | Motion candidate | Pre-change baseline | Real anchor |
|---|---:|---:|---:|---:|---:|---:|
| depth (home) | 24.00 | 23.73 | 23.59 | 24.48 | 38.70 | 18.31 |
| depth (away) | 23.52 | 22.94 | 23.85 | 24.27 | 36.39 | 18.45 |
| compactness | 15.22 | 15.49 | 15.01 | 15.30 | 20.73 | 12.76 |
| centroid gap★ | 7.16 | 7.16 | 7.22 | 7.37 | 18.88 | 5.24 |
| ball distance | 12.33 | 14.52 | 12.07 | 13.02 | 18.62 | 14.97 |
| displacement/window★ | 12.20 | 8.95 | 11.56 | 11.26 | 6.27 | 13.46 |
| **lateral share★** | **0.35** | 0.25 | 0.38 | 0.38 | 0.37 | 0.43 |
| mixed-team degree★ | 0.80 | 0.80 | 0.80 | 0.75 | 0.80 | 0.80 |
| width (report row) | 42.61 | 41.12 | 43.28 | 42.76 | 49.62 | 35.96 |

Flags: direction consistency 0.91 vs real 0.70 (**flagged as deviating**); displacement ratio 0.91.
Distance 0.186 is better than the exp1 state (0.252) and level with the tiered-lane candidate; lateral
share 0.35 is below the two previous candidates (0.38) and further from the real anchor (0.43).
Log: `verify4/like-football.txt`.

---

## 4. L1 statistical suite

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp4/engine && cargo test --test realism --release -- --ignored --nocapture'
```
**Result**: exit 0; **9 passed / 0 failed / 4 filtered out**, 140.19 s — declared 9/9 ✅.

Key readings (200 frozen seeds, 90-min matches unless noted):
- Fouls 25.77/match (yellow 3.19 / red 0.09), free kicks 25.76; corners 4.12/match, single-match peak 11 (<15).
- L3 aggregate: shots 3,136 (regular 2,854, headers 282), goals 364, saved 802, in-box goals 299,
  in-box share (rectangle caliber) 0.8214, on-target 0.3718, conversion 0.1161.
- Side-effect line: goals **home 1.05 / away 0.77 per match (H/A 1.364)**, pass events 962.3,
  shots 14.27 (+headers 1.41), tackles 27.91 (success 15.21), corners 4.12, throw-ins 19.76,
  goal kicks 27.30, fouls 25.77.
- Frozen-window 600 matches: home **1.020/match**, away **0.812/match**, total **1.832**, H/A **1.257**
  (95% CI [1.116, 1.416]); conversion home 0.13088 (612/4676) vs away 0.10386 (487/4689).
- 5-minute cohort: shots 0.76, restarts 2.76, fouls 1.83, goals 0.09.

**H/A note**: the declared “≈1.37 (120-seed estimate)” is **not confirmed at 600 seeds** — the frozen-window
estimate is 1.257 (CI [1.116, 1.416]); the independent event probe below gives 1.256 (agreement). Total goals
per match are 1.83, the lowest of all candidate states examined (baseline ≈2.77, real ≈2.75). Log:
`verify4/l1-realism-nocapture.txt`.

---

## 5. p53 and focused regression filters (p5 / p31 / p32)

**Commands**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc '… cargo test --lib --release p53'
wsl.exe -d Ubuntu-24.04 -- bash -lc '… cargo test --lib --release p5'
wsl.exe -d Ubuntu-24.04 -- bash -lc '… cargo test --lib --release p31'
wsl.exe -d Ubuntu-24.04 -- bash -lc '… cargo test --lib --release p32'
```

| Class | Result | Details |
|---|---|---|
| p53 | **11 passed / 0 failed** ✅ | declared 11/11 confirmed (incl. `p53_same_team_spacing_ge_2m`) |
| p5 | **15 passed / 1 failed** ❌ | `tests::p5_ball_side_shift` — “ball on the right half ⇒ id 5 should shift right” (`left=0.518 right=0.518`; no measurable side shift). Same failure text as the motion-layer candidate. |
| p31 | **19 passed / 1 failed** ❌ | `tests::p31_liveness_stages_reachable_and_pulls_back` — stall limit **17** far beyond 3 s (bound 7); the liveness stage did not pull the match back. (The motion candidate failed a different p31 test — `p31_meaningful_action_resets_counter` — so the p31 invariant class remains red, the concrete red test changed.) |
| p32 | **1 passed / 1 failed** ❌ | `tests::p32_interception_self_consistency` — far-distance (>12 m) interceptions **75** outside expected 95% interval [41.7, 70.4] (expected 56.07, n=1309). Same invariant class as the motion candidate. |

**L2 cross-event invariant (goalkeeper position)**: checked in the non-ignored realism target
(`verify4/realism-default.txt`): realistic failures are only `gm_canary_seeds` (golden re-baseline) and
`l2_sent_off_kickoff_seeds` (directed red-card seed lost) — **`l2_cross_event_invariants` passes**, so the
goalkeeper-position invariant that the motion candidate broke is **not** broken here.
Logs: `verify4/p53.txt`, `verify4/p5.txt`, `verify4/p31.txt`, `verify4/p32.txt`, `verify4/realism-default.txt`.

---

## 6. P18 behavior gates

**Commands**
```powershell
# canary artifact (clean tree; commit hash passed as literal — see environment note)
wsl.exe -d Ubuntu-24.04 -- bash -lc '… P18_SOURCE_COMMIT=1a53bb9d251d05ee5f9ee52e449252b9a740ca09 cargo test --test p18_behavior_gates --release -- --ignored --nocapture'
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs
```
**Result**: artifacts OK (`p18_canary` 30 matches + `p18_baseline` 300 matches; 2 passed / 0 failed, 20.08 s;
canary sha256 `5574b4223b26872abca2365de7f8c8ec790c79df204ce23278d01f7ef32c01d5`; provenance
`source_commit=1a53bb9…`, `engine_source_fingerprint=fnv1a64:ad58b139491ae5ef`). Judge tool exit 0
(report period); overall not passing.

| Key | Name | R13 | Real ref | Ratio | Verdict | Pre-change baseline | Motion candidate |
|---|---|---:|---:|---:|---|---:|---:|
| A1 | chain wall-clock duration (s) | 27.9271 | 10.1814 | **2.74×** | fail (>1.5×) | 29.4866 / 2.90× | 27.3505 / 2.69× |
| A2 | in-chain action gap (s) | 5.0315 | 3.2010 | **1.57×** | fail (>1.5×) | 5.8440 / 1.83× | 5.1789 / 1.62× |
| B4 | possession-time pressed-share | 0.8780 | 0.5609 | 1.57× | pass (≥0.5×) | 0.6458 / 1.15× | 0.9615 / 1.71× |
| A3 | in-chain action count (guardrail) | 5.5628 | 3.1081 | 1.79× | guardrail; floor 4.4502 | 5.1045 | 5.3415 |
| C1 | chains ending in a shot (guardrail) | 0.0850 | 0.0749 | 1.13× | guardrail; floor 0.0680 | 0.1412 | 0.1039 |
| C1 companion | shot-ending chains per match | 14.7333 | 22.75 | 0.65× | comparable column | 23.40 / 1.03× | 16.7333 / 0.74× |

**Versus the pre-change baseline**: A1 better (2.74× vs 2.90×) but still fails; A2 better (1.57× vs 1.83×)
but still fails; **B4 worse** (1.57× vs 1.15× — pressing coverage now 57% above the real reference, further
from the real anchor; the gate passes only because its check is one-sided). Logs:
`verify4/p18-canary-gen.txt`, `verify4/p18-behavior-gates.txt`.
Environment note (not bypassed): the linked worktree `.git` file stores a Windows-style path, so WSL git
cannot resolve it; the full commit hash was resolved on the host and passed literally (tree verified clean).

---

## 7. Ratchet comparison (22 metrics)

**Command**
```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp4/.scratch/tracking-data/winpath-hook.mjs'
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify4/ratchet-before.json
```
Baseline = unchanged pre-change snapshot (sha256 `7738d4e2…`; provenance `commit=1c5729d, wasm=bc2f2b2b,
lib=eb675c14, realGames=2`).

**Result: exit code 1 — 4 regressions.**

| Metric | Before | After | Verdict |
|---|---:|---:|---|
| lf.disp | 6.270 | 12.200 | ✓ improved |
| **lf.lat** | 0.370 | **0.350** | ✗ regressed (real 0.43; both earlier candidates reached 0.38) — genuine |
| lf.mix | 0.800 | 0.800 | · same |
| lf.hd / lf.ad / lf.spread / lf.gap / lf.ballDist | 38.70/36.39/20.73/18.88/18.62 | 24.00/23.52/15.22/7.16/12.33 | ✓ improved |
| lf.distance | 0.542 | 0.186 | ✓ improved |
| p38.hd / p38.spread / p38.gap | 38.736/20.722/18.905 | 24.072/15.218/7.184 | ✓ improved (in band) |
| p38.latSd | 3.219 | 7.501 | ✓ improved (now in band) |
| **p38.swarm** | 0.678 | 0.769 | ✗ rule flag: still inside band [0.451, 0.891] but farther from band center (and closer to upper bound) |
| p38.fault | 12.220 | 3.475 | ✓ improved (in band) |
| p38.balance | 0.984 | 1.086 | · same (in band) |
| **p38.shotsReg** | 23.400 | 12.800 | ✗ rule flag (direction "higher"): still passes the criterion floor (≥5.5) but is the lowest shot volume among candidates and below the real anchor (16.51) |
| p18.a1 | 29.487 | 27.927 | ✓ improved |
| p18.a2 | 5.844 | 5.032 | ✓ improved |
| **p18.b4** | 0.646 | 0.878 | ✗ regressed: one-sided proxy direction (lower = closer to real 0.561); value moved away from the real anchor |
| p18.a3 | 5.104 | 5.563 | · report only |
| p18.c1 | 0.141 | 0.085 | · report only |

Summary: 17 improved, 1 unchanged, 4 rule/real regressions; genuine issues are `lf.lat` (0.35, the weakest
lateral-share reading among candidates) and the continued B4 movement away from the real reference.
Log: `verify4/ratchet-diff.txt`.

---

## 8. Home/away event probe (independent read-only probe)

**Command**
```powershell
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs D:\pitchcraft-exp4\viewer\engine.wasm 401 600
```
**Result**: exit 0 (600 matches, seeds 401..1000). Log: `verify4/ha-probe.txt`.

| Event | Home | Away | H/A | Per match (home/away) |
|---|---:|---:|---:|---|
| shot | 4,688 | 4,709 | 0.996 | 7.81 / 7.85 |
| **goal** | **613** | **488** | **1.256** | **1.02 / 0.81** |
| tackle | 7,951 | 9,106 | 0.873 | 13.25 / 15.18 |
| foul | 8,145 | 7,184 | 1.134 | 13.57 / 11.97 |
| pass | 297,999 | 281,539 | 1.058 | 496.67 / 469.23 |
| corner | 1,401 | 1,095 | 1.279 | 2.33 / 1.82 |
| throw-in | 6,880 | 5,237 | 1.314 | 11.47 / 8.73 |
| free kick | 7,183 | 8,145 | 0.882 | 11.97 / 13.57 |

Interpretation: probe H/A = 1.256, matching the frozen-window L1 value (1.257) and **below** the owner's
120-seed estimate ≈1.37. Pre-change baseline H/A ≈1.10 and real reference ≈1.25 — so H/A is now essentially
at the real reference; total goals ≈1.83/match vs baseline ≈2.77 / real ≈2.75 (−34%), the lowest volume
among the candidates examined.

---

## 9. Trajectory image (120 s window, t ∈ [1800, 1920] s)

**Command**
```powershell
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify4\traj-cont-engine.png continuous-lane 120
```
**Result**: exit 0; 900×620 PNG `verify4/traj-cont-engine.png`
(sha256 `d5348d360f280c8275696ed5732909d0511dc15330558f32f10a2b0e80257432`).

| Series | Lateral sd | Longitudinal sd |
|---|---:|---:|
| R13 (continuous lane layer) | **6.61 m** | **17.51 m** |
| exp1 state (independently verified earlier) | 4.95 m | 15.92 m |
| Real-frame reference | 10.04 m | 14.35 m |

Lateral movement improves versus the exp1 state (+34%) but remains below the real reference (10.04 m) and
below the two later candidates (8.08–8.30 m); longitudinal movement rises to 17.51 m (above real 14.35 m).
The numbers coincide with the motion-layer report's “kinematics disabled” baseline row (same code),
which is a consistency check across worktrees.

---

## 10. Default test suite (`cargo test --release --no-fail-fast`)

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp4/engine && cargo test --release --no-fail-fast'
```
**Result**: **FAILED** — `327 passed / 23 failed / 21 ignored`; **6 targets failed**: `--lib`,
`p124_intent_observations`, `p15_behavior_observation`, `p16_spatial_features`, `p17b_diagnosis_report`,
`realism`. Passing targets: `p17a_behavior_chain_baseline` (24/0/2), `p18_behavior_gates` (6/0/2),
doc-tests (0). (Previous candidate: 330 pass / 20 fail.)

Classification (reference = the motion candidate's default-suite run on the same base heritage; the base
commit itself was not run, so the inherited/new boundary is advisory):

**(a) Inherited from the base heritage (18 of 23):** lib `observation::tests::*` ×2,
lib `p15_recorder_stays_out_of_the_decision_path` (source-text meta-guard brittleness — not a behavioral
failure), lib `p5_ball_side_shift`, lib `p32_interception_self_consistency`; p124
`counter_proof_confirms_the_probe_is_intact`, `gate_rerun_and_p16_baseline_side_by_side`,
`intent_features_cannot_reach_positions`; p15 ×4 (`gap_is_a_classified_outcome_not_a_failure`,
`every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`,
`event_indexes_are_non_empty_monotonic_and_in_range`,
`recorder_on_and_off_reproduce_the_golden_canary_stream`); p16 ×2
(`rust_shape_is_in_the_same_regime_as_the_js_ruler`,
`phaseability_verdict_is_partial_and_the_evidence_is_duration_controlled`); p17b ×2
(`instant_contest_covers_only_the_episode_closing_share_of_a2`,
`loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber`); realism
`gm_canary_seeds`, `l2_sent_off_kickoff_seeds`.

**(b) New / non-expected for R13 (5 of 23):**
| Target | Test | Evidence |
|---|---|---|
| lib | `tests::p30_foul_cooldown_decays_every_tick` | foul cooldown after the 10th tick should decay to 0 but reads 11 — cooldown not decremented per tick (new relative to the motion candidate's run; possibly base-inherited from the A-layer, but not observed there) |
| lib | `tests::p31_liveness_stages_reachable_and_pulls_back` | stall limit 17 far beyond 3 s (bound 7); the liveness stage did not pull the match back (the motion candidate failed a different p31 test, so the p31 invariant class was already red there) |
| p124 | `defensive_intents_are_sparse_and_well_formed` | defensive intents 1381 vs per-tick 5399 — should be sparse events; near per-tick means the channel is misregistered |
| p124 | `purification_records_the_v4_verdict_pending_review` | purification (zero-length) AUC reading outside expected band |
| p124 | `window_features_are_mechanically_tied_to_shots` | window-feature vs shot-attribution distribution check failed |

**(c) Fixed relative to the motion candidate:** `realism::l2_cross_event_invariants` (goalkeeper position
invariant) **now passes**; `p31_meaningful_action_resets_counter` also passes now (replaced by the different
p31 red above).

Caveat: the base commit `0fe2989` was not run with the default suite, so per-test "inherited vs new"
attribution is relative to the previous candidate's run, not a verified base result. The baseline-fingerprint
checks are Node-side tests and outside this Cargo step; Windows line-ending sensitivity affects those Node
hash sentinels, not these Cargo tests.
Log: `verify4/default-suite-all.txt`; focused-target log: `verify4/realism-default.txt`.

---

## 11. Hard-invariant verdict (requested summary)

- Own declared gates: **all reproduced** (formation criteria 8/8 exact values; L1 9/9; p53 11/11; wasm hash).
- **The four tracked regression items from the motion candidate:**
  - p5 `p5_ball_side_shift`: **still red** (15/16) — same failure signature (`left=right=0.518`).
  - p31 liveness guard: **still red** (19/20) — different test, same invariant class (stall 17 ≫ 7).
  - p32 `p32_interception_self_consistency`: **still red** (1/2) — far-distance interceptions outside interval.
  - l2 `l2_cross_event_invariants` (goalkeeper position): **now green** ✅.
- **Additionally new** in the full default suite versus the previous candidate: `p30_foul_cooldown_decays_every_tick`
  and three p124 probe/fixture guards.
- **Conclusion for delivery as “does not break existing gates”: not supported.** Three of the four previously
  identified hard-invariant regressions persist (p5/p31/p32) and one new lib assertion appeared; only the
  goalkeeper-position invariant was recovered. The owner's declared gate set (formation criteria / L1 / p53)
  does pass, but it does not include any of these red invariants.
- Declared H/A is not confirmed at 600 seeds (1.257 measured vs ≈1.37 estimate); total goals 1.83/match is
  the lowest among examined candidates.

---

## 12. Limits

1. Default suite was not run on the base commit `0fe2989`, so the inherited/new boundary in §10 is advisory.
2. Node-side tools test suite (including baseline-fingerprint sentinels) was not run; this task's step list
   covers Cargo targets only.
3. Formation margins: lateral sd 7.501 (+0.486) and swarm 0.769 are both comfortable but the shot volume
   12.8 is the lowest among candidates and far below the real anchor.
4. Comparison baselines: the “motion candidate” numbers come from an independent verification run in a
   different worktree with the same base heritage; they are not a strict base-commit control.
5. The expansion of the default-suite red set (§10b) needs a base-commit run before concluding which layer
   (A-layer block law, continuous lane layer, or event constant changes) causes each item.

---

## 13. Artifact hashes (`verify4/`)

| File | Size (B) | sha256 |
|---|---:|---|
| `build.txt` | 4,374 | `3a5df379dbc5f3ef7fb32f6860e3ff1ce4581133b612d0fb29ef246ba4d83988` |
| `p38-criteria.txt` | 1,242 | `e7f75b0aab94f503c43b0556deec0972647047b99e0c779cf126499329c31c16` |
| `p38-eval-current.json` | 438 | `78cf9987b05a6f084972b435e10b051309795196db4be77f9e5310bde0259046` |
| `like-football.txt` | 2,692 | `36e6717b2408e5426109a33445d50b20b3c69890aa9f950a173eb93ea9d9b7ba` |
| `traj-engine.txt` | 1,024 | `477a478ec3513d955a7716830835aab18ca66e86f2997bfb16fed4aff516a220` |
| `traj-cont-engine.png` | 42,784 | `d5348d360f280c8275696ed5732909d0511dc15330558f32f10a2b0e80257432` |
| `traj-exp1-baseline.png` | 35,510 | `c123e7b7b6832c43b3f3e61469ebd68e6115a0ee3081e2bf3958f8c7055bcdf9` |
| `traj-real-game1.png` | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` |
| `p18-canary-gen.txt` | 3,499 | `4123cd6d2e35caf8d32876c87f09e5d461dfce5286ceda02ea3bb13ebbac4488` |
| `p18-behavior-gates.txt` | 2,262 | `f2080e25933840d5e6c47856e1bd763ec98e4d5b242ba2a24075df2e4eba893e` |
| `ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` |
| `ratchet-diff.txt` | 2,908 | `244bf7f7efd2aa478e482e3176a587662227fa380563c1754007421df4eec665` |
| `l1-realism-nocapture.txt` | 4,279 | `9c3b024cb40bb12609db40c972ba5595ff801acbc73f693d66f9978e51392d3b` |
| `ha-probe.txt` | 1,592 | `daebd9f1b147e4fb169e8ae3ab00dfcb8f310014997431c75ad7c093a184dd0a` |
| `p53.txt` | 4,424 | `d43e16598dffa540310f529252a2a6760bbca64a3bc24171d269abca49008b88` |
| `p5.txt` | 4,934 | `da81a04750b80a78f48ef8f6219a7de49d587d41aa691f8ac86986402676ad0e` |
| `p31.txt` | 5,256 | `83fea9dc246109ce110d49df0f6ef732d2fded9efd7f73b66a85bee63d377a7d` |
| `p32.txt` | 4,388 | `cf9db6a5333670a5ec22e49bdef8f2df21b45fcacb5acc6f52880ab37139f49d` |
| `realism-default.txt` | 4,089 | `8087135b3d5049e8585c4fa4798830f056bf1cd00b69189264998f3936b04883` |
| `default-suite-all.txt` | 44,749 | `f77af5b9bed526f2f08fc7576c19a77dfc697f14c75e4884cf7fec5c4bf18847` |
| `run-bg.sh` | 2,594 | `c9ca73bcf2f7d811b40e08718baf0010ee6b8f3d19cb97dbf8581f11896ad32d` |

Provenance anchors: commit `1a53bb9d251d05ee5f9ee52e449252b9a740ca09`, `engine/src/lib.rs` `3851a2b0…`,
`viewer/engine.wasm` `6d250b1b…`, canary `5574b422…` (source_commit `1a53bb9…`).
Tree clean after the run; tracked `.scratch/` content untouched.

---

## 14. Reproduction

```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp4/.scratch/tracking-data/winpath-hook.mjs'
cd D:\pitchcraft-exp4
# build + P18 canary + L1 + focused filters + realism default + full default suite: verify4/run-bg.sh
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify4\traj-cont-engine.png continuous-lane 120
node .scratch/tracking-data/run-main.mjs tools\ratchet.mjs diff verify4\ratchet-before.json
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs viewer\engine.wasm 401 600
```
Environment helpers (ignored, not committed): `.scratch/tracking-data/run-main.mjs`,
`.scratch/tracking-data/winpath-*.mjs` (Windows-only shims).
