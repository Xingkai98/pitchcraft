# Spec: match-engine

## MODIFIED Requirements

### Requirement: 犯规与纪律牌（foul / 任意球）

引擎 SHALL 在开放持球段产生犯规：防守方有球员贴身（≤ 8m）持球者、犯规点距所攻球门 > 禁区线时，以固定概率产 `foul` 事件。犯规后球权保留给被犯规方，进入任意球重开（`pass detail=free_kick`）。纪律牌决策 SHALL 确定性（引擎 SeededRng）：犯规事件可选携带 `card`（`yellow`/`red`，缺省=无牌）；同人二黄升级红牌罚下；罚下球员不再成为持球者/追逐者/抢断者/逼抢者/传球目标/开球者/接球者，也不得出现在任何事件的并行跑位数组（`movers`）中。

#### Scenario: 罚下球员不得参与跑位
- **GIVEN** 某球员被罚下（`sent_off[id]` 已置位）
- **WHEN** 引擎生成后续 beat 事件的并行跑位（`compute_movers`）
- **THEN** 该球员不产 mover，不出现在 `movers[].id` 中

#### Scenario: 罚下球员不得被选为抢断者/逼抢者
- **GIVEN** 某球员被罚下
- **WHEN** 引擎选择抢断者/拦截者（`nearest_defender`）或 transition 逼抢者（`pick_close_down_players`）
- **THEN** 该球员不被选中

#### Scenario: 罚下球员不得被选为传球目标或开球者/接球者
- **GIVEN** 某球员被罚下
- **WHEN** 引擎选择传球/发球目标（`nearest_teammate` / 向前传球目标）或进球后开球者/接球者（`kickoff_pick`）
- **THEN** 该球员不被选中（否则会以 `to`/`carrier`/`subject` 身份重新进入比赛）

#### Scenario: 某队外场全部罚下时选择器仍为全函数
- **GIVEN** 某队 10 名外场全部被罚下（每队最多 10 张红牌；门将不产犯规故恒不被罚下）
- **WHEN** 引擎调用抢断者/传球目标/开球者选择器
- **THEN** 选择器不 panic、不返回罚下球员，回退到恒未被罚下的门将

#### Scenario: 罚下球员不得再参与任何事件（L2 不变量）
- **GIVEN** 一场完整比赛的事件流
- **WHEN** 从 `foul[card=red]` 重建罚下集合，并扫描其后所有事件
- **THEN** 罚下球员不得出现在任何事件的 `subject` / `movers[].id` / `carrier` / `interceptor` / `to` 中

### Requirement: 事件流过程真实性不变量（L2）

事件流过程真实性不变量 SHALL 覆盖罚下球员参与：对任意 seed 的完整事件流，罚下球员（红牌后）参与任何事件（`subject` / `movers[].id` / `carrier` / `interceptor` / `to`）SHALL 计为违例，`l2_cross_event_invariants` SHALL 断言违例数为零。该不变量 SHALL 覆盖足够多的 seed（≥ 300）以命中红牌派生路径（罚下者恰为开球者/接球者等稀有场景）——窄 seed 窗口会使门假绿。开球者与接球者 SHALL 不同一人（自传退化）。

#### Scenario: L2 不变量断言罚下球员零参与
- **GIVEN** 一个 seed 的完整比赛事件流
- **WHEN** 运行 `l2_cross_event_invariants`
- **THEN** 罚下球员参与事件的违例计数为零，非零则测试失败并报出 seed 与违例详情

#### Scenario: L2 门覆盖红牌派生路径
- **GIVEN** 罚下球员参与的违例只在少数 seed 出现（红牌约 1/6 场）
- **WHEN** 用窄 seed 窗口（如 15）运行 L2
- **THEN** 门可能在实际被违反时仍全绿（假绿）；故 seed 覆盖 SHALL ≥ 300（实测最早出现该路径的 seed 为 260）
