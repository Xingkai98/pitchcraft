# Grill Design: #15B phase 挂载模型

- Type: design
- Status: draft（**结论已成型，待用户 grill 确认**；确认前不写实现代码）
- Created: 2026-09-27
- GitHub issue: https://github.com/Xingkai98/pitchcraft/issues/113（`wayfinder:grilling`）
- 关联：`#15B`（暂停）、`#16`、`openspec/changes/p15-match-behavior-observation/`、
  `.scratch/notes/behavior-realism-analysis-roadmap.md` §4.3/§4.5

> **结论摘要（经三轮独立对抗审阅）**：
> `attacking_transition` **是 team-state，不是 possession phase**——它与已被 §11 排除的
> `defensive_transition` 是**同一窗口的两面**（该窗口同时驱动两队前进/收缩）。
> 因此**不删 `Phase` 闭集**（该 label 本就从不产出，删它只会让已记录的
> `sidecar_schema_fingerprint` 变陈旧），改为在 #15B design 标注「不作 possession phase 产出」。
> 顺序：`#16（含 phaseability gate）→ #15B`。
> 详细论证与实测见 ticket 后半 `## 结论（v4）`。

---

## 1. 触发本票的实测（facts，可复现）

### 1.1 `attacking_transition` 的窗口够不着「当前控球方」的 episode

> ⚠️ 本节初版写「结构上标不出来」，**已被后续实测修正**（见末节 v4）：
> 准确说法是**类型不对**（它是 team-state）+ tackle 路径**在此常数组合下**够不着，
> 而 save 路径**够得着**（98/98）。

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

## 2. 初始决策框架（**已被末节 v4 结论取代，保留以见推理轨迹**）

> ⚠️ 本节是**立票当时**（2026-09-27）列的问题框架。经三轮独立对抗审阅后，
> 末节 `## 结论（v4）` 已给出答案并修正了当时的若干误判。
> **以末节为准**；本节保留是为了让后来者看到问题是怎么收敛的。

### 原 Q1 挂载模型
（三候选：扩张 possession / 引入正交对象 / phase 保持现状。)**v4 的答案**：
两个都不是——`attacking_transition` **是 team-state**，与已排除的 `defensive_transition` 同源，
所以既不该塞进 possession，也不该作为 possession phase 产出。闭集**保留但不产出**。

### 原 Q2 三档 phase 判据
（候选特征：球门向净推进 / 推进·回撤·横向转移 / 线间距 / 接应与人数优势 / 时间序列。）
**v4 的答案**：**确认 #16 之前无判据**，全部推后；且 #16 是必要非充分。

### 原 Q3 与 #16 的顺序
（先 #16 / 合并 / 给 #16 加 phaseability gate。）**v4 的答案**：
`#16（含 phaseability gate）→ #15B`。

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

---

# 结论（v4，embedded from .grill/conclusion-v4.md）

> v1、v2 均被判 `NEEDS_REVISION`；v3 亦被判「轻 NEEDS_REVISION」（四处表述问题，已修）。
> 本版按三轮意见重写。
> **主结论三轮不变**（`attacking_transition` 是 team-state，不是 possession phase；
> 不删闭集；顺序 `#16（含 gate）→ 15B`），但**机制陈述两轮都写过头**，这版把
> 「结构性 / 常数性 / 路径分叉」三者分开，不再混为一谈。

---

## 一、问题的实质（分三层，勿混）

### 1.1 结构性的（与任何常数无关，稳定）

**(a) transition 是团队状态，一个窗口同时驱动两队。** 来自代码，非推断：

`struct Transition { ticks_left, attacking, source }` 是**一个**对象；只有两处武装点
（`lib.rs:4109` tackle、`:4267` save-caught），每次赋值都同时设定 `attacking`——**不存在单侧触发**。

窗口内同时生效（实测 close_down movers `from_defending=4353 / from_attacking=0`）：
- `if tr.attacking == my_team { press *= 2.0 }` → **得球方**前压（`lib.rs:3082-3083`）
- `pick_close_down_players(st, 1 - tr.attacking, …)` → **失球方**收缩（`lib.rs:3217`）

**(b) tackle 路径上，窗口起点那个 open episode 属于失球方。** 868/868。
这是**输入**决定的（tackle 在失球方仍持球时触发），与窗口长度无关。

### 1.2 常数性的（会随重标定翻转，**前一版误标为结构性**）

**窗口的其余拍是否触达得球方的 episode，由常数决定。** 定向变异实证
（我独立复跑，`LOOSE_MAX_TICKS 2→1`）：

