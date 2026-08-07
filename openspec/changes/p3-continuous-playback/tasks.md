# Tasks: 连续比赛播放（continuous-playback）

> 核心（grill Q11b 确认）：事件时间由动作时长自动推算（距离÷速度），事件流 = 动作一个接一个，无固定间隔。

## E. 引擎事件驱动时间推进

- [x] E1.1 引擎时间循环改造：`t += 12-20s 随机` → `t += 当前动作实际时长`（距离÷速度）+ 控球间隔（8-15s）+ 无球跑位填满
- [x] E1.2 有球动作间控球观察间隔（8-15s），无球跑位每 ~1.2s 填满
- [x] E1.3 新增 `off_ball_run`（无球跑位）事件类型：短距离碎步移动（1-2m），带 subject/x/y/x2/y2/speed
- [x] E1.4 无球跑位生成：`fill_with_off_ball` 填满控球间隔（随机非持球者小步移动）
- [x] E1.5 引擎测试：16 全过（含 off_ball_run 相关）

## C0. 前置事项（grill Q5/Q8 确认）

- [x] C0.1 进球后 whistle +2s、kickoff +5s 时间偏移（验证：+2.9~3.6s / +5.9~6.6s 含飞行时长）
- [x] C0.2 静默迭代后 carrier_from 对称刷新（shot 分支 guard 不满足时也 `carrier_from = pos_p`）
- [x] C0.3 非进球 shot 后球权转对方门将（pos 到球落点），消除"球在门线但持球者在场上"的 snap 根因

## C1. Game 连续模式

- [x] C1.1 Game 增加 `mode: 'continuous' | 'clip'`（默认 continuous）：continuous 跨事件推进、播完自动切下一个；clip 现有点播行为（调试保留）
- [x] C1.2 `step()` 连续模式不 clamp 到当前事件结束；`playTime` 整场推进到 matchEnd 自动停
- [x] C1.3 事件间由 off_ball_run 锚点填满；`_interpolateAnchors` 连续模式跨事件插值（事件间隙 hold）
- [x] C1.4 clip 模式保留（调试/单事件点播，测试用 'clip' 构造）
- [x] C1.5 连续模式重复段处理：tackle 前若同一被铲者刚 dribble，丢弃 carry-beat 起点（`buildTimeline` 传 mode，interpretTackle 支持 dropCarryBeat）
- [x] C1.6 `seekTo(t)` 公共方法（进度条拖动）

## C2. app 接入连续流

- [x] C2.1 `app.js` `demo_mode: false` + match_duration_seconds: 2700，接引擎连续流
- [x] C2.2 控件适配：播放/暂停、倍速、整场时间显示、整场重播
- [x] C2.3 **新增整场进度条/时间轴**（可拖动 seek，显示当前比赛时间/总时长）
- [x] C2.4 事件指示器/跳转语义适配连续模式（jumpToEvent 设 playTime 继续连续播）

## C3. viewer 演绎 off_ball_run

- [x] C3.1 `interpretation.js` 新增 `off_ball_run` 演绎（短距离碎步移动，用事件 speed 算时长）
- [x] C3.2 `protocol.js` 支持 off_ball_run 事件类型（EVENT_TYPES 10 类）
- [x] C3.3 mock 补 off_ball_run 样例

## C4. 端到端连续边界验证

- [x] C4.1 端到端测试：连续事件流逐事件播放，球最大单帧位移 0.058（正常传球）、无事件边界瞬移
- [x] C4.2 阈值校准：事件边界位移 < 0.05 判定；剩余 0.058 为传球/跑位动作本身位移，非边界 snap
- [x] C4.3 整场重播：固定种子两次连续播放，球/球员终态一致（确定性）
- [x] C4.4 事件驱动时间一致性：演绎时长 > 引擎间隔+1s 的事件数从 9 → 0（tackle 时长修正后）

## 收尾
- [x] 更新 `index.html`/`app.js` 版本号（`20260806-8`）
- [x] 跑 `verify.sh`（引擎 16 + viewer 71 + WASM 端到端 3113 事件）
- [x] 代码审阅闭环：多轮 subagent 审阅（含引擎误操作重建）→ 全部修复 → 终审通过（球 0.042、球员 0.050、门将 0.010，无 snap，300 seed t 单调）
