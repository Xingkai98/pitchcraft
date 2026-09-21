> ⚠️ **本地快照（已过期）**：本文件是票据**迁移到 GitHub issues 之前**的副本。
> 现行地图在 **GitHub issue #86**（`gh issue view 86`）。
> 本地保留仅作历史存档；**不要以本文件为决策依据**。

# Wayfinder Map: Football Manager 2D 复刻（从零写）

## Destination

从零开始写一个足球经理比赛模拟器（**不依赖框架**），两层架构：**比赛事件引擎** + **2D 画面层**。
事件引擎确定性地产出一场比赛的事件流（传球、射门、跑位、进球……）；画面层把事件流渲染成**早期 FM 风格的圆点球场动画**（俯视球场、球员为圆点、球小圆）。目标是"看起来像一场足球比赛"，而不是掷骰子的文字比分。

## Notes

- 领域：足球比赛模拟 / 确定性模拟 / 游戏开发
- **硬约束：从零写、不用框架**。标准库 + 轻量依赖（SDL / Canvas API 等）的边界待定，见票据 `01`。
- 参考**方法**（不是代码）：研究报告 `research/2026-08-04-football-manager-match-engine/` 中的 4 个开源项目（OpenFootManager、agentic-fc、back-of-the-neural-net、Open Football）+ Bygfoot 的视觉风格。
- 相关技能：wayfinder（本地图）、grilling、prototype、domain-modeling、research。
- 代码与设计都在 `projects/football-manager-clone/` 内。

## Decisions so far

- [引擎核心语言](issues/01-engine-core-language.md) — **Rust**。纯逻辑、平台无关，长期深耕：桌面走 Tauri 原生、网页走 WASM，一套核心两头跑。
- [画面层双端渲染](issues/07-renderer-dual-platform.md) — **JS + Canvas**。移动端浏览器直玩；Windows 桌面用 Tauri 套壳（Tauri 后端即 Rust，与引擎同栈）；画面纯几何绘制、消费事件流。
- [运行时拓扑](issues/08-runtime-topology.md) — **B 内嵌引擎（一步到位）**。桌面 Tauri 后端内嵌 Rust 引擎 crate；网页版引擎编译 WASM。不搞离线预生成过渡，P0 直接上 WASM。引擎必须是独立 Rust crate，可被两端调用。
- [事件演绎层](issues/09-event-interpretation-layer.md) — **引擎给参数、画面演绎**；第一版简单（直线直传）；演绎节奏配置化。分帧剧本（带球踢-追、传球传跑配合）在 `.scratch/notes/interpretation-scripts.md`。

## Not yet specified

- 画面层的具体渲染技术（依赖 `01` 语言决策后才能定）。
- 事件 → 动画的插值细节（球轨迹、跑位过渡的缓动）。
- 校准方案：用哪些真实足球统计分布做对标（射门数、进球分布、控球率）。
- 战术系统建模：阵型与指令如何影响球员行为（这是引擎的核心难度，先有引擎再谈）。
- 存档 / 联赛 / 转会等外围系统（可能 out of scope，视用户目标）。

## Out of scope

- 3D 画面。
- 网络对战 / 多人。
- 复刻 FM 的精确公式（闭源，不可能，也不必要）。
- 完整 FM 的数据库、转会、训练、媒体系统（除非用户明确要求）。

## Tickets（决策票据）

> **2026-08-06 起，票据迁移到 GitHub issues 管理**：`github.com/Xingkai98/pitchcraft/issues`，编号保留（title 带 `[wayfinder #0X]`）。`.scratch/issues/` 保留为本地存档；新决策/票据在 GitHub issues 开。下方状态为迁移时快照。

- `01` **引擎核心语言**（Rust）✅ 已解决（GH issue closed）
- `02` **事件流协议** ✅ 已解决（P0 定稿；P2 Phase B 补 tackle 字段定稿）
- `03` 时间推进模型 ⏳ open（P2 Phase C 落地"事件驱动连续推进"的画面消费端）
- `04` 球场模型 ⏳ open（引擎 AI 阶段）
- `05` 能力值模型 ⏳ open（引擎 AI 阶段，research 待跑）
- `06` 确定性与回放 ⏳ open（P2 Phase C 连续流+固定种子=回放数据；带标签 RNG/定点数仍开放）
- `07` **画面层双端渲染**（JS + Canvas）✅ 已解决（GH issue closed）
- `08` **运行时拓扑**（B 内嵌引擎）✅ 已解决（GH issue closed）
- `09` **事件演绎层**（人球解耦与动画节奏）✅ 已解决（GH issue closed）
- `10` **定位球 + 犯规规则层** ⏳ open（P6 立项 2026-08-08；任意球/角球/点球；含 foul/出界触发规则层前置；已补首批场景：off_target→门球开大脚+中场争抢、进球→球直接回中圈）
- `11` **战术决策系统** ⏳ open（P7 立项 2026-08-08；传球选人升级/跑位模式/整体逼抢；票据 04 落地）

> 当前实施路线：P4（并行节拍核心）✅ 已完成；**P5（队形公式 + 攻防转换 + micro-motion）实施中**（`openspec/changes/p5-team-shape-and-transition/`）；P6（定位球 + 犯规规则层）已立项待规划；P7（战术决策系统）已立项，建议 P5→P6→P7 顺序。

## 已确认的方向（Design 讨论，2026-08-04）

- **两层架构**（事件引擎 + 画面层，事件流接缝）——已确认。
- **双端需求**：网页版（移动端）+ Windows 程序都要能玩——硬需求。
- **"不用框架"的正确含义**（用户澄清）：不用**现成的、跟 FM 实现有关的**框架/引擎/库/代码（足球模拟引擎、现成经理游戏代码）；**通用工具**（Canvas / SDL / Electron / Tauri 等）允许，不算违反约束。
- 因此语言选型不再受"无框架"限制——JS 桌面端用 Electron/Tauri 套壳、C++/Rust 双端靠 WASM，都是允许的通用方案，真正的"从零写"体现在**比赛引擎核心逻辑全部自研**（事件生成、球员 AI、规则、能力值公式、确定性 RNG）。
- **务实路线**：先 JS 打通 P0"引擎→事件流→画面"链路（JS 最快验证接缝），同时把引擎写成**纯逻辑、平台无关**，将来可平移。
