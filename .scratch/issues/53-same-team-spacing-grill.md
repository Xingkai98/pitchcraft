# Grill Design: #53 引擎侧同队间距约束（≥2m）

> batch-grill-me：codex 标推荐。用户确认前不写实现代码。
> 依赖 #25 已完成（槽位层已删、涌现驱动、`compute_movers`/`formation_target` 是当前队形/跑位层）。

## 背景（facts，已从代码确认）

### 现象与根因

- **现象**（#35 实测）：同队球员可贴到 0.11m；观察窗口同队最小间距 0.54/0.65/1.20m，均 <2m。
- **detector 侧**：`tools/detectors.mjs:628` `player_overlap` 已存在（#35 的 detector 部分，P26），
  阈值 `min_distance=2.0m`（strict `<`），按同队 pair 聚合、severity=realism_warning。
  `openspec/specs/diagnosis-runner/spec.md:178` 已立 requirement（2.0m）。
- **引擎侧根因① 口径不一致（核心）**：`REPULSION_MIN_DIST = 0.02` 是**归一化**值（`lib.rs:596`），
  但 repulsion 用 `dist_norm`（`lib.rs:606`）= 归一化欧氏距离，**无轴向缩放**。球场 105×68m，
  故 0.02 归一化 = x 方向 **2.1m**、y 方向 **1.36m**。而 detector 用**真实米制**（`derive-audit-features.js:324`
  `x*pitch.length / y*pitch.width`，pitch=105/68）。→ 引擎「以为」保证了 2m，实际 y 方向只保证 1.36m。
  （issue 原文写「×68≈1.36m」正是 y 轴；x 轴其实是 2.1m，两轴不一致才是真病灶。）
- **引擎侧根因② target 层 ≠ 最终位置**：repulsion 只对 `targets`（目标点）迭代 ≤3 次
  （`lib.rs:2766-2785`），不保证**最终移动后位置**（`st.pos` 发射坐标）间距。移动步长 ≤ 4m/s×1s，
  两人从近处出发奔向分离目标，最终位置可能仍 <2m。
- **引擎侧根因③ 盲区**：
  1. carrier 不参与 repulsion（`lib.rs:2744` `id == st.carrier { continue }`），由 `carrier_move` 独立走位，
     可能带进队友 2m 内；
  2. 特殊站位（corner_prep 的 `corner_setup_target`、close_down_stop、anticipate/chase 目标）虽经 repulsion，
     但 `corner_setup_target`（`lib.rs:2604`）用 id 哈希在禁区 y∈[0.2,0.8] 分散，同队可能 <2m；
  3. dead_zone（`DEAD_ZONE_METERS=2.0`，`lib.rs:487`）：球员距目标 <2m 时不产 mover（`lib.rs:2801`），
     重叠球员停在原处，最终位置不分离。

### 度量/采样口径（detector 真实门）

- detector 采样步长 `sample_step=0.5s`（`derive-audit-features.js:22`），坐标 `round3`（毫米），
  在**事件锚点间线性插值**（`interpolateAnchors`）。→ 保证「整数 tick 发射位置 ≥2m」未必覆盖 0.5s 中点。
- 位置锚点 = 事件的 mover `to_x/to_y` / main / lineup（含 last_emitted 冻结）。
- `round3` + strict `<2.0m` → 引擎需留安全边距（例如目标 2.05m），否则 2.000m 经毫米舍入可能 1.999m 误报。

### 影响面 / 级联

- **golden**：`MODEL_VERSION=5` → `tests/golden-v5/`（`realism.rs:1084`）。改间距会改 mover `to_x/to_y`
  → `stream_hash` 变 → **必须重基线**。P27–P31 先例：每次改变可观测行为 = 新 golden 目录（v2..v5 均保留）。
- **级联**：抢断/犯规频率（`l1_tackle_dilution_and_slot_mix`、`l1_fouls_and_cards`）随位置变化可能漂移；
  `#35` player_overlap 告警应**归零**（这正是 #53 的验收）。
- **已存在但需更新**：`lib.rs:5685` `p5_repulsion_separates_overlap` 断言 `d > 0.005`（归一化 ≈0.34m y），
  需改成米制 2m 断言。
- **out of scope**：`match-engine/spec.md:156` 抢断 `subject_end/carrier_end` 分离「约 0.03」是**跨队**分离
  （抢断者 vs 被抢者），player_overlap 只查同队，不动。

## Grill 决策树

### Q1 间距度量空间（根治口径不一致）

