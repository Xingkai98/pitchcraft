# Tasks: 连续比赛播放（continuous-match-playback）

> 实施顺序：先 Phase B（引擎语义补全），后 Phase C（连续播放）。每阶段独立验证。

## Phase B：引擎语义补全

### B1. 引擎 tackle 就近防守
- [ ] B1.1 `nearest_opponent` 替换 `random_player`：选离持球者最近的对方球员
- [ ] B1.2 距离阈值：防守者距持球者 > 阈值（~10m 归一化）时不产 tackle，落回其他事件类型
- [ ] B1.3 引擎测试：tackle 防守者总是最近的对方球员、阈值生效

### B2. 引擎 tackle 可失败
- [ ] B2.1 tackle 结果按概率 success ~70% / fail ~30%
- [ ] B2.2 状态更新分两支：success → 球权归防守者、防守者到 loose 点；fail → 球权保留原持球者、持球者留接触点附近
- [ ] B2.3 引擎测试：同 seed 确定、两结果都可达（多 seed 抽查）、状态正确

### B3. 引擎新字段 loose / carrier_from
- [ ] B3.1 产出 `loose_x/loose_y`：逼近方向垂线 × 距离，确定性、场内钳制、零距离退化（与 viewer `deflectPoint` 同规则）
- [ ] B3.2 产出 `carrier_from_x/carrier_from_y` = 被铲者上一位置
- [ ] B3.3 `Event` 结构体 + `to_json` 序列化新字段
- [ ] B3.4 引擎测试：tackle 事件含新字段、坐标范围、确定性

### B4. 协议定稿
- [ ] B4.1 `event-stream-protocol` spec：tackle 的 to/x2/y2 列必填 + 新增可选字段（已写入本 change spec）
- [ ] B4.2 `viewer/protocol.js`：tackle 必填校验（to/x2/y2）+ 可选字段透传
- [ ] B4.3 `viewer/protocol.test.js`：tackle 缺 to/x2/y2 抛错、可选字段透传
- [ ] B4.4 `mock-event-stream.js`：tackle 样例补 carrier_from/loose，已有 fail 样例对齐

### B5. viewer 抢断五段式
- [ ] B5.1 `interpretTackle`：被铲者从 `carrier_from` 带球到接触点，防守者同时逼近，碰撞 → 弹开（优先 `loose_x/y`）→ 捡球（result 驱动）
- [ ] B5.2 `carrier_from` 缺失 → 被铲者原地带球（fallback）；`loose` 缺失 → `deflectPoint` 自算
- [ ] B5.3 `config.interpretation.tackle` 调参适配（带球逼近速度等）
- [ ] B5.4 interpretation 测试：五段式、fallback、result 分支

## Phase C：连续播放

### C1. Game 连续模式
- [ ] C1.1 Game 增加 `mode: 'continuous' | 'clip'`（默认 continuous）：continuous 跨事件推进、事件间 hold、播完自动切下一个
- [ ] C1.2 `step()` 不再 clamp 到当前事件结束；`playTime` 整场推进
- [ ] C1.3 事件间空档复用 `_interpolateAnchors` prevAny 兜底（hold）
- [ ] C1.4 clip 模式保留（调试/单事件点播）

### C2. app 接入连续流
- [ ] C2.1 `app.js` `demo_mode: false`，接引擎连续流
- [ ] C2.2 控件适配：播放/暂停、倍速、整场时间显示、整场重播
- [ ] C2.3 事件指示器/跳转语义适配连续模式

### C3. 端到端连续边界验证
- [ ] C3.1 端到端测试：连续事件流逐事件播放，断言球/球员在事件边界位移 < 阈值（无 snap）
- [ ] C3.2 阈值校准并注释依据
- [ ] C3.3 整场重播：固定种子两次连续播放，关键状态一致

## 收尾

- [ ] 更新 `index.html`/`app.js` 版本号（JS 修改后强制刷新）
- [ ] 跑 `verify.sh`（引擎 + viewer + WASM 端到端）
- [ ] 代码审阅闭环：起 subagent 审阅 → 修复 → 复审直到通过
