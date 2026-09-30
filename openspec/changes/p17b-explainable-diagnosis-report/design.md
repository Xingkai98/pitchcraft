# P17B 设计：可解释诊断报告

> ⚠️ **本文是 grill 前的设计**。**待决策**节列出实现前必须闭合的问题；
> 未经 grill 与用户确认，不写实现代码（本仓 OpenSpec 流程）。

## 1. 位置与边界

诊断器是**只读消费者**，位于集成测试层（与 P17A 同款理由）：

```text
simulate_with_behavior_observations(seed, config) -> DiagnosticMatch
                                                       │
        ┌──────────────────────────────────────────────┴────────────────┐
        │  engine/tests/p17b/                                          │
        │    evidence.rs   **证据边界表**（观测事实 / 机制假设，逐字段）    │
        │    episode.rs    逐 episode 派生（动作链 / 结束前窗口 / 四类归因）│
        │    reasons.rs    四类归因的口径与措辞规则                        │
        │    report.rs     JSON / Markdown 序列化 + 可回放定位            │
        └──────────────────────────────┬────────────────────────────────┘
                                       │
              target/p17b-diagnosis/{canary,baseline}.{json,md}
```

**为什么不放在 `engine/src/`**：`engine/src/` 只保留引擎与 #15A 观测层。
诊断器不需要任何生产 API，放进 `src/` 会无谓扩大 `fm_engine` 的公开面；
放 `tests/` 还能直接进既有 `cargo test` 链路（重活走 `#[ignore]`，同 P17A）。

**复用的既有实现**（**不重写**，见 `[[conventions]]` 与本仓「复用而非重建」纪律）：

| 复用 | 来源 | 说明 |
|---|---|---|
| `StateSnapshot`（22 人 + 球位，逐 tick） | #16 G1 | 位置来源，口径以 `ControlFact` 为权威 |
| `support_formation` + `SUPPORT_MAX_DIST_M` / `SUPPORT_MIN_FORWARD_M` | #16 `features.rs` | **接应口径已固化**（阈值是定义的一部分） |
| `IntentSnapshot` / `DefensiveIntent` | #124 | 起脚窗口相 / 防守动作（稀疏） |
| 固定 seed、逐场再聚合、provenance 三件套 | #17A | 口径纪律 |

⚠️ **跨 change 复用的代价（如实记录）**：`tests/p16/` 与 `tests/p17a/` 是**各自的模块**，
`tests/p17b/` 要复用它们须走 `#[path]` include。这会让 p16 的模块被**两处**编译，
且**p16 的改动会静默影响 p17b**。设计选择：**复制最小的口径常量与谓词到 `p17b/`，
并加一条「与 p16 同源」的逐位比对守卫**（而不是直接 include）——理由：
P16 的 `reference.rs` 已有先例（为守卫能扫全文而拆独立文件），且**跨 change 隐式耦合**
正是本项目反复出问题的地方。

## 2. 证据边界（**本 change 的第一交付**）

诊断器能说什么，**严格由现有 sidecar 能观测到什么决定**。
下表逐条给出：量 → 落点 → **性质**。**性质**一栏是本设计的核心：
`观测` = 引擎直接提交的事实；`派生` = 由观测确定性算出；`假设` = **不得写成结论**。

