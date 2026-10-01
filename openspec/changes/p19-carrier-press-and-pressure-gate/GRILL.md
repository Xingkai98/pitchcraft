# P19 Adversarial Design Review

Review basis: pristine `engine/src/lib.rs`, sha256
`2adfe62b49db00e8044d3e78c594b9290a4f111b8135cbd79adcad7f216f4cc1`.
This is a read-only review; no implementation was applied by this reviewer.
The shared worktree later acquired a concurrent prototype diff, which was not
used as review evidence or modified here.

## VERDICT

**SOUND-WITH-FIXES**

The central mechanism claim is true in the current code: the 8 m pressure
early-return makes the nearest-defender term structurally zero on every
reachable open-play shot-engage path, and moving only that clause after the
roll makes the term reachable. The proposed delivery is not implementation
ready, however. It knowingly leaves a hard p53 trajectory invariant broken,
does not define the 4 m standoff in the same geometry used by the mover code,
understates the golden/test blast radius, and uses an `ADDED` spec delta for
behavior that modifies an existing requirement.

## BLOCKERS

### 1. The known p53 invariant violation is still unresolved

- **Evidence:** `design.md:104` records `p53_same_team_spacing_holds_between_anchors`
  failing at 1.74 m, and `design.md:106` records another 1.28 m failure.
  The design says the proposed fixes A/B/C/D are only candidates
  (`design.md:110`), with C/D explicitly still requiring experiments
  (`design.md:113`-`design.md:119`).
- **Why this blocks:** The existing engine requirement is not merely an event
  count preference. `openspec/specs/match-engine/spec.md:481` requires the
  same-team metric invariant, and `:501` requires the entire swept trajectory,
  not only endpoints, to stay above the detector threshold. The test at
  `engine/src/lib.rs:8001` checks exactly the failure mode the prototype
  exhibits. The P19 delta itself admits that implementation must stop until
  this is clean (`.../specs/match-engine/spec.md:59`-`:63`).
- **Fix required:** Implement and measure one correction at a time. Require
  zero endpoint and swept violations over the existing p53 seed set and a
  larger holdout set, then rerun B4 and all L1 bands. Do not rebaseline p53
  or weaken the threshold. If a fix changes the press trajectory, its B4/L1
  numbers must be regenerated.

### 2. “4 m standoff” is not defined by the geometry the implementation uses

- **Evidence:** The design asks for `CLOSE_DOWN_STANDOFF_M` in meters and says
  to reuse `close_down_stop` (`design.md:61`-`design.md:73`). But
  `close_down_stop` at `engine/src/lib.rs:3215`-`:3221` uses `dist_norm`, and
  `CLOSE_DOWN_STOP_DIST` at `engine/src/lib.rs:691` is the normalized value
  `0.02`. `dist_norm` at `engine/src/lib.rs:700` is an unscaled Euclidean
  distance. The actual meter conversion is a different function,
  `distance_meters`, at `engine/src/lib.rs:5551`.
- **Why this blocks:** A normalized 0.02 stop is about 2.1 m on the x axis
  but 1.36 m on the y axis, not a 4 m metric standoff. The proposed code
  therefore has no unambiguous way to implement the published calibration.
  In addition, `pick_close_down_players` at `engine/src/lib.rs:3224`-`:3236`
  ranks candidates by normalized squared distance, while the spec says
  “nearest” and all pressure scoring uses metric distance.
- **Fix required:** Define the target in metric geometry, for example by
  constructing a point on the defender-to-carrier ray whose
  `distance_meters(target, carrier)` is exactly the configured standoff,
  with a documented boundary/clamp rule. Decide whether “nearest” means
  metric distance and implement that consistently. Add a convergence guard
  so a presser already within standoff produces no mover. Re-run the
  calibration after this exact implementation exists.

### 3. The proposed mover insertion point is broader than open play

- **Evidence:** `compute_mover_candidates` has a transition branch and one
  generic non-transition `else` (`engine/src/lib.rs:3292`-`:3301`), but the
  function is called from restart preparation at `:4673` and `:4691`,
  loose-ball movement at `:4971`, kickoff/dead-ball handling at `:5389`,
  and ordinary carrier beats through `beat_movers_main` at `:5933`-`:5939`.
  The design's pseudo-code only adds an `else if carrier is external`
  (`design.md:64`-`:70`); it does not add an explicit open-play context.
