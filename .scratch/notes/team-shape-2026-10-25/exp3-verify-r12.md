# Independent verification — discrete tier candidate R12 (experimental worktree)

- Worktree: `D:\pitchcraft-exp3` (detached HEAD, linked worktree of the main checkout)
- Date: 2026-10-25, 15:05–15:13 (+08:00)
- Candidate under test: R11 (A-layer block law + discrete B4 lane tiers + `EXP1_LATERAL_TRACK=0.70`
  + event constants `BASE_DEF_TACKLE=−1.47`, in-box arc saved 23) **plus a residual-pair forced
  separation fallback** (keeps the same-team spacing invariant on residual separation).
  Declared: formation criteria 8/8 (latSd 7.501 / swarm 0.769 for R11 base), L1 9/9, p53 11/11,
  and the four previously red focused tests (p5/p31/p32/p30) all green.
- Scope note: neutral wording; no external product names, no references to external workspaces.
- Raw outputs: `verify3/*.txt`, `verify3/*.json`, `verify3/*.png`.

---

## 0. Provenance / tree state

| Item | Value |
|---|---|
| Commit under test | `b93056649a4ae545f0dfaea3ed4f3072ee5925e2` — `exp: keep same-team spacing invariant on separation residual` (detached HEAD) |
| Parent | `2a14601` (= R11 commit) |
| Diff vs base `0fe2989` | `git diff --stat 0fe2989..HEAD`: `engine/src/lib.rs` (290 lines changed; 285 insertions, 5 deletions), `B-LAYER-REPORT.md` (263 lines), `SPACING-FIX.md` (111 lines) — total 3 files, 659 insertions, 5 deletions |
| Tree | clean; only this `verify3/` directory added to the worktree-local exclude list (plus an ignored helper dir). Tracked content untouched. |
| Host / toolchain | Windows + PowerShell 5.1; Node `v24.22.1`; Ubuntu 24.04.4 WSL, `cargo/rustc 1.99.1`, target `wasm32-unknown-unknown` |

---

## 1. wasm rebuild

**Command**: `verify3/run-bg.sh` stage 1 (standard WSL build + copy).
**Result**: `build_exit=0` (`Finished release profile … in 0.24 s`; target warm).

| Artifact | Size (B) | sha256 | Time |
|---|---:|---|---|
| `viewer/engine.wasm` (rebuilt) | 285,106 | `e28d51e0f2be4ad47d49e1c011b7f22dfcb1aa8043be9427744e2e3e1d0905f7` | 15:06:18 |
| `engine/src/lib.rs` | — | `84b982c0196d6756af9f0eaf853b87332d310e11a89a538f5c00086f46081e75` | — |

The rebuild reproduces the wasm that was already present in the worktree (same sha256). Log:
`verify3/build.txt`.

---

## 2. Formation criteria (P38)

**Command**: `node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs`
**Result**: exit 0 (report period); **8/8 pass**.

| Criterion | R12 reading | Target | Verdict | R11 reading |
|---|---:|---|---|---:|
| depth (home) | 23.716 | [23.385, 28.385] | ✅ | 23.578 |
| compactness | 15.066 | [13.41, 17.01] | ✅ | 15.024 |
| centroid gap | 7.178 | [6.54, 10.14] | ✅ | 7.200 |
| **lateral displacement sd** | **8.165** | [7.015, 14.015] | ✅ (margin +1.150) | 7.272 |
| pairwise y-correlation (swarm) | 0.753 | [0.451, 0.891] | ✅ | 0.694 |
| line fault | 3.430 | [2.45, 7.45] | ✅ | 3.420 |
| line balance | 1.086 | [0.84, 1.28] | ✅ | 1.086 |
| regular shots/match | 14.599 | ≥ 5.5 | ✅ | 13.800 |

Evaluator JSON: `hd 23.716 / spread 15.066 / gap 7.178 / width 43.179 / latSd 8.165 / lonSd 14.364 /
swarm 0.753 / straight 0.105 / fault 3.430 / midBack 1.086 / shotsReg 14.599`; 10 seeds, 6 windows,
`crashedSeeds=0`. R12 improves the lateral margin over R11 (7.272→8.165) at the cost of a slightly higher
swarm (0.694→0.753, still in band) — both remain passing.

