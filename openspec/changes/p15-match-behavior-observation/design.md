## Source of truth

完整设计与审阅结论记录在 `.scratch/notes/match-behavior-observation-design.md`，状态为 Approved for implementation（2026-09-23）。本 change 不复制另一套枚举或状态表，避免规范漂移。

## Architecture

```text
MatchState transition commit
  -> BehaviorObservationRecorder
  -> DiagnosticMatch sidecar
```

Recorder 是 append-only、无 RNG、不可参与决策的观察器。正式模拟路径在 recorder 关闭时必须与当前实现保持一致。

## Slice order

1. 定义 Rust 数据类型和闭集枚举。
2. 接入 kickoff/restart、控制建立/释放、争抢、射门 finalize、犯规、出界和哨声提交点。
3. 增加手写路径 fixture 与固定 seed 集成测试。
4. 证明 recorder on/off 不改变正式事件、输出和 RNG。
5. 在 #15A 稳定后再实现 #15B phase annotator。

## Prototype disposition

`tools/behavior-observer-prototype.mjs` 保留在本 change 作为已通过的语义回归夹具。它基于事件流启发式推断，不能被正式 recorder 调用，也不能被用来证明 engine 已经记录了真实控制事实。
