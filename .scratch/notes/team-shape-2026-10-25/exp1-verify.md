# Independent verification — team block-law prototype (experimental worktree)

- Worktree: `D:\pitchcraft-exp1` (detached HEAD, linked worktree of the main checkout)
- Date: 2026-10-25, 13:03–13:10 (+08:00)
- Verified state: current prototype change only (`engine/src/lib.rs`) + calibration note `EXP1-CALIBRATION.md`
- Purpose: independently re-run the declared acceptance readings against the frozen prototype state,
  record provenance, and audit the declared home/away goal numbers.
- Scope note: this document is written in neutral terms; it contains no external product names and no
  references to external analysis workspaces.
- Raw command outputs are in this directory (`verify/*.txt`, `verify/*.json`, `verify/*.png`).

---

## 0. Identity

| Item | Value |
|---|---|
| Worktree root | `D:\pitchcraft-exp1` |
| Starting HEAD (before this verification) | `1c5729d08fd8e1270d52005658bbed18802c1158` |
| Start state | `engine/src/lib.rs` modified (76 insertions / 49 deletions); untracked `EXP1-CALIBRATION.md`, `.scratch/exp1-cal/`, `out-traj-exp1.png`, `out-traj-real.png` |
| Host | Windows (PowerShell 5.1), Node `v24.22.1` from `D:\Software\node-v24.22.1-win-x64\node.exe` |
| Toolchain | Ubuntu 24.04.4 WSL, `cargo 1.99.1`, `rustc 1.99.1`, target `wasm32-unknown-unknown` |

---

## 1. Provenance commit (single, throwaway; not for merge)

**Command**
```powershell
git -C D:\pitchcraft-exp1 add engine/src/lib.rs EXP1-CALIBRATION.md
git -C D:\pitchcraft-exp1 commit -m "exp: team block law prototype"
```

**Result**: detached HEAD `0fe298944b0a349bba02f618677d3f81e160c055` ("exp: team block law prototype"),
`2 files changed, 232 insertions(+), 49 deletions(-)` (lib.rs + calibration note).
Calibration scratch (` .scratch/exp1-cal/`, two root-level PNGs, and this `verify/` directory) was kept out of
the commit via worktree-local exclusion entries in `.git/info/exclude` (not tracked files).

After the commit: `git status --porcelain` → empty (clean tree), which is the state used for all readings below.

| Artifact | sha256 |
|---|---|
| commit | `0fe298944b0a349bba02f618677d3f81e160c055` |
| `engine/src/lib.rs` (worktree) | `452ed99e6cb8c4de8a17ec73ed98b8720773723a7e7c625108b699dede85dc8c` |

---

## 2. wasm rebuild

**Command** (script `verify/build-log.sh`, internally the standard WSL build + copy)
```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/d/pitchcraft-exp1/verify/build-log.sh
```

**Result**: `build_exit=0`, warm build `Finished release profile … in 0.10s`, then
`cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm`.

| Artifact | Size (B) | sha256 | Time |
|---|---:|---|---|
| `viewer/engine.wasm` | 282,727 | `5b6488350b42a14aa96afe97992bb54bce8fcef4607f3fda46db0b30828a9402` | 13:08:55 |

✅ Matches the declared expected hash exactly: `5b6488350b42a14aa96afe97992bb54bce8fcef4607f3fda46db0b30828a9402`.
(The same hash was already present before the rebuild; the rebuild reproduces it.)
Build log: `verify/build.txt` (sha256 `b655ca962682dcccd9f0bd881ca0551caf041cdd0d65e32acfad37fe75a135cb`).
Compiler emits 12 dead-code warnings for prototype-era symbols; no errors.

---

## 3. P18 canary generation

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp1/engine \
  && P18_SOURCE_COMMIT=0fe298944b0a349bba02f618677d3f81e160c055 \
     cargo test --test p18_behavior_gates --release -- --ignored --nocapture'
