# Football Manager Clone — P1

从零开始写的足球经理 2D 复刻（**不依赖现成的 FM 类实现**）。P0 打通"Rust 引擎 → 事件流 → JS 画面"链路；P1 完成抢断四段式演绎；P2 完成引擎 tackle 语义补全。

## 当前进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 `p0-event-to-pitch` | 引擎 → 事件流 → 画面链路 | ✅ 已归档 |
| P1 `p1-tackle-drama` | 抢断四段式演绎（持球→逼近→碰撞→弹开+捡球） | ✅ |
| P2 `p2-continuous-match-playback` | 引擎 tackle 语义补全（就近防守/可失败/带球中被抢） | ✅ 已归档 |
| P3 `p3-continuous-playback` | viewer 连续播放（整场 kickoff→whistle 连续流转） | 📋 已规划待实施 |

P3 做完 = **完整播放的比赛画面**。规划见 `openspec/changes/p3-continuous-playback/`。

## 技术栈

- **事件引擎**：Rust（纯逻辑、平台无关、可 WASM 编译）
- **画面层**：JS + Canvas（纯原生，无框架）
- **双端**：网页/移动端浏览器直玩 + Windows 桌面 Tauri 套壳（P1）
- **架构**：引擎产事件流，画面消费事件流，事件流是唯一接缝

## 目录

```
engine/    Rust 事件引擎（零依赖，确定性种子 RNG）
viewer/    JS 画面层（Canvas 圆点球场 + 事件演绎）
openspec/  OpenSpec 规格（change 记录）
.scratch/  wayfinder 决策地图 + 设计文档（票据已迁移 GitHub issues）
```

## 决策票据

wayfinder 决策票据迁移到 **GitHub issues**（`github.com/Xingkai98/pitchcraft/issues`，标签 `wayfinder`，编号 `[wayfinder #0X]`）。`.scratch/issues/` 保留为本地存档。开发流程（OpenSpec + wayfinder）见 `CLAUDE.md`。

## 怎么跑

前置：Rust 工具链（含 wasm32 target）、Node。

```bash
# 1. 编译 WASM 引擎并拷到 viewer
cd engine
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm

# 2. 启动本地 HTTP server（file:// 下 fetch .wasm 会失败）
#    用 serve.py（带 no-cache 头，避免浏览器缓存 JS/HTML）
cd ../viewer
python3 serve.py 8000

# 3. 浏览器打开
#   http://localhost:8000
#   看到圆点球场：22 球员 + 球，传球/带球/射门动画，播放控制。
```

## 怎么验证

```bash
./verify.sh   # 一键跑全部测试（引擎单测 + viewer 120 + WASM 端到端 + 真实性统计套件）
```

分层验证（无视觉依赖）：
- Rust 引擎：确定性、坐标范围、最小比赛、22 人阵容、config 时长
- 协议：字段/类型/lineup/坐标校验
- 动画逻辑：传跑配合、踢-追周期、射门（纯函数单测）
- 渲染：坐标映射、像素位置（MockCanvas 断言）
- **真实性统计套件**（`engine/tests/realism.rs`）：
  - L1 规格一致性（`#[ignore]`，verify.sh 第 5 步 release 显式跑）：射门 15/35/50、头球 12/38/50（chi-square GOF）、tackle 稀释模型、槽位相对 mix、角球场均带（200 seed 聚合）
  - L2 过程真实性（默认 `cargo test` 就跑）：比分==goal 计数、射门落点球门矩形、beat 间隙 ∈{1,2}s、速度上界、门将贴门线、事件 t 范围（任意 seed）
  - golden master（默认跑）：10 canary seed 统计摘要 + 事件流哈希，防静默漂移（`ACCEPT_GOLDEN=1` 显式重基线）
- 最终观感：浏览器人工验收（真实性最后一层，结构化抽查）

## P0 范围（已确认）

- 纯随机事件流 + 简单约束（传球朝队友/射门对方半场/带球朝球门）
- 事件驱动时间、连续坐标、无能力值、种子 RNG、一次性产出
- 基本播放控制、固定种子刷新重播、无阵型（固定默认站位）
- 演绎参数由引擎给、第一版直线直传、节奏配置化（`viewer/config.js`）

## 参考

- 研究报告：`research/2026-08-04-football-manager-match-engine/`
- 演绎剧本：`.scratch/notes/interpretation-scripts.md`
- 协议草案：`.scratch/notes/event-stream-protocol-prototype.md`
