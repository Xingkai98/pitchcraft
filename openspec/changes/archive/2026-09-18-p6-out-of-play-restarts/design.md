# Design: 出界重开体系——角球 + 界外球 + 头球（out-of-play-restarts）

> **归档对齐说明（2026-09-18，issue #81）**：本文是立项时的原始设计稿，其中出界触发与若干概率已被
> P31/P33 与实现期标定取代，归档时 `specs/*/spec.md` 已改写对齐现行代码：
> - **出界触发**：本文写"固定 3-5% roll"，现行是 `open_play_out_probability(pass_risk)` 涌现通道（P31）。
> - **底线归属**：本文正文的"传球出底线 → 门球"需按 `out_restart_for` 细分——越**对方**底线→门球、
>   越**己方**底线→角球（spec 已修正；原 delta 的写法是错的）。
> - **扑出越线**：本文写"~30%"，现行 `corner_roll < 90`（~90%）。
> - **头球射门 result**：本文写 "goal(~10%)/saved(~40%)/off_target(~50%)"，现行 15/30/55（对齐禁区内桶）。
> - **角球争顶 55/45**：现行基线 55/45 + P33 主场偏移（主队 58 / 客队 52）。
>
> 逐条差异见 `.scratch/notes/issue81-delta-drift-inventory.md`；`tasks.md` 的勾选状态不作为完成依据。

## Context

P6 首批完成门球 + 进球回中圈。用户 batch-grill 确认批次1 = 出界重开：出界判定 + 角球 + 界外球 + 头球。批次2 = 犯规 + 任意球 + 点球。

本 change 复用已建成的**高亮机制**（pass/shot）+ **松散球** + **GoalKick 高亮先例**（门球链路：从固定点开球高亮 → 落点松散球 → 拾取/争抢）。**注意：门球不走 DeadBall 状态机**（DeadBall 是进球→中圈 kickoff 专用），死球重开走"固定点开球高亮 + 松散球"路径（同 GoalKick），DeadBall 不扩展。

## Goals / Non-Goals

**Goals:**
- 出界判定：传球出边线 → 界外球（对方）；传球出底线 → 门球（对方门将）；防方解围出底线/出边线 → 角球/界外球（进攻方）；射门被扑出底线 → 角球（进攻方）。
- 角球：角旗区长角球 → 禁区 → 争抢 → 头球（解围/射门/摆渡，可进球）。
- 界外球：边线掷向附近队友（传球出边线对方掷 / 防方解围出边线进攻方掷）。
- 头球复用 shot/pass 高亮，不新增事件类型。

**Non-Goals（批次2/后续）:**
- 犯规判定 + 任意球 + 点球（批次2）。
- **普通传球出底线的触碰归属追踪**（球是否被防守方折射后出界）——简化一律门球。**例外：防方头球解围（detail=clearance）出底线 → 角球**——解围的最后触碰方明确（解围者本人），不属"不做触碰归属"范围。
- 越位。
- 防守人墙/任意球排墙。

## Decisions

### D1: 出界来源与重开类型（Q2 grill 确认）

| 出界情形 | 触发 | 重开 |
|---------|------|------|
| 射门打偏 → 底线 | result=off_target | 门球（已有） |
| 射门被扑出 → 底线 | result=saved + 扑出（未扑住）+ **越线（概率触发）** | 角球（进攻方） |
| 传球出边线 | pass 落点出边线（y<0 或 y>1） | 界外球（对方） |
| 传球出底线 | pass 落点出底线（x<0 或 x>1） | 门球（简化，不做触碰归属） |

**方向映射（home 攻左→右、away 攻右→左）**：**任何出底线传球都由对方门将开门球**（简化，不追踪触碰归属）——home 传球出 x>1（对方门线）或 x<0（己方底线异常）→ away 门将开门球；away 传球出 x<0（对方门线）或 x>1（己方底线异常）→ home 门将开门球。**不做"球出界侧门将"的区分**（该语义仅用于射门扑出底线角球——进攻方向确定时）。
**解围出底线例外**：防方头球解围（detail=clearance）落点出底线 → **角球（进攻方）**，不是门球——解围的最后触碰方明确是防守方（解围者本人），不受"普通传球出底线不做触碰归属"约束（见 Non-Goals 澄清）。

### D2: 出界判定实现（批次1 简化）

