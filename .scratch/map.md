# Wayfinder Map: Football Manager 2D 复刻（从零写）

## Destination

从零开始写一个足球经理比赛模拟器（**不依赖框架**），两层架构：**比赛事件引擎** + **2D 画面层**。
事件引擎确定性地产出一场比赛的事件流（传球、射门、跑位、进球……）；画面层把事件流渲染成**早期 FM 风格的圆点球场动画**（俯视球场、球员为圆点、球小圆）。目标是"看起来像一场足球比赛"，而不是掷骰子的文字比分。

## Notes

- 领域：足球比赛模拟 / 确定性模拟 / 游戏开发
- **硬约束：从零写、不用框架**。标准库 + 轻量依赖（SDL / Canvas API 等）的边界待定，见票据 `01`。
- 参考**方法**（不是代码）：研究报告 `research/2026-08-04-football-manager-match-engine/` 中的 4 个开源项目（OpenFootManager、agentic-fc、back-of-the-neural-net、Open Football）+ Bygfoot 的视觉风格。
- 相关技能：wayfinder（本地图）、grilling、prototype、domain-modeling、research。
- 代码与设计都在 `projects/football-manager-clone/` 内。

## Decisions so far

- [引擎核心语言](issues/01-engine-core-language.md) — **Rust**。纯逻辑、平台无关，长期深耕：桌面走 Tauri 原生、网页走 WASM，一套核心两头跑。
- [画面层双端渲染](issues/07-renderer-dual-platform.md) — **JS + Canvas**。移动端浏览器直玩；Windows 桌面用 Tauri 套壳（Tauri 后端即 Rust，与引擎同栈）；画面纯几何绘制、消费事件流。
- [运行时拓扑](issues/08-runtime-topology.md) — **B 内嵌引擎（一步到位）**。桌面 Tauri 后端内嵌 Rust 引擎 crate；网页版引擎编译 WASM。不搞离线预生成过渡，P0 直接上 WASM。引擎必须是独立 Rust crate，可被两端调用。
- [事件演绎层](issues/09-event-interpretation-layer.md) — **引擎给参数、画面演绎**；第一版简单（直线直传）；演绎节奏配置化。分帧剧本（带球踢-追、传球传跑配合）在 `.scratch/notes/interpretation-scripts.md`。

## Not yet specified

- 画面层的具体渲染技术（依赖 `01` 语言决策后才能定）。
- 事件 → 动画的插值细节（球轨迹、跑位过渡的缓动）。
- 校准方案：用哪些真实足球统计分布做对标（射门数、进球分布、控球率）。
- 战术系统建模：阵型与指令如何影响球员行为（这是引擎的核心难度，先有引擎再谈）。
- 存档 / 联赛 / 转会等外围系统（可能 out of scope，视用户目标）。

## Out of scope

- 3D 画面。
- 网络对战 / 多人。
- 复刻 FM 的精确公式（闭源，不可能，也不必要）。
- 完整 FM 的数据库、转会、训练、媒体系统（除非用户明确要求）。

## Tickets（决策票据）

> **2026-08-06 起，票据迁移到 GitHub issues 管理**：`github.com/Xingkai98/pitchcraft/issues`，编号保留（title 带 `[wayfinder #0X]`）。`.scratch/issues/` 保留为本地存档；新决策/票据在 GitHub issues 开。下方状态为迁移时快照。

