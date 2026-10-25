# Independent verification — R11 candidate (experimental worktree)

- Worktree: `D:\pitchcraft-exp3` (detached HEAD, linked worktree of the main checkout)
- Date: 2026-10-25, 13:48–13:58 (+08:00)
- Candidate under test: A-layer team block law + B4 role lane offsets + lateral-track `0.70` + two event
  constants (`BASE_DEF_TACKLE=−1.47`, in-box arc saved `23`). Declared readings: formation criteria 8/8,
  L1 9/9, like-football distance 0.186, trajectory lateral sd 8.08 m, wasm sha256 `474a303F…26018`.
- Scope note: neutral wording; no external product names, no references to external workspaces.
- Raw command outputs: `verify2/*.txt`, `verify2/*.json`, `verify2/*.png`.

---

## 0. Provenance state

| Item | Value |
|---|---|
| Starting HEAD (before verification) | `0fe298944b0a349bba02f618677d3f81e160c055` (previous experiment commit) |
| Projected commit | `2a14601d506830c654f31052815e236b8ba80d66` — `exp: off-ball target adjustment layer` (detached HEAD) |
| Parent | `0fe2989` |
| Commit diffstat | `2 files changed, 495 insertions(+), 5 deletions(-)` — `engine/src/lib.rs` (249+/5−), new `B-LAYER-REPORT.md` |
| Tree after commit | `git status --porcelain` empty (clean); experiment scratch `.scratch/exp3/` and the `verify2/` output directory are excluded worktree-locally (`.git/info/exclude`, not tracked) |
| Host | Windows + PowerShell 5.1; Node `v24.22.1` (`D:\Software\node-v24.22.1-win-x64\node.exe`) |
| Toolchain | Ubuntu 24.04.4 WSL, `cargo 1.99.1`, `rustc 1.99.1`, target `wasm32-unknown-unknown` |

---