| | `=2`（当前） | `=1`（变异） |
|---|---|---|
| tackle→下一个 episode | +4.0 s | **+3.0 s** |
| 是否落进窗口 `[t,t+4)` | ❌ 落区间外 | ✅ **落区间内** |
| 窗口内得球方 tick | **0 / 3472** | **886 / 3548** |
| 下一 episode 队别 == 得球方 | 0 | 886 |

因为 `gap = LOOSE_MAX_TICKS + 2`，当前 `2+2 = 4 = TRANSITION_TICKS` 是**巧合**。
**⇒ 「tackle 路径挂不上」成立于此常数组合，不是架构不变量。**

**但翻转条件不是「任何重标定」**（v3 此处写过头，已实测更正）。定向 sweep：

| `LOOSE_MAX_TICKS` | 0 | 1 | **2（当前）** | 3 | 4 |
|---|---|---|---|---|---|
| `gap = +2` | 2 | 3 | **4** | 5 | 6 |
| 窗口内得球方**拍数** | **909** | **886** | **0** | **0** | **0** |

（口径：窗口 `[arm, arm+4)` 的 4 个整数拍，逐拍判断是否落在属得球方的 episode 内；
逐常数变体均 `rm -rf target` 重编后实测。0/1 翻转，2/3/4 不翻。）

**翻转条件是 `gap < TRANSITION_TICKS`**（即 `LOOSE_MAX_TICKS ≤ 1`），**不是「任何变动」**。
上调不翻。这个更窄的条件同样必须写进 design——本仓 `dead-constants-must-not-be-mechanism` 的形态。

### 1.3 路径分叉（**save 与 tackle 相反**）

**save 路径的窗口整段落在得球方（门将）的 episode 内：98/98 窗口、392/392 拍。**
因为 save-caught 的窗口与「门将持球建立新 episode」**在同一拍武装**（`lib.rs:4267` 武装后
紧接着 `emit_beat_with_main`，注释明写「这记带球 beat 属于新 episode」）。

**⇒ 「`attacking_transition` 完全无法挂载」是错的**——save 路径上它就挂在得球方的 episode 里。
所以真正的问题**不是「够不够得着」，而是「它是不是 phase」**（见 §2）。

## 二、主结论：它是 team-state，不该作为 possession phase

`defensive_transition` 被 §11 排除，理由逐字为：

> 属于**失去球权**球队的团队状态，不应伪装成当前控球队 possession phase；留给后续 team-state observation
> （`match-behavior-observation-design.md:334`）

而 §1.1(a) 证明：**同一个窗口同时是「得球方的转换」和「失球方的转换」**。
把得球方那一面标成「控球方的 possession phase」，与排除失球方那面**是同一个类型错误**。

**正确的说法是「镜像 + 一处不对称」**（v2 已改对，保留）：
两者是对称的两面，**但得球方最终确实成为控球方**（口径：首个 `start ≥ 武装 tick` 的 episode，
实测 `same=965 / diff=0 / 无后继=1`；**注意该口径包含 save 路径在武装拍当拍开启的门将 episode**，
即它在窗口**内**而非「窗口结束后」），
失球方则不会。这给了 `attacking_transition` 一个 `defensive_transition` 没有的性质：
它描述的是**「将会控球、但尚未控球」**的那一方。

**⇒ §11 对两个 label 的处理不对称，且缺一条显式理由。** 若理由是「得球方将在窗口后进入 episode，
故值得留在闭集等待判据」，那么它与「phase 只能挂在 episode 内」的硬约束**在 tackle 路径上冲突**
（该窗口永不落入该队 episode，除非改常数——见 §1.2）。**冲突须写出来**，
而不是笼统说「不一致」——那是把需要论证的缺口当成已证明的矛盾。

**待决（用户）**：这条缺失的理由**回填 design §11（改已冻结的权威文档）**，
还是**在 #15B design 里记偏离**（不动 §11）？

## 三、处置：闭集不动，标记为「不作 possession phase 产出」

**不删** `attacking_transition`，理由（**经审阅修正，成本比 v2 说的低**）：

1. **行为等价**：该 label 从未产出（`observation.rs:1166`、两条「必须为空」守卫）。
2. **真正要改的是 2 处手写成员表**（v2 说 5 处，夸大了）：
   - `observation.rs:2964`（`check("Phase", &[…])`）——删变体会**编译失败**，必改；
   - `observation.rs:6029`（`same_set!("Phase", Phase::ALL, […])` 的成员行）——与 6024 是**同一处**断言。
   - `p17a/model.rs:679` 与 `p17a_behavior_chain_baseline.rs:989` 都用 `Phase::ALL`，**自动跟随，不会红**。