```

**Result**: exit 0; `2 passed; 0 failed`, 14.12 s. Both ignored tests ran: `p18_canary` (30 matches) and
`p18_baseline` (300 matches).

⚠ Environment caveat (recorded, not worked around): the linked-worktree `.git` file stores a Windows-style
absolute gitdir, so WSL git cannot resolve it:
`fatal: not a git repository: /mnt/d/pitchcraft-exp1/D:/code/pitchcraft/.git/worktrees/pitchcraft-exp1`.
The source commit hash was therefore taken from the Windows side and passed as a literal (same mechanism as
the intended `P18_SOURCE_COMMIT=$(git … rev-parse HEAD)`). The tree was clean (verified on the Windows side)
before the run.

| Artifact | sha256 |
|---|---|
| `engine/target/p18-gates/canary.json` (30 matches) | `077c310be60840c55a9315e92f17752646480e89b6c4750dbfea5918edd1eb34` |
| `engine/target/p18-gates/baseline.json` (300 matches) | `a6bbf3b251ca5ba5826e878ea66465d40c15c303b277e22a3cd0a1d17cb162b0` |

Canary provenance: `source_commit=0fe2989…`, `model_version=9`, `caliber_version=p18-engine-v1`,
`engine_source_fingerprint=fnv1a64:db6be6db09e81d2d`, `test_source_fingerprint=fnv1a64:44502befc38cab9b`,
`seed_first=1 / seed_last=30`, `match_duration_seconds=5400`, `generated_by=engine/tests/p18_behavior_gates.rs`.
Log: `verify/p18-canary-gen.txt` (sha256 `86c474405991db3c693c898bc9e74a44eddb62edab0b2787ef025481f37b341d`).

---

## 4. P18 behavior gates

**Command**
```powershell
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs
```

**Result**: exit 0 (tool is report-period by design). Overall: **not passing** (2 of 3 real criteria fail;
2 guardrails only report information).

| Key | Name | Prototype | Real ref | Ratio | Verdict | Pre-change baseline |
|---|---|---:|---:|---:|---|---|
| A1 | chain wall-clock duration (s) | 27.9424 | 10.1814 | **2.74×** | fail (>1.5×) | 29.4866 / 2.90× |
| A2 | in-chain action gap (s) | 5.1523 | 3.2010 | **1.61×** | fail (>1.5×) | 5.8440 / 1.83× |
| B4 | possession-time pressed-share | 0.7344 | 0.5609 | 1.31× | pass (≥0.5×) | 0.6458 / 1.15× |
| A3 | in-chain action count (guardrail) | 5.4816 | 3.1081 | 1.76× | guardrail; floor = 4.3853 | 5.1045 |
| C1 | chains ending in a shot (guardrail) | 0.0993 | 0.0749 | 1.33× | guardrail; floor = 0.0794 | 0.1412 |
| C1 companion | shot-ending chains per match | 17.1333 | 22.7500 | 0.75× | comparable column (C1 share denominator is not comparable) | 23.40 / 1.03× |

Reading: A1 and A2 improved relative to the pre-change baseline but remain above their 1.5× bands (A2 is
just 0.11× above the bound). B4 still passes; its value moved away from the real reference (0.646→0.734 vs
real 0.561), which the ratchet table below flags under its own direction convention (see §5 note).
Raw log: `verify/p18-behavior-gates.txt` (sha256 `1a24a43bb2d2588abee5a08f4e8d4c7585dbc1befdb5f62ee9671d2a62746b5a`).

---

## 5. Ratchet comparison (22 metrics)

**Command**
```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp1/.scratch/tracking-data/winpath-hook.mjs'
cd D:\pitchcraft-exp1
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify/ratchet-before.json
```

Baseline file copied unchanged from `.scratch/notes/team-shape-2026-10-25/ratchet-before.json` in the main
checkout (sha256 `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd`; provenance
`commit=1c5729d, wasm=bc2f2b2b, lib=eb675c14, realGames=2`).

**Result: exit code 1 — 4 regressions.**

| Metric | Before | After | Verdict |
|---|---:|---:|---|
| lf.disp | 6.270 | 8.950 | ✓ improved |
| lf.lat | 0.370 | 0.250 | ✗ regressed (higher is better; real anchor 0.43) |
| lf.mix | 0.800 | 0.850 | ✓ improved |
| lf.hd | 38.700 | 23.730 | ✓ improved |
| lf.ad | 36.390 | 22.940 | ✓ improved |
| lf.spread | 20.730 | 15.490 | ✓ improved |
| lf.gap | 18.880 | 7.160 | ✓ improved |
| lf.ballDist | 18.620 | 14.520 | ✓ improved |
| lf.distance | 0.542 | 0.252 | ✓ improved |
| p38.hd | 38.736 | 23.691 | ✓ improved (entered band) |
| p38.spread | 20.722 | 15.458 | ✓ improved (entered band) |
| p38.gap | 18.905 | 7.151 | ✓ improved (entered band) |
| p38.latSd | 3.219 | 3.886 | ✓ improved (still outside band; P38's only red) |
| p38.swarm | 0.678 | 0.736 | ✗ regressed by band-distance rule (both values are **inside** the band [0.451, 0.891]) |
| p38.fault | 12.220 | 3.567 | ✓ improved (entered band) |
| p38.balance | 0.984 | 1.081 | · unchanged |
| p38.shotsReg | 23.400 | 16.200 | ✗ regressed by direction rule; still passes the criterion's floor (≥5.5) and is closer to the real reference (16.51) |
| p18.a1 | 29.487 | 27.942 | ✓ improved |
| p18.a2 | 5.844 | 5.152 | ✓ improved |
| p18.b4 | 0.646 | 0.734 | ✗ regressed by ratchet direction rule; **the behavior gate's direction is the opposite** (gate requires engine/real ≥ 0.5×, i.e. higher is better) — registry direction appears stale for this row |
| p18.a3 | 5.104 | 5.482 | · report only |
| p18.c1 | 0.141 | 0.099 | · report only |

Interpretation: one genuine regression (`lf.lat`, the known weak lateral axis); two "regressions" are
tool-rule artifacts while the underlying criteria still pass (`p38.swarm` in band, `p38.shotsReg` above
floor and nearer the real anchor); one (`p18.b4`) is a direction-registry inconsistency between the ratchet
tool and the behavior-gate definition. The raw tool verdict stands as reported: 4 regressions, exit 1.
Log: `verify/ratchet-diff.txt` (sha256 `0c685b70c260d33e72c70ad8f29a86d64e5a000f6d8df318990c00f283a2a93a`).

---

## 6. P38 formation criteria

**Command**
```powershell
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
```
**Result**: exit 0 (report period); **7/8 pass, 1 red** — matches the declared state.

| Criterion | Reading | Target | Verdict |
|---|---:|---|---|
| depth (home) | 23.691 | [23.385, 28.385] | ✅ |
| compactness | 15.458 | [13.41, 17.01] | ✅ |
| centroid gap | 7.151 | [6.54, 10.14] | ✅ |
| lateral displacement sd | 3.886 | [7.015, 14.015] | ❌ (known unfixed item) |
| pairwise y-correlation | 0.736 | [0.451, 0.891] | ✅ |
| line fault magnitude | 3.567 | [2.45, 7.45] | ✅ |
| line balance | 1.081 | [0.84, 1.28] | ✅ |
| regular shots per match | 16.200 | ≥ 5.5 | ✅ |

Evaluator raw JSON: `verify/p38-eval-current.json` (sha256 `e649770fd08ad79fd436a72b20783ed6163b7f26aa798bb62c6c72828b4a27e4`);
10 seeds, 6 windows, `crashedSeeds=0`. Full readings:
`hd 23.691 / spread 15.458 / gap 7.151 / width 41.157 / latSd 3.886 / lonSd 13.574 / swarm 0.736 / straight 0.139 / fault 3.567 / midBack 1.081 / shotsReg 16.200`.
Log: `verify/p38-criteria.txt` (sha256 `b2ae35c5d863447284245b4732da8e45c6cbab2288a59360bb9b1011748ccd63`).

---

## 7. Like-football loss table (8-row caliber)

**Command**
```powershell
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
```
**Result**: exit 0; **distance 0.252** (8/8 rows; old 9-row caliber including the report row = 0.239).

| Category | Metric | Prototype | Real | E/R | \|ln(E/R)\| |
|---|---|---:|---:|---:|---:|
| structure | depth (home) | 23.73 | 18.31 | 1.30 | 0.26 |
| structure | depth (away) | 22.94 | 18.45 | 1.24 | 0.22 |
| structure | compactness | 15.49 | 12.76 | 1.21 | 0.19 |
| structure | centroid gap★ | 7.16 | 5.24 | 1.37 | 0.31 |
| structure | width (report row) | 41.12 | 35.96 | 1.14 | 0.13 |
| structure | ball distance | 14.52 | 14.97 | 0.97 | 0.03 |
| motion | displacement/window★ | 8.95 | 13.46 | 0.67 | 0.41 |
| motion | lateral share★ | 0.25 | 0.43 | 0.59 | 0.53 |
| motion | mixed-team degree★ | 0.85 | 0.80 | 1.06 | 0.06 |

Flags: direction consistency 0.94 vs real 0.70 (**⚠ flagged as deviating**; pre-change baseline was
0.79 vs 0.70), displacement ratio 0.67, stationary share 0.00% both sides.
Log: `verify/like-football.txt` (sha256 `c1ff1bd1e923cfe934f3b412bc30963846155edf77c578f3b968037ae30cfccd`).

---

## 8. Trajectory images (120 s window, t ∈ [1800, 1920] s)

**Commands**
```powershell
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify\traj-exp1-engine.png exp1-final 120
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs real   verify\traj-real-game1.png real-game1 120
```

| Artifact | Size (B) | sha256 | Script reading |
|---|---:|---|---|
| `verify/traj-exp1-engine.png` (prototype) | 35,510 | `c123e7b7b6832c43b3f3e61469ebd68e6115a0ee3081e2bf3958f8c7055bcdf9` | lateral displacement sd **4.95 m**; longitudinal sd **15.92 m** |
| `verify/traj-real-game1.png` (real frames) | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` | lateral sd **10.04 m**; longitudinal sd **14.35 m** |

