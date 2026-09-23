## Slice 1 — formal observation model

- [x] Define `ControlFactKind`, `ControlFactBasis`, `BehaviorControlState`, `ObservedTime`.
- [x] Define `PossessionEpisode`, `RestartSequence`, `DiagnosticMatch` and recorder ownership rules.
- [x] Add opt-in simulation API without changing `simulate()`.
- [x] Define kind-specific closed-set detail union (`ControlFactDetail` / `ObservationGapReason` /
      `IllegalInput`), with the kind↔detail pairing invariant and `ALL` completeness guards.
- [x] Make `DiagnosticMatch` carry `invariant_violations` + terminal `state`, so an opt-in result's
      quality is checkable after the recorder is consumed.
- [x] Bind `source_event_index` through a guarded `bind_event_index`: rejects indexes inside the
      tail-compaction range (`observation_gap`, no silent mis-binding), rejects out-of-range fact
      indexes with a distinct reason. Tail-compaction boundary documented; its call site marked in
      `match_events`.
      **Scope note (不要读成两级都已完成)**: 本项只完成 `ControlFact.source_event_index` 的
      guarded 绑定契约。`PossessionEpisode.event_indexes` / `RestartSequence.event_indexes`
      **尚未接线**——`bind_event_index` 目前没有写它们的入口，两者保持空数组，Slice 2 需先扩展
      该接口（**不得**绕过它直接下标入数组）。见 design §14 A4。
- [x] Derive the opt-in `full_time` time from the formal whistle event
      (`stream_end_boundary` → `commit_stream_end_boundary`, 后者不接收任何时长参数),
      not from `config.match_duration_seconds`. 判别力由手工构造的 `whistle@123.0` 流保证
      （真实路径上 `whistle.t == config` 恒成立，两个来源观测等价，黑盒测试区分不了）。
- [x] Document the Slice 2 kickoff wiring in the module header: first kickoff has **no flight**
      (engine already carries at t=0 → `restart_taken` + `control_established` together); the
      goal-restart kickoff's `control_established` waits for `kickoff_end`; the `kickoff_again`
      whistle records `restart_preparation_started` and is not a match boundary.

Slice 1 落点：`engine/src/observation.rs`（类型 + recorder）、`engine/src/lib.rs`
（`match_events()` 抽取 + `simulate_with_behavior_observations()`）。
验证：`cargo test`（lib 全绿 + 7 off_ball_demo + realism 含 `gm_canary_seeds` golden）、
`npx openspec validate p15-match-behavior-observation`。
**注意**：本 slice 的 opt-in API 只提交比赛生命周期端点（`match_started` + 开球自身的
`restart_preparation_started` / `match_ended`），引擎提交点接入是 Slice 2
（对照表见 `observation.rs` 模块头）。
**未接线的事实（Slice 2 别当成已完成）**：
- **尾部压缩边界没有真的登记**：`lib.rs` 的 `events_note_compaction_boundary` 当前是**空实现**
  （`match_events` 拿不到 recorder 句柄），所以生产 opt-in 路径上 `stable_event_prefix` 恒为
  `None`（= 全部下标视为稳定）、`bind_event_index` 的拒绝分支**在生产路径上不会触发**——
  它只在测试里被真边界验证过。Slice 2 要在排空期绑定下标，必须先接通该登记点。见 design §14 A4.1。
- **`episode/restart` 的 `event_indexes` 未接线**（见上面 Slice 1 第五条 scope note）。
- **`match_started` 的时间 basis 当前是 `event_emit(0.0)`**；若 Slice 2 改为 `state_commit`，
  须同步更新调用点、模块头对照表与 `match_started_time_basis_is_event_emit_at_zero`。见 §14 A3.1。

**设计增量已同步进权威 addendum**：`.scratch/notes/match-behavior-observation-design.md` §14
（detail 闭集联合、`originating_team: TeamRef`、`match_started` 兼记
`restart_preparation_started`、`match_started` 时间 basis、事件下标绑定规则 + 边界登记现状、
sidecar 质量字段、终场时间来源、矛盾输入免检边界、时间不可得 vs 算错）。
**设计缺口待确认**（§14 A9，已在 `observation.rs` 就地标注）：`FlightAction` 闭集无 kickoff 成员；
`RestartEndReason` 闭集无「被新死球顶掉」成员；门球 `start_goal_kick` 无准备期。

## Slice 2 — engine integration

> 接线前先读 `engine/src/observation.rs` 模块头的**接入对照表**（含 5 条已知疑问）。
> 其中两条会直接改变本 slice 的范围：**本引擎没有中场休息**（无下半场开球提交点，`half_time()`
> 暂无用武之地）；**门球（`start_goal_kick`）没有准备期**，与 design §6.2 的统一生命周期冲突，
> 需先确认例外再接线。

- [ ] Record kickoff/restart and first confirmed control.
- [ ] Record pass/interception/lost/tackle/pickup transitions at state commit points.
- [ ] Record shot finalize outcomes: goal, saved caught, rebound, off target and out.
- [ ] Record foul, out, half-time, full-time and whistle interruption paths.

## Slice 3 — verification

- [ ] Add fixtures for successful pass, interception, contested loss, loose pickup, shot outcomes, foul and restarts.
- [ ] Assert episode/contest/restart closure and no overlapping active objects.
- [ ] Assert recorder on/off leaves formal events, output bytes and RNG unchanged.
- [ ] Run Rust tests, prototype tests, OpenSpec validation and `./verify.sh`.

## Slice 4 — follow-up

- [ ] Implement #15B `PhaseAnnotator` only after #15A facts are stable.
- [ ] Do not attach set-piece delivery to a possession episode before confirmed open-play control.
