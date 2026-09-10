# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 比赛时长是单一可配置参数，界面不提供切换

画面层 SHALL 将比赛内容时长实现为单一可配置参数（当前值为 5 分钟），并在初始化时按该参数请求引擎模拟；界面 SHALL 不提供时长切换入口。改配置值即改比赛时长，无需改画面层逻辑。

#### Scenario: 按配置的时长模拟
- **GIVEN** 配置 `playback.matchDuration` 为 5
- **WHEN** 页面初始化并加载引擎
- **THEN** 以 5 分钟（300 秒）为 `match_duration_seconds` 调用引擎模拟

#### Scenario: 界面无时长切换入口
- **GIVEN** 页面已加载
- **WHEN** 用户查看播放控制区
- **THEN** 不存在「切换比赛时长」的按钮或控件

#### Scenario: 改配置即改时长
- **GIVEN** 开发者将配置 `playback.matchDuration` 改为 90
- **WHEN** 页面重新初始化
- **THEN** 以 90 分钟调用引擎模拟，无需修改画面层代码逻辑
