# Tasks: 比赛时长可调 + 精彩事件固定产出 + 跳过机制

## P1. 引擎：槽位驱动 + 时长参数

- [ ] P1.1 新增常量 `HIGHLIGHTS_PER_MATCH`（~40）；`roll_highlight` 改槽位驱动：hold_max = 槽位间距（match_duration / N），每槽必产高亮；高亮类型固定比例（shot 30% / tackle 15% / 其余 pass）
- [ ] P1.2 派生概率固定：pass 出界率 ~8-10%（边线 65%）、shot saved 扑出 60% + 越线 90%、goal 率 9%、头球 goal 8%——保证 5 分钟 vs 90 分钟产出相同精彩事件数
- [ ] P1.3 引擎测试：5 分钟（300s）与 90 分钟（5400s）各跑多 seed，断言核心精彩事件数（shot/角球/界外球/头球/抢断）落在同一区间；修正现有频率测试（v2_highlight_gate_frequency 等适配槽位机制）

## P2. viewer：跳过机制 + 时长选项 + 时间显示

- [ ] P2.1 config.playback：`skipMode: 'fast'|'skip'`（默认 fast）、`skipChoices: [5,10]`（快速播放倍速）、`skipThresholdSeconds`（间隙阈值，5s 比赛时间）
- [ ] P2.2 game.js：高亮事件识别（shot / detail=corner|out_sideline|out_goal_line|clearance / tackle / header）；间隙检测（当前 playTime 距下一个高亮 > 阈值 → 跳过模式）；`cycleSkipMode()` 切换；跳过模式下 step 快速推进或直接跳
- [ ] P2.3 app.js：比赛时长选项按钮（5/10/45/90 分钟，重新 simulate）；跳过模式按钮（快速播放/直接跳过）；时间显示跟随 matchEnd（`MM:SS / MM:SS`）
- [ ] P2.4 viewer 测试：时间格式（跟随 matchEnd）、跳过检测（间隙识别）、跳过模式（快速推进/直接跳）、时长选项重建

## P3. 验证收尾

- [ ] P3.1 版本号更新（index.html/app.js）
- [ ] P3.2 跑 verify.sh（e2e 适配 90 分钟 + 跳过）
- [ ] P3.3 代码审阅闭环
