# REPORT → 主 session：p143r-v4-spacing-gap（GitHub #149）

**状态**：实现 + 全量复验 + 独立审阅（2 轮）完成，**待 push → CI**（未 merge）。分支
`p143r-v4-spacing-gap/2026-10-12`（base main `dc86ca1`）。

## TL;DR

- **核心验收达成**：`node tools/spacing-sweep.mjs`（默认 8 seed）**全 0**（修前 seed 2 = 5 findings）。
- **L1 9/9 保住**（`l3_shot_ratios` 禁区占比 **0.721**）——**未改任何阈值 / detector 门 / 统计带**。
- **窄触发**（用户 2026-10-12 指示的「真越界 <2.0m 才介入」）：把扰动压到**只在真越界的比赛**上
  ——golden 1..10 里**只有触发 seed 2 变**，其余 **逐字节不变**。
- **订正了 §9.6 的根因**（原文机制不成立，见下）。
- **独立审阅 2 轮**：第 1 轮 P0=0 / P1×1 / P2×2 / P3×4；已逐条处理，第 2 轮复审见
  `.scratch/notes/p143r-v4-spacing-gap-review-2026-10-12.md` §9。

## 1. 真机制（订正 §9.6；探针 + 数值双证）

缝隙在 **传球高亮的飞行最后一拍**：飞行时长 `t_end` **几乎不落在拍边界**上 ⇒ 落点落在拍中，
viewer 让接球者**拍中抵达落点并原地保持**到下一锚点。而引擎 `highlight_frozen_segs` 把参与者的
**本拍显示子段**交给分离 solver 时按**均匀拉伸**时序算最近点 ⇒ 低估参与者前进量：seed 2 实测
solver 口径 **2.146m ≥ 阈值**判无冲突，而 viewer 真实显示最近点 **1.258m**。且 mover 的**下一拍
起点在该拍不可动** ⇒ 必须在**上一拍**把 mover 终点推开（跨拍约束）。

⚠️ **§9.6 的机制描述不成立**（「`sweep_pair_lateral` 对起点已 <2.14m 的 pair 原样返回」）：
该 pair 起点距 **2.5964m ≥ 2.14**，早返回分支**未触发**。结论（要修缝）不变，机制按实测定正。

## 2. 修法（`engine/src/lib.rs`，窄触发）

`highlight_frozen_segs`：**只在**「参与者落点落在某**同队** mover 本拍候选轨迹
`SAME_TEAM_OVERLAP_MIN_M`(2.0m，= detector `player_overlap.min_distance`) 内」时介入，按
`t_rem = t_end − t` 分两档——`t_rem < TICK`（本拍内完成，有保持段）→ 落点退化为**一点**；
`TICK < t_rem < 2·TICK` → 终点钉**落点**（跨拍约束）。`t_rem == TICK`（抢断式满拍）与 `≥2·TICK`
**严格走原口径**。新增 `point_seg_dist_m` 辅助 + 常量 `SAME_TEAM_OVERLAP_MIN_M`。
**零阈值放宽、零事件层改动、零 viewer 改动。**

## 3. 复验读数（全量）

| 判据 | 读数 |
|---|---|
| `node tools/spacing-sweep.mjs`（8 seed） | **全 0**（`OK: no player_overlap findings`） |
| `cargo test`（默认 --no-fail-fast） | **全绿**（lib 201 / p124 35 / p15 11 / p16 36 / p17a 24 / p17b 33 / p18 6 / realism 4；含新测试） |
| `cargo test --test realism --release -- --ignored` | **9/9**（`l3_shot_ratios` 0.721） |
| `cd viewer && node e2e-v2.mjs` | OK，**无 snap**（球 0.0079 / 球员 0.0151） |
| `node --test tools/*.test.mjs` | **505/505**（含基线指纹哨兵） |
| `node --test viewer/*.test.js` | 352/353（唯一红 = `app.test.js`，**本地缺 jsdom**；主仓库同一用例同样红，非本次引入；CI `npm ci` 装 jsdom） |
| golden-v8 | 重基线；**只 seed 2 变**（结构性，diff 见 design §D4），其余 9 seed 逐字节不变 |
| p15 截断形态 seed | `[51,103,244]` **仍全命中**（无需重扫） |
| **反证** | 撤修法（换回 `574b653f`）→ `spacing-sweep.mjs 2` **回红**（见 §5 日志） |
| 新增引擎测试变异 | 宽触发(1e9) → 红；去约束(breach 恒 false) → 红；复原 → 绿（**有区分度**） |

**wasm**：修后 `f753b1777dfb4854`（行为等价于记录读数所用构建 `e3b3e89fe47f6766`；注释/`#[cfg(test)]`
改动改哈希不改行为，`zz_churn` 核 `slotDiff=0`）。修前 `574b653f7d8e`（= main B）。

## 4. 独立审阅（paseo agent，零上下文）

- **第 1 轮**：`.scratch/notes/p143r-v4-spacing-gap-review-2026-10-12.md`。P0=0；**P1-1**（spec delta 的 SHALL 比实现宽，
  归档会写错主 spec）→ 已补窄触发条件 + 严格边界；**P2-1**（注释「不漏约束」过宽）→ 已改精确；
  **P2-2**（无引擎级测试覆盖）→ 已加 `p53_highlight_landing_enters_solver_on_breach` + 变异证明；
  P3-1/3-2/3-4 文档引用/golden diff 全集/tasks 勾选已修；P3-3（指纹哨兵采样盲区）为既存信息项。
- **第 2 轮**：见 `.scratch/notes/p143r-v4-spacing-gap-review-2026-10-12.md` §9（复审）。

## 5. 反证日志（撤修法：换回 `574b653f` 的 wasm）
```
$ cp /tmp/engine-b.wasm viewer/engine.wasm && node tools/spacing-sweep.mjs 2
seed 2: 2157 windows, player_overlap findings=5 worst=1.957m

FAIL: 5 player_overlap finding(s) over the swept windows
EXIT=1
```
（复原 `viewer/engine.wasm` = 修后 `f753b177`。）

**新增引擎测试的定向变异**（证明有区分度）：
```
变异 A（阈值 2.0→1e9，宽触发）：test tests::p53_highlight_landing_enters_solver_on_breach ... FAILED（未破阈断言）
变异 B（breach 追加 && false，去约束）：... FAILED（破阈+本拍内完成断言）
复原：... ok
```

## 6. PR / CI

- **PR #150**（base=main）：https://github.com/Xingkai98/pitchcraft/pull/150
- CI runs：push `38211181679` / pull_request `38211197089`（`verify.sh` 9 步；step 5 = spacing-sweep 是验收核心）
- **push run `38211181679`：✅ success（26m52s）**——`verify.sh` 9 步全过（含 **step 5 spacing-sweep 归零**、step 1 cargo test、step 7 L1 9/9）。
- pull_request run `38211197089`：GitHub 于 06:40 重跑（同 commit、同 verify.sh），进行中。
- 结论：**验收核心（step 5）CI 已绿**；PR 为同一 commit 的重复验证。