## 1. wasm rebuild

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/d/pitchcraft-exp3/verify2/run-bg.sh   # first stage = build + copy
```
**Result**: `build_exit=0` (`Finished release profile … in 4.07s`), wasm copied to `viewer/engine.wasm`.

| Artifact | Size (B) | sha256 | Time |
|---|---:|---|---|
| `viewer/engine.wasm` | 283,852 | `474a303fea6ad8f136e0c484538b68ce51153e53a7ee67f0869cb34c17826018` | 13:49:07 |
| `engine/src/lib.rs` | — | `d44461db0d8bf9c82cc5828137a4775cece90a0167887336ed363ad7bbc93cdb` | — |

✅ Rebuild reproduces the declared wasm hash exactly. Log: `verify2/build.txt`.

---

## 2. Formation criteria (P38)

**Command**
```powershell
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
```
**Result**: exit 0 (report period); **8/8 pass** — matches the declared reading.

| Criterion | Reading | Target | Verdict |
|---|---:|---|---|
| depth (home) | 23.578 | [23.385, 28.385] | ✅ |
| compactness | 15.024 | [13.41, 17.01] | ✅ |
| centroid gap | 7.200 | [6.54, 10.14] | ✅ |
| **lateral displacement sd** | **7.272** | [7.015, 14.015] | ✅ (margin only +0.257 above lower bound) |
| pairwise y-correlation (swarm) | 0.694 | [0.451, 0.891] | ✅ |
| line fault | 3.420 | [2.45, 7.45] | ✅ |
| line balance | 1.086 | [0.84, 1.28] | ✅ |
| regular shots/match | 13.800 | ≥ 5.5 | ✅ |

Evaluator JSON: `hd 23.578 / spread 15.024 / gap 7.200 / width 43.399 / latSd 7.272 / lonSd 16.308 /
swarm 0.694 / straight 0.107 / fault 3.420 / midBack 1.086 / shotsReg 13.800`, 10 seeds, 6 windows,
`crashedSeeds=0` (`verify2/p38-eval-current.json`).
Comparison: previous experiment state (0fe2989) = 7/8 (latSd 3.886 red); pre-change baseline = 5/8.

---

## 3. Like-football loss table

**Command**
```powershell
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
```
**Result**: exit 0; **distance 0.186** (8/8 rows; the 9-row reporting caliber is also 0.186). Declared 0.186 ✅.

| Metric | R11 | exp1 state (0fe2989) | Pre-change baseline | Real anchor |
|---|---:|---:|---:|---:|
| depth (home) | 23.59 | 23.73 | 38.70 | 18.31 |
| depth (away) | 23.85 | 22.94 | 36.39 | 18.45 |
| compactness | 15.01 | 15.49 | 20.73 | 12.76 |
| centroid gap★ | 7.22 | 7.16 | 18.88 | 5.24 |
| ball distance | 12.07 | 14.52 | 18.62 | 14.97 |
| displacement/window★ | 11.56 | 8.95 | 6.27 | 13.46 |
| **lateral share★** | **0.38** | 0.25 | 0.37 | 0.43 |
| mixed-team degree★ | 0.80 | 0.80 | 0.80 | 0.80 |
| width (report row) | 43.28 | 41.12 | 49.62 | 35.96 |

Flags: direction consistency 0.88 vs real 0.70 (**still flagged as deviating**; exp1 was 0.94, pre-change
0.79); displacement ratio 0.86. Log: `verify2/like-football.txt`.

---

## 4. Trajectory image (120 s window, t ∈ [1800, 1920] s)

**Command**
```powershell
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify2\traj-r11-engine.png R11 120
```
**Result**: exit 0; 900×620 PNG `verify2/traj-r11-engine.png`
(sha256 `f8a42dbee9e01d476cade6ada53cf9bf5db46d7b05cb51e9ffec55354529b5d5`).

| Series | Lateral sd | Longitudinal sd |
|---|---:|---:|
| R11 (this build) | **8.08 m** | 13.80 m |
| exp1 state (0fe2989) | 4.95 m | 15.92 m |
| Pre-change baseline | 2.96 m | 7.65 m |
| Real-frames reference | 10.04 m | 14.35 m |

Declared +8.08 m lateral reproduced ✅ (+63% vs exp1). Note the side effect: longitudinal sd drops
15.92→13.80 m (−13%) because the per-tick movement budget is re-allocated between axes.
Baseline image copies also in `verify2/`: `traj-exp1-baseline.png` (sha256 `c123e7b7…`, re-rendered during
independent exp1 verification) and `traj-exp1-baseline-owner.png` (sha256 `a5e21c4c…`, owner's original).
Real-frames image is in the exp1 verification directory (sha256 `349c1de7…`).

---

## 5. L1 statistical suite

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --test realism --release -- --ignored --nocapture'
```
**Result**: exit 0; **9 passed / 0 failed / 4 filtered out**, 139.85 s — declared 9/9 ✅.

Key readings (200 frozen seeds, 90-min matches unless noted):
- Fouls 23.27/match (yellow 3.40 / red 0.06), free kicks 23.27; corners 4.48/match, single-match peak 11 (<15).
- L3 aggregate: shots 3,403 (regular 3,130, headers 273), goals 430, saved 874, in-box goals 376,
  in-box share (rectangle caliber) 0.8744, on-target 0.3832, conversion 0.1264.
- Side-effect line: goals **home 1.06 / away 1.09 per match (H/A 0.972)**, pass events 963.1,
  shots 15.65 (+headers 1.36), tackles 26.34 (success 14.01), corners 4.48, throw-ins 18.41,
  goal kicks 27.79, fouls 23.27.
- 5-minute cohort: shots 0.92, restarts 2.60, fouls 1.70, goals 0.12.
- Frozen-window (600 matches) home/away: home **1.043/match**, away **0.960/match**, total **2.003**,
  H/A **1.087** (95% CI [0.971, 1.217]); conversion home 0.12575 (626/4978) vs away 0.11370 (576/5066).

**Home/away audit** (the exp1 residual risk): the previous state measured H/A 2.372 (home 1.372 / away 0.578,
total 1.950); R11 returns to H/A 1.09 (total 2.00) — the asymmetry is **fixed**, but total goal volume is
still about **28% below** the pre-change baseline (2.747) and the real anchor (~2.75). Log:
`verify2/l1-realism-nocapture.txt`.

---

## 6. Home/away event probe (independent read-only probe)

**Command**
```powershell
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs D:\pitchcraft-exp3\viewer\engine.wasm 401 600
```
**Result**: exit 0 (600 matches, seeds 401..1000). Log: `verify2/ha-probe.txt`.