- `01` **引擎核心语言**（Rust）✅ 已解决（GH issue closed）
- `02` **事件流协议** ✅ 已解决（P0 定稿；P2 Phase B 补 tackle 字段定稿）
- `03` 时间推进模型 ⏳ open（P2 Phase C 落地"事件驱动连续推进"的画面消费端）
- `04` 球场模型 ⏳ open（引擎 AI 阶段）
- `05` 能力值模型 ⏳ open（引擎 AI 阶段，research 待跑）
- `06` 确定性与回放 ⏳ open（P2 Phase C 连续流+固定种子=回放数据；带标签 RNG/定点数仍开放）
- `07` **画面层双端渲染**（JS + Canvas）✅ 已解决（GH issue closed）
- `08` **运行时拓扑**（B 内嵌引擎）✅ 已解决（GH issue closed）
- `09` **事件演绎层**（人球解耦与动画节奏）✅ 已解决（GH issue closed）
- `10` **定位球 + 犯规规则层** ⏳ open（P6 立项 2026-08-08；任意球/角球/点球；含 foul/出界触发规则层前置；已补首批场景：off_target→门球开大脚+中场争抢、进球→球直接回中圈）
- `11` **战术决策系统** ⏳ open（P7 立项 2026-08-08；传球选人升级/跑位模式/整体逼抢；票据 04 落地）

## 行为真实性方向（2026-09-22）

> 目标：从“匹配真实比赛统计”推进到“经过真实足球式的状态、空间和动作链”。
> #15A 观察层已于 2026-09-24 完成，**#17A 行为链基线分析已完成**（2026-09-24，2026-09-25 在
> main/`MODEL_VERSION=7` 上重算）。当前 frontier 是 **#15B Possession 内 PhaseAnnotator**：
> 在已确认的 possession episode 内做纯只读的 phase 投影，为 #17B 的解释提供阶段证据。
> 详细执行路线：`.scratch/notes/behavior-realism-analysis-roadmap.md`。

- `12` **比赛行为观察契约** ✅ 已通过 grilling
  - `Possession` 按球队实际控制权变化划分；争抢/二点球保留在竞争状态，不因单个事件随意切段。
  - `Phase` 按战术状态划分，不等同于事件类型或球场区域。
  - 第一版阶段候选：`build_up`、`progression`、`final_third`、`attacking_transition`、`defensive_transition`、`set_piece`。
  - 第一版空间观察：团队级状态 + 球附近局部空间，不做完整 22 人 tracking 分析。
  - 交付物：增强事件流 + 可读球权诊断报告；暂不改变行为生成器，暂不先做 viewer UI。
- `13` **现有事件流可观测性盘点** ⏳ open
  - Blocked by: `12`
  - Type: Research
  - 问题：现有 `pass/dribble/shot/tackle/interception/off_ball_run/beat/foul` 是否足够重建球权、阶段和转换？哪些字段需要补充，哪些只能标记为 unknown？
  - 产物：字段映射表、不可观测项清单、最小增强协议提案。见 `.scratch/notes/behavior-observability-audit.md`。
  - 结论：**部分足够**。引擎内部已有 `possession/carrier/ball_pos/loose/dead_ball/transition`；事件流可重建粗粒度动作链和区域，但缺显式球权变化、phase、统一完成时间和压力观测。第一轮采用“正式事件流不变 + 只读诊断投影”，不改生成逻辑。
  - 状态：✅ 已解决（2026-09-22）
- `14` **当前模型行为基线** ⏳ open
  - Blocked by: `13`
  - Type: Prototype
  - 问题：在不改生成逻辑的情况下，当前 30–100 个 seed 的球权长度、阶段比例、动作链、区域转换和转换反应是什么样？
  - 产物：可重复的 baseline fixture/report；明确哪些异常是模型已有行为，避免后续把回归误判为改进。见 `.scratch/notes/behavior-baseline-2026-09-22.md`。
  - 结论：**已得到第一版基线，但需由 #15 重算语义**。30 seed × 90 分钟平均 460.13 个动作事件、113.13 个启发式球权段；球权持续时间 P50=25 秒、P90=123 秒。阶段启发式结果为 `build_up` 0.12%、`progression` 24.17%、`final_third` 54.80%、攻防转换合计 13.34%、定位球 7.57%。这说明当前输出是动作/高亮流而非完整触球流，且现有 phase 推断不足以直接指导调参。
  - 状态：✅ 已解决（2026-09-22）
