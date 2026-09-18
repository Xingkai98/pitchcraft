# P38 探索探针（主 session + 审阅者）

> 本目录是 P38 wayfinder 探索（map issue #86）的实验代码存档。
> 结论见 `../findings-final.md`。

## ⚠️ 运行前必读：wasm 必须是干净 main

本轮探索**出过两次事故**，都源于用了错误的 `viewer/engine.wasm`：
主仓库根目录那份来自**未合入的 demo 分支**（`demo/off-ball-movement`）。

**每次实验前必须重建**：

```bash
export PATH="$HOME/.cargo/bin:$PATH"          # cargo 不在默认 PATH
cd engine && cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm
sha256sum ../viewer/engine.wasm | cut -c1-8   # 干净 main 应报 901da77b
```

**引擎源码必须干净**（`git status --porcelain engine/` 为空）。改完实验记得
`git checkout engine/src/lib.rs` 还原，否则会污染并发的其他工作。

## 快速循环

```bash
node quick-metrics.mjs 42          # 单种子三项指标，~6 秒
node structural-check.mjs "<标签>"  # 结构判据（断层/移动比/横向/块跨度）
```

完整的 5 种子对标：`node ../../../../../tools/benchmark-compare.mjs`。

## 主 session 的探针（核心）

| 文件 | 用途 |
|---|---|
| `verify-target.mjs` | **靶子验证**：外推率 vs 队形深度排名（U 形）、三种口径的纵深 |
| `structural-check.mjs` | **结构判据**：断层幅度/中场后防移动比/横向移动/块跨度曲线 |
| `quick-metrics.mjs` | 单种子快速指标（改引擎后的反馈循环） |
| `probe2-order-stats.mjs` | 瞬时次序统计量（相邻次序间距 → 断层位置） |
| `probe3-clamp-hypothesis.mjs` | 各线位置随球位变化（防线/锋线） |
| `probe4-block-fit.mjs` | 块模型回归（块中心/跨度 vs 球位） |
| `probe5-per-slot-movement.mjs` | 逐槽位 x/y 移动量 |

## 审阅者的探针

`adv1-*` … `adv9-*` 来自机制向对抗审阅；`probeB-*` … `probeL2-*` 来自方案设计 agent。
它们支撑 `../adversarial-review-*.md` 与 `../design-*.md` 里的数字。

## 实验补丁（`../patches/`）

三个关键实验，全部已验证：

| 补丁 | 改动 | 结果 |
|---|---|---|
| `exp1-template-compress.patch` | 压缩 `default_lineup` 模板间距 | 四项指标改善但断层**搬家**、弹性符号翻反 |
| `exp3-no-clamp.patch` | 移除防线的双重 clamp | gap 从 13.9 **恶化**到 23.5（clamp 有隐藏的正面作用） |
| `exp4b-equal-spacing.patch` | 等间距次序目标 + 球锚定 | 断层消除、四项落位，但 **5 道 L1 门全红**（射门 −93%） |

**这三个补丁是本轮最有价值的资产**：`exp1`/`exp3` 是「拟合数字」的反例，
`exp4b` 是「机制对了但破坏引擎行为」的反例。任何新的验收判据**必须**能把它们区分开
（见 map issue #86 的 #91 票据）。

应用方式：

```bash
cd /home/happy/.claude/worktrees/wayfinder-realism
git apply openspec/changes/p38-formation-realism/notes/patches/exp4b-equal-spacing.patch
export PATH="$HOME/.cargo/bin:$PATH"
cd engine && cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm
cd .. && node openspec/changes/p38-formation-realism/notes/probes-main/quick-metrics.mjs 42
# 还原：git checkout engine/src/lib.rs
```

## 口径提醒

- **真实侧**：`viewer/data/real-game-{1,2}.json`（Metrica，2 场）；
  SkillCorner 转换产物在 `.scratch/p38-frames/`（6 场，需按 `00-fetch-subset.mjs` 流程生成）
- **客队必须镜像**（`teamXs` 里 away 的 x 取 `1-x`）——主 session 曾因漏掉这步
  得出过错误结论（回归斜率被两队抵消）
- **y 轴用 `PITCH_WIDTH_M`(68)**，不是 `PITCH_LENGTH_M`——曾用错导致横向移动量算错