---

## 3. Like-football loss table

**Command**: `node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12`
**Result**: exit 0; **distance 0.181** (8/8 rows; 9-row reporting caliber 0.181).

| Metric | R12 | R11 | exp1 state (0fe2989) | Pre-change baseline | Real anchor |
|---|---:|---:|---:|---:|---:|
| depth (home) | 23.81 | 23.59 | 23.73 | 38.70 | 18.31 |
| depth (away) | 23.61 | 23.85 | 22.94 | 36.39 | 18.45 |
| compactness | 15.08 | 15.01 | 15.49 | 20.73 | 12.76 |
| centroid gap★ | 7.20 | 7.22 | 7.16 | 18.88 | 5.24 |
| ball distance | 12.23 | 12.07 | 14.52 | 18.62 | 14.97 |
| displacement/window★ | 11.81 | 11.56 | 8.95 | 6.27 | 13.46 |
| lateral share★ | 0.38 | 0.38 | 0.25 | 0.37 | 0.43 |
| mixed-team degree★ | 0.80 | 0.80 | 0.80 | 0.80 | 0.80 |
| width (report row) | 43.07 | 43.28 | 41.12 | 49.62 | 35.96 |

Flags: direction consistency 0.88 vs real 0.70 (**flagged as deviating**); displacement ratio 0.88.
Distance improves slightly versus R11 (0.186→0.181) and substantially versus the exp1 state (0.252).
Log: `verify3/like-football.txt`.

---

