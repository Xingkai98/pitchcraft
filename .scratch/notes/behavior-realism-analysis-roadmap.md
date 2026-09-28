# 行为真实性：数据分析到生成改造路线

状态：Active roadmap
最后更新：2026-09-26
Canonical map：`.scratch/map.md` 的“行为真实性方向”
当前 frontier：**phase 挂载模型设计票据**（#15B 暂停，见 §4.5；#17A 已完成）

## 1. 当前已经具备什么

#15A Match Behavior Observation 已完成，不再是设计或事件流启发式原型：

- `ControlFact`：控制建立/释放、争抢、死球、重开和比赛边界事实；
- `PossessionEpisode`：开放比赛中的明确球队控制片段；
- `RestartSequence`：死球判定到重新进入开放比赛的重开片段；
- `DiagnosticMatch`：正式事件流 + sidecar + invariant violations；
- engine 内部生产状态提交点接线，不从事件文本事后猜球权；
- recorder 不参与比赛决策、不消费 RNG、不改变正式 `simulate()` 输出。

关键改动四段（经 PR #107 重放落地到 main）：

- 设计与 OpenSpec change；
- formal observation model；
- engine 状态提交点接入；
- fixtures、multi-seed gate 和验证门。

> **为何不写提交哈希**（2026-09-26）：这四段原先记的是重放**之前**的短哈希
> （`824911b` / `ad3dc05` / `8a3da2b` / `647cb1e`），在 main 上**不可达**——重放会重写哈希。
> 定位请用上表按 PR/语义名，或 `git log --grep`。

验证基线：

- 300 seed × 90 分钟：**338,120** facts、**30,179** episodes、**15,584** restarts、0 gaps
  （`MODEL_VERSION = 7` 口径；v6 时代为 331,966 / 26,429 / 14,476——跨了 P104 体积重标定，勿混用）；
- plain `simulate()` 与 opt-in 正式 events 逐字节一致；
- `cargo test`、prototype tests、OpenSpec strict、`./verify.sh` 全绿；
- 生产 wiring mutation 和非 canary 缺陷 gap 注入均能使门失败。

## 2. 已作出的路线决策

**现在就开始行为数据分析，不再等待 #15B phase 或 #16 空间特征全部完成。**

理由：#15A 已经能回答“控球如何开始、延续、争抢、丢失、射门结束和重开”，足以识别第一批过程异常。
#15B/#16 的作用是进一步解释异常发生在哪个战术阶段、由什么空间关系造成，而不是开始分析的前置条件。

因此路线固定为：

```text
#17A：#15A 行为链基线分析（立即）✅ 已完成
  → phase 挂载模型设计票据（2026-09-27 插入，见 §4.5）   ← 当前
  → #15B：Possession 内 PhaseAnnotator（暂停）
  → #16：团队与局部空间特征
  → #17B：阶段 + 空间 + 动作链诊断报告
  → #18：行为真实性 L3 验证层
  → #19：最小生成机制改造
  → 前后行为基线与真实比赛对照
```

## 3. #17A：已完成（2026-09-24，2026-09-25 在 main/v7 上重算）

> **结论摘要**：OpenSpec change `p17a-behavior-chain-baseline-analysis` 已落地；10 条机器判定的
> 异常规则中 **6 条触发**（A1/A2/A3/A7/A8/A10）。头条是「球权转移不消耗时间、也不由位置决定」
> ——动作间隔 **12.64 s**、争抢 **52.7%** 同 tick 收束、拦截/抢断夺回率 **0.0%** 而传失 **94.7%**、
> 重开准备期是方式常数、争抢 **78.2%** 集中在中带。机制已逐条读代码核对：`start_loose_ball`
> 的单队追逐者选择（与角球的 `start_battle_loose` 双队机制形成对照）是 A2/A3/A10 的共同根因。
> 完整报告：`.scratch/notes/behavior-chain-baseline-2026-09-24.md`。
>
> **数值口径为 `MODEL_VERSION = 7`**（main）。初版数字取自一条 fork 自无球 demo 分支、`v6` 的树，
> 跨了 P104 体积重标定；判据未改、触发集合不变，数值全变。移植与重算记录见报告 §8。
> 原定下一 frontier 是 #15B（phase），随后 #16（空间特征），再进 #17B/#18/#19。
> **2026-09-27 更正：15B 暂停**——先答「phase 挂载模型」设计问题，见 §4.3/§4.5。

