---
title: 2D 足球模拟的业界现状：方向是不是错了
date: 2026-10-17
question: 做了两个半月还是不像真实足球，是方向错了吗？业界有没有 SOTA 的时间/模型分析？
status: completed
last_verified: 2026-10-17
sources: 44
tags: [soccer-simulation, robocup, football-manager, tracking-data, evaluation]
---

# 2D 足球模拟的业界现状：方向是不是错了

## TL;DR

**目标没错，模型类别错了。**

现在这个引擎是：**每秒一次决策 + 全体球员奔向一个解析公式算出的目标点 + 全场只有 1 个人逼抢 + 到目标 2 米内原地不动**。
这个模型类别在数值上无法产生足球的观感——不是参数没调对，是它表达不了目标。

三条可证伪的判断：

| # | 判断 | 证据 |
|---|---|---|
| 1 | 时间分辨率低 4–25 倍 | 本引擎 1 Hz；FM 4 Hz；RoboCup 2D 10 Hz；真实 tracking 10–25 Hz |
| 2 | 自由度用错了地方 | 30+ 个全局常量拟合一个需要 22 个独立决策者交互的系统 |
| 3 | 优化目标有退化方向 | 你自己的 `like-football` 距离最低 0.365 那版，画面是两队叠在球上 |

而且**这三件事你自己的仓库里已经证过了**（§2），不需要外部证据。

外部调研的两条结论：

- **坏消息**：全世界**没有**"学出来的全场 22 人 2D 比赛模拟器"。最长的学习式 rollout 是 GenTac 的 **5 秒**（arXiv 2604.11786，技术报告，非同行评审）。一场 90 分钟 ≈ 1000 个自回归窗。端到端学一个足球模拟器这条路目前不存在。
- **好消息**：你不需要学。工业界天花板 = **每球员局部决策（10 Hz）+ 球物理 + 用真实 tracking 数据标定与验收**。FM27 刚做完的正是这件事（用 Hawk-Eye 数据重做速度与加速）。

**关于「怎么设计这个模型」**：§7.5 是第二轮补充调研，给的是**可以抄的实现**——HELIOS agent2d 的
分层骨架（读源码验证）、Delaunay 关键帧站位、最小费用流盯人 + 变更惩罚、EQS 的候选点打分管线、
实测的 A0/S0 加速模型（不是恒速）、Bekkers 压迫强度公式、Spearman pitch control 的精确分段式
（1.1 ms/帧）、以及让横向目标依赖对手位置的那一档模型。

**另外：本报告里的证伪实验已经跑了**（§8，`tools/spike-10hz.mjs`）。一个 30 分钟写出、零调参、只有 10 Hz + 局部决策 + 加速度积分的玩具，在同口径下把 `mean|ln|` 从引擎的 **0.397 降到 0.278**，6 个结构量里 5 个更接近真实（只有 ballDist 略差）。但它**没修好横向移动**——这决定了下一步该做什么（§8.4）。

---

## 1. 你现在到底建了个什么（考古）

不是"一个没调好的足球模拟器"，是**一台事件槽机器**。逐条读代码可以确认：

### 1.1 时间：1 tick = 1 秒

```rust
// engine/src/lib.rs:606
pub const TICK_SECONDS: f64 = 1.0;
```

决策频率 1 Hz。参照系：

| 系统 | 决策频率 | 依据 |
|---|---|---|
| **本引擎** | **1 Hz** | `TICK_SECONDS = 1.0` |
| Football Manager | **4 Hz** | 官方博客：「每个球员和裁判每 **四分之一秒**做一次决策，我们叫一个 slice」 |
| RoboCup 2D | **10 Hz** | 官方文档：「一场比赛分 6000 个 cycle，每个 cycle 100 ms」 |
| Google Research Football | **10 Hz** | 论文：3000 帧 = 300 秒（5 分钟一场） |
| SimSpark (RoboCup 3D) | 50 Hz | camera 25 Hz 每 2 cycle 一帧，推导 |
| SkillCorner tracking | **10 Hz** | 官方 README（10 fps） |
| Metrica tracking | ~25 Hz | 社区常引（未在 README 声明） |

> ⚠️ 纠正：本仓 `research/2026-08-23-match-realism-testability/` 里写的「FM 每 1/6 秒一次决策」**是错的**。FM 官方原文是 quarter of a second = 0.25 s。差 6 倍。

### 1.2 运动：直接改坐标，没有速度、没有加速度、没有朝向

```rust
// engine/src/lib.rs:3816-3825（compute_mover_candidates 尾部）
let d = dist_norm(from, target);
if d < dead_zone { continue; }               // dead_zone = 2.0 m → 不产 mover = 完全不动
let step = d.min(norm_step(speed * TICK_SECONDS));   // RUN_SPEED_MS = 4.0 m/s × 1 s = 4 m
let (tox, toy) = move_toward(from, target, step);    // 沿直线推进，直接改坐标
```

后果：

- **每拍最多走 4 米**，恒速，无加减速。真实球员加速 ~5 m/s²，7 m/s 需要 1.4 秒——**在 1 Hz 下加速段完全不可见**。
- **到目标 2 米内就冻结**（`DEAD_ZONE_METERS = 2.0`）。视觉上是"滑到位置 → 停住 → 球动了再滑"。
- 没有朝向、没有惯性。所以转向是瞬时的，轨迹是折线。

这就是 CLAUDE.md 里记的「球员 120 秒轨迹是**水平细线**（在铁轨上滑动）」——它是这段代码的直接输出，不是渲染问题。

### 1.3 队形：一个由 12 个手调常量组成的解析公式 + 正弦抖动

`formation_target()`（lib.rs:3544）是这些项的线性混合：

```
目标x = base.x + 球侧平移 + 进攻压上 + 防线推进        // 旧式
目标x = 0.5 * 旧式 + 0.5 * 球相对块公式                // FORM_MIX_X = 0.5
目标y = 0.7 * 旧式 + 0.7-weighted 块公式               // FORM_MIX_Y = 0.7
      + sin(phase * 0.7 + id) * FORM_INDIV             // 个体"抖动"= 90 秒周期的正弦
```

常量：`FORM_MIX_X=0.5`、`FORM_MIX_Y=0.7`、`FORM_TRACK_Y=0.3`、`FORM_SPREAD_X=0.8`、`FORM_SPREAD_Y=1.3`、`FORM_CENTER_HOME=0.358`、`FORM_CENTER_AWAY=0.642`、`FORM_TRACK_X=0.5`、`FORM_CENTER_OFFSET=0.033`、`FORM_ATTACK_SIGN=1.0`、`FORM_INDIV=0.08`、`FORM_PHASE_PERIOD_S=90.0`、`FORM_PHASE_ID_STEP=37.0`，加上 `SIDE_SHIFT_FACTOR=0.06`、`DEFENSE_PUSH_FACTOR=0.12`、`PRESS_UP_OFFSET=0.02`。

**这是 16 个自由参数表达一个 22 人系统。** 每个球员不感知队友和对手（除了同队反推 repulsion），只感知球的位置——所以没有盯人、没有补位、没有越位线协调、没有二点球预判。

### 1.4 逼抢：全场 1 个人

```rust
// engine/src/lib.rs:895-899
const OPEN_PRESS_N: usize = 1;      // 只指派 1 名防守球员逼近持球者
const OPEN_PRESS_GATE: i32 = 1;     // 且仅当球在防守方本方半场
```

其余 21 人一律 `action = "run"` 走向 `formation_target`。这解释了 map.md 里记的数字：

> 持球拍中仅 **6.29%** 存在"防守方朝持球者移动"（`close_down` **215** vs `run` **58 961**，30 seed）

**开放比赛里没有人被指派去逼抢。** 你看到的 22 个点里，有 21 个在执行同一条队形公式。