| Event | Home | Away | H/A | Per match (home/away) |
|---|---:|---:|---:|---|
| shot | 4,968 | 5,054 | 0.983 | 8.28 / 8.42 |
| **goal** | **620** | **570** | **1.088** | **1.03 / 0.95** |
| tackle | 7,674 | 8,036 | 0.955 | 12.79 / 13.39 |
| foul | 7,674 | 6,304 | 1.217 | 12.79 / 10.51 |
| pass | 295,102 | 282,912 | 1.043 | 491.84 / 471.52 |
| corner | 1,472 | 1,201 | 1.226 | 2.45 / 2.00 |
| throw-in | 6,141 | 5,050 | 1.216 | 10.23 / 8.42 |
| free kick | 6,302 | 7,673 | 0.821 | 10.50 / 12.79 |

Interpretation vs provided references: pre-change baseline H/A ≈1.10 / total goals ≈2.77; real reference
H/A ≈1.25 / total ≈2.75. R11: **H/A 1.088 (back at baseline level, below real)**, **total goals ≈1.98
(−28% vs baseline and real)**. Caliber delta vs the Rust L1 home/away test: probe goal counts differ by
~1% (620/570 vs 626/576), attributable to event-attribution caliber; direction and magnitude agree.

---

## 7. P18 behavior gates

**Commands**
```powershell
# canary artifact (clean tree; commit hash passed as literal — see note)
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && P18_SOURCE_COMMIT=2a14601d506830c654f31052815e236b8ba80d66 cargo test --test p18_behavior_gates --release -- --ignored --nocapture'
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs
```
**Result**: artifacts OK (`p18_canary` 30 matches + `p18_baseline` 300 matches, 2 passed / 0 failed, 20.33 s;
canary sha256 `ff1940cdd145749eff83126e66ee8cababff758a889b8e8a0c11d5237cb40146`; provenance
`source_commit=2a14601…`, `engine_source_fingerprint=fnv1a64:24f620e67bc62866`). Judge tool exit 0
(report period), overall not passing.

| Key | Name | R11 | Real ref | Ratio | Verdict | Pre-change baseline | exp1 state |
|---|---|---:|---:|---:|---|---:|---:|
| A1 | chain wall-clock duration (s) | 28.0637 | 10.1814 | **2.76×** | fail (>1.5×) | 29.4866 / 2.90× | 27.9424 / 2.74× |
| A2 | in-chain action gap (s) | 5.0547 | 3.2010 | **1.58×** | fail (>1.5×) | 5.8440 / 1.83× | 5.1523 / 1.61× |
| B4 | possession-time pressed-share | 0.8854 | 0.5609 | 1.58× | pass (≥0.5×) | 0.6458 / 1.15× | 0.7344 / 1.31× |
| A3 | in-chain action count (guardrail) | 5.5546 | 3.1081 | 1.79× | guardrail; floor 4.4437 | 5.1045 | 5.4816 |
| C1 | chains ending in a shot (guardrail) | 0.0992 | 0.0749 | 1.32× | guardrail; floor 0.0793 | 0.1412 | 0.0993 |
| C1 companion | shot-ending chains per match | 16.9667 | 22.75 | 0.75× | comparable column | 23.40 / 1.03× | 17.13 / 0.75× |

**Is it worse than the pre-change baseline?** A1 and A2 are **better** than the pre-change baseline
(2.76× vs 2.90×; 1.58× vs 1.83×) but both still **fail** their 1.5× bounds; A2 is now only 0.08× above the
bound. A1 is marginally worse than the previous experiment state (28.06 vs 27.94). **B4 is worse than both**
pre-change (1.15×) and exp1 (1.31×) in distance-to-real terms: the engine now spends 0.885 of possession
time under pressing vs real 0.561 — the gate still passes because its check is one-sided (only a lower
bound). Logs: `verify2/p18-canary-gen.txt`, `verify2/p18-behavior-gates.txt`.
Environment note (not bypassed): the linked worktree `.git` file stores a Windows-style path, so WSL git
cannot resolve it; the commit hash was resolved on the host and passed literally (tree verified clean).

---