## 4. L1 statistical suite

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --test realism --release -- --ignored --nocapture'
```
**Result**: exit 0; **9 passed / 0 failed / 4 filtered out**, 131.51 s — declared 9/9 ✅.

Key readings (200 frozen seeds, 90-min matches unless noted):
- Fouls 23.61/match (yellow 3.46 / red 0.05), free kicks 23.61; corners 4.59/match,
  single-match peak **15 — exactly at the 15 bound (margin 0)**.
- L3 aggregate: shots 3,394 (regular 3,106, headers 288), goals 437, saved 885, in-box goals 376,
  in-box share (rectangle caliber) 0.8604, on-target 0.3895, conversion 0.1288.
- Side-effect line: goals **home 1.10 / away 1.08 per match (H/A 1.014)**, pass events 963.2,
  shots 15.53 (+headers 1.44), tackles 26.10 (success 13.91), corners 4.59, throw-ins 18.47,
  goal kicks 27.95, fouls 23.61.
- Frozen-window 600 matches: home **1.050/match**, away **0.943/match**, total **1.993**, H/A **1.113**
  (95% CI [0.994, 1.247]); conversion home 0.12689 (630/4965) vs away 0.11230 (566/5040).
- 5-minute cohort: shots 0.92, restarts 2.60, fouls 1.70, goals 0.12.

Home/away: R12 returns H/A to ≈1.11 (R11 measured 1.087), i.e. near the pre-change baseline (≈1.10) and
below the real reference (≈1.25). Total goals ≈1.99/match remain ≈28% below the pre-change baseline and the
real reference (both ≈2.75). Log: `verify3/l1-realism-nocapture.txt`.

---

## 5. Focused regression filters (previously red items + p53)

**Commands**: `cargo test --lib --release <filter>` for `p53`, `p5`, `p31`, `p32`, `p30`.

| Filter | Result | Notes |
|---|---|---|
| p53 | **11 passed / 0 failed** ✅ | including `p53_same_team_spacing_ge_2m` (the R11 red) |
| p5 | **16 passed / 0 failed** ✅ | `p5_ball_side_shift` now green (was 15/16 red) |
| p31 | **20 passed / 0 failed** ✅ | liveness-stage guard now green (was 19/20 red) |
| p32 | **2 passed / 0 failed** ✅ | interception self-consistency now green (was 1/2 red) |
| p30 | **14 passed / 0 failed** ✅ | foul-cooldown decay now green (was 13/14 red) |

All five filter classes are fully green — the owner-provided claim is independently confirmed.
Logs: `verify3/p53.txt`, `verify3/p5.txt`, `verify3/p31.txt`, `verify3/p32.txt`, `verify3/p30.txt`.

---

## 6. P18 behavior gates

**Commands**
```powershell
# canary artifact (clean tree; commit hash passed as literal — see environment note)
wsl.exe -d Ubuntu-24.04 -- bash -lc '… P18_SOURCE_COMMIT=b93056649a4ae545f0dfaea3ed4f3072ee5925e2 cargo test --test p18_behavior_gates --release -- --ignored --nocapture'
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs
```
**Result**: artifacts OK (`p18_canary` 30 matches + `p18_baseline` 300 matches; 2 passed / 0 failed, 17.62 s;
canary sha256 `532aedc8e89a3b45660d8f5bc0b23bd075f9f6dfe61422d16faa58a06f7135f1`; provenance
`source_commit=b930566…`, `engine_source_fingerprint=fnv1a64:58029c3be5472b34`). Judge tool exit 0
(report period); overall not passing.

| Key | Name | R12 | Real ref | Ratio | Verdict | Pre-change baseline | R11 |
|---|---|---:|---:|---:|---|---:|---:|
| A1 | chain wall-clock duration (s) | 27.8607 | 10.1814 | **2.74×** | fail (>1.5×) | 29.4866 / 2.90× | 27.9424 / 2.74× |
| A2 | in-chain action gap (s) | 5.0557 | 3.2010 | **1.58×** | fail (>1.5×) | 5.8440 / 1.83× | 5.1523 / 1.61× |
| B4 | possession-time pressed-share | 0.8858 | 0.5609 | 1.58× | pass (≥0.5×) | 0.6458 / 1.15× | 0.7344 / 1.31× |
| A3 | in-chain action count (guardrail) | 5.5196 | 3.1081 | 1.78× | guardrail; floor 4.4157 | 5.1045 | 5.4816 |
| C1 | chains ending in a shot (guardrail) | 0.1007 | 0.0749 | 1.34× | guardrail; floor 0.0805 | 0.1412 | 0.0993 |
| C1 companion | shot-ending chains per match | 17.3000 | 22.75 | 0.76× | comparable column | 23.40 / 1.03× | 17.13 / 0.75× |

Versus the pre-change baseline: A1 better (2.74× vs 2.90×) but still fails; A2 better (1.58× vs 1.83×)
but still fails; **B4 worse** (1.58× vs 1.15× — pressing coverage now 58% above the real reference, further
from the real anchor; the gate passes only because its check is one-sided). This B4 profile is essentially
unchanged from R11. Logs: `verify3/p18-canary-gen.txt`, `verify3/p18-behavior-gates.txt`.
Environment note (not bypassed): the linked worktree `.git` file stores a Windows-style path, so WSL git
cannot resolve it; the full commit hash was resolved on the host and passed literally (tree verified clean).

---

## 7. Ratchet comparison (22 metrics)

**Command**
```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp3/.scratch/tracking-data/winpath-hook.mjs'
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify3/ratchet-before.json
```
Baseline = unchanged pre-change snapshot (sha256 `7738d4e2…`; provenance `commit=1c5729d, wasm=bc2f2b2b,
lib=eb675c14, realGames=2`).

**Result: exit code 1 — 3 regressions** (same regression set as R11).

| Metric | Before | After | Verdict |
|---|---:|---:|---|
| lf.disp | 6.270 | 11.810 | ✓ improved |
| lf.lat | 0.370 | 0.380 | ✓ improved |
| lf.mix | 0.800 | 0.800 | · same |
| lf.hd / lf.ad / lf.spread / lf.gap / lf.ballDist | 38.70/36.39/20.73/18.88/18.62 | 23.81/23.61/15.08/7.20/12.23 | ✓ improved |
| lf.distance | 0.542 | 0.181 | ✓ improved |
| p38.hd / p38.spread / p38.gap | 38.736/20.722/18.905 | 23.716/15.066/7.178 | ✓ improved (in band) |
| p38.latSd | 3.219 | 8.165 | ✓ improved (in band) |
| **p38.swarm** | 0.678 | 0.753 | ✗ rule flag: still inside band [0.451, 0.891] but farther from band center (closer to upper bound) |
| p38.fault | 12.220 | 3.430 | ✓ improved (in band) |
| p38.balance | 0.984 | 1.086 | · same (in band) |
| **p38.shotsReg** | 23.400 | 14.599 | ✗ rule flag (direction "higher"): still passes the criterion floor (≥5.5) but below the real anchor (16.51) |
| p18.a1 | 29.487 | 27.861 | ✓ improved |
| p18.a2 | 5.844 | 5.056 | ✓ improved |
| **p18.b4** | 0.646 | 0.886 | ✗ **valid regression**: engine/real coverage 0.886 vs real 0.561, i.e. the value moved away from the real anchor (the one-sided behavior gate still passes) |
| p18.a3 | 5.104 | 5.520 | · report only |
| p18.c1 | 0.141 | 0.101 | · report only |

Summary: 18 improved, 1 unchanged, 3 regressions. Per the task's note: **p18.b4 0.646→0.886 is an effective
regression in distance-to-real terms even though the gate passes**; `p38.swarm` and `p38.shotsReg` are
rule-based flags while their criteria still pass. Log: `verify3/ratchet-diff.txt`.

---

## 8. Home/away event probe (independent read-only probe)

**Command**
```powershell
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs D:\pitchcraft-exp3\viewer\engine.wasm 401 600
```
**Result**: exit 0 (600 matches, seeds 401..1000). Log: `verify3/ha-probe.txt`.

| Event | Home | Away | H/A | Per match (home/away) |
|---|---:|---:|---:|---|
| shot | 4,956 | 5,021 | 0.987 | 8.26 / 8.37 |
| **goal** | **629** | **557** | **1.129** | **1.05 / 0.93** |
| tackle | 7,679 | 7,981 | 0.962 | 12.80 / 13.30 |
| foul | 7,803 | 6,300 | 1.239 | 13.01 / 10.50 |
| pass | 295,381 | 283,078 | 1.043 | 492.30 / 471.80 |
| corner | 1,456 | 1,226 | 1.188 | 2.43 / 2.04 |
| throw-in | 6,124 | 5,132 | 1.193 | 10.21 / 8.55 |
| free kick | 6,298 | 7,802 | 0.807 | 10.50 / 13.00 |

Probe H/A = 1.129 (frozen-window L1 caliber 1.113 — agreement within ~1.4%); pre-change baseline H/A ≈1.10,
real reference ≈1.25. Total goals ≈1.98/match (baseline ≈2.77, real ≈2.75): the H/A asymmetry is fine, the
volume deficit remains.

---

## 9. Trajectory image (120 s window, t ∈ [1800, 1920] s)

**Command**
```powershell
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify3\traj-r12-engine.png R12 120
```
**Result**: exit 0; 900×620 PNG `verify3/traj-r12-engine.png`
(sha256 `f8a42dbee9e01d476cade6ada53cf9bf5db46d7b05cb51e9ffec55354529b5d5`).

| Series | Lateral sd | Longitudinal sd |
|---|---:|---:|
| R12 | **8.08 m** | **13.80 m** |
| exp1 state (independently verified) | 4.95 m | 15.92 m |
| Real-frame reference | 10.04 m | 14.35 m |

The rendered PNG is **byte-identical to the R11 trajectory image** (same sha256): in this sampled window the
residual-pair fallback never activates, so the trajectory is unchanged — consistent with the fix being a
narrow invariant guard rather than a motion-model change. R12 remains an improvement over the exp1 state
laterally (4.95→8.08) and is now at the real longitudinal level (13.80 vs real 14.35).

---

## 10. Default test suite (`cargo test --release --no-fail-fast`)

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --release --no-fail-fast'
```
**Result**: **FAILED** — `331 passed / 19 failed / 21 ignored`; **6 targets failed**: `--lib` (3 failed),
`p124_intent_observations` (5), `p15_behavior_observation` (4), `p16_spatial_features` (2),
`p17b_diagnosis_report` (3), `realism` (2). Passing targets: `p17a_behavior_chain_baseline` (24/0/2),
`p18_behavior_gates` (6/0/2), doc-tests.

