# G1 批烤：时间 / 协议 / 状态机（C1 运动层）

范围：只读审阅 D2.2/D2.3/D2.4/D5/D6/D8/D9 + 三份 delta + tasks + Round 6 审阅；
对照 main `engine/src/lib.rs` 的 tick/finalize/drain 与 `viewer/game.js`/`interpretation.js` 时间语义。
不修改设计/规范/引擎/viewer，不 commit。

## 已由设计钉死、不需要用户决策的事实

- **F1 三层 cadence 与首拍相位已定**：`SIM_DT=0.1`/`DECISION_DT=0.5`/`BEAT_DT=0.2`，
  首 beat=0.5、段边界 `S=sort(B∪D∪E)`、`beat.t`=段起点、`dt∈{0.1,0.2}`（终场末段例外）
  （design.md:80–87、228–240；D11 #1/#2 design.md:1077–1079）。
- **F2 高亮参与者不再隐藏/不再 frozen**：参与者进入 `movers`（`action:"highlight"`），
  事件锚点 = 连续积分（含分离）到 `t_end` 的位置；`frozen_mask` 不再用于参与者、
  `highlight_frozen_segs` 显示线退役（design.md:467–468、493–499、645–688）。
- **F3 唯一执行路径已宣告**：`CommittedPlan` 覆盖内只消费缓存、不 `decision()`/不掷骰/不积分，
  未覆盖边界由 live scheduler 执行，SHALL NOT 存在第二套调度语义（design.md:92–94、114–117、219–222）。
- **F4 旧流 v11 回放必须兼容，且判别已定**：`buildTimeline` 读第一条 beat 有无 `dt` 做流级选择，
  旧流 `legacyBeatSeconds=0.5` + warning，同流 `dt` 时有时无报错；第一阶段不逐段混用 0.2/0.5
  （design.md:751–753、794–795；pitch-viewer spec.md:43–51）。
- **F5 四态驱动与稀疏携带已定**：`controlled`/`loose`/`highlight`/`restart`；高亮期禁 `main`/`ball`、
  事件本身 = 首锚点；非高亮新状态首段即使零位移也发 `main`/`ball`（design.md:479–501；
  event-stream-protocol spec.md:76–134）。
- **F6 同刻排序已定**：非 beat 事件先（按引擎发射顺序）、beat 最后，beat 描述事件后段；
  「先 beat 后事件」视为实现错误（design.md:259–262）。

## Q1 — 悬空高亮 `t_end>dur` 的终场 finalize 链由谁执行？

**问题**：main 现在有一条独立于 tick 循环的排空循环（`engine/src/lib.rs:3395`
`while st.highlight.is_some() { finalize_highlight(...dur) }`，含 P30 的同 `dur` 链式 finalize
去重）；D2.2 的权威循环是 `while s < dur`、计划 `P_eff=min(P_end,dur)` 终态交还。
当一条高亮 `t_end>dur`（finalize 本应落在 `>dur` 的 0.1s 网格）时，该高亮的**结果提交**
（如 shot goal 计分 → kickoff → 门球链）既不在计划覆盖内（计划只规划到 `t_end`，不规划被
`dur` 截断的终态），也不在 A/B/C/D 循环内（`s≥dur` 已退出）——**谁、在哪一步执行终场 finalize 链？**

- **A**：保留 main 的排空循环，作为计划外 live finalize，并在 D2.2 显式豁免「唯一执行规则」。
- **B（推荐）**：终场 finalize 链并入 `CommittedPlan` 的终态覆盖：计划在 `dur` 处缓存「被截断
  高亮的终场 finalize 结果（比分/球权/新高亮链）」，循环退出后零活。计划内容需显式把
  「dur 截断的终场 finalize 链」列入事件列表与终态状态。
- **C**：禁止悬空高亮跨 `dur`——凡 `t_end>dur` 的高亮在 `t_c` 即拒发。会改变「终场射门仍计分」
  语义，动 L1 射门/比分。

**理由/证据**：A 直接违反 design.md:92–94「SHALL NOT 第二套调度语义」；C 改事件语义与 D2.3
「终场排空：链式 finalize 只保留一个终态」冲突。B 与 D2.2 计划内容（design.md:96–129）一致，
但当前「事件列表（含 finalize 事件）」只覆盖 `[t_c,t_end]` 的 finalize，**没有**写被 `dur`
截断的终场 finalize 链算不算计划内容。spec match-engine:145–171 的 `P_end 与终场交接` 也只在
`dur<P_end` 时给「终场截段/终态」，未定义该截段里是否执行 finalize 结果提交。

**需要用户决策：否**——应由设计补写终场 finalize 链的唯一执行入口（B 或 A+B 的最小化）。

