# 行为真实性：数据分析到生成改造路线

状态：Active roadmap
最后更新：2026-09-24
Canonical map：`.scratch/map.md` 的“行为真实性方向”
当前 frontier：**#17A #15A 行为链基线分析**

## 1. 当前已经具备什么

#15A Match Behavior Observation 已完成，不再是设计或事件流启发式原型：

- `ControlFact`：控制建立/释放、争抢、死球、重开和比赛边界事实；
- `PossessionEpisode`：开放比赛中的明确球队控制片段；
- `RestartSequence`：死球判定到重新进入开放比赛的重开片段；
- `DiagnosticMatch`：正式事件流 + sidecar + invariant violations；
- engine 内部生产状态提交点接线，不从事件文本事后猜球权；
- recorder 不参与比赛决策、不消费 RNG、不改变正式 `simulate()` 输出。

关键提交：

- `824911b`：设计与 OpenSpec change；
- `ad3dc05`：formal observation model；
- `8a3da2b`：engine 状态提交点接入；
- `647cb1e`：fixtures、multi-seed gate 和验证门。

验证基线：

- 300 seed × 90 分钟：331,966 facts、26,429 episodes、14,476 restarts、0 gaps；
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

## 3. #17A：下一会话立即执行

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

随后按 Paseo lifecycle 启动新的 change/session：

```text
P17A behavior-chain baseline analysis
```

该会话只负责分析器、报告和异常候选；独立审阅会话负责检查统计口径、样本可复现性和“是否真的能定位生成机制”。