### 问题

当前模型在真实 possession/restart/contest 语义下，究竟重复产生哪些不像足球的过程？

### 分析样本

- 默认基线：固定 300 seed × 90 分钟；
- 调试 canary：10–30 seed；
- 所有结果必须保存 seed、比赛时间、episode/restart id，能够回到事件流或 viewer；
- 基线必须记录源码 commit、配置和 sidecar schema 版本。

### 第一批指标

1. **Possession 形状**
   - 持续时间、动作数、传球数；
   - 开始原因和结束原因；
   - 射门前动作链长度；
   - 不同开始原因下的结束分布。
2. **控制权转换**
   - `control_lost → contest → pickup` 时长；
   - 原控球队重新拿球概率；
   - tackle/interception/pass-lost 后的下一控制方；
   - 转换后的前 1–3 个动作。
3. **Restart 质量**
   - kickoff/free-kick/throw-in/corner/goal-kick 到首次明确控制的时间；
   - 重开后首次 possession 的长度和结束原因；
   - 是否大量出现“发出 → 立即丢失/争抢”。
4. **动作链 motif**
   - 高频 N-gram/链型，例如 `pickup → pass → lost`；
   - `restart → receive → immediate loss`；
   - `control → pass* → shot`；
   - `tackle → loose → original team pickup`；
   - 对每个 motif 输出频率、后果和具体样本。

### 交付物

- 可重复运行的分析命令；
- 机器可读 JSON；
- 人可读 Markdown 报告；
- 5–10 个高影响异常模式，必须包含：
  - 数量证据；
  - 具体 seed/time/episode；
  - 为什么不像真实足球；
  - 最可能对应的生成机制；
  - 还缺什么 phase/空间数据才能确认。

### 停止条件

#17A 不是无限分析。满足以下条件即停止并进入 #15B/#16：

- 已识别至少一条高频、高影响、可复现的异常流程；
- 能把异常定位到具体动作链和 engine 决策区域，而不是只说场均统计偏差；
- 能提出一个不依赖全局重写的最小生成改造候选；
- 已选择用于前后比较的固定 seed 集和行为指标。

推荐优先候选：

```text
后场建立控制
→ 是否形成可用接应
→ 是否经过中场推进
→ 进入前场、合理回传，或在有压力下丢失
```

## 4. #15B：PhaseAnnotator

第一版 phase 仅挂在 `PossessionEpisode` 内：

- `build_up`
- `progression`
- `final_third`
- `attacking_transition`
- `unknown`

约束：

- phase 不影响模拟决策；
- phase 不反向改变 possession 边界；
- 无足够事实时输出 `unknown`；
- 定位球 delivery 留在 `RestartSequence`，首次明确控制前不标 possession phase；
- 不把球场区域直接等同为战术阶段。

### 4.1 落地形态：**落在 sidecar，不是分析器层**（2026-09-26 更正）

⚠️ **本节先前写「分析器层的纯只读投影」，那是错的**——它来自对 §11 的误读，且**同一轮里
`map.md` 又被改成相反的说法**（「见 design §11」）。两处互相矛盾。以下按证据重写：

**设计意图是填充 sidecar 预留的字段**，证据三条（都在仓里可查）：

1. `match-behavior-observation-design.md:36` 的 sidecar schema 明写 `phase_segments // #15B，第一版可为空`；
2. 同文件 `:338`：「#15A 的 sidecar schema 为其**预留**空数组即可」；
3. `engine/src/observation.rs` 已经把 `PhaseSegment { episode_id, start_t, end_t, phase, provenance }`
   整个结构体、`Phase` / `PhaseProvenance` 两个闭集、以及 `DiagnosticMatch.phase_segments` 字段
   **全部预留好了**，并留了两个「15B 之前必须为空」的守卫。

**这仍然满足「纯只读投影」**：标注器读 `PossessionEpisode`/`ControlFact`/引擎 hints 产 segment，
**不反向影响** possession 边界或决策。它只与 P15A 现有的两条纪律冲突——「recorder 不参与决策」
与「不改 recorder」——而这两条都指**决策路径**，不是字段填充；`phase_segments` **不参与任何
JSON 序列化**（`events_json()` 只序列化 events），故按字节一致门与 golden **不受影响**。