## Q2 — 权威伪代码里 finalize 有两个发射器：A 的 `boundary_events_at` 与交还块的 `plan.events_at`

**问题**：伪代码（design.md:152–153、178–181）中 A 阶段 `emit/apply boundary_events_at(s)` 与
交还块 `if use_plan and s == plan.P_eff: emit plan.events_at(s)` 是两个发射点。计划覆盖的
**内边界**（含 `s=P_eff` 的 finalize）由谁发射？A 阶段对计划覆盖边界是否跳过？

- **A（推荐）**：把 A 的 `boundary_events_at(s)` 定义为**计划感知**：`s∈[t_c,P_eff)` 覆盖内从
  plan 事件账本取、不重算；`s=P_eff` 的 finalize 由交还块消费账本（不是再次 emit）；伪代码里
  显式写 gating 与「账本消费一次」。
- **B**：交还块是唯一 finalize 发射点，A 阶段对 plan 覆盖边界整体跳过（`start_marker`+覆盖判断）。
- **C**：维持伪代码字面，两处都可能 emit，靠 `plan_divergence` 事件账本事后抓重复/遗漏。

**理由/证据**：`start_marker` 只防「回到同一 `s` 重复处理起点」（design.md:151、182–184），
不防 `P_eff` 边界的 A 与交还块各发一次 finalize。R6 已把「唯一执行路径」判为关闭，但伪代码的
`boundary_events_at` 与 `plan.events_at` 的**发射职责归属**仍未写清——实现者仍会二选一。

**需要用户决策：否**——应由设计把两个发射点合并为同一事件账本消费，写清覆盖边界的 gating。

## Q3 — 观察层 `frozen` 快照字段在「参与者不再 frozen」后变为什么？

**问题**：D2.4/D7.3 只迁移了 p16/p124 快照的 `t` 对齐（改对 `beat.from`，design.md:319–324、
835），但 p16 的 `state_snapshot_frozen_marks_active_highlight_only`
（`engine/tests/p16_spatial_features.rs:495`）断言：`frozen` 仅在活跃高亮拍非空（:505）、
且**必有非空拍**（:519 防空转「全 5399 拍 frozen 恒空？」）、且非空拍是少数（:527）。
D5.4 宣告「`frozen_mask` 不再用于参与者」（design.md:467–468）后，`observe_state` 的 `frozen`
参数（`lib.rs:3353–3357` 现取 `highlight.participants`）该填什么？

- **A（推荐）**：观察层 `frozen` 字段保留，语义改为「活跃高亮参与者 id **标签**」（不再有
  冻结含义），p16 该测试改断言（仍非空、仅高亮拍、少数拍）——运动层与观察层解耦但标签继续存在。
- **B**：`frozen` 恒空，删 p16 的 frozen 断言。但 p16 是 D7.3「全部保留」的研究门
  （design.md:857），删断言需显式批准，且「防空转」门的价值会丢。
- **C**：观察层继续按 `highlight.participants` 填 frozen（现状照搬），运动层不冻结——语义分叉。

**理由/证据**：design.md 通篇没有 `observe_state`/`frozen` 快照字段的迁移项（grep design/tasks/delta
仅 design.md:467–468、688 提及 `frozen_mask`/`highlight_frozen_segs`，与观察层 `frozen` 是两码事）。
若实现者按字面删掉参与者冻结，p16 的 :519 防空转断言直接红。

**需要用户决策：否**——应由设计在 D2.4 或 D7.3 补一条「观察层 frozen 标签语义」的迁移决定。

## Q4 — 验收主指标依赖的工具不在 main，且参与者入 movers 使 frozen 口径失效

**问题**：D7.1/D9.1/task 6.6 的 turn120/staticFrac 依赖 `tools/visual-review/motion-census.mjs`
的「frozen 口径」+ `conditional['0.5'].turnsPerPlayer`（design.md:817–818、975–977；
tasks.md:84）。但 ① main 的 `tools/visual-review/` 下**没有** `motion-census.mjs`（只有
`motion-metrics.mjs`），它活在 `p155-measurement-instrument/2026-11-19` 分支；② C1 后参与者以
`action:"highlight"` 进入 movers，而 Change 0 的 frozen 24 窗与 0.829/0.0104 锚是在 v11
（参与者被排除出 movers）口径下算的——**同一脚本跑新流，输入已经变了**。

- **A（推荐）**：Phase 0 从 p155 分支移植 `motion-census.mjs`，并显式**过滤 `action:"highlight"`**
  （保持与 v11/Change 0 口径可比）；tasks 补「移植 + 口径守护」项。
- **B**：不移植，改由 `motion-metrics.mjs` 重造 turn120——但 frozen 24 窗与 0.0104 锚全部作废，
  须重新标定真实锚（回退 D9.1 的「0.0104 可直接比较」承诺）。
