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
- [x] mutation-test 关键新断言（**Slice 2 编号 S1–S9**：水位不推进 / 只绑最后一条 / 暂停被忽略 /
      水位目标变空操作 / superseded 退回 Unknown / 门球补记 prep / 开球降级 Unknown /
      边界不登记 / 正式路径启用 recorder）——除两条源码守卫外全部由行为测试抓到。
      （编号加 `S` 前缀避免与 Slice 3 的 `M1–M6` 混淆：**两节的编号各自独立起算**，原先都写
      「M1–M12」/「M1–M6」曾让同一文档里出现两组同名标签。）
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

> 落点：`engine/src/observation.rs` 的 `#[cfg(test)]` 尾部新增 8 条**手写路径 fixture**
> （「Slice 3：全路径手写 fixture 覆盖矩阵」一节）；`engine/tests/p15_behavior_observation.rs`
> 为**新增的集成门文件**（**11 条默认** + 1 条 ignored 校准门；第 5 轮修复新增 2 条
> **接线层**门，见下「接线层断言」）。
> 本 slice **不改生产行为**（golden-v6 逐字节不变，见下第 3 条），只把此前散在临时审阅 harness
> 里的证据固化成仓库内可重复的门。

- [x] Add fixtures for successful pass, interception, contested loss, loose pickup, shot outcomes,
      foul and restarts.
      **清单 → 断言映射**（`Slice 3：全路径手写 fixture 覆盖矩阵` 一节）：
      | 清单项 | 落点 |
      |---|---|
      | successful pass | `same_team_receive_continues_episode_without_new_boundary`（既有，续接 episode 不断边界） |
      | interception | `interception_starts_a_loose_contest_then_same_tick_pickup_opens_the_new_episode`（**新增**：`InterceptionLoose` 此前**无任何 fixture 走它**，只在枚举完整性测试里出现） |
      | contested loss | `lost_pass_closes_episode_and_enters_contest`（既有，`PassLost`） |
      | loose pickup | 同 interception / tackle 两条的拾取段（`contest_ended(Pickup)` + 新 episode） |
      | tackle success but loose | `tackle_success_opens_a_loose_contest_before_anyone_has_control`（**新增**：此前 `TackleLoose` 只被半场哨测试借用） |
      | shot goal | `shot_outcome_closes_episode_with_its_own_reason`（既有，goal 分支） |
      | shot saved caught | 同上（saved_caught 分支） |
      | shot saved rebound | `shot_saved_rebound_closes_episode_and_opens_a_rebound_contest_with_matching_reason`（**新增**：episode 结束原因与争抢原因**同名不同义**，配错会污染按原因聚合） |
      | shot off target | `shot_off_target_ends_the_episode_as_out_and_takes_a_goal_kick_without_preparation`（**新增**） |
      | foul → free kick | `foul_opens_a_free_kick_with_explicit_preparation_then_delivery_restores_open_play`（**新增**：此前 `Foul` 只作为「第二个死球」出现，没有完整链路） |
      | out → throw/corner/goal kick | `out_of_play_restarts_carry_their_own_team_kind_and_lifecycle_shape`（**新增**：三种重开的**生命周期形状不同**——门球无准备期） |
      | first kickoff / goal-restart kickoff | `first_kickoff_has_no_flight_while_a_goal_restart_kickoff_waits_for_the_flight_to_end`（**新增**：两条开球专线形状不同，判别力在 `DeterministicFlightEnd` 与 `RestartControl` 归一） |
      | full-time | `full_time_closes_every_open_object_including_unfinished_flight`（既有）＋ 集成门 `terminal_state_invariants_and_closure_hold_on_the_canary_seeds` |
      | whistle interruption gap | `whistle_interrupt_is_a_gap_only_when_the_ball_was_in_flight`（**新增**：同场区分「必须产 gap」与「必须不产 gap」两种哨声语境） |
      | **half-time** | **未交付，且不虚构 fixture**：本引擎无中场休息（单段循环 `while t < dur`），`half_time()` 零生产调用点（design §15 A9-5 / A9-8）。它目前只由**未使用契约测试** `half_time_closes_contest_and_terminates_restart_without_sequencing` 覆盖。**中场休息的接线延后到引擎真的引入生产提交点**，届时才可能写半场 fixture。 |
      **⚠️ 上表全部是 recorder 单元 fixture——它们不覆盖 `lib.rs` 的接线。** 第 5 轮修复发现：
      这些 fixture 直接调 `contest_started(..)` / `goal_kick_started(..)`，**从不经过 `lib.rs`**，
      因此 `lib.rs` 的接线变异（提交点传错 reason / 换错命令）对它们**完全不可见**。
      早先有几条 fixture 的文档注释写「改 `lib.rs` 某处 → 本 fixture 必红」，实测**为假**
      （`TackleLoose→ShotRebound`、`InterceptionLoose→PassLost`、kickoff basis 三个变异下，
      7/7 fixture 全绿）。该错误文案已删除，并改为显式区分「recorder 级变异（本 fixture 捕获）」
      vs「接线变异（集成门捕获）」。
