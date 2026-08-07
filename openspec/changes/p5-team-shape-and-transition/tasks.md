# Tasks: 队形公式 + 阶段转换 + micro-motion（team-shape-and-transition）

> 本 change = Change B（真实感层），依赖 p4（并行节拍核心）。

## S1. 引擎：球相关队形目标

- [ ] S1.1 队形偏移公式：`目标 = 角色基准(default_lineup) + 队形偏移(球位置, 控球阶段, 球侧)`
- [ ] S1.2 防线随球前压/回撤（防线 = 防守方后卫线，不含门将；防线 x 不超过球 x；门将仅回门线）
- [ ] S1.3 全队随球侧平移（防守收窄 / 进攻保宽度）
- [ ] S1.4 控球阶段压上（己方持球前压 / 对方持球回收）
- [ ] S1.5 防橡皮筋：approach-rate cap + dead-zone（位移 < 阈值不移动，movers 保持增量）
- [ ] S1.6 防重叠：目标间距约束（repulsion）
- [ ] S1.7 引擎测试：防线前压/回撤、球侧平移、静区、确定性

## S2. 引擎：控球阶段 + 攻防转换

- [ ] S2.1 每队 phase 状态机（attack/defend/transition）
- [ ] S2.2 transition 触发：球权易主（tackle 成功 + 射门被扑救；拦截后续加入）→ transition 窗口（固定 `TRANSITION_TICKS = 4`）
- [ ] S2.2b transition 窗口起算：tackle 成功 tick 武装 transition（全队前压/回撤立即生效），持球者前插目标等松散球被拾取后激活
- [ ] S2.2c transition 与高亮门控合成：transition 期间 hold 门控暂停（钉死为暂停这一种），transition 期间不再掷新高亮
- [ ] S2.2d 松散球期间 phase：球权易主后无人持球时，两队 phase 沿用最后持球方归属，窗口不中断；新持球者拾取后按球权刷新
- [ ] S2.3 transition 行为：新进攻方持球者前插 + 全队前压；新防守方回撤 + 就近 2 名外场防守者 close_down
- [ ] S2.4 transition 窗口（4 tick）结束 → 回 attack/defend
- [ ] S2.5 引擎测试：tackle 成功触发反击、窗口结束恢复、反击期间无新高亮、确定性

## S3. viewer：micro-motion

- [ ] S3.1 渲染层 micro-motion：静止球员小幅重心调整（振幅 < 0.002，逻辑位置不变）
- [ ] S3.2 确定性且连续微动：A/φ/t0/T 由 `hash(id)` 一次派生并缓存（球员级常量），t 连续推进，`A·sin(2π(t−t0)/T+φ)` 波形 tick 边界无跳变
- [ ] S3.3 移动中抑制微动（movers/高亮参与者/main 持球者不微动）
- [ ] S3.4 viewer 测试：逻辑位置不变、确定性、tick 边界连续、无 snap 不破坏

## S4. 验证与收尾

- [ ] S4.1 端到端：全队阵型伸缩/平移、攻防转换有反击、静止球员微动
- [ ] S4.2 版本号更新（index.html/app.js）
- [ ] S4.3 跑 verify.sh
- [ ] S4.4 代码审阅闭环