- **Why this blocks:** “non-transition” is not equivalent to
  “non-transition, non-dead-ball, non-loose, non-restart-prep”. If `st.carrier`
  remains valid in any of those shared paths, the new branch will emit a
  `close_down` mover during a state the requirement explicitly excludes. Even
  if current state clearing happens to make some calls inert, that is an
  undocumented coupling and a future regression trap.
- **Fix required:** Pass an explicit open-play/mover context (or use a
  dedicated open-play candidate path) and gate on the exact excluded states.
  Add tests that assert no press mover during transition, loose ball, restart
  preparation, dead-ball flight, and set-piece preparation, while ordinary
  open play does produce the presser.

### 4. The stated four-test blast radius omits exact-stream golden failures

- **Evidence:** The design/proposal list four red tests
  (`design.md:95`-`design.md:104`, `proposal.md:50`-`proposal.md:59`).
  However, `engine/tests/realism.rs:1336`-`:1355`
  `gm_canary_seeds` compares every summary field and the event stream hash
  against `golden-v{MODEL_VERSION}`. Independently,
  `engine/tests/p15_behavior_observation.rs:241`-`:265`
  requires both recorder-on and recorder-off streams to match the same golden
  hashes for seeds 1..10.
- **Why this blocks:** A press mover and changed carrier decisions are
  intentional observable behavior changes. They necessarily change event
  counts, mover content, and often RNG branch consumption. “Record that the
  event flow changed” does not make these exact-hash tests pass. The proposed
  default suite cannot be green under the stated implementation without an
  explicit golden/version decision.
- **Fix required:** Choose and document either a new `MODEL_VERSION`/golden
  directory or a deliberate rebaseline of the current version. Regenerate
  goldens, inspect the complete diff, preserve the v1..v6 legacy baselines,
  and rerun the P15 recorder gates. Do not call the blast radius four until
  the full suite has been run. Also run the P124 live-path intent tests,
  especially `engine/tests/p124_intent_observations.rs:582`,
  `:626`, `:741`, and `:1222`, because their production assertions are tied
  to shot-window and defensive-intent timing.

### 5. The spec delta is semantically `MODIFIED`, not only `ADDED`

- **Evidence:** The P19 delta is headed `## ADDED Requirements` and includes
  the pressure ordering and liveness behavior at
  `.../specs/match-engine/spec.md:14`-`:18` and scenarios at
  `:37`-`:47`. The main spec already has
  `### Requirement: 持球行动机会驱动开放比赛行动评估` at
  `openspec/specs/match-engine/spec.md:350`, including the shot hazard and
  `defensive_pressure` formula at `:354`, defensive competition at `:358`,
  and the liveness pass behavior at `:360` and `:436`.
- **Why this blocks:** P19 changes the meaning and ordering inside an
  existing requirement: pressure no longer excludes the shot-engage path.
  That is a modification, even though the B4 press-assignment behavior is
  genuinely new. Leaving the whole block as `ADDED` creates two overlapping
  sources of truth.
- **Fix required:** Split the delta. Keep a narrowly scoped B4 press
  requirement as `ADDED`; represent the pressure-gate/order change as a
  `MODIFIED` copy of the existing requirement, with its header matching the
  main spec exactly and its full scenario set copied. The repository process
  explicitly requires that for `MODIFIED`
  (`openspec/changes/p104-volume-recalibration/tasks.md:80`-`:86`;
  see also `openspec/changes/archive/2026-09-18-p37-skillcorner-corpus/specs/pitch-viewer/spec.md:3`-`:7`).
  The current `npx openspec validate p19-carrier-press-and-pressure-gate
  --strict` result is “valid”, but that only validates the current
  structural delta; it does not resolve this semantic overlap.

## Mechanism Verification

The hard-gate claim is confirmed:

1. `OPEN_PLAY_PASS_PRESSURE_M` and `SHOT_PRESSURE_NEAR_M` are both 8.0
   (`engine/src/lib.rs:556` and `:576`).
2. `evaluate_open_play_carrier_action` computes the nearest defender at
   `engine/src/lib.rs:1828`, then returns Pass before the shot-engage roll
   when `nearest_defender_m <= OPEN_PLAY_PASS_PRESSURE_M` at `:1836`.
3. The only NaturalDeadline shot-engage call is immediately after that guard,
   at `engine/src/lib.rs:1843`.
