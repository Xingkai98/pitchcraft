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
| 动作（含 `chase`/`close_down`/`run`/`keeper_return`） | `Mover.action`（beat 事件内） | **观测** |
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
| 射门当时的 **hazard 值本身** | — | **不可得**（引擎私有打分；**但其输入部分可得**：`entry_pressure_bucket` / `pressure_state_ticks` / 射门者与门将位置） |

> ⚠️ **本表本身出过一手错（2026-09-30 grill 抓到，如实记录）**：初版把
> 「射门时的**门将位置**」与 hazard 并列写成「不可得」——**错**：
> 门将位置在 `Event::keeper_x/keeper_y` 上（普通射门 `lib.rs:3815`、头球射门 `:5041` 都设），
> 且逐 tick 就在 `StateSnapshot.pos[0]/[21]`。这是**反向的假边界**
> （把「可得」说成「不可得」）——虽不如反向危险，但**同样会让报告放弃本可做的解释**。
> 现拆成两行：**门将位置可得、hazard 值不可得（其输入部分可得）**。
> ⇒ **教训**：这张表是**结论的闸门**，它的每一条都必须**实测核对**，不能凭印象填——
> 与侦察阶段那两处被探针推翻的读码推断是同一个病。

**规则**：报告里每条结论**必须**标注它的性质（`观测`/`派生`），且**给出落点字段名**。
`假设` 类文字**只能**出现在显式标为「机制假设（未验证）」的段落里，
且必须附「验证它需要什么」。

## 3. 报告结构

### 3.1 L1：逐 episode 诊断卡

对固定 seed 集的**每个** possession episode 产出一张卡：

```text
seed=7  episode=42  team=home  t=[1234s, 1268s]  时长=34s
start_reason=pickup        end_reason=control_lost
争抢成因=interception_loose（若本段以争抢收束）

动作链（事件下标）:
  #9001 pass  success      →  #9007 pass success  →  #9014 dribble
  →  #9020 pass  intercepted

结束前 3 拍（t-2..t）:
  t  接应者数  最近接应(m)  压迫倒计时  起脚窗口  位置(球)
  ...
  守方追球者：id=15 (chase→持球者), id=18 (chase→持球者)      ← 松散球期，见 §4.4

四类归因（**每条带落点**）:
  转换  观测  contest_started.detail=interception_loose      [control_fact#812]
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

**不报什么**：战术相位。**不得**出现 `build_up` / `progression` / `final_third` /
`attacking_transition` / `Phase` 等词（源码扫描守卫，见 §6）。

理由：`#16` 判「空间量本身不足」、`#124` 判「意图信号也不足」——
phase 判据目前**没有**可用的观测依据。

### 4.2 接应

**复用 #16 的 `support_formation` 口径**：以球位为参考，距球 ≤ `SUPPORT_MAX_DIST_M`（25 m）
且在该队进攻方向上比球靠前 ≥ `SUPPORT_MIN_FORWARD_M`（2 m）的**非门将队友**计为接应者。

**阈值是定义的一部分**——复制到 `p17b/` 后须有**同源守卫**（与 `p16` 逐位比对），
防止两处口径分叉。

### 4.3 压力

**可用**：`pressure_state_ticks`（**剩余保持 tick 数**，不是强度）+ `DefensiveIntent.kind` 分布。

**措辞纪律**（**本条是 §2 规则的重点落点**）：
- ✅ 「这一拍 `pressure_state_ticks=0`」
- ❌ 「因为压力小所以选择传球」——因果是**假设**，未验证；
- ⚠️ **不得**暗示压力能区分阶段：`#124` 实测 `pressure_*` 对 phase 的 AUC = 0.372。

### 4.4 动作

**可用**：`Mover.action` 串 + 事件流。

⚠️ **一条反直觉的实测事实（本设计的侦察产物，两处读码推断都错了）**：
普通**松散球**期产出 `action="chase"` 的 mover（8 seed 实测 844 个），
且 **43% 的松散球段两队都有人追**。故「丢球后谁做了什么」**可以**回答——
但必须写明下面两个**已知局限**：

1. 用 `beat.ball.loose` 识别松散球 ⇒ **同拍拾取**（P17A 的 A2：52.7%）可能不产 loose beat，
   故段数是**下界**；
2. 侦察实测 **27% 的松散球段无追球者 mover**，**成因未查**。
   设计若依赖该比例，须先补探针。

## 5. 待决策（**实现前须闭合**）

1. **报告粒度**：逐 episode 全覆盖，还是按异常筛选（如只报链长 > p90 的段）？
   全覆盖的产物会很大（300 seed 约 2.6 万 episode）。
2. **`support_formation` 复用的形态**：复制 + 同源守卫，还是 `#[path]` include
   （§1 提到跨 change 隐式耦合的代价）？
3. **「27% 无追球者」** 是否在本 change 内查清？（§4.4 局限 2）
4. **L2 聚合的分组维度**取舍——全上会稀释重点。
5. **产物是否需要与 P17A 对齐 seed 集与口径**（便于两报告交叉引用）？
6. **「可回放」的强度**：只给 `(seed, t, event_index)` 坐标，
   还是要能一键重现那段的事件流？

## 6. 测试策略

| 判据 | 性质 |
|---|---|
| 只读投影：`simulate()` 与 opt-in 路径事件流**逐字节相同** | 门槛（复用既有守卫） |
| **每条结论带落点**：扫描报告生成代码，引用的字段必须在 `observation` 的**公开**类型里 | 门槛（**反「假覆盖」**） |
| **措辞守卫**：源码中不得出现 `Phase` / `build_up` / `progression` / `final_third` / `attacking_transition` | 门槛（源码扫描，同 P16 循环性防护形状） |
| 接应口径与 `p16` **逐位同源** | 门槛 |
| 松散球追球者可见：至少一段能报到 `chase` mover（**探针转正为断言**） | 门槛 |
| 可回放定位有效：每条记录的 `event_index` 能回到事件流且时间自洽 | 门槛 |
| 确定性：同输入两次输出**逐字节相同** | 门槛 |
| 缺证据时显式 `unknown`，不猜 | 门槛 |
| 每个门槛都做**定向变异**验证有判别力 | 门槛（本仓纪律） |
| 覆盖率下限：真实 seed 上非空的比例（防空转） | 门槛 |

## 7. 与既有工作的关系

- **P17A**：本 change 消费它产出的异常清单，把它**从聚合降到逐 episode**；
  诊断卡须能解释 P17A 点名的 6 条异常**各自**的样本。
- **P16 / P124**：本 change **消费**它们的观测与口径，**不重跑**它们的 gate。
- **#15B**：本 change **不实现**；且本 change 的结论（phase 不可得）**强化**了 15B 的暂停理由。
- **#18 / #19**：本 change 为 #18 提供「哪些模式值得立成门」的候选，
  为 #19 提供「改哪一条」的靶点。**本 change 自己不立门、不改生成。**

## 8. 已知局限（如实记录）

- 上表所有「不可得」项是**结构性**的，不是「还没做」；
- 侦察只跑 **8 seed**；进产物前须按 P17A 约定用 30 / 300 seed 重算；
- 本设计的 §2 证据表基于**源码 + 探针**核对，但 **`[[probe-itself-needs-audit]]`**：
  探针本身也要审——实现阶段须独立复核探针（尤其「27% 无追球者」的判定口径）。
