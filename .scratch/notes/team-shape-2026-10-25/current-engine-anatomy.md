# pitchcraft 当前引擎解剖（机制改造前置参考）

> 只读产出，不改源码。树：`main` @ `1c5729d`（2026-10-17 合入 p143r-v4 后）。
> 口径：所有行号指当前树 `engine/src/lib.rs`（12440 行）、`engine/tests/realism.rs`（1708 行）。
> 标【观测】= 代码/文件里直接读到；【推断】= 由代码+常量算出的结论，未在本会话跑仿真验证。
> 数字纪律：每个数带出处或算式；无法自证的集中在 §8。

---

## B1 当前机制地图

### B1.0 一拍的骨架（决定所有频率量）

| 项 | 证据 | 说明 |
|---|---|---|
| tick = 1.0 s | `TICK_SECONDS` :606 | 仿真推进步长；`tick()` :3324 每拍调一次 |
| beat 每拍一条 | `beat_event` :3264；主路 `tick` :3380-3414 | 唯一例外：重开判定 tick 与进球后开球 tick 不产 beat（spec `match-engine:229`） |
| 开放局每拍走 | `advance_action_opportunity` :2318 → `execute_action_resolution` :2360 | **自然 deadline 是唯一决策节拍源**，无槽位/固定评估节拍 |
| movers 每拍重算 | `compute_mover_candidates` :3699 | 18 个调用点（主路 `beat_movers` :6432 / `beat_movers_main` :6535） |
| 位移上限 | :3830 `step = d.min(norm_step(speed*TICK_SECONDS))` | speed：RUN 4.0 :616 / CARRIER 5.0 :614 / GK 3.0 :618 |
| 到点冻结 | `DEAD_ZONE_METERS=2.0` :608；:3829 `if d < dead_zone { continue }` | **92.7% 的「拍×球员」位移恒为 0**（`beat-and-speed-limits.md` §2/§4，旧 main 实测）；这是队形指标≈目标形状的结构原因 |
| 归一化口径陷阱 | `norm_step` :902、`dist_norm` :907 | 米制只按 x 轴 105 折算 ⇒ 纯 y 方向「4m 预算」实测只有 `4×68/105=2.59m`，dead-zone 纯 y 只有 1.30m（`beat-and-speed-limits.md` §4 附注） |

### B1.1 `formation_target`（队形目标；p143r-v4 后已是"球相对块混合式"）

- **签名/出口**：`fn formation_target(st, id) -> (f64,f64)` :3544-3592。输出 x 被 `clamp01(tx2).clamp(0.04,0.9)`、y `clamp01`（:3591）。**门将不走本函数**（调用方 :3766 跳过 id 0/21）。
- **唯一生产调用点**：:3785（`compute_mover_candidates` 第三分支 else）。另两处是测试 :8499/:8501。
- **输入**：`st.lineup[id]`（静态 4-4-2 基准，:537-556）、`st.ball_pos`、`st.possession`、`st.transition`、`is_defender`（:3537，`home_defenders/away_defenders`）、`st.ticks_since_meaningful_action`；**零 RNG**。
- **三段公式**（【观测】逐项抄自 :3549-3589）：
  1. 旧式 `tx = base.x + SIDE_SHIFT_FACTOR*(ball.x−0.5) + attack_dir*press`（press=±`PRESS_UP_OFFSET`，transition 中己方反击 **×2**）；
  2. 防线额外 `push = |ball.x − own_goal| * DEFENSE_PUSH_FACTOR`，并**钳在 `[base.x, ball.x]`**（home；away 镜像）:3565-3569；
  3. 球相对块：`block_cx = center0 + FORM_TRACK_X*(ball.x−center0) + attack_dir*±FORM_CENTER_OFFSET`；`block_tx = block_cx + (base.x−center0)*FORM_SPREAD_X + ix`；`block_ty = 0.5 + (ball.y−0.5)*FORM_TRACK_Y + (base.y−0.5)*FORM_SPREAD_Y + iy`；最后 `tx2 = (1−FORM_MIX_X)*tx + FORM_MIX_X*block_tx`、`ty = (1−FORM_MIX_Y)*ty0 + FORM_MIX_Y*block_ty`（:3588-3589）。
  4. 个体抖动 `ix/iy = sin/cos(st.ticks_since_meaningful_action + id*37 相位) * FORM_INDIV`（:3582-3585）——**纯确定性正弦，非行为**。
- **频率**：每个非门将外场、每次产 beat 的拍（含高亮飞行/松散球/重开准备拍）都算一次；开放局约 1 Hz。
- **旧文档失效提醒**：`findings-final.md` §2 的「y 只有 `SIDE_SHIFT_FACTOR*0.6`，最大横向位移 1.2m」与 §4b「水平细线」描述的是 p143r-v4 **之前**的公式；当前 y 已有 `FORM_TRACK_Y=0.3`+`FORM_SPREAD_Y=1.3`+`FORM_INDIV=0.08` 三项。

### B1.2 `compute_mover_candidates`（movers 唯一生产者）

`fn compute_mover_candidates(st, rng, t, excluded) -> Vec<Mover>` :3699-3838【观测】：

| 段 | 行 | 行为 |
|---|---|---|
| ① transition close_down 选择 | 3705-3710 | 目标：`Tackle→st.ball_pos` / `SaveCaught→attacking_forward(:3677)`；执行者 `pick_close_down_players(1−tr.attacking, target, 2)` |
| ② 开放局逼抢选择 | 3711-3735 | `OPEN_PRESS_N>0` 且 `OPEN_PRESS_GATE` 放行（=1：球在防守方本方半场）→ 最近的 **1** 名防守外场，目标 = 持球者当前位置 |
| ③ 门球预判 | 3737-3749 | GoalKick 高亮期双方各 1 人跑落点，action=`chase` |
| ④ 角球 battle chaser | 3751-3754 | 防方 chaser 跑落点，action=`chase` |
| ⑤ 角球准备期 | 3756-3759 | `corner_setup_target` :3596（攻方禁区包抄/防方回防），action=`run` |
| ⑥ targets 第一遍 | 3763-3787 | 排除 `excluded`/carrier/sent_off/门将；优先级：close_down > anticipate > battle > corner_prep > **formation_target**。close_down 停点 = `close_down_stop_d`，`stop` 在 transition 用 `CLOSE_DOWN_STOP_DIST`（0.02≈2.1m）、开放局用 `OPEN_PRESS_STOP_DIST`（0.05≈5.25m）:3769 |
| ⑦ repulsion（目标层） | 3788-3806 | 同队 pair，米制 `same_team_dist_m < SAME_TEAM_MIN_DIST_M(2.2m)` → `separate_pair_m` 对推；**≤3 轮**；carrier 不参与（本就不在 targets） |
| ⑧ 产出 movers | 3807-3836 | 门将单独 M1b（见 B1.4）；其余取 targets；`d < dead_zone` 跳过；`step=min(d, norm_step(speed*TICK))`，`move_toward` |
| 出口约束 | 函数头 :3694-3698 | **只产候选、不写 `st.pos`**（P34 硬约束）；写回统一在 `commit_beat_positions` |

