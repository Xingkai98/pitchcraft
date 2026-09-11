# Spec: match-observation

## ADDED Requirements

### Requirement: 观察诊断前需确认事件锚点

已提交的观察 SHALL 在进入诊断前经过「事件锚定确认」：页面/CLI/对话 SHALL 能将观察描述锚定到窗口内的事件 index 集合，确认产物 SHALL 持久化到任务。未确认前诊断 SHALL 不启动（非 queue-only 服务亦同）。

#### Scenario: 提案后等待确认
- **GIVEN** 一个已入队的观察任务
- **WHEN** 提案运行（模型选出候选事件，或无可选时回退为空）
- **THEN** 任务状态转为 `awaiting_confirmation`，展示候选事件与锚点漂移提示

#### Scenario: 确认锚定后进入诊断
- **GIVEN** 任务处于 `awaiting_confirmation`
- **WHEN** 用户通过页面/CLI/对话确认事件 index 集合
- **THEN** 任务状态转为 `confirmed`，诊断以确认的 index 集合为锚点运行

#### Scenario: 无模型时用户从全量列表选
- **GIVEN** 提案运行但无可用模型
- **WHEN** 任务进入 `awaiting_confirmation`
- **THEN** 展示窗口全量高亮事件列表供用户勾选，无需模型
