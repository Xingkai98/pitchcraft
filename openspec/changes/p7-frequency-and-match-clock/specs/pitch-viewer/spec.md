# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 比赛时间显示

画面层 SHALL 显示比赛时钟，刻度跟随比赛内容时长：5 分钟比赛显示 `MM:SS / 05:00`，90 分钟显示 `MM:SS / 90:00`（playTime 即比赛秒直接格式化）。

#### Scenario: 上半场结束（90 分钟比赛）
- **GIVEN** match_duration_seconds=5400、playTime=2700
- **THEN** 显示 `45:00 / 90:00`

#### Scenario: 全场结束（5 分钟比赛）
- **GIVEN** match_duration_seconds=300、playTime=300
- **THEN** 显示 `05:00 / 05:00`

## ADDED Requirements

### Requirement: 跳过机制

画面层 SHALL 跳过非精彩段：检测两个高亮事件之间的间隙（> 阈值），进入跳过模式——**快速播放（5x/10x 快进，比赛时钟快跳）或直接跳过（playTime 瞬跳到下一个高亮，时钟瞬跳）**，屏幕提供选项切换。高亮段正常速度播放。

#### Scenario: 间隙快速播放
- **GIVEN** 两个高亮事件间隙 > 阈值、跳过模式=快速播放
- **WHEN** 画面层进入该间隙
- **THEN** 以 5x/10x 快进（比赛时钟快跳），到下一个高亮恢复正常速度

#### Scenario: 间隙直接跳过
- **GIVEN** 两个高亮事件间隙 > 阈值、跳过模式=直接跳过
- **WHEN** 画面层进入该间隙
- **THEN** playTime 瞬跳到下一个高亮起点（球员位置靠 beat 锚点连续，无瞬移），时钟瞬跳

#### Scenario: 高亮正常播放
- **GIVEN** 处于高亮事件（shot/角球/界外球/头球/抢断）
- **WHEN** 画面层播放该段
- **THEN** 正常速度播放（按用户倍速）

### Requirement: 高亮事件识别

画面层 SHALL 识别高亮事件：shot / pass detail=corner|out_sideline|out_goal_line|clearance / tackle / 头球 = 精彩段；普通 pass + beat = 过渡（可跳过）。

#### Scenario: 识别高亮
- **GIVEN** 一条事件流
- **THEN** 高亮事件被识别为精彩段，普通 pass 与 beat 被识别为过渡段
