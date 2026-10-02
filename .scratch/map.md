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
> main/`MODEL_VERSION=7` 上重算）。**#16 已完成（2026-09-29，PR #123）**，裁决 **部分够**：
> `final_third` 可判（AUC 0.855/0.862），**`build_up`/`progression` 判不了**（0.461/0.431）——
> 审阅者扫了 21 个空间量，最强非循环量只 0.634 ⇒ **空间量本身不足**。
> **#124 已完成（2026-09-30，PR #127）**，裁决 **仍不够**：接出「意图」类观测后，
> `build_up`/`progression` 依旧判不了（非循环意图特征全落在 0.449–0.546）；
> 且抓到 `window_*` 三条对 `final_third` 的 0.966 是**同义反复**（leave-one-out 后 → 0.510）。
> ⇒ **#16 + #124 合读：空间（#16）与意图（#124）两条路都试过、都不够**——
> phase 判据目前**没有**可用的观测依据（见 roadmap §5.1/§5.2）。
> **#17B 已实现并合入**（2026-09-30，PR #133；7 轮 grill 全过 + 9 轮实现期独立审阅）。
> **#18 行为验证层已完成**（2026-10-01，PR #136；设计 3 轮 grill + 实现 2 轮审阅）。
> **#19 最小生成改造 = 负结果结项（2026-10-01，D）**：硬门形状确是真瓶颈（grill + 独立审阅双核），
> 但把门形状改对后 `press 移均值 × L1 带余量薄(1–6%) × 窗抖动` 三者相乘 ⇒ **无连续可行区间**
> （米制 standoff 扫掠 `[5.35,5.95]` 步长 0.02 × 官方全套 × 三窗，最长连续段 **0.04 m ≪ 0.10 m**）。
> **引擎未改动**（`engine/src/lib.rs` = 基线 `2adfe62b…`）。**这不是「带定义矛盾」**（出处核查排除），
> 而是**引擎贴着带沿站**（射门/抢断都**低于**真实、且要同时抬升并保持比值——单点做不到）。
> **#19 的真价值**：证明前六个 change（P15A→P18）推不动引擎**不是分析不够，是这个结构结**
>（射门/抢断/犯规由同一处接触几何驱动，单点改必破另一带）。
> 证据：change `openspec/changes/p19-carrier-press-and-pressure-gate/`（含 `GRILL.md`）
> + `.scratch/notes/19-{recon,shape-probe,band-provenance}-2026-10-01.md`。
> ⇒ **frontier 待用户裁定**（候选：协调动「射门 + 防守几何」的更大 change /
> 先修两条 `#19` 遗留债 **#139**（`far==0`，**✅ 已修 2026-10-02，PR #142**）/ **#140**（P9 上界，open））。
> #18 的交付：判据组 **A1/A2 + B4**（B4 结构性）+ 护栏 A3/C1 + 报告项 + 不可得声明 D。
> **头号靶点（交给 #19）**：**引擎的防守方「有距离、无逼近」**。
> ⚠️ 本行原载「起始 **61.5 m** vs 真实 6.0 m」——**该数已撤销**（2026-10-01，#19 侦察发现）：
> 它出自 #18 探针的 `【chase】` 行，**只过滤 `chase`/`close_down` mover**，而那些动作
> 只在松散球拍与 transition 拍出现（`beat.ball` 与 `beat.main` **互斥**），**那里根本没有持球者**。
> #18 自己已撤销 B1–B3，理由逐字就是「**种群不同义**」。
> **真值**：持球拍最近防守者到持球者的距离 **7.79 m**（真实 6.01 m）⇒ **距离本身没问题**。
> **真问题**：持球拍中仅 **6.29%** 存在「防守方朝持球者移动」（`close_down` **215** vs `run` **58 961**，
> 30 seed）⇒ **开放比赛里没有任何球员被指派去逼近持球者**。
> #17B 范围**不含 phase**（`#16`/`#124` 双负）；`#15B` 仍暂停（重开须先找到新观测来源）。
> 交付：只读诊断器（`engine/tests/p17b/` + `p17b_diagnosis_report.rs`，**零 `engine/src/` 改动**）；
> 产物 `target/p17b-diagnosis/{canary,baseline}.{json,md}`（`#[ignore]` 门生成，gitignored）。
> ⚠️ **一处如实记录的残余风险**（见 change 的 `REVIEW.md` 末节）：`close_down` 归因的一个
> 「扫文本」守卫**能力有限**（自由散文里的新措辞抓不住），本 change 已按裁定**停止迭代**，
> 防线改为「人读唯一的那份权威叙述」。
> **#15B 暂停**（#113：`attacking_transition` 是 team-state）；**#113 已全部裁定**（无待决项）。
> 权威路线：`.scratch/notes/behavior-realism-analysis-roadmap.md` §4.3–§4.5、§5。
> 详细执行路线：`.scratch/notes/behavior-realism-analysis-roadmap.md`。

