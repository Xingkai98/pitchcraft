# Design: 先分清引擎/viewer 的测量仪器（Change 0）

## D0 目标与硬边界

**目标**：把「引擎 mover 意图 / viewer 插值纹理 / 指标定义」三者对 `turn120`、`staticFrac`、`ballStaticFrac` 的贡献分开；给出可复现的冻结刺激集与条件指标；审计 L1 带的来源与性质。产物用于决定 Change 1 的优先级，不直接改比赛行为。

**硬边界（SHALL NOT）**：

- 不改 `engine/`、`viewer/` 的任何行为；`git diff -- engine/ viewer/` 为空。
- 不改 L1 / ratchet / detector 阈值；不删红门；不先放宽。
- 不跑 48 项盲测来验「无行为变更」；盲测归 Change 1。
- 不把历史数字当本次复测；所有历史读数标「转述」。
- 不写唯一证据到 `/tmp`；产物落 `openspec/changes/p155-measurement-instrument/notes/`。

## D1 冻结 stimulus set（A 先交，B 复用）

**目的**：让消融与条件指标在同一批输入上可比。

固定内容：

- **引擎侧**：`main = 16dfaa0` 现构建 wasm；seeds 与窗口沿用 R7i 包的 12 seed × 2 anchor（或更小的预注册集，须在 `notes/stimulus.md` 写明）；每个 seed 的完整事件流 SHA256。
- **窗口**：24s、5Hz、121 帧；采样相位固定（与 R7i `windows.json` 一致）；窗内事件流切片（或可重建的 `(seed, t0, t1)`）。
- **真实侧**：Metrica 2 场 + SkillCorner 10 场（偶数位）× 2 anchor；真实数据清单与许可；缺数据时标 n/a，不静默填 0。
- **源码/协议**：`engine/src/lib.rs` SHA256、`viewer/*.js` SHA256、`MODEL_VERSION`、`TICK_SECONDS`、viewer `config.js` 版本。
- **产物**：`notes/stimulus.json`（机器可读）+ `notes/stimulus.md`（人读口径）+ `windows.sha256`。

**失败处理**：若 wasm/真实数据缺失，A 仍须产出「可复现的引擎侧子集」并在报告里标 `real=n/a`；不得用另一版 wasm 冒充。

## D2 同流渲染消融（A）

同一批事件流/窗口，分别用下列渲染路径出帧：

| 模式 | 定义 |
|---|---|
| `linear` | 锚点线性插值，无 Catmull，无 T1 纹理 |
| `catmull` | 现行 Catmull–Rom，无 T1 纹理 |
| `t1` | Catmull + T1 弓形纹理（现行默认） |
| `direct` | 直接事件端点重采样（不做拍内插值；对照） |
| `current` | 现行 viewer 全链（含 highlight 滑行/间隙 hold） |

每个模式输出：同窗 `trajectory.png` / `contact.png`（复用 `tools/visual-review/render.mjs` 与 `soft-canvas.js`），以及 `turn120`（旧/条件）、`staticFrac`、路径长度、速度分位、加速度尾部、曲率/自转。

**报告**：`notes/ablation.md`，必须给出：

- 每个指标的 `mode` 间差值与区间（逐窗配对，不跨窗拼接）。
- 「引擎 movers 锚点」与「渲染帧」的同特征对照（能算多少算多少，缺口径如实写）。
- viewer 贡献的**区间**，不是单点百分比；若无法分解，明确写「不可分解」及缺什么。
- 结论只回答「viewer 是否值得先修」，不直接给 Change 1 方案。

## D3 条件运动指标（B）

**旧 turn120（兼容列）**：相邻两步方向差 >120°，零步也计角——保留，但只作历史对照。

**条件 turn120**：

- 仅当相邻两步的步速都 ≥ `0.5 m/s` 时计入转向。
- 并列报：有效步数、每有效步转向率（turns per effective step）、每米路径转向率。
- 邻近门限敏感性：`0.3 / 0.5 / 1.0 m/s` 三档；主口径 `0.5`，其余作稳健性。
- 同时报 `move→stop`、`stop→move`、`move→move` 三类转移的计数与占比。

**静止与球**：

- `staticFrac`：步速 <0.5 m/s 的步占比；另报 <0.2 / <1.0 两档。
- `ballStaticFrac`：球相邻原始帧速度 <0.5 m/s 的步占比；另报 <0.2 / <2.0 两档。
- 速度分位：p50 / p90 / p99；加速度尾部（|Δv|/Δt 的 p95/p99）。
- 球场方向对称性：底/顶边使用率、左/右半场使用率（有符号不对称量）。

**口径**：逐窗算 → 对窗取分布；不跨场拼接；剔门将；外推点按既有规则（真实侧默认跳过）；每项带 `n`、`seed`、窗口长度、采样率。

## D4 ballStaticFrac 来源分解（B）

对同一批引擎窗，按时间权重归类球静止的来源：

| 类别 | 判定 |
|---|---|
| `carrier_hold` | 开放比赛、球附着于持球者、`carrier_move` 走 hold 分支 |
| `carrier_dribble` | 开放比赛、球附着于持球者、走推进分支 |
| `highlight_flight` | 传球/射门/门球飞行高亮 |
| `loose` | 松散球/争抢 |
| `restart/dead` | 死球/重开准备/角球准备 |

输出：每类的时间权重、条件静止率、每类对总静止的贡献。**R2 的旧比例不能套给 main 2Hz**；必须本次复算。

