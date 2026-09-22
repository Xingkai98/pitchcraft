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

### 2. 分层验证（自动化断言 + 视觉验证）

按层验证。**自动化断言是门槛**（进 CI、可复现），**视觉验证是探索与验收手段**
（模型能读图后，看图与断言同等合法）：

| 层 | 验证方式 | 性质 |
|----|----------|------|
| Rust 引擎 | `cargo test`（确定性、坐标范围、事件结构） | 门槛 |
| 事件流协议 | JSON 断言（字段齐全、类型合法、初始站位、id 方案） | 门槛 |
| 动画逻辑 | 写成纯函数，单测（传球轨迹、带球踢-追、插值） | 门槛 |
| 坐标映射 | `normalizedToPixels` 纯函数单测 | 门槛 |
| Canvas 渲染 | `renderFrame(t) → getImageData()` 像素断言（位置/移动） | 门槛 |
| 日志核对 | viewer 输出渲染坐标，文本比对 | 门槛 |
| **轨迹/画面形态** | **渲染 PNG 由模型读图**（单帧、轨迹图、并排对比） | **探索 + 验收** |
| 最终观感 | 用户视觉验收（对应 FM 数据校准的人眼环节） | 验收 |

**为什么用图**（2026-09-19 起）：此前的约束是"不得依赖模型视觉能力"，
当时模型不具备读图能力。现在具备，且 P38 探索证明**图能看到数字看不到的东西**——
例：引擎球员 120s 轨迹是**水平细线**（在铁轨上滑动），而一个"四项指标全绿"的
队形方案在轨迹图上与基线**无区别**。纯数字判据会把这种方案判为成功。

**准则**：
- 图用于**发现问题和最终验收**；能被算出来的量（如横向位移 sd）**仍要写成数值断言进 CI**
  ——图能发现，数值能守护。
- 渲染不依赖浏览器：用 `viewer/soft-canvas.js` + `renderFrame` 光栅到 PNG
  （参考 `openspec/changes/p38-formation-realism/notes/probes-main/render-trajectories.mjs`）。

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

- 生成：`node tools/fetch-tracking-data.mjs`（Metrica），再 `node tools/convert-tracking-to-frames.mjs`
- **SkillCorner（P37，20 场 / MIT）**：`node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata`
  （tracking 是 Git LFS 指针，实体走 `media.githubusercontent.com/media/.../**master**/...`——
  分支是 master 不是 main；并发 6 路可续），再 `node tools/convert-skillcorner-to-frames.mjs --match <id>_match.json --out ...`
- 数据与转换产物都在 `.gitignore`（`viewer/data/`、`.scratch/tracking-data/`），不入库
- 原理 / 坐标对齐 / 已知坑：`.scratch/notes/real-match-reference.md`
- 改 `tracking-player.js` 或转换器后，跑 `viewer/tracking-player.test.js` +
  `viewer/tracking-e2e.test.js`（真实数据的像素级验收，缺数据时自动跳过）

### 6. 比赛标尺（P36 立尺 → P37 扩样本：真实比赛 vs 引擎的可比指标）

真实比赛与引擎比赛**共用同一份指标实现**（`viewer/match-metrics.js`），输出可直接对比的
队形/空间指标。调参判据（"散不散"）由此从形容词变成数字。

- 跑：`node tools/benchmark-compare.mjs`（报告期：只输出数字与对比，**不产生 pass/fail**；
  唯一断言在指标单测）。**两套数据集分别报告**（Metrica 2 场 / SkillCorner 20 场），
  附跨数据集可比性检查
- 交叉验证：`node tools/benchmark-crossvalidation.mjs`（half-split + LOO）。⚠️ **是报告项、
  不是门**——min/max 包含门的通过率与样本量无关（N=20 约 0.25），正常数据下也常"红"；
  升格为门须先刻画门的零分布（design D7）。verify.sh 里只打印、不阻塞
- 基线：`viewer/data/benchmark-baseline.json`（**入库**，是 `viewer/data/*` 的 gitignore 例外；
  其余真实数据仍不入库）。重生成：fetch → convert（含 20 场 SkillCorner）→ 构建 wasm →
  `node tools/benchmark-baseline.mjs`