- **A** 把间距约束搬到**米制空间**：新增/复用 `distance_meters`（x×105, y×68）做分离判定与推开，
  `REPULSION_MIN_DIST` 改为米制常量（如 `2.0m` + 安全边距 0.05 → 2.05）。detector 恰用米制，口径一致、可证。
- B 留在归一化空间但**分轴**阈值（x 用 2/105≈0.019、y 用 2/68≈0.029）：治标，双常量易漂移、难读。
- C 只把 0.02 提到 0.03 归一化（x 3.15m / y 2.04m）：过分离 x、仍未解决口径不一致、且 0.03 不是「2m」。

### Q2 最终位置保证机制

- **A** 两阶段：保留 target 层 repulsion（现状，改米制）+ **最终位置后处理分离**——对整队 `st.pos`
  跑一遍「同队 < 阈值则沿连线推开」硬推，保证**发射坐标** ≥2m。
- B 只加 target 层迭代次数 + 纳入 carrier，接受最终位置残余（不保证）。
- C 连续松弛循环（迭代到收敛）：最稳但最重、可能改写 RNG 无关的纯几何推挤多次，难定收敛界。

### Q3 盲区覆盖（carrier / 特殊站位 / dead_zone）

- **A** 后处理分离作用于**全体外场 + 门将**（含 carrier、corner/close_down/chase/anticipate 目标、
  门将），一处兜底所有路径；carrier 也在最终位置参与分离。特殊站位函数不改，由兜底保证。
- B 只补 carrier + 逐特殊站位函数改（corner_setup_target 等各自保证）——多处改、易漏。
- C 保留盲区（接受残余 <2m，只做 Q1 阈值提升）。

### Q4 golden 重基线策略

- **A** `MODEL_VERSION` 5→6，新增 `tests/golden-v6/`，保留 v1..v5 作历史对照，
  更新 `gm_legacy_baselines_preserved_and_differs`（当前流与 v1..v5 都不同）。
- B 原地重基线 v5（`ACCEPT_GOLDEN=1` 覆盖）：丢历史、违反 P27–P31 已建立的「行为变更=新目录」纪律。
- C 不改 golden：不可能——流必变。

### Q5 采样级保证（0.5s 插值中点）+ 验收方式

- **A** 引擎硬门 = 新增**引擎侧单测**：跑完整比赛（或固定 seed 集），逐 tick 扫描**发射位置**
  （mover to/main/lineup）同队两两米制距离 ≥ 2.0m（留 epsilon）；0.5s 中点由 **tools detector 零 finding**
  断言兜底（detector 是真实门，若中点越界会红，再迭代）。不在引擎里预做中点分离（过度工程）。
- B 引擎额外对每段 mover 中点做分离保证：重、复杂，且中点不是发射坐标、viewer 也未必采样到。
- C 不设引擎侧硬门，只靠 tools detector 零 finding：detector 是 JS 层，引擎回归会漏到 viewer 才暴露。

### Q6 是否需要独立 OpenSpec change + 编号

- **A** 按流程立 OpenSpec change（`p34-same-team-spacing`，proposal+design+specs+tasks），
  validate 通过后 `/opsx:apply` 实施。spec 落 `match-engine` 新增「同队间距 ≥2m」requirement。
- B 直接改代码不立 change：违反项目 OpenSpec 流程（CLAUDE.md 强制）。

## 若按推荐（倾向全 A）走，改动集预览

1. `engine/src/lib.rs`：`REPULSION_MIN_DIST` 米制化 + 米制分离纯函数 + 最终位置后处理分离（含 carrier/门将）；
   更新 `p5_repulsion_separates_overlap`；新增 `p53_same_team_spacing_ge_2m` 整场扫描单测。
2. `engine/src/lib.rs` `MODEL_VERSION` 5→6。
3. `engine/tests/realism.rs`：`golden_dir` 加 6；`gm_legacy_baselines_preserved_and_differs` 加 v5 对照；`ACCEPT_GOLDEN=1` 生成 v6 基线（提交前人工审查 diff）。
4. `openspec/specs/match-engine/spec.md`：新增同队间距 requirement。
5. `openspec/changes/p34-*`：proposal/design/specs/tasks。

## codex 推荐（2026-09-15，gpt-5.6-sol / high）