- [x] **接线层断言（第 5 轮修复新增，补上 recorder 单测的结构盲区）**：
      `engine/tests/p15_behavior_observation.rs` 新增 2 条走 `simulate_with_behavior_observations`
      真实 opt-in 路径的门——**这是本 change 唯一覆盖 `lib.rs` 争抢/开球接线的层**。
      | 门 | 覆盖 | 施加于 `lib.rs` 的目标变异 → 结果（已实测） |
      |---|---|---|
      | `contest_reasons_and_settlements_are_bound_to_their_own_engine_events` | **全部 5 个**引擎可达的 `ContestStartReason` 的：①事实绑定的**引擎事件**（`interception_loose`→`Pass/intercepted`、`pass_lost`→`Pass/lost`、`tackle_loose`→`Tackle/success`、`shot_rebound`→`Shot/saved`、`delivery_loose`→`Pass/contested`）；②同刻关闭的 episode `end_reason`（前四类**恰好 1 条**：`ControlLost`×3 + `ShotRebound`×1；`delivery_loose` 条数**不约束**（实测 204 条里 194 条同刻 0 条关闭），但凡有同刻关闭的 `end_reason` 必须为 `ControlLost`——末刻的截断形态除外）；③**紧邻下一条事实**必为 `contest_ended` 且收束原因 ∈ {`Pickup`, `MatchEnd`} | `TackleSuccess` 的 `TackleLoose→ShotRebound`：✅ 红（`"shot_rebound" 绑定到了 Tackle 事件，期望 Shot`）；`PassIntercepted` 的 `InterceptionLoose→PassLost`：✅ 红（result = intercepted，期望 lost）；`ShotSavedRebound` 的 `EpisodeEndReason::ShotRebound→ControlLost`：✅ 红（`episode 51 end_reason = ControlLost，期望 ShotRebound`）；**角球/门球/解围交付** 的 `DeliveryLoose→PassLost`（3 处一起改）：✅ 红（`"pass_lost" 绑定的 Pass 事件的 result = contested，期望 lost`）；**角球交付点的 `EpisodeEndReason::ControlLost→ShotRebound`**：✅ 红（`"delivery_loose" 关闭的 episode 91 end_reason = Some(ShotRebound)，期望 ControlLost`） |
      | `kickoff_flight_basis_separates_first_kickoff_from_a_goal_restart` | 首开球**无飞行**（`taken_t` 与 `open_play_resumed_t` 都是 `EventEmit`**且同刻**，且**首个 episode 整段**（实测 canary 跨度 16–144s、300 seed 10–360s）内 0 条 `DeterministicFlightEnd` 事实）vs 进球后开球**等飞行结束**（`open_play_resumed_t.basis == DeterministicFlightEnd`，且恢复时刻 > taken 时刻） | `advance_dead_ball` 的 `kickoff_end` 处理里 `ObservedTime::flight_end → state_commit`：✅ 红（`恢复 basis = StateCommit，期望 deterministic_flight_end`） |
      **样本集**：`CONTEST_SEEDS` = canary 10 + `[24, 38, 49, 80, 84]`（`shot_rebound` 300 seed 仅 35 条、
      canary 里只有 seed 15 有 1 条，故显式补 5 个种子使该行不空转；防空转断言：
      `shot_rebound >= 4`、`pass_lost >= 50`、合计 `>= 500`、`pickup >= 500`、`match_end >= 1`——
      下限都**留余量**（实测 6 / 96 / 735 / 733 / 2），不写成「恰好等于实测值」）。
      门**只加一次** seed 模拟（15 场 ≈ +6s debug），默认门总耗时从 ~20s 变为 ~29s。
      **豁免判据不是「放松断言」**：事实未绑定 / 同刻闭合多条 episode 的唯一合法例外是「对象在流截断
      时刻才被创建」（`dur` 时刻的排空期，`lib.rs` 已 `suspend_event_index_binding(true)`，
      design §15 A9-10）——实测 300 seed 里未绑定 9 例（全部 5 类；收敛到 4 个非交付类为 4 例）、
      同刻关闭 ≠1 条 3 例，**全部 `t == 尾哨`**，故断言按「非截断时刻必须满足」写。
      **门内种子上该豁免确实触发**（实测 15 个门内种子里 3 条未绑定 + 3 条末刻同刻关闭，
      全部 `t == 尾哨`）——所以「豁免不吞缺陷」**不能**靠「门内 0 例」来论证，只能靠
      **豁免范围**：它只放行 `t == 尾哨` 这一种形态，非末刻一律判红（且已实测：非末刻的
      `delivery_loose` `end_reason` 变异会让门变红）。
      **收束取法（第 5 轮审阅后改正）**：取**紧邻的下一条事实**（要求它必为 `contest_ended`），
      而不是「其后第一条 `contest_ended`」——后者在「本次争抢未收束、更晚某次收束了」时会让
      `and_then` 拿到**别人的**收束事实，从而把「争抢悬空」这条缺陷静默吞掉（可掩盖的假绿）。
      「紧邻下一条必为 `contest_ended`」是 recorder 状态机性质（实测 300 seed / 15,743 条争抢零反例）。
      **覆盖归属如实记录**：这些接线变异由**集成门单独**捕获——`src/observation.rs` 的
      7 条相关 fixture 在前 3 个变异（`TackleLoose` / `InterceptionLoose` / kickoff basis）
      下**全部保持绿**（已实测；其余 3 个同属 `lib.rs` 接线变异，机制相同——fixture 自己传
      reason / basis，读不到 `lib.rs` 的提交点）。故**不得**再把这些变异记录成「fixture 的
      判别力」，也不得把本门写成「fixture 判别力的补充证明」——它是**唯一**的覆盖来源。
      **P1 覆盖转交缺陷（第 5 轮审阅发现并修复）**：本门初版把 `delivery_loose` 用一行注释
      「转交」给 `restart_kind_decides_the_delivered_episode_start_reason`，而**那条门只读
      `restart_sequences` / `possession_episodes`、不读 `control_facts`，对 `delivery_loose`
      零断言**——于是 `delivery_loose`（`lib.rs` 3 个接线点、门内 204 条事实）在**整个
      `tests/` 目录无人断言**，而注释声称它被覆盖。这与本票要修的原始缺陷**同类**（假覆盖声明）。
      已改为真正断言它（并加 `DeliveryLoose→PassLost` 变异证明判别力）。
      **第二轮审阅又发现两处（同批修复）**：
      ① `delivery_loose` 的 `EpisodeEndReason` 参数（3 个交付点）当时**仍然零断言**——把三者一起
      改成 `ShotRebound` 时 7 条 episode `end_reason` 漂移，而集成门 + 全量 `--lib` **都全绿**。
      已把「条数不约束」收紧为「**有同刻关闭则 `end_reason` 必须为 `ControlLost`**」
      （`Closing::AnyCountButReason`），并加防空转断言（非末刻同刻关闭 ≥1 条，实测 7 条）
      + 变异证明红。② 本票**仍有一处已知缺口**（如实记录，不转交假门）：`DeadBallReason`
      的集成断言在 `tests/` 里**完全不存在**——把 `lib.rs` 唯一的犯规死球点 `DeadBallReason::Foul`
      改成 `OutSideline`，集成门与全量 `--lib` **都全绿**。`observation.rs` 的犯规 fixture
      原先写「由两条集成门共同覆盖」，而那两条门都不读 `DeadBall` 事实——**假覆盖声明**，
      已改为明确标注缺口。补它需要新增 `DeadBall` 事实的集成门，**不在本 slice 范围内**。
      **同类的已知缺口还有一条（第 5 轮自查发现，如实记录）**：`EpisodeEndReason` 的**取值**
      在集成层基本无人断言。已实测的存活变异：把 `obs_goal_kick_delivered` 的
      `EpisodeEndReason::Out` 改成 `SavedCaught`（门球路径的 episode 收束原因）→ 集成门 11 条
      **全绿**。两条曾被 `observation.rs` 的 fixture 注释写成「覆盖这一面」的门都不查取值：
      `restart_kind_decides_the_delivered_episode_start_reason` 读 `start_reason`、
      `terminal_state_invariants_and_closure_hold_on_the_canary_seeds` 只断言
      `end_reason.is_some()`。该假覆盖声明已删除、改为明确标注缺口。
      **共性**：本门只钉了**争抢类** reason 与**首开球 basis**；`EpisodeEndReason` /
      `DeadBallReason` / `RestartEndReason` 的**取值**仍主要靠 `src/observation.rs` 的手写
      fixture（= recorder 级，接线变异不可见）。若要收口，应新增按**值**断言的集成门——
      这是本 slice 之外的工作量，**不得**用「某条门覆盖了」轻描淡写地结清。