**待确认项**（开工前必须定，见 §4.2 第 4 条）：填充**发生在哪里**——是 recorder 在 `into_diagnostic_match`
之前填，还是 `simulate_with_behavior_observations` 在拿到 `DiagnosticMatch` 之后填？
后者更贴合「recorder 不参与」，但 `PhaseSegment.episode_id` 指向的是 sidecar 内部对象，
两种位置都能实现。**这是一个真决策，不要默认略过。**

### 4.2 实现前必须闭合的七项（2026-09-26 定，比原先四条更全）

前四项来自 grill 要问的设计决策，后三项是原清单漏掉的工程前置：

1. **四个 phase 的可执行谓词**——现有文档只给了禁令（「不把球场区域直接等同为战术阶段」），
   没给判据。没有谓词，`build_up` 与 `progression` 的边界就是空的。
2. **episode 内多段 phase 的切分 / 合并 / 边界不变量**——§11 的 `PhaseSegment[]` 与
   「无法确定边界时拆段」暗示允许多段，但切分规则未定；**且不得跨 episode / `RestartSequence`
   / `DeadBall`**。
3. **`attacking_transition` 的触发来源、有效时间窗与转出条件**——`defensive_transition` 已明确排除
   （那是失球方的 team-state，留给后续 team-state observation），但它留在了闭集里，边界要说清。
4. **输入事实的优先级与 `unknown` / provenance 策略**——何者优先、何时降级、`engine_hint |
   geometry | event | inherited | unknown` 各自在什么条件下产出。
5. **时间基准混用**（原清单漏项）——`TimeBasis` 闭集有四个成员：
   `StateCommit` / `EventEmit` / `DeterministicFlightEnd` / `Unknown`（`observation.rs`）。
   P17A 报告 §6 已把 basis 混用列为已知局限。phase 的起止若跨 basis 混用，时间窗会出现
   事实上不存在的重叠或空隙；必须规定**同一 segment 只用同一 basis**。
6. **fixture matrix、反空转测试与变异验证**（原清单漏项）——按本仓门槛：边界 fixture 覆盖
   `build_up`/`progression`/`final_third`/`attacking_transition`/`unknown` 五类 + 定位球不被误标；
   每个断言配**反证条**；对「删掉某条 phase 判据」做定向变异，证明门会红（P36/P17A 的教训）。
7. **analyzer / provenance 记录方式**（原清单漏项）——沿用 P17A 的做法：版本号随判据变化递增、
   产物自带 `source_commit` + `engine_source_fingerprint` + 口径常量，使两次不可比的运行
   能在产物层被识别。

### 4.3 `attacking_transition` 是 team-state，不作 possession phase（2026-09-28 定论）

> 本节经**三轮独立对抗审阅**（GH #113）。**前两版都写错了机制**，此处是定论；
> 完整论证见 `.scratch/issues/113-15b-phase-mounting-model.md` 与 GH #113。

**结论**：`MatchState.transition { ticks_left, attacking, source }` 是**一个**对象，
**同时驱动两队**——得球方前压（`press *= 2.0`）、失球方收缩（`close_down`）。
实测窗口内 close_down movers **`4353 属防守方 / 0 属进攻方`**。

⇒ 它是**团队状态**，与 design §11 已排除的 `defensive_transition` **同构**
（§11 逐字理由：「属于失去球权球队的团队状态，不应伪装成当前控球队 possession phase」）。
把得球方那一面标成 possession phase 是**同一个类型错误**。
→ **它不应作为 possession phase 产出**（处置见 §4.5）。

**一处须说明的不对称**：得球方在窗口后**确实**成为控球方，失球方不会——
所以是**镜像**而非孪生。这条不对称应写进 design，而非当作已证明的矛盾。

#### 前两版写错的三处（保留，因是本仓反复踩的坑）

| 曾写 | 实测更正 |
|---|---|
| 「tackle→下一个 episode **恒 +4.0 s**，结构事实」 | **常数巧合**：`gap = LOOSE_MAX_TICKS + 2`，只因 `2+2=4` 才等于 `TRANSITION_TICKS`。sweep：翻转条件是 **`gap < TRANSITION_TICKS`**（`LOOSE_MAX_TICKS` 0/1 翻：909/886 拍；2/3/4 不翻）——**「任何重标定都会翻」也错，上调不翻** |
| 「够不着任何 `PossessionEpisode` / 窗口整段在 Contested」 | **只对 tackle 路径**；save 路径 **98/98 窗口、392/392 拍全覆盖**——「完全够不着」是假的。窗口起点**总是**已有 open episode（868/868、98/98），只是**属失球方** |
| 「事件晚一拍」 | **讲反了**：tackle 事件与武装**同函数同 tick**（`lib.rs:4093`/`:4109`）；滞后的是 `contest_started`（`arm+1`） |

