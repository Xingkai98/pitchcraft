# Design: C3 换人惩罚身份对齐 + C4 压迫/盯人仲裁顺序修正

## D0. 目标与判据

**目标**：修两个已由只读探针确认的机制错误，使 `mark_prev` 的“同一人”判断与 C4 的选人
契约按代码/票据语义工作。

**不目标**：把 L1 四条带调绿。L1 只作护栏；专项目标不看“进带”，而看机制探针：

| 改动 | 机制判据 | 反证（若出现则假设错） |
|---|---|---|
| C3 身份对齐 | `marking_prev_index_mismatches` 归零 | 归零后换人率完全不变且 L1 不变 → 影响面可能被高估，需重新评估 |
| C4 仲裁顺序 | 门控通过后实际派出压迫者的比例显著高于 3.5% | 比例仍低 → 仍有别的占用/门控原因，不能归因于 C3 |

**固定种子/口径**：L1 报告 60 场 seed 401..460，严格门 200 场 seed 401..600；
探针 3 场 seed 401..403；轨迹 seed 42 / t=1800 / 90s；所有改动前后用同一组口径。

**记录纪律**：每次改动记录 `git diff` 哈希、`engine/src/lib.rs`/wasm sha、`REALISM` 组合。

## D1. C3：换人惩罚必须按进攻者身份

### 现状（错误）

`MatchState.mark_prev: Vec<Option<usize>>` 保存的是**上一拍 `att_ids` 的下标**；
`marking::assign` 用 `prev[i] == Some(j)` 判断“是否还是同一个人”。但 `att_ids` 每次调用都按
“当前非门将外场 minus 持球者”重建：持球者一变，成员和顺序都变。后果：

- 同一下标可能指向另一个进攻者 → 惩罚落到错误目标；
- 真正的同一进攻者换了下标 → 惩罚漏掉；
- 探针 2026-10-19 实测 **7.4%** 的分配存在错位（含越界/防守者位置变化）。

### 修法

- `MatchState` 用 `mark_prev_attacker: [Option<usize>; 22]`（按**防守者 id** 索引，
  值是**进攻者 id**）。这是行为状态，不再是纯探针。
- 每次 `apply_marking`：
  1. 若防守方改变：清空 `mark_prev_attacker`；
  2. 对每个当前防守者，用 `mark_prev_attacker[d]` 在**当前** `att_ids` 中找位置，
     构造 `prev[k]`（找不到则 `None`）；
  3. `assign` 保持不变；
  4. 匹配成功时把 `att_ids[j]` 的 id 写回 `mark_prev_attacker[d]`；未匹配时**保留**
     上次匹配 id（跨未匹配段换人仍应计一次换人）。
- `marking_prev_index_mismatches` 保留为旁路观测：修复后应为 0（它是“旧口径错位”的哨兵，
  不再是机制输入）。

### 预期与不作为承诺

惩罚对齐后，换人率**可能升、可能降**——它只保证惩罚落在正确的目标上。若换人率不降，
说明“惩罚常数太小”或“贪心本身抖动”才是主因，需要下一轮机制设计；本 change 不调常数。

## D2. C4：先选压迫者，再让其余人盯人

### 现状（契约不一致）

#172 闭环：「同一拍里先选 press 集合（≤N），其余防守者做 mark；被 press 选中的不再参与 mark」。
当前顺序是 `apply_marking` → `apply_pressure`，且 `apply_pressure` 只从 `action=="run"` 选人。
C3 先把约 9 人标成 `mark`，于是 C4 几乎无人可用：门控通过 8,927 次，只有 308 次（3.5%）
派出压迫者。

### 修法

把 `apply_pressure` 拆成两步，并在 `compute_mover_candidates` 里重排：

```
let press = if realism.press { pick_presser(st, &actions) } else { None };
if let Some((id, _)) = press { actions[id] = "close_down" }
if realism.marking { apply_marking(...) }          // 自动排除 presser（action != run）
if realism.press { apply_pressure_target(st, ..., press) }
```

- `pick_presser`：门控（本方半场）+ 双方有人 + 网格 `space::press_point` + 从
  `action=="run"` 且**不在 `excluded`**（本拍不产 mover 的高亮参与者/冻结者）的防守者中
  选离球最近者；**只计算/选人，不改 targets**。门控通过计数在 `press_gate_passed`。
  排除 `excluded` 是 2026-10-19 复审抓到的接线缺口：旧选人不看 excluded，可能选中
  一个不会移动的“压迫者”。
- 选中者先把 `action` 置 `close_down`，`apply_marking` 的 `def_ids` 自然排除它。
- `apply_pressure_target`：设置压迫者目标 + 其余防守者弱侧向球收（保持原逻辑，作用在
  mark 之后的 targets 上）。
- 未选中时行为与旧路径相同（只是少了一次从已 mark 人群中找人的空转）。

### 预期与不作为承诺

门控通过后的实际压迫率应显著上升（从 3.5% 起）。但 C4 开始真正参与后，L1 射门/抢断/犯规
可能变好、变坏或不动；**本 change 不据此调任何常数**。C4 是否有价值，等修完仲裁后用同一组
探针 + L1 + 轨迹重新判定。

## D3. 实验顺序（一次只改一条）

1. **A：只改 D1（C3 身份对齐）**；跑探针 + L1 60 场 + P38 + 轨迹；记录。
2. **B：在 A 的基础上只改 D2（C4 仲裁）**；同一组复测；记录。
3. **C：最终** 跑 L1 严格 200 场、默认 lib/realism 测试、探针、P38、轨迹；跑审阅闭环。

每一步都保留改动前的读数；不把 A/B 的效果混在一起。若 A/B 后 L1 仍红，按“机制探针是否
按预期移动”判断成败，不因 L1 红而否定机制修复，也不因 L1 偶然变好而宣布成功。

## D4. 风险与边界

- 只影响 `realism.marking` / `realism.press` 打开的路径；默认全关路径与既有 golden 不变。
- `mark_prev_attacker` 的“保留上次匹配目标”语义要让 `marking::assign` 的 `prev` 只在
  “该进攻者当前仍在场”时才非 None；否则 `assign` 无法表达“上次是谁”。
- `pick_presser` 先于 marking 选人，可能选走一个原本要盯关键进攻者的防守者；这是 #172
  契约的明确取舍，不是 bug。若后续发现防线被拉散，应在 C4 设计里加约束，而不是恢复
  旧的 mark-first 顺序。
- 本 change 不升 `MODEL_VERSION`、不建 flags-on golden；正式 C3/C4 change 落地时补。