### B1.3 `close_down_stop_d` / `pick_close_down_players`

- `close_down_stop_d(from,target,stop)` :3626-3632：零 RNG 纯几何；沿 `from→target` 前进 `d−stop`（归一化欧氏），`d≤stop` 原样返回。停距语义：**不贴身、不进拾取半径**。
- `pick_close_down_players(st, defend_team, target, n)` :3635-3648：该队外场按**归一化欧氏距离²**排序取前 n；排除门将/carrier/罚下。**无身体朝向、无盯人对象、无换人惩罚**——这是"当前引擎完全没有盯人概念"的代码证据（对照 `plan.md` §2 C3）。

### B1.4 门将 M1b（`keeper_return`）

`:3813-3822` + `keeper_line_dist_m` :672-675：目标 x 由「球距本方门线」直线式给出 `d = max(2.0, −0.4632+0.2440*ball_line_m)`，y `= 0.5 + (ball.y−0.5)*GK_TRACK_Y(0.10)`；action 名沿用 `keeper_return`（改名会牵动断言，:3815-3816）。速度 `GK_SPEED_MS`、dead_zone 与其他人**共用**（:3822/:3829）。

### B1.5 carrier 决策（事件层）

| 环节 | 位置 | 输入/输出 | 频率 |
|---|---|---|---|
| 机会生命周期 | `advance_action_opportunity` :2318；`open_action_opportunity` :1873 | 开启/到期 → `build_action_plan` | 每 tick 推进 age，到期 = `action_deadline_for`:1856 |
| deadline 公式 | `compute_action_deadline` :1744 | `danger/pressure/escape_space ∈[0,1]`（`opportunity_geometry` :1832）→ `2 −4·danger −3·pressure +5·escape`，round 后钳 `[2,12]`（常量 :1238-1255） | 零 RNG；门将 +3 tick（`GK_DEADLINE_BONUS_TICKS` :1250），再减 liveness 压缩 |
| carrier 三段判定 | `evaluate_open_play_carrier_action` :2122-2191 | ① **硬门**：`gk_holding || nearest_defender_m ≤ OPEN_PLAY_PASS_PRESSURE_M` → 普通传球；② `open_play_shot_engage_hits`(:2196) → 采样射门目标距离（`sample_shot_target`）分三态：已在射程→进起脚窗口 / >`SHOT_PASS_ADVANCE_M`(40m)→向前传球 / 否则带球推进；②.5 停滞≥`LIVENESS_STAGE_2_TICKS`(4)且无压→出球；②.6 `CIRCULATION_PASS_P=0.15` 随机出球；③ 其余→继续带球（**返回 `None`，不承诺动作**） | 每次自然 deadline；下限 2 tick，`escape` 项可把它抬到 7 以内 |
| 防守竞争 | `evaluate_defensive_action` :2214 → `select_defensive_action` :6900 | 对最近防守者算 tackle/foul/contain/jockey 四 score 取最高（纯几何+冷却，零 RNG） | 与 carrier 同机会点，一次只选一个 |
| 射门唯一生产者 | `shot_window_plan` :4420 ← `build_action_plan(ShotWindow)` :4427 | `ShotWindow` 触发器；`shot_hazard_hits` :2099 = `1−exp(−exp(score)·1)`，`score = −4.0 + 2.5·(distance+angle+space−pressure−cooldown)`（:6716，常 :701-722）；命中 → `committed=true`、不可回溯 → `emit_shot_highlight` | 起脚窗口内每 tick 掷一次，窗口 `SHOT_WINDOW_TICKS=2` :705 |
| 射门推进 hazard | `open_play_shot_engage_hits` :2196 | 复用同一 score + `OPEN_PLAY_SHOT_ENGAGE_SHIFT = −4.15` :764 | 每个 deadline 一次（未进①时） |
| 带球 main | `carrier_move` :3463-3498 | `hold_pp=70−forward_intent_pp`；hold → 原地 ±1% 抖动；否则沿进攻 x +0.03（transition +0.05），再钳 `CARRIER_SPEED_MS*TICK`；**每 tick 消费 2–3 次 RNG**（:3477 roll + 分支 1–2 次） | 每 tick |
| 传球目标 | `carrier_pass_target` :2031 → `choose_pass_target` :2005 | 价值函数 `pass_score`（权重 :290-304：前向 .8/开阔 .5/长度 1/空间 1/在前方 .2/反乒乓 .8），零 RNG；`PASS_NO_GK` | 每次出球档 |

**关键常量现状**：`OPEN_PLAY_PASS_PRESSURE_M = 4.0`（:736）。旧笔记/`defense-layers.md` §3 的 **8.0 已过时**；8→4 的理由写在 :732-735（逼抢者停 ~5m，若仍 8m 则恒出球、射门推进档不可达）。这句同时是"出球门 ↔ 射门量"耦合的**现行**版本。

### B1.6 队形/逼抢相关常量（B2 的机制子集）

| 常量 | 值 | 行 | 用途 |
|---|---|---|---|
| `SIDE_SHIFT_FACTOR` | 0.06 | 801 | 旧式 y 随球平移（x 也被它挪用，:3550） |
| `DEFENSE_PUSH_FACTOR` | 0.12 | 803 | 防线随球前压 |
| `PRESS_UP_OFFSET` | 0.02 | 805 | 控球阶段压上；transition 内 ×2 |
| `TRANSITION_TICKS` | 4 | 807 | 攻防转换窗口 |
| `FORM_MIX_X / FORM_MIX_Y` | 0.5 / 0.7 | 3510 / 3512 | 旧式 vs 球相对块混合 |
| `FORM_TRACK_Y` | 0.3 | 3514 | 块心横向跟球 |
| `FORM_SPREAD_X / FORM_SPREAD_Y` | 0.8 / 1.3 | 3516 / 3518 | 块内纵/横铺开 |
| `FORM_CENTER_HOME / AWAY` | 0.358 / 0.642 | 3520-3521 | 块心（恰等于 4-4-2 基准均值，:540-545） |
| `FORM_TRACK_X` | 0.5 | 3523 | 块心随球纵向牵引 |
| `FORM_CENTER_OFFSET / FORM_ATTACK_SIGN` | 0.033 / 1.0 | 3525 / 3527 | 攻方压上/守方回收（镜像正确，见 B3 gap 推导） |
| `FORM_INDIV / FORM_PHASE_PERIOD_S / FORM_PHASE_ID_STEP` | 0.08 / 90.0 / 37.0 | 3530-3534 | 个体确定性正弦抖动 |
| `CLOSE_DOWN_STOP_DIST` | 0.02（≈2.1m） | 886 | transition close_down 停距 |
| `OPEN_PRESS_STOP_DIST` | 0.05（≈5.25m） | 893 | 开放局逼抢停距 |
| `OPEN_PRESS_N` | 1 | 895 | 逼抢人数 |
| `OPEN_PRESS_GATE` | 1 | 899 | 仅球在防守方本方半场 |

