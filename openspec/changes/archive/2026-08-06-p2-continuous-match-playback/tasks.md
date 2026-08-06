# Tasks: 连续比赛播放（continuous-match-playback）

> 实施顺序：先 Phase B（引擎语义补全），后 Phase C（连续播放）。每阶段独立验证。

## Phase B：引擎语义补全

### B1. 引擎 tackle 触发决策模型（距离感知 + 积极性）
- [x] B1.1 `nearest_defender` 用 `pos[]` 实时位置（非静态站位），选离持球者最近的对方球员
- [x] B1.2 常量 `TACKLE_DISTANCE_THRESHOLD_METERS`（10m）：最近防守者超阈值 → 不产 tackle，重掷落回 pass/dribble/shot
- [x] B1.3 常量 `TACKLE_EAGERNESS`（0.09，标定每场 8-15 次）+ `should_tackle()` 决策函数：阈值内以该概率决定是否真抢
- [x] B1.6 门将排除（nearest_defender 跳过 GK id 0/21）+ 同对冷却（last_tackle_pair 避免乒乓）
- [x] B1.4 三常量组织成清晰签名，注释标明将来接战术（票据 04）/属性（票据 05）
- [x] B1.5 引擎测试：多 seed 频率抽样、坐标范围、确定性

### B2. 引擎 tackle 可失败
- [x] B2.1 常量 `TACKLE_SUCCESS_RATE` = 0.5（success/fail 各半）
- [x] B2.2 状态更新分两支：success → 球权归防守者、防守者到 loose 点；fail → 球权保留原持球者、持球者留接触点附近、防守者归位
- [x] B2.3 引擎测试：同 seed 确定、两结果都可达（多 seed 抽查）、状态正确

### B3. 引擎新字段 loose / carrier_from
- [x] B3.1 产出 `loose_x/loose_y`（success 与 fail 都发）：逼近方向垂线 × 距离，确定性、场内钳制、零距离退化（与 viewer `deflectPoint` 同规则）
- [x] B3.2 产出 `carrier_from_x/carrier_from_y` = 被铲者上一位置（dribble 起点验证通过）
- [x] B3.3 `Event` 结构体 + `to_json` 序列化新字段
- [x] B3.4 引擎测试：tackle 事件含新字段、坐标范围、确定性

### B4. 协议定稿
- [x] B4.1 `event-stream-protocol` spec：tackle 的 to/x2/y2 列必填 + 新增可选字段（已写入本 change spec）
- [x] B4.2 `viewer/protocol.js`：tackle 必填校验（to/x2/y2）+ 可选字段透传
- [x] B4.3 `viewer/protocol.test.js`：tackle 缺 to/x2/y2 抛错、可选字段透传
- [x] B4.4 `mock-event-stream.js`：tackle 样例补 carrier_from/loose，已有 fail 样例对齐

### B5. viewer 抢断五段式
- [x] B5.1 `interpretTackle`：被铲者从 `carrier_from` 带球到接触点，防守者同时逼近，碰撞 → 弹开（优先 `loose_x/y`）→ 捡球（result 驱动）
- [x] B5.2 `carrier_from` 缺失 → 被铲者原地带球（fallback）；`loose` 缺失 → `deflectPoint` 自算
- [x] B5.3 `config.interpretation.tackle` 调参适配（带球用 dribbleSpeed）
- [x] B5.4 interpretation 测试：五段式、fallback、result 分支

## 收尾

- [x] 更新 `index.html`/`app.js` 版本号（JS 修改后强制刷新；已到 `20260806-2`）
- [x] 跑 `verify.sh`（引擎 + viewer + WASM 端到端）
- [x] 代码审阅闭环：三轮 subagent 审阅（17+6+4 条发现）→ 全部修复 → 终审通过（无 critical/major）

> 注：Phase C（viewer 连续播放）已拆分为独立 change `p3-continuous-playback`，本 change 归档仅含 Phase B。