### 1.5 事件：由槽位和高亮驱动，不是由空间涌现

引擎的主体是 `Highlight` / `slot` / `beat` 状态机，`execute_action_resolution` 按概率掷出射门/抢断/传球。位置是从事件**派生**出来的（为动画服务），而不是位置**产生**事件。

设计文档 `.scratch/design.md` 第 3 条原则写死了这个选择：

> **分区/事件采样，不做连续物理**。球和球员不是牛顿力学仿真，是"状态机 + 概率事件"。

**这是整个问题的源头。** 它导致了后来的全部耦合。

---

## 2. 你自己的仓库已经证过的三件事

这三条比任何外部资料都重要——它们是**可控实验**的结果。

### 2.1 横向移动差 24 倍（`openspec/changes/p38-formation-realism/notes/findings-final.md`）

| | 真实 | 引擎 | 差 |
|---|---|---|---|
| 后防横向移动（y-sd） | 14.7 m | **0.6 m** | **24×** |
| 纵向移动（x-sd） | 19.7 m | ~5 m | 4× |

机制已定位到 `SIDE_SHIFT_FACTOR=0.06` ⇒ 最大横向位移 1.2 m。**没有边路职责、套边、肋部跑动。**

### 2.2 把队形改对 → 引擎的足球行为崩掉

同一份 findings 的第 4 条：用纯目标公式把队形修到与真实同构（纵深 27.11 vs 25.94），同时

```
l1_tackle_dilution_and_slot_mix FAIL — 普通射门总数不足：94（应 ~1400，跌 93%）
l1_home_away_goal_asymmetry     FAIL
l1_fouls_and_cards              FAIL
l3_shot_ratios                  FAIL
4 passed; 5 failed
```

**队形与事件生成是死耦合的。** 这不是 bug，是"位置从事件派生"这个方向的必然结果。

### 2.3 单点改造被证伪（map.md · #19）

> **无连续可行区间**：米制 standoff 扫掠 `[5.35,5.95]` 步长 0.02 × 官方全套 × 三窗，最长连续段 **0.04 m ≪ 0.10 m**。

> 证明前六个 change（P15A→P18）推不动引擎**不是分析不够，是这个结构结**

**这就是"没有头"的正式证明。** 你已经用严格的方法证明了：在这个模型类别里，不存在把这些约束同时满足的参数点。继续扫参数是徒劳的。

---

## 3. 为什么会有"试来试去没头"的感觉——三个结构性原因

### 原因一：假设空间不包含目标

目标（"看起来像足球"）的本质是 **22 个独立决策者在 10 Hz 下的交互**。真实比赛每秒钟有约 22×4 = 88 个自由度在变化（位置 2 + 速度 2），且依赖邻居状态。

你的模型：16 个全局常量 + 1 个决策者（持球者）+ 1 个逼抢者。

**任何参数取值都无法让这个表达式产生盯人、压迫线、肋部跑动、二点球。** 这不是优化问题，是表达能力问题。

### 原因二：目标函数是退化标量

`tools/visual-review/like-football.mjs` 定义一个 7 项 `mean |ln(引擎/真实)|` 距离。注释里已经记录了它的失败：

> P143r 三版（v1 / v2g-g3 / FB4）都是「指标变好、用户看不出」
> 纯块配置距离 0.365（全场最低）但画面是两队叠在球上——标量有**退化方向**

7 个数压缩掉了 22×4×10 = 880 维/秒的轨迹信息。任何低维投影都会有退化方向，**优化它必然被钻空子**。你后来不断加指标（`lat`、`mix`、`gap`），是在给一个本来就该换掉的损失函数打补丁。

### 原因三：努力被分配到测量而不是建模

| 项 | 行数 |
|---|---|
| 引擎源码 | 20,128（其中 `observation.rs` 7,537 = **37% 是观测/诊断**） |
| 引擎测试 | 24,093（**比引擎还多**） |
| viewer 生产代码 | 6,738 |
| viewer 测试 | 6,276 |
| tools（测量/探针） | 21,159 |
| openspec 规格 | 60,015 |
| .scratch 笔记 | 21,386 |
| 一次性探针脚本 | **70 个**（`probe-rail-ness` / `swarm-test` / `sweep-*` / `exp89-*`） |

**73 天，112 个 PR，规格 6.0 万 + 笔记 2.1 万 + 工具 2.1 万 + 测试 3.0 万 = 13.2 万行；引擎生产代码 2.0 万行。** 围绕引擎的行数是引擎本身的 6.5 倍。

最近 17 天（10-01 → 10-17）：83 次提交，只有 11 次碰 `engine/src/lib.rs`，且最后一次是**纯注释**。

`verify.sh` 里有三套判据被显式降级为「只打印，不阻塞」：

- P37 half-split（`design D7`）
- P38 八条队形判据（`#91`）
- P18 行为判据（`design §3.4`）

理由是"引擎现状本来就达标不了，立成硬门会一直红"。**你造了尺子，尺子说你不行，然后你把尺子降级了。** 这是这个项目最危险的信号：它意味着项目已经从"改进引擎"漂移成"维护一套关于引擎不行的文档"。

---

## 4. 业界 SOTA：三大家族，以及它们各能给你什么

### A 族：物理 / agent 仿真（全场比赛，但动力学是手写的）

代表：RoboCup 2D（rcssserver）、Google Research Football、Football Manager、SimSpark。

**共同点**：**每个球员是独立 agent，在每个 tick 做局部决策。** 结构不是加出来的，是交互涌现的。

**RoboCup 2D**（最接近你要的东西）：

- 105×68 m 平面，球员半径 0.3 m，球半径 0.085 m
- 每 cycle：`u = v + a; p = p + u; v = decay·u; a = 0`，`player_decay = 0.4`，`player_accel_max = 1.0`，`stamina_max = 8000`
- 动作是 `turn` / `dash` / `kick` / `tackle` / `catch`，参数有界连续标量（`dash power 0–100`），**每个 cycle 每类只能一次**
- 感知带噪声（高斯 `dist_noise_rate 0.0125`），视野锥 60°/120°/180°
- 每队 11 个独立程序（HELIOS base：世界模型 → 基础动作 → 多 cycle 计划器 → 角色（门将/中卫/边翼/中锋）→ 队形表）

它的**已知缺陷**也值得你知道（因为它们同样会出现在你重写后）：盘状身体、无接触、`move` 是瞬移、球可以在一个 cycle 内穿过球员、纯 2D 无球高。

**Google Research Football**：C++ 游戏引擎（基于 GameplayFootball 定制），10 fps，19 个离散动作，5 分钟一场，策略只控制**一个**球员。仓库已归档（2025-06 停止推送）。

**Football Manager**：4 Hz 决策 + 渲染层插值。SI 官方 2026-10 公开的 FM27 改造就是**完全重做速度与加速**：

> "Player speed and acceleration have long been areas we wanted to bring more in line with real football movement. Using Hawk-Eye Innovations data, we've completely overhauled our systems inside the engine."
> "players will no longer accelerate unnaturally quickly to recover defensively, or be able to turn at unrealistic speeds when making an off-ball run"

**这句话几乎是给你写的**：商业 SOTA 也在解决"加速不自然、转向速度不真实"，而且他们的方法是**用真实追踪数据重做运动学**——不是调战术参数。

### B 族：轨迹生成模型（学真实数据，但只有几秒）

代表：Social LSTM → Social GAN → AgentFormer → MID/LED → TranSPORTmer → GenTac。