## 8. Ratchet comparison (22 metrics, changed vs pre-change baseline)

**Command**
```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp3/.scratch/tracking-data/winpath-hook.mjs'
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify2/ratchet-before.json
```
Baseline file = unchanged copy of the pre-change snapshot (sha256 `7738d4e2…`, provenance
`commit=1c5729d, wasm=bc2f2b2b, lib=eb675c14, realGames=2`).

**Result: exit code 1 — 3 regressions.**

| Metric | Before | After | Verdict |
|---|---:|---:|---|
| lf.disp | 6.270 | 11.560 | ✓ improved |
| lf.lat | 0.370 | 0.380 | ✓ improved (exp1 state had regressed to 0.250) |
| lf.mix | 0.800 | 0.800 | · same |
| lf.hd / lf.ad / lf.spread / lf.gap / lf.ballDist | 38.70/36.39/20.73/18.88/18.62 | 23.59/23.85/15.01/7.22/12.07 | ✓ improved |
| lf.distance | 0.542 | 0.186 | ✓ improved |
| p38.hd / p38.spread / p38.gap | 38.736/20.722/18.905 | 23.578/15.024/7.200 | ✓ improved (in band) |
| p38.latSd | 3.219 | 7.272 | ✓ improved (now inside band) |
| **p38.swarm** | 0.678 | 0.694 | ✗ regressed by band-distance rule (both values inside band [0.451, 0.891]; still passes criterion) |
| p38.fault | 12.220 | 3.420 | ✓ improved (in band) |
| p38.balance | 0.984 | 1.086 | · same (inside band) |
| **p38.shotsReg** | 23.400 | 13.800 | ✗ regressed by direction rule (still passes the criterion floor ≥5.5; now below the real anchor 16.51 — nearer in one sense, but the rule guards volume collapse) |
| p18.a1 | 29.487 | 28.064 | ✓ improved (still fails its gate) |
| p18.a2 | 5.844 | 5.055 | ✓ improved (still fails, closer) |
| **p18.b4** | 0.646 | 0.885 | ✗ regressed by direction rule |
| p18.a3 | 5.104 | 5.555 | · report only |
| p18.c1 | 0.141 | 0.099 | · report only |

Note on the `p18.b4` direction registry: the tool's `lower` direction is a one-sided proxy meaning
"closer to the real anchor by being lower" (real 0.561). For R11 the value moved 0.734→0.885, i.e. **away
from the real anchor**, so this row's "regressed" flag is meaningful here, not merely a stale registry
artifact (the gate passes only because its check is one-sided). For `p38.swarm` and `p38.shotsReg` the
flags are rule artifacts: both still satisfy their criteria. Compared with the exp1 state (4 regressions,
exit 1), R11 reduces the ratchet regression count to 3. Log: `verify2/ratchet-diff.txt`.

---

## 9. Default test suite (no `--ignored`)

