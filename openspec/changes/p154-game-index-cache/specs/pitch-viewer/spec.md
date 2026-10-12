# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 播放器的静态索引可复用，且复用不改变播放语义

`viewer/game.js` SHALL 把构造 `Game` 时**与播放时刻无关**的那部分产物（锚点时间线、按实体分组的
时间索引、每事件结束时刻、比赛总时长）算成**可复用**的结果，并 SHALL 允许调用方把它传给 `Game`
构造以跳过重算。该结果 SHALL 只依赖 `(events, lineup, mode)` 与**建该结果时读取的配置常量**，
SHALL NOT 依赖 `playTime`、`opts`（逐次构造的入参）或任何构造期可变状态。

该结果**烘焙了建它时刻的配置**，故复用 SHALL 只发生在配置未变的前提下；调用方 SHALL NOT 在
「建结果」与「复用」之间修改配置（同源守卫只比较 `events`/`lineup`/`mode`，守护不到配置变化）。

复用该结果构造出的 `Game`，SHALL 与不经复用构造出的 `Game` **逐位一致**——包括球员/球位置、
事件索引、高亮窗口、每事件结束时刻、比赛总时长，以及在 `seekTo` / `step` 之后的全部可观测状态。
「`_interpolateAnchors` 返回 `null`（该实体此刻无锚点）时回落初始站位」这条分支 SHALL 在两条
路径上表现相同。

该结果 SHALL 只在**同源**（同 `events`、同 `lineup`、同 `mode`）时被接受；不同源 SHALL 报错，
SHALL NOT 静默回落到「重新计算」。

不传该结果的既有构造路径（App 播放、`createGame`、各测试与工具）SHALL 行为逐位不变。

#### Scenario: 复用与重建产出逐位相同的播放状态

- **WHEN** 用同一份 `(events, lineup, mode)` 分别以「复用静态索引」与「每次重建」构造两个 `Game`，并在同一组时刻 `seekTo`（含首个锚点之前、事件之间、末尾、罚下前后）
- **THEN** 两者的球员位置、球位置、播放时刻、当前事件索引、高亮窗口、纪律牌与进度值**逐位相同**

#### Scenario: 静态索引不被构造或推进改写

- **WHEN** 用同一份索引连续构造并推进多个 `Game`（`seekTo` / `step`）并逐窗采集观测
- **THEN** 传入的 `events` / `lineup` 与索引本身逐字节不变（复用可安全跨窗，不存在共享可变状态污染）

#### Scenario: 跨事件流复用被拒

- **WHEN** 把为事件流 A 建立的静态索引传给以事件流 B（或不同 lineup、不同 mode）构造的 `Game`
- **THEN** 构造报错，不产出任何位置或观测

#### Scenario: 配置变化不在同源守卫的守护面内（如实声明）

- **WHEN** 在「建立静态索引」与「构造 `Game`」之间修改影响演绎的配置（如 `interpretation` / `pitch` 下的值）
- **THEN** 同源守卫放行（它只比较 `events`/`lineup`/`mode`），复用的索引保持**建它时刻**的配置语义
  ——这是**已知边界**：调用方不得这样用

#### Scenario: 不传索引的路径行为不变

- **WHEN** 以原有方式（不传静态索引）构造 `Game`
- **THEN** 构造与播放行为与引入复用能力之前逐位相同