| 模型 | 数据 | 视界 | 结果 |
|---|---|---|---|
| TranSPORTmer (ACCV 2024) | 283 场 LaLiga，6.25 Hz | 观测 3.2 s → **预测 6.4 s** | ADE **2.42 m**，FDE 4.50 m |
| GenTac (arXiv 2604.11786, 2026-04) | 20 场（SkillCorner+Sportec+Metrica），25 fps | 自回归 **5 s** | 1 s ADE 0.15 m；但结构误差 1 s 已有 40.67 m²（队形面积） |
| SoccerMap (ECML PKDD 2020) | 740 场 EPL，10 Hz | 传球瞬间 | 输出概率**面**，不产运动 |

**重要负面发现**：
1. **没有**任何已发表的系统能从学到的动力学生成整场 22 人 2D 画面。5 秒 → 5400 秒差 3 个数量级。
2. "Football-U"这个常被引用的轨迹基准是**美式橄榄球（NFL）**，不是足球。别被数字骗了。
3. 精确度指标（minADE/minFDE）有系统性问题：CausalTraj 论文明确指出这些指标"忽略了预测轨迹能否联合构成一个合理的多智能体未来"；Victor et al.（Neural Computing & Applications 2021）发现足球轨迹预测**很难超过线性外推**。

**所以 B 族不是替代品。** 它的正确用法是：**给你一个比 7 个标量好得多的验收工具**，以及一组直接可用的防守几何量（pitch control / pressing intensity）。

### C 族：价值 / 空间模型（不算运动，只算价值）

xT（Karun Singh）、VAEP（Decroos, KDD 2019）、EPV（Fernandez & Bornn, Machine Learning 2021）、pitch control（Spearman 2018）、SoccerMap、TacticAI（Nature Communications 2024）。

**它们能给你什么**：
- **pitch control**：每个时刻"谁最先能到球场的每个点"——这是防守站位的物理依据，闭式解，零训练成本。用它替换你的 `formation_target` 里"防守球员该站哪"的部分，是**可立即实施**的最大单项升级。
- **pressing intensity**（Bekkers, arXiv:2501.04712）：由 pitch control 派生的每帧压迫概率——你的 `OPEN_PRESS_N=1` 的直接替代。
- **TacticAI**（DeepMind + Liverpool）：22 个球员作为图节点，生成角球站位。**仅限定位球**，且一次只调一队。别指望它是通用模拟器。

**TacticAI 的真实意义**：它证明"用图神经网络 + 真实 tracking 数据生成合理球员站位"在**受限场景**下已经达到"人类专家分不出真假"（5 人专家小组 F1 0.60 vs 生成模型 0.53）。这是你的可行目标的一个校准点。

---

## 5. 关键的验证方法论：你缺的不是指标，是"多尺度模式"

你的验证问题是**用 7 个聚合标量代替整个轨迹分布**。学术上这个错误有名字和标准解法：

**Pattern-Oriented Modelling**（Grimm et al., *Science* 310:987-991, 2005）：
> 模型必须**同时**复现多个尺度、多个层级组织上的多个模式，因为任何单一聚合输出都可以由许多结构完全不同的模型产生。

这就是**等终局性（equifinality）**：你调 `like-football` 距离到 0.365，是因为有无数个错误结构都能达到这个数。POM 说：单模式匹配不算验证。

**足球领域的最新证据**（Forcher et al., *IJSSC* 19(2):757-768, 2024，153 场德甲）：
- 全队紧凑度在成功与不成功的防守中**几乎没有差别**
- 只有**最靠近球的 5 名防守球员**有差别，效应量很小（−0.08 ≤ d ≤ −0.16）

**推论**：用全队聚合紧凑度当优化目标，恰好测的是**眼睛不看的那个尺度**。眼睛看的是局部 5 人几何——而你的模型连 5 人局部几何都没有。

**可用的替代指标**（GenTac §12.2 + TacSIm CVPR 2026 都在用）：
- stretch index（球员到质心的平均距离）
- 队形面积（convex hull）——真实德甲均值 **792.54 ± 227.24 m²**
- 队宽 / 队深
- 两两距离矩阵的 Frobenius 范数
- 队质心位移
- Kuramoto 同步序（速度方向一致性）
- 防线–中场线间距（真实均值 **10.22 ± 3.76 m**）
- 离球 5 人紧凑度（分尺度，不是全队）

**验收方式也应该换**：不是"跑 200 场看聚合"，而是**从真实帧出发做短视界 rollout**——给定 SkillCorner 某一帧的真实 22 人位置速度，让引擎自己跑 1/3/5 秒，比较结构量。这有明确的 pass/fail，且没有退化方向。

### 5.1 补记：本仓已经有一套更好的仪器（也是我第一轮漏掉的）

本仓 `.claude/skills/visual-review/SKILL.md` 的「像不像的验收」已经实现了**双盲判别测试**：
同一渲染器 / 单张单源 / 呈现顺序与来源统计独立 / 中性命名 / 24 张 12 真 12 假 / 零上下文裁判 /
报准确率 + 置信度 + 结构化依据；配套 `panel.mjs` 五条定位判据（P1 方正度、P3a 逐比特冻结、
P4 门将距门线、P5 异队最近距离尾部、R1 gap），并明确**不合成单一标量**。

这套方法在学术上有同名先例：**The Robotic Soccer Turing Test**（Rojas, Behnke; FU Berlin）——
用人类判别者区分真实比赛与模拟比赛的视频，作为机器人足球的"像不像"标准。本仓的做法
（尤其"顺序必须与来源独立、否则整轮作废"那条）与该传统一致，且比多数论文的评估更严格。

⇒ 因此 §5 的建议应修正为：**不要另造仪器**。本仓已有的面板 + 双盲判别就是正确方向，
缺的是把它用在**模型改造的每一版**上（当前它只在验收期用），以及把它扩展到 §8.4 的横向维度
（面板现在没有直接管横向尺度的硬判据，`width` 只报不断言——本仓 SKILL.md 自己写了这一点）。

---

## 6. 你已经有别人没有的东西

`tools/fetch-tracking-data.mjs` 能拉：

- **SkillCorner Open Data**：20 场，10 Hz，22 人 + 球，MIT 许可
- **Metrica sample data**：3 场，含 events

**这是这个项目最大的资产，而它现在只被用来"并排播放"和提取 4 个标量。**

20 场 × 90 分钟 × 10 Hz ≈ **108 万个真实帧**，每帧 46 个数（22 人 × 2 + 球 × 2）。这是训练/标定/验收连续模型的完整数据。

**方向建议的核心一句话**：把这份数据从"参考视频"变成"目标函数"。

---

## 7. 三条路线

### 路线 A：提高分辨率 + 局部决策 + 连续运动（推荐，§8 已部分验证）

保留：viewer（13k 行）、事件协议、测试基建。
替换：`formation_target` / `compute_mover_candidates` / `TICK_SECONDS`。

新增三层：

```
Layer 0（新）：10 Hz 连续 agent 仿真
  每球员状态：pos(x,y), vel(vx,vy), heading
  每拍：局部感知（邻居 + 球）→ 决策 → 加速度 → 积分
  球：独立物理对象（速度、衰减、可选高度）
  → 输出：每拍 22 人 + 球的位置/速度

Layer 1（改造现有）：事件检测
  传球 / 射门 / 抢断 / 犯规 = Layer 0 的几何结果（距离、速度、朝向）
  不是掷骰子，是判定条件满足

Layer 2（不动）：viewer 渲染
  已经是按坐标画点，接 10 Hz 帧流即可
```

**成本**：核心循环重写（估 2–4 周密集中等强度），标定（1–2 周）。
**风险**：中等。这是 RoboCup 2D / FM 都走通的路，不是研究。
**关键点**：**不要**保留"事件槽"驱动。事件必须是几何的**结果**。

### 路线 B：数据驱动（学一个运动先验）

在路线 A 之上，用 SkillCorner 数据标定/拟合：

