# Spec: match-engine

## MODIFIED Requirements

### Requirement: 犯规与纪律牌（foul / 任意球）

引擎 SHALL 在开放持球段产生犯规：防守方有球员贴身（≤ 8m）持球者、犯规点距所攻球门 > 禁区线时，以固定概率产 `foul` 事件。犯规后球权保留给被犯规方，进入任意球重开（`pass detail=free_kick`）。纪律牌决策 SHALL 确定性（引擎 SeededRng）：犯规事件可选携带 `card`（`yellow`/`red`，缺省=无牌）；同人二黄升级红牌罚下；罚下球员不再成为持球者/追逐者/抢断者/逼抢者/传球目标/开球者/接球者，也不得出现在任何事件的并行跑位数组（`movers`）中。当某队外场球员全部被罚下时，向前传球目标选择（`emit_forward_pass_highlight`）与任意球追逐者选择（`nearest_any`）SHALL 回退门将，不返回无效 id。

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
- **WHEN** 引擎调用抢断者/传球目标/开球者/最近队友选择器
- **THEN** 选择器不 panic、不返回罚下球员，回退到恒未被罚下的门将（`nearest_in_team` 回退 home 0 / away 21，不返回无效 id -1）

#### Scenario: 向前传球目标退化态回退门将
- **GIVEN** 某队外场球员全部被罚下，且仅存球员持球需向前传球推进
- **WHEN** 引擎调用 `emit_forward_pass_highlight` 选择向前传球目标
- **THEN** 回退该队门将（`to != from`），不返回无效 id（-1），不越界

#### Scenario: 任意球追逐者退化态回退门将
- **GIVEN** 两队外场球员全部被罚下
- **WHEN** 引擎调用 `nearest_any` 选择松散球追逐者
- **THEN** 回退 home 门将 0，不返回无效 id（-1），不越界