---

## B2 常量清单（走位/速度/压迫/决策）

### B2.1 速度、节拍、静区、间距

| 常量 | 值 | 行 | 用途 | 被谁锁 |
|---|---|---|---|---|
| `TICK_SECONDS` | 1.0 | 606 | 仿真/beat 步长 | spec `event-stream:28`、`match-engine:229`；`realism.rs` L2（用**符号**断言，见 B5 陷阱） |
| `DEAD_ZONE_METERS` | 2.0 | 608 | 到点冻结 | golden；`p23_sent_off_keeper…`:8976-8978 依赖其数值 |
| `CARRIER_SPEED_MS` / `RUN_SPEED_MS` / `GK_SPEED_MS` | 5.0 / 4.0 / 3.0 | 614/616/618 | 每拍位移上限 | `p5_approach_cap`:8542；L2 速度上界（`realism.rs:1218` 系列） |
| `PICKUP_RADIUS_METERS` | 0.5 | 610 | 松散球拾取 | 派生：门球落点避让 :3664 |
| `SAME_TEAM_MIN_DIST_M` | 2.2 | 814 | 同队端点分离目标 | spec `match-engine:567`；`p53_*` 全族 |
| `SAME_TEAM_SWEPT_MIN_M` | 2.14（−6cm） | 850 | 拍内扫掠目标 | spec `:587`；`p53_…between_anchors`:8685 |
| `SAME_TEAM_SWEPT_PUSH_CAP_M` | 6.6 | 879 | 拍内侧推上限 | — |
| `SAME_TEAM_SEPARATION_MAX_ROUNDS` | 12 | 884 | solver 轮数上限 | — |

### B2.2 决策节拍与 liveness

| 常量 | 值 | 行 | 备注 |
|---|---|---|---|
| `BASE_ACTION_DEADLINE_TICKS` / `MIN_` / `MAX_` | 2 / 2 / 12 | 1238 / 1247 / 1248 | 主 spec `match-engine:436` 仍写「[3,12]」——**与代码已分叉** |
| `GK_DEADLINE_BONUS_TICKS` | 3 | 1250 | 门将放宽 |
| `LIVENESS_STAGE_1/2/3_TICKS` | 2 / 4 / 7 | 947-949 | 主 spec `:444` 仍写 8/12/16——**分叉**；p143r-v4 delta 已写 2/4/7 |
| `LIVENESS_STAGE_FORWARD_PP / PASS_RISK / DEADLINE` | [12,28,55] / [.10,.25,.45] / [1,2,3] | 951/953/955 | 三处接入点 |
| `CIRCULATION_PASS_P` | 0.15 | 727 | ②.6 主动出球 |
| `OPEN_PLAY_SHOT_ENGAGE_SHIFT` | −4.15 | 764 | 射门推进 hazard 平移（p143r-v4 联合解） |

### B2.3 全部 19 个 `*_TICKS`（START-HERE §6.3 的清单在当前树复核）

`grep -cE '^\s*(pub )?const [A-Z0-9_]+_TICKS\b'` = **19**（本会话 grep 确认），逐条：

| # | 常量 | 值 | 行 | # | 常量 | 值 | 行 |
|---|---|---|---|---|---|---|---|
| 1 | `TACKLE_COOLDOWN_TICKS` | 4 | 385 | 11 | `TRANSITION_TICKS` | 4 | 807 |
| 2 | `CONTACT_PAIR_COOLDOWN_TICKS` | 6 | 389 | 12 | `LIVENESS_STAGE_1_TICKS` | 2 | 947 |
| 3 | `PRESSURE_STATE_HOLD_TICKS` | 8 | 512 | 13 | `LIVENESS_STAGE_2_TICKS` | 4 | 948 |
| 4 | `LOOSE_MAX_TICKS` | 2 | 612 | 14 | `LIVENESS_STAGE_3_TICKS` | 7 | 949 |
| 5 | `HOLD_MIN_TICKS` | 8 | 678 | 15 | `BASE_ACTION_DEADLINE_TICKS` | 2 | 1238 |
| 6 | `HOLD_MAX_TICKS` | 15 | 679 | 16 | `MIN_ACTION_DEADLINE_TICKS` | 2 | 1247 |
| 7 | `SHOT_DRIVE_MAX_TICKS` | 5 | 683 | 17 | `MAX_ACTION_DEADLINE_TICKS` | 12 | 1248 |
| 8 | `SHOT_WINDOW_TICKS` | 2 | 705 | 18 | `GK_DEADLINE_BONUS_TICKS` | 3 | 1250 |
| 9 | `SHOT_COOLDOWN_TICKS` | 8 | 712 | 19 | `FOUL_MIN_GAP_TICKS` | 11 | 2568 |
| 10 | `CORNER_SETUP_MIN_TICKS` | 8 | 797 | | | | |

**注意**：`HOLD_MIN_TICKS`/`HOLD_MAX_TICKS`（:678-679）与 `POSSESSION_HOLD_MIN/MAX`（:520-521）、`OFF_BALL_RUN_INTERVAL/DIST`（:523/525）在 grep 里**只有定义没有生产消费点**——槽位时代遗留（`p31_slot_layer_is_gone`:11679 只禁了另一批符号名，故它们还留着）。改机制时别把它们当活参数。

### B2.4 射门/传球/对抗常量（决策层）

