# 行为真实性：数据分析到生成改造路线

状态：Active roadmap
最后更新：2026-09-26
Canonical map：`.scratch/map.md` 的“行为真实性方向”
当前 frontier：**#15B Possession 内 PhaseAnnotator**（#17A 已完成，见下）

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
#17A：#15A 行为链基线分析（立即）
  → #15B：Possession 内 PhaseAnnotator
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
> 下一 frontier 是 #15B（phase），随后 #16（空间特征），再进 #17B/#18/#19。

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

### 4.1 落地形态（design §11 已定，不要再讨论）

`.scratch/notes/match-behavior-observation-design.md` §11 给了 `PhaseAnnotator` 的输入签名，
方向是定的：**分析器层的纯只读投影**——不改 P15A recorder、不改正式事件流、不改 golden，
`phase_segments` 在 sidecar 里继续只是预留字段。`Phase`/`PhaseProvenance` 闭集已在
`engine/src/observation.rs` 预留（有测试守着「#15B 之前必须为空」）。

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

### 4.3 与 #16 的接口张力（须在 #15B 设计里显式处理）

§11 的签名里有 `spatial_features`，**而 #16 按路线图排在 #15B 之后**——即 v1 的签名里有一项
输入尚不存在。这不是可以默认略过的策略问题，v1 必须二选一并写进 design：

- **（推荐）保留参数、显式留空**，并规定「该参数缺席时凡依赖空间判断的判据一律输出 `unknown`」，
  使 #16 到位后是**填充**而非**改签名**；
- 或**改签名**，把空间依赖整体推到 #16 之后。

无论选哪条，**都不得用区域/坐标冒充空间特征**——那正是 §11 禁止的「把球场区域直接等同为战术阶段」。

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

随后按 Paseo lifecycle 启动新的 change/session。**当前 frontier 是 #15B**
（见 §4；#17A 已于 2026-09-24 完成，不要重跑）：

```text
#15B Possession 内 PhaseAnnotator
```

- 该会话负责 phase 分析器、边界 fixture 与 provenance；**不得**改 P15A recorder、
  正式事件流或 golden（落地形态见 §4.1）。
- 开工前先闭合 §4.2 的七项，并处理 §4.3 与 #16 的接口张力。
- 独立审阅会话负责检查判据可执行性、`unknown`/provenance 策略、时间基准一致性与
  「门是否真空转」（反证条 + 定向变异）。

> **本节曾指错方向**（2026-09-26 更正）：原先写「启动 P17A behavior-chain baseline analysis」，
> 而 P17A 当时已完成——新会话照做会去重跑一个已收尾的 change。
