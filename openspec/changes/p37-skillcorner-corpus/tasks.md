# Tasks: 扩样本——接入 SkillCorner

> 顺序：**用户确认 D2/D5/D6 三项口径 → 抓取与转换器 → 口径与基线 → 交叉验证 → 文档收尾**。
> 用户确认前不写实现代码（项目流程要求）。
>
> 立项侦察已完成（2026-09-18，主 session 实测）：`player_id`↔`players[].id` 32/32、
> 外推率 57.9%、半场时钟回跳 190.9s、球场 104/105/106、时间缺口 61 处合计 1599s。
> 证据见 `design.md` 的「上下文」与 D1–D8。

## P0. 设计与确认

- [ ] P0.1 提案 + 设计 + spec delta（本文件所在 change）——立项已完成，待审阅
- [ ] P0.2 **独立审阅（subagent，零记忆）**：审 design 的可实现性与遗漏，
      重点核对：外推口径是否真的两侧可比（D2）、时间轴拼接是否与引擎侧同构（D3）、
      球场尺寸偏差的取舍是否成立（D4）、half-split 当硬门是否会因单场异常而脆（D7）。
      报告落 `reviews/design-review.md`，P1 问题**修完再进实现**。
- [ ] P0.3 **用户拍板三项**（见 design「Open Questions」）：
      D2 外推点口径 / D5 窗口步长 / D6 样本组合。
      答复记入本文件的 `## User Confirmation` 节（**用户实质答复，非占位文本**）。

## User Confirmation

（待用户答复 P0.3 的三项。占位文本不计入确认。）

## P1. 抓取与转换器

- [ ] P1.1 `tools/fetch-tracking-data.mjs` 增加 SkillCorner 数据集条目：
      仓库用 codeload 打包（~25.7MB，含 `match.json` 等小文件）；**tracking 实体是 LFS 指针**，
      须逐场从 `media.githubusercontent.com/media/SkillCorner/opendata/**master**/data/matches/<id>/<id>_tracking_extrapolated.jsonl`
      拉取（分支是 **master**，用 main 会 404）。
      - 单场失败**可跳过/可续**（网络抖动不应废掉整批 20 场）；
      - 记录许可（MIT）与来源；落 `.scratch/tracking-data/`（gitignored）。
- [ ] P1.2 `tools/convert-skillcorner-to-frames.mjs`：SkillCorner → 帧序列（与 Metrica 转换器同构）
      - 坐标系：米 + 球场中心原点 → 归一化 + 平移到左门线；y 轴翻转与 Metrica 转换器一致
      - **球场尺寸按每场取值**（104/105/106，不得硬编码），记入 `meta.pitchMeters`
      - 朝向：`match.json.home_team_side[period-1]`，`right_to_left` 翻 x
      - 身份：`players[]` 按 `team_id` 分队；门将用 `player_role.name == 'Goalkeeper'`
        （**注意 `position_group` 对门将是 `"Other"`**）；tracking 的 `player_id` 对应
        `players[].id`（**不是 `trackable_object`**，实测交集 0）
      - 替补顶槽位：保证每帧 id 集合稳定（沿用 Metrica 转换器的 `assignIds` 思路）
      - **时间轴拼接**：P2 平移 `shift = max(P1.t) - min(P2.t)`，产出单调时间轴
      - **外推标记透传**：`is_detected=false` 的点写入帧序列（字段名见 P1.3）
      - 缺球补全：沿用 `ballFill` 语义（`nearest`/`hold`/`none`）与 `ballFill` 标记
      - `meta.coverage`：填充率、球缺失率、**外推点占比**、`shortHandedPct`、重复坐标率
- [ ] P1.3 帧序列 schema 扩展：外推标记的字段名与形状**写定并入库**
      （建议 `players[i]` 从 `[x,y]` 扩展为 `[x,y,extrapolated?]` 或并列 `extrapolatedIds` 数组
      ——**选择须考虑 `fromTrackingFrame` 的改动量与向后兼容**，见 P2.1）
- [ ] P1.4 转换器单测：LFS 指针识别 / 坐标归一（含 104/105/106 三种尺寸）/
      朝向（`left_to_right` 与 `right_to_left` 两种）/ 身份映射（含 `position_group="Other"` 的门将）/
      **时间轴拼接（构造回跳输入断言输出单调）** / 外推标记透传 / 缺球补全