#### 口径警告（前两版的数字因此对不上）

- 窗口定义有**两套**：引擎真窗口 `[武装 tick, +4)` vs 事件锚 `[事件.t, +4)`。
  tackle 上两者**同 tick**；save 武装滞后 saved-shot 事件 +1（90 次）/+2（8 次）。
- 因此**本文件旧版记的 `1230 / 84 / 1106` 应作废**（本轮复现不出 `84`/`1106`；
  可复现的是事件锚口径 `1230 / 124`）。引用一律以 #113 票据为准。
- `tackle 事件数` 60 场为 **868**（旧版写 867 是「有后继 episode」的子集口径）。

**命名冲突警告**（仍成立）：主 spec `match-engine:641`「控球阶段与攻防转换」讲的是引擎内部
team `attack`/`defend` + `transition_active`，与 15B 的 possession phase 闭集**不是同一个概念**。

**⇒ 15B 的前置问题因此收敛为**（见 §4.5 与 #113 §8）：

> **Phase 是否必须完全挂在 `PossessionEpisode` 内，还是需要一个与 possession 正交的
> transition observation 层（如 `TransitionSpan`）？**

**15B 暂停**，待设计票据确认。

### 4.4 与 #16 的接口张力（须在 #15B 设计里显式处理）

§11 的签名里有 `spatial_features`，**而 #16 按路线图排在 #15B 之后**——即 v1 的签名里有一项
输入尚不存在。这不是可以默认略过的策略问题，v1 必须二选一并写进 design：

- **（推荐）保留参数、显式留空**，并规定「该参数缺席时凡依赖空间判断的判据一律输出 `unknown`」，
  使 #16 到位后是**填充**而非**改签名**；
- 或**改签名**，把空间依赖整体推到 #16 之后。

无论选哪条，**都不得用区域/坐标冒充空间特征**——那正是 §11 禁止的「把球场区域直接等同为战术阶段」。

### 4.5 15B 的处置与顺序（2026-09-28 定）

**已定**（依据 §4.3，见 GH #113）：

- `attacking_transition` **不作 possession phase 产出**——它是 team-state（§4.3）；
- **不删** `Phase` 闭集成员：它从未产出，删它只改 2 处手写成员表，却让**已记录的**
  `sidecar_schema_fingerprint` 变陈旧，且**定向突变实测删 label 后全套测试仍全绿**（无守卫守该值）；
- 改为在 #15B design 标注「`attacking_transition` 在 possession phase 层**不作产出**，
  语义归 team-state observation」；
- **顺序**：`#16（含 phaseability gate）→ #15B`。

**为何否决另两条**：

| 方案 | 否决理由 |
|---|---|
| 扩张 possession 覆盖 contested | **类型缺陷**：`Contested` = 控制**未**确认、`PossessionEpisode` = 控制**已**确认，互斥由 `design §6` 转移表 / `§9.1` / `observation.rs` 的 `reject` 分支保证；合并是把「未确认」塞进「已确认」。**且会撞 §10 不变量与既有守卫**（`p15_behavior_observation.rs` 那批直接变红），**并毁 P17A 全部统计** |
| 15B 现在单独做 | 三档（`build_up`/`progression`/`final_third`）在 #16 之前**确认无判据**（只有坐标，而「区域 ≠ 阶段」）；save 路径虽够得着，但那是把 team-state 标成 phase（类型错误）。整体产出 ≈ 零 |

**仍待用户拍板**（不再阻塞设计，但阻塞实现，见 #113 §8 全 7 项）：

1. 缺失的 §11 理由：**回填 design §11**（动冻结文档）还是在 #15B design 记偏离？
2. 是否为 **team-state observation** 立项（承载两队转换语义），
   还是先走「**负空间 + 判据**」的零新对象路线？（旧 episode 的 `control_lost` +
   `contest_started(tackle_loose)` + 4-tick 窗口已构成转换窗口的完整负空间表达——
   缺的是「升格为标签的判据」，不是「对象」）