3. **改 `sidecar_schema_fingerprint` 会让已记录的基线指纹变陈旧**
   （当前 `fnv1a64:7c76518ceff85604`，见 P17A 报告 `:17`；删除后我实测为 `fnv1a64:d8140101f83a4582`）。
   ⚠️ **但没有任何测试写死该值**（全仓 grep 只命中报告与本文件）——所以删 label **不会让测试变红**，
   只会让**记录下来的**指纹对不上。v2 说「有守卫」是不准的。

**⇒ 推荐**：闭集不动；#15B design 写一行「`attacking_transition` 在 possession phase 层
**不作产出**（类型理由见 #113）」，`Phase::ALL` 注释指向它。

## 四、否决「扩张 possession 覆盖 contested」

三条理由（**最硬的一条 v1/v2 都漏了**）：

1. **类型缺陷**：`Contested` 是「控制**未**确认」，`PossessionEpisode` 是「控制**已**确认」，
   互斥由 §6 状态转移表、§9.1、`observation.rs` 的 `reject` 分支保证。合并是**把「未确认」塞进「已确认」**。
2. **会撞 §10 不变量与既有守卫**（最硬、最便宜可验）：「每时刻最多一个开放 episode」
   「restart 与开放 episode 不重叠」「episode/contest 收束」——改了会直接让
   `p15_behavior_observation.rs` 那批门变红。
3. **会毁 P17A 全部统计**：`metrics.rs` 逐条迭代 `m.episodes`，边界一改全重算
（报告 §8 有 v6→v7「判据未改、数值全变」的先例）。

## 五、顺序

- `build_up`/`progression`/`final_third`：**确认无判据**（#16 之前只有坐标，而「区域 ≠ 阶段」）。
- **save 路径子集**：技术上现在就能标（§1.3），但**不建议做**——它会把 team-state 标成 possession phase
  （§2 的类型错误），且会触发两条「必须为空」守卫。
- **⇒ 顺序**：`#16（含 phaseability gate）→ #15B`。

**§5 与 §3 不冲突**的原因写明：save 路径只证明**够得着**，不改变**类型不对**。
这恰说明类型问题比可达性问题更根本。

## 六、item 2 结论：**零新对象**，且能力比先前说法更强（2026-09-28 实测更正）

### 6.1 先更正本文件早前的两处错误说法

| 曾写 | 实测更正 |
|---|---|
| 「转换窗口是**负空间**表达」（与 roadmap §4.5 同） | **不是负空间，是正信号**。窗口自带一条专用 mover 动作，见 6.2 |
| （同轮对话中）「`close_down` 根本不在事件流里」 | **在**。20 场实测 **870 拍带 `close_down`，全部落在窗口内，窗口外 0** —— 它**恰是窗口的指纹**。（先前 grep 漏看 `actions[]` 赋值点 `lib.rs:3254`，只查了直接构造 `Mover` 的两处，是查错。） |

### 6.2 实测证据

**插桩对照**（在 `lib.rs` 的武装/清除点打日志，与事件流逐条对）：

```
Tackle 路径                      SaveCaught 路径
ARM   t=80  ← tackle 事件 @80     ShotSaved 事件 @1950
CLEAR t=84                        ARM   t=1951  ← +1
                                  CLEAR t=1955
```

**窗口的观测**（20 场）：

| 要回答的 | 从哪读 | 实测 |
|---|---|---|
| **窗口起止** | `tackle` 事件（同 tick）/ `saved shot` 事件 **+1**；终点 = 起点 + `TRANSITION_TICKS` | 插桩逐条吻合 |
| **转换形态** | `Mover.action == "close_down"` | 870 拍，**窗口外 0** |
| **参与者** | 该 tick 的 mover id | 样本：`t=81 player 11, 14` |

### 6.3 结论

**⇒ item 2 选「零新对象」。** 且理由**强于先前说法**：

- 先前说「能标是转换期，但说不出打得怎么样」——**也不成立**：`close_down` 已出口，
  「失球方有无组织收缩、谁在收缩」**都读得到**；
- **真正**读不到的只有**得球方前压幅度**（`press *= 2.0` 只改 `formation_target` 的目标点，
  不单独出流）——但可从 mover 的 `to_x/to_y` 推算，**不构成阻塞**。

