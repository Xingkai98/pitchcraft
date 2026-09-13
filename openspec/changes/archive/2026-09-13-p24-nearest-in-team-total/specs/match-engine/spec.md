# Spec: match-engine

## MODIFIED Requirements

### Requirement: 犯规与纪律牌（foul / 任意球）

引擎 SHALL 在开放持球段产生犯规：防守方有球员贴身（≤ 8m）持球者、犯规点距所攻球门 > 禁区线时，以固定概率产 `foul` 事件。犯规后球权保留给被犯规方，进入任意球重开（`pass detail=free_kick`）。纪律牌决策 SHALL 确定性（引擎 SeededRng）：犯规事件可选携带 `card`（`yellow`/`red`，缺省=无牌）；同人二黄升级红牌罚下；罚下球员不再成为持球者/追逐者/抢断者/逼抢者，也不得出现在任何事件的并行跑位数组（`movers`）中。当某队外场球员全部被罚下时，最近队友选择（`nearest_in_team`）SHALL 回退该队门将，不返回无效 id。

#### Scenario: 全队外场罚下时最近队友回退门将
- **GIVEN** 某队外场球员（10 人）全部被罚下
- **WHEN** 引擎调用 `nearest_in_team` 选择该队球员
- **THEN** 返回该队门将（home 0 / away 21），而非无效 id（-1），不越界
