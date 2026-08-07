# Tasks: 并行节拍事件流核心（parallel-beats）

> 本 change = Change A（核心）。Change B（队形公式、阶段转换、micro-motion）在 `p5-team-shape-and-transition`。

## P1. 引擎：固定 tick + 全员状态

- [ ] P1.1 引擎主循环改为固定 1s tick：`while t < dur { t += 1; ... }`，每 tick 更新全员状态
- [ ] P1.2 维护 `pos[22]` 实时位置，每 tick 为每球员决策目标（持球带球/队友跑位/门将回位；本轮用现有角色锚点 + 小幅调整）
- [ ] P1.3 **dribble 从高亮移入 main**：v2 全场比赛带球 = beat.main，pass/shot/tackle 仍为高亮
- [ ] P1.4 **每个持球 tick 都发 main**（含零位移控球，球在脚下）——保证球可见、唯一驱动者
- [ ] P1.5 **高亮锚点整数 tick 对齐**：pass/shot/tackle 的 t 量化到 1s 边界
- [ ] P1.6 **飞行中高亮注册表**：维护被高亮控制的球员（到何时、结束位置），每 tick 执行排除 + pos[] 对账
- [ ] P1.7 **高亮事件携带参与者精确起点**（pass: passer+receiver；shot: shooter+keeper；tackle: carrier_from+tackler）
- [ ] P1.8 确定性：同 seed 同 config → 同节拍流 + 高亮事件

## P2. 协议：beat 节拍 + 球所有权

- [ ] P2.1 新增 `beat` 事件类型：`{t, type:'beat', movers:[{id,from_x,from_y,to_x,to_y,speed,action}], main?:{...}, ball?:{x,y,loose}}`
- [ ] P2.2 movers 增量（只含移动球员，位移阈值 ~0.5m）；to = tick 步进终点
- [ ] P2.3 **main = 带球/控球 only**（pass/shot/tackle 只走高亮，避免双播）
- [ ] P2.4 **球所有权三分**：main 带球 / 高亮 / beat.ball 松散球；movers/main/ball 互斥（不同时含 main 和 ball）
- [ ] P2.5 movers action 枚举（run/return/close_down/dribble/keeper_return）
- [ ] P2.6 向后兼容：v1 事件（pass/shot/tackle 等）保留，viewer 兼容两者；demo_mode 保持 v1 事件驱动
- [ ] P2.7 protocol 校验支持 beat + movers/main/ball 互斥 + id 唯一 + 坐标范围

## P3. viewer：beat 演绎 + 两层合成

- [ ] P3.1 interpretEvent 支持 beat：movers 批量插值（多球员并行移动，静止 hold；跨拍连续 from(N+1)==to(N)）
- [ ] P3.2 **两层合成（buildTimeline 纯函数）**：高亮参与者从重叠 beat movers 排除；高亮覆盖 beat；可单测
- [ ] P3.3 **球可见性**：main 带球随轨迹、高亮随高亮轨迹、松散球随 beat.ball、死球 hold
- [ ] P3.4 连续播放适配：beat + 高亮边界无瞬移（跨拍连续 + 高亮起点整数 tick）
- [ ] P3.5 **性能**：~2700 beat 锚点，插值从线性扫描改时间索引/二分（避免 60fps 卡顿）

## P4. 验证与收尾

- [ ] P4.1 引擎测试：节拍确定性、球所有权（唯一驱动）、高亮参与者排除、tick 单调
- [ ] P4.2 viewer 测试：beat 批量插值、两层合成、球可见性、跨拍连续、无 snap
- [ ] P4.3 **现有测试迁移**：16 引擎测试断言 v1 结构（dribble 事件、tackle 频率），beat 重写会破坏，需迁移/更新
- [ ] P4.4 端到端：整场连续播放，多人同时动，关键时刻有戏，无 snap
- [ ] P4.5 版本号更新（index.html/app.js）
- [ ] P4.6 跑 verify.sh
- [ ] P4.7 代码审阅闭环
