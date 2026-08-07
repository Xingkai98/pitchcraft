# Tasks: 并行节拍事件流（parallel-beats）

> 升级（2026-08-07）：加球相关队形目标、控球阶段+转换、球所有权/合成规则——让"22 人在动"变成"一支球队在踢球"。

## P1. 引擎：固定 tick + 全员状态 + 队形/阶段

- [ ] P1.1 引擎主循环改为固定 1s tick：`while t < dur { t += 1; ... }`，每 tick 更新全员状态
- [ ] P1.2 维护 `pos[22]` 实时位置，每 tick 为每球员决策目标
- [ ] P1.3 **球相关队形目标**：每球员目标 = 角色基准 + 队形偏移（防线随球前压/回撤、全队随球侧平移、控球阶段压上）
- [ ] P1.4 **控球阶段 + 转换**：每队 phase（attack/defend/transition）；球权易主触发 transition（新进攻方前插前压、新防守方回撤收缩）
- [ ] P1.5 关键时刻（pass/dribble/shot/tackle）仍按战术随机产高亮事件，跨 tick 由事件时序驱动球轨迹
- [ ] P1.6 确定性：同 seed 同 config → 同节拍流 + 高亮事件

## P2. 协议：beat 节拍 + 球所有权

- [ ] P2.1 新增 `beat` 事件类型：`{t, type:'beat', movers:[{id,from_x,from_y,to_x,to_y,speed,action}], main?:{...}, ball?:{...}}`
- [ ] P2.2 movers 增量（只含移动球员）
- [ ] P2.3 **main 只管带球/控球**（pass/shot/tackle 只走高亮，避免双播）
- [ ] P2.4 **球所有权**：main 带球时球轨迹由 main 驱动；高亮期间由高亮驱动；松散球 beat 带 ball（loose:true）
- [ ] P2.5 向后兼容：v1 事件（pass/dribble/shot 等）保留，viewer 兼容两者
- [ ] P2.6 protocol 校验支持 beat + movers + ball

## P3. viewer：beat 演绎 + 两层合成

- [ ] P3.1 interpretEvent 支持 beat：movers 批量插值（多球员并行移动，静止 hold）
- [ ] P3.2 **两层合成**：高亮期间参与者以高亮为准，忽略重叠 beat movers；引擎 pos[] 对账到高亮结束位置
- [ ] P3.3 **球可见性**：节拍带球时球随 main 移动；松散球随 ball 坐标；高亮时球随高亮轨迹
- [ ] P3.4 连续播放适配：跨 beat 连续（from(N+1)==to(N)），beat + 高亮边界无瞬移
- [ ] P3.5 **静止球员 micro-motion**：小幅重心调整（不改变逻辑位置），避免圆点完全冻结

## P4. 验证与收尾

- [ ] P4.1 引擎测试：节拍确定性、队形偏移、阶段转换、全员移动、tick 单调
- [ ] P4.2 viewer 测试：beat 批量插值、两层合成、球可见性、micro-motion
- [ ] P4.3 端到端：整场连续播放，全队阵型伸缩/平移，攻防转换有反击，关键时刻有戏，无 snap
- [ ] P4.4 版本号更新（index.html/app.js）
- [ ] P4.5 跑 verify.sh
- [ ] P4.6 代码审阅闭环