**(a) Inherited from the base heritage (18 of 19):**
- `--lib` (3): `observation::tests::every_episode_and_restart_object_has_event_indexes_or_a_documented_exception`,
  `observation::tests::truncated_stream_produces_a_full_time_gap_by_design`,
  `tests::p15_recorder_stays_out_of_the_decision_path` (source-text meta-guard brittleness — non-behavioral).
- `p124` (5): `defensive_intents_are_sparse_and_well_formed`, `counter_proof_confirms_the_probe_is_intact`,
  `gate_rerun_and_p16_baseline_side_by_side`, `intent_features_cannot_reach_positions`,
  `purification_records_the_v4_verdict_pending_review`.
- `p15` (4): `gap_is_a_classified_outcome_not_a_failure`,
  `every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`,
  `event_indexes_are_non_empty_monotonic_and_in_range`,
  `recorder_on_and_off_reproduce_the_golden_canary_stream`.
- `p16` (2): `rust_shape_is_in_the_same_regime_as_the_js_ruler`,
  `phaseability_verdict_is_partial_and_the_evidence_is_duration_controlled`.
- `p17b` (2): `instant_contest_covers_only_the_episode_closing_share_of_a2`,
  `loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber`.
- `realism` (2): `gm_canary_seeds` (golden re-baseline), `l2_sent_off_kickoff_seeds` (directed red-card seed
  lost). **`l2_cross_event_invariants` passes** (goalkeeper position invariant intact).

