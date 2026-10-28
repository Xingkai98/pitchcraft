---
title: 带守卫的 goal 循环 brief — in-box-shot-priority 自主探索
date: 2026-10-28
type: task
---

# 带守卫的 goal 循环 brief（in-box-shot-priority 自主探索）

> 主 session 只做监督与验收；你（探索 agent）在本 worktree 的 `feat/in-box-shot-priority/2026-10-28`
> 分支上自主迭代引擎改动，直到双盲判别测试里裁判分不出「引擎 vs 真实」。
> **本 brief 是合同。违反任何一条纪律 = 主 session 会叫停并回退。**

## 0. 你的目标与边界

- **北极星（停止条件）**：双盲判别测试准确率 ≤ 0.55（24 张刺激，SE≈10pp），且 ≥2 个零上下文裁判一致。
- **但盲测只是验收，不是搜索方向。** 你的**每一步搜索**由 real-anchored 标量驱动，不是"猜裁判喜欢什么"。
- **工作目录**：本 worktree（`git rev-parse --show-toplevel` 应指向 `…/.claude/worktrees/in-box-shot-priority-2026-10-28`）。
- **分支**：`feat/in-box-shot-priority/2026-10-28`（base = `origin/feat/in-box-shot-priority @ 918c773`）。
- **每个候选版本 commit 一条**，message 自述改了什么、为什么；主 session 会 review/revert。

## 1. 优化目标（搜索方向，按顺序）

1. **先看轨迹图**（第一步，不是可选项）：`trajectory.mjs` 渲图 → **Read 它** → 用一句话写下看到的
   （例："引擎是水平短线、红蓝各占半场、不追球" vs 真实"一团弧线、红蓝混在中路"）。
2. **后量**：`like-football.mjs` 的**距离**（越小越像）+ **最大缺口是哪个量**。攻最大缺口，别去优化 main 已过关的量。
3. **已知最大缺口**（main 实测，2026-10-05）：**disp 位移/窗 0.13×**、**gap 分边 4.42×**、**hd/ad 纵深 2.19×**。
   —— **`dir`（方向一致性）不是优化目标**（main 已过关，0.63≈真实 0.70，没信号）。
4. 每轮改动后跑 `panel.mjs --dataset all`：报「判别准确率 + 落在真实分布外的条目数」，**不合成单一标量**。

## 2. 地板（每轮必须全绿；红了 = 立即回退这一轮，不许"顺手修"）

1. **ratchet 不退化**：改动前 `node tools/ratchet.mjs save /tmp/snap-<轮>.json`，改动后
   `node tools/ratchet.mjs diff /tmp/snap-<轮>.json`。**exit 1 = 有退化 = 回退**；exit 2 = 采集失败（缺数据，先补齐再跑，绝不静默跳过）。
   ⚠️ **2026-10-28 起软指标用「真实 ±25%」带**（`lf.*`）：**带内 = 不退化**（含朝边缘走，方向正确但中间小回退不拦）；带外越远越退化。`lf.distance` 降为报告项。硬不变量（`p38.*`/`p18.*`/L1/spacing/确定性/无snap/无重叠）照旧死守。
   **带内但比上版回退的候选 → 必须过视觉门（trajectory 图 + 盲测 + 纹理探针 冻结/急转）才准升。**
2. **verify.sh 硬门**：`./verify.sh` 里 cargo test / viewer tests / tools tests / wasm e2e / spacing overlap / L1 realism 必须绿。
   （benchmark / crossval / P38 八条 是报告期不阻塞，但 ratchet 里的 `p38.*`/`p18.*` 会判退化。）
3. **确定性 / 无 snap / 无同队重叠**：同 seed 同流（事件流哈希一致）；viewer 播放无 snap。

## 3. 纪律（每条都有前车之鉴，违反 = 主 session 叫停）

1. **★ 先看后量**：任何移动层改动，第一步必须是渲轨迹图 + Read + 写一句话，**然后**才读数字。
2. **★ 尺度**：任何判断先写「5 分钟窗口原始事件数」（viewer 实际播 `FIXED_SEED=42`/`matchDuration=5`）；
   报 90 分钟聚合必须两个尺度并列。
3. **wasm 必须现构建**：`(cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)`。
   读数带 **wasm 流哈希 / engineFingerprint + seed 集**（同 wasm 文件哈希 ≠ 同一次实验）。
4. **跨场绝不拼接**（逐场算再平均，拼接 sd 虚高 6.5× 且奖励 hack）；队形类判据剔门将；横向跨度一律指 y；`sd_x`/x 跨度不当判据。
5. **最简竞争解**：每条改动先试"改个常数/阈值能不能也达标"——能 → 这条不算机制改动，作废。
6. **为什么/机制**：每条改动写「因为 X 所以 Y」；死常量 / 结论对机制错 / doc 声称的机制代码里不存在 = 作废。
7. **探针自审**：NaN 比较恒假、计数器照常 ++、空转断言 = 假证据，先审探针再信读数。
8. **不动**：`engine.wasm`（committed 那份别当基准）、`tools/convert-*.mjs`（源码指纹哨兵，改一行注释就红且要重下数据）、viewer 的 config/seed（viewer-match 漂移守卫会红）。