- [x] Assert episode/contest/restart closure and no overlapping active objects.
      `terminal_state_invariants_and_closure_hold_on_the_canary_seeds`（10 canary seed）：
      ① 每个 episode 闭合且 `end_reason` 齐备、`end_t >= start_t`、有事实；
      ② 每个 restart 闭合；③ episode 之间按 `(start_t, id)` 严格递增且前一条 `end_t` 不晚于
      下一条 `start_t`（**不重叠**）；④ episode 起点**不落在**任何未收束 restart 的活跃窗口内
      （**episode 与 restart 不重叠**）；⑤ 首开球 episode 的 basis 是 `event_emit`、首开球
      sequence 事件下标非空。防空转断言要求 canary 集合产出 ≥200 episode / ≥100 restart。
      **用 `(start_t, id)` 而非只比 `start_t`**：`restart.open_play_resumed_t` 与 episode 的
      `start_t` 由**同一次 `control_established`** 提交，时刻可以相等；实测 150 seed 里同刻
      restart/episode 各 0 例，但断言不依赖这个巧合。
      另加 `restart_end_reasons_stay_within_the_two_reachable_ones`（结束原因只在可达的两值内）。
- [x] Assert recorder on/off leaves formal events, output bytes and RNG unchanged.
      **RNG 面只有「间接证据」——如实记录，勿退回「更强/直接证明」的旧说法。**
      ① `recorder_on_and_off_reproduce_the_golden_v6_canary_stream`——把结果锚到**磁盘上的
         golden-v6 基线**（seed 1..=10，与 `tests/realism.rs::GOLDEN_SEEDS` 同一集合），
         正式路径与 opt-in 路径的事件流 FNV-1a 都必须等于基线 `stream_hash`。
         **这是独立来源的对照**：只比「两条路径互相比」理论上可被「两边都错成一样」骗过。
      ② `plain_and_opt_in_paths_agree_byte_for_byte`——`simulate()` vs `events_json()` 逐字节，
         含 `dur 120` 的**截断 regime**（事件流形状最不一样处）。
      ①②合起来就是 RNG 面的全部证据形态：**正式事件流逐字节相同（且锚到磁盘 golden）**。
      决策全由 RNG 驱动，消费点一变决策就变、事件流随即不等，故这是**强间接证据**；
      但它**不是**对 raw RNG 的直接观测。
      **真正限制（2026-09-24 校正，勿再写错理由）**：比赛自己的 rng 是 `match_events` 的
      **局部变量、函数返回即丢弃**，外部**拿不到「这场比赛消费了多少 / 消费后游标在哪」**。
      `SeededRng` **是导出的**——`lib.rs` 有 `pub use rng::SeededRng;`，「类型拿不到 / `mod rng`
      私有」是**错的**理由；即便拿到类型，也只能新建一个从头开始的序列，与那场比赛无关。
      因此：**没有** raw RNG cursor / sequence 的可观察证据工件，也不得再引入「beat 序列是 RNG
      消费的满射代理」这类**看起来更强、实际与逐字节门完全重复**的代理断言（已删，见下）。
      ③ `sidecar_is_deterministic_for_the_same_seed_and_config`——同 seed 的 sidecar（含
         **events 本身**）完全一致；覆盖 events 而不只是三个对象数组，否则两边 events 不同长时
         只比下标数组会双双通过而掩盖错位。
      **⚠️ 本条清单下的三处旧表述已被更正（2026-09-24，均为「结论对、机制错」或「叙事过强」）**：
      | 旧表述（错） | 更正 |
      |---|---|
      | `SeededRng` 未导出 / `mod rng` 私有 → 集成层拿不到 rng 原始序列 | 类型**是**导出的（`pub use rng::SeededRng`）。真限制是**比赛 rng 是 `match_events` 局部变量、返回即丢弃**，消费位置不可观测。 |
      | 集成门 `recorder_on_and_off_consume_the_same_rng_sequence` 是「RNG 消费的满射代理」，这条是「design §13 门 5 的 RNG 面」 | **已删除**：它比的是 `simulate(seed)` vs `observed(seed).events_json()`——与 ② **逐字节完全重复**，却把结论叙述成「RNG 消费被证明一致」，属**误导性叙事**；且「满射代理」不成立（rng 消费可在不改变 beat 序列的位置发生）。RNG 面证据改为只由 ①② 承载。 |
      | `src/observation.rs::recorder_on_off_consumes_identical_rng` 是「design §13 的**更强**版本、比 RNG 原始输出」 | **实测是 tautology**：改成跑 `seed + 1` 的另一场比赛仍全绿。根因：`draw()` 每次 `SeededRng::new(seed)` 从头抽，而比赛 rng 返回即丢弃，故「跑完再抽」永远是同一个从头序列，相等**构造使然**。已**改名**为 `rng_draw_helper_is_seed_dependent_and_skip_sensitive`，只测 helper 自身的 seed 依赖 + `skip` 敏感性，**不再声称比较 on/off recorder**。 |
      **处置原则**：**不改生产签名**（要让某层直接比 raw 序列，得先让 `match_events` 接受外部注入
      的 rng——那需要真实需求，不是为测试放宽可见性）。**本条与「不得把启发式 guard 当结构证明」
      同类：把一条自我确认的测试写成证据，比没有测试更危险。**