- **传球出界**：低概率（~3-5%）落点出界。引擎在**普通传球（emit_pass_highlight）**选落点时，掷 3-5% 让落点 x/y 超出 [0,1]（≤0.05 归一化）。**仅普通传球掷出界 roll**——重开球（角球发球/界外球掷球/门球开大脚）不出界，落点恒在界内。
- **出界走新 HighlightOutcome**（参照 GoalKick 先例）：新增 `HighlightOutcome::PassOutOfPlay { detail, out_pos, source }`。出界 pass 事件 **to=None**（落点是出界点，无接球者），带 detail=`out_sideline`/`out_goal_line`；坐标钳制 [0,1]。finalize 时据 **detail + source** 触发对应重开，**不设 carrier**：
  - `source=NormalPass`（普通传球）：出边线 → **界外球（对方）**；出底线 → **门球（对方门将）**。
  - `source=Clearance`（防方头球解围）：出边线 → **界外球（进攻方）**；出底线 → **角球（进攻方）**——解围最后触碰方明确是防守方，走角球而非门球。
- **扑出底线角球**：`emit_shot_highlight` 的 saved-rebound 分支，**先掷越线概率**（~30%），若越线则**弹开点改为未钳制**（球越过门线，home 攻 x>1 / away 攻 x<0）→ 新增 `HighlightOutcome::CornerAward`（角球）；否则维持现有松散球（rebound）。**角球触发源 = 扑出反弹越线（概率触发，非几何必然）**；按此源角球约 0.5-2 次/场（19 射门×30% saved×30% 扑出×30% 越线 ≈ 0.5-2 次），不设 6-10 次/场的高频目标。
  - **几何说明**：saved 射门目标 x=0.98/0.02（界内门线），deflect_point 弹开点钳制 [0,1]——仅靠几何无法越线，故用**概率触发越线**（越线时弹开点 = 门线外一点，如 home 攻 x=1.03 / away 攻 x=-0.03），确保角球可达。
  - **未钳制点仅引擎内部消费**：越线弹开点只用于确定角旗侧与触发角球，**所有事件字段坐标一律钳制 [0,1]**（corner 高亮起点=角旗、落点=禁区、发球者走位都在界内）——protocol.js 0-1 校验不受影响。
- 事件坐标：出界落点钳制 [0,1]，带 detail；viewer 球飞向边界（钳制到边缘）。

**为什么**：协议坐标 [0,1] 校验不破坏；出界视觉 = 球到边界；简化不追踪触碰归属（传球出底线一律门球）。

### D3: 角球机制（Q3 grill 确认：完整版）