- `15` **球权与阶段标注器** 🚧 #15A 已完成；#15B 待开始
  - Blocked by: `13`, `14`
  - Type: Prototype
  - 问题：如何从现有事件流确定 possession 边界、阶段起止、竞争状态和球权结束原因？
  - 产物：纯函数标注器 + 边界案例测试 + 带 `possession_id/phase/chain_index` 的诊断事件流。见 `.scratch/notes/possession-annotator-2026-09-22.md`。
  - 结论：**第一版边界已收敛**。成功传球保持球权；`lost` 保留为 `contested`；拦截/抢断切换控制权；出界、射门、犯规形成可解释的结束原因；犯规后的任意球作为新的 `set_piece` 段。动作完成时间暂用距离/速度估算，`phase` 保留启发式和 `unknown` 能力。
  - **#15A Match Behavior Observation：✅ 已完成（2026-09-24）**。
    - 正式设计：`.scratch/notes/match-behavior-observation-design.md`。
    - 实现提交：`ad3dc05`（formal model）、`8a3da2b`（engine integration）、`647cb1e`（verification gates）。
    - 已能可靠输出 `ControlFact`、`PossessionEpisode`、`RestartSequence`、contest、结束原因和事件归属；正式事件流保持不变。
    - 300 seed × 90 分钟验证：331,966 facts、26,429 episodes、14,476 restarts、0 gaps；`verify.sh` 全绿。
  - **#15B PhaseAnnotator：⏳ open（当前 frontier）**。
    - 第一版只在已确认的 possession episode 内标注 `build_up / progression / final_third / attacking_transition / unknown`。
    - 定位球 delivery 留在 `RestartSequence`，首次明确开放控制前不得伪装成 possession phase。
    - 契约与约束见 `.scratch/notes/match-behavior-observation-design.md` §11；`Phase`/`PhaseProvenance`
      闭集已在 `engine/src/observation.rs` 预留（不产出 segment）。
- `16` **团队与局部空间特征** ⏳ open
  - Blocked by: `12`, `13`
  - Type: Research
  - 问题：从当前坐标和 beat/off-ball 信息中，第一版可靠计算哪些宽度、纵深、线间距、支援和压力特征？
  - 产物：特征定义及缺失数据处理规则；不在此票据内改跑位逻辑。
- `17A` **#15A 行为链基线分析** ✅ 已完成（2026-09-24；2026-09-25 在 main/v7 上重算）
  - Blocked by: `15A`
  - Type: Prototype
  - 问题：当前模型的真实 possession、contest、restart 和动作链究竟如何运作？哪些过程模式最不像足球？
  - 产物：OpenSpec change `p17a-behavior-chain-baseline-analysis`（分析器 `engine/tests/p17a/` +
    target `engine/tests/p17a_behavior_chain_baseline.rs`）；固定 seed 分析器（baseline `1..=300`
    / canary `1..=30`，均 90 分钟）+ JSON/Markdown 基线；10 条机器判定的异常规则。
  - 结果（`MODEL_VERSION = 7`，2026-09-25 重算）：**6 条触发**（A1/A2/A3/A7/A8/A10）。
    头条：动作间隔 **12.64 s**、争抢 **52.7%** 同 tick 收束、拦截/抢断夺回率 **0.0%**
    而传失 **94.7%**、重开准备期是方式常数（任意球恒 1 s / 门球 0 s）、争抢 **78.2%** 集中中带。
    报告见 `.scratch/notes/behavior-chain-baseline-2026-09-24.md`。
  - 停止条件已满足：给出了具体动作链 + 回放定位 + 可核对的机制区域，并提出**单点**最小改造候选
    （松散球追逐者选择，见报告 §5）；固定 seed 集与前后对比指标已选定。
  - 状态：✅ 已解决（2026-09-24）；下一步 #15B phase → #16 空间特征 → #19 最小改造。
