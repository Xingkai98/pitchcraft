# Proposal: 扩样本：接入 SkillCorner（20 场，MIT）

## Why

P36 立起了标尺，但默认形态只能是**报告期**——只输出数字与对比，**不判定符合性**。
根因不是标尺做得不好，是**样本不够**：

- 真实侧只有 **2 场 / 13 个满窗**（Metrica 匿名样本）。
- 实测留一交叉验证：用 game1 导出的观测范围去检查 **game2**（同一数据集、同一采集管线的
  另一场），纵深只有 **3/6** 个窗口落得进去。

> **用 2 场数据当验收标准，会把一半真实比赛判成"不像足球"。**

所以校准目标迟迟定不下来——现在定就是拿 2 场数据过拟合（issue #78 原文）。
本 change 把真实样本 **2 场 → 20 场**（SkillCorner opendata，MIT 许可），
让标尺从「只能报警」升级为「区间有统计意义」，为后续的校准 change 提供判据。

这不是"再接一个数据源"的功能扩展，而是**解锁校准的前置条件**（issue #78 标题原文）。

## What Changes

- **新增 SkillCorner 抓取**：`tools/fetch-tracking-data.mjs` 增加 SkillCorner 数据集条目。
  ⚠️ tracking 是 **Git LFS 指针**（仓库内仅 133 字节），实体须走
  `media.githubusercontent.com/media/.../**master**/...`（分支是 master 不是 main，
  用 main 会 404——已实测）。20 场合计 ~1.82 GB。
- **新增转换器**：`tools/convert-skillcorner-to-frames.mjs`，把 SkillCorner 的
  `tracking_extrapolated.jsonl` + `match.json` 转成与 Metrica 转换器**同构**的帧序列
  （`{ meta, frames: [{ t, players, ball }] }`）。四件必须处理的事（均已实测验证）：
  1. **坐标系**：米 + 球场中心原点 → 归一化并平移到左门线。
     ⚠️ **球场长度实际有 104/105/106 三种**（20 场实测），**不得硬编码 105×68**。
  2. **朝向**：`match.json.home_team_side`（按 period 索引）决定是否翻 x——
     实测 20 场里有 10 场 P1 是 `right_to_left`（恰好一半），硬编码会让一半比赛整体镜像。
  3. **身份映射**：tracking 的 `player_id` 对应 `match.json.players[].id`
     （实测 32/32 匹配），**不是** `trackable_object`（交集 0——调研时踩过，匹配率 0%）。
     门将用 `player_role.name == 'Goalkeeper'`（**`position_group` 对门将是 `"Other"`**，
     只查 position_group 会漏）。
  4. **时间轴拼接**：SkillCorner 的 `timestamp` 是**比赛时钟**，半场交界处**回跳**
     （实测 frame 28919 = `00:48:10.90` → frame 29000 = `00:45:00.00`，回跳约 190s）。
     直接当连续时间用会出现负的帧间隔、切窗错乱。须拼成单调时间轴。
- **外推点（`is_detected`）透传与口径**：SkillCorner 每帧固定 22 条 `player_data`，
  但实测球员点仅 **57.9% 是真检测**（球的坐标从不缺失、但 **17.7%** 是外推值），
  其余是外推值——**坐标看起来正常但不可信**。
  本 change 把该标记**原样透传**到帧序列（球员与球两处都透传），并给指标层一条显式口径
  （候选方案见 design D2，**待用户确认**）。
  ⚠️ 审阅推翻初稿的「跳过外推点 → 两侧可比」：trim1 是顺序统计量，跳过外推点会把参与
  人数从恒定的 10 变成浮动，**约 45%–61% 的口径差是机械伪影**。候选方案已按此重列。
- **基线与样本量**：`tools/benchmark-baseline.mjs` 支持多数据集（Metrica + SkillCorner）
  分别报告，基线重生成，样本量 **13 窗 → 139 窗**（900s 步长）。
- **留一交叉验证先落报告项**：新增交叉验证——half-split 与 leave-one-game-out 的落空数字。
  ⚠️ **本阶段不作硬门**：审阅证明 min/max 包含门的通过率与样本量无关（N=20 时约 0.25），
  在数据完全正常时也会频繁变红——它不是"数据不够"，是判据形态的问题。
  这是 issue #78 的验收条件，但**升格为门须先刻画门的零分布**（见 design D7）。

## Capabilities

### Modified Capabilities

- `pitch-viewer`: 比赛标尺的真实侧数据源从 1 个（Metrica，2 场）扩展到 2 个
  （+ SkillCorner，20 场，MIT）；帧序列 schema 增加外推点标记（球员与球两处）；
  指标口径增加「外推点处理」与「逐场球场尺寸」两条；基线支持多数据集、
  跨数据集可比性检查与交叉验证（**报告项**）。

## Impact

- 新增：`tools/convert-skillcorner-to-frames.mjs` + 单测；
  `tools/benchmark-crossvalidation.mjs`（交叉验证，**报告项**）+ 单测；
  `tools/converter-schema-consistency.test.mjs`（双转换器 schema 一致性）。
- 修改：`tools/fetch-tracking-data.mjs`（SkillCorner 条目 + LFS 通道）、
  `tools/benchmark-baseline.mjs`（多数据集 + 逐场记录 + 跨数据集检查）、
  `viewer/match-metrics.js`（外推点口径 + **逐场球场尺寸**，
  **口径变更必须同步重生成基线**，见 P36 的陈旧性校验）、`verify.sh`、`README.md`、
  `CLAUDE.md`、`.gitignore`。
- **零引擎改动**：与 P36 一致，本 change 只扩测量样本，不改被测量的引擎。
- **数据不入库**：原始 tracking（1.82 GB）与转换产物都不入库，只入库基线摘要——
  与 P35/P36 一致。基线体积会随样本增长，需评估（见 design 风险）。
- 不引入新依赖（纯 std/原生 JS；`curl`/`git` 已在现有抓取脚本中使用）。

## 与 P36 的关系

P36 是**标尺**，本 change 是**把标尺的刻度做准**（样本量决定区间的统计意义）。
P36 的指标函数与统一帧表示是共用接口，本 change **复用**、不重写：

- `viewer/match-metrics.js` 的指标实现**不重写**，只新增外推点处理与逐场尺寸；
- 转换器产出同一 schema，`fromTrackingFrame` 仍然适用；
- 基线生成与对比链路复用，只扩展数据源。

> ⚠️ **「复用、不重写」有一处例外要说清**：审阅证明「默认跳过外推点」会让 trim1 的
> 参与人数从恒定 10 变成浮动 0–10，从而**实质上改变了估计量**（即便代码一行没改
> 估计量本身）。所以本 change 对指标层的改动**不是零语义**——它要么改估计量（β）、
> 要么把该依赖量化声明（α）。这正是 design D2 的核心。

> issue #78 原文建议顺序：**#77（标尺实现）先做出指标函数 → 本 issue 接入后复用**。
> #77 已合入 main（commit `465eabf`），故本 change 直接复用，无需等待。
