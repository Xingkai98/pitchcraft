# Tasks: 高亮结束那一拍的分离视野缝隙（#149）

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/match-engine/spec.md`（delta 格式）
- [ ] 1.2 `npx openspec validate`（本环境不可用）——**手工核对**：MODIFIED requirement 标题与主 spec
      `### Requirement: 同队球员间距（≥2m）` 逐字一致、scenario 全量复制 + 新增 1 条（见审阅 P1-1 的补正）

## 2. 复现（门槛）

- [x] 2.1 本 worktree 从源码重建 wasm（不拷旧实验）：`574b653f7d8e`（= main B），与归因一致
- [x] 2.2 `node tools/spacing-sweep.mjs 2` → **5 findings / worst 1.957m**（复现 #149）
- [x] 2.3 探针定位真机制（`zz_probe_seed2.mjs` 时序重建）+ 数值核验（solver 口径 2.146 vs viewer 真实
      1.258）⇒ **订正 §9.6 机制**（起点距 2.596 ≥ 2.14，早返回未触发）

## 3. 实现（`engine/src/lib.rs`，最小改动）

- [x] 3.1 `highlight_frozen_segs`：**窄触发**（落点落在同队 mover 本拍候选轨迹 2.0m 内才介入）+
      两档（严格本拍内完成→落点一点；下一拍内完成→终点钉落点）；新增 `point_seg_dist_m` +
      常量 `SAME_TEAM_OVERLAP_MIN_M=2.0`
- [x] 3.2 SHALL NOT：无阈值/detector 门/统计带变更；无事件层常数变更；无 viewer 变更（自查 diff）
- [x] 3.3 引擎级测试 `p53_highlight_landing_enters_solver_on_breach`（窄触发三门 + 严格边界 + 跨队豁免）
      ——补审阅 P2-2 的覆盖缺口

## 4. 全量复验（缺一不可）

- [x] 4.1 `cargo test`（默认全量）全绿
- [x] 4.2 `cargo test --test realism --release -- --ignored` L1 **9/9**（`l3_shot_ratios` 0.721）
- [x] 4.3 `node tools/spacing-sweep.mjs`（默认 8 seed）**全 0**（本 change 验收核心）
- [x] 4.4 `cd viewer && node e2e-v2.mjs`（无 snap）；viewer 352/353（唯一红 = `app.test.js`，环境缺
      jsdom，非本次引入）；tools 单测 505/505
- [x] 4.5 golden-v8：行为变了照规重基线（`ACCEPT_GOLDEN=1`）；**只 seed 2 变**，diff 记入 design §D4
- [x] 4.6 churn 实测（`zz_churn.mjs`）：blast radius 落在触发 seed（golden 1..10 只 seed 2 变）
- [x] 4.7 **反证**：撤修法（换回 `574b653f`）→ `node tools/spacing-sweep.mjs 2` 回红（exit 1）

## 5. 独立审阅（零上下文 paseo agent）

- [x] 5.1 起零上下文 paseo agent 审 diff（P0=0；P1×1 spec 文本过宽；P2×2；P3×4）
- [x] 5.2 处理：P1-1 补 spec 窄触发条件与严格边界；P2-1 注释/design 改精确表述；P2-2 加引擎测试；
      P3-1/3-2/3-4 修文档引用 / 补 diff 全集 / 同步勾选；P3-3 为既存哨兵采样盲区（信息项，记 design）

## 6. 收尾

- [x] 6.1 回填 design §D4 复验读数
- [ ] 6.2 push → 等 CI（`gh run list` / `gh pr checks`）全绿（含 step 5 归零）；PR base=main
- [ ] 6.3 落盘 `REPORT-to-main-session.md`（结论 / CI 链接与状态 / diff 摘要 / 复验读数）；**不自行 merge**