| 量 | 落点（公开 API） | 性质 |
|---|---|---|
| 控制权建立/释放（队、人、位置、依据） | `ControlFact{kind,team,player,location,basis}` | **观测** |
| episode 起止与原因 | `PossessionEpisode{start_t,end_t,start_reason,end_reason}` | **观测** |
| 争抢成因 / 结局 | `ControlFactDetail::{ContestStart,ContestEnd}` | **观测** |
| 归属事件下标 | `PossessionEpisode::event_indexes` / `ControlFact::source_event_index` | **观测** |
| 动作（闭集恰为 `chase`/`close_down`/`run`/`keeper_return`） | `Mover.action`（beat 事件内） | **观测**（⚠️ 是**开集字符串**，无编译期闭集；见 §4.4） |
| **松散球的追球者**（`chase`） | `Mover.action == "chase"`，靶点恒为球 | **观测**（⚠️ 覆盖有限，见 §4.4 / BLOCKER-1） |
| 触球结果（pass result / shot result / tackle） | `Event{type_,result,detail,...}` | **观测** |
| 22 人位置 + 球位（逐 tick） | `StateSnapshot{pos,ball}` | **观测** |
| 起脚窗口相（是否开窗 / 已耗拍数 / 是否 committed / 入窗压力档） | `IntentState`（逐 tick） | **观测** |
| 防守动作类型 + 防守者 | `DefensiveIntent{kind,defender}`（稀疏） | **观测** |
| 持球者受压倒计时 | `IntentState::pressure_state_ticks` | **观测**（**不是「强度」**，见 §4.3） |
| 接应者数 / 最近接应距离 | 由 `StateSnapshot` + P16 口径算出 | **派生** |
| 动作链（N-gram / motif） | 由事件序列算出 | **派生** |
| **射门时门将位置** | `Event::keeper_x/keeper_y`（**射门与头球射门都设**）+ `StateSnapshot.pos[0]/[21]` | **观测** ⚠️ 见下「表本身出过一手错」 |
| 射门者的起脚位置 | `Event::{x,y}`（shot 的 subject 位置） | **观测** |
| 「因为压力大所以传丢」类因果 | — | **假设**：**禁止**写成结论 |
| 战术相位（build_up / progression / …） | — | **不可得**（#16/#124 双负） |
| 传球当时的候选 / 选择集 | — | **不可得**（引擎私有打分） |
| 射门当时的 **hazard 值本身** | — | **不可得**（引擎私有打分）。**但其输入 4/5 可得**：`distance_quality` / `angle_quality` / `space_available` 由 `StateSnapshot.pos` 派生；`defensive_pressure` 的 `pressure_state` 分量读 `IntentState::pressure_state_ticks`。**唯一不可得的是 `cooldown_penalty` 的 `cooldown_ticks`** ⚠️ 见下 |
| **观察可信度** | `DiagnosticMatch::{is_coherent, gap_count, gap_reason_counts}` | **观测** ⚠️ 见 §3.0：**报告的前置门** |

> ⚠️ **`interception_loose` 的覆盖缺口（BLOCKER-1，grill 抓到、本人 30 seed 独立复现）**：
> 占丢球 **36%** 的 `interception_loose`（729/2027）**一次都不产 loose beat**
> （8 seed 184/184、30 seed 729/729）。⇒ **「丢球后谁做了什么」只在 46.7% 的丢球上可答**，
> 其余看不到追逐过程。**P17A 点名的 A2 异常（同拍收束）恰好全落在盲区里**，
> 故 §7 的「覆盖 P17A 6 条异常样本」须相应收敛。

> ⚠️ **本表本身出过一手错（2026-09-30 grill 抓到，如实记录）**：初版把
> 「射门时的**门将位置**」与 hazard 并列写成「不可得」——**错**：
> 门将位置在 `Event::keeper_x/keeper_y` 上（普通射门 `lib.rs:3815`、头球射门 `:5041` 都设），
> 且逐 tick 就在 `StateSnapshot.pos[0]/[21]`。这是**反向的假边界**
> （把「可得」说成「不可得」）——虽不如反向危险，但**同样会让报告放弃本可做的解释**。
> 现拆成两行：**门将位置可得、hazard 值不可得（其输入部分可得）**。
> ⇒ **教训**：这张表是**结论的闸门**，它的每一条都必须**实测核对**，不能凭印象填——
> 与侦察阶段那两处被探针推翻的读码推断是同一个病。

> ⚠️ **同一张表的第二处错（grill 复核抓到）**：初版把 `entry_pressure_bucket` 列为
> hazard 的**输入**——**错**。`compute_shot_score` 的五因子是
> `distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty`，
> **不读** `entry_pressure_bucket`：`shot_pressure_bucket()` 的唯一调用点在
> `lib.rs:3881`，赋给 `ShotSetup::entry_pressure_bucket`，供**提交率方向门**用，与 hazard 无关。
> ⇒ **本表本身两处**（门将位置、`entry_pressure_bucket`）；**连同侦察阶段的两处，共四处**。
> 按**来源**分：**侦察那两处由本人探针自我纠正**（Slice 0），
> **本表这两处由独立 grill 抓出**。
> 这坐实了 §8 的结论：实现阶段必须继续独立复核。

**规则**：报告里每条结论**必须**标注它的性质（`观测`/`派生`），且**给出落点字段名**。
`假设` 类文字**只能**出现在显式标为「机制假设（未验证）」的段落里，
且必须附「验证它需要什么」。

## 3. 报告结构

### 3.0 前置门：观察可信度

