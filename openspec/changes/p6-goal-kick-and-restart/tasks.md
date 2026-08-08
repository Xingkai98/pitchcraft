# Tasks: 死球重开正确化——门球 + 进球回中圈（goal-kick-and-restart）

> P6 首批，聚焦两个死球重开场景。

## G1. 引擎：off_target → 门球

- [ ] G1.1 finalize_highlight 的 ShotOffTarget 分支重写：possession 切对方门将；球位置 = 对方门将（瞬移）
- [ ] G1.2 门将开大脚高亮：球从门线飞到中场落点（无 to，高速长球）
- [ ] G1.3 落点进入松散球（双方可争 `nearest_any`）→ 拾取恢复 main（复用 P4）
- [ ] G1.4 门球不触发 transition
- [ ] G1.5 引擎测试：打偏→门球流程、possession 切换、双方争抢拾取、门球不触发 transition

## G2. 引擎：进球 → 球直接回中圈

- [ ] G2.1 ShotGoal 分支去"从门内滚回中圈"过渡：进球确认后球位置直接 = 中圈
- [ ] G2.2 开球者走回中圈 + kickoff 保留（现有流程）
- [ ] G2.3 引擎测试：进球后球直接回中圈（事件流断言）

## G3. viewer：门球 + 进球区分

- [ ] G3.1 门将开大脚高亮演绎（球从门线飞中场，无接球者动画）
- [ ] G3.2 中场松散球争抢（复用 P4 松散球演绎，双方追逐）
- [ ] G3.3 buildTimeline 去掉进球"从门内滚回中圈"过渡锚点（球直接跳回中圈）
- [ ] G3.4 goal 视觉加强（越门线进网 + 明显停留）；saved/off_target 停门线/边线
- [ ] G3.5 viewer 测试：门球演绎、进球瞬移回中圈、goal vs saved 区分

## G4. 验证与收尾

- [ ] G4.1 版本号更新（index.html/app.js）
- [ ] G4.2 跑 verify.sh
- [ ] G4.3 代码审阅闭环
