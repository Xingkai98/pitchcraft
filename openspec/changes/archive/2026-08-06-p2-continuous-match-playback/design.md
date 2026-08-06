# Design: 引擎 tackle 语义补全（tackle-engine）

## Context

P1 之后单事件演绎成形，但 tackle 的引擎语义仍不自洽：引擎连续流认为"防守者在接触点拿到球"（`pos[p] = victim_pos`），而 viewer 把抢断演成"球弹到 loose 点、有人捡球"。连续播放（见 `p3-continuous-playback`）必 snap。

本 change = 原 p2 的 Phase B：引擎/协议 tackle 语义补全。Phase C（viewer 连续播放）已拆分到 `p3-continuous-playback`。

## Goals / Non-Goals

**Goals:**
- 引擎 tackle 语义真实化：就近防守、可失败、事件自带"带球起点 + 弹开点"。
- viewer 抢断升级五段式：被铲者带球中被抢。
- 引擎/viewer 两端状态一致，为连续播放铺路。

**Non-Goals:**
- 不做引擎 AI（决策打分/能力值）——票据 05，之后。
- 不做无球跑位/位置维持事件（`off_ball_run`）——Phase C 先 hold，后续单独 change。
- 不做带标签 RNG 流完整化/定点数——票据 06 的完整目标，Phase B/C 用现有种子 RNG 保证同 seed 确定。
- 不做完整 90 分钟比赛规则（越位/界外球/角球）——之后。
- 不做 Tauri 桌面壳（票据 07 已定，但接入桌面是独立工作）。

## Decisions

### D1: 本 change 只做 Phase B（引擎/协议语义补全）
- Phase B 先做（引擎语义），完成后归档；Phase C（viewer 连续播放）拆分到 `p3-continuous-playback`。
- **为什么**：C 的事件边界连续性依赖 B 的 loose/carrier_from；阶段独立可验证、可归档。

### D2: `loose_x/y` 由引擎算，规则与 viewer `deflectPoint` 对齐
- 引擎确定性地算弹开点：逼近方向垂线 × 距离（归一化），优先场内、越界钳制、零距离退化——与 P1 viewer 的 `deflectPoint` 同规则。
- **success 与 fail 都发 `loose_x/y`**（fail 的 loose 点按同规则算，viewer 演"原持球人追到弹开点拿回"）。
- viewer 优先采用引擎的 `loose_x/y`；缺失时 fallback 现有 `deflectPoint`。
- **为什么**：引擎说了算（语义），viewer 兜底（兼容旧数据）。两端同规则保证一致。

### D3: `carrier_from_x/y` = 被铲者带球起点（上一事件持球者位置）
- 引擎在 `pos[]` 里维护持球者位置，tackle 事件发 `carrier_from` = 持球者**带球起点**（上一次 dribble/pass 起点，或射门点），`x2/y2` = 接触点。
- viewer 在一个片段内演"被铲者从 `carrier_from` 带球到接触点"，防守者同时逼近 → 移动中的持球者被抢。
- **carrier_from 缺失时**（旧数据/兼容）：viewer 保持 P1 行为——被铲者原地带球（球直接出现在脚下），不做额外移动。
- **连续模式的重复段（已知边界，p3 处理）**：clip 模式（当前）每个事件自包含，tackle 自带"带球中被抢"完整演绎（符合用户核心诉求）；连续模式（p3）里若 tackle 前正好是同一被铲者的 dribble，viewer 会丢弃 carry-beat 起点、hold 到接触时刻，避免重复前段——在 p3 的 viewer 侧处理，不改变 `carrier_from` 的"带球起点"语义。
- **为什么**：真实语义——tackle 针对移动中持球人；引擎数据现成，成本极低；单事件自包含（不依赖事件流上下文）。

### D4: tackle 触发决策模型（距离感知 + 抢断积极性）
- 引擎**不再固定概率进 tackle 分支必抢**，而是：每个事件点，找离持球者最近的对方球员（用 `pos[]` 实时位置，非静态站位；**排除门将**）；
  - 最近距离 > `tackle_distance_threshold`（约 10m）→ 不产 tackle，落回 pass/dribble/shot（当作普通进攻事件）。
  - 最近距离 ≤ 阈值 → 以 `tackle_eagerness`（抢断积极性概率，标定约 **0.09**，对应每场 8-15 次）决定是否真的去抢；概率不中 → 继续进攻。
  - **同对冷却**：与上次抢断同一对 (防守者,被铲者) 时不立即再抢，避免乒乓。
- 三个参数组织成**引擎内常量 + 清晰决策函数** `should_tackle()`，注释标明将来接战术（票据 04）/属性（票据 05）。
- **为什么**：实现"防守者自行判断、只有少量机会真抢"（用户 2026-08-06 补充）；参数化挂载点是战术/属性系统的入口。目标频率每场约 8-15 次（实测 0.09 → 平均约 10 次/场）。

### D4b: 抢断结果 success/fail 概率 50/50 + 状态双分支
- 抢断结果按概率：success 50% / fail 50%（用户确认，非初稿 70/30）。
- 状态更新分两支（两端状态一致，下一事件不 snap）：
  - **success**：球权归防守者，防守者位置更新到 `(loose_x, loose_y)`（与 viewer 演绎"追到弹开点捡球"终态一致，下一事件从 loose 出发不 snap）。
  - **fail**：球权保留原持球者；**被铲者追到弹开点拿回**（pos 到 loose，与 viewer fail 演绎终态一致），防守者停在接触点。
- **为什么**：success 落 loose 点是"不 snap"的核心（Q5）；fail 让被铲者到 loose 拿回 + 防守者停接触点，是 viewer fail 演绎的终态（审阅确认两端一致，而非初稿"防守者归位"）。

### D7: 确定性用现有种子 RNG（带标签流归票据 06）
- Phase B 引擎随机仍走单一 `SeededRng`，同 seed → 同事件流（现有约束不变）。
- **为什么**：票据 06 的带标签流/定点数是引擎 AI 复杂化时的完整目标，现在引入反而扰动现有确定序列。

## Risks / Trade-offs

- **[Phase B 改变同 seed 事件流]** → 引擎逻辑变化必然改变事件序列；demo 重放随之变化，可接受。
- **[协议扩展向后兼容]** → 新字段可选；viewer 对缺失字段 fallback（`carrier_from` 缺失→被铲者原地带球；`loose` 缺失→`deflectPoint`）。

## Migration Plan

- 协议 v1 增量扩展：tackle 新增可选字段、`to`/`x2/y2` 转必填（protocol.js 校验 + spec 定稿）。旧事件流仍可解析。
- 引擎状态机：tackle 分支重写；`pos[]` 维护逻辑补 `loose`/`carrier_from`。
- viewer：`interpretTackle` 五段式。
- mock：tackle 样例补 `carrier_from`/`loose`，加 fail 样例（已有一条）。

## 移交 p3（2026-08-06）

- **Phase C（viewer 连续播放）** 已拆分为 `p3-continuous-playback`：含连续播放 specs/tasks/design，及两个前置事项（进球事件同刻、静默迭代后 carrier_from 过期）。本 change 只含 Phase B。