- `17B` **带阶段与空间解释的行为诊断报告** ⏳ open
  - Blocked by: `17A`, `15B`, `16`
  - Type: Prototype
  - 问题：如何把一场比赛按球权、阶段和局部空间展开，使人能回答“为什么这次推进结束/为什么这里射门/丢球后发生了什么”？
  - 产物：JSON + 文本报告格式；支持按球权、阶段、动作链、区域和压力回放检查。
- `18` **行为真实性验证层** ⏳ open
  - Blocked by: `14`, `17B`
  - Type: Research
  - 问题：哪些可验证模式应成为 L3 行为测试，而不是继续堆场均统计？
  - 产物：转换反应、动作链、空间关系、球权过程四类断言及容忍带。
- `19` **最小行为改造 vertical slice** ⏳ open
  - Blocked by: `17B`, `18`
  - Type: Prototype
  - 问题：选哪一条最小真实足球流程先从观测转为生成约束？推荐：后场组织 → 中场推进 → 前场结束/丢球。
  - 产物：不影响其他阶段的最小改造实验、前后 baseline 对比和行为测试结果。
- `20` **真实数据校准边界** ⏳ open
  - Blocked by: `17B`, `18`, `19`
  - Type: Research
  - 问题：哪些特征可由 event data 校准，哪些必须依赖 tracking；如何避免把数据相关性误当作足球因果结构？
  - 产物：数据需求分级、公开数据适用范围和后续 calibration 计划。
- `21` **空间行为模型** ⏳ open
  - Blocked by: `19`, `20`
  - Type: Prototype
  - 问题：如何把支援、拉开、压迫、回收、线间距等空间关系接入现有 off-ball/transition 模型？
  - 产物：团队形状与局部空间驱动的行为原型。
- `22` **观测层接入现有 viewer** ⏳ open
  - Blocked by: `17B`
  - Type: Prototype
  - 问题：诊断信息如何以 debug overlay、逐球权暂停和事件链方式进入 viewer，而不污染正式演绎协议？
  - 产物：可视化诊断模式；正式 viewer 行为保持兼容。

> **执行顺序（2026-09-24 决策）**：`#17A 立即分析` ✅ 已完成 → `#15B phase` → `#16 空间特征` →
> `#17B 可解释报告` → `#18 行为验证` → `#19 最小生成改造`。不要等 #15B/#16 全部完成才开始分析；
> 也不要在 #17A 仅凭场均统计直接调参数。

> 当前实施路线：P4（并行节拍核心）✅ 已完成；**P5（队形公式 + 攻防转换 + micro-motion）实施中**（`openspec/changes/p5-team-shape-and-transition/`）；P6（定位球 + 犯规规则层）已立项待规划；P7（战术决策系统）已立项，建议 P5→P6→P7 顺序。

## 已确认的方向（Design 讨论，2026-08-04）

- **两层架构**（事件引擎 + 画面层，事件流接缝）——已确认。
- **双端需求**：网页版（移动端）+ Windows 程序都要能玩——硬需求。
- **"不用框架"的正确含义**（用户澄清）：不用**现成的、跟 FM 实现有关的**框架/引擎/库/代码（足球模拟引擎、现成经理游戏代码）；**通用工具**（Canvas / SDL / Electron / Tauri 等）允许，不算违反约束。
- 因此语言选型不再受"无框架"限制——JS 桌面端用 Electron/Tauri 套壳、C++/Rust 双端靠 WASM，都是允许的通用方案，真正的"从零写"体现在**比赛引擎核心逻辑全部自研**（事件生成、球员 AI、规则、能力值公式、确定性 RNG）。
- **务实路线**：先 JS 打通 P0"引擎→事件流→画面"链路（JS 最快验证接缝），同时把引擎写成**纯逻辑、平台无关**，将来可平移。