**(b) New for R12 relative to R11 (1 of 19):**
- `p17b` `restart_window_falls_back_explicitly_when_taken_t_is_missing` — the canary no longer contains any
  `taken_t`-missing fallback window (observed distribution `{"taken_t": 2498}`; expected 2 cases in 30
  seeds), so the fallback branch is unexercised. This is a **probe/caliber coverage guard**, not a hard
  behavioral invariant; it becomes red because the R12 event-flow change removed the triggering samples.

**(c) All four previously red focused items + p53 are green in this suite** (see §5); the default-suite red
set is now 3 lib failures fewer than R11 (R11: 19 total, lib 4; R12: 19 total, lib 3) with one p17b probe
guard added.

Caveat: the base commit `0fe2989` was never run with the default suite, so the inherited/new boundary is
relative to the previous candidate's run (same base heritage), not a verified base result. The
baseline-fingerprint checks are Node-side tests outside this Cargo step; Windows line-ending sensitivity
affects those Node hash sentinels, not these Cargo tests. Log: `verify3/default-suite-all.txt`.

---

## 11. Verdict (requested: can R12 serve as “does not break existing gates” delivery evidence?)

- **Owner-declared gates reproduced**: formation criteria 8/8 (R12 values: latSd 8.165, swarm 0.753),
  L1 9/9, p53 11/11, and all four previously red focused tests (p5 16/16, p31 20/20, p32 2/2, p30 14/14)
  are green — independently confirmed.
- **Tracked hard-invariant regressions from the continuous-tier / motion candidates are resolved**:
  p5 / p31 / p32 / p30 / p53 all green; the goalkeeper cross-event invariant (`l2_cross_event_invariants`)
  is green. This is the cleanest candidate of the series on hard behavioral invariants.
- **Remaining default-suite red set is the inherited fixture/golden class plus one new probe-coverage guard**
  (`p17b restart_window_falls_back_explicitly_when_taken_t_is_missing`). No new *hard behavioral* invariant
  failure was found.
- **Residual numerical risks** (should accompany any delivery decision): `p18.b4` is a valid regression
  (0.646→0.886, gate still passes one-sidedly); `p38.swarm` 0.753 is in band but closer to the upper bound;
  `p38.shotsReg` 14.6 is below the real anchor 16.51; total goals ≈1.99/match (−28% vs baseline/real);
  corner single-match peak reached the bound (15/15, margin 0); H/A ≈1.11–1.13 (baseline ≈1.10, real ≈1.25).
- **Caveat for “delivery evidence”**: the base commit was not run through the default suite, so the
  inherited/new classification is advisory; and the Node-side tools tests were not part of this step.

---

## 12. Limits

1. Default suite was not run on the base commit `0fe2989`; inherited/new boundary is relative to the prior
   candidate run (advisory).
2. Node-side tools test suite (including baseline-fingerprint sentinels) not run — out of this step's scope.
3. The new p17b probe-coverage red needs a decision (refresh canary fixture or accept unexercised branch).
4. Corner peak 15 equals its bound — zero margin on that statistical bound.
5. Formation margins good (latSd +1.150) but swarm closer to upper bound than R11.

