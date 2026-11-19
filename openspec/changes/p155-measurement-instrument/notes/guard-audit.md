# 守卫分类与场景夹具审计（P155 / B 工作流）

日期：2026-11-19
范围：`engine/src/lib.rs` 的 `#[cfg(test)]` 场景守卫（p53/p31/p6/p32 等）、
`engine/tests/{realism,p15_behavior_observation,p16_spatial_features,p17b_diagnosis_report,
p18_behavior_gates,p124_intent_observations}.rs` 的研究/赛况门。
**本 change 不改任何门**（spec 要求）；本文只给分类与替代夹具建议。

## 0. 分类规则

1. **真不变量**：与「比赛行为长什么样」无关，任何实现都必须成立——确定性、坐标有限、
   身份合法、事件/状态对账、球权一致、纯函数契约。保留硬门。
2. **契约型场景守卫**：契约本身是真不变量（同队间距、不死锁、角球双追、拦截概率自洽），
   但**触发方式**依赖固定 seed / 单条事件链 / 「第一个找到的样例」。契约保留，
   脆弱夹具可替换为「显式构造场景 + 条件断言 + 多 seed 置信范围」。
3. **统计/记录门**：固定 seed 覆盖、历史读数、分布/AUC 阈值。可重扫/重钉，但**换样本不换判据**；
   不得因候选变红就删除。

> ⚠️ 分类是**审计判断**，不是引擎行为。不要把「契约型」读成「可以放宽」——三类都保留，
> 只是触发方式与证据形态不同。

## 1. 真不变量（建议原样保留硬门）

| 守卫 | 位置 | 守什么 | 备注 |
|---|---|---|---|
| `l2_cross_event_invariants` | `realism.rs:1350` | 比分==goal 计数、射门落点、beat 间隙、最大间隙、速度上界、门将位置、事件 t 范围、罚下零参与、开球非自传 | 300 seed；任意 seed 成立 |
| `l2_pass_fill_constant_matches_engine_tick` | `realism.rs:1330` | 填拍时长与引擎 `TICK_SECONDS` 同步；容差覆盖量化硬上界 | 拍频改动的绊线 |
| `plain_and_opt_in_paths_agree_byte_for_byte`、`sidecar_is_deterministic...`、`recorder_on_and_off_reproduce_the_golden_canary_stream` | `p15_behavior_observation.rs:195/227/290` | 观察 sidecar 不改变正式流、确定性 | 真不变量 |
| `state_snapshots_are_per_tick_and_bit_identical`、`state_snapshot_positions_match_the_beat_projection_bit_for_bit`、`formal_path_produces_no_snapshots_and_is_byte_identical` | `p16_spatial_features.rs:361/445/548` | 快照逐位一致、正式路径零 sidecar | 真不变量 |
| `formal_path_is_byte_identical_and_produces_no_observations` | `p17b_diagnosis_report.rs:153` | 正式路径不受 sidecar 影响 | 真不变量 |
| `intent_export_never_enters_the_formal_path` | `p124_intent_observations.rs:506` | 意图导出不进正式流 | 真不变量 |
| `p53_separate_pair_*`（x/y 轴、米制方向、重合退化、clamp、跨队） | `lib.rs:9279–9439` | 分离 solver 的纯函数契约 | 真不变量/单元契约；建议保留 |
| `p32_interception_roll_width_quantizes_by_ceil` | `lib.rs:12065` | `ceil` 量化在全部档位/边界的精确值 | 真不变量/单元契约 |
| `p31_natural_deadline_is_deterministic` | `lib.rs:10632` | 同几何同 seed 同计划 | 真不变量 |
| `probe_rejects_non_finite_and_never_hides_skips` | `p124:227` | 探针不吞非有限值/不隐藏 skip | 真不变量 |
| `ball_and_main_are_mutually_exclusive` | `p18:139` | `beat.ball` 与 `beat.main` 不得同时出现 | 真不变量；但只在 **seed 1** 上测，且有「样本非空」前置断言（防空转）。建议多 seed |
| `gates_are_finite_and_not_vacuous` | `p18:168` | 研究门导出量有限/非负/非退化 | 真不变量 + 样本量下限；单 seed 夹具 |
| `p31_slot_layer_is_gone` | `lib.rs:12303` | 生产段不得残留槽位符号 | 真不变量，但**文本扫描**脆弱（见 §4） |

## 2. 契约型场景守卫（保留契约，替换脆弱触发夹具）