**先修的 facts 偏差**（codex 指正）：
- Q1 核心不是「有没有米制 helper」（`distance_meters` 已存在），而是 repulsion 的**判定距离 + 推开向量**都要同一米制几何。
- 现 `p5_repulsion_separates_overlap` 只证 target 层被推开、查的是 mover `to_x/to_y`，不覆盖 carrier/门将/dead-zone 停者的**最终 st.pos**。
- carrier 若在 compute_movers 内改 `st.pos[carrier]` 会晚于 `carrier_move` 返回 MainAction，不一起修 `main.x2/y2`/`ball_pos`/`carrier_from`/`last_emitted` 会状态不一致。
- `CLOSE_DOWN_STOP_DIST`/dead-zone/步长也仍用归一化近似，说明「引擎已全米制化」不是事实（但本 issue 不强求全修）。

**Q1 推荐：A**（米制空间，阈值 2.0m + 安全余量 ≈2.05m）。保留归一化存储，新增局部米制距离/推开纯函数（dx×105、dy×68，方向也先在米制算再换回）。B 只有实现成椭圆度量才与 A 等价，单纯分轴阈值/换常量不是同一判定边界。风险：余量过大会让角球/禁区/门前过疏散；只修 repulsion 不修全引擎运动学轴向近似。

**Q2 推荐：A**（保留 target 层 repulsion + 最终候选位置分离后处理），但后处理必须放**写入 st.pos / 构造 mover/main 之前**，不是事后补改。固定上限确定性迭代（先算 carrier 候选 + 全部 mover 候选含 dead-zone 停者 → 同队 pair 米制分离 → 再按修正终点构造事件并一次性写 st.pos）。语义副作用（改 close_down 停点/角球包抄点）接受为「最小必要推移」，不重选目标不重抽 RNG。风险：一轮 pair sweep 不保证全局无冲突（需固定迭代 + 终断言）；边界 clamp01 可能致分离不足（需边界感知方向或记录退化）。

**Q3 推荐：A**（最终分离覆盖 carrier/门将/全部特殊站位路径；特殊函数继续表达「想去哪」，分离层统一表达「≥2m」，不分散到各入口）。carrier 安全做法：随机结果视为已确定候选终点，几何分离零 RNG、固定遍历顺序；重构 carrier_move 先产候选 MainAction → 统一 solver 修正 → 再统一提交。若不重构则必须同步修 `MainAction.x2/y2`（x/y 保留起点）、`st.pos[carrier]`、`ball_pos`、`carrier_from`、`last_emitted[carrier]`。风险：carrier 被推开球跟着走 → 后续事件流可观测变化；边界+角色优先级需写成确定性规则。

**Q4 推荐：A**（MODEL_VERSION 5→6，新增 golden-v6，保留 v1–v5）。legacy 测试从 v1–v4 扩到 v1–v5，当前 v6 与全部旧版比较；版本注释/「当前 v5」文字同步更新。风险：新 golden 可能掩盖过大漂移，须人工审查比分/射门/传球/抢断/犯规/出界 diff；频率大漂移应拒绝基线继续定位。

**Q5 推荐：A**（引擎硬门查每 tick 最终发射位置 + detector 继续作 0.5s 采样/viewer 口径真实门）。明确边界：A 只保证「发射锚点」，detector 零 finding 才保证当前 viewer 0.5s 采样无越界；若 detector 抓到中点越界 → 回引擎调 solver，不忽略。**不**在引擎预计算每段中点推开（把 detector 观测模型硬编码进模拟器=过度工程）。风险：非连续时间数学保证；验收脚本必须真跑 detector 不只跑 Rust 单测。

**Q6 推荐：A**（OpenSpec change `p34-same-team-spacing`，proposal+design+specs+tasks，validate 后 apply）。`match-engine` 新增同队最终位置 ≥2m requirement；`diagnosis-runner` 已有 detector requirement 不重复定义冲突阈值。change 需写明：引擎硬门=最终发射/状态位置、viewer detector=0.5s 采样插值、tackle `subject_end/carrier_end`=跨队分离 out of scope、carrier 状态同步、边界处理、dead-zone/特殊站位优先级。风险：validate 绿 ≠ 几何正确，仍需 Rust 单测 + golden 审查 + detector 三重验证。

**核对清单（codex 补全，比 grill 预览多出）**：carrier 提交顺序与事件字段同步、MODEL_VERSION/版本注释更新、legacy v1–v5 扩展、最终位置 solver 的边界/有限迭代验收、实际 detector 回归命令。「米制分离纯函数」须含米制推开向量（不能只换距离比较）。

## Open Questions

无。codex 已标推荐（全 A），待用户确认后立项。

## User Confirmation

（待用户确认。）