---

## 13. Artifact hashes (`verify3/`)

| File | Size (B) | sha256 |
|---|---:|---|
| `build.txt` | 3,718 | `89212a75516a0a5ebec1fcce7006d337a49199596e115d9720ef0d460d69966d` |
| `p38-criteria.txt` | 1,242 | `c07fcc6d169a4c2c08a97125f547719b9664f4859b40aaa5c36778f87088982e` |
| `p38-eval-current.json` | 442 | `48b8e4d8b10edf7b690b864b8a566764366d61701bc86e8182c767c6c33a203b` |
| `like-football.txt` | 2,692 | `4af30dc6515f31e79ceac50fb1f2cce5df032f7c7bee9aab8f575d297e4a6d9c` |
| `traj-engine.txt` | 1,022 | `8ee7bf572f1b732780d5e2be6d480e3912abf05199a4aee404bd5f9645382a34` |
| `traj-r12-engine.png` | 42,379 | `f8a42dbee9e01d476cade6ada53cf9bf5db46d7b05cb51e9ffec55354529b5d5` |
| `traj-exp1-baseline.png` | 35,510 | `c123e7b7b6832c43b3f3e61469ebd68e6115a0ee3081e2bf3958f8c7055bcdf9` |
| `traj-real-game1.png` | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` |
| `p18-canary-gen.txt` | 2,885 | `282647f1a2ff358a91807672d74fb8d07be6c26f3c78fa026b84b2064b521f3e` |
| `p18-behavior-gates.txt` | 2,262 | `b03bac92ad2ac2f0521df8ca03118037eec54a578e5b585aebdfaf7601775b28` |
| `ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` |
| `ratchet-diff.txt` | 2,908 | `4183ce191b88905a10c8a82470634240f3aaaedd28cb87eae2bf1f966544473f` |
| `l1-realism-nocapture.txt` | 3,665 | `e6f4c9f030b7786ace40ac3b8d2b9a311579995880258bbd8746ec4133318c2f` |
| `ha-probe.txt` | 1,592 | `95ba4c49dcfc214ba7467847d32a734044bef82ea7f6e695b181fb783160ffcc` |
| `p53.txt` | 3,899 | `fdc6a2d5aad85f0769587489adbedbfbb6f6a5971e4ba2cda9700285fd8216f9` |
| `p5.txt` | 4,112 | `3946b8e9e5ec8901effcbe0d7eb8b6849f2a74eade2328d0271797f42802d53b` |
| `p31.txt` | 4,348 | `2f90d9a019a6aa948e710f92e582d5e33cf46f8503ed4a30a84d63664a71dd40` |
| `p32.txt` | 3,354 | `e427556336c8d02758965deda4f90af6f1bc84906e417915b72e500228235a5e` |
| `p30.txt` | 3,955 | `5110e41c435dfa32d447cb7e373c427e8120e6ba8111ce509b8bf324b5e0a54c` |
| `default-suite-all.txt` | 42,861 | `568e320944d39d8b2d3bad770647066e2d62757d254d0b0897e0b9a4f5b72947` |
| `run-bg.sh` | 2,249 | `d5e5bc73f6461fd2c00e21a421b0bdfd79d73549ef15b62d178722450b8e43c2` |

Provenance anchors: commit `b93056649a4ae545f0dfaea3ed4f3072ee5925e2`, `engine/src/lib.rs` `84b982c0…`,
`viewer/engine.wasm` `e28d51e0…`, canary `532aedc8…` (source_commit `b930566…`). Tree clean; tracked content
untouched; only `verify3/` locally excluded.

---

## 14. Reproduction

```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp3/.scratch/tracking-data/winpath-hook.mjs'
cd D:\pitchcraft-exp3
# build + P18 canary + L1 + focused filters + full default suite: verify3/run-bg.sh
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify3\traj-r12-engine.png R12 120
node .scratch/tracking-data/run-main.mjs tools\ratchet.mjs diff verify3\ratchet-before.json
node D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs viewer\engine.wasm 401 600
```
Environment helpers (ignored, not committed): `.scratch/tracking-data/run-main.mjs`,
`.scratch/tracking-data/winpath-*.mjs` (Windows-only shims).