角球从角旗区开出（**角旗区选择：按出底线点 x/y 就近取角**——home 攻扑出 x>1 → 右角 x=1；away 攻扑出 x<0 → 左角 x=0；防方解围出底线同理。y 就近取 0/1）：
0. **发球准备期（归属机制：新增轻量 `RestartPrep` 状态，非 DeadBall）**：角球触发（CornerAward 或防方解围出底线 PassOutOfPlay source=Clearance）后，发球者 = **攻方离角旗最近的外场球员**；进入 `RestartPrep { player, target=角旗, kind=Corner }`。**准备期 `st.ball_pos = 角旗`（球停在固定点等待发球，产 beat.ball 静止锚点）**——formation_target 以角旗为基准、发球高亮起点=角旗，无球瞬移。准备期 tick（发球者走位 + 攻防站位，见步骤 4），发球者到角旗（<1m）触发发球高亮。**准备期归属：RestartPrep 挂在 tick 主分支（dead_ball 之后、highlight 之前）**，同 DeadBall preparing 的走位模式。
1. **长角球发球**：pass 高亮（复用 GoalKick 开球高亮先例），**带 detail=`corner`**（viewer 据此识别这是角球发球，不靠起点推断），起点=角旗区（x=0/1, y=0/1），落点=禁区附近（x 贴近门线、y 球门范围）——**落点在发球高亮时刻选定**（准备期站位用队形目标，不预知精确落点），带高度（协议加 h 字段，见 D6，h>0）。
2. **落点松散球 + 双追逐**：落点无人持球 → 松散球；**攻防各 1 名追逐**——LooseBall 加 `battle: Option<(i32, i32)>`（**元组 = (攻方 chaser, 防方 chaser)，loose 启动时固定**，避免每 tick 重算 nearest 导致胜者身份漂移）；攻方 chaser = 攻方 nearest（LooseBall.chaser 沿用），防方 chaser = 防方 nearest（存 battle 元组第 2 位）。compute_movers 让两个 chaser 都 chase 落点（action=chase，复用 GoalKick 预判模式）。**battle 期间 advance_loose 移动攻方 chaser（现有逻辑），compute_movers 额外产防方 chaser 的 chase mover**；battle 结束后（无论胜负）回普通 LooseBall 路径。
3. **争抢结果**：攻方 chaser 达到落点拾取半径时，**就地 roll 55/45（攻/防）**（不在落点前 roll，避免"追到一半改判"）：
   - 攻方胜：**就地争抢结果分支**（攻方 chaser 即胜者，起点=落点，**carrier=攻方 chaser**）——**头球射门**（~55%）→ shot 高亮（subject=攻方 chaser，起点=争抢点，detail=header，h=0），结果 goal(~10%)/saved(~40%)/off_target(~50%)；**头球摆渡**（~30%）→ pass 高亮给队友（subject=攻方 chaser，普通 pass 无 detail，h=0）；**拿球组织**（~15%）→ main 恢复（carrier=攻方 chaser）。
   - 防方胜：**防方 chaser 移动到位**（到落点，拾取语义，同现有 LooseBall 拾取瞬移 `pos[chaser]=loose_pos`），**carrier=防方 chaser**，就地头球解围——**头球解围**（~70%）→ pass 高亮顶出禁区（subject=防方 chaser，起点=落点，detail=clearance，h=0）→ 落点松散球**重新争（普通松散球，非 battle）**；**解围出底线**（~20%）→ PassOutOfPlay(detail=out_goal_line, source=Clearance) → **角球（进攻方）**；**解围出边线**（~10%）→ PassOutOfPlay(detail=out_sideline, source=Clearance) → **界外球（进攻方）**。
   - 败者行为：roll 失败方就地停（画面呈现"没争到"，不再额外移动）。**防方胜后"松散球重新争"是普通单追逐拾取**（非角球 battle），避免角球递归无上限（连续角球期望 ~1.1 个，概率终止）。
4. **角球站位**：发球准备期（发球者走向角旗，球在角旗），攻方禁区包抄（nearest 几名向禁区/球门区预判，formation_target 覆盖）、防方回防（formation_target 自然覆盖 + 向禁区回收）。

**为什么**：完整呈现"角球 → 争抢 → 头球解围/射门/进球"；复用 shot/pass 高亮（头球=shot detail=header、解围=pass detail=clearance）；角球争抢扩展 LooseBall（battle 标记 + 双追逐 + 争抢结果分支），是**本 change 唯一的新机制**；解围出底线走 PassOutOfPlay(source=Clearance) 与普通传球出底线（source=NormalPass→门球）区分，避免规范矛盾。

### D4: 界外球机制（Q4 grill 确认：复用 pass）

- 传球出边线 → **对方掷界外球**（detail=out_sideline, source=NormalPass → 对方）；防方解围出边线 → **进攻方掷界外球**（source=Clearance）。
- **掷球者**：接球方离出界点最近的外场球员（**排除门将**，同 tackle/解围的"外场"语义，避免门将跑出禁区掷球）。
- **掷球者准备期（归属机制：RestartPrep）**：进入 `RestartPrep { player=掷球者, target=出界点, kind=ThrowIn }`。**准备期 `st.ball_pos = 出界点`（球停在边线等待掷球，产 beat.ball 静止锚点）**，掷球者走向出界点（边线），到点触发掷球高亮（同角球发球准备期，避免 viewer 瞬移）。
- **掷球**：pass 高亮（复用 GoalKick 开球先例），起点=出界点（边线），落点=掷球者附近队友（nearest_teammate），**receiver_x/y = 接球队友当前位置**（同普通 pass，viewer 让接球者从实位跑向落点，不瞬移），短传无高度（h=0，协议 h 字段见 D6）。
- 复用"固定点开球高亮 + 接球者持球"路径（同 GoalKick 但落点有人接）。

**为什么**：界外球 = 从边线短传重新组织，复用 pass 高亮 + 掷球者定位 + 准备期。

### D5: 统一机制（Q9 grill 确认）