| 常量 | 值 | 行 | 用途 |
|---|---|---|---|
| `BASE_SHOT_TENDENCY` / `SHOT_FACTOR_GAIN` | −4.0 / 2.5 | 701 / 703 | hazard 基线与增益 |
| `SHOT_PRESSURE_NEAR_M` / `SECOND_M` | 8.0 / 16.0 | 707 / 709 | pressure 因子尺度 |
| `SHOT_SPACE_MIN_M` / `MAX_M` | 2.0 / 8.0 | 714 / 716 | space 因子 |
| `SHOT_ROLL_SCALE` | 1000.0 | 718 | 千分位掷定 |
| `SHOT_WINDOW_TIGHT_M` / `FREE_M` | 4.0 / 8.0 | 720 / 722 | 窗口压迫分桶（观测） |
| `SHOT_PASS_ADVANCE_M` | 40.0 | 685 | 远段先向前传球 |
| `BOX_DIST_M` / `ARC_DIST_M` | 16.5 / 25.0 | 687 / 689 | 三桶边界 |
| `OPEN_PLAY_PASS_PRESSURE_M` | **4.0** | 736 | 出球硬门（见 B1.5） |
| `PASS_W_*` / `PASS_OPEN_CAP_M` / `PASS_NO_GK` / `PASS_SELECTION_ENABLED` | .8/.5/1/1/.2/.8 / 25.0 / true / true | 290-306 | 传球价值函数 |
| `INTERCEPT_D_TIGHT/MID_M`、`INTERCEPT_P_TIGHT/MID/FAR`、`LONG_PASS_M`、`VERY_LONG_PASS_M`、`INTERCEPT_P_CAP` | 6/12、7.5/4.5/2.0、22/35、60 | 330-342 | 拦截概率分档 |
| `PASS_RISK_*` / `LANDING_ERROR_*` / `OUT_CHANNEL_*` | :1011-1056 | | 出界涌现通道 |
| `TACKLE_DISTANCE_THRESHOLD_METERS` / `TACKLE_SUCCESS_RATE` / `TACKLE_EAGERNESS` / `TACKLE_GEOM_*` | 12.0 / 0.5 / 0.5 / :316-319 | 273/282/277 | 抢断资格与 sigmoid |
| `BASE_DEF_TACKLE` / `BASE_DEF_FOUL` | −0.86 / −0.19 | 469 / 502 | **p143r-v4 联合标定的体量旋钮** |
| `FOUL_PRESS_DIST_M` / `CARD_YELLOW_P` / `CARD_RED_P` | 8.0 / .13 / .0035 | 352/355/357 | 犯规/牌 |
| `CLINICAL_GOAL_PP_HOME/AWAY`、`BATTLE_ATTACK_WIN_HOME/AWAY` | 2/0、58/52 | 788-794 | 主场优势两条通道 |
| `SIDE_SHIFT_FACTOR` 等队形常量 | 见 B1.6 | 799-807 | |

**spec 锁**：`FORM_MIX_X=0.5 / MIX_Y=0.7 / SPREAD_X=0.8 / SPREAD_Y=1.3 / INDIV=0.08` 被 p143r-v4 delta 的 Scenario「弱化档参数」**逐值写死**（`openspec/changes/p143r-v4-four-layer-team-behavior/specs/match-engine/spec.md:23-24`）；`OPEN_PRESS_STOP_DIST≈5m`、`OPEN_PLAY_PASS_PRESSURE_M < 停距` 同 delta :31-35。

---

## B3 P38 八条判据的机制归因

### B3.0 口径（先把"量怎么算"钉死，再谈归因）

工具链：`criteria/eval-criteria.mjs`（求值）+ `viewer/match-metrics.js`（帧指标）+ `criteria/criteria-spec.json`（带）。

| 判据 | 算法（证据） | 口径后果 |
|---|---|---|
| `hd` 纵深 | `match-metrics.js:228` `quantileSpan(x_sorted)` = 非门将 10 人 x 的 **q10–q90**（米）；`eval-criteria.mjs:68-69` 对 `cutWindows`（300s 窗、步长 900s，`match-metrics.js:74-75`）逐窗算再平均；`rawBallOnly` 默认跳过外推点 | 剔门将；窗均；与 q 分位有关，与人数弱相关 |
| `spread` 紧凑度 | `match-metrics.js:232` 每人到**队形质心**的**二维**距离均值（含 y） | y 跨度直接进这个量 |
| `gap` 重心间距 | `match-metrics.js:269` 两队质心的**二维**距离 | 球权项在双方**同向**移动时会被抵消 |
| `latSd` 横向位移 sd | `eval-criteria.mjs:75-82`：**单个 120s 窗 [1800,1920]**，home id 1..10 各自 y 的 sd（米）→ 平均 | 只测一段固定比赛时间；只测主队；**不含任何行为标签** |
| `swarm` | `eval-criteria.mjs:84-90`：同窗同 10 人 y 序列的**两两相关**均值 | 同窗；只主队 |
| `fault` 断层 | `eval-criteria.mjs:103-119,134`：**整场**按队取 x 排序 → 每"名次槽"的**均值** `P[i]` → `max(P[i+1]−P[i])` | 先平均再差分 ⇒ 对球位跟踪不敏感，直接读静态模板 |
| `midBack` 各线均衡 | `eval-criteria.mjs:121-126`：整场每 slot 的 x-sd → `mean(sdX, home id 5-8) / mean(sdX, home id 1-4)` | **比值**口径，分母是后卫 |
| `shotsReg` 普通射门/场 | `eval-criteria.mjs:60-64,207-210`：`type==='shot' && detail!=='header'`，逐场按 90min 归一后平均；下限 5.5（`criteria-spec.json:92-99`） | 逐场归一；单边下界（真实 16.51 只作参照） |

真实中心值（`criteria-spec.json:3-12`）：hd 25.885 / spread 15.21 / gap 8.34 / latSd 10.515 / swarm 0.671 / fault 4.95 / midBack 1.06 / shotsReg 16.51（参照）。

### B3.1 逐条归因

**① `fault = 18.9`——公式+静态模板的**直接**后果，可精确复算【观测】**
基准 x（:540-545）：`0.14,0.18,0.18,0.20,0.40,0.40,0.42,0.42,0.62,0.62`。任一 slot 的整场均值为
`E[x] = 0.5·base + 0.5·(center0 + 0.8·(base−center0)) + 共同项 = 0.9·base + 0.1·0.358 + 共同项`，
故相邻排序槽差 = `0.9 × base 差`。最大基准差 = **0.20**（0.20→0.40 与 0.42→0.62 两处，两处都 0.20）：
`0.9 × 0.20 × 105 m = 18.9 m`。**与 lead 给的 18.9 完全吻合** ⇒ 这条判据现在测的几乎就是 4-4-2 模板的两条线间距；不涉及移动、不涉及行为。要动它只能动模板或 `FORM_MIX_X/FORM_SPREAD_X`。

**② `hd = 38.7`——公式直接后果【推断（同①的系数法）】**
`E[x]` 对 base 的系数同为 0.9（同①），故 q10–q90 ≈ `0.9 × (base q10–q90) + 球项`。上述 10 个 base.x 的 q10–q90 = `0.62 − 0.176 = 0.444`（按 `match-metrics.js:173-181` 的 (n−1)p 线性插值）⇒ `0.9 × 0.444 × 105 ≈ 42.0m`；球位牵引（`FORM_TRACK_X=0.5`）与压上/回收把它压到 38–39 量级（精确值需实跑复算）。**移动的贡献可忽略**：`beat-and-speed-limits.md` §2.2 实测"把指标算在目标位置上"只差 **+1.1%**（旧 main，同口径）；`§5` 的四个反事实（瞬移/速度×3/拍长 0.25s/2s）指标变动 **≤1.7%**。⇒ hd 是目标形状的函数，不是"追不上"。

