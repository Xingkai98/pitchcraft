# Tasks: viewer 连续播放（continuous-playback）

## C1. Game 连续模式
- [ ] C1.1 Game 增加 `mode: 'continuous' | 'clip'`（默认 continuous）：continuous 跨事件推进、事件间 hold、播完自动切下一个
- [ ] C1.2 `step()` 不再 clamp 到当前事件结束；`playTime` 整场推进
- [ ] C1.3 事件间空档复用 `_interpolateAnchors` prevAny 兜底（hold）
- [ ] C1.4 clip 模式保留（调试/单事件点播）
- [ ] C1.5 连续模式重复段处理：tackle 前若同一被铲者刚 dribble，丢弃 carry-beat 起点、hold 到接触时刻（对齐 design D4）

## C2. app 接入连续流
- [ ] C2.1 `app.js` `demo_mode: false`，接引擎连续流
- [ ] C2.2 控件适配：播放/暂停、倍速、整场时间显示、整场重播
- [ ] C2.3 事件指示器/跳转语义适配连续模式

## C3. 前置事项（Phase B 终审记录）
- [ ] C3.1 进球后 shot/whistle/kickoff 时间偏移（避免连续模式下球瞬移回中圈）
- [ ] C3.2 静默迭代后 carrier_from 过期处理（引擎对称刷新或 viewer 按 D4 丢弃 carry-beat）

## C4. 端到端连续边界验证
- [ ] C4.1 端到端测试：连续事件流逐事件播放，断言球/球员在事件边界位移 < 阈值（无 snap）
- [ ] C4.2 阈值校准并注释依据
- [ ] C4.3 整场重播：固定种子两次连续播放，关键状态一致

## 收尾
- [ ] 更新 `index.html`/`app.js` 版本号（JS 修改后强制刷新）
- [ ] 跑 `verify.sh`（引擎 + viewer + WASM 端到端）
- [ ] 代码审阅闭环：起 subagent 审阅 → 修复 → 复审直到通过