- ⚠️ **引擎侧数字必须来自 main 源码构建的 wasm**（P38 #87 的教训）：P37 的基线曾用
  **未合入分支**（`demo/off-ball-movement`）的 wasm 生成——重心间距偏 −55.8%、宽度偏 −25.9%，
  且这些数字进了 README，而**当时没有任何哨兵能发现**。现在基线记录
  `engineFingerprint`（`viewer/engine.wasm` 与 `engine/src/lib.rs` 的双哈希），
  `tools/benchmark-baseline.test.mjs` 会在源码变更而基线未重生成时**变红**。
  改引擎做实验请记得 `git checkout engine/src/lib.rs` 还原后重跑测试（那红是预期的）
- ⚠️ **`engine.wasm` 的文件哈希会随「注释行数」变化**（#104 实测，`design.md` §D0）：
  不是调试段（wasm 里没有 `.debug_*`），而是 ① `data` 段里 `panic!` 的 `Location{line,col}`
  静态常量 + ② `name` 段里 Rust 内部符号的 LLVM 内容哈希——注释平移一行，两处都变，
  **行为一点没变**。`-C strip=symbols` / `-C panic=abort` 都消不掉。
  → **读数请引「流哈希」或基线 `engineFingerprint`，不要引构建哈希**；
  **源码注释里也不许引自己的构建哈希**（那是不动点问题：写了哈希就改行号，哈希又变）。
  行为等价的判据是**事件流哈希**（同 seed 同流），不是 wasm 文件哈希。
- ⚠️ **改引擎注释后必须重跑默认 `cargo test`**（#104 实测，`design.md` §D0b）：
  `engine/src/lib.rs` 有几条测试**扫描自己的源文件文本**（`include_str!("lib.rs")` +
  `src.split("#[cfg(test)]").next()`）来守「删干净、无残留」。**注释里出现这些被扫的字面量
  会被算进扫描**——例：在注释里写 `#[cfg(test)]` 会让 `split` 提前截断，三条 `p31_*` 测试同时红。
  ⚠️ **`engineFingerprint` 哨兵抓不到它**（它只判行为是否变，而注释不改行为 → 走"放行"分支）。
  **抓住它的是默认套件**——别把"改注释无害"当默认前提。
- 口径写死在 `viewer/match-metrics.js` 头部注释与 spec：剔除门将 / 瞬时队形逐帧算再均值 /
  **`q10–q90` 纵深**（P37 用户拍板 β：trim1 是顺序统计量、值依赖人数 n，跳过外推点后两侧
  人数不同 → 不是同一估计量）/ **逐场球场尺寸**（104/105/106 不折算）/ 控球代理（离球最近者，
  **代理**非真实持球权）/ 采样 0.2s / 球相关主口径只用原始球帧 / **外推点默认跳过**
  （全点口径并列作对照）。**改口径必须重生成基线**（基线记录指标模块 sha256，
  不匹配时对比工具报"陈旧"并拒绝对照）
- 改 `match-metrics.js` 后跑：`viewer/match-metrics.test.js`（口径守护：剔除门将用极端位置断言、
  q10–q90 插值规则精确值、外推默认跳过 + **反证条**）+ `tools/benchmark-compare.test.mjs` +
  `tools/benchmark-baseline.test.mjs` + `tools/benchmark-crossvalidation.test.mjs`
- 标尺是测量工具：**零引擎改动**。指标能否当门由实测分布是否分离决定（design D3），
  弹性是口径敏感量、不作校准目标（design D4）
- 设计与审阅（已归档，2026-09-18）：`openspec/changes/archive/2026-09-18-p36-match-benchmark/`
  （P36 立尺 D1–D6 + 两轮审阅）、`openspec/changes/archive/2026-09-18-p37-skillcorner-corpus/`
  （P37 扩样本 D1–D8 + 独立审阅 P1×5）；对照通路的来由见
  `openspec/changes/archive/2026-09-18-p35-real-match-reference/`。
  ⚠️ 主 spec 已含这三个 change 的 requirements（`openspec/specs/pitch-viewer/spec.md`）。

### 7. 参考的研究报告

- `research/2026-08-04-football-manager-match-engine/report.md`：FM 引擎原理 + 开源项目方法 + Bygfoot 视觉
- 演绎剧本（带球踢-追、传球传跑配合）：`.scratch/notes/interpretation-scripts.md`
- 事件流协议草案：`.scratch/notes/event-stream-protocol-prototype.md`