- 速度、加速度分布（按角色、按球距）
- 压迫触发条件（用 pitch control 计算）
- 队形参数（用 stretch index / 面积 / 线间距拟合）

**不需要深度学习**。查表 + 分位回归就能吃掉大部分。"学"的部分是**参数**，不是**策略**。

**成本**：3–4 周（在 A 之上）。
**风险**：低。这是确定性收益。

### 路线 C：端到端学习式模拟器

**不推荐。** 理由：全世界没人做出来过（§4 B 族），最长的 rollout 是 5 秒。你会在一个没有成功先例的问题上耗掉下一个两个半月。

---

## 7.5 模型设计参考：可以直接抄的 SOTA（第二轮补充调研）

> 第一轮只给了"三大家族"的粗分类。这一节补的是**怎么设计模型**——每一块都有验证过的实现、
> 具体参数或公式。凡标 **[源码验证]** 的是读了实现而不是读摘要。

### 7.5.1 骨架：HELIOS agent2d（唯一有公开源码的 11v11 @10 Hz 完整架构）

[源码验证] `SamplePlayer::actionImpl()` 每拍 12 行，层次是：

```
Strategy::update()          # 局面分类（6 态）+ 队形点
FieldAnalyzer::update()     # 预计算几何：越位线、可射区
doPreprocess()              # tackle / 转向 / 接球意图 → 提前返回
ActionChainHolder::update() # ← 只有"能踢到球的人"才走这里
role = createRole()          # shirt number → 角色名 → 工厂（查表，不是优化）
role->execute()              # 角色行为
```

**关键设计：贵的东西只给一个人跑。** 链搜索只对"持球者"执行，其余 21 人每拍跑 3 条规则。

**无球决策**（`bhv_basic_move.cpp`）就是这三行，按顺序：

```cpp
if (Bhv_BasicTackle(0.8, 80.0).execute()) return;             // 1 能抢就抢
if (!有队友可踢 && (self_min <= 3 || (self_min <= mate_min && self_min < opp_min + 3)))
  { Body_Intercept().execute(); return; }                      // 2 逼抢/拦截
Body_GoToPoint(formation.getPosition(unum), dist_thr, ...);    // 3 回队形点
```

**整个防守性格由两个常量决定**：逼抢余量 `+3`、紧迫度 `self_min <= 3`。
Gliders2d 的前两步进化就是把这两个数字变成**变量**（pressing 默认 3 → 13，按位置分 7/23/4）。

**有球决策**（`action_chain_graph.cpp`）：深度 **4** 的最佳优先搜索、每拍上限 **500** 个节点、
**每拍从零重建**（不做增量）。动作集 `{Hold, Dribble, Pass, Shoot, Clear}`；
评分是**一个标量，作用在预测的球位置上**：

```
+1e7 球进对方门
-1e7 球进自家门
否则： ball.x + max(0, 40 - 球到对方球门距离)
      + 1e6  若从该位置可射门
      + 5e5  若该位置是我自己
```

**风险提示（对你的直接启示）**：这个评分几乎总是"越靠前越好"，所以回传/横向保持被系统性低估——
这与你的引擎"射门/抢断偏低、传球成功率偏高"是**同一类病**：单标量评估器塌缩。
HillStone 的对策是显式的射门成功率 `S = A/α + B/d + C·θ`（α 射门角、d 距离、θ 门将让出的角度）
加一条**回传逃生**：若最佳三步路径价值低于阈值，回传重建。

### 7.5.2 站位：Delaunay 关键帧插值（最便宜的"角色 + 空间约束"）

`FormationDT`：每个局面一组合成（球在若干关键位置时 11 个站位），**Delaunay 三角化 + 重心插值**，
O(1) 查表，运行期零搜索。作者用 `fedit2` 手工编辑；11 个局面各一个 `.conf`。

**这正是你缺的那一层**：不是"公式算出目标点"，而是"**由人给定的站位表 + 连续插值**"。
它便宜、可读、可手调，而且天然支持"边路职责"这种你想加但加不进去的东西（§8.7）。

### 7.5.3 盯人：最小费用流 + **变更惩罚**（一天能实现，且能直接治你的病）

Tanaka et al. 2015（JSAI SIG-SAI）把盯人分配建成**不完全二分图上的最小费用流**（Ford–Fulkerson），
并明确写了失败模式：

> "From one assignment plan to another, targets that players have to mark can be reconsidered.
> **If too many modifications occur, the markers only wander around the soccer field** without
> having the possibility to reach their target."

**对策就是给"换盯人对象"加一项惩罚成本。** 早先用匈牙利算法要求完全二分图，被迫给不该考虑的配对打分；
换成不完全图 + 流之后，可以显式删掉不合理的边，改动次数下降。

对你的意义：你的 `formation_target` **没做「盯人」分配**（全体奔向各自基准点），所以没有「盯人对象」这个概念。
⚠️ 注意措辞：引擎**已经有**开放局逼抢（`OPEN_PRESS_N = 1`，2026-10-11 起），缺的是「认领某个进攻者」，不是「没人逼抢」。
**这一条是可以独立于重写先做的**，而且它自然产生横向位移（盯人对象在横向移动）。

### 7.5.4 承诺与重规划：不要每拍 argmax

- **agent2d 是"每拍全重建"**（cautious），而且它靠"世界变化慢于 100 ms"来保持连贯——不是显式承诺。
- **Golog 混合架构**（Dylla, Ferrein & Lakemeyer, AAAI-02）给出了更好的写法：计划生成后，
  **每拍用真实世界重新给"计划的下一步"打分**，效用掉了就放弃计划。
- 承诺分类（Kinny & Georgeff）：bold / cautious / **single-minded**（只在不可行时重规划）。
  **实际能用的形式是 single-minded + 迟滞**：不可行 **或** 挑战者连续 N 拍超过现任 δ 才换。
- agent2d 的 `δ/N` 就是 2 拍局面迟滞 + `self_min < opp_min + pressing`——不是理论，是迟滞，够用。

### 7.5.5 点选择：EQS 的 `生成 → 过滤 → 打分 → argmax`（工业级，文档完整）

Unreal 的 Environment Query System 是"选一个点去站位"这件事的**完整公开规范**：

1. **Generator** 产出候选点（队形点、Voronoi 顶点、拦截点、盯人目标的身后点…）
2. **Context** 定义参照系
3. **Test** 分 `Filter Only` / `Score Only` / `Filter and Score`，且**先过滤后打分**
4. 归一化：`Absolute` 或 `Relative to Scores`
5. 响应曲线：Constant / Linear / Square / Inverse Linear / Square Root
6. **Scoring Factor 可以是负数**
7. Reference Value 用帐篷函数（最接近参照值最高分）

**对你的意义**：你的 `formation_target` 是把几项线性加权——那是"一个写死的打分器"。
EQS 的形状是"**候选集 + 逐项归一化打分 + 权重**"，可以热调、可解释、且天然支持
"这一项这个球员不适用就给负权重"。

### 7.5.6 通信：只共享感知，不共享计划

[源码验证] agent2d 的 `sample_communication.cpp`：固定长度的类型化消息（Ball / Pass / Intercept /
Goalie / Stamina / Recovery…），**每拍选一个发言人**（避免 11 人同时广播），按优先级塞进
**10 字符/拍**的预算里。触发条件是**惊讶**而不是定时：球速突变 >0.1、方向变化 >20°、
且最后触球者是对手、且当前无对手可踢。

**收到的信息用来干什么**：把自己的"陈旧球位"换成队友的新鲜报告（`audio_memory`）。
⇒ **集体不确定性低于任何个体。** 这条对你的价值：如果将来做"信息受限"的球员 AI，这是现成方案。

### 7.5.7 个体运动学：用实测的 A0/S0 模型，别用恒速

实测（GPS/光学追踪，职业球员）：

