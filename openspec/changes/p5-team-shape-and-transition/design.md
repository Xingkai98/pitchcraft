# Design: 队形公式 + 阶段转换 + micro-motion（team-shape-and-transition）

## Context

P4（并行节拍核心，Change A）建立固定 tick + beat 事件 + 球所有权。本 change 在 p4 核心之上加"真实感层"：队形整体移动、攻防转换/反击、静止球员 micro-motion。三者都是引擎内可调公式 / viewer 渲染 polish，不改变 beat 协议或 viewer 架构。

## Goals / Non-Goals

**Goals:**
- 球相关队形目标：每球员目标 = 角色基准 + 队形偏移（防线随球前压/回撤、全队随球侧平移、控球阶段压上）。
- 控球阶段 + 攻防转换：球权易主触发 transition（新进攻方前插、新防守方回撤 + 就近收缩）。
- micro-motion：viewer 给静止球员小幅重心调整（不改变逻辑位置，确定性）。

**Non-Goals:**
- 不做完整战术系统（阵型/指令/角色职责深度）——票据 04。
- 不做球员 AI（决策打分/能力值）——票据 05。
- 不做盯人系统（一对一标记）、逼抢压力系统——后续。
- 不做定位球。

## Decisions

### D1: 球相关队形目标（p4 D8 从 p4 移入）

> 审阅确认"静态 home 回位"产生 11 个独立人偶，不产生队形平移。本 change 落地球相关队形目标。

- 每球员目标位置 = **角色基准 + 队形偏移**。队形偏移是 `(球位置, 控球阶段, 球侧)` 的公式：
  - 防线随球前压/回撤（防守线 push up / drop back，**且防守线 x 不超过球 x**）
  - 全队随球侧平移（ball-side shift，球在左半场全队偏左；防守时收窄到球侧，进攻时保持宽度）
  - 控球阶段压上（己方持球时整体前压，对方持球时回收）
- 角色基准 = 现有 `default_lineup` 4-4-2 锚点（作为 home 目标）。
- 每个开放比赛时刻，球员目标随球/阶段实时变化。
- **防"橡皮筋"**：每 tick 移动受速度上限（approach-rate cap）+ 静区（dead-zone，位移 < 阈值不移动）约束，movers 保持增量。
- **防重叠**：目标点间距约束（repulsion），避免两圆点重叠。
- **为什么**：这是"像足球"的最大真实感来源——阵型伸缩/平移。

### D2: 控球阶段 + 攻防转换（p4 D11 从 p4 移入）

> 审阅确认"攻防转换/突然反击"是最像足球的时刻。

- 引擎维护每队 `phase`（attack / defend / transition）。
- **transition 触发**：球权易主（tackle 成功、扑救、拦截——有生产者的事件）。transition 窗口 = 3-5 tick（≥1s，保证反击可见）。
- **transition 行为**：新进攻方持球者目标前移（高速推进）、全队前压（队形偏移放大）；新防守方整体回撤 + 就近 2 名外场防守者向持球者收缩（close_down，覆盖队形目标）。
- transition 窗口结束 → 回到 attack/defend（按球位置/持球方）。
- **为什么**：粗糙的 transition 也能产生"突然反击"画面。

### D3: micro-motion（p4 P3.5 从 p4 移入）

- viewer 渲染层：静止球员（不在 movers/高亮参与者）在逻辑位置做小幅重心调整（振幅 < 0.002 归一化，约 0.2m）。
- **确定性**：位移由 `hash(id, floor(t))` 决定，非每帧随机——保证重放一致。
- **不改变逻辑位置**：仅渲染偏移（drawPlayer），不进 game.players 逻辑位置——不污染调试日志、不违反无 snap、确定性可重放。
- **抑制**：球员正在移动（movers 或高亮参与者）时不做 micro-motion。
- **为什么**：真实球员始终小幅调整重心，冻结圆点显假。

## Risks / Trade-offs

- **[橡皮筋]**: 队形目标若参数不当会全体拖向球/振荡。缓解：approach-rate cap + dead-zone + 间距约束；参数调优。
- **[transition 频率]**: 只有 tackle 成功等触发，约 4-7 次/场反击（50/50 抢断）。缓解：后续加拦截/扑救触发的过渡。
- **[micro-motion 违反无 snap]**: 若改变逻辑位置会破坏跨拍连续。缓解：仅渲染层偏移，逻辑位置不变。
- **[确定性]**: 阶段/队形/微动都必须种子确定，保证同 seed 同回放。

## Migration Plan

- 引擎：per-tick 目标决策升级（锚点 + 队形偏移 + 阶段）；加 phase 状态机 + transition 窗口。
- viewer：micro-motion 渲染（render 层）。
- 不改变 beat 协议、viewer 架构、接缝。

## Open Questions

- 队形偏移公式的具体参数（防线前压幅度、球侧平移量、approach-rate cap、dead-zone）——实施时定义并调参。
- transition 窗口的确切长度与衰减（3-5 tick？）——实施时定。
- 是否把 loose-ball 回收也纳入 transition 触发——实施时看 tackle 高亮流程。
