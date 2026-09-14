# Tasks: 防守接触竞争迁移（#25 阶段 2C）

## P1. 三层 cooldown 状态

- [x] P1.1 `tackle_cooldown[22]`（defender 级 3-5s）
- [x] P1.2 `last_contact_pair` + `contact_age_ticks`（pair 级 5-8s）
- [x] P1.3 `foul_cooldown_ticks` 复用（全局 11s）

## P2. 防守动作打分

- [x] P2.1 `score_tackle` / `score_foul` / `score_contain` / `score_jockey` 纯函数
- [x] P2.2 `evaluate_defensive_action` 打分选一

## P3. 删 same_pair/far + 犯规并入

- [x] P3.1 `emit_tackle_highlight_impl` 删 same_pair/far，结果两态
- [x] P3.2 `maybe_open_foul` 并入防守打分（同窗口竞争）

## P4. contain/jockey 状态

- [x] P4.1 contain/jockey 只调 pressure_state，不产事件

## P5. golden v4 + 频率断言

- [x] P5.1 golden v4 重基线，v1/v2/v3 保留
- [x] P5.2 频率断言改方向性（tackle ≠ 槽数量）

## P6. 测试 + 收尾

- [x] P6.1 纯决策测试（cooldown/吃黄打折/打分选一）
- [x] P6.2 三层 cooldown 行为测试
- [x] P6.3 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [x] P6.4 独立 subagent 审阅闭环

## 审阅闭环

- 独立零记忆 codex（gpt-5.6-sol）三轮审阅：第一轮 2 P1 + 2 P2 + 2 P3 → 全部修复；
  第二轮 1 P1 + 1 P2 → 处置（HA 预注册纪律 + cooldown 写读闭环测试）；第三轮 **通过，无遗留问题**。
- 每轮均含独立变异验证（删/改守卫 → 对应测试变红）。

## 关联

- #25 阶段 2C；不碰事件协议/viewer；阶段 3 后续
