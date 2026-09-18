# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this project.

## 这是什么

从零开始写的足球经理 2D 复刻项目（**不依赖现成的 FM 类实现**：现成足球模拟引擎、现成经理游戏代码；通用工具如 Canvas / SDL / Electron / Tauri / WASM 允许）。

## 技术栈（已确认，勿改）

- **事件引擎**：Rust crate（纯逻辑、平台无关、可 WASM 编译）
- **画面层**：JS + Canvas（纯原生，无框架）
- **双端**：网页/移动端浏览器直玩 + Windows 桌面 Tauri 套壳
- **运行时拓扑**：B 内嵌引擎——桌面 Tauri 后端内嵌引擎 crate，网页版引擎编译 WASM
- **两层架构**：引擎产事件流，画面消费事件流，事件流是唯一接缝
- 架构与决策记录见 `.scratch/map.md` 和 `.scratch/design.md`

## 开发流程（后续开发必须遵守）

### 1. OpenSpec 流程

- 所有开发按 OpenSpec 流程：先建 change（proposal + design + specs + tasks），validate 通过后 `/opsx:apply` 实施。
- 用 wayfinder 决策地图（`.scratch/map.md` + `.scratch/issues/`）记录重大决策。
- 设计细节先用 batch-grill-me 敲定（reviews/grill-design.md），用户确认前不写实现代码。

### 2. 分层验证（无视觉依赖）

验证**不得依赖模型视觉能力**（截图读图不作为通过门槛）。按层验证：

| 层 | 验证方式 |
|----|----------|
| Rust 引擎 | `cargo test`（确定性、坐标范围、事件结构） |
| 事件流协议 | JSON 断言（字段齐全、类型合法、初始站位、id 方案） |
| 动画逻辑 | 写成纯函数，单测（传球轨迹、带球踢-追、插值） |
| 坐标映射 | `normalizedToPixels` 纯函数单测 |
| Canvas 渲染 | `renderFrame(t) → getImageData()` 像素断言（位置/移动） |
| 日志核对 | viewer 输出渲染坐标，文本比对 |
| 最终观感 | 用户视觉验收（对应 FM 数据校准的人眼环节） |

关键约束：坐标映射必须纯函数；viewer 必须暴露 `renderFrame` 测试钩子；viewer 必须输出调试日志。

### 3. 代码审阅闭环（强制收尾）

**每次开发完成后**，必须：
1. 起 subagent 审阅代码
2. 发现问题 → 修复
3. 再起 subagent 审阅
4. **直到审阅全部通过，无遗留问题**，才算完成

审阅不通过 = 开发未完成。

### 4. 浏览器缓存强制刷新（JS 修改后必须更新版本号）

**每次修改 `viewer/` 下的 JS 代码（app.js / interpretation.js / renderer.js 等）或 HTML 后，必须更新 `viewer/index.html` 里 `<script>` 标签的版本号**，否则浏览器会缓存旧 JS，用户看不到改动。

当前：`<script type="module" src="./app.js?v=20260805-1"></script>`

规则：
- 改 JS/HTML 后，把 `?v=` 后的版本号改成新值（如 `20260805-2`、`20260805-3`），格式 `YYYYMMDD-N`（日期-当日序号）。
- `engine.wasm` 已有 app.js 里的自动 cache-busting（`fetch ?v=${Date.now()}`），无需手动改。
- 改 JS 但忘改版本号 = 用户刷新看到旧效果，视为遗漏（提交前检查）。

### 5. 真实比赛对照数据（viewer 数据源切换）

viewer 可切到「真实比赛（对照）」：公开 tracking 数据 → 帧序列 → 复用同一 `renderFrame` 播放。
调参时用它做参照，不再只能靠语言描述。**这条通路绕过引擎与演绎层**，是参照物，不是引擎的一部分。

- 生成：`node tools/fetch-tracking-data.mjs`，再 `node tools/convert-tracking-to-frames.mjs`
- 数据与转换产物都在 `.gitignore`（`viewer/data/`、`.scratch/tracking-data/`），不入库
- 原理 / 坐标对齐 / 已知坑：`.scratch/notes/real-match-reference.md`
- 改 `tracking-player.js` 或转换器后，跑 `viewer/tracking-player.test.js` +
  `viewer/tracking-e2e.test.js`（真实数据的像素级验收，缺数据时自动跳过）

### 6. 比赛标尺（P36：真实比赛 vs 引擎的可比指标）

真实比赛与引擎比赛**共用同一份指标实现**（`viewer/match-metrics.js`），输出可直接对比的
队形/空间指标。调参判据（"散不散"）由此从形容词变成数字。

- 跑：`node tools/benchmark-compare.mjs`（报告期：只输出数字与对比，**不产生 pass/fail**——
  2 场样本导出的范围不足以当验收判据；唯一断言在指标单测）
- 基线：`viewer/data/benchmark-baseline.json`（**入库**，是 `viewer/data/*` 的 gitignore 例外；
  其余真实数据仍不入库）。重生成：fetch → convert → 构建 wasm → `node tools/benchmark-baseline.mjs`
- 口径写死在 `viewer/match-metrics.js` 头部注释与 spec：剔除门将 / 瞬时队形逐帧算再均值 /
  `trim1` 纵深 / 米制 / 控球代理（离球最近者，**代理**非真实持球权）/ 采样 0.2s /
  球相关主口径只用原始球帧。**改口径必须重生成基线**（基线记录指标模块 sha256，
  不匹配时对比工具报"陈旧"并拒绝对照）
- 改 `match-metrics.js` 后跑：`viewer/match-metrics.test.js`（口径守护：剔除门将用极端
  位置断言、trim1 两侧都注入）+ `tools/benchmark-compare.test.mjs`
- 标尺是测量工具：**零引擎改动**。指标能否当门由实测分布是否分离决定（design D3），
  弹性是口径敏感量、不作校准目标（design D4）
- 设计与审阅：`openspec/changes/p36-match-benchmark/`（design D1–D6 + 两轮审阅）

### 7. 参考的研究报告

- `research/2026-08-04-football-manager-match-engine/report.md`：FM 引擎原理 + 开源项目方法 + Bygfoot 视觉
- 演绎剧本（带球踢-追、传球传跑配合）：`.scratch/notes/interpretation-scripts.md`
- 事件流协议草案：`.scratch/notes/event-stream-protocol-prototype.md`