- **C**：工具缺失留待验收时再决定——D9.1 主判据在 Phase 0 无法执行，不可接受。

**理由/证据**：`ls tools/visual-review/` 实测无 `motion-census.mjs`；tasks 无「移植工具」项。
真实侧不受影响（真实 tracking 无 action 字段），受影响的是**引擎侧 v11 基线**与 frozen 24 窗
回归集的可比性。

**需要用户决策：否**——但若按 A 过滤后 v11 基线读数仍 ≠ Change 0 记录，须上会说明口径差异，
不得静默换锚。

## Q5 — `last_emitted` 不在「完整调度状态」清单里，但 retained scenario 断言它逐边界一致

**问题**：计划快照的「完整调度状态」清单（design.md:106–108、142–143）只列
motion + 球权/冷却/动作机会/活跃高亮/重开/decision 计数，**没有 `last_emitted`**。而
D4.4 第 9 步「段边界上才写 `last_emitted`/发 beat」（design.md:433）与 MODIFIED
`同队球员间距` 的保留 scenario「状态与事件一致」要求「每名未罚下球员的 `st.pos` SHALL 等于
其最近一次发射位置（`last_emitted`）」（match-engine spec.md:334）——计划覆盖边界是否更新/缓存
`last_emitted`？

- **A（推荐）**：`last_emitted` 纳入计划缓存状态清单，逐边界随缓存状态提交（保持 retained
  scenario 语义与 D4.4 第 9 步一致）。
- **B**：`last_emitted` 不算计划状态，计划覆盖边界由发射时从缓存 `to` 状态回写。
- **C**：把「状态与事件一致」scenario 限定到 live 边界（计划覆盖边界豁免）——弱化保留契约。

**理由/证据**：A 最小且不动 retained scenario；B 让「覆盖内只消费缓存」出现一个不在缓存里的
隐式写回，与 design.md:114–117 冲突。

**需要用户决策：否**——应由设计把 `last_emitted`（或等价发射缓存）补进 D2.2 的完整状态清单。

## Q6 — 旧流重放时，`micro-motion` 的高亮回溯前提「不再有 tackle beat 在前的特例」是否成立？

**问题**：MODIFIED `静止球员 micro-motion` 的保留 scenario「高亮参与者回溯识别」把前提写成
「所有高亮事件统一『事件先、beat 后』，**不再有 tackle beat 在前的特例**」
（pitch-viewer spec.md:105–108）。但旧 v11 流（F4 仍支持）里 tackle 的 beat 在同 tick
**之前**（`viewer/game.js:424–425` 现注释）。旧流重放时该回溯/高亮窗口判定是否仍按旧序工作？

- **A（推荐）**：回溯判定按**流级模式**分叉——新流假定事件先，旧流保留 tackle-beat-first 的
  窗口回溯（`game.js:424–431` 逻辑保留并加 legacy 分支）；spec scenario 注明前提只对新流。
- **B**：旧流也统一按「事件先」假定（需证明旧流 tackle beat-first 下回溯仍正确，或接受旧流
  高亮抑制失效）。
- **C**：明确旧流只保「五段式合成 + 段长」，micro-motion/高亮参与者抑制对旧流不承诺。

**理由/证据**：D6.1/D6.2 的旧流兼容只覆盖段长与五段式合成（design.md:751–753、794–795），
未覆盖 `_highlightEnd`/`_activeHighlightIndex` 的旧序回溯。若实现者按 scenario 的新前提删掉
tackle-beat-first 分支，旧流 tackle 的参与者抑制窗口会失效。

**需要用户决策：否**——应由设计在 D6 注明「旧流的 tackle 同 tick 排序仍按旧序处理」的兼容条款。

## G1 认为仍会阻塞 design 批准的点

1. **Q1 终场 finalize 链的执行入口未定**——悬空高亮 `t_end>dur` 的结果提交落不进 A/B/C/D 循环，
   与「唯一执行规则」正面冲突（最严重，直接决定调度器是否仍是两条路径）。
2. **Q2 `boundary_events_at` 与 `plan.events_at` 双发射器归属未写**——「唯一执行路径」在伪代码
   字面上仍留两个 finalize 发射点。
3. **Q3 观察层 `frozen` 快照字段迁移缺失**——p16「全部保留」的防空转断言会因参与者不冻结而红，
   设计没有这条迁移。
4. **Q4 验收主指标工具不在 main + 参与者入 movers 使口径失效**——D9.1 主判据（turn120/staticFrac）
   在 Phase 0 无可执行工具，且 frozen 24 窗与 0.0104 锚在新输入下不可比。

Q5、Q6 属实现/Phase 0 可闭合的澄清（但应落进 design 或 tasks），不单独阻塞批准。
