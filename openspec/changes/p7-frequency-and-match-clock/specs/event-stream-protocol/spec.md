# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 比赛时长参数透传

事件流协议 SHALL 透传比赛时长：`match_duration_seconds` 由调用方指定（默认 5400s=90 分钟），事件流 t 字段即比赛秒。观看时长（播放压缩）是 viewer 配置，不进入事件流。

#### Scenario: 90 分钟事件流
- **GIVEN** match_duration_seconds=5400
- **THEN** 事件流末尾 whistle 的 t=5400（90:00），t 字段即比赛秒