- [x] Run Rust tests, prototype tests, OpenSpec validation and `./verify.sh`.
      实测结果与**成本**（2026-09-24，本分支；命令原样可复跑）：
      | 门 | 命令 | 结果 | 耗时 |
      |---|---|---|---|
      | Rust targeted | `cargo test --test p15_behavior_observation` | ✅ **11 passed** / 1 ignored（第 5 轮修复新增 2 条接线门） | ~21s（debug） |
      | Rust 全量 | `cargo test` | ✅ 219+7+9+4 passed、0 failed（第 4 轮） | ~12m（debug，本机实测；见下「最终整跑」） |
      | Rust 全量（**最终整跑**，第三轮修复后） | `cargo test` | ✅ **exit 0**：`219 passed`（lib）/ `7 passed` / `9 passed + 1 ignored`（p15）/ `4 passed + 9 ignored`（realism）/ `0`（doc）——五次 `test result: ok`，0 failed | 376s + 69s + 32s + 243s ≈ 12min（debug） |
      | 300-seed 校准 | `cargo test --release --test p15_behavior_observation -- --ignored --nocapture` | ✅ 300 场 × 5400s：facts 331,966 / episode 26,429 / restart 14,476 / gap 0 | **~14s（release）**；debug ~110s |
      | prototype Node | `node --test tools/behavior-observer-prototype.test.mjs` | ✅ 6 passed | ~0.12s |
      | OpenSpec | `npx openspec validate p15-match-behavior-observation --strict` | ✅ valid | <1s |
      | `./verify.sh` | `./verify.sh` | ✅ **EXIT=0，六步全过** | **~11min**（整跑，见下） |
      **`./verify.sh` 完整实测（2026-09-24，本机整跑，非分步替代）**：`./verify.sh` 因超过前台
      10 分钟上限而以 `run_in_background` 跑完，**退出码 0、末行「全部验证通过」**。逐步结果：
      ① `cargo test` 全绿（含本 change 的 `p15_behavior_observation` target）；
      ② viewer `node --test` 298/298；③ tools `node --test` 410/410；
      ④ wasm 端到端 `E2E v2 OK`（5822 事件、4 seed 无 snap）；⑤ P34 同队间距滑窗各 seed
      `player_overlap findings=0`；⑥ `realism --release -- --ignored` 9 passed / 0 failed。
      **跑前先做了两件事**（否则第 4/5 步验证的不是本分支）：
      ① **从本分支重建 `viewer/engine.wasm`**——该文件被 gitignore，且其现有副本构建于
         **2026-09-22（P15 之前）**；不重建则第 4/5 步跑的是旧引擎（`CLAUDE.md` 的
         worktree 备忘也记了「engine.wasm 必须从本 worktree 重建」）。
      ② 确认 `node_modules/jsdom` 在位（否则第 2 步会以模块解析失败整体挂掉）。
      **未为了 P15 修改 `engine/tests/realism.rs:475` 的 pre-existing clippy error**
      （`clippy::nonminimal_bool`：`kx >= 0.0 && kx >= 0.15` 恒真）——**已核实在 HEAD 上就存在**
      （`git show HEAD:engine/tests/realism.rs` 同一行），与本 change 无关，按任务要求不顺手修改；
      `cargo clippy --all-targets` 因此在本仓库**当前即为 red**，这不是 P15 引入的回归。
      本 change 新增/改动的两个文件（`tests/p15_behavior_observation.rs`、
      `src/observation.rs` 的测试段）**clippy 干净**（新文件 0 warning/error）。
      **校准落盘**：`engine/target/p15-calibration/300-seed-90min.json`（**不进版本库**——它是
      可复现的运行产物，权威口径是脚本本身 + 断言；提交进仓库只会制造一份会漂的副本）。
      **`lib.rs` 保持逐字节未改**：本 slice 全部改动落在**测试侧**（`src/observation.rs` 的
      `#[cfg(test)]` 段 + 新测试文件 + 本 tasks 文档）；生产源代码（`lib.rs`、
      `observation.rs` 的非测试部分）**零改动**——`sha256(lib.rs)` = `672a39ea…`，与
      `git show HEAD:engine/src/lib.rs` 逐字节相同。这也是「不改变比赛生成行为和 observation
      语义」这条约束的机器化证据。
      **mutation 判别力**（M1–M4 各对应一类断言，M5 是本轮补的 release-gate 原因校验，M6 是本轮
      保真修复的加固验证；除 M4① 的**反面记录**外均已实测变红）：
      | # | 变异 | 目标断言 | 结果 |
      |---|---|---|---|
      | M1 | `full_time` 里删掉 `close_episode`（+ 静默禁用 `into_diagnostic_match` 的 `invariant_violations` 求值，否则自检先红、看不到 closure 断言本身的判别力） | `terminal_state_invariants_and_closure_hold_on_the_canary_seeds` 的「episode 未闭合」 | ✅ 红：`seed 5：episode 86 未闭合`；ignored 校准门同时红 |
      | M2 | 删掉 `control_established` 的交付控制归一 | `restart_kind_decides_the_delivered_episode_start_reason` | ✅ 红：`seed 1：restart 1（FreeKick，t=80）交付后的 episode 2 start_reason = successful_receive（期望 restart_control）`；`src` 侧两条 fixture 同时红 |
      | M3 | `EventIndexTarget::OpenEpisode` 分支改为不写下标 | `event_indexes_are_non_empty_monotonic_and_in_range` 的「非空 / 仅截断例外」 | ✅ 红：`seed 1：episode 0（start_t=0）无事件下标，且不在流截断时刻`；ignored 校准门同时红 |
      | M4（额外，本 slice 自查） | `simulate()` 改成跑 `seed + 1` 的另一场比赛 | ① `src` 层 `recorder_on_off_consumes_identical_rng`（今名 `rng_draw_helper_is_seed_dependent_and_skip_sensitive`） ② 集成层 `recorder_on_and_off_consume_the_same_rng_sequence`（**已删除**） | **① 全绿 → 暴露既有 tautology**：该测试与「哪场比赛」无关，故已**降级改名**为纯 helper 检查；**② 当时红 → 证明它只是在重复逐字节门的后果**，且其「满射代理 / RNG 消费」叙事不成立，故**已删除**。二者处置见上一条「三处旧表述更正」。 |
      | M5（本轮修复，**release gate 的原因校验**） | 在 `simulate_with_behavior_observations` 里给**非 canary seed 250** 注入一条 `MissingStreamEndBoundary` gap（只在该 seed） | `l3_300_seed_90min_calibration_lands_evidence_on_disk` 的**逐条原因分类**（`check_gaps_are_allowed`） | ✅ 红：`seed 250 @ dur 5400：gap 原因 Some(Gap(MissingStreamEndBoundary)) 不在允许集`。**关键对照**：同一变异下把分类调用换成 `gaps += dm.gap_count()`（即只留 `gaps <= 5` 量级守卫）→ 门**全绿**（`gaps=1 [(250, 1)]`）——证明「分类校验」是承重的，量级守卫**不能**替代它（修复前该 release gate 正是这个盲区） |
      | M6（本轮加固验证，防止 fixture 保真修复**削弱**判别力） | 再次施加 M2（删掉 `control_established` 的交付控制归一） | `out_of_play_restarts_...` + `restart_delivery_control_start_reason_...` + **`foul_opens_a_free_kick_...`** | ✅ **三条全红**：`Corner ... 原始值 Pickup 不得直接落到 episode`、`ThrowIn ... 原始入参 SuccessfulReceive 不得成为 episode 的 start_reason`、**`foul_opens ... 任意球交付的原始入参 SuccessfulReceive 必须被归一成 RestartControl`**。**意义**：改传各重开的**真实生产原始值**后判别力**未削弱**；且第三条是第三轮审阅发现的**恒真断言**（修复前在 M2 下**全绿**），修复后判别力**从 0 恢复到与另外两条一致**——这条变异同时证明了「保真修复是加固而非放宽」与「恒真断言已被消除」 |
      M1 的**记录价值**：自检（`invariant_violations`）与结构断言（closure）在本仓是**分层**的，
      M1 单点变异时自检先红，说明结构断言不是自检的重复实现——用 M1+M1b 两点变异才显出它的
      独立判别力。
      **变异后源码已复原（口径修正，2026-09-24 审阅后）**：`src/lib.rs` 的 sha256 =
      `672a39ea…`，与 HEAD 的 blob **逐字节相同**（它是 P15 唯一**未**被本 slice 改动的源码；
      M5 变异即施加在此文件，复原后 `git diff src/lib.rs` 为空）。`src/observation.rs` 则
      **不可能**与 HEAD 相同——本 slice 在其中新增了 600+ 行测试，故正确的复原判据是
      「**与本 slice 工作树的改动前内容一致**」（即只剩 Slice 3 的测试增量），而不是「等于 HEAD」。
      早先一句「两个文件都复原为与 HEAD 一致」把 `observation.rs` 也写进去了，属**错误陈述**
      （审阅指出）：该文件在 HEAD 的哈希是 `6adc4c50…`，与工作树的天然不同。
      **最终哈希（2026-09-24，第 5 轮修复收尾时实测）**：`src/lib.rs` = `672a39ea…`（= HEAD，
      未改）；`src/observation.rs` 工作树 = `998fea7e…`；`git show HEAD:engine/src/observation.rs`
      = `6adc4c50…`。生产前缀（`#[cfg(test)]` 之前，HEAD 行 1..2771）在两侧 sha256 均为
      `4018ae6e…`——这是「生产源码零改动」的**逐字节**证据（比只比整文件哈希更强：整文件哈希
      因测试增量必然不同）。
      ⚠️ **工作树哈希会随每轮修复而变**（历轮出现过 `ed39c8d1…` / `919d7398…` / `78b19152…`）——
      它是当时的快照，不是不变量。**不变量**是上面那条「生产前缀两侧同哈希」，核验时以它为准。
      **第 5 轮（测试修复会话）实测**：`cargo test` exit 0（lib `219 passed`、p15 `11 passed + 1 ignored`、
      realism `4 passed + 9 ignored`、doc `0 passed`）；`cargo test --release --test p15_behavior_observation
      -- --ignored --nocapture` 300 场 × 5400s 绿（facts 331,966 / episode 26,429 / restart 14,476 / gap 0，
      14.5s）；`node --test tools/behavior-observer-prototype.test.mjs` 6 passed；
      `npx openspec validate p15-match-behavior-observation --strict` valid；`git diff --check` 干净。
      **6 个**接线变异（`TackleLoose→ShotRebound` / `InterceptionLoose→PassLost` / kickoff
      `flight_end→state_commit` / `ShotSavedRebound` 收束原因 `ShotRebound→ControlLost` /
      `DeliveryLoose→PassLost`（3 处一起改）/ 三个交付点的 `delivery_loose` `EpisodeEndReason`
      `ControlLost→ShotRebound`（3 处一起改））**全部使集成门变红**（终版 6/6 全红复核通过，
      每轮变异后 `lib.rs` 逐字节复原为 `672a39ea…`），
      同批变异下 `src/observation.rs` 的 7 条相关 fixture **全部保持绿**（第 5 轮复核）；7 个 recorder 级变异
      （施加在 fixture 自己的调用上）**全部使对应 fixture 变红**。每轮变异后 `lib.rs` 逐字节复原
      （脚本核验 sha256 回落到 `672a39ea…`）。
      **独立审阅的发现与处置（2026-09-24，第三轮之后的 Slice 3 审阅）**：审阅结论无 P0/P1 断言
      缺陷，但发现 1 条 P1 **文档错误** + 4 条 P2，全部已修（**修的是记录与 fixture 保真度，
      不是断言**）：
      | # | 问题 | 处置 |
      |---|---|---|
      | P1 | 我写「集成层拿不到 RNG 原始序列，因为 `mod rng` 私有、`SeededRng` 未导出」——**理由错**：`lib.rs` 有 `pub use rng::SeededRng;`，类型是导出的（审阅实测 `fm_engine::SeededRng::new(42)` 在集成测试里可编译可跑）。**结论对、机制错**，正是本票 §15 A9-11 #1 修过的同一类错误。 | 理由改写为真实原因：比赛 rng 是 `match_events` 的**局部变量、返回即丢弃**，外部无法观测消费位置；并在集成测试模块头写入「RNG 面只有间接证据」。 |
      | P2 | 我从 tasks 里写「两个文件都复原为与 HEAD 一致」——`observation.rs` **不可能**与 HEAD 相同（本 slice 在其中新增了测试）。 | 改为「`lib.rs` 与 HEAD 逐字节相同；`observation.rs` 的判据是只剩 Slice 3 增量」，并把两个真实哈希写进记录（见上）。 |
      | P2 | `shot_saved_rebound_...` fixture 的拾取用 `ControlChange` 并断言它——引擎在这条路径（`ShotSavedRebound` → `advance_loose`）**传的是 `Pickup`**，`ControlChange` 是 `ShotSavedCaught` 的值。**fixture 测的是引擎不产生的值**。 | 改为 `Pickup` + `prior_episode_end = ControlLost`（与 `lib.rs` 的 `obs_control_from_loose` 一致），并加一条 `contest_ended(Pickup)` 断言。 |
      | P2 | `foul_opens_...` fixture 的死球 basis 传 `FinalizedOutcome`——引擎 `emit_foul_and_free_kick` 传 `EngineState`（犯规不是高亮结算产物）。无断言读 basis，故是**未记录的值不符**。 | 改为 `EngineState`，并在注释里写明「犯规是状态提交点上的事实，不是高亮结算」。 |
      | P2 | `first_kickoff_...` fixture 把进球后开球交付的入参注释成「生产实际传的原始值」，但引擎传的是 `RestartControl`（`SuccessfulReceive` 是 `PassCaught` 的值）。 | 注释改写：注明真实值，并说明**故意**传更弱的 `SuccessfulReceive`——这样「删掉交付归一」时本行会红（传真实值反而会让该变异存活）。 |
      | P2 | closure 门的「episode 不落在 restart 窗口内」判据是**单向**的（只抓窗口**内部开始**，抓不到「窗口前开始、窗口内结束」）。 | 标注为**判据边界**（今天不可达，因为 `dead_ball_started` 在同一 `t` 关掉开放 episode），并写明将来引擎放宽时须补成双向；**不得**声称本门证明「任意形态的重叠都不存在」。 |
      | P2（第二轮修复） | `out_of_play_restarts_...` fixture 对**三种重开都传同一个交付入参** `Pickup` + `EngineState`，注释写「生产实际传的原始值（角球/门球走 pickup）」——但**界外球生产实际走 `emit_throw_in` 的 `PassCaught` → `SuccessfulReceive` + `FinalizedOutcome`**，可见 `lib.rs`。混用会掩盖「界外球与角球/门球在交付路径上不同」这一事实。 | 把入参按重开方式参数化并对齐生产：**界外球** `SuccessfulReceive`+`FinalizedOutcome`；**角球/门球** `Pickup`+`EngineState`；注释改写真值来源（`PassCaught` 分支 vs `advance_loose` 拾取分支）。三条仍断言最终归一为 `RestartControl`。 |
      | P2（第二轮修复） | 集成测试模块头的能力表**漏列两条实际存在的测试**（`every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`、`restart_end_reasons_stay_within_the_two_reachable_ones`），且默认测试条数写成 10（实为 9）。 | 补齐两行、条数改为 9；并补模块头「RNG 面只有间接证据」的口径纪律条目。 |
      | **P1 断言缺陷（第三轮独立审阅发现，最高价值的一条）** | `foul_opens_a_free_kick_...` 的**交付入参**传 `EpisodeStartReason::RestartControl`（**已归一后的结果值**）+ `EngineState`，而 `emit_free_kick` 与界外球同机制走 `PassCaught` → 生产实际传 `SuccessfulReceive` + `FinalizedOutcome`。输入即答案 → 末条 `episodes()[1].start_reason == RestartControl` 断言**恒真**：实测删掉交付归一后该 fixture **仍全绿**（另外两条同类 fixture 则红）。**这正是本票本轮要根治的 fixture fidelity 缺陷，且是同类里唯一带「自我确认断言」的**。 | 改传真值 `SuccessfulReceive` + `FinalizedOutcome`；**同一变异下本行立即红**（`left: SuccessfulReceive, right: RestartControl`）。判别力由此**从 0 恢复到与另外两条一致**（见 M6）。 |
      | **P2 空转断言（第三轮审阅）** | 两处**构造使然**的断言被当判据：① `every_gap_...` 的 `assert_eq!(samples, CANARY_SEEDS.len()*3 + truncated.len())`——两侧由**同一组循环边界**数出，恒等，改错循环边界也照绿；② `gap_is_a_classified...` 的 `assert_eq!(counts.len(), ObservationGapReason::ALL.len())`——`gap_reason_counts()` 就是 `ALL.iter().map(..)`，长度恒等。 | ① 删除，防空转只留**由运行产物得来**的 `observed_gaps > 0`；② 换成有判别力的两条：`sum(counts) == gap_count`（抓「gap 事实 detail 为 None / 不属任何闭集成员」）+ `full_time` 桶数 `== gap_count`（抓原因错配）。 |
      | P2 文档（第三轮审阅） | `disabled_recorder_is_a_no_op` 注释称「`simulate()` 压根不建 recorder」——**假**：`simulate()` 建 `disabled()` 并传给 `match_events`（`lib.rs`，同处注释亦有记述）。**pre-existing**（HEAD 同串），非本 slice 引入。 | 改为如实：`simulate()` **确实**走 `disabled()` 路径；本测试只验证 `disabled()` 契约，不验证那条接线。 |
      | nit（第三轮审阅） | 300-seed gate 的 task 归属写成「`Assert recorder on/off leaves ... RNG unchanged` 的结构面（gap 分类）」——但该门只跑 observed 路径、从不比较 on/off，与 on/off-RNG 清单项无关（且与模块头「RNG 面没有独立门」自相矛盾）。 | 改为归属「观察对象不变量（gap 分类）」，并显式说明与 on/off-RNG 无关。 |
      | nit（第三轮审阅） | `allowed_gap_details` 的「单点定义」表述覆盖不到文件里**另一处**字面 `FullTimeDuringBallInFlight`（`gap_is_a_classified...` 对两个已知截断样本的断言）。 | 在 doc-comment 里如实标注范围：那处是**更严**的检查（fail-closed，放宽允许集时会红而非静默放行），但确实是漂移面，改允许集时须一并看。 |
      **第三轮独立审阅（本次修复会话的 workflow 复验，4 维并行 + 逐条反证）**：22 个 agent、
      17 条 finding 经反证，**5 条确认**、其余 12 条判为「引用的文本在当前工作树已不存在/已修」。
      确认 5 条的处置：
      | # | 问题（确认） | 处置 |
      |---|---|---|
      | P2 | FreeKick fixture 交付入参生产不可达（同 M6 那条）——**反证者实测复现**：删归一后该 fixture 全绿，而同文件另两条红 | 已传真值（见上表 P1 行）；复验下三行全红 |
      | nit | `out_of_play_restarts_...` 的 `prior_episode_end` **仍硬编码 `None`**，而生产 `advance_loose` 拾取传 `Some(ControlLost)`（`lib.rs`）；角球/门球两行与生产不符（当前**惰性**：`dead_ball_started` 已关掉 episode，该参数不被读） | 按行参数化：界外球 `None`、角球/门球 `Some(ControlLost)`——与同节 `shot_saved_rebound_...` 的保真写法一致（消除同节自相矛盾） |
      | nit | 该 fixture 的判别力注释写「删归一 → **三行**全红」，实际测试在**首个失败行** panic，只报一条 | 注释改为「首个失败行（ThrowIn）红；逐行判别力由把该行移到首位的等价变异证明」 |
      | P2 | tasks.md 内**两处同一个 target 的通过数不一致**（`9 passed` vs `219+7+10+4`） | 统一为 `219+7+9+4`，并补「最终整跑」行记录本轮 exit 0 的五次 `test result: ok` |
      | P2 | tasks.md 记的 `observation.rs` 工作树哈希是**中间快照**（`fbb51e5c…`），本轮修复后已变 | 更新为收尾实测值并注明「工作树哈希随每轮修复而变、**不是不变量**；不变量是生产前缀两侧同哈希」 |
      | nit | 「允许集单点定义」表述与同文件另一处字面原因的关系未写清 | 在测试 doc-comment 与本文档同时注明**单点范围**与那处「更严、fail-closed」的性质 |
