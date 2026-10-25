# Tasks: p-team-block-law

## 1. 设计确认（阻塞后续）

- [x] 真实 tracking 拟合块定律（`research/2026-10-25-team-shape-law/fit-team-shape.mjs`）
- [x] 真实 tracking 拟合结论与既有负结果（P38/#19/real-formation-laws/real-lateral-laws）
- [x] 原型在隔离 worktree 实测（P38 3/8→6/8；like-football 0.542→0.249；L1 3 红）
- [ ] **用户确认 design.md**（含 D4 标定策略、D5 latSd 边界）

## 2. L1 标定（硬前提）

- [ ] 机制归因：禁区内射门占比 / 抢断体量 / 射正率 分别由哪些距离门控驱动（写进 notes）
- [ ] 逐个常数标定，记录 config → L1 + P38 + like-football（表格）
- [ ] 达成 L1 9/9；若不可行 → 记录负结果并停止
- [ ] `BENCH`：标定后 like-football 距离 ≤0.30

## 3. 形状收尾

- [ ] hd 修进带（span 节点微调，验证不影响 L1）
- [ ] 轨迹图 + 单帧对比复核（横向 sd / 队形）
- [ ] 决定 FORM_INDIV 是否保留（`latSd≈3.2` 可能由其支撑——用 `FORM_INDIV=0` 反证一次）

## 4. 落地（标定通过后）

- [ ] `engine/src/lib.rs`：`formation_target` 替换 + 私有常量（无 pub 增删）
- [ ] 重写 `p5_formation_and_transition` / `p5_ball_side_shift` / `p5_press_up_and_gk_exempt`
      的断言（保留判据意图，不缩守卫）
- [ ] `MODEL_VERSION 9→10` + 新建 `engine/tests/golden-v10/` + `realism.rs:1355` 分派
- [ ] spec delta 通过 `openspec validate`；`openspec archive` 预演
- [ ] `./verify.sh` 全绿；ratchet 22 项无退化
- [ ] 独立审阅闭环（零上下文 subagent；CLAUDE.md §3）：代码 + 数字出处 + 机制归因

## 5. 交付

- [ ] `research/2026-10-25-team-shape-law/report.md` 更新最终数字与出处
- [ ] `.scratch/notes/team-shape-2026-10-25/` 实验记录补齐（标定过程）
- [ ] PR 描述：改前/改后判据表 + L1 逐条 + 风险/未做
