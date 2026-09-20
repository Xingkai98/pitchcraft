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