诊断建立在 observation 上，**观察不可信时诊断无意义**。
故报告生成前 SHALL 检查 `DiagnosticMatch::{is_coherent(), gap_count(), gap_reason_counts()}`：
- `is_coherent() == false` 或 `gap_count() > 0` 的 seed ⇒ 报告**显式标注**，
  其诊断卡标 `观察不可信`，且**不进入** L2 聚合；
- 这是**前置门**，不是「顺便打印」——P15A 的既有契约已提供这三个口子，**不新增**。

### 3.1 L1：逐 episode 诊断卡

对固定 seed 集的**每个** possession episode 产出一张卡：

```text
seed=7  episode=42  team=home  t=[1234s, 1268s]  时长=34s
start_reason=pickup        end_reason=control_lost
观察可信度=coherent（gap=0）

动作链（事件下标）:
  #9001 pass  success      →  #9007 pass success  →  #9014 dribble
  →  #9020 pass  intercepted

结束前 3 拍（t-2..t）:
  t  接应者数  最近接应(m)  压迫倒计时  起脚窗口  位置(球)
  ...

【丢球后】争抢成因 = pass_lost（**本段属「产 loose beat」的 46.7%**）
  追球者（chase，靶点恒为球）：id=15, id=18
  close_down：id=04（来源=Tackle⇒追球）/ —
  ⚠️ 若成因是 interception_loose ⇒ 此处记「**不产 loose beat，追逐不可见**」（§4.4.2）

四类归因（**每条带落点**）:
  转换  观测  contest_started.detail=pass_lost               [control_fact#812]
  接应  派生  结束前 3 拍接应者数 = 0 / 2 / 1                 [state_snapshots#1265..1267]
  压力  观测  pressure_state_ticks = 0（无压迫状态）           [intent_snapshots#1267]
  动作  观测  最终选择 = 向前传球（pass, lead=…）             [event#9020]

可回放: seed=7, t=1268, episode=42, event_indexes=[9001..9020]
```

### 3.2 L2：聚合视图

- 按 `end_reason` 分组的链长 / 接应 / 压力分布；
- 按 `ContestStartReason` 分组的成因与结局；
- **按归因类别分组**的计数（供 #19 挑靶点）；
- ⚠️ **不产生 pass/fail**（同 P36 报告期纪律）；不设「好/坏」标签。

### 3.3 查询接口

支持按 **球权 / 动作链 / 区域 / 压力** 回放检查（`map.md` 的 `17B` 条目原文）。
⚠️ **阶段一项不可得**，本设计**显式删除**该项——不得改名后假装满足。

## 4. 四类归因的口径（**逐条**）

### 4.1 转换（re-scoped）

**报什么**：`EpisodeStartReason` / `EpisodeEndReason` / `ContestStartReason` 的**事件级**取值，
以及「上一段怎么结束 → 这一段怎么开始」的**事件序列**。

**不报什么**：战术相位。措辞守卫见 §6——⚠️ 它的**扫描范围与相容规则**是
grill 点名的 MAJOR-1，**必须定死**：

- **扫描范围**：`tests/p17b/{evidence,episode,reasons}.rs` 三个**报告逻辑**文件；
  **排除** `report.rs`（provenance 构造点，见下）；
- **剥注释**：扫前**剥掉 `//` 之后**的全部内容（P124 的同类守卫踩过这个坑并记了教训）——
  否则 §4.1 这句「不得出现 `build_up`…」的**注释本身**会让守卫自己判红；
- **与 provenance 相容**：`#17A`/P16 的 `sidecar_schema_fingerprint` **恰恰包含**
  `add!("Phase", Phase::ALL)`（`p16/report.rs:223`、`p17a/model.rs:679`）——
  `Phase` 是 `observation` 的公开闭集，指纹漏了它就没在守护闭集完整性。
  ⇒ **`Phase` 出现在指纹构造点是正确的**，守卫须**排除该处**。
- **守卫真正要守的命题**不是「p17b 里没有 Phase 这个词」，而是
  「**p17b 不声称能判相位**」。守卫的注释里须写明这一点，
  否则它会去保护一个错误命题。

理由：`#16` 判「空间量本身不足」、`#124` 判「意图信号也不足」——
phase 判据目前**没有**可用的观测依据。

### 4.2 接应

**复用 #16 的 `support_formation` 口径**：以球位为参考，距球 ≤ `SUPPORT_MAX_DIST_M`（25 m）
且在该队进攻方向上比球靠前 ≥ `SUPPORT_MIN_FORWARD_M`（2 m）的**非门将队友**计为接应者。

