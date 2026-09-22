# Progress: p104-volume-recalibration

> 主 session 会核验 worktree 文件，不只依赖口述。每个阶段在此留痕。

## 状态：**停在「等用户拍板」**（P0）

- 分支 `p104-volume-recalibration/2026-09-21`，基于 main `6f5827f`
- 干净 main wasm sha8 = `901da77b`（已在本 worktree 重建核对）
- `git status --porcelain engine/` 为空；`viewer/engine.wasm` = `901da77b`

## 阶段记录

| 阶段 | 状态 | 产物 |
|---|---|---|
| 读三份前提文档 + patches/README | ✅ | — |
| 重建 wasm 核对 sha | ✅ | `901da77b` |
| 建 change 目录 | ✅ | `openspec/changes/p104-volume-recalibration/` |
| 探针 + 口径对齐自检 | ✅ | `notes/probes/*.mjs`，五项指标与 Rust 逐位相同 |
| 穷尽最简竞争解（#102 教训） | ✅ | `design.md` §D2（方案 ①②③） |
| 抢断杠杆粗扫 + 细扫 | ✅ | `notes/probes/out/FINDINGS-exploration.md` §2 |
| 通道杠杆（机会点速率）试过并排除 | ✅ | FINDINGS §3 |
| 留出窗口（3 个不重叠种子窗） | ✅ | design.md §D5，三窗稳定 |
| 角球长尾刻画 | ✅ | design.md §D6，600 场 P(>12)=0.17% |
| proposal / design / tasks / spec delta | ✅ | `npx openspec validate --strict` 通过 |
| **独立零记忆 subagent grilling** | ✅ | `reviews/grill-design.md` |
| **P0 用户拍板** | ⏸ **阻塞中** | design.md §D7 的 5 个 Open Question |
| P2 引擎常量 | ⬜ 待拍板 | — |
| P3 门重标 | ⬜ 待拍板 | — |
| P4 golden v7 | ⬜ 待拍板 | — |
| P5 主 spec + verify.sh + 看图 | ⬜ | — |
| P6 审阅闭环 | ⬜ | — |

## 需要用户确认什么（摘要，详见 `design.md` §D7）

1. **抬体积用 2 常量还是 3 常量？**（建议 3；2 常量更简单但犯规钉在下界）
2. **射门带新值？**（建议 `[13,21]`；真实侧两来源分歧 16.5 vs 22.1，锚点待定）
3. **主队进球带新值？**（建议 `[0.85,1.60]`）
4. **单场角球上界新值？**（建议 `≤18`；这是第三条红门，**任务书未列**）
5. **`MODEL_VERSION` 6→7 + golden-v7，确认？**

## 与任务书的两处实质偏差（如实报出）

1. **shot/tackle `[0.5,1.5]` 不需要重标**——因为本票**把抢断一起抬了**（0.563 在原带内）。
   任务书给的红值 1.785 来自「只抬射门」的配置。
2. **`l3_shot_ratios` 三条比率带也不需要重标**——实测三条全过。
   真正被顶破的第三条是**单场角球上界 12**（任务书未列）。

## 任务书未列、本票实测发现的第四条连带项

**比赛标尺基线 `viewer/data/benchmark-baseline.json` 必须重生成**（design.md §D6b）。
引擎指纹（`lib.rs` + `engine.wasm` 双哈希）会让 `tools/benchmark-baseline.test.mjs` 硬失败。
实测候选 vs 基线：hd −0.349 / ad −0.264 / spread +0.116 / gap −0.368 / ballDist +1.958
（全部 ≫ 1e-6 的"仅注释改动"容差）。重生成链路本票已在 worktree 验证**逐位可复现**。

## 附：本票**未**做的事（诚实性声明）

- **未做技能类实际改动**：P0 未拍板，引擎源码零改动（`git status` 为空）。
- **传球体积**（418 vs 真实 ~900）不在本票——它需要另一条独立机制。
- **二次进攻链**不在本票——本票是常量抬升，不是结构修复。
- **真实侧只有 2 场（Metrica）+ 356 场（StatsBomb 事件表）**，无 SkillCorner tracking 对照
  （本票不碰队形，不需要）。
- 角球长尾的 exceedance 用 600 场估（P(>12)=0.17% → 约 1/600），**置信区间很宽**。
