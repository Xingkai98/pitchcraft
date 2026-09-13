# Tasks: 出界事件协议迁移

## P1. 引擎出界事件字段

- [x] P1.1 Event struct 加 `out_pos: Option<(f64,f64)>` + to_json 输出（含 out_side）
- [x] P1.2 `emit_pass_out_play_slot`：result 改 `out`、加 `out_side`、out_pos 存真实越界值、x2/y2 保留投影
- [x] P1.3 P6 普通传球出界（`emit_pass_highlight` allow_out 分支）：同上
- [x] P1.4 头球解围出界（clearance 分支）：同上

## P2. viewer 协议

- [x] P2.1 protocol.js pass detail 校验补 `out_side` 枚举（goal_line/sideline）

## P3. detector 出界证据

- [x] P3.1 `outEvidenceOf` 优先 `result='out'`，兼容 out_side/detail/几何
- [x] P3.2 `classifyPassOutcome` 同步

## P4. golden 版本分离

- [x] P4.1 MatchConfig 加 model_version；golden 测试按版本目录读写
- [x] P4.2 v2 重基线（golden-v2 目录），v1 保留

## P5. 测试 + 收尾

- [x] P5.1 出界 pass 字段断言（result=out / out_side / x2y2∈[0,1] / out_pos 可越界）
- [x] P5.2 事件数量逐 seed 对比 v1 一致（只字段值变）
- [x] P5.3 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [x] P5.4 独立 subagent 审阅闭环

## 实施备注

- P5.2 的两处落地：`engine/tests/realism.rs::gm_v1_regression_counts_unchanged`（永久回归，
  逐 seed 对比 v1 基线 28 个计数字段 + stream_hash 必须变）+ `tools/d6-stream-compare.mjs`
  （逐字段对比 pre/post wasm，实测 seed 1-200 零差异）。
- P5.4 审阅闭环：两轮、每轮两个独立零记忆 agent（claude/fable-5 + codex/gpt-5.6-sol）。
  第一轮 1 个 P0（model_version 语义）+ 若干 P1/P2/P3，已全部修复；第二轮无 P0/P1。
- **实施修正（用户批准）**：D3 原文「飞行时间/方向计算用真实终点」未实现——与 D6 硬验收矛盾，
  改用 variantC（out_pos 存真实越界值 + 两个回灌点 clamp + 飞行时长用投影点近似）。见 design.md D3/D6。

## 关联

- #25 阶段 1；P21 detail 治标简化；golden 策略 D5