**Commands**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --release'
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --release --no-fail-fast'
```

**Result**: **FAILED**. Plain run stops in the library target (`197 passed / 4 failed / 1 ignored`, 34.85 s,
exit 101). Full no-fail-fast run: **331 passed / 19 failed / 21 ignored**; **6 targets failed**:
`--lib`, `p124_intent_observations`, `p15_behavior_observation`, `p16_spatial_features`,
`p17b_diagnosis_report`, `realism`. Targets that passed: `p17a_behavior_chain_baseline` (24/0/2),
`p18_behavior_gates` (6/0/2), doc-tests (0).

Failure list with cause classification:

**(a) Behavior-dependent fixture / golden expectations — expected class when the model behavior changes
(17 of 19):**
| Target | Test | Evidence / cause class |
|---|---|---|
| lib | `observation::tests::every_episode_and_restart_object_has_event_indexes_or_a_documented_exception` | seed set no longer covers all three truncation shapes (fixture coverage) |
| lib | `observation::tests::truncated_stream_produces_a_full_time_gap_by_design` | expected sample no longer truncates an unresolved flight (gaps=0 vs 1) |
| p15 | `recorder_on_and_off_reproduce_the_golden_canary_stream` | seed 1 stream deviates from stored golden hash (needs `ACCEPT_GOLDEN=1` re-baseline) |
| p15 | `gap_is_a_classified_outcome_not_a_failure` | sample no longer reproduces a truncation gap (fixture invalid) |
| p15 | `every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect` | no gaps at all ⇒ guard cannot classify (fixture invalid) |
| p15 | `event_indexes_are_non_empty_monotonic_and_in_range` | seed coverage of truncation shapes lost (fixture coverage) |
| p16 | `rust_shape_is_in_the_same_regime_as_the_js_ruler` | Rust mean depth 23.67 m now differs from the JS ruler regime ≥30 m (behavior) |
| p16 | `phaseability_verdict_is_partial_and_the_evidence_is_duration_controlled` | AUC 0.666 vs expected separation (behavior/probe) |
| p17b | `instant_contest_covers_only_the_episode_closing_share_of_a2` | zero-duration contests 53.4% (design share changed) |
| p17b | `loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber` | mean loose duration 4.17 vs design 3.02 (behavior) |
| p124 | `defensive_intents_are_sparse_and_well_formed` | defensive intents not sparse under new behavior |
| p124 | `counter_proof_confirms_the_probe_is_intact` | AUC 0.666 outside probe's expected band |
| p124 | `gate_rerun_and_p16_baseline_side_by_side` | rerun differs from stored baseline |
| p124 | `purification_records_the_v4_verdict_pending_review` | purification AUC readings outside expected band |
| realism | `gm_canary_seeds` | golden line mismatch: seed 1 home_score golden 1 vs current 0 (needs re-baseline) |
| realism | `l2_sent_off_kickoff_seeds` | directed red-card seed 33 no longer produces a red card |

**(b) Source-text meta-guard brittleness — non-behavioral red (1):**
- lib `tests::p15_recorder_stays_out_of_the_decision_path` — panic "cannot find the end of the recorder
  impl block (structure changed?)": the guard parses `lib.rs` text and the added B-layer code moved its
  textual anchor. Not evidence about the decision path; guard needs maintenance.

**(c) Genuine behavioral assertion violation (1):**
- lib `tests::p53_same_team_spacing_ge_2m` — same-team emitted positions **1.9697 m < 2.2 m** at seed 9,
  t=4799 s, ids 4 and 0 ⇒ the same-team spacing guarantee is broken by this candidate (worth flagging as a
  real regression of a hard behavioral invariant, not merely a stale fixture).

**(d) Not attributable without a base comparison:**
- p124 `intent_features_cannot_reach_positions` (signature guard complains about `match_intents` signature;
  R11 did not touch `intent.rs`).
- In general, the default suite was **not** run on the base commit `0fe2989`, so per-test attribution
  between "inherited from the A-layer experiment" and "introduced by R11" cannot be separated here. Also
  note the default run had no `P124_SOURCE_COMMIT`/`P16_SOURCE_COMMIT`/`P17B_SOURCE_COMMIT` set (the
  ignored artifact gates were skipped as designed); the baseline-fingerprint checks are Node-side tests
  (`tools/benchmark-baseline.test.mjs`) and are not part of this Cargo step.
Raw logs: `verify2/default-suite.txt` (plain), `verify2/default-suite-all.txt` (no-fail-fast).

---

## 10. Risks / limitations

1. **Default suite is red**: 19 failures as classified above; one genuine hard-invariant failure
   (same-team spacing) plus one meta-guard breakage, the rest behavior/golden re-baselining.
2. **Formation margins are thin**: lateral sd is 0.257 above its lower bound; swarm 0.694 is inside but the
   band-distance rule still flags it; `shotsReg` 13.8 is below the real anchor (16.51) though above the
   one-sided floor (5.5).
3. **Goal volume remains low**: total goals ≈1.95–2.00/match vs baseline 2.75 and real ≈2.75 (−28%), while
   H/A is back at baseline level (≈1.09 vs real ≈1.25). The asymmetry risk from the previous state is fixed;
   the volume deficit is not.
4. **P18**: A1/A2 still fail (2.76×, 1.58×); B4 moved away from the real reference (1.58×) although the gate
   passes; no behavioral criterion has improved into its band.
5. **Lateral-track coefficient is a compensation value** (~2× the fitted real-side anchor per the owner's
   report), so P38 8/8 is achieved on a coefficient that the owner themselves flag as a compensation rather
   than a new mechanism.
6. **Probe caliber note**: the independent event probe attributes goals by shot subject; the Rust test
   counts differently by ~1%. Directions agree.
7. Not run here: Node-side tools test suite, full `verify.sh`, P38 mutation self-test, and the default suite
   on the base commit (see 9d).

---

## 11. Artifact hashes (this directory)

| File | Size (B) | sha256 |
|---|---:|---|
| `build.txt` | 3,780 | `c88c935f5c5a126d504e4f544500a31f3ebfda00fd91aff2e4737a43f37a6a90` |
| `p18-canary-gen.txt` | 2,885 | `4e078344ad781eff9ce103fef0885066fdb6a15e2e455d5dfb6d7139066abb63` |
| `p18-behavior-gates.txt` | 2,372 | `0a6fe85a110bead8799342060635b627e2a039baee12d049eb017c6e25d3d34f` |
| `p38-criteria.txt` | 1,242 | `4fd395e524f3faf5afa9c513fbfa07c6e78c98d169d5067a8b8516afae9c8cfe` |
| `p38-eval-current.json` | 434 | `f77994bb10e487dcf886cedc7262359d096bcddb9970d67d08bb55d1d19bed5f` |
| `like-football.txt` | 2,694 | `40f395e2355b808ed146dbe7e103ea2570b47b2fd882eaf939368fa02a597b99` |
| `ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` |
| `ratchet-diff.txt` | 2,908 | `a2194b7d2997b216261afd7cd05e3204d8b6bfade29e332406afa8180c2d9573` |
| `traj-engine.txt` | 1,022 | `5e148f15c6b82fda459485b327883d1fe47fdc9c503af68199fbdacf1979190d` |
| `traj-r11-engine.png` | 42,379 | `f8a42dbee9e01d476cade6ada53cf9bf5db46d7b05cb51e9ffec55354529b5d5` |
| `traj-exp1-baseline.png` | 35,510 | `c123e7b7b6832c43b3f3e61469ebd68e6115a0ee3081e2bf3958f8c7055bcdf9` |
| `traj-exp1-baseline-owner.png` | 30,382 | `a5e21c4ce68b997f1aae8af446d713bc07f19bd17c359a3a0ddd93eb75d9e747` |
| `l1-realism-nocapture.txt` | 3,665 | `2920c6f93dcf3b2070f053a1e3ec25e232748f678098742a57dded16db1b56c9` |
| `ha-probe.txt` | 1,592 | `2e7528ec8e4671ec6d196c04c1150cd9fb8a971a81bb22a8b036655c00e75c17` |
| `default-suite.txt` | 19,619 | `ed260eeee8d2a2893e5d6c674e2b7eb13b696076976195931bb87c3b4a9f39c6` |
| `default-suite-all.txt` | 42,597 | `3853e4b0dc2da15143fc2d1a1b5c09d58909b34822fd051eaca057097e960ee0` |
| `run-bg.sh` | 1,964 | `b1daa97ab2bcc41d17b65ba7fa7f8e5684785745363d37a879d9e484b2167109` |
| `run-default-nff.sh` | 440 | `4a082f23ed0a9a4b49f684953742382230b4624cc0bf3f0631f355a6c79e2125` |

Provenance anchors: commit `2a14601d506830c654f31052815e236b8ba80d66`, `engine/src/lib.rs`
`d44461db…`, `viewer/engine.wasm` `474a303f…`, canary `ff1940cd…` (source_commit `2a14601…`).
Tree clean after the run (`git status --porcelain` empty; `.scratch/exp3/` and `verify2/` locally excluded).

---

## 12. Reproduction

```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp3/.scratch/tracking-data/winpath-hook.mjs'
cd D:\pitchcraft-exp3
# build + P18 canary + L1 + default suite: verify2/run-bg.sh (first three stages), verify2/run-default-nff.sh
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify2\traj-r11-engine.png R11 120
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify2\ratchet-before.json
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs viewer\engine.wasm 401 600
```
Environment helpers (ignored, not committed): `.scratch/tracking-data/run-main.mjs`,
`.scratch/tracking-data/winpath-*.mjs` (Windows-only shims; main-guard and absolute-path ESM resolution).
