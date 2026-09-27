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

### 4.3 `attacking_transition` 在现行契约下**结构上无法标注**（2026-09-27 实测更正）

⚠️ **本节先前写「有引擎内真值可接，第一版应当接这个 hint」——那是错的**（同一轮内被实测反证）。
保留更正过程，因为它是 15B 停摆的直接原因。

**引擎里确实有一个同名状态**：`MatchState.transition { ticks_left, attacking, source }`，
窗口固定 `TRANSITION_TICKS = 4`，仅两个来源 `Tackle` / `SaveCaught`（save-rebound 不触发）。
**但它够不着任何 `PossessionEpisode`**——实测（60 seed × 90 分钟）：

| 路径 | 易主动作 → 下一个 episode 起点 | 与窗口 `[t, t+4)` 的关系 |
|---|---|---|
| **Tackle** | **867/867 全部恰好 4.0 s**（零例外） | 4.0 **落在区间外** -> **零重叠** |
| SaveCaught | p50 = 20 s | 有重叠，但靠**松散球停留久**碰上，非窗口有效 |

时间线（tackle@80）：`ControlReleased@81 -> ContestStarted@81 -> ContestEnded@84 -> ControlEstablished@84`

**根因是架构错配，不是覆盖率问题**：

```text
design §11 硬约束：phase_segments 只能挂在 PossessionEpisode 内，
                   不得跨越 episode / RestartSequence / DeadBall
引擎真实情况：      transition 窗口 ⊂ Contested 区间（tackle 路径整段落在里面）
契约：              Contested 不是 PossessionEpisode（map.md:63；design §6 状态转移表）
```

`observation.rs` 亦确认 episode 只在 `Controlled` 下开启（悬空 `Contested` 走 `reject` 分支）。
**两侧约束合起来 ⇒ `attacking_transition` 的真值落在 phase 够不着的地方。**
与窗口重叠的 episode 共 1230/6047（20.3%），但拆开只有 **84 个是「起始落在窗口内」**，
1106 个是「在窗口内**结束**」——后者是丢了球权的旧 episode，不是转换。

**SaveCaught 之所以有重叠**：它的窗口与「门将持球建立新 episode」**在同一拍武装**
（`lib.rs` save-caught 分支：武装 `transition` 后紧接着 `emit_beat_with_main`，注释明写
「这记带球 beat 属于新 episode」）；而 tackle 路径的窗口整段在 contested 内，等 episode 开启时窗口已清除。

**命名冲突警告**（此条仍成立）：主 spec `match-engine` 已有一条「控球阶段与攻防转换」要求，
讲的是引擎内部的 team `attack`/`defend` + `transition_active`，与 15B 的 possession phase 闭集
**不是同一个概念**，勿混用同一名词。

**因此 15B 的前置问题不是「如何接 transition hint」，而是**：

> **Phase 是否必须完全挂在 `PossessionEpisode` 内，还是需要一个与 possession 正交的
> transition observation 层（如 `TransitionSpan`）？**

这个问题没有答案之前，直接开工 15B 会变成形式主义——见 `.scratch/map.md` 的 `15B` 条目与
roadmap §4.5。**15B 暂停。**

### 4.4 与 #16 的接口张力（须在 #15B 设计里显式处理）

§11 的签名里有 `spatial_features`，**而 #16 按路线图排在 #15B 之后**——即 v1 的签名里有一项
输入尚不存在。这不是可以默认略过的策略问题，v1 必须二选一并写进 design：

- **（推荐）保留参数、显式留空**，并规定「该参数缺席时凡依赖空间判断的判据一律输出 `unknown`」，
  使 #16 到位后是**填充**而非**改签名**；
- 或**改签名**，把空间依赖整体推到 #16 之后。

无论选哪条，**都不得用区域/坐标冒充空间特征**——那正是 §11 禁止的「把球场区域直接等同为战术阶段」。

### 4.5 决定：**15B 暂停**，先立「phase 挂载模型」设计票据（2026-09-27）

按 §4.3 的实测结论，15B 在现行契约下没有可标的真值。三个候选方案各自的代价：