```
dv/dt = A0 · (1 − v/S0)      A0 ≈ 7.2 m/s² (6.3–7.6)   S0 ≈ 9.5 m/s (9.2–9.8)
```

- 等效时间常数 τ = S0/A0 ≈ **1.32 s**；从静止到 8.5 m/s 需 **~3 s**、**26 m**
- 顶级球员极速 **9.0–9.5 m/s**；一场平均 **176 次高强度跑、57 次冲刺**，**平均冲刺长度仅 5.9 m（≈0.8 s）**
- 极速只在**疾跑中段**出现 2–4 s，之后 3 秒内就掉下来——**不存在"匀速奔跑"**
- 减速比加速强：峰值 **8–9 m/s²**，但持续制动 3–5 m/s²
- **转向靠侧向加速度限制**：`a_lat ≈ 6–8 m/s²` ⇒ 转弯半径 `R = v²/a_lat`
  （4 m/s → 2.3 m，8 m/s → 9 m，9.5 m/s → 12.9 m）。**意图 90° 的切入，实际只转 14.6°–40.5°**
- 疲劳：UCL 15 分钟分箱，**总跑动 −14%、高强度跑 −15%**（末段 vs 首段），
  且**中场休息有回弹**、61–75 分钟有**二次低谷（−21%）**——不是单调衰减

对照你的引擎：恒速 4 m/s、无加速无朝向、2 m 死区。**RoboCup 2D 自己都比你更接近人类**
（它 0.33 s 到顶速、0.38 m 转弯半径，比人快 6–8 倍——但至少是连续的）。

### 7.5.8 球物理

- 阻力：`Cd` 从 **0.5（6.1 m/s）降到 0.2（9.1 m/s）**，档位之间可线性插值
- 加速度量级：`a_drag = 0.0133·v² m/s²`（25 m/s 时 8.3 m/s²；12.5 m/s 时 2.1 m/s²）
- 滚动阻力（草地）：**未能验证到可信实测值**；物理估计 μ_roll 0.05–0.15 ⇒ **0.5–1.5 m/s²**，
  建议用**恒定减速 0.8 m/s²**，不要用 RoboCup 的指数衰减（它 27 m/s 能滚 42 m，偏长）

### 7.5.9 代价参考（最有说服力的两个数字）

| 数据点 | 数字 |
|---|---|
| FRA-UNIted 重新实现**一个**战略行为（无球行为：拦截/接应/盯人/对抗/跑位） | **84–113 学生·小时**，且需要熟手指点；原文："hardly be accomplished by novices"。<br>⚠️ 该数字来自 RoboCup 团队描述文档（TDP），**未能在本机核到原文链接**（环境不能解析 PDF）；引用时请标注「二手/未复核」 |
| Gliders2d 从 agent2d 拿到 **+4.2 球/场** | **6 处手选的标量改动**，每步用 **1000 场**验证 |

⇒ 两个结论：(1) 一个人的项目做不出完整的 RoboCup 级别 AI；(2) **但 +4.2 球/场的杠杆常常是
"把常量变成变量 + 按角色/区域条件化"，不是结构创新**。前提是**先有 1000 场评估夹具**。

### 7.5.10 没有公开答案的部分（别在这些上花时间找资料）

| 问题 | 状态 |
|---|---|
| EA FC / FIFA 的球员决策架构 | **完全无公开文档**。两个 EA 专利都是"用真实追踪数据回放"和"广播互动"，与 agent AI 无关 |
| Football Manager 内部 | **只有 FM21 博客那一层**：4 Hz slice、按属性选动作、允许 slice 内改主意。**博客从没说"效用函数/打分"**——说它是效用 AI 是推断 |
| MCTS 用于足球 | **没有可验证的 RoboCup 2D 战绩**。CVPRW-2026 的 Monte Carlo Pass Search 是**分析**用（世界模型和价值模型都是学出来的） |
| BDI 在 11v11 2D | **没有任何 BDI 队伍拿过好名次**。所有前 10 都是行为式或 MDP |
| IAUS 的确切公式 | 一手文本拿不到（403 / 只有视频）。用 EQS 代替引用 |

---

### 7.5.11 站位与空间：三档模型（从最便宜到最贵，都能查表实现）

这一档是你最缺的，也是"横向不动"（§8.4/§8.7）最可能被解决的地方。

| 档 | 模型 | 实现难度 | 代价 | 产出 |
|---|---|---|---|---|
| 0 | **Voronoi / 最近球员分区** | 1/5 | O(P log P) | "这块地归谁" |
| 1 | **Bekkers 压迫强度** | 1/5 | 每对球员闭式解 | 每个对手被压迫的概率 |
| 2 | **Spearman pitch control** | 3/5 | **1.1 ms/帧**（Numba，105×68 网格，22 人实测） | "球到任一点时谁先到"的概率场 |
| 3 | **Taki 支配区域**（含加速度） | 3/5 | 10–100 ms/帧 | 时间分割的严格版 |
| 4 | **SPP 跑位模型**（采样 200 点，PP×PI 打分） | 4/5 | 重 | 该往哪跑 |

#### 档 0：Voronoi——便宜但**高估 2.3 倍**

Caetano et al. 2021 实测：Voronoi 平均每格 **171 m²**，按到达时间算的支配区域只有 **73 m²**，
且有 **5,537 m² 无人区**。Voronoi 只是"所有人速度为零"时的特例。

#### 档 1：压迫强度（一天能实现，直接替换你的 `OPEN_PRESS_N=1`）

Bekkers, arXiv:2501.04712，逐对球员闭式解：

```
τ_ij = |d| / v_max                    d = (对手位置+速度·τ_r) − (防守者位置+速度·τ_r)
τ_β  = |v_i| · β / π                  β = 速度方向与"去拦截方向"的夹角
T_ij = τ_r + τ_ij + τ_β
p_ij = [1 + exp(−(π/(√3·0.45))(1.5 − T_ij))]^{−1}     # σ=0.45，在 T=1.5 s 处评价
P_j  = 1 − Π_i (1 − p_ij)                              # 至少一人能在 1.5 s 内拦截
```

`P_j` 就是"对手 j 被压迫的概率"。**你的 `OPEN_PRESS_N=1` 可以换成：所有 P_j > 阈值的防守者
都进入压迫。** 实现成本一天；unravelsports 有参考实现。

#### 档 2：pitch control（有验证、有开源、够快）

时间-拦截的精确分段式（Spearman；Rego 论文 §3.2.3 给了推导）：

```
p_i' = p_i + v_i·τ_r                       # 反应时间内继续走
d = |r − p_i'|,  u = (r − p_i')/d,  v_∥ = v_i·u
T0 = (v_max − v_∥)/a_max ,  D0 = v_∥T0 + ½a_max·T0²
if v_∥ ≥ v_max:  T = d/v_max
elif D0 > d:     T = (−v_∥ + sqrt(v_∥² + 2·a_max·d))/a_max
else:            T = T0 + (d − D0)/v_max
τ_exp = τ_r + T
```

默认参数：`a_max = 7 m/s²`、`v_max = 5 m/s`、`τ_r = 0.7 s`（无加速度的简化版则
`τ_exp = τ_r + |r − (p+vτ_r)|/v_max`，Shaw 的参考实现就是这版）。

概率化：`f(T) = [1 + exp(−(π/(√3σ))(T − τ_exp))]^{−1}`，`σ = 0.45`。

**性能已实测**：`mkh1991/pitch-control` 在 M3 MacBook Air 上 **1.1 ms/帧**（Numba）/ 12.3 ms（NumPy），
105×68 网格 22 人。⇒ 90 分钟 25 Hz 一场约 2.5 分钟。**你的 10 Hz 只更低。**