**③ `spread = 20.7`——公式直接后果，且被 y 主导【推断】**
`spread` 是二维距离均值；`block_ty` 里 `(base.y−0.5)*FORM_SPREAD_Y(1.3)` 把基准 y 的 ±0.3 拉到 ±0.39 归一化
⇒ y 半宽 `0.39×68 ≈ 26.5m`。spread≈20.7 与"y 宽 > x 深"的 4-4-2 块一致。⇒ 调 `FORM_SPREAD_Y` 是这条判据的主杠杆，而它会同时打 `swarm`（全队同向缩放）。

**④ `gap = 18.9`——公式直接后果 + 一处"共同球项抵消"的口径后果【推断】**
块心差 `0.642−0.358 = 0.284` ⇒ x 向 `29.8m`。两点修正：① 防线前压项 `attack_dir*push` 在**攻守两侧反向**（home 后卫 +x、away 后卫 −x），把质心对拉近；② 两队共用同一 `ball` 项（`FORM_TRACK_X`、`FORM_TRACK_Y`）⇒ 在**gap 里同向抵消**，不会互相拉近也不会拉远。故 gap 的残差 = `块心差×105 − 防线项×0.4` 的量级，18.9 落在 29.8 与更小值之间需要实跑复算（本文件不宣称精确分解）。**要点**：gap 不是"球员行为"的函数，是"两个块心 + 防线钳位"的函数。

**⑤ `latSd ≈ 3.2`——很可能是"测量口径 + 确定性抖动"的后果，而不是横向行为【推断，建议复核】**
120s 窗内个体 y 的变化源只有三项：`(ball.y−0.5)*FORM_TRACK_Y*FORM_MIX_Y`（系数 `0.3×0.7=0.21`，全队同向）、
`iy`（系数 `0.7×0.08=0.056` 归一化 ⇒ **振幅 `0.056×68 = 3.81m`** 的正弦，周期 90s，相位随 id 错开）、
以及 dead-zone 对 y 的有效截断（纯 y 仅 1.30m）。纯正弦的 sd = 振幅/√2 = `3.81/1.414 ≈ 2.69m`；加球项与截断后落到 3 左右与 lead 读数同量级。
⇒ **当前 latSd 很可能主要由 `FORM_INDIV` 这一个"为了打破同步感"的确定性抖动撑起来**，而非职责/盯人/跑动。
判据组当初用 latSd 挡 exp4b（`criteria/README.md:117`），此路径会让"假横向"通过——建议加一条反证：把 `FORM_INDIV` 置 0 重测 latSd/swarm/直线度（预期 latSd 掉到 ~1 以内），或直接看轨迹图（正弦是原地摆动，不是跑动带）。

**⑥ `swarm`——口径后果 + 公式竞争项【推断】**
swarm 是"共同球项方差"与"个体项方差"的比：共同项 sd ≈ `0.21 × ball_y_sd`，个体项 sd ≈ 2.69m（上条）。
若 ball_y_sd ≈ 10m（旧 main 实测 9.9m，`findings-final.md:213`），共同项 sd≈2.1m，则相关 ≈ `2.1²/(2.1²+2.69²+…) ≈ 0.37`。
⇒ swarm 由 `FORM_TRACK_Y`（越大越 swarm）与 `FORM_INDIV`（越大越不 swarm）**直接**决定；它是唯一能同时看见"整队跟球"和"个体抖动"的量。

**⑦ `midBack`——公式 + 防线钳位的"比值口径"后果【推断】**
分子（中场 5-8）x-sd 来自块跟踪（对 `ball.x` 的系数约 `0.5×0.06+0.5×0.5 = 0.28`）；分母（后卫 1-4）
被 :3565-3569 的 `min(ball.x).max(base.x)` **钳住**——不后退、不越过球 ⇒ x-sd 被结构性压小。
⇒ `midBack > 1` 是钳位的产物，不是"中场更活跃"。带 `[0.84,1.28]`（`criteria-spec.json:84-89`）实际上在守"后卫不要也乱跑"。

**⑧ `shotsReg`——事件层，与队形公式只有间接通道【观测】**
`shotsReg` 由三件事相乘：① 能走到 tier② 的 deadline 比例 = `1 − P(最近防守者 ≤4m) − P(停滞≥4) − 0.15`；
② `open_play_shot_engage_hits`（score + `OPEN_PLAY_SHOT_ENGAGE_SHIFT=−4.15`）；③ 起脚窗口 2 tick 内的 hazard 提交率。
其中 `P(最近防守者≤4m)` **与队形/逼抢机制强耦合**（防守者停距 `OPEN_PRESS_STOP_DIST≈5.25m` 就在 4m 门外侧）。
⇒ 任何"把防守者拉近/拉远"或"改变球所在半场分布"的队形改动都会改这个量；这也是历史"压纵深→射门崩"的现行机制解释。
仓内现行锚：p143r-v4 delta 自记 **22.2/场**（`p143r-v4/specs/match-engine/spec.md:120`），判据下限 5.5。

### B3.2 一句话汇总

- **公式/模板的直接后果**：`fault`（可精确复算 18.9）、`hd`、`spread`、`gap`。
- **口径后果占主导**：`latSd`、`swarm`（120s 固定窗 + 确定性正弦 + 只测主队）、`midBack`（比值+后卫钳位）、`fault`（先平均再差分）。
- **事件层、与队形只有间接通道**：`shotsReg`（出球门 4m × engageShift × 窗口 hazard）。
- ⇒ 除 `shotsReg` 外，其余 7 条**全部**可以被"改公式/改模板"直接推动（这正是 exp1/2/4b 能买到几何判据的原因）；真正拦 hack 的仍是 `latSd`+`swarm`（`criteria/README.md:113-119`），而这两条现在有被 `FORM_INDIV` 部分"买通"的风险（B3.1⑤）。

---

## B4 注入点清单（additive：不推翻 formation 公式）

> 前提：`formation_target` 的取值公式不动。所有候选都**零 RNG**、沿用现有 `Mover` 结构。

### C1（首选）`compute_mover_candidates` 的 targets else 分支加"每球员指派层"

- **位置**：:3784-3786，`else { targets[id] = Some(formation_target(st,id)); }` 之后。
- **插法**：先把 22 个 `(target, action)` 收齐（或加一遍第二遍循环），再用新函数
  `assign_off_ball_duties(st) -> [(Duty, MaybeTarget); 22]` 覆写**部分**球员：
  压迫者 → `close_down_stop_d` 朝持球者；盯人者 → 被盯者位置 + 偏移；接应者 → 传球线空当；其余保持 `formation_target`。
