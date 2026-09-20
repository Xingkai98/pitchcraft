# P38 实验补丁存档

> **这不是"待合的改动"，是实验证据。**
> 每个补丁记录 P38 探索中试过的一个方案，配合 `../findings-final.md` 的结论表使用。
> 全部可 `git apply` 到当时的 main 重现实验。

## ⚠️ 关于 `fix-tackle-duplicate-mover.patch`

**这是唯一一个改引擎源码的补丁，且尚未合入 main。**

它在 P38 线 B 中被当作**前置修复**：横向机制让队友靠得更近 → tackle 的"推开队友"分支
频繁触发 → 产生同 id 两条 mover → `createGame` 抛错（`local s=0.96` 时 10 种子崩 5 个）。
agent 验证过它**单独跑在干净 main 上行为中性**（`duty 0.0` 复现基线射门 7.2/场，一致）。

**要不要合入是 #89 的决定，不是 P38 的。** 理由：
- 它修的是**真实缺陷**（重复 mover 会让 viewer 崩），但触发条件是**队形压缩后才常见**——
  当前 main 的队形没有压缩，所以它现在不是问题
- 等 #89 的方案真正压缩队形时，它会变成必需

**别顺手合它。** 若要合，应作为独立 change 走 OpenSpec 流程 + 完整验证。

## 补丁清单

### 纵向（改 `formation_target` 的 x）

| 补丁 | 一句话 | 结论 |
|---|---|---|
| `exp1-template-compress.patch` | 压缩 `default_lineup` 的模板间距 | ❌ hack（断层搬家、弹性符号翻反） |
| `exp3-no-clamp.patch` | 移除防线的双重 clamp | ❌ 更差（gap 13.9→23.5） |
| `exp4b-equal-spacing.patch` | 等间距次序目标 + 球锚定 | ⚠️ 纵深达标但射门 −93%（**与射门耦合**） |

### 横向（改 `formation_target` 的 y）

| 补丁 | 一句话 | 结论 |
|---|---|---|
| `exp5-lateral-follow.patch` | 全队加横向跟球系数 | ❌ swarm 0.95（"一群鱼"） |
| `exp7-ballside-tuck.patch` | 球侧过载 + 远端内收 | ⚠️ 方向对力度不够（横向 1.31m vs 真实 10.04） |

### 射门链（阶段 2 新增，2026-09-20）

> 阶段 2 的结论：射门崩的**真因不是队形**，是持球链的出球门。见 `../defense-layers.md`。

| 补丁 | 一句话 | 结论 |
|---|---|---|
| `exp10-pass-gate-3m.patch` | `OPEN_PLAY_PASS_PRESSURE_M` 8.0 → 3.0（**只改一行常量**） | ⚠️ 诊断证据：射门 7.2→11.4/场，但引擎 L1 门 4 红（犯规 50/场、shot/tackle 1.65）；配 exp4b 时 5 红 |
| `exp11-defense-layers.patch` | 防守方按纵深排名分「压迫层 / 保护层」 | ❌ **证伪**：纵深过压 17.9（真实下界 23.4）、射门归零、10 种子崩 2 个 |

⚠️ **exp10 不是"待合的修复"**——它是一条**单变量诊断**：证明射门数对这条门因果敏感
（8.0→3.0 让射门 +58%）。它单独**不能**交付（L1 门红），但它是本轮唯一一条
**不在队形里**的线索，交给 #89 做机制设计时的起点。

⚠️ **更正（#89，2026-09-20）**：exp10 那条"犯规 50/场 = 门收紧的代价"是**混淆读数**——
50.4 来自 `exp4b + 门 3.0`，而 **exp4b 自己**就让犯规到 55/场（队形压缩 → 球员距离普遍变小
→ `TACKLE_DISTANCE_THRESHOLD_METERS` 内的时间变多）。在**干净 main** 上收门，犯规反而略降
（23.53 → 20.37）。见 `../tradeoff-breaking.md` §2.1。

### #89：打破单标量门（2026-09-20 新增）

> 完整论证与真实数据实测：`../tradeoff-breaking.md`。
> 变体库：`probes-main/exp89-variants.mjs`；runner：`probes-main/run-exp89.mjs`。

| 补丁 | 一句话 | 结论 |
|---|---|---|
| `exp89-position-gate.patch` | 位置门：射程内门收 0.5m（贴身照射）+ `d1≤1.5m` 时仍出球 | ❌ **#89 原假设证伪**：射门 10.8/场（比同射门数的一维门**不赢**）、犯规 22.5 正常 |
| `exp89-position-gate-noguard.patch` | 同上无保护条 | ❌ 保护条不生效（10.8 vs 10.4，sem≈0.5 内） |
| `exp89-flat-gate-3.0.patch` | 全局收门到 3.0m（一维对照） | ⚠️ 射门 11.4/场，犯规 20.4（**在干净 main 上 L1 绿**，与前人结论相反） |
| **`exp89-engage-shift-3.5.patch`** | **`OPEN_PLAY_SHOT_ENGAGE_SHIFT` −4.3→−3.5** | ✅ **射门 17.6/场（≈真实 16.51）、犯规 23.46 ∈ L1[16,30]** |
| **`exp89-engage-shift-3.0.patch`** | 同上 →−3.0 | ⚠️ 射门 26.8/场（超真实）、犯规 23.56 绿，**但进球 0.95→3.18 破 4 条 L1** |
| `exp89-combo-gate-shift.patch` | 位置门 + 倾向抬升（可加性对照） | ⚠️ 19.9 vs 可加预测 21.2 → 两乘子**近似独立** |

**这两个 `engage-shift` 是本轮唯一"同时拿到射门量级与犯规带"的配置**，
但**都不是可交付解**：射门频率一抬，`shot_bucket` 的固定转化率把进球一起抬上去。
真正的下一对兑换是 **射门频率 ↔ 进球**（见 `../tradeoff-breaking.md` §3.1）。
**同样不建议顺手合入**——它们未做 OpenSpec、且会破 L1 的进球相关门。

### 组合 / 其他

| 补丁 | 一句话 | 结论 |
|---|---|---|
| `exp8-shot-space.patch` | 射门空间尺度按真实重标定 | ✅ **单独**通过全部门、射门 7.9→9.6；但救不了队形压缩的崩 |
| `exp9-duty-s0.6.patch` | 公共球侧信号 + 边中增益分化 | ❌ swarm 0.899 |
| `exp9-gated-s1.1.patch` | 各人响应相位不同（打破公共信号） | ⚠️ swarm 0.355 很好，但画面是**竖直铁轨** |
| `exp9-local-s1.0.patch` | 局部邻居 y 均值驱动 | ❌ 相变不稳定、射门崩 |
| `fix-tackle-duplicate-mover.patch` | 引擎：重复 mover 修复 | ⏸ **未合入**，见上 |

## 应用方式

```bash
cd <clean-main-worktree>
git apply openspec/changes/p38-formation-realism/notes/patches/<补丁>
export PATH="$HOME/.cargo/bin:$PATH"
(cd engine && cargo build --target wasm32-unknown-unknown --release)
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
node openspec/changes/p38-formation-realism/notes/criteria/eval-criteria.mjs <标签>
# 还原
git checkout engine/src/lib.rs
```

⚠️ **每次实验前确认 wasm 是从当前 worktree 的 main 源码重建的**（记 sha256 前缀）。
P38 在这上面栽过两次（拿过未合入分支的 wasm、以及脚本硬编码旧 worktree 路径）。