4. `open_play_shot_engage_hits` extracts `shot_opportunity_features` and calls
   `compute_shot_score` at `engine/src/lib.rs:1875`-`:1880`.
5. The feature extraction reads metric nearest and second-defender distances
   at `engine/src/lib.rs:6113`-`:6125`; `defensive_pressure` is non-zero for
   a nearest defender below 8 m at `:6044`-`:6048`, and
   `compute_shot_score` subtracts it at `:6081`-`:6086`.

There is no other early guard in the NaturalDeadline path that makes this
specific roll unreachable. The `facing_goal` guard belongs to the separate
ShotWindow path (`engine/src/lib.rs:1755`-`:1769`). `foul_allowed` is only a
defensive score qualification (`engine/src/lib.rs:6303`-`:6305`), not a
carrier-side early return.

The claim needs one qualification: “shot path is reachable” does not mean a
Shot event is guaranteed. NaturalDeadline still evaluates the defense at
`engine/src/lib.rs:1893`-`:1932`, and `resolve_action_opportunity` gives
Tackle/Foul precedence over the carrier action at `:1935`-`:1955`. A pressed
carrier can therefore enter `open_play_shot_engage_hits` and still be
interrupted by defensive competition. The spec should say whether it is
asserting candidate reachability or emitted Shot-event probability.

## P1 Issues

### B4 is gameable by long-distance movers

`gates-spec.json:74`-`:89` defines B4 as the fraction of carrier ticks with a
defender mover whose distance to `beat.main` decreases by more than 0.3 m. It
does not require a close final distance. The reconnaissance records that a
20 m standoff produced roughly 63% B4 while making mean defender distance
worse (`.scratch/notes/19-recon-2026-10-01.md:133`-`:137`). The selected 4 m
value is less suspicious, and it is near the measured baseline distance, but
the design has no anti-gaming guard.

For acceptance, report B4 together with nearest-defender mean/median and
p10/p90, the share at <=5 m and <=8 m, approach delta, final absolute
distance, presser identity/action, and repeated/oscillating assignment counts.
Run the 4 m result beside the 20 m counterexample. B4 alone is not evidence
of realistic defending.

### The published numbers are plausible but not independently reproducible

The three-window table is internally coherent: the shape probe reports
18.36/18.67/18.26 shots, 32.92-33.48 tackles, 27.45-28.15 fouls, and
pass completion 0.8415-0.8438 (`.scratch/notes/19-shape-probe-2026-10-01.md:60`-`:70`).
The direct B4 value 0.2880 and the P18 checker value 0.2832 are not
automatically contradictory, but the difference must be attributed to the
exact checker/denominator implementation.

They remain unverified for review purposes because the probes were deleted
and the committed engine is pristine (`.scratch/notes/19-shape-probe-2026-10-01.md:137`-`:143`).
The same note records an earlier buggy reorder that moved liveness as well
and produced 21.3 shots in one window versus 5.4/5.2 in the others
(`:147`-`:155`). That self-correction supports the final mechanism, but it
also shows that a five-line ordering change is sensitive to exact patch
shape. Require the exact patch, source fingerprint, command, raw outputs,
and both B4 implementations before trusting the numbers.

### A1/A2 scope cut is legitimate, but it is not a solved behavior

The proposal explicitly leaves A1/A2 to the opportunity-lifecycle work
(`proposal.md:61`-`:64`), and the actual `advance_action_opportunity`
mechanism remains unchanged at `engine/src/lib.rs:1995`-`:2035`. That scope
cut is legitimate for a B4-focused change. The probe reports improvement,
not resolution: A1 remains 4.12x real and A2 3.41x real
(`.scratch/notes/19-shape-probe-2026-10-01.md:72`-`:80`).

Keep A1/A2 as non-regression reports and retain A3/C1 as guardrails. Do not
use the observed improvement as evidence that this change fixes chain tempo.

### The spec conditions are not fully aligned with their scenarios

The requirement says open play excludes transition, dead ball, loose-ball,
and restart-prep states (`.../specs/match-engine/spec.md:5`), but the first
scenario only says “non-transition” (`:31`-`:35`). Add the other exclusions
to the scenario or make the implementation contract explicit. Also, the
scenario permits `chase` or `close_down`, while the current open-play mover
branch only has `close_down` semantics; `chase` exists in other contexts at
`engine/src/lib.rs:3337`-`:3344`. Use the exact intended action vocabulary.

### The p53 threshold wording is inconsistent