## 4. hack 迹象（出现任一 = 立即停 + 回退 + 报告，不继续）

- 硬门红（ratchet exit 1 / verify.sh 任一步红 / L1 红 / spacing 红）。
- 指标改善但轨迹图仍是「水平短线 / 红蓝各占半场 / 不聚拢 / 不追球」。
- disp/latSd 改善来自「加抖动（锯齿）/ 冻人」，或 gap 改善来自「防守方没有形状、满场跟人」。
- 只对 2 场 Metrica 好、对 SkillCorner 20 场不好（语料识别）。
- 「分数绿但 5 分钟 viewer 里人眼还看得出假」。
- 优化了 main 已过关的量（dir）——方向错了。

## 5. 停止条件

- **成功**：双盲判别准确率 ≤ 0.55，≥2 个零上下文裁判，held-out 刺激集 + fresh 裁判。
- **止损**：≤ 6 个候选版本不收敛 → 回退到最优候选，如实写残余缺口，停。

## 6. 每轮必须落 `RECORD.md`（本目录）

每条记录带全口径：轮次 / wasm 流哈希 / seed 集 / trajectory.png 路径 + 一句话读图 /
like-football 距离 + 最大缺口 / panel 判别准确率 / 地板结果（ratchet + verify.sh 步名）/
机制注记（因为什么所以什么）。**缺口径的记录 = 假记录。**

## 7. 关键命令速查

```bash
# 现构建 wasm（每次改动后）
(cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
# 先看
node tools/visual-review/trajectory.mjs viewer/engine.wasm /tmp/traj.png [seed=42] [t0=1800] [win=90]
# 后量
node tools/visual-review/like-football.mjs viewer/engine.wasm [seeds=5] [win=12]
# 面板（--wasm 必给，否则 exit 2）
node tools/visual-review/panel.mjs --dataset all --wasm viewer/engine.wasm --lib engine/src/lib.rs
# 跨窗形态
node tools/visual-review/contact-sheet.mjs viewer/engine.wasm /tmp/sheet.png [seed] [win] [n] [t0csv]
# 单窗细看
node tools/visual-review/render.mjs viewer/engine.wasm /tmp/one.png [seed=42] [t0=600] [win=12] [n=6]
# 地板
node tools/ratchet.mjs save /tmp/snap.json   # 改动前
node tools/ratchet.mjs diff /tmp/snap.json   # 改动后（exit 1 = 退化）
./verify.sh
```

## 8. 真实数据（gitignored，本地已有）

- **Metrica 2 场**（运动锚 disp/dir/still）：`viewer/data/real-game-{1,2}.json`（已就位）。
- **结构锚**（hd/ad/spread/gap/width/ballDist）：committed `viewer/data/benchmark-baseline.json`（已就位，入库）。
- **SkillCorner 20 场**（盲测 22 场的另一半 + panel `--dataset all`）：raw tracking 在
  `.scratch/tracking-data/skillcorner/`（已就位）。**frames 未转**，需要时逐场：
  `node tools/convert-skillcorner-to-frames.mjs --match <…/<id>_match.json> --out viewer/data/skillcorner-<id>.json`
  （match.json 与 tracking 的对应关系见 `convert-skillcorner-to-frames.mjs` 内 `resolveTrackingPath`）。
  **盲测前必须补齐 20 场**，否则真实侧只有 2 场，「裁判认出那两场」的混杂解释无法排除。

## 9. 权威参考（先读，别凭记忆）

- `.claude/skills/visual-review/SKILL.md` —— 完整纪律、盲测配方（刺激集 7 条）、固定 6 维打分、已知盲区。
- `openspec/changes/p-team-block-law/design.md` —— 当前 A 层块定律机制 + D12/D13（门前射门优先级）。
- issue 175（`gh issue view 175`）—— C1–C5 wayfinder map 与最新进度。
- `.scratch/notes/team-shape-2026-10-25/` —— 本轮 A/B 层与门前射门探索证据。

## 10. 盲测配方（从 SKILL.md，必须逐条遵守）

刺激集：同一渲染器渲真实与引擎（先验证两侧调色板/几何逐字节相同）→ 单张单源 → 真实侧瑕疵清零 →
死球窗过滤 → 呈现顺序与来源统计独立（洗牌 + 检验前一半真实张数）→ 中性命名 + 24 张恰好 12 真 12 假 →
裁判零上下文（独立目录，无答案键），报逐张判定 + 置信度 + 结构化依据。
**读法**：准确率 vs 0.5 基线；24 张 SE≈10pp，2–3pp 差不下结论。