| 方案 | 代价 |
|---|---|
| 1 照做（机器 + `unknown`） | 交付一台**空转的机器**：`attacking_transition` 上限 2–3%，其余 ~97% `unknown`；对 #17B 无阶段解释价值。应改名为前置基础设施票据，而非宣称 15B 提供了阶段证据 |
| 2 扩张 possession 以覆盖 contested | **破坏 P15A 已验证的核心契约**。`Controlled`/`Contested` 互斥是状态机基础（`design §6` 转移表、`§9.1`）；改了会连带 episode 数/时长/起止原因/动作归属与 P17A 全部统计。正确方向是**新增正交对象**（`TransitionSpan`），不是扩张 possession |
| 3 先做 #16 | #16 是**必要非充分**：它给的空间特征（宽度/纵深/局部人数/最近防守距离/接应角度）能支持「是否有组织接应」「是否受压」这类判断，**但不能自动定义** `build_up`/`progression`/`final_third`——`build_up ≠ 后场`、`progression ≠ 球向前移动`、`final_third ≠ 前 1/3`。若不额外产出面向 phaseability 的连续特征，只是在推迟同一个问题 |

**结论**：先回答设计问题，而不是选实现路径。

> **Phase 是否必须完全挂在 `PossessionEpisode` 内，还是需要一个与 possession 正交的
> transition observation 层（如 `TransitionSpan`）？**

**决策票据须回答**：

1. 挂载模型三选一：扩张 possession / 引入正交 `TransitionSpan` / phase 保持现状、转换另行表达；
2. 若引入 `TransitionSpan`：它与 `PossessionEpisode` 的嵌套或相邻关系、状态不变量、边界 fixture；
3. 若扩张 possession：需要什么证据才敢动 P15A 的契约——至少包括真实数据证明转换阶段应覆盖争抢区间、
   新的状态不变量、重跑 0 gap / episode-contest 收束 / 300 seed 校准 / sidecar 确定性 / golden 门，
   并重生成 P17A 全部指标、确认哪些历史结论失效；
4. `build_up`/`progression`/`final_third` 的**可判定性判据**：需要哪些特征、在什么时间窗上算、
   如何避免退化成「区域 = 阶段」；以及若最终不可判定，`unknown` 的期望占比与如何避免 15B 形式主义；
5. 与 #16 的顺序：先 #16、合并、还是保持 `#16 -> 15B` 但给 #16 加一个 **phaseability gate**——
   先检验现有观测能否区分三档，够则设计谓词，不够则明确保留 `unknown` 或补数据。

**在票据解决前不动 15B 实现。**

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

**当前 frontier 是「phase 挂载模型」设计票据，不是 #15B 实现**（见 §4.5）。
**#15B 已暂停**（2026-09-27）：实测证明 `attacking_transition` 在现行契约下结构上无法标注
（§4.3），`build_up`/`progression`/`final_third` 在 #16 之前没有判据——照做会得到一台产出≈零的机器。

```text
phase 挂载模型设计票据（wayfinder issue / OpenSpec explore）
  Phase 是否必须完全挂在 PossessionEpisode 内，
  还是需要一个与 possession 正交的 transition observation 层？
```

- 该会话**只出设计决策**，不写实现；须回答 §4.5 列的五项（尤其是挂载模型三选一，
  以及扩张 possession 需要什么证据才敢动 P15A 已验证的契约）。
- **不得**动 P15A recorder、正式事件流或 golden。
- 决策落地后，路线按 §4.5 第 5 条确定：先 #16、合并、或 `#16 -> 15B` 但给 #16 加 phaseability gate。
- 独立审阅会话负责核「结论是否被原始契约支持」（本轮的教训：引权威要引原始出处，
  不要把后来的注记当契约——已发生过一次）。

> **本节曾是错的**（2026-09-26 修过一次、09-27 又因实测改一次）：最初让新会话启动
> **P17A**（已完成，照做会重跑），随后改成启动 **#15B**，而 #15B 现已暂停。
> 每次路线变化都要回来改这里——**这是新会话的第一入口，写错方向代价最大**。

> **本节曾指错方向**（2026-09-26 更正）：原先写「启动 P17A behavior-chain baseline analysis」，
> 而 P17A 当时已完成——新会话照做会去重跑一个已收尾的 change。