**验证程度**：用传球成功率间接验证——Spearman 2017 报 **0.819**（基线 0.789）；
Rego 复现 0.813 / AUC 0.863。注意这是"验证了传球接球"，**不是验证了控制面本身**。

#### 档 3：支配区域（Taki & Hasegawa 2000；Fujimura & Sugihara 2005 闭式解）

定义：`D_k = { x : t_s(x,p_k) < t_s(x,p_m) for all m≠k }`，`t_s` 是在最大努力下的最短到达时间。
Fujimura 的闭式可达圆盘（`α≈1.3 s⁻¹`、`v_max≈7.8 m/s`）把每帧代价压到可用范围。

**为什么这一档可能治好你的横向问题**：目标位置**依赖对手的位置和速度**，对手横移 → 目标横移 →
球员横移。而你现在的 `formation_target` 只读球位，所以横向最多 1.2 m（`SIDE_SHIFT_FACTOR=0.06`）。
**这是一个可检验的假设**（§8.7 的负结果只否定了"静态宽度目标"，没否定这一条）。

#### 队形的实测数字（可直接当靶子）

153 场德甲 25 Hz：线间距 防–中 **10.17 ± 3.87 m**、中–前 **13.21 ± 4.21 m**、防–前 **23.50 ± 5.88 m**；
队形面积 **792.54 ± 227.24 m²**；队长 **32.49 ± 8.69 m**；队宽 **37.34 ± 4.83 m**。
防线高度（西甲 2,413 段）：绝对 **46.95 m**、相对球 **26.93 m**。

**队形识别**两个现成方法：Bialkowski 最小条件熵 + 匈牙利（**75.33%** 与专家标注一致，
4-4-2 占 50.37%）；EFPI 模板匹配（1/5 难度，实时）。

#### 盯人：匈牙利 / 最小费用流（第 6 节已述）

代价函数的四种选法（都是设计选择，没有唯一正确答案）：
时间-拦截 `τ_exp(i→j)`；距离 `|p_i − p_j|`；风险加权 `τ_exp − λ·threat(j)`；区域约束 `τ_exp + μ·|zone|`。
**再加一项"换人惩罚"**——这是 §7.5.3 那条。

#### 越位线：现成算法

Shaw 的实现：把所有防守者按深度排序取**倒数第二深**，与球位、中线取 max，**加 0.2 m 容差**。
（对应 IFAB Law 11 的"倒数第二名对方球员"。）

#### 这一档的空白

- **没有**"压迫还是保持"的形式化最优模型（没有同行评审论文）。上面 `P_j` 阈值式是工程近似。
- **没有**弹簧-质量的"弹性队形"模型；EFPI 的 "elastic" 只是模板缩放。
- 支配区域**没有**维护良好的开源实现；pitch control 有 5 个以上。

## 8. 证伪实验：已经跑了（`tools/spike-10hz.mjs`）

原计划花 1–2 天做这个 spike，实际用约 30 分钟写出并跑了。**结果支持"模型类别"这个判断，但有一项明确不支持**——见下方"不支持的部分"。

### 8.1 实验设计

一个 ~200 行的独立最小仿真器（**不碰 `engine/`**），只保留三项与本引擎不同的结构选择：

| 选择 | 本引擎 | spike |
|---|---|---|
| 决策频率 | 1 Hz | **10 Hz** |
| 球员决策 | 全体奔向同一个全局公式的目标点 | **每球员局部规则**（守方最近 3 人压迫持球者、其余盯人 + 越位线；攻方 2 人接应、其余按阵型随球平移） |
| 运动 | 每拍直接改坐标、恒速 4 m/s、到目标 2 m 内冻结 | **加速度积分**（上限 5–6 m/s²，近目标自动减速） |

**没有**传球物理、没有规则、没有事件模型、**零调参**。

口径完全复用本仓 `viewer/match-metrics.js`：同一份指标代码、5 Hz 采样、300 s 窗。真实锚 = committed 基线 `viewer/data/benchmark-baseline.json`（SkillCorner 20 场 139 窗），跑 5400 s（6 窗）。

### 8.2 结果

**口径 `perMetricAllPoints`**（P38 认定这才是公平靶子：全点 25.4 ≈ Metrica 25.94；`perMetric` 因跳过外推点系统性压小纵深）：

| 指标 | 真实 | 引擎 | 引擎比 | spike | spike比 | |
|---|---|---|---|---|---|---|
| hd 主队纵深 | 25.8 | 38.7 | 1.50× | **31.7** | **1.23×** | ✅ |
| ad 客队纵深 | 25.6 | 36.4 | 1.42× | **31.7** | **1.24×** | ✅ |
| spread 紧凑度 | 14.8 | 20.7 | 1.40× | **18.6** | **1.26×** | ✅ |
| **gap 分边** | 6.9 | **18.9** | **2.74×** | **3.3** | **0.47×** | ⚠️ 反向过冲 |
| width 宽度 | 37.9 | 49.6 | 1.31× | **46.3** | **1.22×** | ✅ |
| ballDist 球距 | 18.4 | 18.6 | 1.01× | 19.9 | 1.08× | ≈ |
| **mean\|ln\|** | | | **0.397** | | **0.278** | |

`perMetric`（primary）口径下同样方向：引擎 0.623 / spike 0.413。

运动量（12 s 窗中位）：

| 量 | 真实 | 引擎 | spike |
|---|---|---|---|
| lat 横向位移占比 | 0.43 | 0.37 | **0.27** ❌ |
| mix 混队度 | 0.80 | 0.80 | 0.75 |
| disp 每窗端点位移 | ~13.5 m | **6.5 m** | **19.2 m** |

### 8.3 支持的部分

1. **「机械分边」（gap）确实是全局公式的产物。** 引擎 2.74×，spike 0.47×——一个 3 人压迫规则把它从"两队被机械推开"直接翻到"两队过度纠缠"。**这是本报告里唯一一个被干预直接改变的量**，而且它正是 `like-football.mjs` 注释里记的"用户一号抱怨"。
2. **位移量级回到了正确区间。** 引擎每 12 s 窗只走 6.5 m（真实 ~13.5），spike 19.2 m。1 Hz + 2 m 死区让球员大部分时间是静止的，这是"看着不像在踢球"的直接来源。
3. **零调参**。spike 没有任何一个数字是对着指标调出来的（阵型是按真实球队尺寸摆的，压迫是 3 人，就这些）。它的 0.278 是结构选择的副产品，不是拟合结果。对比：引擎用了 ~30 个常量 + 73 天，落在 0.397。

### 8.4 **不支持的部分（重要）**

**横向移动没有自动出现。** `lat` 引擎 0.37、spike **0.27**、真实 0.43——**spike 更差**。

这说明：**提高频率 + 局部决策并不能自动产生横向跑动。** "盯最近的人"是个纵向主导的规则，它不产生边路宽度、套边、肋部跑动。横向必须来自**显式的通道职责**（边锋保持宽度、边后卫插上、中场拉开肋部）——那是一个**设计任务**，不是调参任务，也不是"提高分辨率"的副产品。

这一条同时解释了本仓 own width 的困境：`like-football.mjs` 自己写着"摘掉 width 后标量里没有直接管横向尺度的项……**能算、会打印、无人断言**"。

### 8.5 结论怎么用

- **它没有证明"重写就好了"。** spike 没有事件、没有规则、没有传球物理，它产生不了比赛。它只是一段位置流。
- **它证明了模型类别这个变量是真的。** 在一个其余全部保持最笨的最小实现里，仅换掉"1 Hz 全局公式 / 固定速度"这三项，6 个结构量里 5 个更接近真实（只有 ballDist 略差），`mean|ln|` 从 0.397 降到 0.278，且**没有任何调参**。
- **它同时暴露了下一层真问题**：横向（宽度/通道职责）不会涌现，必须显式设计。这正是你下一步要做的**设计决策**，而不是继续扫参数。