Prototype/real lateral ratio = 4.95/10.04 = **0.49** (pre-change baseline was 2.96/10.04 = 0.30; clear
improvement, still short of real). The real image is byte-identical to the one produced in the pre-change
baseline run (same sha256), confirming the real-frame rendering is deterministic and the data is unchanged.
Logs: `verify/traj-engine.txt` (sha256 `59413be1cb3083b8dcfebae0c5c0b17420666cb38ef56a180dc530f5ab937405`),
`verify/traj-real.txt` (sha256 `39f128d6b9c14875bfa3e821c0cc6c3f8d8c245a05403bca8af685325996bf0a`).

---

## 9. L1 statistical suite and home/away audit

**Command**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp1/engine \
  && cargo test --test realism --release -- --ignored --nocapture'
```
**Result**: exit 0; **9 passed / 0 failed / 4 filtered out**, 98.87 s. Log:
`verify/l1-realism-nocapture.txt` (sha256 `8f12410fa61fadf6836ece588317df444a3732a44f10c3a9c9c6fc2f594c6f51`).

Key printed readings (200 frozen seeds, 90-min matches unless noted):
- P13 side-effect line: goals **home 1.45 / away 0.58 per match** (H/A **2.491**), pass events 957.8,
  shots 14.79 (+ headers 1.07), tackles 27.46 (success 14.29), corners 3.80, throw-ins 20.39,
  goal kicks 25.48, fouls 21.82 (yellow 2.83 / red 0.05).
- Home/away test (600 matches, frozen window): home **1.372/match**, away **0.578/match**, total 1.950,
  H/A **2.372**; conversion home 0.13215 (823/6228) vs away 0.09674 (347/3587), gap +0.03541.
- Report-only calibration line: `matches=600 home_goals=823 away_goals=347 H/A=2.372 log(H/A)=0.864 95% CI=[2.092, 2.689]`.
- Shot-ratio outputs: shots 3173, regular 2959, headers 214, goals 405, saved 806, in-box goals 342,
  in-box share 0.8444, on-target 0.3817, conversion 0.1276.
- Other: fouls 21.82 / yellow 2.83 / red 0.05; corner peak 12 (bound 15); 5-min cohort: shots 0.89,
  restarts 2.60, fouls 1.31, goals 0.11.

### 9.1 Audit of the declared "home/away goals 1.435 / 0.580"

**Verdict: the numbers are goals per match (home / away); the ratio concern is CONFIRMED.**

- Caliber: both quoted sources are per-match goal counts over 90-minute matches —
  the side-effect line prints `进球 主1.45/客0.58` and the frozen-window test prints `主 1.372/场 客 0.578/场`.
  The declared 1.435/0.580 is the same quantity (measured on the final build: 1.372–1.45 home, 0.578–0.58
  away; the small difference from the declared 1.435 is a run/config delta, not a caliber change).
- Magnitude: H/A = 2.372 (600-match CI [2.092, 2.689]) to 2.491 (200-seed side-effect line). The declared
  "H/A ≈ 2.47" is therefore accurate.
- Comparison: pre-change baseline had home 1.415 / away 1.332 per match (H/A **1.063**); the real reference
  cited in the test comments is home 1.53 / away 1.22 (H/A ≈ 1.25). The prototype therefore moved home/away
  balance in the wrong direction by a wide margin, and total goals per match fell from 2.747 to 1.950.
- Why L1 is still 9/9: the home/away test asserts only (a) home goal sample ≥60, away ≥40;
  (b) home goals/match ∈ [0.85, 1.60] → 1.372 passes; (c) home conversion > away conversion → 0.13215 > 0.09674
  passes; (d) home/away shot samples ≥3000 each and team-shot sum equals total; (e) away goals/match ≥ 0.30 →
  0.578 passes. The H/A ratio itself is **not asserted** (the companion calibration test is explicitly
  report-only, no assertions). Total goals per match is likewise not gated.
- Conclusion: `9/9` is consistent with the gate's documented scope, but the gate has **no sensitivity** to this
  failure mode; the asymmetry is a genuine major residual risk (the calibration note's risk item 3 already
  flags it as compensation rather than a fix — this audit confirms the direction and magnitude and adds the
  gate-blindness explanation).
- Related gate-blind consequence: total goals/match 2.747 → 1.950 (−29%); the shots/distribution bands were
  satisfied by lowering shot volume (shots/match 22.23 → 14.79), with the away side absorbing the cut.

---

## 10. Risks and observations (summary)

1. **Home/away asymmetry confirmed**: H/A 2.37–2.49 vs real ≈1.25 and pre-change 1.063; not covered by any
   automated gate (§9.1). This is the largest residual risk.
2. **Total goals volume**: 1.95/match vs pre-change 2.75; shots 14.79/match vs pre-change 22.23; corners
   3.80 vs pre-change 4.91. Inside the existing bands but at the low edge.
3. **Lateral axis remains the weak point**: P38 lateral sd 3.886 is the only red criterion; like-football
   lateral share 0.25 vs real 0.43 (regressed from 0.37); ratchet flags it as a regression.
4. **New direction-consistency warning**: like-football direction consistency 0.94 vs real 0.70 (flagged);
   pre-change 0.79. Worth watching in follow-up.
5. **P18 A2 close to bound**: 1.61× vs 1.5× threshold; A1 2.74× still far.
6. **Ratchet rule/definition mismatches** (§5): B4 direction registry disagrees with the behavior gate;
   swarm/shotsReg "regressions" are in-band/floor-passing rule artifacts.
7. Default `cargo test` (golden baselines and other non-ignored suites) was not run — expected to change with
   behavior; this verification covers only the declared L1/L3 ignored suite plus the reporting tools.

---

## 11. Reproduction

```powershell
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/pitchcraft-exp1/.scratch/tracking-data/winpath-hook.mjs'
cd D:\pitchcraft-exp1
# build + P18 canary + L1: see verify/build-log.sh, §3, §9 commands
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node .scratch/tracking-data/run-main.mjs tools/ratchet.mjs diff verify\ratchet-before.json
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine verify\traj-exp1-engine.png exp1-final 120
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs real   verify\traj-real-game1.png real-game1 120
```
Environment helpers in `.scratch/tracking-data/` (ignored, not committed): `run-main.mjs` (main-guard shim
for Windows) and `winpath-*` (absolute-path ESM resolve hook). Both were required on Windows only.

---

## 12. Artifact hashes (this directory)

| File | Size (B) | sha256 |
|---|---:|---|
| `build.txt` | 4,052 | `b655ca962682dcccd9f0bd881ca0551caf041cdd0d65e32acfad37fe75a135cb` |
| `build-log.sh` | 836 | `b55e293403a7d845ac2cadf006df178cb7bd898c51a3aa08d963e5e4dea68810` |
| `p18-canary-gen.txt` | 2,800 | `86c474405991db3c693c898bc9e74a44eddb62edab0b2787ef025481f37b341d` |
| `p18-behavior-gates.txt` | 3,522 | `1a24a43bb2d2588abee5a08f4e8d4c7585dbc1befdb5f62ee9671d2a62746b5a` |
| `p38-criteria.txt` | 1,250 | `b2ae35c5d863447284245b4732da8e45c6cbab2288a59360bb9b1011748ccd63` |
| `p38-eval-current.json` | 440 | `e649770fd08ad79fd436a72b20783ed6163b7f26aa798bb62c6c72828b4a27e4` |
| `like-football.txt` | 2,708 | `c1ff1bd1e923cfe934f3b412bc30963846155edf77c578f3b968037ae30cfccd` |
| `ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` |
| `ratchet-diff.txt` | 2,906 | `0c685b70c260d33e72c70ad8f29a86d64e5a000f6d8df318990c00f283a2a93a` |
| `traj-engine.txt` | 1,022 | `59413be1cb3083b8dcfebae0c5c0b17420666cb38ef56a180dc530f5ab937405` |
| `traj-exp1-engine.png` | 35,510 | `c123e7b7b6832c43b3f3e61469ebd68e6115a0ee3081e2bf3958f8c7055bcdf9` |
| `traj-real.txt` | 1,052 | `39f128d6b9c14875bfa3e821c0cc6c3f8d8c245a05403bca8af685325996bf0a` |
| `traj-real-game1.png` | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` |
| `l1-realism-nocapture.txt` | 3,936 | `8f12410fa61fadf6836ece588317df444a3732a44f10c3a9c9c6fc2f594c6f51` |
| `run-bg.sh` | 1,650 | `15fe5db29e95c086d0acad3e51326c61f1bac81f50efa32178707c08eaf2c23d` |

Provenance anchors: commit `0fe298944b0a349bba02f618677d3f81e160c055`, `engine/src/lib.rs`
`452ed99e…`, `viewer/engine.wasm` `5b648835…`, canary `077c310b…`. Working tree clean after the run
(`git status --porcelain` empty; `verify/` and calibration scratch are locally excluded).