The P19 scenario says trajectory distance `>= 2 m`
(`.../specs/match-engine/spec.md:59`-`:63`). The main spec documents
`SAME_TEAM_MIN_DIST_M = 2.2 m` at `openspec/specs/match-engine/spec.md:481`,
the code sets 2.2 m at `engine/src/lib.rs:642`-`:648`, endpoint tests assert
that threshold at `:7926`-`:7973`, and swept tests use the detector's 2.0 m
threshold with epsilon at `:8001`-`:8043`. State clearly which layer is the
contract: 2.2 m endpoint solver target, 2.14 m swept target, and strict
2.0 m detector gate, or change the requirement to match the actual design.

## P2 Issues

- The “nearest one” rule is not deterministic in the same metric as the
  pressure features. `pick_close_down_players` uses normalized geometry and
  a sort tie-break by id; the spec should either adopt that exact rule or
  require metric nearest with the tie-break.
- The proposed per-beat assignment can repeatedly emit the same presser after
  it reaches the target. Without convergence detection, B4 can be purchased
  by repeated small approach segments and event volume can inflate. The
  design mentions this only as candidate fix C (`design.md:113`-`:116`).
- The design should add a direct regression test for GK holding and
  `stalled_unpressed`. The code currently combines both with the pressure
  guard at `engine/src/lib.rs:1829`-`:1839`; a careless reorder reproduces
  the exact failure documented in shape-probe section 8.
- The full realism suite has more hard volume and distribution guards than
  the four listed tests: shot bucket shares and `far45` at
  `engine/tests/realism.rs:673`-`:677`, shot/tackle ratio and corner/throw-in
  bounds at `:792`-`:855`, pass completion at `:858`-`:885`, and L2
  cross-event invariants at `:1071`-`:1114`. These are not confirmed failures
  without the patch, but they must be treated as blast-radius candidates.

## UNVERIFIED CLAIMS

1. The exact post-change B4 values 0.2880 and 0.2832, because the probe
   implementation and raw output are not committed.
2. The exact three-window L1 values under the final implementation, because
   no committed/final implementation exists; a concurrent prototype diff in
   the shared worktree was outside this review snapshot and was not executed.
3. Whether candidate p53 fixes A, B, C, or D remove all swept violations
   without breaking B4 or L1.
4. Whether the intended 4 m value is actually 4 m after converting the
   normalized `close_down_stop` geometry to metric coordinates.
5. Whether the “exactly four” default test failures is complete; the listed
   golden and P124 tests make that claim doubtful.
6. Whether A1/A2 stay improved, rather than merely shift on the three
   calibration windows, on independent seed windows.
7. Whether the B4 increase represents close, sustained defending rather than
   repeated long-distance approach events. The joint distance/approach
   metrics above would settle this.

## WHAT I'D RE-RUN

1. Apply only the clean reorder: preserve GK and `stalled_unpressed` early,
   call `open_play_shot_engage_hits` for pressed carriers, and pass after a
   miss. Add the press assignment with an explicitly metric 4 m target and
   convergence guard.
2. Add a targeted test/instrumentation proving that a favorable pressed
   NaturalDeadline state enters `open_play_shot_engage_hits`, that its
   continuous pressure term is positive, and that the resulting probability
   is lower but non-zero than the same geometry without pressure. Separately
   assert GK and liveness still pass before the roll.
3. Re-run pristine versus the exact patch on 401..600, 601..800, and
   801..1000, reporting shots, tackles, fouls, pass completion, A1, A2, A3,
   C1, B4 direct, B4 checker, and B4 denominators for every window.
4. Add independent holdout windows (at least 1001..1200 and 1201..1400;
   preferably 1,000+ seeds total) and report per-window spread, not only the
   pooled mean.
5. Sweep the actual metric standoff around the claimed boundary, including
   3.5 through 4.5 in small increments, and collect L1 bands plus absolute
   distance and approach distributions. Include the 20 m counterexample as a
   negative control.
6. Test p53 fixes one at a time over the existing and expanded seed sets,
   checking both endpoint and swept detectors. Require zero violations before
   any rebaseline.
7. Run `cargo test`, the ignored release realism suite, P15, P17A, P124, and
   `npx openspec validate --all --strict`. Then make the golden/model-version
   decision explicit, regenerate only the intended golden set, inspect its
   full diff, and verify same-seed stream hashes on two repeated runs.