### 8.6 换成**本仓自己的验收口径**重算

§8.2 用的是 6 个结构量。本仓真正的验收工具是 `like-football.mjs`（8 行含运动量、primary 口径、
`mean|ln|`，width 为报告行不进距离）。把 spike 放进同一张表（真实锚 = SkillCorner 结构基线 +
Metrica 运动帧，即本工具的实际锚）：

| 类别 | 指标 | 真实 | 引擎 | \|ln\| | spike | \|ln\| |
|---|---|---|---|---|---|---|
| 结构 | 纵深(主) | 18.31 | 38.70 | 0.748 | 31.7 | **0.549** |
| 结构 | 纵深(客) | 18.45 | 36.39 | 0.679 | 31.7 | **0.541** |
| 结构 | 紧凑度 | 12.76 | 20.73 | 0.485 | 18.6 | **0.377** |
| 结构 | **分边★** | 5.24 | 18.88 | **1.282** | 3.3 | **0.462** |
| 结构 | 球距 | 14.97 | 18.62 | **0.218** | 19.9 | 0.285 |
| 运动 | **位移/窗★** | 13.33 | 6.27 | 0.754 | 19.2 | **0.365** |
| 运动 | 横向占比★ | 0.42 | 0.37 | **0.127** | 0.27 | **0.442** ❌ |
| 运动 | 混队度★ | 0.80 | 0.80 | **0.000** | 0.75 | 0.065 |
| | **距离（8 行）** | | | **0.539** | | **0.386** |

（引擎侧 0.539 是 `like-football.mjs` 的实跑输出；spike 侧按同公式逐行算。）

**在这个口径下结论不变，但代价更清楚**：总分 0.539 → 0.386，最大改善是**分边**（1.282 → 0.462）
与**位移**（0.754 → 0.365）；**唯一明确退步是横向占比**（0.127 → 0.442）。

⚠️ **别只看总分**。本仓 SKILL.md 自己写过：`lat` 能被"抖动"刷分（FB4 的 lat 0.35 逼近真实但画面
仍不对，因为 mix 从 0.65 掉到 0.61）。spike 的 mix 是 0.75（引擎 0.80、真实 0.80）——也略降。
所以 spike 的成绩单是"**结构修好了、横向没修好**"，不是"整体更好"。

### 8.7 横向：试了显式宽度职责，**失败了**（负结果）

按 §8.4 的推断，给 spike 加"显式宽度职责"（攻方按名义站位向外拉开、守方盯人与名义宽度混合），
扫 `WIDTH_GAIN ∈ {0, 0.30, 0.45, 0.60}`：

| WIDTH_GAIN | lat（真实 0.42） | mix（真实 0.80） | spread | 距离 |
|---|---|---|---|---|
| 0（基线） | 0.27 | 0.75 | 18.6 | 0.278 |
| 0.30 | **0.23** ↓ | 0.65 ↓ | 21.3 | 0.322 |
| 0.45 | 0.25 | **0.55** ↓↓ | 21.8 | 0.322 |
| 0.60 | 0.28 | 0.55 | 22.2 | 0.330 |

**结论：静态拉开宽度 ≠ 横向跑动。**

- `lat` 量的是 `|dy| / (|dx| + |dy|)`——球员走到边线**站住**之后就不再产生 `dy`，所以"阵型更宽"
  反而降低 lat。这是估计量的性质，不是实现 bug（本仓 SKILL.md 也记过 `lat` 可被"抖动"刷分）。
- 把两队推得更开直接摧毁 `mix`（混队度 0.75 → 0.55），也就是"两队各占一半球场"——正是
  本仓 `like-football.mjs` 注释里记的失败模式。

⇒ **横向不是一条规则能修的。** 真实足球的横向来自**随时间变化的位置交换**：套边、内切、
肋部换位、边中结合、转移球导致的整体横移。这些是**战术行为**，需要球员之间有**时序上的
承诺与交换**（谁套、谁补、什么时候换），而不是各自的静态宽度目标。

这条负结果同时说明：**§8 的全部结论都不能外推成"重写就好了"**。它只证明"分辨率 + 局部决策 +
连续运动"修好了结构量与位移量级；横向、以及由横向承载的"比赛流转感"，仍然是一个**未解决的
设计问题**——而它很可能才是"看起来像足球"的最后一段。

### 8.8 视觉证据（同一渲染器，12 s 窗 6 帧）

```
node tools/visual-review/render.mjs viewer/engine.wasm /tmp/cmp.png 42 600 12 6
```
上排引擎、下排真实（Metrica）。肉眼可见三件事：

1. **真实的 22 人在 12 秒里整块平移**（队形作为一个紧凑单元移动）；引擎的 6 帧几乎没变。
2. **真实是紧凑块**（两队在同一个区域缠斗，块内红蓝交错）；引擎散得开、两队分区更明显。
3. **真实的球跟着块走**；引擎的球在换位置而人不动。

这三条与上表 `disp`（0.47×，几乎不动）、`gap`（3.61×）、`spread`（1.62×）逐条对应。

复现：`node tools/spike-10hz.mjs 5400`

---

## 9. 工作量参考（估算，非承诺）

| 动作 | 估算 | 可验收产出 |
|---|---|---|
| spike（§8） | ✅ **已完成（~30 min）** | 6 结构量对比表，平均对数误差 0.397 → 0.278 |
| 横向/位置交换设计（§8.4 + §8.7；**不是调参，且已证不是一条规则**） | **2–4 周，且无先验方案** | `lat` 从 0.27/0.37 提到真实 0.42，同时 `mix` 不下降 |
| Layer 0 核心（10 Hz + 局部决策 + 球物理） | 2–3 周 | 22 人连续跑 90 分钟不崩、无瞬移 |
| 事件层改造（几何判定替代掷骰） | 1–2 周 | 射门/传球/抢断由位置产生 |
| 用 pitch control 替换防守站位 | 3–5 天 | 压迫覆盖从 9.7% 提升到真实量级 |
| 用 SkillCorner 标定运动学 | 1–2 周 | 速度/加速分布落在真实分位带内 |
| 短视界 rollout 验收改造 | 3–5 天 | 1/3/5 s 结构误差有数字 |

总计：**约 8–12 周**能到"不再有明显的铁轨感、队形有横向结构、压迫存在"（横向那段含不确定性）。对比：过去 73 天 112 个 PR 换来的现状。

**注意顺序变化**：原计划把横向放在"标定"里。§8.4 证明横向不会从局部决策里涌现；§8.7 进一步证明
**一条"显式宽度"规则反而让它更差**。所以横向被提到第二行，且估算从 3–5 天改成 2–4 周、并标注
**没有先验方案**——这是整条路线里唯一一段没有现成答案的工作。

---

## 10. 诚实的边界

本报告里哪些是硬证据，哪些是推断：

| 结论 | 性质 |
|---|---|
| 本引擎 1 Hz、1 人逼抢、4 m/s 恒速、2 m 死区 | **代码硬证据**（附行号） |
| 横向差 24 倍、改队形致射门跌 93%、"无连续可行区间" | **本仓实验硬证据** |
| spike 0.278 vs 引擎 0.397 | **本报告实测**，但见下面三条限制 |
| FM 4 Hz、RoboCup 10 Hz、GRF 10 fps | **一手来源**（官方博客/文档/论文） |
| 无端到端学习式全场模拟器 | **检索结论**（可能漏，但两路独立调研一致） |
| "调整合统计无法产生真实观感" | **推断**。没有同行评审论文直接这么说。支撑是 POM 标准 + Forcher 的弱区分度证据。标为推理，不是引用 |
| FM 内部引擎架构 | **未公开**。任何超出 0.25 s slice 的说法都不可靠 |
| 工作量估算 | **估算**，基于单人 + AI 辅助，置信度低 |

