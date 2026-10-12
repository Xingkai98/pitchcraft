# Tasks: 四层球队行为整合落地（P143r-v4）

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/match-engine/spec.md`（delta 格式）
- [x] 1.2 手工核对格式（`npx openspec` 本环境不可用，exit 216）——逐条对照
      `openspec/changes/p143r-v2-role-based-offball/specs/match-engine/spec.md`

## 2. 干净源码实现（`engine/src/lib.rs`，手写非生成器输出）

- [x] 2.1 移动 v3：`formation_target` 尾部换球相对块公式（命名常量 `FORM_*`）+ 个体抖动
- [x] 2.2 防守 def：`compute_mover_candidates` 加开放局逼抢分支（`OPEN_PRESS_*`）+
      `close_down_stop_d`（停距可变）；`OPEN_PLAY_PASS_PRESSURE_M 8→4`
- [x] 2.3 密度 vol：`BASE_ACTION_DEADLINE_TICKS 7→2` / `MIN 3→2` /
      `LIVENESS_STAGE_* 8/12/16→2/4/7` / `SHOT_FIRST`（停滞移到射门推进档之后）/ `CIRCULATION_PASS_P=0.15`
- [x] 2.4 事件 evt：`carrier_pass_target` → 价值函数（`pass_score`/`pass_space_ahead`/`choose_pass_target`）
      + `MatchState.last_pass_pair`（反乒乓）；对抗成败几何 sigmoid（`TACKLE_GEOM_*`）
- [x] 2.5 联合常数：`BASE_DEF_TACKLE −0.65→−0.86`、`BASE_DEF_FOUL −0.06→−0.19`、
      `OPEN_PLAY_SHOT_ENGAGE_SHIFT −3.4→−4.15`
- [x] 2.6 去掉生成器死项（`0.0 *`）/占位注释；删死函数 `close_down_stop`（被 `close_down_stop_d` 取代）
- [x] 2.7 `MODEL_VERSION 7→8` + `golden_dir()` 加 `8 => "tests/golden-v8"`

## 2b. 爆炸半径（改事件流 → 既有测试红，逐条处置）

- [x] 2b.1 `p31_liveness_profile_three_stages_monotone`：常数断言 8/12/16→2/4/7（同一判据，新值）
- [x] 2b.2 `p28_action_deadline_formula`：BASE==MIN=2 后危险/压迫压缩被地板吃掉 → 断言改「≤」+
      上界改 `BASE+ESCAPE_BONUS`（附录：为什么 MAX 不再可达）
- [x] 2b.3 `p28_action_opportunity_is_live`：`res_jockey` 0→>0（`OPEN_PLAY_PASS_PRESSURE_M` 4m 的
      预设后果，注释已预言；改「结构性不可达」断言为「可达」）
- [x] 2b.4 `v2_highlight_gate_frequency`：band [300,500]→[600,1400]（真实锚 ~860-1060）
- [x] 2b.5 `truncated_stream_produces_a_full_time_gap_by_design`：seed 470→562（同判据重扫）
- [x] 2b.6 `every_episode_and_restart_object_has_event_indexes_...`：seed 集重钉
      （[11,42,154,211,223,246,288,353,393]，形态①②③ 5/2/2；换样本不换判据）
- [x] 2b.7 golden-v8 生成（`ACCEPT_GOLDEN=1`）
- [x] 2b.8 **已修**：`p53_same_team_spacing_holds_between_anchors`——**根因订正**（原 design §D4
      说「P34 carrier 拍内扫掠豁免」，**实测机制不是它**）：违规点在**拍起点**（`sk_raw<0`），
      是 `finalize_highlight` 把参与者位置**直接写 `pos`**（绕过同队分离），而队友在球飞行期
      跑进了接球点 → 下一拍 carrier 的**起点**已 <2m（起点不可动 ⇒ 整拍残留）。
      修：`PassCaught` 结算处用既有 `separate_target_point` 把接球者从**当前**队友位置推开。
      验证：p53 绿（seed 8 最坏 1.765m→2.133m）**且 L1 仍 4/5**（未破射门几何）。

## 2c. 爆炸半径（全量 `cargo test --tests --no-fail-fast`：**16 条红，收尾已逐条处置**）

改事件流（密度 ~2.1×）会让**所有 pinned-seed / 口径快照**类测试失效——与 p143r-v2 的 3 条同族，
但面更大（16 条）。**逐条已归类 + 留证**（详见 `design.md` §D4 与落盘报告 §7）：

- [x] 2c.1 **真不变量红（已修）**：
  - `realism::l2_cross_event_invariants`：**根因订正**（原说「y2 越界」，**实测是 `x2` 越门线**）：
    `separate_target_point` 把射门终点沿 x 推离门线（0.02→0.0192/0.0194）以求 2.2m 分离余量
    ——但那对已 >2.0m detector 阈值。⚠️ **两条射门路径都会出**（seed 1 是 header、seed 42 是
    open-play saved，**非「唯一=header」**）。修：两条射门路径分离后都把 x 夹回门线
    （只保留 y 方向分离）。验证：seeds 1..120 无违例。
  - `p53_...between_anchors`（见 §2b.8）。
- [x] 2c.2 **seed 覆盖门（重钉 seed，判据不变）**——6 条全修：
  `p15::gap_is_a_classified_outcome...`（470@120→**562@120**，第二例 1228@400→**348@400**）、
  `p15::every_gap_on_the_canary_streams...`（同步）、
  `p15::event_indexes_are_non_empty...`（三形态改由**独立** `TRUNCATION_FORM_SEEDS=[11,225,42]` 覆盖，
  与 CANARY 解耦）、`p15::contest_reasons...`（CONTEST_SEEDS 补 `match_end` seed 7）、
  `p17b::restart_window_falls_back...`（补 fallback 窗口 seed 225/278）、
  `realism::l2_sent_off_kickoff_seeds`（29/35/59/84→**64/121/168/203**，同判据「红牌先于进球」）。
  （`observation.rs` 的两条同类门亦按新流复扫——见 §2b.5/2b.6。）
- [x] 2c.3 **口径 / 体量快照（密度层改了基数 → 按新基数重标定）**——8 条已处置（除 §2d 裁决项）：
  `p16::state_snapshot_frozen...`（`len/4`→`len/3`，实测 28.5%）、
  `p17b::loose_census_...`（段数带 `[800,1100]`→`[1500,2100]`=1801；`both` 占比带 `[.45,.68]`→`[.33,.52]`=42.3%）、
  `p124::defensive_intents_are_sparse...`（`len/5`→`len/4`，1106）、
  `p124::window_features_are_mechanically_tied_to_shots`（`0.85`→`0.80`，实测 0.817）、
  `p124::counter_proof_...`（**引擎版本重锚** 0.855→0.764，见 §2d）。

## 2d. ⚠️ 裁决待定（**用户级动作，本 change 不自改**）

四层移动层改变了 `forward_m/s` 的**形态**，使两条**P16 研究裁决**在新引擎上不再成立：

| 断言 | P16 旧值/带 | v4 实测 | 含义 |
|---|---|---|---|
| build_up vs progression（时长归一 `forward_m/s`） | `\|AUC−0.5\|≤0.06` | **0.382** | 「空间量**能**分开这两档」——**推翻** P16 裁决 |
| 净化四臂 | 全在 `[0.44,0.56]` | 0.388/0.437/0.437/0.500 | 同上 |

**这些是版本锚点漂移还是改判？** 前者（`final_third` 仍可分、探针完整性）→ **按新引擎重锚**（已做）；
后者（「两档分不分得开」）→ **推翻裁决，改判是用户级动作**，本 change **不自行改**。

- [x] 2d.1 涉及测试**只记录 v4 读数 + 显式注释「裁决待定」**（`p16::phaseability_verdict...` ②、
      `p124::gate_rerun...` ②、`p124::purification_records_the_v4_verdict_pending_review` ①）——**绝不静默放宽**
- [ ] 2d.2 **待用户拍板**：新裁决（「空间量能分开 build_up/progression」）是否成立、是否另立 change 处理

## 3. 验证（权威门 + 视觉）

- [x] 3.1 `cargo test --test realism --release -- --ignored l1_` → **4/5**（红 = `shot/tackle ratio`
      0.484→**0.479**，收尾 p53/l2 修复后微移；**用户已拍板接受**，保主场优势）
- [x] 3.2 `cargo test --tests --no-fail-fast` → 收尾后**全绿**（除 §2d 裁决项以「记录+待定」标注）
- [x] 3.3 视觉：`trajectory.mjs` + `contact-sheet.mjs`（用户尺度 seed42/5min）**已 Read 图**
- [x] 3.4 `viewer-match.mjs` 5min seed42：**传球 45 / 抢断 2 / 犯规 2 / 射门 4**
- [x] 3.5 新 wasm 放 `/tmp/p143r-v3/viewer/engine-v4.wasm`（sha16 `c3dafc3f0ee860ac`；**P2-3 订正**：
      原记 `b4d1d607` 非 HEAD 构建，此为 HEAD 重建；流哈希 `02f03ce1583ce6f4`，seed42/5min 仍 45/2/2/4）

## 4. 审阅闭环（强制）

- [ ] 4.1 起独立审阅（引擎改动）——**本 change 交付后由主 session 安排**
- [ ] 4.2 修复 → 再审 → 直到放行

## 5. 记录

- [x] 5.1 `.scratch/notes/p143r-v4-landing-2026-10-07.md`（四层读数 + 硬前沿证据 + 已知红 + 决策项）
- [ ] 5.2 合入后：重生成 `viewer/data/benchmark-baseline.json`（`engineFingerprint` 哨兵，
      需真实 tracking 数据，见 design §D8.3）
- [ ] 5.3 **决策项上报**：`ratio ≥0.5` 与 `home>away` 二选一（**用户拍板**，见 design §D2）
