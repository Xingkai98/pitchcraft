# Proposal: C3 换人惩罚身份对齐 + C4 压迫/盯人仲裁顺序修正

## Why

2026-10-19 的验收回路（`openspec/changes/c1c5` 回路改动，未提交）在不改行为的前提下量到两个**确定的机制错误**：

1. **换人惩罚的“同一人”判断按 `att_ids` 下标而不是进攻者 id。** 持球者一变，`att_ids`
   的成员/顺序就变；探针实测 **10,787 / 145,284 ≈ 7.4%** 的分配里，`mark_prev` 里的
   `prev` 下标在当前 `att_ids` 中指向了另一个进攻者（或越界/位置已属于另一名防守者）。
   惩罚因此可能落在错误目标上，也可能漏掉真正的“换人”。
2. **C4 压迫在 C3 盯人之后才选人。** C3 先把约 9 名防守者标成 `mark`，C4 只从
   `action == "run"` 里选压迫者；探针实测门控通过 8,927 次，只有 **308 次（3.5%）**
   还能找到空闲防守者。C4 当前几乎被 C3 架空，也解释了它对 like-football 距离增量 ≈0。

这两条都是**代码与票据契约不一致**，不是“指标不好看”。本 change 只修这两条，
**不调任何概率/几何常数**，不以 L1 进带为目标；L1 只作为“不要更坏”的护栏。

## What Changes

1. **换人惩罚身份对齐（C3）**
   - 把 `MatchState.mark_prev`（`Vec<Option<usize>>`，`att_ids` 下标）改为
     按防守者 id 保存的 `mark_prev_attacker: [Option<usize>; 22]`（进攻者 id）。
   - `apply_marking` 每次用“上一拍进攻者 id → 当前 `att_ids` 下标”构造
     `marking::assign` 需要的 `prev`；进攻者已不在场时传 `None`。
   - 换防守方（球权回合切换）时重置，不跨回合比较；未匹配时保留上次目标
     （“跨过未匹配段再换人”仍算换人）。
2. **压迫/盯人仲裁（C4 + C3）**
   - 按 #172 的闭环契约：**先选 press 集合（≤N），其余防守者做 mark；被 press 选中的不再参与 mark**。
   - 把 `apply_pressure` 拆成 `pick_presser`（只选人/算压迫点，不改目标）与
     `apply_pressure_target`（设置压迫目标 + 弱侧压缩）。
   - 调用顺序：`pick_presser` → 把选中者 `action="close_down"` → `apply_marking`
     （自动排除它）→ `apply_pressure_target` → repulsion。
   - 候选 SHALL 排除 `excluded`（本拍不产 mover 的高亮参与者/冻结者）——否则会选到一个
     根本不会移动的“压迫者”，探针的“已派出”读数虚高。

## 不做 / 不承诺

- **不**调 `SWITCH_PENALTY_S`、`MARK_STOP_M`、`OPEN_PRESS_*` 或任何概率常量。
- **不**因为 L1 仍红就继续调常数；若修完 L1 没改善，说明“这两个 bug 是主因”的假设被证伪，
  下一步需要新的机制探针（射门窗口/抢断机会），而不是扫参数。
- 不把 C4 的价值判死：修完仲裁后必须重新测；C4 可能变好、变坏或仍无增量。

## Impact

- `engine/src/lib.rs`：`MatchState` 字段、`apply_marking` 的 `prev` 构造、
  `apply_pressure` 拆分与调用顺序。默认（`realism` 全关）路径不调用这些分支，行为不变。
- 探针：`marking_prev_index_mismatches` 预期归零（保留为回归观测）；`press_gate_passed`
  与实际压迫率用于验证仲裁是否真的生效。
- 不改事件 schema、不改 `MODEL_VERSION`/golden：本 change 是 C1–C4 原型分支内的行为修正；
  正式 C3/C4 change 落地时再按预约的 12/13 升版本与 golden。