**spike 结果的三条限制（别把它读成"重写就好了"）**：

1. **它不产生比赛。** 没有事件、规则、传球物理、犯规、定位球。它只证明"位置流"这一层。
2. **样本小。** 6 个 300 s 窗、1 个种子；引擎侧是 5 种子 × 30 窗。方向性结论可看，数值别当精确值。
3. **它只测了 6 个结构量。** 真实验收该用 §5 的多尺度模式组（含离球 5 人紧凑度、pressing intensity）。6 个量本身就可能被钻空子——这正是本报告批评引擎的地方，我自己的实验也受同一限制。

---

## 11. 来源

**本仓（硬证据）**
- `engine/src/lib.rs:606` `TICK_SECONDS`
- `engine/src/lib.rs:895-899` `OPEN_PRESS_N` / `OPEN_PRESS_GATE`
- `engine/src/lib.rs:3544` `formation_target`
- `engine/src/lib.rs:3816-3825` mover 生成
- `engine/src/lib.rs:902-916` `norm_step` / `move_toward`
- `openspec/changes/p38-formation-realism/notes/findings-final.md`
- `.scratch/map.md`「行为真实性方向」
- `.scratch/notes/behavior-realism-analysis-roadmap.md` §6
- `tools/visual-review/like-football.mjs`
- `tools/spike-10hz.mjs`（本报告 §8 的证伪实验）

**外部（一手来源）**
- FM21 比赛引擎 AI（0.25 s slice）：https://www.footballmanager.com/news/match-engine-ai-fm21
- FM27 比赛引擎改造（Hawk-Eye 速度/加速）：https://www.footballmanager.com/fm27/features/fm27-tactical-tweaks-and-match-engine-upgrades
- RoboCup 2D 官方：https://rcsoccersim.github.io/blog/2024/SS2D/
- rcssserver 手册：https://rcsoccersim.readthedocs.io/en/latest/soccerserver.html
- rcssserver 默认参数：https://github.com/rcsoccersim/rcssserver/blob/master/src/serverparam.cpp
- rcssserver 19.0.0（bipedal dash）：https://github.com/rcsoccersim/rcssserver/releases/tag/rcssserver-19.0.0
- Google Research Football 论文：https://arxiv.org/abs/1907.11180
- GRF 仓库（已归档）：https://github.com/google-research/football
- TacticAI（Nature Communications 2024）：https://arxiv.org/abs/2310.10553
- SoccerMap：https://arxiv.org/2010.10202
- Pitch control 复述：https://arxiv.org/2501.04712
- Pressing Intensity（Bekkers）：https://arxiv.org/2501.04712
- GenTac（5 s 学习式 rollout）：https://arxiv.org/2604.11786
- TranSPORTmer：https://arxiv.org/2410.17785
- CausalTraj（指标批判）：https://arxiv.org/2511.18248
- Victor et al.（DL 打不过线性外推）：https://arxiv.org/2106.00173
- Pattern-Oriented Modelling（Grimm et al., Science 2005）：https://doi.org/10.1126/science.1116681
- Forcher et al. 2024（紧凑度弱区分）：https://doi.org/10.1177/17479541231172695
- TacSIm（CVPR 2026）：https://arxiv.org/2603.25199
- The Robotic Soccer Turing Test（Rojas & Behnke）：https://www.semanticscholar.org/paper/ab8308ad589eb296babaa19de038a036a622116f
- HELIOS Base（agent2d）：https://link.springer.com/chapter/10.1007/978-3-662-44468-9_46 ／ 源码镜像 https://github.com/KN2C2D/agent2d-stack
- Gliders2d（6 步 +4.2 球）：https://arxiv.org/abs/1812.10202
- CYRUS（传球预测 + 跑位）：https://arxiv.org/abs/2205.10953
- 盯人分配（最小费用流 + 变更惩罚）：https://www.jstage.jst.go.jp/article/jsaisigtwo/2015/SAI-023/2015_01/_pdf
- Golog 混合架构（React/Deliberate/Select）：https://cdn.aaai.org/Workshops/2002/WS-02-05/WS02-05-005.pdf
- Unreal EQS（生成/过滤/打分/曲线）：https://dev.epicgames.com/documentation/en-us/unreal-engine/eqs-node-reference-tests-in-unreal-engine
- 加速–速度剖面 A0/S0（职业球员实测）：https://pmc.ncbi.nlm.nih.gov/articles/PMC10880943/
- EPL 跑动量与极速实测：https://pmc.ncbi.nlm.nih.gov/articles/PMC11474994/
- 变向与制动实测：https://pmc.ncbi.nlm.nih.gov/articles/PMC6132493/
- UCL 疲劳分箱（−14%/−15%）：https://pmc.ncbi.nlm.nih.gov/articles/PMC9598698/
- Taki & Hasegawa 支配区域：https://doi.org/10.20965/jaciii.2005.p0159 ／ 综述 https://arxiv.org/abs/1602.06994
- Spearman pitch control（参考实现）：https://github.com/Friends-of-Tracking-Data-FoTD/LaurieOnTracking
- pitch control 实测性能（1.1 ms/帧）：https://github.com/mkh1991/pitch-control
- Bekkers 压迫强度：https://arxiv.org/abs/2501.04712
- Bialkowski 队形识别（最小熵 + 匈牙利）：https://doi.org/10.1109/ICDM.2014.133
- EFPI 模板匹配：https://arxiv.org/abs/2506.23843
- 线间距/队形面积实测（153 场德甲）：https://doi.org/10.1177/17479541231172695
- Voronoi vs 支配区域面积实测：https://doi.org/10.1038/s41598-021-97537-4
- SkillCorner Open Data：https://github.com/SkillCorner/opendata
- Metrica sample data：https://github.com/metrica-sports/sample-data

---

## 附：环境可运行性修复（2026-10-17，与调研同时做）

在干净 clone 上跑通 `verify.sh` 时发现三个问题，已修：

1. **`node_modules` 是一个指向 Linux 基建路径的已提交软链接**，在 macOS 上断链。
   根因：`.gitignore` 写的是 `node_modules/`（带斜杠只匹配目录），软链接不是目录，所以被提交了。
   修：`git rm --cached node_modules` + `.gitignore` 补一条不带斜杠的 `node_modules`。

2. **Rust 工具链是 2021 年的 1.53**，不支持 `edition = "2021"`，`cargo build` 直接失败。
   修：`rustup self update` → 移除已下线的 `rls-preview` 组件 → `rustup update stable`（→ 1.99.1）。

3. **`verify.sh` 在 Node ≥ 21 上会在第 2 步静默中止。**
   计数行正则写的是 `^(# (tests|pass|fail))`（Node 20 的 TAP 风格），而 Node 21+ 的默认报
   告器输出是 `ℹ tests 394`。grep 无匹配 → 退出码 1 → `set -o pipefail` + `set -e` → 整个
   脚本中止，且**什么都不打印**。失败详情回放用的 `^not ok` 同样匹配不到 spec reporter 的 `✖`。
   修：两处正则改成 `^((#|ℹ) (tests|pass|fail))`，失败回放改成 `^(not ok|✖)`。

另外记录一个**性能事实**（未改）：`verify.sh` 第 1 步跑的是 **debug** 版 `cargo test`，
其中 `p124_intent_observations` 等测试要跑 30 seed × 5400 s。在 M 系列 Mac 上整步约
**40 分钟**；同套测试加 `--release` 只需 **7 分 38 秒**（13 个测试二进制全绿）。
debug 版能抓整数溢出，这个语义不该丢——若嫌慢，建议给 dev profile 加 `opt-level = 1`
而不是把测试改到 release 跑。
