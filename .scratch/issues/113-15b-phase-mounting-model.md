# Grill Design: #15B phase 挂载模型

- Type: design
- Status: draft（待用户 grill 确认；**确认前不写实现代码**）
- Created: 2026-09-27
- GitHub issue: https://github.com/Xingkai98/pitchcraft/issues/113（`wayfinder:grilling`）
- 关联：`#15B`（暂停）、`#16`、`openspec/changes/p15-match-behavior-observation/`、
  `.scratch/notes/behavior-realism-analysis-roadmap.md` §4.3/§4.5

> **为什么立这张票**：15B 原计划直接实现 phase 标注器，实测发现它的核心标签
> 在现行契约下**结构上标不出来**（下节）。所以先答设计问题，再谈实现路径。

---

## 1. 触发本票的实测（facts，可复现）

### 1.1 `attacking_transition` 够不着任何 possession

引擎里有一个同名状态 `MatchState.transition { ticks_left, attacking, source }`，
窗口固定 `TRANSITION_TICKS = 4`，来源仅 `Tackle` / `SaveCaught`（save-rebound 不触发）。
它看起来是现成的真值，实测却不是：

| 路径 | 易主动作 → 下一个 episode 起点 | 与窗口 `[t, t+4)` |
|---|---|---|
| **Tackle** | **867/867 全部恰好 +4.0 s**（60 seed × 90 min，零例外） | 4.0 **落在区间外** → **零重叠** |
| SaveCaught | p50 = 20 s | 有重叠，但靠**松散球停留久**碰上，非窗口有效 |

时间线（tackle@80）：

```text
ControlReleased@81 → ContestStarted@81 → ContestEnded@84 → ControlEstablished@84
```

重叠统计：与窗口重叠的 episode 1230/6047（20.3%），但拆开 **只有 84 个是「起始落在窗口内」**，
1106 个是「在窗口内**结束**」——后者是丢了球权的旧 episode，不是转换。

**SaveCaught 之所以有重叠**：它的窗口与「门将持球建立新 episode」**在同一拍武装**
（`lib.rs` save-caught 分支：武装 `transition` 后紧接着 `emit_beat_with_main`，
注释明写「这记带球 beat 属于新 episode」）；tackle 路径的窗口整段在 contested 内，
等 episode 开启时窗口已清除。

### 1.2 根因是架构错配，不是覆盖率

```text
design §11 硬约束：phase_segments 只能挂在 PossessionEpisode 内，
                   不得跨越 episode / RestartSequence / DeadBall
引擎真实情况：      transition 窗口 ⊂ Contested 区间（tackle 路径整段落在里面）
契约：              Contested 不是 PossessionEpisode
```

`Contested` 与 `PossessionEpisode` 互斥是 P15A 状态机的基础：
`design §6` 状态转移表把 `Controlled` / `Contested` 分列，
`§9.1` 明写 `pass lost` / `tackle` 进 loose 时「关闭旧 episode，进入 `Contested`」，
`observation.rs` 里 episode 只在 `Controlled` 下开启（悬空 `Contested` 走 `reject` 分支）。
另见 `map.md:63`「争抢/二点球保留在竞争状态，不因单个事件随意切段」。

### 1.3 另三档在 #16 之前没有判据

`build_up` / `progression` / `final_third` 本质是战术概念，而 #16 之前可用的信号只有位置
（`Action.x/y`、`ControlFact.location`）。契约明禁「把球场区域直接等同为战术阶段」
（`map.md:64`，grilling 契约，作者 Xingkai98，2026-09-24）。
照做会得到 **~2–3% 标签 + ~97% `unknown`** 的空转机器。

---

## 2. 需要 grill 的决策

### Q1（核心）Phase 的挂载模型

> **Phase 是否必须完全挂在 `PossessionEpisode` 内，还是需要一个与 possession 正交的
> transition observation 层？**

三个候选，代价已核：

| 方案 | 代价 |
|---|---|
| **1. 扩张 possession** 以覆盖 contested 区间 | **破坏已验证契约**。`Controlled`/`Contested` 互斥是状态机基础；改了连带 episode 数/时长/起止原因/动作归属，以及 P17A 全部统计。需重生成并确认哪些历史结论失效 |
| **2. 引入正交对象**（如 `TransitionSpan`） | 不动 possession 语义，但引入**新的对象类型与嵌套/相邻关系**，需要新的不变量与边界 fixture。跨 `Contested` 的表达能力是它的价值，也是它的复杂度 |
| **3. phase 保持现状，转换另行表达** | 最小改动：15B 只做 possession 内能判的部分（当前≈只有 `unknown`），转换语义留给别的层。代价是 15B 可能仍无产出 |

**须一并回答**：
- 若选 1：需要什么证据才敢动 P15A 契约？（至少：真实 tracking/event 数据证明转换阶段**应**覆盖争抢区间、
  新的状态不变量、重跑 0 gap / episode-contest 收束 / 300 seed 校准 / sidecar 确定性 / golden 门）
- 若选 2：`TransitionSpan` 与 `PossessionEpisode` 是**嵌套**还是**相邻**？跨 dead ball 怎么办？
  与 `RestartSequence` 的关系？谁负责开启/关闭？
- 若选 3：15B 是否还有存在意义？若无，是否应把「phase」整体推迟到 #16 之后再立项？

### Q2 三档 phase 的可判定性判据

`build_up` / `progression` / `final_third` 各自需要**哪些特征**才不退化成为「区域 = 阶段」？
候选方向（来自 2026-09-27 的一次外部咨询，**未验证**）：

- 按球队进攻方向归一化的**球门向净推进**；
- 连续动作窗口内的**推进 / 回撤 / 横向转移**；
- 推进是否伴随**线间距变化**；
- 推进后是否形成**前方接应或局部人数优势**；
- 球权开始后的**时间序列**，而非单帧空间快照。

**须回答**：这些特征足够吗？若不足，15B 应明确保留 `unknown`，还是先补数据/模型？
以及 `unknown` 的期望占比到多少算「15B 形式主义」、需要重新设计？

### Q3 与 #16 的顺序

三条路：

1. 先 #16，再 15B；
2. #15B + #16 合并为一个 change；
3. 保持 `#16 → 15B`，但给 **#16 加一个 phaseability gate**——先检验现有观测能否区分三档，
   够则设计谓词，不够则明确保留 `unknown` 或补数据。

**注意**：#16 是**必要非充分**。它给的空间特征（宽度/纵深/局部人数/最近防守距离/接应角度）
能支持「是否有组织接应」「是否受压」这类判断，但**不能自动定义**三档——
`build_up ≠ 后场`、`progression ≠ 球向前移动`、`final_third ≠ 前 1/3`。

---

## 3. 不在本票范围

- 不写实现（含 15B 标注器、`TransitionSpan` 落地、#16 特征）；
- 不改 P15A recorder、正式事件流或 golden；
- 不改 P17A 分析器或已生成基线。

---

## 4. 参考

- `.scratch/notes/behavior-realism-analysis-roadmap.md` §4.3（实测）、§4.5（暂停决定与三方案代价）
- `.scratch/notes/match-behavior-observation-design.md` §6（状态转移表）、§9.1（释放与关闭）、§11（phase 契约）
- `.scratch/map.md` 的 `12`（grilling 契约）、`15`（#15A/#15B 状态）
- `engine/src/observation.rs`：`PhaseSegment` / `Phase` / `PhaseProvenance` 预留与两条「必须为空」守卫
- `engine/src/lib.rs`：`Transition` / `TransitionSource` / `TRANSITION_TICKS` 与窗口清除时机
