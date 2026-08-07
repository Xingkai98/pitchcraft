# Tasks: 并行节拍事件流核心（parallel-beats）

> 本 change = Change A（核心）。Change B（队形公式、阶段转换、micro-motion）在 `p5-team-shape-and-transition`。

## P1. 引擎：固定 tick + 全员状态

- [ ] P1.1 引擎主循环改为固定 1s tick：`while t < dur { t += 1; ... }`，每 tick 更新全员状态
- [ ] P1.2 维护 `pos[22]` 实时位置，每 tick 为每球员决策目标（持球带球/队友跑位/门将回位；本轮用现有角色锚点 + 小幅调整）
- [ ] P1.3 **dribble 从高亮移入 main**：v2 全场比赛带球 = beat.main，pass/shot/tackle 仍为高亮
- [ ] P1.4 **每个持球 tick 都发 main**（含零位移控球，球在脚下）——保证球可见、唯一驱动者
- [ ] P1.4b **main 每拍推进 ≤ speed×1s（约 5-7m）** + 零位移控球占比——避免 carrier 横穿球场（校准）
- [ ] P1.5 **高亮触发节拍门控**：持球 hold 以 tick 计（8-15 tick），hold 归零时在整数 tick 掷高亮类型（pass/shot/tackle），非每 tick 掷
- [ ] P1.5b **高亮门控 fallback**：hold 归零必掷一条高亮；tackle 距离/积极性检查失败 → 改掷 pass/shot（无 'dribble' 落点）
- [ ] P1.6 **高亮锚点整数 tick 对齐**：pass/shot/tackle 的 t 量化到 1s 边界；覆盖区间 [t_start, t_end)，t_end = 自然飞行终点（可非整数）；高亮结束后的驱动者按 D12 交接（不限于 pass）
- [ ] P1.7 **飞行中高亮注册表**：维护被高亮控制的球员（到何时、结束位置），每 tick 执行排除 + pos[] 对账；**任意时刻至多一条飞行中高亮**；参与者退出高亮时 last-emitted-pos 置为高亮结束位置（回归 movers 不回弹）
- [ ] P1.8 **高亮事件携带参与者精确起点**（pass: passer+receiver；shot: shooter+keeper；tackle: carrier_from+tackler；**tackle carrier_from = 接触点，carry-beat 归零**）；**参与者起点硬约束**（起点 == 该 tick 开始 pos[]）；**高亮结束位置由事件字段派生**（pass 接球者=pass.x2/y2、shot 门将=shot.x2/y2、tackle 双方=接触点）
- [ ] P1.9 **movers 连续性**：引擎维护 last-emitted-pos，保证球员重新出现时 from = 上次 viewer 所见（跨缺席精确衔接）；**位移阈值 = 静区（dead-zone）等值 0.5m——移动超过阈值才动、才发 movers，低于阈值不动不发（last-emitted-pos 恒等于 pos[]）**
- [ ] P1.10 **carrier 不进 movers**（main-only）：持球者移动只由 main 表达
- [ ] P1.11 确定性：同 seed 同 config → 同节拍流 + 高亮事件
- [ ] P1.12 **松散球生命周期**：高亮结束（t_end 后下个整数 tick 边界）→ beat.ball 驱动（含球滚动轨迹 x/y→x2/y2+speed）→ 追逐者（tackle 弹开 = 抢断方限定 / save-rebound = 不限队可争）→ 拾取半径 ~0.5m → 下一 tick 边界 main 恢复；LOOSE_MAX_TICKS=2，超时球 hold 等待**不瞬移**（非强制瞬移拾取）
- [ ] P1.13 **高亮结束→球权交接（D12）**：pass→接球者 main；shot→goal 死球 kickoff / save-caught 门将 main（窗口后出球）/ save-rebound 松散球 / **off_target 死球 kickoff（对方开球）**；tackle→success 松散球 / fail 被铲者 main

## P2. 协议：beat 节拍 + 球所有权

- [ ] P2.1 新增 `beat` 事件类型：`{t, type:'beat', movers:[{id,from_x,from_y,to_x,to_y,speed,action}], main?:{...}, ball?:{x,y,loose}}`
- [ ] P2.2 movers 增量（只含移动球员，位移阈值 ~0.5m）；to = tick 步进终点
- [ ] P2.3 **main = 带球/控球 only**（pass/shot/tackle 只走高亮，避免双播）
- [ ] P2.4 **球所有权三分**：main 带球 / 高亮 / beat.ball 松散球；互斥扩展——高亮覆盖区间内 beat 既不含 main 也不含 ball；非高亮 beat 不同时含 main 和 ball
- [ ] P2.5 movers action 枚举（run/return/close_down/keeper_return/chase；**无 dribble**——carrier 不进 movers；chase = 松散球追逐者）
- [ ] P2.6 向后兼容：v1 事件（pass/shot/tackle 等）保留，viewer 兼容两者；demo_mode 保持 v1 事件驱动
- [ ] P2.7 protocol 校验支持 beat（**特判 beat 无顶层 subject/x/y**）+ movers/main/ball 互斥（含高亮期间无 main 无 ball）+ id 唯一 + 坐标范围

## P3. viewer：beat 演绎 + 两层合成

- [ ] P3.1 interpretEvent 支持 beat：movers 批量插值（多球员并行移动，静止 hold；跨拍连续 from(N+1)==to(N)）
- [ ] P3.2 **两层合成（buildTimeline 纯函数）**：高亮参与者从重叠 beat movers 排除；高亮覆盖 beat；可单测
- [ ] P3.3 **球可见性**：main 带球随轨迹、高亮随高亮轨迹、松散球随 beat.ball、死球 hold
- [ ] P3.4 连续播放适配：beat + 高亮边界无瞬移（跨拍连续 + 高亮起点整数 tick）
- [ ] P3.5 **性能**：~2700 beat 锚点，插值从线性扫描改时间索引/二分（避免 60fps 卡顿）

## P4. 验证与收尾

- [ ] P4.1 引擎测试：节拍确定性、球所有权（唯一驱动）、高亮参与者排除、tick 单调、高亮门控
- [ ] P4.2 viewer 测试：beat 批量插值、两层合成、球可见性、跨拍连续、无 snap
- [ ] P4.3 **现有测试迁移 + 重标定**：13 个引擎测试断言 v1 结构（dribble 事件、tackle 频率），beat 重写会破坏，需迁移；tackle 频率测试（8-15/场）按高亮门控重标定
- [ ] P4.4 **更新 verify.sh 断言**：v2 非 demo 流不再含顶层 dribble 事件（变 beat.main），verify.sh 需断言 beat 事件 + main 带球
- [ ] P4.5 端到端：整场连续播放，多人同时动，关键时刻有戏，无 snap
- [ ] P4.6 版本号更新（index.html/app.js）
- [ ] P4.7 跑 verify.sh
- [ ] P4.8 代码审阅闭环