⚠️ **依赖闭包比「两个常量 + 一个谓词」大**（grill MINOR-6）：
`support_formation` 还依赖 `team_shape` / `attack_dir` / `progress` / `KEEPER_IDS` /
`PITCH_LENGTH_M` / `PITCH_WIDTH_M`（分布在 `p16/features.rs` 与 `p16/shape.rs`）。

**复用形态见 §5 待决策 2**——该决策的一个硬约束：本仓已有先例
（`p124/report.rs` 的 `caliber_snapshot` 直接 `crate::features::SUPPORT_MAX_DIST_M` 活读），
即 **`#[path]` include 是本仓既成做法**；若选「复制」，则「同源守卫」**只能**是
**源码文本比对**（`include_str!` 两侧 + 提取字面量），因为不 include 就**无法在运行时比对**。
两种形态各有代价，须显式选定（**不得**在实现时含糊）。

### 4.3 压力

**可用**：`pressure_state_ticks`（**剩余保持 tick 数**，不是强度）+ `DefensiveIntent.kind` 分布。

**措辞纪律**（**本条是 §2 规则的重点落点**）：
- ✅ 「这一拍 `pressure_state_ticks=0`」
- ❌ 「因为压力小所以选择传球」——因果是**假设**，未验证；
- ⚠️ **不得**暗示压力能区分阶段：`#124` 实测 `pressure_*` 对 phase 的 AUC = 0.372。

### 4.4 动作

**可用**：`Mover.action` 串（开集，实际产出恰为 `{chase, close_down, run, keeper_return}`）
+ 事件流。

#### 4.4.1 **松散球判据必须排除重开准备期**（BLOCKER-2）

`BallState{loose:true}` 有**两个**生产点：`advance_loose`（真松散球）**和**
`advance_restart_prep`（角球/界外球**发球前**的走位等待，球钉在发球点）。
用 `beat.ball.loose` 裸判会把后者算进来——**实测（30 seed）**：

```text
                段数   两队都追   只一队   none    平均时长
  开球期        946     541       405      0      3.02
  准备期        379       0         0    379      6.28     ← 全是「无追球者」
```

准备期的 379 段**不是「丢球后没人追」**（球根本不在比赛中），
把它们算进来会让比例**失真**（初版「43% / 27%」即由此而来）。

⇒ **判据定死为**：`beat.ball.loose && !in_restart_window`，
`in_restart_window` 取 `restart_sequences` 的 `[start_t, taken_t)`。
**修正后的权威比例**：开球期两队都追 **57.2%**、只一队 **42.8%**、**无追球者 0%**。

#### 4.4.2 覆盖缺口（BLOCKER-1）

`interception_loose`（**36% 的丢球**）**完全不产 loose beat** ⇒ **看不到追逐**。
报告须**按成因**分别声明覆盖，**不得**给一个笼统的「Q3 可答」。

#### 4.4.3 `close_down` **不恒为「追球」**（MAJOR-2）

`compute_mover_candidates` 里 `close_down` 的靶点按 `TransitionSource` 分流：
`Tackle` → `st.ball_pos`（追球）；**`SaveCaught` → `attacking_forward(..)`（追人）**。

> ⚠️ **实现期更正（审阅轮 2 实测，2026-09-30）**：本节的**证据句**
> 「实测（8 seed）188/513（37%）的 `close_down` 终点距球 > 5.25 m」**已被推翻**，分两层：
> ① 数值：`188/513` 是**归一化**距离直接与 `5.25` 比得到的（单位混用），世界坐标真值 **168/513**；
> ② **更重的是因果链**：`close_down_stop` 只推进 `d − CLOSE_DOWN_STOP_DIST`（≈2 m）、
> **打不到靶点** ⇒ **远端球员的 mover 终点天然离球远**，与「追的是不是人」无关。
> 实测 8 seed 的 513 个 `close_down` **全部朝球逼近**（靠近 513 / 远离 0）；
> 且 `SaveCaught` 分流只占 **9.9%**（30 seed 215/2162），不是 37%。
>
> **结论与纪律不变**（`close_down` 不恒为追球 ⇒ 不得与 `chase` 并称），但**依据**只能是
> **靶点分流本身**（上一段的源码事实），**不得**引「距球远」。
> 实现侧三处引用已收回（`evidence.rs` 的 `MoverTarget` 行 / `reasons.rs` 的 `WORDING_RULES` /
> 入口测试的 doc），由 `pursuit_roles_are_classified_never_merged` 的 doc 与
> `reasons.rs` 的 `WORDING_RULES` 承载。

