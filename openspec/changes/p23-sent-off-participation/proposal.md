# Proposal: 罚下球员不得再参与比赛（sent_off 未全路径排除）

## Why

引擎 `MatchState.sent_off[22]` 在红牌/二黄时置位，spec 已声明「罚下球员不再成为持球者/追逐者」（`match-engine` 犯规与纪律牌 requirement）。但实现**只屏蔽了部分路径**：

- ✅ 已屏蔽：`nearest_in_team` / `nearest_any`（松散球追逐）、`nearest_defender_avail`（犯规）、carrier 守卫。
- ❌ **未屏蔽**（罚下球员继续"上场"）：
  1. `compute_movers`（`engine/src/lib.rs:1112`）——mover 生成循环只排除 `excluded`（当前高亮参与者）和 carrier，**不排除 `sent_off`**。罚下球员照常跑位，出现在每个 beat 事件的 `movers` 数组里。
  2. `pick_close_down_players`——transition 逼抢选择不排除 `sent_off`。
  3. `nearest_defender`（抢断路径）——抢断者选择不排除 `sent_off`（犯规路径用的 `nearest_defender_avail` 有排除，抢断路径漏了）。

调研实测：多 seed 扫描全事件流，罚下球员在 movers / close_down / 抢断者中出现 **7266 次**（issue #34）。

## What Changes

### 引擎侧修复（主）

- `compute_movers`：第一遍目标循环加 `st.sent_off[id]` 跳过（目标置 None → 自动不参与 repulsion 推开、不产 mover）；第三遍门将/外场 mover 产出循环加同样守卫（罚下门将也不产 `keeper_return`）。
- `pick_close_down_players`：加 `st.sent_off[id]` 跳过。
- `nearest_defender`（抢断）：加 `st.sent_off[id]` 跳过。

### 引擎侧不变量测试（防回潮）

- `realism.rs` L2（`l2_cross_event_invariants`）新增不变量：扫描全事件流，从 `foul[card=red]` 重建罚下集合（红牌 / 二黄展示为红），断言罚下球员此后**不得出现在任何事件的 `subject` / `movers[].id` / `carrier` / `interceptor` / `chaser` / close_down 参与者**中。违例计数进 `MatchStats`，`l2_cross_event_invariants` 断言为 0。
- 引擎单元测试（lib.rs）：构造确定性红牌场景，断言罚下后该球员不再产生任何 mover、不再被选为抢断者/close_down。

### golden master 重基线

- 修复改变事件流（罚下球员不再进 movers）→ 10 个 canary seed 的流哈希变化 → `ACCEPT_GOLDEN=1` 重基线（只接受「罚下球员不再参与」这一语义变化，不接受其它漂移）。

## Capabilities

### Modified Capabilities

- `match-engine`: 犯规与纪律牌 requirement 的「罚下球员」语义从「不再成为持球者/追逐者」扩展为「不再参与任何事件」（mover / close_down / 抢断者 / 持球者 / 追逐者）；L2 不变量 requirement 增补「罚下球员不得参与」项。

## Impact

- `engine/src/lib.rs`（compute_movers / pick_close_down_players / nearest_defender + 单元测试）
- `engine/tests/realism.rs`（MatchStats 增字段 + L2 不变量断言）
- `engine/tests/golden/*.json`（重基线，10 文件）
- 不碰 viewer、tools/detectors.mjs（sent_off 状态不进观察窗口，detector 无从重建——引擎侧不变量测试是唯一正确落点）

## 关联

- 修复 issue #34；从 wayfinder 地图 #28 L3 拆出
- 与 #35（位置重叠）独立；与 #25（引擎造数重构）不同线——这是纪律规则不完整，不是造数因果倒置