- **movers 语义变化**：`to_x/to_y` 从"队形目标"变成"职责目标"；`action` 新增标签（B4 C3）。
  语义仍满足 spec（mover = 本拍终点、增量、只含移动球员）。
- **必须同步**：① `targets` 是 repulsion 的输入（:3791 循环）——职责目标一样会被同队推开，**不要**在指派层里预写"最终位置"；
  ② `excluded`/carrier/sent_off 的排除在 :3764-3766，指派层必须尊重（否则 `p23_sent_off_produces_no_mover` 红）；
  ③ 门将仍走 :3813 分支，不进指派层；④ 新目标要 `clamp01`（出界目标会让 :3830 步长方向荒谬）。
- **协议/spec 影响**：mover 字段集不变（spec `event-stream:28`），`action` 无枚举（viewer `protocol.js:39-51` 只校验 id/坐标）。**无 spec delta 需求**（除非新增 action 语义要写进 spec）。
- **会红**：`p5_formation_and_transition`:8426（统计 `"close_down"` 子串 + 防线前压断言）、`p5_press_up_and_gk_exempt`:8506（采 id5 的 mover 平均 x）、`p53_same_team_spacing_ge_2m`:8609 / `…between_anchors`:8685（若职责目标让队友更近）、`p5_repulsion_separates_overlap`:8907、`beat_movers_id_unique_on_tackle_push`:10661、`gm_canary_seeds`（`realism.rs:1506`，必然）、L1/L3 统计带（间接，非必然）。

### C2 `formation_target` 的调用点包一层（最便宜，签名不变）

- **位置**：:3785 一处（生产路径唯一）。`let t = formation_target(st, id); let t = duty_overlay(st, id, t);`
- **与 C1 的差别**：C1 能改 action、能改停距、能用 `close_down_stop_d`；C2 只能挪目标点。两者可叠加（C2 先、C1 后）。
- **会红**：同上但少一些——`p5_ball_side_shift`:8492 直接调 `formation_target`，**不会**因包层而红（好性质）。
- ⚠️ 若改成在 `formation_target` **内部**加第三项（而非调用点包层），则 `p5_ball_side_shift`、delta 的「弱化档参数」Scenario、以及 hd/spread/gap 三条全部直接受动——**不满足"不推翻公式"**，不推荐作为第一层。

### C3 `Mover.action` 字段承载职责标签

- **位置**：结构 `Mover` :60-68（字段已有）；赋值点 :3771/3775/3779/3783/3822/3834、:4628/:5168/:5469/:5893/:6420；序列化 :165。
- **可加性**：viewer 不读 `action`（全仓 grep：`viewer/*.js` 无 mover.action 消费），spec 只要求字段存在。
- **风险点**：`p5_formation_and_transition` 用**字符串包含**统计 `"close_down"`（:8444）——保留旧标签或同步改测试；
  `p23_sent_off_keeper…`:8989 与 `p5_press_up_and_gk_exempt`:8529 钉死 `"keeper_return"`（**不要改名**，M1b 在 :3815-3816 明确记过「改名会牵动既有测试的断言」）。
- **协议/spec**：新增标签属词汇扩展，不破字段；但若要让 viewer/下游按职责渲染，需要 spec delta 写清枚举（当前 spec 故意不枚举）。

### C4 `commit_beat_positions(_ex)` 加职责相关的分离策略

- **位置**：`commit_beat_positions_ex` :6358-6424（`frozen`/`extras`/`swept_light`/`frozen_segs` 已参数化）；薄封装 :6342。
- **可做的 additive 事**：把"压迫者/盯人者"放进 `swept_light`（免拍内扫掠）或给它们单独预算；**不能**改 `st.pos` 与 `last_emitted` 的一致性。
- **必须同步**：`beat_movers`(:6432) 与 `beat_movers_main`(:6535) 两条提交路径都走同一个 `_ex`；任何新参数要从这两处一起透传。
- **会红**：`p53_*` 全族、`p5_approach_cap`:8542（预算）、`beat_movers_id_unique_on_tackle_push`:10661、golden。**谨慎**：这是"事件与画面一致"的唯一入口，误改会造瞬移。

### C5 repulsion（目标层）改造

- **位置**：:3788-3806（≤3 轮、同队、2.2m）。它**只作用于同队**，故"盯人者贴着被盯者"（跨队）不受影响——这点对指派层有利。
- **可做的 additive 事**：对"被指派到同一区域"的同队 pair 提高阈值/增加轮数；或对压迫者豁免（压迫者本来就该离开队形块）。
- **风险**：轮数/阈值上调直接改变 `p53` 与 `p5_approach_cap`；且 `separate_same_team_m`(:6122) 有每人 `3×2.2m` 位移预算，超限会把重叠留到下一拍（不是死循环）。

### C6（防守指派层的"真"入口）`pick_close_down_players` + OPEN_PRESS 分支

- **位置**：:3635（选择器）/ :3711-3735（调用）。把"最近的 1 人"换成"按代价矩阵/拦截概率选 1–N 人 + 换人惩罚"即可（对应 `plan.md` C3/C4）。
- **比 C1 更小**：只影响 1 名防守者的目标，`close_down` 的 `close_down_stop_d` 语义和 action 都可保留 ⇒ `p5_formation_and_transition` 的 close_down 统计仍非零。
- **会红**：`p23_sent_off_not_picked_as_close_down`:9025（直接调 `pick_close_down_players`；保留函数签名/语义即可）、golden、P18 B4（coverShare 已 1.15× 真实，只会更高——`gates-spec.json:82-86` 方向：引擎已过高，**不允许再升**）。

**优先级建议**：C2/C1（同一层，先 C2 后 C1）→ C6（防守指派）→ C3（标签）→ C5 → C4。
C4 最后动，因为它动"位置写回"这条唯一一致入口。

---

## B5 约束清单（不能破坏的硬契约）

