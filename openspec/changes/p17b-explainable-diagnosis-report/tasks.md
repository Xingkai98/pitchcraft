# P17B 任务

> ✅ **本 change 已进入实现阶段**（设计定稿 + 7 轮 grill 全过 + 用户拍板三条待决策）。
> Slice 1–4 已完成（25 条默认门全绿 / 2 条 `#[ignore]` 产物门已跑），Slice 5 见 `REVIEW.md`。

## Slice 0 — 侦察（✅ 已完成 2026-09-30）

- [x] 实测「现有 sidecar 能不能回答 #17B 的四个问题」
- [x] 落成 note：`.scratch/notes/17b-recon-2026-09-30.md`
- [x] **如实记录被推翻的推断**（第二轮：两处读码推断；第三轮：**数字全对但口径归因错**）
- [x] 探针 `engine/tests/zz_17b_recon.rs`（**临时，用完即删**）

### 侦察结论（**30 seed**，grill 修正后）

| 问题 | 现有 sidecar | 依据 |
|---|---|---|
| 为什么结束 | ✅ 够 | `EpisodeEndReason`(10 员) + 事件/事实下标 |
| 为什么这样选 | ⚠️ **射门够、传球不够** | `shot_setup` 全相有（**门将位置亦可读**）；传球**无选择集** |
| 丢球后谁做了什么 | ⚠️ **只在 46.7% 的丢球上够** | `interception_loose`（**36%**）**完全不产 loose beat** |
| 四类归因 | ⚠️ 三类可答 | 「转换」只能报**事件级**（phase 双负） |

### grill 后的修正（**本轮最重要的部分**）

| 级别 | 发现 | 处置 |
|---|---|---|
| **BLOCKER-1** | `interception_loose` 729/729 **零 loose beat** ⇒ Q3 的「够」是**假能力边界** | §2/§4.4.2 降级为「按成因分别声明覆盖」+ 新增守卫 |
| **BLOCKER-2** | `ball.loose` **把重开准备期算作松散球** ⇒ 初版 43%/27% **口径失真** | 判据定死 `loose && !in_restart_window`（§4.4.1） |
| MAJOR-1 | 措辞守卫与 provenance 的 `add!("Phase", …)` **自相矛盾** | §4.1 定死扫描范围/剥注释/相容规则 |
| MAJOR-2 | `close_down` **不恒追球**（依据 = **靶点按 `TransitionSource` 分流**） | §4.4.3 措辞纪律 + spec scenario。⚠️ **实现期更正**：原载的「37% 在追人」（188/513）两层都不成立——归一化/世界坐标混用 + `close_down_stop` 打不到靶点（实测 513 个**全部朝球逼近**）。依据已收回为靶点分流本身 |
| MAJOR-3 | 与 `match-audit`/`diagnosis-runner` **无边界陈述** | §7 显式划界 |

**两条 BLOCKER 均由本人 30 seed 独立复现确认**（不采信转述）。

## Slice 1 — 证据边界与模块骨架（✅ 已完成 2026-09-30）

- [x] 建 `engine/tests/p17b/`（`evidence.rs` / `episode.rs` / `reasons.rs` / `report.rs`）
- [x] 把 design §2 的证据表**落成代码常量**（量 → 字段 → 性质），并加「字段存在」守卫
      ——落成 **`Locus` 枚举**（字段改名即**编译不过**，比扫文本更强）；
      守卫 `evidence_table_lists_every_locus_and_every_row_is_readable` +
      `locus_read_probes_actually_read_the_field`（逐变体证明读探针不空转）
- [x] 复用 P16 接应口径——**用户拍板：`#[path]` include 活读**（见 design §5 待决策 2）

### ⚠️ 实现期的两处**实测更正**（读码/转述会错，本 change 的复发形态）

| 处 | 设计/侦察的说法 | 实测（30 seed，探针实跑） | 处置 |
|---|---|---|---|
| 1 | 松散球段 = **连续** loose beat 串（准备期拆开后 946 段 / 均长 3.02） | ✅ 复现：严格「流中相邻」= **946 段 / 均长 3.02**；宽松口径（跨过非 loose beat）= **324 段 / 8.83** | 判据定死为**流中相邻**（报告在口径栏并列两口径） |
| 2 | 「修正后：两队都追 **57.2%** / 只一队 42.8%」 | ❌ **对不上**：`chase`-only 只有 11.3%。但 `chase` **或** `close_down` 在队 = **57.2% / 42.8%**，与设计所载**逐位吻合** | ⇒ 设计那个数是「**任何 mover**」口径。报告**主口径只用 `chase`**（因 `close_down` 会追人），并把三种读法并列 |

第 2 处的教训与 design §8 记的四处同族：**数字对得上不代表口径对得上**——
`946` 这个「巧合」被 grill 更正过一次，而 `57.2%` 这个数至今没被核对过口径。

## Slice 2 — 逐 episode 诊断卡（✅ 已完成 2026-09-30）

