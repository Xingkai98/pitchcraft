# Spec: diagnosis-runner

## MODIFIED Requirements

### Requirement: detector 出界证据契约认 detail

确定性审计的出界证据 SHALL 优先认定 `result === 'out'` 的 pass 事件为出界（主路径）；SHALL 兼容 `out_side`、`detail` 为 `out_sideline`/`out_goal_line`、以及落点几何出界作为次要证据分支。真实出界传球（`result:"out"` + `out_side`）SHALL 被判定为出界，而非 `unknown`。

#### Scenario: 显式 out 被判定出界
- **GIVEN** 一个 pass 事件 `result:"out"`、`out_side:"sideline"`
- **WHEN** 运行审计
- **THEN** 该事件被认定为出界（unforced_out 依据 nearest_defender_distance 产出 finding；pass_outcomes 计入 out_count）

#### Scenario: 兼容旧 detail 出界
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`（旧 bundle）
- **WHEN** 运行审计
- **THEN** 该事件仍被认定为出界（兼容分支）
