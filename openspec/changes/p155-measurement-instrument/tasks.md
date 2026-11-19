# Tasks: 先分清引擎/viewer 的测量仪器（Change 0，GitHub #190）

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `specs/match-measurement/spec.md` / `tasks.md`
- [x] 1.2 `openspec validate p155-measurement-instrument --strict` → valid
- [x] 1.3 GitHub issue #190（`wayfinder:task`）与本 change 双向关联

## 2. A：冻结刺激集 + 渲染消融（可独立并行）

### 2.1 冻结刺激集

- [x] 2.1.1 从 `main = 16dfaa0` 现构建 wasm（不拷旧实验产物），记录 wasm SHA256 与构建命令
- [x] 2.1.2 选定 12 seed × 2 anchor 的引擎窗（沿用 R7i 的 seed/t0；若换集，须在 `notes/stimulus.md` 写理由）
- [x] 2.1.3 产出 `notes/stimulus.json`：seed / t0 / t1 / 采样率 / 相位 / 每 seed 事件流 SHA256 / 源码 SHA / `MODEL_VERSION` / `TICK_SECONDS` / 真实数据清单
- [x] 2.1.4 产出 `notes/stimulus.md`：口径、缺数据处理、与 R7i `windows.json` 的可比性说明
- [x] 2.1.5 `windows.sha256` 落盘；同输入重跑逐位一致

### 2.2 消融工具与报告

- [x] 2.2.1 新增 `tools/visual-review/render-ablation.mjs`：linear / catmull / t1 / direct / current 五种渲染路径
- [x] 2.2.2 新增 `tools/visual-review/render-ablation.test.mjs`：纯函数/模式选择/同输入可复现/反证条
- [x] 2.2.3 每个模式输出同窗 `trajectory.png` / `contact.png`（复用 `render.mjs` / `soft-canvas.js`）
- [x] 2.2.4 每个模式输出逐窗特征：旧/条件 `turn120`、`staticFrac`、路径长度、速度分位、加速度尾部、曲率/自转
- [x] 2.2.5 产出 `notes/ablation.md`：逐窗配对差与区间；viewer 贡献区间或「不可分解 + 缺什么」；「mover 锚点 vs 渲染帧」对照
- [x] 2.2.6 明确结论只回答「viewer 是否值得先修」，不直接给 Change 1 方案

## 3. B：条件指标 + 静止分解 + L1/守卫审计（可独立并行）

### 3.1 条件运动指标

- [x] 3.1.1 新增 `tools/visual-review/motion-census.mjs`（或在不破坏既有 API 前提下扩展 `motion-metrics.mjs`，二选一在实现时定并写注释）
- [x] 3.1.2 实现旧 `turn120` + 条件 `turn120`（双方步速 ≥0.5 m/s）、有效步数、每有效步/每米转向率
- [x] 3.1.3 实现 0.3/0.5/1.0 m/s 门限敏感性；`staticFrac`/`ballStaticFrac` 的 0.2/0.5/1.0（球 2.0）档
- [x] 3.1.4 实现 move→stop / stop→move / move→move 转移计数；速度分位与加速度尾部；方向对称性
- [x] 3.1.5 新增 `tools/visual-review/motion-census.test.mjs`：零步反证条（左→停→左不计条件转向）、门限边界、空输入、逐窗不拼接
- [x] 3.1.6 产出 `notes/motion-census.md`：旧/条件并列、三档门限、有效步分母、口径与 n

### 3.2 静止来源分解

- [x] 3.2.1 实现 `ballStaticFrac` 五类分解：`carrier_hold` / `carrier_dribble` / `highlight_flight` / `loose` / `restart/dead`
- [x] 3.2.2 报每类时间权重、条件静止率、对总静止的贡献
- [x] 3.2.3 产出 `notes/ball-static-decomposition.md`：main 2Hz 本次复算；明确 R2 旧比例不可套用

### 3.3 L1 带审计

- [x] 3.3.1 逐条读 `engine/tests/realism.rs` 及引证，填表：测试名/断言、当前值、真实锚/出处、性质（真实拟合/护栏/未验证）、宽度来源、贴沿风险
- [x] 3.3.2 重点核：射门体量、抢断体量、犯规/牌、角球、界外球、传球成功率、射门结果比例、主场优势
- [x] 3.3.3 产出 `notes/l1-band-audit.md`：每条带的性质与出处；「未验证」不得当真实锚；不删红门
- [x] 3.3.4 列出「需要重标定」的候选与最小证据（不在本 change 改带）

### 3.4 守卫分类

- [x] 3.4.1 把守卫分为真不变量 / 契约型场景守卫 / 统计记录门
- [x] 3.4.2 对 p53/p31/p6/p32 等脆弱夹具给出「显式构造场景 + 条件断言 + 多 seed 置信范围」替代建议
- [x] 3.4.3 产出 `notes/guard-audit.md`；本 change 不改任何门

## 4. C：用户尺度基线 + 汇合

- [x] 4.1 `viewer-match.mjs` 跑 seed42/5min：传球 48 / 抢断 2 / 犯规 3 / 射门 0
- [x] 4.2 90min 聚合（同 wasm / seed42）：11737 事件；pass 913 / tackle 28 / foul 24 / shot 24 / beat 10743
- [x] 4.3 产出 `notes/change0-verdict.md`：viewer 贡献区间 + 条件指标基线 + L1 带审计结论 + Change 1 建议（viewer vs engine motion layer）
- [x] 4.4 `notes/change0-verdict.md` §8 列出不确定项与最小补实验

## 5. 验收与收尾

- [x] 5.1 `git diff --stat main -- engine/ viewer/` 为空（合并后实测）
- [x] 5.2 `node --test tools/visual-review/*.test.mjs` 通过（合并时点 107 → 修复后 **112/112**）
- [x] 5.3 `openspec validate p155-measurement-instrument --strict` 通过
- [x] 5.4 独立审阅（零上下文）通过；P0/P1 修复后复审。
  Round 3 结论：**P0=0 / P1=0**（见 `notes/review-round1.md` 的「Fix log (Round 2)」与
  「Round 3 复审（收尾）」）
- [x] 5.5 产物/notes 入库（**本分支**；未 push）；不把唯一证据留 `/tmp`。
  ⚠️ 已知例外：SkillCorner/Metrica 真实数据与旧 worktree 的绝对路径是 gitignored/历史路径，
  不在本分支内；窗口表与身份哈希已入库。
- [ ] 5.6 GitHub #190 更新状态与结论摘要

## 6. 审阅修复（Round 1，2026-11-19）

- [x] 6.1 P1-1…P1-7 逐条处置；P2 cheap-doc 同步修正（见 `notes/review-round1.md` 的「Fix log (Round 1)」）
- [x] 6.2 真实侧外推点过滤后重跑 frozen/all/active 三套普查，JSON/log/notes/verdict 同步更新
- [x] 6.3 `node --test tools/visual-review/*.test.mjs` 全绿；`openspec validate p155-measurement-instrument --strict` 通过
