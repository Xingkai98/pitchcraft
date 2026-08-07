# Tasks: 并行节拍事件流（parallel-beats）

## P1. 引擎：固定 tick + 全员状态

- [ ] P1.1 引擎主循环改为固定 1s tick：`while t < dur { t += 1; ... }`，每 tick 更新全员状态
- [ ] P1.2 维护 `pos[22]` 实时位置，每 tick 为每球员决策目标（持球带球/队友跑位/门将回位）
- [ ] P1.3 角色基准点：定义每球员 home 位置（GK/DF/MF/FW），无球跑位向基准点调整/回位
- [ ] P1.4 关键时刻（pass/dribble/shot/tackle）仍按战术随机产高亮事件，跨 tick 由事件时序驱动球轨迹
- [ ] P1.5 确定性：同 seed 同 config → 同节拍流 + 高亮事件

## P2. 协议：beat 节拍

- [ ] P2.1 新增 `beat` 事件类型：`{t, type:'beat', movers:[{id,from_x,from_y,to_x,to_y,speed,action}], main?:{...}}`
- [ ] P2.2 movers 增量（只含移动球员）；main 在持球者焦点时出现
- [ ] P2.3 球位置由高亮事件驱动（pass/shot 的 x/y→x2/y2+speed），beat 不含球
- [ ] P2.4 向后兼容：v1 事件（pass/dribble/shot 等）保留，viewer 兼容两者
- [ ] P2.5 protocol 校验支持 beat + movers

## P3. viewer：beat 演绎

- [ ] P3.1 interpretEvent 支持 beat：movers 批量插值（多球员并行移动，静止 hold）
- [ ] P3.2 main 焦点叠加：main 描述的带球/传球/射门按事件时序演绎，与 movers 并行
- [ ] P3.3 高亮事件叠加播放：pass/shot/tackle 在节拍背景上播，球轨迹由高亮事件驱动
- [ ] P3.4 连续播放适配：beat + 高亮事件边界无瞬移

## P4. 验证与收尾

- [ ] P4.1 引擎测试：节拍确定性、全员移动、tick 单调
- [ ] P4.2 viewer 测试：beat 批量插值、main 叠加、高亮叠加
- [ ] P4.3 端到端：整场连续播放，全员同时动，关键时刻有戏，无 snap
- [ ] P4.4 版本号更新（index.html/app.js）
- [ ] P4.5 跑 verify.sh
- [ ] P4.6 代码审阅闭环
