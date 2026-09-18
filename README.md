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
viewer/    JS 画面层（Canvas 圆点球场 + 事件演绎 + 真实比赛对照播放）
tools/     辅助脚本（真实比赛 tracking 的拉取与转换等）
openspec/  OpenSpec 规格（change 记录）
.scratch/  wayfinder 决策地图 + 设计文档（票据已迁移 GitHub issues）
```

## 真实比赛对照

viewer 可把**公开的真实比赛 tracking 数据**转成同一套 2D 圆点格式并排播放——调参时不再只能
靠语言描述"感觉不对"。tracking 数据本身就是逐帧 22 人 + 球的位置，因此直接喂给同一个
`renderFrame`，**绕过引擎与演绎层**（保留未加工的真实行为作参照）。

```bash
node tools/fetch-tracking-data.mjs              # 拉公开数据集（约 60MB，不入库）
node tools/convert-tracking-to-frames.mjs \
  --in .scratch/tracking-data/sample-data/data/Sample_Game_1 \
  --out viewer/data/real-game-1.json --keyframe-hz 5
cd viewer && python3 serve.py 8000              # 数据源选「真实比赛（对照）」
```

原理、坐标对齐（半场换边/朝向/门将识别）、数据质量处理见 `.scratch/notes/real-match-reference.md`。

## 比赛标尺（P36）

把「看着感觉不对」变成「能量的数字」：真实比赛与引擎比赛**共用同一份指标实现**
（`viewer/match-metrics.js`），输出可直接对比的队形/空间指标。

```bash
node tools/benchmark-compare.mjs    # 跑引擎 5 种子 × 5400s → 与真实观测基线对比
```

**默认形态 = 报告期**（用户 2026-09-18 拍板）：只输出数字、偏离方向与幅度，**不产生
pass/fail**。真实样本（2 场 / 13 个满窗）导出的范围不足以当验收判据（用它验收会把一半
真实比赛判为"不像真实足球"），在样本扩大、校准目标确定之前，标尺的职责是**量出差距**。
唯一有断言的是指标单测（保证"量出来的数是对的"，不保证"引擎像真实"）。

实测差距（最终口径 `trim1` × 引擎 5400s 采样，2026-09-18）：

| 指标 | 真实（13 窗） | 引擎（30 窗） | 结论 |
|------|--------------|--------------|------|
| 主队纵深（trim1） | 25.2m [16.2–29.6] | 39.6m [32.1–47.6] | 不重叠，均值 +57% |
| 紧凑度（到重心） | 15.2m [10.8–17.4] | 20.0m [17.9–23.2] | 不重叠，+31% |
| 两队重心间距 | 8.3m [6.8–10.5] | 15.1m [11.7–18.0] | 不重叠，+82% |
| 客队纵深 | 26.2m [20.2–29.6] | 38.9m [29.2–46.1] | 边缘接触（0.4m），仅报告 |
| 宽度 / 重心到球 | — | — | 区间重叠，仅报告 |
| 弹性（纵深随球） | Δ 随分桶口径 3.2→−2.3 | 13.2→2.6 | 口径产物，不作目标 |

两条教训（写在 `openspec/changes/p36-match-benchmark/design.md` D3/D4）：
① 弹性"引擎是真实的 2.6 倍"是分桶口径产物——换一个同样合理的口径信号就消失，
不能作为校准目标；② 纵深估计量必须在**两侧都做注入实验**（只测一侧会得到错误结论：
floor 索引的分位在防守侧与 max-min 一样脆弱）。

**口径**（每条都有守护测试，`viewer/match-metrics.test.js`）：剔除门将（id 0/21）、
单帧瞬时队形（逐帧算再均值）、`trim1`（掐头去尾各 1 人取 8 人 x 跨度）、米制
（x×105 / y×68）、控球代理 = 离球最近者所属队（**代理**，非真实持球权）、采样 0.2s、
球相关指标主口径只用原始球帧（真实侧约 40% 帧球位是补全推断）。

**基线**（`viewer/data/benchmark-baseline.json`，摘要入库、原始数据不入库）：记录真实
2 场 / 13 满窗的观测范围（含每窗时长、game2 末窗 246s 残窗）、引擎 5 种子×6 窗冻结值、
样本量与未覆盖维度声明（联赛/球队风格/比分状态未知）、指标模块 sha256（陈旧性校验）。
重生成链路：

```bash
node tools/fetch-tracking-data.mjs
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json
(cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
node tools/benchmark-baseline.mjs   # → viewer/data/benchmark-baseline.json
```

指标实现变更后必须重跑（基线记录 sha256，不匹配时对比工具拒绝拿旧基线对照新实现）。

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
./verify.sh   # 一键跑全部测试（引擎单测 + viewer + tools + WASM 端到端 + 标尺报告 + 真实性统计套件）
```

分层验证（无视觉依赖）：
- Rust 引擎：确定性、坐标范围、最小比赛、22 人阵容、config 时长
- 协议：字段/类型/lineup/坐标校验
- 动画逻辑：传跑配合、踢-追周期、射门（纯函数单测）
- 渲染：坐标映射、像素位置（MockCanvas 断言）
- **比赛标尺**（`viewer/match-metrics.test.js` + `tools/benchmark-compare.test.mjs`）：
  指标口径守护（剔除门将/trim1 两侧对称/瞬时队形/取帧策略）、对比逻辑、基线缺失时跳过
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
