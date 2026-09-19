# P38 候选片段（供逐个评审）

> 这是给**人**看的目录：每个候选是一个**独立的、可应用的改动**，附实测结果与我的判断。
> 与 `notes/patches/` 的区别：那里是**实验存档**（含被证伪的），这里是**我认为值得你花时间看的**。

## 怎么用

每个候选一个目录，包含：
- `README.md` —— 改了什么、为什么、实测数字、**我的判断**（含不通过的部分）
- `*.patch` —— 可 `git apply` 到 main 的完整改动
- `evidence/` —— 跑出来的原始输出

```bash
cd <worktree>
git apply candidates/<候选>/*.patch
export PATH="$HOME/.cargo/bin:$PATH"
(cd engine && cargo build --target wasm32-unknown-unknown --release)
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs   # 判据组
node openspec/changes/p38-formation-realism/notes/probes-main/render-trajectories.mjs engine /tmp/x.png "x" 120  # 轨迹图
git checkout engine/src/lib.rs                                                     # 还原
```

## 候选清单（按值得看的程度排序）

| # | 候选 | 状态 | 一句话 |
|---|---|---|---|
| 01 | 射门空间尺度重标定 | ✅ **单独通过全部门 + 射门↑** | 真实射门时防守者中位仅 2.5m；引擎却要求 8m 才算"没压迫" |
| 02 | 球侧过载 + 远端内收 | ⚠️ 方向对力度不够 | swarm 从 0.95 降到 0.73（真实 0.61），但横向只有 1.31m |
| 03 | 两队解耦 | ⬜ **未实测** | 票据 #89 的核心假设，从没验证过 |

（其余实验 —— 模板压缩 / 单常数 / 等间距重排 / 整队跟球 —— 已证伪，
存 `../notes/patches/`，仅作反例。）

## 一条贯穿所有候选的重要事实

**P38 探索至今没有找到能同时满足「纵深 + 横向 + swarm + 引擎门」的机制。**
原因不是没试够，而是一条**耦合**：

> 队形压紧 → 防守方自然贴上进攻方 → 射门空间归零

实测：纵深 40 → 27 时，射门 15.8/场 → 1.8/场，**中间没有可用工作点**。
候选 01 证明"射门模型的空间尺度"不是主因（单独有效，但救不回队形压缩造成的崩塌）。

→ 这正是票据 #89 要解决的问题。**候选 03（两队解耦）是唯一还没试过的方向。**