- [ ] P1.5 **量化外推过滤的影响**（D2 最大风险）：逐场逐窗统计「仅真检测」口径下的
      有效帧数与丢帧率；若某窗落入 `minFrames=100` 之下则记录并报告。
      **产出数字回填 design D2**；若丢帧严重，回退方案须经用户确认。
- [ ] P1.6 两转换器产出 schema 一致性测试：一条断言同时跑 Metrica 与 SkillCorner 转换器，
      断言两者产物结构相同（守护 D1 的"共用 schema"承诺）

## P2. 口径与基线

- [ ] P2.1 `viewer/match-metrics.js`：新增外推点口径（`fromTrackingFrame` 透传标记 +
      `teamShape`/`possessionProxy` 等按默认口径跳过外推点 + 全点口径并列）
      - **口径语义不得改变**（P36 已定的 trim1/剔门将/瞬时队形/米制等保持不变）
      - 该改动会使 P36 基线因 `hashMetricsModule` 校验失效——**这是设计意图**，必须重生成
- [ ] P2.2 外推口径守护测试：构造含外推标记的输入，断言默认口径跳过它；
      **反证条**（对齐 P36 的教训）：断言全点口径下结果**不同**，
      否则测试对"是否跳过"无区分度（空转断言）
- [ ] P2.3 `tools/benchmark-baseline.mjs` 支持多数据集：
      Metrica（2 场）与 SkillCorner（20 场）**分别报告**（D6），
      SkillCorner 为主；各数据集的来源/许可/采集方式入 `declarations`
- [ ] P2.4 基线重生成：样本 13 窗 → 140 窗（900s 步长）；
      **逐窗记录** `frameCount` 与「仅真检测」下的有效帧数；
      声明节补齐：时间缺口占比（~27%）、球场尺寸偏差（<1%）、
      "样本增加可能让范围变宽"的预告（D8 / spec 最后一条）
- [ ] P2.5 基线体积实测；超 300KB 则按 D8 瘦身（记录取舍）

## P3. 交叉验证

- [ ] P3.1 `tools/benchmark-crossvalidation.mjs`：
      **half-split 硬门**（种子固定并记录）+ **leave-one-game-out 诊断**（报告项）；
      输出逐指标、逐场结果
- [ ] P3.2 交叉验证单测：构造"范围容纳"与"范围不容纳"两组输入，
      断言前者通过后者红；**变异自证**（对齐 P28/P36 教训：守卫绑执行层，绕过必红）
- [ ] P3.3 `verify.sh` 纳入：交叉验证门（真实侧数据缺失时**跳过而非失败**，沿用 P36 惯例）
- [ ] P3.4 实测运行并记录结果：20 场 half-split 是否通过、哪些指标最易落空、
      与 P36 的 2 场范围对比（**变宽还是变窄**）——回填 design 与 README

## P4. 文档与收尾

- [ ] P4.1 `README.md` / `CLAUDE.md`：SkillCorner 怎么抓、怎么转、基线怎么重生成、
      交叉验证门怎么跑；口径在哪
- [ ] P4.2 把实测发现写入文档（外推口径的影响量级、时间轴拼接、球场尺寸偏差、
      half-split 结果）；数字以基线文件为**唯一来源**
- [ ] P4.3 `openspec validate --all --strict` 通过
- [ ] P4.4 代码审阅闭环（独立 subagent，直到无遗留问题；报告落 `reviews/impl-review*.md`）
- [ ] P4.5 **合入**：merge origin/main 进分支 → push → PR → CI 绿 → merge
      —— **合入动作之前**必须先完成：跟踪 issue #78 的 comment + close、
      `openspec/changes/` 归档或留存确认、本地 main 快进。合入后 agent 会话即终止。

## 后续（不在本 change 范围）

- [ ] **校准目标定档**：样本到位后，用本 change 的判据定"引擎纵深 +57% 该压到多少"
      ——这是 issue #78 解锁的下一步，需独立立项
- [ ] ratchet 门/区间验收门：样本够了，区间才有意义（P36 已留接口）
- [ ] 引擎侧样本特征化（不受真实样本限制，可并行）
