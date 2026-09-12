# Design: 罚下球员不得再参与比赛

## Context

`sent_off[22]` 红牌/二黄置位，spec 已声明罚下语义，但实现只屏蔽了部分路径（松散球追逐、犯规、carrier 守卫），`compute_movers` / `pick_close_down_players` / `nearest_defender` 三条路径漏了。罚下球员照常跑位、被选为抢断者/逼抢者。

关键事实（已核实）：
- `apply_card` 二黄升级红：`card=red` 事件是唯一对外可见的罚下信号，`sent_off` 只存引擎内部状态、不进事件 JSON、不进观察窗口。
- 事件 JSON 里罚下球员的可见证据是：**红牌事件之后该 id 仍出现在 `beat.movers[].id` / `subject` / `carrier` / `interceptor` 中**。
- `compute_movers` 有 `excluded: &[i32]` 参数（当前高亮参与者），所有调用点都传入；门将走 `keeper_return` 分支不受 `targets` 约束。

## Goals / Non-Goals

**Goals:**
- 罚下球员不再出现在任何 beat mover、不再被选为抢断者/close_down。
- 引擎侧不变量测试（L2）重建罚下集合并断言全程零参与。
- golden 重基线只接受「罚下球员不再参与」语义变化。

**Non-Goals:**
- 不做「少一人」的战术影响（阵型 10 人、少一人战术行为）——现有注释已声明「本试点仅屏蔽其成为 carrier/chaser」，本 change 只把屏蔽补完整，不做战术重构（归 #11 战术系统）。
- 不改 `sent_off` 状态进事件 JSON / 观察窗口（detector 侧无从重建，引擎不变量是唯一正确落点）。

## Decisions

### D1: 修复范围 = 三条未屏蔽路径

| 路径 | 位置 | 修法 |
|---|---|---|
| mover 生成 | `compute_movers` 第一遍目标循环（~1156） | `if st.sent_off[id as usize] { continue; }`（目标保持 None） |
| mover 生成（门将） | `compute_movers` 第三遍（~1200） | 门将分支前加 `if st.sent_off[id as usize] { continue; }`（罚下门将不产 keeper_return） |
| transition 逼抢 | `pick_close_down_players` | 循环内加 `if st.sent_off[id as usize] { continue; }` |
| 抢断者 | `nearest_defender` | 循环内加 `if st.sent_off[id] { continue; }` |

注意 `nearest_defender` 是「遍历所有外场、无 sent_off 守卫」——犯规路径用 `nearest_defender_avail`（有守卫），抢断路径用 `nearest_defender`（无守卫），两者同源但守卫不一致，是漏掉的主因。

### D2: 不变量测试落点 = 引擎侧（不碰 detector）

观察窗口不含 `sent_off`，detector 无从重建罚下集合。正确落点是引擎 `realism.rs` L2：

- `MatchStats` 增 `n_sent_off_participation: usize` + `n_red: usize`（已有 `n_foul_red` 可复用）。
- 聚合时扫描事件流：维护 `sent_off` 集合（`foul[card=red]` 的 `subject` 加入），此后任一事件的 `subject` / `movers[].id` / `carrier` / `interceptor` 命中该集合 → `n_sent_off_participation += 1`。
- `l2_cross_event_invariants` 断言 `n_sent_off_participation == 0`。

### D3: 不变量统计的字段提取

`realism.rs` 已有 `mover_speeds`（从 `"movers":[` 提取 speed）等提取器。需新增 `mover_ids`（提取 movers 数组内 id）与 foul 红牌 subject 提取（已有 `field_str(e, "card")` 匹配 `Some("red")`，subject 提取器若没有则补）。

### D4: golden 重基线

修复改变事件流 → 10 个 canary seed 的 `stream_hash` 变化。重基线时：
1. 先跑 `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 前，**人工核对**统计摘要只有「罚下球员不再参与」的预期变化（比分/进球/射门/传球等语义数字不应动，mover 数量可能微变）。
2. 不接受 golden 之外任何「为过测试而改」的漂移。

### D5: 单元测试（lib.rs）

构造确定性红牌场景直接驱动引擎（不依赖整场出现红牌的概率）：
- 手动 `st.sent_off[某外场 id] = true` 后调 `compute_movers`，断言产出的 movers 不含该 id。
- `nearest_defender` / `pick_close_down_players` 同理（罚下球员不被选中）。

已有测试 `lib.rs:3578/3619` 直接调 `compute_movers(&mut st, &mut rng, ...)`，可循此模式。