## D5 L1 带来源审计（B）

逐条读 `engine/tests/realism.rs` 及引证，建立表格：

| 字段 | 含义 |
|---|---|
| 测试名 / 断言 | 带或比率 |
| 当前值 | main 行为实测（或注明转述） |
| 真实锚 | 出处、样本量、口径 |
| 性质 | `真实拟合` / `护栏` / `未验证` |
| 宽度来源 | 数据分布 / 历史标定 / 经验值 |
| 风险 | 贴沿、伪影撑起、口径敏感 |

**规则**：

- 角球、界外球、抢断体量等已被历史标为护栏的，按护栏处理，不把带中点当真实最优。
- 传球成功率、犯规/牌、射门体量、射门结果比例等待核来源的，标「未验证」，不替它们认证真实拟合身份。
- 主场优势方向是群体统计假设，不是每批 seed 必须通过的物理不变量；来源与功效另审。
- 确定性、坐标有限、身份合法、事件/状态对账、球权一致仍是硬门；固定 seed 的覆盖夹具可替换，但不能删契约。

## D6 守卫分类与场景夹具（B）

把现有研究/赛况守卫分为：

1. **真不变量**（确定性、坐标、身份、事件对账、球权）——保留硬门。
2. **契约型场景守卫**（p53 同队间距、p31 不死锁、p6 角球双追、p32 拦截概率自洽）——保留契约，替换脆弱触发夹具（显式构造场景 + 条件断言 + 多 seed 置信范围）。
3. **统计/记录门**（p15/p16/p124/p17b 的固定 seed 覆盖、历史读数）——可重扫/重钉，但必须换样本不换判据。

产出 `notes/guard-audit.md`：每条守卫的类别、当前实现、脆弱点、替代夹具建议、是否本 change 可动（默认不动）。

## D7 用户尺度基线（B 或主 session）

- `node tools/visual-review/viewer-match.mjs viewer/engine.wasm`：seed42/5min 原始事件计数（传球/抢断/犯规/射门）、最长无动作段、墙钟。
- 90min 聚合：同 seed 或预注册 seed 集，报事件量与 L1 关键量。
- 两者并列，先写 5min。不强行要求每 5min 有射门；0 射门本身可能是真实 5min 的可发生结果，需分布与现场观看，不能据此断言模拟错误。

## D8 并行与文件所有权

**A（消融）**：

- 新 `tools/visual-review/render-ablation.mjs` + `render-ablation.test.mjs`
- `notes/stimulus.json` / `notes/stimulus.md` / `notes/ablation.md`
- 只读 `replay-blind-core.mjs` / `render.mjs` / `soft-canvas.js`；如需改共享文件，先在 issue/PR 说明，不与 B 同时改。

**B（仪器/守卫）**：

- 新 `tools/visual-review/motion-census.mjs` + `motion-census.test.mjs`（或在不破坏既有 API 的前提下扩展 `motion-metrics.mjs`，二选一，须在 design 落地时定）
- `notes/ball-static-decomposition.md` / `notes/l1-band-audit.md` / `notes/guard-audit.md`
- 只读 `engine/tests/realism.rs`、`viewer/match-metrics.js`；不改其断言。

**共享只读**：`replay-blind-core.mjs`、`render.mjs`、`soft-canvas.js`、`viewer/game.js`。A 的 frozen set 是 B 的输入；A 先交 `notes/stimulus.json`，B 可用自己的 L1 审计先行。

**汇合**：主 session 在两条工作流都完成后写 `notes/change0-verdict.md`：viewer 贡献区间 + 条件指标基线 + L1 带审计结论 + Change 1 建议（viewer vs engine motion layer）。

## D9 验收标准

- `openspec validate p155-measurement-instrument --strict` 通过。
- `git diff -- engine/ viewer/` 为空（行为零改动）。
- 新工具单测通过；旧 viewer/tools 套件不新增红。
- `notes/stimulus.json` 带 seed / 窗口 / 事件流 SHA / 源码与协议版本。
- `notes/ablation.md` 给 viewer 贡献区间，或明确「不可分解 + 缺什么」。
- `notes/motion-census` 同时报旧/条件 turn120、三档门限、move/stop 转移、ballStaticFrac 分解。
- `notes/l1-band-audit.md` 每带都有性质与出处；「未验证」没有被当真实锚。
- `notes/guard-audit.md` 给出可替换夹具建议；本 change 不改守卫。
- 用户尺度 5min 与 90min 并列，口径完整。

## D10 风险与已知限制

- 消融可能无法给出唯一百分比（交互项、非线性）；允许给区间与「不可分解」。
- 真实侧 24 窗不是全部真实足球；结论标注样本边界。
- 历史 R4/R5c/R7 的因果结论只作转述；本 change 不重跑那些实验。
- `wasm` 与 native 非逐位同流（既有记录）；阈值边缘判定仍以 cargo 为准。
- 若 A 的 frozen set 与 B 的 L1 审计时间错开，B 先交 L1 审计；不得用不同 wasm/seed 的读数拼表。

## D11 参考

- GitHub #190；地图 #175；C1 #170；#122；#166。
- `.scratch/notes/handoff-astra-2026-11-19.md`；`.scratch/notes/astra-diagnosis-2026-11-19.md`。
- `tools/visual-review/discriminator-census` 的原始脚本在 `fix/formation-jitter-dc-bias/2026-11-01` 分支（`openspec/changes/fix-formation-jitter-dc-bias/notes/probes/discriminator-census.mjs`）。
