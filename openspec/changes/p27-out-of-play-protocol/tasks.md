# Tasks: 出界事件协议迁移

## P1. 引擎出界事件字段

- [ ] P1.1 Event struct 加 `out_pos: Option<(f64,f64)>` + to_json 输出（含 out_side）
- [ ] P1.2 `emit_pass_out_play_slot`：result 改 `out`、加 `out_side`、out_pos 存真实越界值、x2/y2 保留投影
- [ ] P1.3 P6 普通传球出界（`emit_pass_highlight` allow_out 分支）：同上
- [ ] P1.4 头球解围出界（clearance 分支）：同上

## P2. viewer 协议

- [ ] P2.1 protocol.js pass detail 校验补 `out_side` 枚举（goal_line/sideline）

## P3. detector 出界证据

- [ ] P3.1 `outEvidenceOf` 优先 `result='out'`，兼容 out_side/detail/几何
- [ ] P3.2 `classifyPassOutcome` 同步

## P4. golden 版本分离

- [ ] P4.1 MatchConfig 加 model_version；golden 测试按版本目录读写
- [ ] P4.2 v2 重基线（golden-v2 目录），v1 保留

## P5. 测试 + 收尾

- [ ] P5.1 出界 pass 字段断言（result=out / out_side / x2y2∈[0,1] / out_pos 可越界）
- [ ] P5.2 事件数量逐 seed 对比 v1 一致（只字段值变）
- [ ] P5.3 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P5.4 独立 subagent 审阅闭环

## 关联

- #25 阶段 1；P21 detail 治标简化；golden 策略 D5