| # | 契约 | 位置 | 备注 |
|---|---|---|---|
| 1 | **beat = 1 Hz** | `openspec/specs/event-stream-protocol/spec.md:28`；`match-engine:229`（beat t 差 ∈{1.0,2.0}±0.001） | 改 `TICK_SECONDS` 必须同步 spec delta。⚠️ `realism.rs` 的 L2 用**符号** `TICK_SECONDS` 断言（START-HERE §6 陷阱 2），改值会自动"通过"而 spec 违约 |
| 2 | **mover 定义** | `event-stream:28`（字段集）、`:33`（静止者不在 movers、carrier 不在 movers）、`match-engine:567-603`（同队 2m/端到端分离/`st.pos==last_emitted`）、`event-stream:107`（归一化坐标） | 新增职责层必须仍满足：增量、坐标 [0,1]、同队间距、carrier 不进 movers |
| 3 | **golden 版本** | `MODEL_VERSION=9` :243；`golden_dir` :1355-1368（`other => panic!`）；`gm_canary_seeds` `realism.rs:1506`；`ACCEPT_GOLDEN` 机制 | bump 需：新建 `engine/tests/golden-vN/` + 加分派分支 + `ACCEPT_GOLDEN=1` 重基线；旧目录保留（START-HERE §6.4；版本预约 C1=10…C5=14） |
| 4 | **L1/L3 统计带** | `realism.rs` 见 §B6；窗口 `seeds 401..600`（:38-40）、主客 `401..1000`（:71-72） | 预注册窗口，**不得按结果重挑** |
| 5 | **P18 canary 产物** | `engine/tests/p18_behavior_gates.rs`（`target/p18-gates/`、`P18_SOURCE_COMMIT` :100、30 seed canary :40）；`verify.sh:105-114`；`gates-spec.json:5-22` | 生成时**工作树须干净**；产物 gitignored；`MODEL_VERSION`/行为变化后需重新生成 |
| 6 | **`engine/Cargo.toml` 零依赖** | `Cargo.toml`（无 `[dependencies]` 实体） | 新机制只能用 std |
| 7 | **确定性** | `match-engine:24`（同 seed 同流）、golden | 新层必须零 RNG 或明确记账 RNG 消费顺序 |
| 8 | **源码扫描守卫** | `p15_recorder_stays_out_of_the_decision_path`:7446（比赛逻辑**不得读** recorder 状态，`RECORDER_READS` 14 项 :7503）；`p31_slot_layer_is_gone`:11679（禁 12 个槽位符号）；`p31_liveness_section_never_emits_events`:12070；`p31_liveness_consumed_in_three_places`:12209；`p31_all_four_liveness_hooks_are_live`:12123 | 若新层要读 observation，必须把读取搬进 recorder；若要加 liveness 接入点，需同步改这些清单 |
| 9 | **主 spec 与实现已分叉** | `match-engine:436`（[3,12] tick）、`:444`（停滞 8/12/16 s）vs 代码 2 / 2-4-7 | p143r-v4 的 delta 尚未归档进主 spec；`validate --all` 本来就是红的（CLAUDE.md §1）。改机制要么等该 change 归档，要么自带 delta |
| 10 | **基准指纹哨兵** | `tools/benchmark-baseline.test.mjs`（`engineFingerprint`）；CLAUDE.md §6 | 改 `lib.rs`（哪怕注释）会让它红，需 `node tools/benchmark-baseline.mjs` 重生成（依赖 gitignored 真实数据） |
| 11 | **viewer 缓存版本** | CLAUDE.md §4 | 若动 `viewer/*.js`：`index.html` + 每条 import 的 `?v=` 全改 |
| 12 | **注释也会被打** | CLAUDE.md §6（#104 教训） | 注释里写被源码扫描的字面量（如 `#[cfg(test)]`）会让测试红 |

---

## B6 realism L1/L3 统计带（`engine/tests/realism.rs` 实测值）

口径：`l1_stats()` = `seeds 401..600` 200 场 × 5400 s（:38-40, :644-647）；`ha_stats()` = `401..1000` 600 场（:71-72）。

| 门 | 断言 | 行 |
|---|---|---|
| **L1 射门分布·禁区内** | goal ∈[0.10,0.20] / saved ∈[0.24,0.36] / off ∈[0.48,0.60] | 708 / 709 / 710 |
| **L1 射门分布·禁区弧** | goal ∈[0.03,0.12] / saved ∈[0.14,0.30] / off ∈[0.61,0.75] | 713 / 714 / 715 |
| **L1 射门分布·远射** | goal ∈[0.0,0.08] / saved ∈[0.04,0.18] / off ∈[0.78,0.92] | 718 / 719 / 720 |
| 禁区内起脚占比 | ∈[0.45,0.65]；>45m 射门 ==0 | 724 / 726 |
| **射门体量** | 普通射门/场 ∈**[14,29]**（样本 ≥800） | 742-746 / 699 |
| 头球 | 样本 ≥100；chi-sq < 13.82（15/30/55，df=2） | 755 / 757 |
| **抢断体量** | tackle/场 ∈**[24,50]**（样本 ≥400） | 789-793 / 775 |
| 抢断成功率 | 整体 ∈[0.42,0.58]；close ∈[0.42,0.58] | 798-802 / 809-813 |
| 抢断距离 | 事件内重算 dist > 12+0.05m 的 tackle ==0 | 847-851 |
| **shot/tackle 比** | ∈**[0.5,1.5]** | 873-877 |
| **角球** | 场均 ∈[1.0,7.0]；单场峰值 ≤15 | 886 / 916 |
| **界外球** | 场均 ∈**[15,60]**（P143r-v4 重标：真实 ~33-43） | 937-941 |
| **传球成功率** | ∈[0.82,0.90]（样本 ≥6万；失败 ≥3000） | 960-964 / 957-958 |
| 拦截占失败比 | ∈[0.55,0.90] | 967-971 |
| **主客进球** | 主/场 ∈[0.85,1.60]；主队转化率 > 客队；客/场 ≥0.30 | 1012-1016 / 1045-1050 / 1051-1055 |
| 主客样本 | gh≥60、ga≥40、主客射门各 ≥3000、按队和==总射门 | 1010-1011 / 1034 / 1038 |
| **犯规/牌** | foul/场 ∈[16,30]；黄 ∈[2.0,5.0]；红 ≤0.8；任意球短差 ≤0.5% | 1109 / 1111 / 1113 / 1117 |
| **L3 射正率** | (goal+saved)/shots ∈[0.28,0.39] | 1174 |
| **L3 转化率** | goal/shots ∈[0.08,0.14] | 1175 |
| **L3 禁区内进球占比** | ∈[0.80,0.91]（**罚球区矩形**口径，非板条） | 1183（口径见 :1166-1173） |
| L2（默认套件） | 比分==goal 计数、射门 y2 窗口、beat 间隙 {1,2}、速度上界、门将贴门线、t 范围、罚下零参与 | 1218-1310 |
| 5min 方向门 | `p31_frequency_5min_directional`：射门/出界/犯规机制在短场不得死 | 1614-1700 |
| report-only | `p13_side_effect_snapshot`:1191、`l3_home_away_goal_calibration`:1071（无 ratio 硬门） | — |

**现行读数（仓内出处，未在本会话复跑）**：p143r-v4 delta 自记 射门 **22.2**、抢断 **45.8**、ratio **0.484（差下界 3.15%，已知边际红）**、主 1.475 / 客 1.425（`p143r-v4/specs/match-engine/spec.md:110-114,120,124,142-145`）；`design.md` §D2 记录了 `BASE_DEF_TACKLE` 扫描表证明「ratio≥0.5」与「home>away」不可兼得。

---

## B7 候选机制排序（只据仓内证据）

