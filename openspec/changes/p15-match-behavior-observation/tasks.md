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

> 接线前先读 `engine/src/observation.rs` 模块头的**接入对照表**（Slice 1 是候选映射，Slice 2 已
> 逐行对照 `lib.rs` 实际控制流复核并改写为**已接线**版）。三条**开球专线**、七条坑仍是理解
> 接线的入口。设计缺口（§14 A9 四条）已在 Slice 2 全部解决并记入 design §15。

- [x] Resolve the §14 A9 design gaps **before** wiring（见 design §15）：`FlightAction` 补 `Kickoff`；
      `RestartEndReason` 补 `SupersededByDeadBall`；门球定为 §6.2 生命周期的**结构性例外**
      （无准备期，专用入口 `goal_kick_started`）；进球路径的准备期**只**由 `kickoff_again` whistle 记一次；
      明确本引擎单段循环无中场休息（`half_time()` 无调用点）。
      **可达性更正（2026-09-23，release-gate 修复）**：`SupersededByDeadBall` 是
      **recorder 层防御性契约，当前生产引擎不可达**（2800 场 / 69,320 条 restart 实测 0 例，
      两条结构性理由见 design §15 A9-2）；文档**不得**再声称「生产已覆盖」。
- [x] 统一重开生命周期（design §15 A9-6）：**硬规则**只有一条——`restart_preparation_started`
      必须有先行 `dead_ball_started`（recorder 侧不再凭空造 sequence，违者记
      `RestartPreparationWithoutScheduledRestart`）；由此 `CornerAward` / 出界角球分支显式先报死球。
      `emit_foul_and_free_kick` 里「观察提交写在 `st.restart_prep` 赋值**之前**」**降级为书写约定**
      （2026-09-24 mutation：调换该行序全量 `cargo test` 仍全绿，**无行为判别力**——见 design §15 A9-6
      第 2 条）；**不得**再把它写成「否则 `SupersededByDeadBall` 永不出现」的因果。
- [x] 重开交付后的 episode `start_reason` 由 recorder 按**开放 restart** 归一（`RestartControl`；
      首开球显式豁免为 `Kickoff`），不再靠调用点的 `Highlight::restart_delivery` 分流
      （那漏掉了角球/门球的落点 pickup）。判别门：
      `restart_delivery_control_start_reason_is_decided_by_the_open_restart`（按 restart kind）、
      `restart_delivery_start_reason_matches_the_restart_kind_on_real_matches`（多 seed 生产路径）、
      `open_play_control_keeps_its_declared_start_reason`（反证：无开放 restart 时不得改写）。
      目标变异（硬编码 `Pickup` / 删归一）实测均红。
- [x] 首开球 sequence 的 `event_indexes` 绑定到正式 `Kickoff` 事件（收束前先绑一次、收束后再绑一次）；
      门：`every_episode_and_restart_object_has_event_indexes_or_a_documented_exception`
      （逐对象断言，两个**有据可依**的例外：流末终场哨开启的 episode、流末被截断在死球里的 restart）。
- [x] Make the tail-compaction boundary **actually registered**（Slice 1 是空实现）：
      `match_events` 在**排空循环之前**先 `note_event_stream_compaction(drain_start)` 登记边界、
      再 `suspend_event_index_binding(true)`，循环后恢复暂停。
      **顺序是有判别力的**：第一版用返回值 `CompactionBoundary` 把边界带到 `match_events`
      **返回之后**才登记——那样排空期全程不受保护、且此后没有任何绑定会去查该边界（装饰性接线，
      审阅实测把 `register` 改成空操作全部测试照旧全绿）。
      守卫：源码 `p15_compaction_boundary_is_actually_registered`（钉住「登记早于排空循环」）
      + 行为 `drain_period_bindings_are_suspended_not_gap_reported`（seed 33 上删掉暂停即产出 gap）。
- [x] Extend `bind_event_index` to a single guarded entry for all targets
      (`EventIndexTarget::{Fact, OpenEpisode, OpenRestart, UnattributedFacts, LastFactOfKind}`)；
      `PossessionEpisode.event_indexes` / `RestartSequence.event_indexes` 不再绕过该接口。
      后两个 target 的存在理由：把「本提交点的全部新事实」与「按 kind 找最近一条」这两类
      查找搬进 recorder，接线层就不必读观察状态（见下一项守卫）。
- [x] Record kickoff/restart and first confirmed control（首开球专线 1 + 进球后开球专线 2）。
- [x] Record pass/interception/lost/tackle/pickup transitions at state commit points.
- [x] Record shot finalize outcomes: goal, saved caught, rebound, off target and out.
- [x] Record foul, out, free kick/throw-in/corner/goal kick and full-time whistle paths.
      **半场不接线**（本引擎无中场休息，见坑 5）。