⇒ **措辞纪律**：**不得**把 `chase` 与 `close_down` 并称「追球者」。
`chase` 的靶点恒为球（可称追球）；`close_down` 须**按来源分类**后再命名。

## 5. 待决策（**实现前须闭合**）

1. **报告粒度**：逐 episode 全覆盖，还是按异常筛选（如只报链长 > p90 的段）？
   全覆盖的产物会很大（300 seed 约 2.6 万 episode）。
2. **`support_formation` 复用的形态**：`#[path]` include（本仓既成做法，见 §4.2）
   还是复制 + **源码文本**同源守卫？两种代价须显式权衡后**定死**。
3. ~~「27% 无追球者」是否查清~~ → **已查清，不再待决策**：是重开准备期（§4.4.1），
   且**不构成缺陷**。**新的待决策**：`in_restart_window` 用 `[start_t, taken_t)` 时
   **`taken_t` 缺失怎么办**——实测（30 seed）重开 **1613 个，缺失 2 个**（≈0.12%），
   **非零**，故**必须**定义行为（不能按「不会发生」处理）。
4. **L2 聚合的分组维度**取舍——全上会稀释重点。
5. **产物是否需要与 P17A 对齐 seed 集与口径**（便于两报告交叉引用）？
6. **「可回放」的强度**：只给 `(seed, t, event_index)` 坐标，
   还是要能一键重现那段的事件流？
7. **观察可信度门**（§3.0，grill MINOR-5a）：`is_coherent()==false` 或 `gap_count()>0` 的 seed
   是**排除**、**标注但保留**、还是**整体拒绝运行**？
8. **时长 0 的争抢如何呈现**（grill MINOR-5c）：1081/2027（30 seed）无 loose beat，
   其中 `interception_loose` 729 全在此列。报告须有**明确呈现口径**
   （显式「追逐不可见」而非留空——留空会被读成「没发生」）。
9. **松散球判据的子口径**：`in_restart_window` 的窗口定义见 3；
   另需定「`chase` mover 的**归属队**怎么读」（`mover.id` 映射到队，还是有更权威来源）。

## 6. 测试策略

| 判据 | 性质 |
|---|---|
| 只读投影：`simulate()` 与 opt-in 路径事件流**逐字节相同** | 门槛（复用既有守卫） |
| **每条结论带落点**：扫描报告生成代码，引用的字段必须在 `observation` 的**公开**类型里 | 门槛（**反「假覆盖」**） |
| **措辞守卫**：**剥注释**后扫 `tests/p17b/{evidence,episode,reasons}.rs`，不得出现 phase 词；**排除** `report.rs` 的指纹构造点 | 门槛（源码扫描；**扫描范围/剥注释/相容规则须按 §4.1 定死**） |
| **假边界守卫（反 BLOCKER-1）**：报告对每个 `ContestStartReason` 都**显式声明覆盖**（可答 / 不可见），不得有未声明的成因 | 门槛（**本条是本 change 的立身之本**） |
| **松散球判据守卫（反 BLOCKER-2）**：判据须排除重开准备期；定向变异（去掉 `!in_restart_window`）须判红 | 门槛 |
| 接应口径与 `p16` **同源**（形态见待决策 2） | 门槛 |
| 松散球追球者可见：**覆盖率下限**（30 seed 实测 946 段产 loose beat）——**不得**用「至少一段」这种空转下限 | 门槛 |
| 观察可信度门生效（§3.0） | 门槛 |
| **动作分类守卫**（反 MAJOR-2）：把 `chase` 与 `close_down` 合并成一类的变异须判红 | 门槛 |
| **规范一致性守卫**：spec/tasks 中**每处提及 P17A 异常覆盖的块**（**单位为「Scenario 段 / 停止条件条目」，非「句子」**——spec 把「证据边界内」放在 scenario **标题行**、把「逐条说明/盲区」放在 **`- **THEN**` 行**，跨两行，故须**合块判**），须**同时**含「证据边界内」与「边界外逐条说明 / 落在盲区」两半——**正向断言**，而非扫某个转述串（⚠️ **不得写成「扫 `- **THEN**` 行找禁串」**：禁串是转述、且 `tasks.md` 的违规是裸 bullet、**一个 `- **THEN**` 行都没有** ⇒ 那样写出的守卫在真有违规的版本上实测**不命中**，是空转）。⚠️ 须**排除引用/警示文本**（`⚠️` 行、引用块），否则 spec 里那句禁令本身会判红（同 §4.1 剥注释的自指坑）。**反证条**：把该 scenario 还原成「各自都能找到样本」**必须判红** | 门槛（复发防线；**须带反证条**） |
| 可回放定位有效：每条记录的 `event_index` 能回到事件流且时间自洽 | 门槛 |
| 确定性：同输入两次输出**逐字节相同** | 门槛 |
| 缺证据时显式 `unknown`，不猜 | 门槛 |
| 每个门槛都做**定向变异**验证有判别力 | 门槛（本仓纪律） |
| 覆盖率下限：真实 seed 上非空的比例（防空转） | 门槛 |