- [x] **未决项如实转记**（不勾上面的清单，只记录口径）：
      - **A9-7 决策路径 guard 的接口级隔离仍未完成**（上一节最后一条）。Slice 3 的测试与文档
        **不得**把那个启发式 guard 当作**结构证明**——它是**回归下限**（封闭字符串清单 +
        一层「新增读方法忘了登记」的反向覆盖启发式）。本 slice 未重构 recorder API。
      - **末尾两项口径纪律**（写死在测试文档里，防下游误用）：`event_indexes` 里的**事件时间
        可以早于** `object.start_t`（`event_emit` 早于 `state_commit`，design §15.6；实测
        80 场 1923/7749 条绑定如此）——**不得**断言事件落在对象时间窗内；
        `gap_count() == 0` **只对本样本成立**，终场哨落在未决飞行中途时会**合法**产
        `full_time_during_ball_in_flight`（design §15.5：seed 147 @ 120、seed 368 @ 400）
        ——**不得**断言「所有 duration 均为 0」，而按**分类**断言
        （`gap_is_a_classified_outcome_not_a_failure` +
        `every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`：
        允许集只有 design §10 的两个哨声原因，其余全部原因都是缺陷信号）。
        **允许集单点定义在 `allowed_gap_details()`**，由 canary 清扫门与
        **300-seed release 校准门共用**（后者逐 seed 逐条调 `check_gaps_are_allowed`）——
        各写一份必然漂移，一处收窄后另一处仍放行缺陷 gap。release 门里的 `gaps <= 5` 只是
        **次级量级守卫**，**不能**代替原因校验（M5 变异实测：seed 250 注入
        `MissingStreamEndBoundary` 时分类门红、而 `gaps <= 5` 仍绿）。
        **单点范围如实说明**：文件里**另有一处**字面写 `FullTimeDuringBallInFlight`
        （`gap_is_a_classified...` 对两个已知截断样本的断言）。它是**更严**的检查（要求恰好
        这一种），**不是**允许集的副本——放宽 `allowed_gap_details` 时那处会**红**（fail-closed）
        而不会静默放行；但它确实是**漂移面**，改允许集时须一并看（同 `tests/*.rs` 的 doc-comment）。
      - **RNG 面的口径纪律（本 slice 校正后的定稿，勿退回旧说法）**：**没有任何一层**能直接观测
        到这场比赛消费了多少 RNG / 消费后游标在哪——比赛 rng 是 `match_events` 的**局部变量、
        返回即丢弃**。（`SeededRng` 是导出的，但这不改变结论：新建的序列与那场比赛无关。）
        因此「recorder on/off 不改变 RNG」只能靠**间接**证据：正式事件流与磁盘 golden 逐字节
        相同（集成门 ①②；决策由 rng 驱动，消费点变则流变）。**不得**把逐字节相同写成「已用
        raw RNG 序列直接证明」，也**不得**再引入 beat 序列之类的「满射代理」——它与逐字节门
        重复（原集成门因此删除）。`src` 层保留的 `rng_draw_helper_is_seed_dependent_and_skip_sensitive`
        只是 helper 自检，**不是** RNG 等价性证据。
        若将来真的需要直接比 raw 序列，**唯一**正当做法是让 `match_events` 接受外部注入的 rng
        （改生产签名）——先有真实需求，**不是**为测试放宽可见性。

## Slice 4 — follow-up

- [ ] Implement #15B `PhaseAnnotator` only after #15A facts are stable.
- [ ] Do not attach set-piece delivery to a possession episode before confirmed open-play control.