- 所有死球重开（门球/角球/界外球）都走**固定点开球高亮 + 松散球**路径（同 GoalKick 先例），**不扩展 DeadBall 状态机**（DeadBall 仅进球→中圈 kickoff）。**`RestartPrep` 是独立轻量状态（非 DeadBall 扩展）**，只负责发球者/掷球者走位到固定点的准备期（角球/界外球专用，门球无需准备期——门将已在门线）。**RestartPrep 期间 `st.ball_pos = 固定点`（角旗/出界点），球停固定点等待发球，发球高亮起点=固定点 → 无球瞬移。** **创建 RestartPrep 时切换 possession**：角球 → possession=攻方；界外球 → possession=掷球方（对方/进攻方）；发球高亮 finalize 后持球方按 pass 的 to/落点确定。
- 所有球飞行都走 pass/shot 高亮；落点争抢都走松散球。
- 本 change 新增机制：出界判定（PassOutOfPlay/CornerAward 高亮结局）+ 角球双追逐 + 协议 h 字段。

### D6: 协议加 h（高度）字段

- 事件流加可选字段 `h`（归一化 0-1，球高度）——pass/shot 高亮带弧线高度，viewer 用球大小表示（FM 做法，P6 首批已实现）。
- **h 语义统一**（四份文档同一表述）：`h` 缺失（undefined）→ viewer 按飞行时长/距离默认插值（向后兼容，P6 首批现有行为）；`h=0` → 明确无高度（球不放大，如界外球掷球/头球解围/**头球摆渡**/头球射门/短传）；`h>0` → 有高度（球放大，如角球发球/门球开大脚/普通长传）。**头球类动作（头球射门 shot detail=header、头球解围 pass detail=clearance、头球摆渡）h=0**（头球是低高度动作，不放大）。
- **普通传球 h 分类阈值**：**短传（≤20m）h=0**；**中长传（>20m）h>0**（0.2-0.4，随距离增大）；**角球发球/门球开大脚 h>0（0.5-0.8）**（长弧线高球）。头球类恒 h=0。
- 术语统一：`h` 缺失时的 viewer 回退统一称"按飞行时长/距离默认插值"（design、event-stream-protocol spec、pitch-viewer spec、tasks 四份文档同一表述）。
- viewer 据 h 调球大小：半径 × (1 + h×1.5)，h∈[0,1] → 球放大 1.0-2.5 倍。**量纲**：协议 h 是 0-1 全范围；P6 首批实现的 h 是 0-0.2（飞行弧线），本 change 将引擎产出的 h 统一为 0-1 语义，viewer 公式不变（半径 ×(1+h×1.5) 适配 0-1）。

**为什么**：P6 首批已实现"球大小表示高度"，但协议无 h 字段、viewer 硬编码 0-0.2——补协议字段并统一 0-1 语义，让角球/界外球/头球能区分高度。

## Risks / Trade-offs

- **[角球双追逐 + 争抢结果]**: 角球是本 change 最大增量（扩展 LooseBall 双追逐 + 争抢结果分支 + 头球决策）。缓解：复用 shot/pass 高亮 + GoalKick 开球先例，只加争抢机制。
- **[出界频率]**: 传球出界 3-5% × ~130 pass/场 ≈ **界外球 ~4-6.5 次/场**；扑出反弹越线 → 角球 ~0.5-2 次/场（低频，真实）。画面中断增多但真实。
- **[头球进球率]**: ~10% 头球射门进球率（真实角球进球 2-4%），偏高但保证观众偶尔看到头球破门。实施时可调。

## Migration Plan

- 引擎：出界判定（PassOutOfPlay/CornerAward 高亮结局）+ 角球双追逐争抢 + 头球高亮产出（复用 shot/pass）+ 协议 h 字段。
- viewer：角球发球高亮 + 禁区争抢（双追逐）+ 头球演绎（头球射门=shot detail=header、解围=pass detail=clearance）+ 界外球掷球 + 出界视觉 + h 字段支持。
- 测试：引擎（出界判定/角球双追逐/头球解围/头球射门/界外球/h 字段）+ viewer（角球/头球/界外球/h 大小表示）。

## Open Questions

- 角球发球落点分布（禁区哪里）——实施时调参（近门柱/远门柱/禁区弧）。
- 头球射门/解围的具体概率（攻方 55/30/15、防方 70/20/10；头球射门 goal 10%/saved 40%/off 50%）——实施时可调。
- 传球出界频率（3-5%）——实施时按画面节奏调。