- `12` **比赛行为观察契约** ✅ 已通过 grilling
  - `Possession` 按球队实际控制权变化划分；争抢/二点球保留在竞争状态，不因单个事件随意切段。
  - `Phase` 按战术状态划分，不等同于事件类型或球场区域。
  - 第一版阶段候选：`build_up`、`progression`、`final_third`、`attacking_transition`、`defensive_transition`、`set_piece`。
  - 第一版空间观察：团队级状态 + 球附近局部空间，不做完整 22 人 tracking 分析。
  - 交付物：增强事件流 + 可读球权诊断报告；暂不改变行为生成器，暂不先做 viewer UI。
- `13` **现有事件流可观测性盘点** ✅ 已解决（2026-09-22）
  - Blocked by: `12`
  - Type: Research
  - 问题：现有 `pass/dribble/shot/tackle/interception/off_ball_run/beat/foul` 是否足够重建球权、阶段和转换？哪些字段需要补充，哪些只能标记为 unknown？
  - 产物：字段映射表、不可观测项清单、最小增强协议提案。见 `.scratch/notes/behavior-observability-audit.md`。
  - 结论：**部分足够**。引擎内部已有 `possession/carrier/ball_pos/loose/dead_ball/transition`；事件流可重建粗粒度动作链和区域，但缺显式球权变化、phase、统一完成时间和压力观测。第一轮采用“正式事件流不变 + 只读诊断投影”，不改生成逻辑。
  - 状态：✅ 已解决（2026-09-22）
- `14` **当前模型行为基线** ✅ 已解决（2026-09-22；数字为 v6 启发式时代，见该 note 的入库注记）
  - Blocked by: `13`
  - Type: Prototype
  - 问题：在不改生成逻辑的情况下，当前 30–100 个 seed 的球权长度、阶段比例、动作链、区域转换和转换反应是什么样？
  - 产物：可重复的 baseline fixture/report；明确哪些异常是模型已有行为，避免后续把回归误判为改进。见 `.scratch/notes/behavior-baseline-2026-09-22.md`。
  - 结论：**已得到第一版基线，但需由 #15 重算语义**。30 seed × 90 分钟平均 460.13 个动作事件、113.13 个启发式球权段；球权持续时间 P50=25 秒、P90=123 秒。阶段启发式结果为 `build_up` 0.12%、`progression` 24.17%、`final_third` 54.80%、攻防转换合计 13.34%、定位球 7.57%。这说明当前输出是动作/高亮流而非完整触球流，且现有 phase 推断不足以直接指导调参。
  - 状态：✅ 已解决（2026-09-22）