- [x] `simulate()` 走 `disabled()` recorder；守卫 `p15_recorder_stays_out_of_the_decision_path`
      钉住「recorder 不读状态、不参与决策」：`lib.rs` 生产段**没有任何函数**读 recorder /
      sidecar 的 11 个读方法（除 `obs_bind*` 纯写入族），判据是**显式写入白名单**而非 `obs_` 前缀
      ——前缀豁免曾放过 `obs_restart_open`（读 `obs.restarts()`、被 `finalize_highlight` 调用）。
      **定位更正（2026-09-23）**：这是**回归下限**（封闭字符串清单 + 一层「新增读方法忘了登记」
      的反向覆盖启发式），**不是结构证明**——返回 `Vec<usize>` 之类名字不沾关键词的新读方法仍会
      漏过；接口级隔离是未决事项，见 design §15 A9-7。文档不得再声称「证明所有未来 read 方法
      都被捕获」。
- [x] 事实事件下标归属：`Highlight::obs_event` 承载「产生这次结算的动作事件」，
      `EventIndexTarget::UnattributedFacts` 水位把同一提交点的**全部**新事实绑到同源事件。
- [x] 固定 seed 集成测试（`fixed_seed_sidecar_binds_event_indexes_and_leaves_no_gaps`）：
      0 gap / 0 违规 / 事件下标非空且严格递增。手工 fixture 覆盖门球例外、开球具名、
      superseded 结束原因、水位扫描。
- [x] mutation-test 关键新断言（M1–M12：水位不推进 / 只绑最后一条 / 暂停被忽略 /
      水位目标变空操作 / superseded 退回 Unknown / 门球补记 prep / 开球降级 Unknown /
      边界不登记 / 正式路径启用 recorder）——除两条源码守卫外全部由行为测试抓到。
- [x] 两轮独立审阅的发现全部修复（详见 design §15.2 的实测记录）：
      tackle 的 `obs_event` 在动作事件 push 前取值 → 绑到上一拍 beat；
      `obs_contest_pickup` 在 battle 提交前读 `st.possession` → 100 条事实 team/player 矛盾；
      门球 `taking` 靠 `1 - possession` 反推（无测试区分）；
      决策路径守卫的 `obs_` 前缀豁免可被同名辅助函数绕过；
      压缩边界登记推迟到排空之后 = 装饰性接线；
      排空期暂停只有源码守卫覆盖（现由 seed 33 的行为门补齐）；
      5 处 `unwrap_or(TeamId::Home)` 猜队别全部消除。
- [x] release-gate 修复轮（2026-09-23）：重开交付 `start_reason` 归一（P0）+ 首开球事件下标绑定；
      统一重开生命周期（A9-6：prep 必须有先行死球那条**硬规则**；犯规路径的行序当时被当成硬规则，
      2026-09-24 mutation 否定，已降级为书写约定，见下条）；
      `SupersededByDeadBall` 可达性如实降级为 recorder 层契约（A9-2）；
      逐对象事件下标覆盖门；决策路径守卫定位更正为回归下限（A9-7）；`half_time` 零调用点
      reconciliation（A9-8）；开销口径软化 + 可复现口径测量（A9-9，ignored 测试，纯引擎比值 ~1.03）。
- [x] 第三轮独立审阅（2026-09-24）：无 P0/P1 缺陷；4 条 P2/nit 已修（`SuccessfulReceive`
      不可达原因的更正、短时长截断的合法 gap 来源 + 专门的守卫测试、P1 理由 2 的错误表述、
      `source_event_index` 倒退重绑守卫 `event_index_regressed`）。见 design §15 A9-11。
- [x] 窄范围修复轮（2026-09-24，Release-gate 复审后）：三条**文档因果**更正，**不动生产行为**
      （1）`emit_foul_and_free_kick` 的行序主张：mutation 证明不可观测 → 降级为书写约定，并删去
      「否则 `SupersededByDeadBall` 永不出现」的错误因果（A9-6 第 2 条）；
      （2）「短时长截断才产 `full_time_during_ball_in_flight`」是**错误全称**：实测
      `seed 368 @ dur 400` 在更长时长上同样合法产该 gap（400 seed 里第 2 例），已改写为机制描述 +
      已复核示例（A9-11 第 2 条的更正，§15.5）；
      （3）补 sidecar **event index 时间口径**：死球类 restart 的因果事件可以早于 `restart.start_t`
      （`event_emit` 早于 `state_commit`；实测 80 场 3879 条 restart 中 1923 条绑定事件早于
      `start_t`），下游**不得**要求所有 `event_indexes` 的事件时间落在对象时间窗内（§15.6）。
      **未**新增源码顺序守卫：行序无判别力，为注释顺序加脆弱测试不划算（A9-6 明确记录此取舍）。
- [ ] **未决（下一轮）**：决策路径 guard 的**接口级隔离**（把「读观察状态」收进不对比赛逻辑
      可见的 view 类型），替代当前的名字/签名启发式。见 design §15 A9-7。

## Slice 3 — verification

- [ ] Add fixtures for successful pass, interception, contested loss, loose pickup, shot outcomes, foul and restarts.
- [ ] Assert episode/contest/restart closure and no overlapping active objects.
- [ ] Assert recorder on/off leaves formal events, output bytes and RNG unchanged.
- [ ] Run Rust tests, prototype tests, OpenSpec validation and `./verify.sh`.

## Slice 4 — follow-up

- [ ] Implement #15B `PhaseAnnotator` only after #15A facts are stable.
- [ ] Do not attach set-piece delivery to a possession episode before confirmed open-play control.
