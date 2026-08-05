# 事件流协议最小原型（票据 02 的讨论资产）

> 状态：**草案 v1**，供票据 `02` 讨论。定稿后成为 `docs/event-stream-protocol.md`。
> 依据：事件粒度"细到能画动作"、归一化坐标、JSON 起步、协议与序列化分离；演绎参数由引擎给（票据 09）。

---

## 1. 总则

- **协议 = 字段定义**（本文件），序列化格式（JSON/紧凑/二进制）是实现细节，可演进。
- **事件 = 一次决策的产物**（对齐 FM 切片决策），不是物理帧。
- **坐标 = 球场归一化**（0-1，x 左门线→右门线，y 下边线→上边线），朝向中立，画面层按需翻转。
- **引擎给演绎参数**（速度/节奏/提前量），画面层负责节奏演绎（票据 09）。

## 2. 事件字段定义

所有事件共用一套字段，类型可选的省略。**约定：位置用球场上实际发生的点，不区分主客朝向。**

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `t` | float | ✅ | 比赛时间（秒，从 0 计，含补时） |
| `type` | string | ✅ | 事件类型，见枚举 |
| `subject` | string | ✅ | 主球员 id（发起者/持球者/被犯规者），格式 `home#7` / `away#4` |
| `from` | string | — | 来源球员 id（传球者/传中者） |
| `to` | string | — | 目标球员 id（接球者/被铲者） |
| `x`, `y` | float | ✅ | 事件发生位置（归一化 0-1） |
| `x2`, `y2` | float | — | 目标位置（传球落点/射门方向/带球终点） |
| `result` | string | — | 结果，见各类型 |
| `speed` | float | — | 球速或带球速度（m/s） |
| `touch_freq` | float | — | 带球触球频率（次/秒） |
| `lead` | float | — | 传球提前量（球传到接球者跑动方向前方多远） |
| `score` | string | — | 比分，进球/whistle 时给出，格式 `"1-0"` |
| `detail` | string | — | 附加说明（角球/界外/红牌/开球等） |
| `note` | string | — | 自由文本（可选，调试用） |

## 3. 事件类型枚举（第一版 8 类）

| 类型 | 必填字段 | result | 视觉（画面演绎） |
|------|----------|--------|------------------|
| `kickoff` | t, x, y, subject | — | 中圈开球 |
| `whistle` | t, score?, detail | — | 半场/全场/进球后 |
| `pass` | t, from, to, x,y, x2,y2, speed, lead | success/fail | 球飞 + 接球者先跑位 |
| `dribble` | t, subject, x,y, x2,y2, speed, touch_freq | success/fail | 踢-追周期 |
| `shot` | t, subject, x,y, x2,y2, speed | goal/saved/off_target/blocked | 球加速 + 门将先动 |
| `tackle` | t, subject, to, x,y | success/fail | 防守者逼近 + 球权切换 |
| `interception` | t, subject, x,y | success | 拦截传球 |
| `substitution` | t, subject, to, detail | — | 换人 |

**注**：`goal` 不是独立类型，是 `shot` 的 `result=goal`；进球后画面补一个 `whistle`（detail=kickoff_again, score 更新）。

## 4. 示例事件流（半场前半段）

一段"像球赛"的事件流。**引擎给参数，画面负责演绎**——这里只列事件，画面层按 09 的剧本演。

```json
// 开场
{ "t": 0.0,   "type": "kickoff", "subject": "home#9", "x": 0.50, "y": 0.50 }

// 回传后场，倒脚
{ "t": 3.5,   "type": "pass", "from": "home#9", "to": "home#8",
  "x": 0.52, "y": 0.50, "x2": 0.48, "y2": 0.48, "speed": 8.0, "lead": 0.1, "result": "success" }
{ "t": 5.8,   "type": "pass", "from": "home#8", "to": "home#6",
  "x": 0.48, "y": 0.48, "x2": 0.40, "y2": 0.44, "speed": 7.5, "lead": 0.1, "result": "success" }

// 中场推进，带球一段
{ "t": 8.2,   "type": "dribble", "subject": "home#6",
  "x": 0.40, "y": 0.44, "x2": 0.46, "y2": 0.40, "speed": 3.2, "touch_freq": 1.2, "result": "success" }

// 直塞（lead 大：传到 9 号跑动前方）
{ "t": 10.5,  "type": "pass", "from": "home#6", "to": "home#9",
  "x": 0.46, "y": 0.40, "x2": 0.62, "y2": 0.34, "speed": 12.0, "lead": 0.4, "result": "success" }

// 9 号接球被拦截
{ "t": 11.8,  "type": "interception", "subject": "away#5", "x": 0.60, "y": 0.35 }

// 客队反击带球
{ "t": 12.5,  "type": "dribble", "subject": "away#5",
  "x": 0.60, "y": 0.35, "x2": 0.55, "y2": 0.38, "speed": 3.5, "touch_freq": 1.3, "result": "success" }

// 抢断
{ "t": 14.0,  "type": "tackle", "subject": "home#4", "to": "away#5",
  "x": 0.56, "y": 0.37, "result": "success" }

// 主队 4 号长传，射门机会
{ "t": 15.0,  "type": "pass", "from": "home#4", "to": "home#10",
  "x": 0.56, "y": 0.37, "x2": 0.70, "y2": 0.42, "speed": 15.0, "lead": 0.2, "result": "success" }

// 射门：被扑
{ "t": 16.5,  "type": "shot", "subject": "home#10",
  "x": 0.72, "y": 0.42, "x2": 0.95, "y2": 0.50, "speed": 20.0, "result": "saved" }

// 门将开球
{ "t": 18.0,  "type": "pass", "from": "away#1", "to": "away#2",
  "x": 0.02, "y": 0.50, "x2": 0.15, "y2": 0.46, "speed": 13.0, "lead": 0.2, "result": "success" }

// 半场哨
{ "t": 2700.0, "type": "whistle", "score": "0-0", "detail": "half_time" }
```

## 5. 待讨论

1. **`subject` vs `from`/`to`**：主球员用 `subject`，传球用 `from`/`to`（`subject`=持球者）。够用吗，还是统一用 `from`/`to`/`subject` 三选？——当前设计是 `subject` 必填（发起者），`from`/`to` 用于传球关系。
2. **`t` 用秒**（浮点）够吗？还是需要精确到比赛时钟（45:00 + 补时）？——引擎内部用秒推进，补时作为引擎输出。
3. **结果枚举值**：`success/fail/goal/saved/off_target/blocked` 是否覆盖？需要加 `out`（出界）/`corner`（角球）吗？
4. **位置精度**：归一化 0-1 用 float 够吗？如果做确定性（票据 06），可能要用定点数——协议字段类型先按 float，实现时再定。
5. **进球后流程**：`shot(result=goal)` → `whistle(kickoff_again, score)`，两跳够不够？要不要 `goal` 独立事件？