| 守卫 | 位置 | 契约 | 当前夹具/脆弱点 | 替代建议 |
|---|---|---|---|---|
| `p53_same_team_spacing_ge_2m` | `lib.rs:9158` | 同队发射位置 ≥2m−ε，且 > detector 2.0m | seeds 1..10 全扫描；末尾「worst < 2.05」是**机制存活**断言，行为改变/过度分离会假红 | 保留多 seed 全扫描；把「worst<2.05」降为**报告**；另加显式构造 pair（阈值−ε/阈值/阈值+ε）与 10 seed 的 worst 分布 |
| `p53_same_team_spacing_holds_between_anchors` | `lib.rs:9234` | 拍内线性插值全程 ≥2m−ε | seeds 1..8；同样有「worst<2.15」机制断言 | 同上；加合成的 from→to 交点场景（穿越/相切/远离三档） |
| `p53_same_team_frozen_participant_separates_mover`、`p53_highlight_landing_enters_solver_on_breach`、`p53_sent_off_not_separated`、`p53_cross_team_not_constrained`、`p5_repulsion_separates_overlap` | `lib.rs:9357–9439` + `p5` | 冻结参与者/落点/罚下/跨队的分离语义 | 手工构造 `MatchState`（已经较显式）；但依赖内部字段与 `beat_movers` 签名 | 保留；把「内部字段构造」收敛为 test-only builder，减少签名变更时的连锁修改 |
| `p31_open_play_carrier_decision_is_geometric` | `lib.rs:10558` | 贴身→出球、近门无压→射门推进、后场→带球 | 用 50/100 个 RNG seed 找「至少一次」；无显式场景断言；行为耦合 | 显式构造三种几何 + 条件断言（给定几何的 `exec` 分布/方向），再报告多 seed 的置信区间；不要把「至少一次」当唯一证据 |
| `p31_no_fixed_evaluation_beat` | `lib.rs:12334` | 开放比赛 deadline 不是固定槽位间距 | 跑 seed 3 一整场，断言 `deadline_max > deadline_min`；若该场没有自然 deadline 会空跑/假红 | 对 `compute_action_deadline` 做纯函数网格（距离×压力×空间）断言取值随几何变化；全场比赛只作覆盖 |
| `p6_corner_battle_double_chase` | `lib.rs:10049` | 角球落点 battle 有攻防双 chase | 在 seeds 1..80 里找**第一个**角球；若该角球后没有 loose beat，**静默通过**；若 80 场内无角球则 panic | 构造 `MatchState` 角球 restart + loose battle，直接断言 ≥2 chase 与角色；对全部角球遍历，至少一个断言生效；无角球时用前置条件失败（不要静默） |
| `p6_corner_kick_structure`、`p6_header_shot_h_zero`、`p6_clearance_structure`、`p6_goal_kick_*`、`p6_pass_out_*`、`p6_throw_in_*` 等 | `lib.rs:9723–10300` | 各重开/事件结构 | 多数是「seeds 1..N 找第一个该类型事件，找到就 return，找不到 panic」；首个样例可能不含要断言的子结构 | 用显式构造的事件/状态调用对应 emit 函数；再保留一个多 seed 覆盖测试（断言「在预注册 seed 集内至少 K 个样例」） |
| `p32_interception_self_consistency` | `lib.rs:11870` | 拦截概率实现自洽（分桶/接线/常量绑定） | 400 场全比赛聚合；行为/RNG 改动会重抽；已多次因窗口/样本变动而红（M5 记录） | 保留纯函数精确值测试；把 400 场聚合改为预注册小样本 + 自助 CI，或构造采样 harness；接线/常量断言保留 |
| `l2_sent_off_kickoff_seeds` | `realism.rs:1448` | 罚下零参与 + 开球非自传（定向 seed 钉死稀有路径） | 4 个定向 seed 会随流失效；有「确有红牌」前置断言防空转 | 保留定向夹具与前置断言；把 seed 失效时的重扫写成流程（同一判据）；另由 300 seed 的 `l2_cross_event_invariants` 做宽扫 |
| `p124 intent 契约组`（`intent_export_is_tick_aligned...`、`contact_intents_match_the_event_stream`、`intent_semantics_are_pinned`、`committed_is_not_observable...`） | `p124:464–760` | 意图通道与事件/位置对账 | 依赖固定 seed 1/2/3/7 与 `GATE_SEEDS` 窗口；行为改流后可能空跑（已有“非空”前置断言，较好） | 保留前置断言；把窗口依赖改为多 seed 置信范围；见 §4 的 `GATE_SEEDS` 风险 |
| `defensive_intents_are_sparse_and_well_formed` | `p124:623` | 防守意图稀疏且形态合法 | 分布断言；「稀疏」阈值未给真实锚 | 标为报告/统计门；若要保留，用多 seed 的置信区间而非单点阈值 |

## 3. 统计 / 记录门（可重扫/重钉，但换样本不换判据）