- [x] 动作链派生（`episode.rs::action_chain`；`beat` 不计入，同 P17A 口径）
- [x] 结束前窗口（`tail_window`：末 `TAIL_TICKS=3` 拍 —— 接应 / 压力 / 起脚窗口 / 球位）
- [x] **松散球期的追球者**（`loose_runs`；`chase` 与 `close_down` **分列**，归属按 `Mover.id`）
- [x] 四类归因各自的口径与措辞规则（design §4；`reasons.rs` 的 `WORDING_RULES`）
- [x] 松散球判据 `loose && !in_restart_window`；**`taken_t` 缺失的显式行为**（四档 `WindowEnd`，可审计）

## Slice 3 — 报告与产物（✅ 已完成 2026-09-30）

- [x] L1 逐 episode JSON + Markdown（`report.rs`；card 渲染见 `render_card_md`）
- [x] L2 聚合视图——**刻意最小**（用户拍板）：只给三个分组计数
      （按结束原因 / 按争抢成因含**可见vs不可见分子分母** / 按异常类别）
- [x] 可回放定位（seed / t / episode / event_index；`replay` 块）
- [x] provenance（`source_commit` + `engine_source_fingerprint` + `test_source_fingerprint`
      + sidecar schema 指纹 + 口径快照，沿用 P17A/P16 形态）
- [x] 产物**自带能力边界**：证据边界表 / 结构性不可得 / 覆盖声明 / P17A 异常逐条映射 / 措辞规则

## Slice 4 — 测试与判据（✅ 已完成 2026-09-30；25 条默认门全绿）

- [x] 逐字节一致门（复用既有；`formal_path_is_byte_identical_...`）
- [x] **落点守卫**：`Locus` 枚举 + `read` 编译期存在性 + 逐变体判别力
- [x] **措辞守卫**：剥注释后扫三文件；**排除** `report.rs` 的指纹构造点
- [x] 接应口径**活读** `p16`（同源哨兵：p17b 不得自己声明该常量）
- [x] 松散球追球者可见（**探针转正为断言**；含 `chase`/`close_down` 分列）
- [x] 可回放定位有效（`replay_locators_resolve_to_real_events_with_consistent_time`）
- [x] 确定性 + 防空转下限 + 缺证据显式 `unknown`
- [x] **每个门槛做定向变异，验证有判别力**——7 条实跑均红，见 `REVIEW.md` 的变异表
- [x] 规范一致性守卫（**块判 + 反证条**，正反两向实跑过）
- [x] P17A 异常规则**逐条**覆盖声明（规则集合从 P17A 源码文本抽取，防漏项）
- [x] 观察可信度门（标注但保留、不进 L2 聚合；含反证条）

## Slice 5 — 审阅闭环（本仓强制收尾）

- [ ] 独立只读 subagent 审阅 → 修复 → 再审阅 → 全过
- [ ] 写 `REVIEW.md`（含 agent id 留痕）

## 待决策（✅ 全部闭合 2026-09-30）

- [x] 报告粒度：**canary 全覆盖 + baseline 按异常筛选**（用户拍板）
- [x] `support_formation` 复用形态：**`#[path]` include 活读**（用户拍板）
- [x] ~~「27% 无追球者」是否查清~~ → **已查清**：是**重开准备期**，不构成缺陷（grill BLOCKER-2）
- [x] 松散球窗口的 `taken_t` 缺失行为：**四档显式取值链**
      （`taken_t` → `open_play_resumed_t` → 下一条重开的 `start_t` → 事件流末端），
      每档记入 `RestartWindow.end_source` 可审计；canary 上实测**确有** fallback（非未执行代码）
- [x] 观察可信度门：**标注但保留、不进 L2 聚合**（用户拍板）
- [x] 时长 0 的争抢：**显式记「追逐不可见」**（`PursuitView::Invisible` 带成因，不许留空）
- [x] L2 聚合维度：**刻意最小**（用户明确要求缩减——价值在逐 episode 卡与前后对比）
- [x] seed 集：**与 P17A 对齐**（canary 1–30 / baseline 1–300）
- [x] 「可回放」强度：**给 `(seed, t, episode_id, event_indexes)` 坐标**，不做一键重现

## 未完成 / 交给后续 change

- **`#15B` phase 标注器**：仍暂停（本 change **强化**了其暂停理由：两条路都不够）
- **引擎侧补观测**（若确证缺某量）：须**另开 change**，不在本 change 夹带
- **行为门**：归 `#18`
- **生成改造**：归 `#19`
- **viewer 可视化**：归 `#22`

## 停止条件

- 证据边界表落地且有守卫；
- 逐 episode 诊断卡**在证据边界内**覆盖 P17A 点名的异常样本，并对边界外的**逐条说明**；
- 四类归因各自口径明确、措辞有守卫；
- **未越界**（不改 `engine/src/`、不实现 15B、不立门、不改生成）。
