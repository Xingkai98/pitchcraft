# Progress: p104-volume-recalibration

> 主 session 会核验 worktree 文件，不只依赖口述。每个阶段在此留痕。

## 状态：**已实现 + 全套门绿，进入审阅闭环（P6）**

- 分支 `p104-volume-recalibration/2026-09-21`，基于 main `6f5827f`
- commit：`d71f7b0`（实现）、`01db87a`（主 spec 对齐）
- 干净 main wasm sha8 = `901da77b`；**交付 wasm sha8 = `b12fa58c`**

## 阶段记录

| 阶段 | 状态 | 产物 |
|---|---|---|
| 读三份前提文档 + patches/README | ✅ | — |
| 重建 wasm 核对 sha | ✅ | `901da77b` |
| 探针 + 口径对齐自检 | ✅ | `notes/probes/l1-metrics.mjs`，五项与 Rust 逐位相同 |
| 穷尽最简竞争解（#102 教训） | ✅ | `design.md` §D2（方案 ①②③④） |
| 抢断杠杆粗扫 + 细扫 | ✅ | `notes/probes/out/FINDINGS-exploration.md` |
| 通道杠杆（deadline）试过并排除 → **第 2 轮重新纳入** | ✅ | `design.md` §D3.3 |
| 留出窗口（3 窗 + 位移/带宽比） | ✅ | `design.md` §D7（比值 ≈ 0.01–0.03） |
| 角球长尾刻画与**归因修正** | ✅ | `design.md` §D6 |
| 真实侧锚点（StatsBomb 大五 n=170） | ✅ | `notes/probes/out/FINDINGS-exploration.md` §7 |
| proposal / design / tasks / spec delta | ✅ | `openspec validate --strict` 通过 |
| **独立零记忆 grilling** | ✅ | `reviews/grill-design.md`（3B/6M/4m）+ `reviews/grill-verification-round2.md` |
| grill 逐条回应 | ✅ | `design.md` §D9 |
| **用户第 1 轮 + 第 2 轮拍板** | ✅ | `design.md` `## User Confirmation` |
| **两方案全套门对照** | ✅ | `notes/scheme-comparison.md`；选方案 ③ |
| P2 引擎常量（3 条 + MODEL_VERSION 7） | ✅ | `d71f7b0` |
| P3a 三条体量带 + 新增抢断带 | ✅ | `d71f7b0` |
| P3b 三条被打破的既有测试（改语义/重构造/重扫） | ✅ | `d71f7b0` |
| P4 golden v7（10 seed，人工审查 diff） | ✅ | `engine/tests/golden-v7/` |
| P4b 标尺基线重生成 | ✅ | `viewer/data/benchmark-baseline.json` |
| P5.1 主 spec 同步（与 delta 逐字一致） | ✅ | `01db87a` |
| P5.2 `openspec validate --all --strict` | ✅ | 10 passed / 0 failed |
| P5.3 `cargo test` 全绿（硬要求） | ✅ | **129p/0f**（lib）+ **4p/0f**（realism 非 ignored） |
| P5.4 `./verify.sh` 9 步全绿 | ✅ | 「=== 全部验证通过 ===」exit 0 |
| P5.5 看图 | ✅ | `notes/visual-check.md`（三方并排 + 全场窗 + 量化直线度） |
| P5.6 判据组逐条对照 | ✅ | `notes/criteria-comparison.md`（swarm **确实恶化**，如实记录） |
| **P6 审阅闭环** | 🔄 **进行中** | `reviews/review-round1.md` |

## 关键实测数字（可复现）

| 量 | 干净 main | 交付 | 真实锚 |
|---|---|---|---|
| 普通射门/场 | 7.755 | **17.095** | 21.64（StatsBomb 大五 n=170） |
| 抢断/场 | 9.41 | **30.38** | 36.90（同上 `Duel/Tackle`，含两态） |
| 犯规/场 | 23.53 | **20.55** | ~20–21 |
| shot/tackle | 0.824 | **0.563**（带 `[0.5,1.5]` ✅ 不动） | ~0.52 |
| 主队进球/场 | 0.602 | **1.188**（带 `[0.85,1.60]`） | 1.53 |
| 传球/场 | 418.1 | 395.9 | ~900 |
| 门球/场 | 11.05 | 16.42 | — |
| 角球单场 max（3000 场） | 12 | **13**（带 `≤15`） | — |

## 与任务书的三处实质偏差（如实报出，grill + 主 session 均已复核）

1. **shot/tackle `[0.5,1.5]` 不需重标**——本票把抢断**一起抬了**（0.563 在原带内）。
   任务书的红值 1.785 来自「只抬射门」的配置。
2. **`l3_shot_ratios` 三条比率带不需重标**——实测三条全过。
3. **任务书未列的第四条连带项**：比赛标尺基线 `engineFingerprint` 哨兵
   （实测六项指标全漂移 ≫ 容差）→ 已重生成（用户 Q6 确认）。

## grill 的 B1：任务书与设计初版都**完全没预见**的 3 条既有红门（已修）

| 测试 | 位置 | 性质 | 处理 |
|---|---|---|---|
| `v2_tackle_frequency_in_target_range` | `lib.rs:6011` | P7 槽位时代遗留带 `[3,14]`（槽位层 P31 已删） | 换成同源体量带 `[24,50]` + 写明「语义已死」 |
| `p30_window_foul_cancels_without_shot` | `lib.rs:8141` | 打分基线变更使原几何选出 Tackle | 重扫几何取 d≈3.15m（Foul 胜出） |
| `l2_sent_off_kickoff_seeds` | `realism.rs:1129` | RNG 重排使原 4 seed 零红牌 | 重扫取「红牌先于进球」的 29/35/59/84 |

> ⚠️ 三条均为**改语义/重构造/重扫**，**非**放宽断言或删测试（`design.md` §D10 明令）。

## 技术债（本票记录、不修）

- **`far==0` 断言「量错了东西」**（grill 第 2 轮读码后的表述）：
  它要测的不变量在**未序列化几何**上严格成立且已被 `p30_tackle_score_directions` 守护；
  而 `realism.rs` 的 `far` 从**序列化后字段**重算距离 → **冗余且脆弱**。
  三配置 3000 场都有越界（干净 main 0 / 交付 15 / 备选 25），最大仅 12.0076m。
  正确修法 = 删或加 ε（低风险）；**不在本票**。措辞已落 `design.md` §D10 与测试注释。
- **角球上界硬编码** `8→12→18→15` 已是第四次重标，建议改对均值的相对界。

## 诚实性声明

- 引擎源码改动**未推远程**（待主 session 决定合入）。
- **传球体积缺口未修、且略恶化**（418 → 396，真实 ~900）——需另一条独立机制。
- **判据组净中性偏负**：`swarm` 真回归一条（0.488→0.338）、真改善零条、噪音翻绿一条。
- 看图为必须已做：**无新轨迹形态**，但横向形态中性偏负（latSd 略降、直线度略升）。