判据：① 能否在 `formation_target` 不动的前提下单独调；② 打几门；③ 历史耦合风险（"射门量崩"）。

| 序 | 候选 | 插入点 | 预期动到 | 最大风险 |
|---|---|---|---|---|
| **1** | **每球员 OOP 职责/接应指派层**（压迫/盯人/接应三分支，按几何打分选人） | C2+C1（B4） | `latSd`↑、`swarm`↓、`gap`↓、`midBack` 变；`hd/spread` 微动 | **射门量**：压迫者靠近会抬高 `P(防守者≤4m)` → 出球档变多、tier② 变少（`defense-layers.md` §3 的机制）⇒ 用 `OPEN_PLAY_SHOT_ENGAGE_SHIFT` 作独立补偿（`tradeoff-breaking.md` §3 实测该乘子与出球门近似可加，:`325-331`）。次要：P18 B4 `coverShare` 已 1.15× 真实且判据只许降（`gates-spec.json:82-86`） |
| **2** | **防守逼抢改为"按 p_ij/代价矩阵选 1–N 人 + 换人惩罚"** | C6（`pick_close_down_players`/OPEN_PRESS 分支） | P18 A1/A2（首次转绿路径，`plan.md` C4）；`gap`；`shotsReg` | 同上（射门档）；另一条风险：`OPEN_PRESS_GATE` 已是折中（:896-899），放宽会拉平防线（v3 副作用，:897-898 明写） |
| **3** | **接应/传球线指派**（给持球者造 2 条可选线路） | C1 的 support 分支 +（可选）复用到 `choose_pass_target` | `hd/gap` 间接、`shotsReg`↑（更多推进机会）、L1 传球成功率 | 传球成功率带 [0.82,0.90] 两侧都窄；`p31/32` 拦截自洽门对 RNG 顺序敏感 |
| **4** | **pitch-control 式 OOP 位置评分**（替换 `formation_target` 的站位项） | 不能在调用点包层（要换"该站哪"），需改公式 ⇒ 与 B4 前提冲突 | hd/spread/gap 全动；P18 A1/A2 | **最大**：`findings-final.md` §4 记 5 道 L1 门全红、射门跌 93%（15.8→1.8 量级）；且 `plan.md` §2 的 C4 明确要配"C2/C3 先解耦"。仅作第二期 |
| **5** | **运动学层（加速度/转向限制，替代 `step=min(d,speed)`）** | :3830 + `carrier_move` :3494 | **不动** hd/spread/gap（`beat-and-speed-limits.md` §5：瞬移/速度×3/拍长变化 ≤1.7%）；动轨迹形态/P18 A2 | golden + L2 速度上界 + `p5_approach_cap`；若同时改 `TICK_SECONDS` 则违约 spec（B5#1）。**对 P38 八条基本无用**——它是观感层，不是判据层 |
| **6** | **二次进攻链（补射/被扑后二次起脚）** | 事件层（`emit_shot_highlight` 结局分支） | `shotsReg` 可直接向真实 16.5 收敛（`criteria/README.md:54-63` 明写引擎"设计上"缺这条）；L1 射门体量带 | 进球同步上涨（`tradeoff-breaking.md` §0：射门↔进球通过固定转化率耦合）；P18 C1；golden；属 C5 范围 |

**排序理由（仓内证据）**：
1. 只有 #1/#2 能在**不改公式、不改事件类型**的前提下新增"个体横向自由度"——这正是 `findings-final.md` §7.4 给出的目标（三实验结论：整队跟球=伪个体性、等间距=只重排、远端内收=方向对力度不够）。
2. #3 是唯一可能让 `shotsReg` **上升**的队形侧改动，与"历史耦合"同向而非对抗。
3. #4 有最强的负结果先例（射门崩），且违反 B4 的 additiv 前提；#5 被实测证明对判据无效；#6 改事件层、成本最高。

**"射门量崩"这条历史耦合的现行表述**（写进任何新机制的验收）：
- 机制：`evaluate_open_play_carrier_action` 的**第一道硬门**是 `nearest_defender_m ≤ 4.0m`（:2136/:2141），过了这道门就没有 tier②、没有射门推进。
- 证据：只改这一行常量 8.0→3.0，射门 7.2→11.4（`defense-layers.md` §3，旧 main）；反向"队形压紧→防守者变近"则射门崩（exp4b 26.4/0.56，`defense-layers.md` §4）。
- 现行护栏：P38 `shotsReg ≥ 5.5`（单边）、L1 `[14,29]`、L1 ratio `[0.5,1.5]`；p143r-v4 的联合解已把 ratio 压到 0.484。

---

## 8. 本仓内不可自证 / 待基线验证清单

1. **lead 提供的当前八条判据读数**（hd 38.7 / spread 20.7 / gap 18.9 / latSd ~3.2 / swarm / fault / midBack / shotsReg）：本会话未跑 wasm 评测器，**不可自证**；本文对它们的归因用"公式系数法"，其中 `fault=18.9` 与算式 `0.9×0.20×105` **精确吻合**，可视为强佐证。
2. `p143r-v4` 的 22.2/45.8/0.484/1.475/1.425：出自仓内 change 文档（自证到文档，未在本会话复跑）。
3. `plan.md` 的 "pitch control 1.1 ms/帧（Numba 实测）"：外部/上游读数，仓内不可复算。
4. L1 带的真实侧锚（StatsBomb n=170、Metrica 2 场 16.51）：带值与出处写在 `realism.rs` / `criteria/README.md`，但原始数据在仓外或被 gitignore。
5. `beat-and-speed-limits.md` 的全部读数：旧 main（`fb2e557` 内容）实测；**p143r-v4 改了 formation 公式后未重测**，本文只用其"移动不是队形成因"的**机制结论**，不搬具体值当现状。
6. `FORM_INDIV` 撑起 `latSd`（B3.1⑤）：【推断】，需一条反证实验（`FORM_INDIV=0` 重测 latSd/swarm）才能定为观测。

---

## 附：本次精读的高价值入口（给下一位实现者）

- 队形/跑位：:3500-3838（`FORMATION` 常量块 + `formation_target` + `compute_mover_candidates`）
- 位移提交/分离：:6108-6179（`separate_same_team_m`）、:6325-6548（`commit_beat_positions*` / `beat_movers*`）
- carrier 决策：:1852-1910（deadline）、:2044-2202（三段判定 + 两个 hazard）、:4374-4466（起脚窗口）
- 防守决策：:2204-2314（打分/结算）、:6763-7000（四 score + 资格）
- tick 主循环：:3320-3415；主 beat：:3440-3498
- 判据口径：`openspec/changes/p38-formation-realism/notes/criteria/{README.md,eval-criteria.mjs,criteria-spec.json}`；`viewer/match-metrics.js`
