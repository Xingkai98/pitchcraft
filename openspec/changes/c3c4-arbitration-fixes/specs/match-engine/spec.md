# Spec: match-engine

## ADDED Requirements

### Requirement: 换人惩罚 SHALL 按进攻者身份而不是数组下标判断“同一人”

当 `realism.marking` 打开时，引擎 SHALL 为每名防守者保存**上一次实际匹配到的进攻者 id**，
并用它在当前进攻者集合中的位置构造换人惩罚的 `prev`；SHALL NOT 把上一拍的 `att_ids` 下标
直接当作当前拍的下标。换防守方（球权回合切换）时 SHALL 清空该状态；未匹配时 SHALL 保留
上一次匹配的目标。

#### Scenario: 持球者变化导致 att_ids 平移

- **GIVEN** 防守者 7 上一拍盯进攻者 12，`att_ids=[11,12]`
- **WHEN** 持球者从 13 变为 11，`att_ids` 变为 `[12,13]`，7 仍然盯 12
- **THEN** 换人惩罚 SHALL NOT 把这次“下标 1→0”计为换人
- **AND** 探针的 `marking_prev_index_mismatches` SHALL 为 0

#### Scenario: 跨过未匹配段换目标

- **GIVEN** 防守者上一拍盯 12，随后一拍未匹配
- **WHEN** 下一拍改盯 11
- **THEN** 这次变化 SHALL 被计为一次换人

### Requirement: 开放局压迫 SHALL 先于盯人分配选人

当 `realism.press` 与 `realism.marking` 同时打开时，引擎 SHALL 先按压迫门控/控制场选出
压迫者（≤N），再把其 `action` 标为 `close_down`，并让盯人分配排除该球员；其余防守者
SHALL 走盯人分配。SHALL NOT 先让盯人占用全部防守者、再让压迫从 `action=="run"` 中空选。

#### Scenario: 压迫者不被盯人占满

- **GIVEN** 球在防守方本方半场，双方都有外场球员
- **WHEN** 同一拍同时执行 C4 压迫与 C3 盯人
- **THEN** 被选中的压迫者 SHALL NOT 出现在本次盯人分配中
- **AND** 候选 SHALL 排除本拍不产 mover 的 `excluded` 球员（高亮参与者/冻结者）
- **AND** 门控通过后实际派出压迫者的调用比例 SHALL 显著高于“mark-first”基线（3.5%）
