# Tasks: 引擎侧同队间距约束（#53）

## P1. 米制分离纯函数 + 常量（D1）

- [ ] P1.1 `engine/src/lib.rs` 新增 `SAME_TEAM_MIN_DIST_M = 2.05` 常量 + `same_team_dist_m`（复用 `distance_meters`）+ `separate_pair_m` 纯函数（米制距离 + 米制推开方向，d==0 退化沿 +x，clamp01）
- [ ] P1.2 target 层 repulsion（`compute_movers` 第二遍 `lib.rs:2766-2785`）改米制判定/推开（`same_team_dist_m` + `separate_pair_m`，替换 `dist_norm`/`REPULSION_MIN_DIST`）
- [ ] P1.3 单测 `separate_pair_m`：x 轴（0.02 归一化 = 2.1m 不分离）、y 轴（0.02 归一化 = 1.36m 分离）、重合退化、边界 clamp

## P2. 最终位置统一分离（D2）

- [ ] P2.1 `carrier_move` 产出候选终点（不写 `st.pos`），返回候选 `(x2f,y2f)` + 起点/速度/touch_freq
- [ ] P2.2 `compute_movers` 产出候选 `Mover`（含 dead_zone 停者候选 = 当前 `st.pos`），不写 `st.pos`
- [ ] P2.3 新增统一分离 solver：合并 carrier+全体 mover 候选+未移动球员当前 `st.pos` → `[f64;22]`，同队 pair 固定迭代（3–5 轮）米制分离 + 终断言；零 RNG、固定遍历顺序
- [ ] P2.4 统一写回：分离后数组写 `st.pos` + 同步 `last_emitted`/`carrier_from`/`ball_pos`；`MainAction.x2/y2`、`Mover.to_x/to_y` 取分离后值，起点保留
- [ ] P2.5 所有 `compute_movers` 调用点（tick 高亮飞行 / `advance_restart_prep` / `emit_corner_kick` / `emit_throw_in` / `emit_free_kick` / `emit_beat_with_main`）走同一分离路径

## P3. 单测 + 验收（D3）

- [ ] P3.1 `p53_same_team_spacing_ge_2m`：多 seed 整场逐 tick 同队 pair 米制距离 ≥ `SAME_TEAM_MIN_DIST_M - ε`
- [ ] P3.2 更新 `p5_repulsion_separates_overlap`（`lib.rs:5685`）：改米制最终位置断言（不再 `d>0.005`）
- [ ] P3.3 carrier 逼近队友 / 角球包抄 / close_down 专项场景单测

## P4. golden v6（D4）

- [ ] P4.1 `MODEL_VERSION` 5→6（`lib.rs:228`）+ 版本注释
- [ ] P4.2 `golden_dir` 加 `6 => "tests/golden-v6"`（`realism.rs:1084`）；`gm_legacy_baselines_preserved_and_differs` legacy 扩 v1–v5
- [ ] P4.3 `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 生成 v6；**人工审查每个 seed diff**（比分/射门/传球/抢断/犯规/出界不得异常漂移）

## P5. 主 spec + detector 验收 + 审阅闭环

- [ ] P5.1 `openspec/specs/match-engine/spec.md` 同步新增「同队球员间距 ≥2m」requirement（与 delta 一致）
- [ ] P5.2 `npx openspec validate --all --strict` 全绿
- [ ] P5.3 `cargo test` + `verify.sh` 全绿（含 realism L1）
- [ ] P5.4 跑真实 diagnosis，`player_overlap` finding 归零（若 0.5s 插值中点仍越界 → 回引擎调 solver，不忽略）
- [ ] P5.5 独立零记忆 subagent 审阅闭环（发现问题→修复→再审至无遗留）

## 关联

- 修复 issue #53；关闭 #35 引擎侧；golden v6 重基线