- `15` **球权与阶段标注器** 🚧 #15A 已完成；#15B **暂停**（2026-09-27，前置为「phase 挂载模型」设计票据，见本条末）
  - Blocked by: `13`, `14`
  - Type: Prototype
  - 问题：如何从现有事件流确定 possession 边界、阶段起止、竞争状态和球权结束原因？
  - 产物：纯函数标注器 + 边界案例测试 + 带 `possession_id/phase/chain_index` 的诊断事件流。见 `.scratch/notes/possession-annotator-2026-09-22.md`。
  - 结论：**第一版边界已收敛**。成功传球保持球权；`lost` 保留为 `contested`；拦截/抢断切换控制权；出界、射门、犯规形成可解释的结束原因；犯规后的任意球作为新的 `set_piece` 段。动作完成时间暂用距离/速度估算，`phase` 保留启发式和 `unknown` 能力。
  - **#15A Match Behavior Observation：✅ 已完成（2026-09-24）**。
    - 正式设计：`.scratch/notes/match-behavior-observation-design.md`。
    - 实现：formal model、engine integration、verification gates 三段改动，见 PR #107 的提交序列。
      （**此前这里写的是三个短哈希**——那是重放前的旧分支对象，main 上**不可达**，
      重放后哈希已变。除非确需回溯旧分支，否则按 PR/符号名定位。）
    - 已能可靠输出 `ControlFact`、`PossessionEpisode`、`RestartSequence`、contest、结束原因和事件归属；正式事件流保持不变。
    - 300 seed × 90 分钟验证：331,966 facts、26,429 episodes、14,476 restarts、0 gaps；`verify.sh` 全绿。
  - **#15B PhaseAnnotator：⏸ 暂停（2026-09-27）**——前置有两块：
    [★ #113](issues/113-15b-phase-mounting-model.md)（挂载模型，**已全部裁定**，无待决项）
    + [★ #116](issues/116-team-local-spatial-features.md)（空间特征与 phaseability gate，✅ **已完成** 2026-09-29，PR #123）
    + [★ #124](issues/124-intent-observations.md)（意图观测，✅ **已完成** 2026-09-30，PR #127）。
    - **前置已闭合、结论为负**：空间（#16）与意图（#124）**两条路都不够** ⇒
      #15B 的 phase 判据目前**没有**可用的观测依据；重开的前提是**先找到新的观测来源**。
    - 第一版只在已确认的 possession episode 内标注 `build_up / progression / final_third / attacking_transition / unknown`。
    - 定位球 delivery 留在 `RestartSequence`，首次明确开放控制前不得伪装成 possession phase。
    - 契约与约束见 `.scratch/notes/match-behavior-observation-design.md` §11；`Phase`/`PhaseProvenance`
      闭集已在 `engine/src/observation.rs` 预留（不产出 segment）。
    - **暂停原因**（结论见 GH #113，经三轮对抗审阅）：`attacking_transition` **是 team-state，
      不是 possession phase**——引擎 `transition` 窗口同时驱动两队（得球方前压 / 失球方收缩），
      与 §11 已排除的 `defensive_transition` 同构。另三个标签在 #16 之前无判据
      （只有坐标，而「区域 ≠ 阶段」）。照做会得到产出≈零的机器。
    - **处置已定**：**不删** `Phase` 闭集（该 label 从不产出；删它只改 2 处手写成员表，
      却让已记录的 `sidecar_schema_fingerprint` 变陈旧，且无测试守该值）；
      改为在 #15B design 标「不作 possession phase 产出」。
    - **顺序**：`#16（含 phaseability gate）→ #15B`。
    - **#113 已全部裁定**（2026-09-28）：§11 理由记在 #15B design 的偏离 / 不立 team-state
      observation / `phase_segments` 由纯函数在 `DiagnosticMatch` 之后填 / 判据冻结项前提不成立（撤销）/
      三档判据归 #116。**15B 的开启条件只剩 #116 的 phaseability gate 结论。**
    - 落地形态（填 sidecar 预留字段）与七项清单仍有效，但**先回答挂载模型**。
    - 详见 `.scratch/notes/behavior-realism-analysis-roadmap.md` §4.1–§4.5。
    - **开工前须闭合七项**（谓词、多段切分、`attacking_transition` 边界、`unknown`/provenance、
      时间基准、fixture+变异、provenance 记录）**及与 #16 的接口张力**——
      见 `.scratch/notes/behavior-realism-analysis-roadmap.md` §4.1–§4.4。
- `16` **团队与局部空间特征（含 phaseability gate）** ✅ 已完成（2026-09-29；PR #123）
  [★ #116](issues/116-team-local-spatial-features.md)（GH #116 侦察）
  [★ #124](issues/124-intent-observations.md)（GH #124：接出「意图」观测并重跑 gate ✅ 已完成 2026-09-30，PR #127）
  - Blocked by: `12`, `13`（均已完成）
  - Type: Research
  - 问题：从当前坐标和 beat/off-ball 信息中，第一版可靠计算哪些宽度、纵深、线间距、支援和压力特征？
  - **本轮新增**：还须产出**面向 phaseability** 的带时间关系特征（球门向净推进 / 推进·回撤·横向转移 /
    线间距变化 / 接应与人数优势 / 球权后的时间序列）——原候选是静态快照，不足以判 `build_up`/`progression`/`final_third`
    （`build_up ≠ 后场`、`progression ≠ 球向前移动`）。
  - **验收 = phaseability gate**：不只「特征算得出来」，还要裁决**三档能否判定**。
  - **裁决：部分够**——`final_third` 可判（`forward_m/s` AUC **0.855**/30 seed、**0.862**/300 seed）；
    `build_up`/`progression` **判不了**（**0.461**/**0.431**）。审阅者**自己扫了 21 个空间量**，
    最强非循环量只 0.634 ⇒ **「空间量本身不足」**，不是「特征没选好」。
  - **落地**：引擎经 G1 导出真实位置（每 tick 全量 22 人 → `DiagnosticMatch.state_snapshots`，
    **事件流零增量**、不改 `ControlFact` 闭集）；四类时间关系特征；
    口径以 `ControlFact` 为权威（两种口径使后场起点差 **3 倍**：7.5% vs 23.5%）。
  - **给 15B 的处置**：`final_third` 是**几何证据不是战术意图**，须命名为证据
    （如 `GoalwardProgressEvidence`），**不得复用 `Phase`**；另两档保留 `unknown`。
  - **当时的下一步**：#124（接出射门窗口/防守线路等「意图」观测 → 重跑 gate）——**已完成（2026-09-30，PR #127），裁决仍不够**。
  - 产物：OpenSpec change `p16-team-local-spatial-features`（含 `REVIEW.md`：7 轮独立审阅）；**不实现 15B**。
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
- `17B` **可解释的行为诊断报告** ✅ **已实现并合入**（2026-09-30，PR #133；设计 7 轮 grill + 实现期 9 轮独立审阅）
  - Blocked by: `17A` ✅, `16` ✅ —— **`15B` 不再是阻塞**（其前置双负：phase 判据无观测依据）
  - Type: Prototype
  - 问题：如何把一场比赛按球权、局部空间和动作链展开，使人能回答
    “为什么这次推进结束 / 为什么这里射门 / 丢球后发生了什么”？
    ⚠️ **原文含「阶段」**——本轮**删除**该项：`#16`/`#124` 双负，phase 不可得，**不得**用区域冒充。
  - 产物：OpenSpec change `p17b-explainable-diagnosis-report`；只读诊断器
    （`engine/tests/p17b/` + `p17b_diagnosis_report.rs`）；L1 逐 episode 诊断卡 +
    L2 聚合视图；JSON + Markdown；支持按**球权 / 动作链 / 区域 / 压力**回放检查。
  - **本 change 的第一交付是「证据边界表」**：每个量 → 落点公开字段 → 性质
    （`观测`/`派生`/`假设`）逐条可审计——针对本仓「doc 声称的机制代码里不存在」这一族缺陷。
  - 侦察：`.scratch/notes/17b-recon-2026-09-30.md`（实测；**记录了两处被探针推翻的读码推断**）。
  - **待决策 6 条**见 change 的 `design.md` §5；grill 通过 + 用户确认后才开实现。
- `18` **行为真实性验证层** ✅ 已完成（2026-10-01；PR #136，设计 3 轮 grill + 实现 2 轮审阅）
  - Blocked by: `14`, `17B`（均已完成）
  - Type: Research
  - 问题：哪些可验证模式应成为 L3 行为测试，而不是继续堆场均统计？
  - **裁决：四类里三类立得住 + 一类如实声明不可得**（交付**四类**中的三类，
    是对本条原「四类断言」的偏离，已在 change 里记）：
    - **球权过程** ✅ A1/A2（链时长 **4.88×**、间隔 **3.95×**）
    - **转换反应** ✅ **B4**（持球时被防守方逼近覆盖的占比：真实 **56.1%** vs 引擎 **5.81%**，
      **9.7× 且是下界**；结构性条）
    - **动作链** ⚠️ C1 降为护栏（分母不可比）、C2 不立（两侧都落 L1 带内）
    - **空间关系** ✅ **无增量**（已由 P38 的 8 条判据覆盖）
    - **restart 恢复** ❌ **如实声明不可得**（真实数据无「发出」时刻）
  - **推翻的前提**：「真实数据只有位置」不成立——SkillCorner opendata 的
    `dynamic_events.csv` / `phases_of_play.csv` **不是 LFS**、**已在下载产物里**，只是没解析器。
  - change：`openspec/changes/p18-behavior-verification-layer/`
    （判据在 `notes/criteria/`，**12 份可复现探针**在 `notes/probes/`）
  - **头号靶点（交给 #19）**：引擎的防守方「**有距离、无逼近**」。
    ⚠️ 原载「起始 **61.5 m**」**已撤销**（#19 侦察，2026-10-01；出处与理由见上方摘要块——
    那是只过滤 `chase`/`close_down` 的**异种群**口径，#18 已撤销其 B1–B3）。
    **真值**：持球拍最近防守者距离 **7.79 m**（真实 6.01 m），**距离没问题**；
    **真问题**是**没人被指派去逼近**（持球拍中仅 6.29% 有逼近）。
  - ⚠️ **如实标注**：判据**报告期**（退出码恒 0）；证明的是「判据没被改坏」，
    **不是**「能分辨真改善」——后者要等 `#19` 交付机制后用合法配置簇标定。
- `19` **最小行为改造 vertical slice** ⬛ **负结果结项（2026-10-01，D）**
  - Blocked by: `17B`, `18`
  - Type: Prototype
  - 问题：选哪一条最小真实足球流程先从观测转为生成约束？推荐：后场组织 → 中场推进 → 前场结束/丢球。
  - 产物：不影响其他阶段的最小改造实验、前后 baseline 对比和行为测试结果。
  - **结论：`#19` 的最小单点生成改造被证伪（负结果）。**
    - **机制成立**：`OPEN_PLAY_PASS_PRESSURE_M`(8 m) 硬门**确**是开放比赛射门路径的瓶颈
      （8.0 与 `SHOT_PRESSURE_NEAR_M` 同常量、连续压迫项在射门路径可达时恒为 0、两者在 8.0 互补）
      ——由**独立 grill + 独立审阅双重复核**。
    - **但无连续可行区间**：把门形状改对（reorder）+ press 后，
      `press 移均值 × L1 带余量薄(1–6%) × 窗抖动` 三者相乘 ⇒ 米制 standoff 扫掠
      `[5.35,5.95]` 步长 0.02 × 官方全套 × 三窗（401/1001/1201），**最长连续可行段 0.04 m ≪ 0.10 m**。
    - **不是「带定义矛盾」**（`.scratch/notes/19-band-provenance-2026-10-01.md` 核查排除）；
      而是**引擎贴着带沿站**：射门(17.1)/抢断(30.4) 都**低于**真实(21.6/36.9)、要同时抬升并保持
      比值（贴真实 0.586）——**单点改动做不到**。
    - **引擎未改动**：`engine/src/lib.rs` = 基线 `2adfe62b…`；本 change 只交付**否定证据**。
    - **真价值**：证明前六个 change 推不动引擎**不是分析不够，是这个结构结**。
    - 产物：change `openspec/changes/p19-carrier-press-and-pressure-gate/`（proposal/design/tasks/
      spec/**GRILL.md**/`notes/probes/` 原始输出）+ 3 份 note。
    - **遗留债各开一票**：**#139 ✅ 已修（2026-10-02，PR #142；加 ε=0.05m，有硬上界依据）**、#140（P9 两条比率带上界按现状配，open）。
  - 状态：⬛ 负结果结项（2026-10-01）；**frontier 待用户裁定**（更大 change / 先修债）。
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

> **执行顺序（2026-10-01 更新）**：`#17A` ✅ → `#113` ✅ 已裁定 → `#16` ✅（PR #123）
> → `#124` ✅（PR #127）→ `#17B 可解释诊断报告` ✅（PR #133）→ `#18 行为验证层` ✅（PR #136）→
> **`#19 最小生成改造` ⬛ 负结果结项（D，2026-10-01；见本条）→ frontier 待用户裁定**。
> `#19` 的结论：最小单点改造**做不到**——硬门形状确是真瓶颈，但「press 移均值 × L1 带余量薄 ×
> 窗抖动」使可行域为空（无连续 ≥0.1 m 段），**引擎未改动**。遗留债 **#139**（`far==0`，**✅ 已修 2026-10-02，PR #142**）/ **#140**（P9 上界，open）。
> 下一步**候选**（用户裁定）：协调动「射门 + 防守几何」的更大 change，或先修 #139（已完成）/#140（open）。
> `#15B` **暂停中**——其前置（#116 的 gate）已给出且为**负**：空间与意图两条路都不够，
> 重开须先找到新观测来源。（原序列 `#15B → #16` 已因 #113 改为 `#16 → #15B`。）
> 不要等 #15B/#16 全部完成才开始分析；也不要在 #17A 仅凭场均统计直接调参数。

> 当前实施路线：P4（并行节拍核心）✅ 已完成；**P5（队形公式 + 攻防转换 + micro-motion）实施中**（`openspec/changes/p5-team-shape-and-transition/`）；P6（定位球 + 犯规规则层）已立项待规划；P7（战术决策系统）已立项，建议 P5→P6→P7 顺序。

## 已确认的方向（Design 讨论，2026-08-04）

- **两层架构**（事件引擎 + 画面层，事件流接缝）——已确认。
- **双端需求**：网页版（移动端）+ Windows 程序都要能玩——硬需求。
- **"不用框架"的正确含义**（用户澄清）：不用**现成的、跟 FM 实现有关的**框架/引擎/库/代码（足球模拟引擎、现成经理游戏代码）；**通用工具**（Canvas / SDL / Electron / Tauri 等）允许，不算违反约束。
- 因此语言选型不再受"无框架"限制——JS 桌面端用 Electron/Tauri 套壳、C++/Rust 双端靠 WASM，都是允许的通用方案，真正的"从零写"体现在**比赛引擎核心逻辑全部自研**（事件生成、球员 AI、规则、能力值公式、确定性 RNG）。
- **务实路线**：先 JS 打通 P0"引擎→事件流→画面"链路（JS 最快验证接缝），同时把引擎写成**纯逻辑、平台无关**，将来可平移。