| 守卫 | 位置 | 当前形态 | 风险 |
|---|---|---|---|
| `l1_shot_result_distributions` / `l1_tackle...` / `l1_pass_completion_rate` / `l1_home_away...` / `l1_fouls_and_cards` / `l3_shot_ratios` | `realism.rs:785–1293` | 200/600 场聚合带 | 见 `notes/l1-band-audit.md`；多数带是护栏或未验证 |
| `p31_frequency_5min_directional` | `realism.rs:1844` | 1000 场 5min + 20 场 90min | 机制存活/方向护栏；不是真实拟合 |
| `p15` `terminal_state_invariants_and_closure_hold_on_the_canary_seeds`、`restart_kind...`、`contest_reasons...`、`kickoff_flight...`、`event_indexes...` | `p15_behavior_observation.rs:338/535/648/958/1092` | 观察层契约 + canary seed | 部分是 300 seed 统计；`TRUNCATION_FORM_SEEDS` 等定点集会随流失效（M5 记录换过样本） |
| `p16 phaseability` 类 AUC 门 | `p16_spatial_features.rs`（`GATE_SEEDS`） | AUC 阈值（如 >0.75） | **窗依赖**：`openspec/changes/m5-inside-shot-ratio-caliber/tasks.md` 第 2 步记录同代码换窗余量从 +0.005 掉到 +0.0004；`auc_raw>0.60` 自称不是判据却会红 |
| `p17b` 覆盖/可读性门 | `p17b_diagnosis_report.rs:173/221/317/448` | 证据表/覆盖/探针读数 | 契约 + 记录；`*_guard_has_discriminating_power` 是元测试（应保留） |
| `p18_behavior_gates` 组 | `p18_behavior_gates.rs:157/186` | `carrier_ticks_dominate_loose_ticks`（持球拍 >5×松散球拍）、`pass_fail_c7_differs...`（C7 与 p17a 口径不同） | 统计/记录；`ball/main` 互斥与有限性见 §1；`p18_canary`/`p18_baseline` 是**产物门**，需 `P18_SOURCE_COMMIT`，不在 `verify.sh` |
| `p124_purification_records_the_v4_verdict_pending_review` | `p124:319` | `drop_restart` 记录的 AUC 0.437/0.437/0.405 | **记录门**（verdict pending review）；不是物理不变量 |
| `gm_*` | `realism.rs:1662–1830` | 10 canary seed 记录 | 记录门；改行为需重基线，不能当真实拟合 |

## 4. 已知脆弱点（按风险排序）

1. **「第一个找到的样例」模式（p6 一族）**：找到第一个事件就 `return`；
   如果该样例不包含要断言的子结构（例如角球后没有 loose beat），测试**静默通过**。
   这是「空转断言」的高发形态。建议：遍历全部候选、至少一个断言必须生效；
   或无候选时显式失败（不是 skip）。
2. **固定 seed 夹具**：`l2_sent_off_kickoff_seeds`、`p15 TRUNCATION_FORM_SEEDS`、
   p124 `GATE_SEEDS`、p6 的 1..80/1..100 搜索。引擎改流后旧 seed 会失效；
   保留「前置断言」（确有红牌/确有事件）是正确做法，但应把「换 seed」写成流程而不是临时补丁。
3. **机制存活断言混在契约门里**：`p53` 的 `worst < threshold+0.05/0.15`——
   它防「分离从未触发」，但行为改变/过度分离会假红。建议降为报告，
   或改成「预注册 seed 集里至少一个 pair 落在 [threshold, threshold+0.05]」的条件断言。
4. **文本扫描**：`p31_slot_layer_is_gone` 用 `include_str!("lib.rs")` + `split("#[cfg(test)]")`
   扫生产段。注释里出现被扫字面量会计入（本仓已有教训：注释写 `#[cfg(test)]` 会让三条
   `p31_*` 同时红）。这是**真不变量**但维护脆弱；能用类型/符号表就别用文本。
5. **窗依赖的统计门**：p16 `phaseability`、p124 `GATE_SEEDS`、L1 的 200/600 窗。
   同一代码换窗可红可绿；报告必须带窗口。CLAUDE.md 的「跨窗余量取 min」是正确口径。
6. **`--ignored` 产物门不在 CI**：`p124_canary`/`p16_canary`/`p17b_canary`/`p17b_baseline`/
   `p18_canary` 需要显式 `P*_SOURCE_COMMIT` 且要求干净工作树；`verify.sh` 不跑它们。
   ⇒ **CI 绿 ≠ 全量 `--ignored` 绿**。这不是守卫设计问题，是运行口径问题，必须在报告里写明。

## 5. 替代夹具的通用模板（下一 change 可直接用）

```
1) 显式构造状态：MatchState / lineup / ball_pos / possession / carrier / 关键 pos，
   只设置断言需要的字段；不跑整场。
2) 条件断言：给定该状态，调用被测函数，断言「契约」而非「某个 seed 的事件序列」。
3) 多 seed 置信范围：统计门用预注册 seed 集，逐 seed/逐场先算再平均，报区间与 n；
   跨窗余量取 min，不用单窗点估计。
4) 反证条：对每个新夹具做一次定向变异（删掉被测机制），断言必红。
5) 换样本不换判据：固定 seed 失效时只换 seed，改判据要单独说明理由。
```

## 6. 本 change 的边界

- **没有改任何门、没有删除红门、没有放宽阈值**。
- 没有运行全量 `--ignored`；没有重扫固定 seed；没有重跑 200 场 L1。
- 分类与建议是给 Change 1/2 的输入；是否真正替换夹具由后续 change 决定。
