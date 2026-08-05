# Tasks: P0 事件流到球场（event-to-pitch）

## 1. 项目骨架

- [x] 1.1 在项目根目录创建 workspace 结构：`engine/`（Rust crate）+ `viewer/`（JS）
- [x] 1.2 初始化 Rust 引擎 crate（`engine/`，`cargo init --lib`），配置 WASM 目标（wasm-bindgen）
- [x] 1.3 初始化 JS 画面层（`viewer/`，纯原生 Canvas，无框架，`index.html` + `app.js`）

## 2. 事件流协议（v1，草案落地）

- [x] 2.1 在引擎 crate 定义事件类型枚举：kickoff / whistle / pass / dribble / shot / tackle / interception / substitution
- [x] 2.2 定义事件结构体：t / type / subject / from / to / x,y / x2,y2 / result / speed / touch_freq / lead / score / detail / note
- [x] 2.3 **（S1）定义球员 id 方案**：0-10 = home，11-21 = away（协议层，viewer 据 id 分主客队颜色）
- [x] 2.4 **（B1）定义初始站位消息**：扩展 kickoff 事件（或新增 lineup 事件）携带 22 个 {id, team, x, y} 初始站位，viewer 纯从事件流渲染
- [x] 2.5 实现事件序列化（JSON 输出，字段遵循协议草案 v1 + 上述修复）
- [x] 2.6 在 viewer 侧定义对应的事件解析（读 JSON → JS 事件对象）

## 3. Rust 引擎（最小实现）

- [x] 3.1 实现种子 RNG（种子驱动，同种子 → 同事件流）
- [x] 3.2 实现最小比赛流程：产出 kickoff → pass → dribble → shot → whistle 的事件序列（事件靠规则 + 随机，不做球员 AI）
- [x] 3.3 事件带演绎参数：pass 带 speed/lead，dribble 带 speed/touch_freq，shot 带 speed
- [x] 3.4 事件坐标归一化（0-1），引擎不假设文件系统/命令行（纯逻辑、平台无关）
- [x] 3.5 **（S3）定义最小 config 形状**：`{ match_duration_seconds }`（或明确 P0 为占位空对象），并在 spec 写明，保证确定性契约可测
- [x] 3.6 编译引擎为 WASM，暴露 `simulate(seed, config) → 事件流` 接口

## 4. JS 画面层（最小实现）

- [x] 4.1 Canvas 绘制球场：草地 + 白线（边线、中线、中圈、禁区）
- [x] 4.2 渲染 22 个球员圆点 + 球（主客队颜色区分，按 id 方案 0-10 home / 11-21 away）
- [x] 4.3 **（B1）从初始站位消息渲染 22 个球员初始位置**，随后按事件流更新
- [x] 4.4 消费事件流：按 t 推进播放时刻
- [x] 4.5 演绎 pass（传跑配合：接球者先跑位、球飞向落点）、dribble（踢-追周期）、shot（球飞向球门）——第一版直线、简单节奏
- [x] 4.6 演绎节奏参数放配置文件（phase 时长、人球分离量），可调
- [x] 4.7 **（S4）明确参数分工**：per-event 速度/提前量/触球频率来自事件载荷（事件值优先）；config 只放动画时序（phase 时长、人球分离量）

## 5. 分层验证（引擎/协议/动画逻辑可自动化）

- [x] 5.1 **（S2）viewer 加载 WASM**：fetch engine.wasm 并实例化，从 app.js 调用 simulate(seed, config)；注明需本地 HTTP server（file:// 下 fetch .wasm 失败）
- [x] 5.2 **引擎层测试（cargo test）**：确定性（同 seed 同 config → 同事件流）、坐标范围（0-1）、事件结构/字段、config 决定时长
- [x] 5.3 **协议层断言**：读事件流 JSON，断言字段齐全、事件类型合法、初始站位消息存在、id 方案正确
- [x] 5.4 **动画逻辑单测**：事件→动画映射写成纯函数（不碰 DOM），单测传球轨迹/带球踢-追/插值计算
- [x] 5.5 种子复现验证：同 seed 两次模拟，事件流一致（含不同种子结果不同的抽查）

## 6. 画面渲染验证（无视觉依赖：像素断言 + 坐标测试 + 日志核对）

- [x] 6.1 **坐标映射纯函数单测**：`normalizedToPixels(x, y, canvasW, canvasH)` 是纯函数，单测 (0,0)→(0,0)、(1,1)→(画布宽,高)、(0.5,0.5)→中心
- [x] 6.2 **Canvas 像素断言**：viewer 暴露测试钩子 `renderFrame(eventStream, t) → 离屏 canvas getImageData()`；断言开球时两队颜色像素出现在预期位置、pass 事件后球像素从起点移到终点位置
- [x] 6.3 **调试日志核对**：viewer 输出每条已渲染事件的屏幕坐标到 console，对照事件流坐标 × 映射函数逐条核对一致
- [x] 6.4 **browser-act 截图（尽力而为）**：无头浏览器截图作为额外 sanity check；不依赖视觉，不作为通过门槛
- [x] 6.5 **用户视觉验收**：用户在浏览器打开看实际运行，反馈节奏、真实感、动作是否像球赛（对应 FM"数据校准"的人眼环节）
- [x] 6.6 验证协议接缝：跑一次链路，记录协议字段哪些顺、哪些别扭（为 02 定稿收集依据，产出"协议验证笔记"）

## 7. 代码审阅闭环（subagent 审阅，直到全部 OK）

- [x] 7.1 **起 subagent 审阅代码**：开发全部完成后，用 code-review 类 subagent 审阅全部代码（引擎 + viewer + 协议）
- [x] 7.2 **修复审阅问题**：subagent 发现的问题逐个修复
- [x] 7.3 **重复审阅直到 OK**：修复后再起 subagent 审阅，直到审阅通过无问题
- [x] 7.4 审阅通过后，更新 `README.md`（项目根）：P0 状态、如何跑起来（`cargo build` / 启动本地 HTTP server / 打开 viewer）
- [x] 7.5 提交 git：P0 完整提交，含引擎、画面、协议草案落地的变更