⇒ **转换的完整观测已经现成**（起止 / 形态 / 参与者），新建 `TransitionSpan` 是重复建设。
「转换的具体内容」**不需要任何后续 issue 承接**；它作为证据归入 #15B 的 design 即可。

## 七、口径警告（v2 的机制讲错了，此处更正）

**v2 声称「事件晚一拍」——实测为假**：`EventType::Tackle` 在 `emit_tackle_highlight_impl`
内 `events.push`（`lib.rs:4093`），武装在同函数末尾（`:4109`）——**同一函数、同一 `t`，868/868 零滞后**。

真正滞后的是 **`contest_started` 这条 control fact**（`observation.rs` 的 `ContestStarted`；
v3 误写作 `control_started`，该 fact kind 不存在）：在 `finalize_highlight` 的 `t_end = arm+1` 提交
（868/868 为 +1）。save 武装则滞后 saved-shot 事件 +1（90 次）或 +2（8 次）。

**⇒ 教训**：`[武装,+4)` 与 `[事件.t,+4)` 在 tackle 上是**同一个窗口**。
v1/v2 都把它们当成两套口径讲，是错的。

## 八、裁定（2026-09-28，用户采纳推荐）

### 8.1 §11 那条缺失的理由 —— **记在 #15B design 的偏离里，不改 §11**

**理由**：§11 的权威在 `.scratch/notes/match-behavior-observation-design.md`（828 行，
状态 Approved for implementation 2026-09-23），而 P15A 的 OpenSpec change **明说不复制另一套**
（`openspec/changes/p15-match-behavior-observation/design.md:3`「本 change 不复制另一套枚举或状态表，
避免规范漂移」）。回填 §11 = 改一份**已被 P15A 验证依据引用**的冻结文档，代价是两处 design 对不上；
而这条补充只是「为什么不产出某个 label」，属实现层偏离说明。
**⇒ 写在 #15B design，并注明与 §11 的关系。**

### 8.2 `phase_segments` 填充位置 —— **在 `DiagnosticMatch` 之后，由纯函数填**

**理由（决定性差别在可测性）**：
- 之后：`annotate_phases(&DiagnosticMatch) -> Vec<PhaseSegment>` 是**纯函数**，测判据 =
  `annotate_phases(&手搭 fixture)`，**不用跑引擎**；且 phase 日后要用空间特征，recorder 手里没有。
- 之前：判据要缠进 recorder 的提交点，且与「recorder 不参与决策」的定位冲突。
P17A 已在用「只读消费 `DiagnosticMatch`」这个形状。

### 8.3 判据冻结的守卫 —— **本项前提不成立，撤销**（2026-09-28 实测定论）

原问题问的是「`gap = LOOSE_MAX_TICKS + 2` 与 `TRANSITION_TICKS` 的巧合被改后，
design 里的判据会静默变假，怎么防」。

**实测表明这个巧合不影响决策**：把 `LOOSE_MAX_TICKS` 2→1（此时 tackle 窗口**变为可挂载**），
`close_down` **仍然出现**（seed 1 实测 44 → 52 拍）。即「窗口是 team-state」这条结论**与常数无关**——
它的依据是「窗口同时驱动两队」（`press *= 2.0` + `close_down`），那是**代码结构**，不是窗口长度。

**⇒ 无需守卫**。原第 5 项基于一个错误前提（把「可挂载性」当成了决策依据）。

> ⚠️ 但**另一条**确实需要守卫，且已有做法：**窗口边界**（`+4` 与 `skip` 关系）若被重标定，
> **重建公式**（`tackle 事件 + TRANSITION_TICKS`）会失效。这条写进 #15B design，
> 并靠既有 `engineFingerprint` 哨兵（源变则基线红）兜住——沿用本仓既成做法，不新造机制。

### 8.4 其余三项（原 2/4/6/7）

| 项 | 裁定 |
|---|---|
| **顺序**（原 2） | `#16（含 phaseability gate）→ #15B`。**确认** |
| **是否为 team-state observation 立项**（原 3） | **不立**（§6 实测：转换观测已现成） |
| **存量口径数字**（原 4） | **已处理**：roadmap §4.3 已标 `1230/84/1106` **作废**，并注明可复现的是 `1230/124`。无遗留 |
| **命名冲突**（原 6） | **写进 #15B design**：主 spec `match-engine:641` 的 `transition_active` 与 possession phase 闭集**不同概念**，勿混用同一名词。这是「防止后来者误用」的文档义务，不改 spec |
| **`phase_segments` 填充**（原 7） | 见 8.2 |

**⇒ #113 全部裁定完毕，无待决项。**
