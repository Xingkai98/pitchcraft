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

### D1: 球相关队形目标（真实感层核心，替代 p4 的占位目标）

> 审阅确认"静态 home 回位"产生 11 个独立人偶，不产生队形平移。本 change 落地球相关队形目标。

- 每球员目标位置 = **角色基准 + 队形偏移**。队形偏移是 `(球位置, 控球阶段, 球侧)` 的公式：
  - 防线随球前压/回撤（**防线 = 防守方后卫线（外场后卫，不含门将）**；防守线 push up / drop back，**且防守线不得越过球——沿己方进攻方向钳制：home 攻左→右则 line.x ≤ ball.x，away 攻右→左则 line.x ≥ ball.x**；**门将不参与防线前压，仅回位到门线**）
  - 全队随球侧平移（ball-side shift，球在左半场全队偏左；防守时收窄到球侧，进攻时保持宽度；**门将除外——不参与球侧平移，仅回位到门线**）
  - 控球阶段压上（己方 attack phase 时整体前压，对方持球/己方 defend 时回收）
- **球侧平移用连续映射**：shift ∝ (ball_x − 0.5)（而非二分切换），避免球在中线附近时全队左右 shuffle（防 P5-9 集体抖跳）。
- **后卫线识别规则（审阅 p5）**：防线 = 每队离己方门线最近的 4 名外场球员（按 pos[] 到己方门线距离排序取前 4，不含门将）——`default_lineup` 是扁平 `{id,x,y}` 无角色标签，此规则保证防线公式可落子。
- 角色基准 = 现有 `default_lineup` 4-4-2 锚点（作为 home 目标）。
- 每个开放比赛时刻，球员目标随球/阶段实时变化。
- **防"橡皮筋"**：每 tick 移动受速度上限（approach-rate cap）+ 静区（dead-zone）约束，movers 保持增量。**运算顺序：先 dead-zone 判定（位移 < 阈值不动不发），后 approach-rate cap（位移限幅）**。
- **dead-zone 绑定 P4 单门（审阅 p5）**：dead-zone 阈值 == P4 movers 位移阈值（0.5m，同一变量），**不作为独立可调参数**——保证 last-emitted-pos 恒等于 pos[] 不变量跨 change 成立。
- **防重叠**：目标点间距约束（repulsion），避免两圆点重叠（也进 match-engine spec）。**作用域 = 同队内部（11 人之间，不跨队）**；**施加顺序 = 在队形偏移/close_down 目标确定之后，对目标点做最小间距修正**。
- **carrier 目标与 main 接缝（审阅 p5）**：持球者的移动由 main 表达（带球轨迹），队形公式不直接移动 carrier 的逻辑位置；transition 的"持球者前插" = main 的带球目标（高速推进），经 main 表达，不进 movers。
- **为什么**：这是"像足球"的最大真实感来源——阵型伸缩/平移。

### D2: 控球阶段 + 攻防转换（真实感层核心）

> 审阅确认"攻防转换/突然反击"是最像足球的时刻。

- 引擎维护每队 `phase`（attack / defend / transition）。
- **transition 触发**：球权易主——**tackle 成功 + 射门被扑住（save-caught）**（p4 有生产者的高亮事件）；拦截标注"后续加入"（p4 不产拦截）。**save-rebound（扑出反弹）不触发 transition**——按普通松散球（P4 D11）处理，phase 按拾取方刷新（S2.2d 通用规则）。
- **transition 窗口 = 固定 `TRANSITION_TICKS = 4`**（确定性常量，非随机，保证可断言）。
- **窗口起算点（审阅 p5）**：**tackle 成功 → 在 tackle 高亮起点 tick 武装**（接触即得球权，tackle 高亮时长 1 tick）；**save-caught → 在 save 高亮终点 tick 后的首个整数 tick 边界武装**（门将扑住时刻可非整数，取整到下一整数 tick——与 tackle 的"起点 tick 武装"不同，不算对称）。"持球者前插"目标等新持球者拾取松散球后才激活（P4 D11 时序）。
- **窗口 vs 拾取时序（审阅 p5）**：transition 窗口（4 tick）从武装 tick 起算，不因松散球延长；tackle 高亮 1 tick → 松散球在触发 tick 的 t_end 产生，拾取 ≤ 触发 tick + 2（< 窗口 4）→ "持球者前插"目标必在窗口内激活。**松散球追逐限定赢得球权一方**（P4 D11 队过滤）→ 窗口内无二次球权翻转。
- **松散球期间 phase（P5-D）**：球权易主后的松散球阶段（无人持球），两队 phase 沿用最后持球方归属（新进攻方仍 attack、新防守方仍 defend），待新持球者拾取后按球权刷新——transition 窗口不因松散球中断。
- **transition 与 p4 高亮门控合成**：transition 期间持球 hold 门控**暂停**（钉死为暂停这一种：transition 期间不掷新高亮，无"hold 计数下限"备选；hold 计数**冻结**——不增不减，transition 结束续走），保证反击窗口完整可见。
- **transition 行为**：新进攻方持球者目标前移（高速推进，经 main 表达）、全队前压（队形偏移放大）；**save-caught 时 carrier = 门将，门将不参与"前插"**（前插只作用于外场球员；门将持球 main 在门线零位移/短带，随后经 pass 高亮出球，队形前压由外场球员执行）；新防守方整体回撤 + 就近 2 名外场防守者收缩（close_down，覆盖队形目标；**过渡期（武装 tick → 松散球产生）close_down 目标 = 接触点/被铲者位置**，松散球产生后切换为球位，拾取后切换为持球者）。
- transition 窗口结束 → 回到 attack/defend（按球位置/持球方）。
- **为什么**：粗糙的 transition 也能产生"突然反击"画面。

### D3: micro-motion（真实感层 viewer polish）

- viewer 渲染层：静止球员（不在 movers/高亮参与者/**main 持球者**）在逻辑位置做小幅重心调整（振幅 < 0.002 归一化，约 0.2m）。
- **确定性且连续**：偏移 = `A(id)·sin(2π·t/T(id) + φ(id))`，其中 A/φ/T 由 `hash(id)` **一次派生并缓存**（球员级常量，入场即定，非每 tick 重哈希；去冗余相位 t0——由 φ 吸收）；t = 连续比赛时间（连续推进，不 floor 到 tick）——波形连续，tick 边界自然无跳变（避免 P5-1 整秒抖跳）。
- **不改变逻辑位置**：仅渲染偏移（drawPlayer），不进 game.players 逻辑位置——不污染调试日志、不违反无 snap、确定性可重放。
- **抑制**：球员正在移动（movers 或高亮参与者）或为 main 持球者时不做 micro-motion（避免人球分离，P5-8）。
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

- 队形偏移公式的具体参数（防线前压幅度、球侧平移量、approach-rate cap）——实施时定义并调参（dead-zone 绑定 P4 单门 0.5m，非独立参数）。
- 是否把 loose-ball 回收也纳入 transition 触发（新持球者拾取松散球后是否刷新 transition 窗口）——实施时看 tackle 高亮流程。