3. `phase_segments` 的**填充位置**（recorder 内 vs `simulate_with_behavior_observations` 后）；
4. **判据冻结的守卫方式**（写进 §4.2 清单，还是靠 `engineFingerprint` 哨兵）；
5. 三档 phase 的**可判定性判据**本身（待 #16）。

**在 1–5 落地前不动 15B 实现。**

## 5. #16：团队与局部空间特征

第一版只做当前引擎可靠提供的特征：

- 球队宽度和纵深；
- 球附近局部人数；
- 最近防守距离/压力；
- 前方与侧后方接应数量；
- 支援角度；
- 中后场与前场的间距代理。

不在该票据修改跑位或决策逻辑；缺失 tracking 时明确标 unknown，不从统计相关性虚构因果。

## 6. #17B → #18 → #19

### #17B 可解释报告

将 #17A 的动作链与 #15B/#16 合并，回答：

- 这次 possession 为什么结束？
- 为什么在这里选择射门/向前传球？
- 丢球后谁做了什么？
- 问题属于阶段转换、接应结构、压力判断还是动作选择？

### #18 行为真实性验证层

把稳定结论变成 L3 行为门，而不是继续增加场均统计：

- 转换反应；
- 动作链；
- possession 过程；
- 空间关系；
- restart 后的开放比赛恢复。

### #19 最小生成改造

一次只改一条流程。首选：后场组织 → 中场推进 → 前场结束/合理丢球。

每次改造必须同时提供：

- 修改前 #17A/#17B 基线；
- 修改后同 seed 对比；
- 行为门结果；
- 原有 golden/event stream 确定性说明；
- 场均统计作为护栏，而不是优化目标。

## 7. 禁止事项

- 不因某个场均指标偏差直接调概率；
- 不把事件类型或球场区域直接当 phase；
- 不用启发式 prototype 覆盖 engine recorder 的事实；
- 不在 #17A 同时改生成器，先完成诊断和样本选择；
- 不以“分布更接近”替代具体比赛流程变得更合理；
- 不等所有 tracking/空间能力完备才开始第一轮分析。

## 8. 新会话接手入口

新会话只需先读取：

1. `.scratch/map.md` 的“行为真实性方向”；
2. 本文件；
3. `.scratch/notes/match-behavior-observation-design.md`；
4. `openspec/changes/p15-match-behavior-observation/`；
5. `engine/tests/p15_behavior_observation.rs` 了解现有 sidecar 不变量。

随后按 Paseo lifecycle 启动新的 change/session。

**当前 frontier 是「用户拍板 #113 的待决项」，不是 15B 实现**（见 §4.5）。
**#15B 已暂停**（2026-09-27；结论 2026-09-28 定，GH #113 经三轮对抗审阅）：

- `attacking_transition` **是 team-state，不作 possession phase 产出**（§4.3）；
- `build_up`/`progression`/`final_third` 在 #16 之前**确认无判据**——照做会得到产出≈零的机器；
- **顺序**：`#16（含 phaseability gate）→ #15B`。

**#113 的设计结论已定**，剩下的是 §4.5 列的**用户待拍板 5 项**
（§11 理由回填方式 / 是否立 team-state observation / `phase_segments` 填充位置 /
判据冻结的守卫方式 / 三档判据本身）。**这 5 项没定之前不要开 15B 实现会话。**

- 若要开工，先做 **#16**，并给 #16 加 **phaseability gate**（先检验现有观测能否区分三档，
  够则设计谓词，不够则明确保留 `unknown` 或补数据）。
- **不得**动 P15A recorder、正式事件流或 golden。
- 独立审阅会话负责核「结论是否被原始契约支持」（教训：引权威要引**原始出处**，
  不要把后来的注记当契约——本轮发生过一次；且**行号引用会漂**，一律用符号名）。

> **本节已被修过三次**（09-26、09-27、09-28）：最初让新会话启动 **P17A**（已完成，照做会重跑），
> 随后改成 **#15B**（其后暂停），现改为「拍板 #113 的五项待决」。
> 每次路线变化都要回来改这里——**这是新会话的第一入口，写错方向代价最大**。

> **本节曾指错方向**（2026-09-26 更正）：原先写「启动 P17A behavior-chain baseline analysis」，
> 而 P17A 当时已完成——新会话照做会去重跑一个已收尾的 change。
