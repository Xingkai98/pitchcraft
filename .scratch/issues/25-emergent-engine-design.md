# 25 · 事件生成因果倒置重构（涌现驱动）设计草稿

- Type: design（grill 起点，尚未定稿）
- Status: draft
- Created: 2026-09-13
- 关联: issue #25；依赖 issue #53（同队间距，等本重构）；#36（标定，等本重构）

## 已拍板的方向（用户 2026-09-13）

1. **频率保证走 C 路**（离线校准 + 运行时涌现 + 非事件型护栏）。否决 A（运行时软配额=隐性配额）、B（纯涌现，当前模型会事件塌缩）。
2. **比赛时长 = 真实物理时间**。现在只调 5 分钟（真实 5 分钟），其它时长再说。废掉 `HIGHLIGHTS_PER_MATCH=24` 的「压缩观感」目标。

## 核心洞见（codex 评审）

槽位层不只管「事件配额」，还管「比赛节拍调度」。删它前必须先定义「持球行动机会（Possession Action Opportunity）」——每个持球段在「行动到期点」评估一次「带球/传球/射门/抢断/犯规」，而不是「事件类型配额」。

## 分 4 阶段

### 阶段 0：定义新合同（不写实现代码，先定设计）

- 开放比赛状态机：哪些状态属于开放比赛；哪些行动可互相打断；谁负责推进、谁负责产生高亮；`finalize_highlight` 对每种后继的责任。
- RNG 版本：`model_version = v1_slot | v2_emergent`。确定性 = (seed, model_version, config) 可复现，**不承诺 v1/v2 事件流对齐**。
- golden 策略：保留 v1 基线，v2 用新基线目录，不 `ACCEPT_GOLDEN` 覆盖。

### 阶段 1：出界编码 + 协议迁移

- 双坐标语义：`x2/y2` 保留场内合法投影（viewer 渲染用）；新增显式 `out` 标志 + `out_side`（goal_line/sideline）+ 真实越界终点/越界量。
- 内部 `HighlightOutcome::PassOutOfPlay` 不 clamp（飞行用真实终点）。
- detector 改读显式 out 字段（P21 的 detail 治标可以简化）。
- 验收：不改变出界触发概率、不改变重开归属、不改变 RNG 消费顺序；viewer 不瞬移；旧统计摘要只允许协议字段变化、不允许事件数量变化。

### 阶段 2：射门/抢断改行动机会驱动

- 射门：`evaluate_shot_opportunity` 与 `emit_shot_highlight` 分开；「到射程」是提高 hazard 的条件，不是直接触发；加射门 cooldown、防守压力、角度、更优传球目标。
- 抢断/犯规竞争：贴身状态每个行动机会只做一次防守动作选择（tackle/foul/contain/jockey）；`same_pair` 补丁升级成显式 `tackle_cooldown`/`last_contact_pair`。
- 此阶段保留槽位层作 fallback，但槽位不再直接指定事件类型。

### 阶段 3：删槽位层 + C 路护栏

- 删 `HIGHLIGHTS_PER_MATCH`/`roll_highlight_slot`/`slot_clock`/`slot_interval`/`emit_pass_out_play_slot`。
- 引入行动 deadline + liveness guard（非事件型：前插倾向↑/传球风险↑/行动 deadline↓）。
- 离线校准参数（一批 seed 上调，统计落进「每 5 分钟」带）。
- 新统计校准测试 + v2 golden 基线。

## 待 grill 的开放问题（未定）

1. 「持球行动机会」的具体模型：行动 deadline 怎么算（按持球时长？按位置？按压力？）。
2. 射门 hazard 打分公式的初始形状（base_tendency + distance + angle + space - pressure - cooldown）。
3. L1 统计带从「每 90 分钟」改成「每 5 分钟」的口径怎么定（真实 5 分钟射门/角球/犯规参考值哪来）。
4. 护栏的触发阈值与动作（停滞多久算停滞、先改哪个状态参数）。
5. 协议迁移的字段命名（`out_side` vs `out_reason`，越界量要不要 `overshoot`）。

## Next

grill 敲定上述开放问题 → 立 OpenSpec change（阶段 0/1 先做）。