## 7. 与既有工作的关系

- **P17A**：本 change 消费它产出的异常清单，把它**从聚合降到逐 episode**。
  ⚠️ **收敛**（BLOCKER-1）：原写「诊断卡须能解释 6 条异常**各自**的样本」——**做不到**：
  A2（同拍收束）的样本恰好全在「不产 loose beat」的盲区里。改为：
  「**在证据边界内**能解释的，且逐条说明哪条异常**落在盲区**」。
- **P16 / P124**：本 change **消费**它们的观测与口径，**不重跑**它们的 gate。
- **#15B**：本 change **不实现**；且本 change 的结论（phase 不可得）**强化**了 15B 的暂停理由。
- **`match-audit` / `diagnosis-runner`（grill MAJOR-3，须显式划界）**：
  两者是**同族但不同输入**的既有能力，本 change **不复用**它们，须说清为什么：
  - `match-audit`（`openspec/specs/match-audit/`）：对 **audit bundle**（JS 侧打包的观察包）
    跑 detector 出 findings；本 change 直接消费引擎的 `DiagnosticMatch`，**不经过 bundle**。
    其 `unforced_out` / `ignored_interception_opportunity` / `inactive_responsibility`
    与本文「压力判断 / 动作选择」两类归因**问的是同一批现象**——
    ⇒ 报告须**说明两者结论如何对照**（至少不得互相矛盾）。
  - `diagnosis-runner`（`openspec/specs/diagnosis-runner/`）：**LLM 驱动**的服务化诊断；
    本 change 是**确定性 Rust**、无 LLM、无服务依赖。
  - **边界判据**：本 change 的产物是**逐 possession 的确定性展开**；
    若某结论已由 detector 覆盖，本 change **引用**而非重造。
- **#18 / #19**：本 change 为 #18 提供「哪些模式值得立成门」的候选，
  为 #19 提供「改哪一条」的靶点。**本 change 自己不立门、不改生成。**

## 8. 已知局限（如实记录）

- 上表所有「不可得」项是**结构性**的，不是「还没做」；
- 侦察的**定量**结论现为 **30 seed**（原 8 seed）；进产物前须按 P17A 约定扩到 300；
- ⚠️ **本设计已经历四轮同族缺陷，且每轮都是新的一类**：
  ① 侦察两处**读码推断**被探针推翻；
  ② §2 表的**假边界**（门将位置）；
  ③ §3/§4.4 的**口径归因错**（数字全对但代表的意义错）；
  ④ 新增守卫**红在自己身上**（自指），以及 §2 表的**第二处**错（`entry_pressure_bucket`）。
  **① 由本人的探针自我纠正**（Slice 0，那时**尚无独立审阅者**；note **开篇**写明「事实来自**实跑**，不是读代码」）；
  **②③④ 由独立 grill 抓出**（② 的修复提交 `e927977` 时间戳 13:02:48 **晚于**设计提交
  `68ea839` 的 13:01:03 —— 即 grill 已在跑，**不是**本人自查）；③ 的判据另经本人独立复现确认。
  ⚠️ **两个计数基准不同，勿混**：§2 的「**四处**」只数**证据表相关**的错；
  本节的「**四轮**」按**轮次**数，其内含 6 处错。
  ⇒ **实现阶段仍须独立复核**，且**探针本身也要审**（`[[probe-itself-needs-audit]]`）。
  **新守卫的「自指」是本 change 的复发模式**（§4.1 的剥注释、§6 的规范一致性守卫是同一个坑）——
  写任何**扫描文本**的守卫时，先问：**它会不会扫到自己的规则说明？**
