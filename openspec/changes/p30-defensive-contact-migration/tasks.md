# Tasks: 防守接触竞争迁移（#25 阶段 2C）

## P1. 三层 cooldown 状态

- [ ] P1.1 `tackle_cooldown[22]`（defender 级 3-5s）
- [ ] P1.2 `last_contact_pair` + `contact_age_ticks`（pair 级 5-8s）
- [ ] P1.3 `foul_cooldown_ticks` 复用（全局 11s）

## P2. 防守动作打分

- [ ] P2.1 `score_tackle` / `score_foul` / `score_contain` / `score_jockey` 纯函数
- [ ] P2.2 `evaluate_defensive_action` 打分选一

## P3. 删 same_pair/far + 犯规并入

- [ ] P3.1 `emit_tackle_highlight_impl` 删 same_pair/far，结果两态
- [ ] P3.2 `maybe_open_foul` 并入防守打分（同窗口竞争）

## P4. contain/jockey 状态

- [ ] P4.1 contain/jockey 只调 pressure_state，不产事件

## P5. golden v4 + 频率断言

- [ ] P5.1 golden v4 重基线，v1/v2/v3 保留
- [ ] P5.2 频率断言改方向性（tackle ≠ 槽数量）

## P6. 测试 + 收尾

- [ ] P6.1 纯决策测试（cooldown/吃黄打折/打分选一）
- [ ] P6.2 三层 cooldown 行为测试
- [ ] P6.3 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P6.4 独立 subagent 审阅闭环

## 关联

- #25 阶段 2C；不碰事件协议/viewer；阶段 3 后续
