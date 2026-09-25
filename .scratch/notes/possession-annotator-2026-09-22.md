# 球权与阶段标注器（Prototype）

> 历史原型记录；正式语义以 `.scratch/notes/match-behavior-observation-design.md` 为准。

日期：2026-09-22

> **入库注记（2026-09-26）**——本文件记录的 `tools/behavior-observer-prototype.mjs` 是**原型**，
> 已被 #15A 取代。原文未改写，阅读时以注记为准：
>
> 1. **「当前契约」一节的字段不是正式 sidecar 的形状**。正式观察层在
>    `engine/src/observation.rs`（`ControlFact` / `PossessionEpisode` / `RestartSequence` /
>    `DiagnosticMatch`），由引擎内部状态提交点产生，**不从事件文本事后重构**——
>    这是 #13 盘点时定下的方向（「正式事件流不变 + 只读诊断投影」），原型的
>    `EventObservation` 只是它的草稿形态。
> 2. 原型本身仍在本仓（`tools/behavior-observer-prototype.mjs` + 其 `.test.mjs`），
>    但**不再是权威语义来源**；它的 `phase` 是启发式标签（原文 §当前限制 4 已自述）。
> 3. **§当前限制第 5 条已过期**：它说「先用 `#16` 的空间特征和 `#17` 的报告验证」——
>    该编号体系已重排为 #16（空间特征）→ #17B（可解释报告），且 #15B（phase）**排在它们之前**，
>    是本路线当前的 frontier。
> 4. **§已确定的边界**（成功传球保持球权、`lost` 记 `contested`、拦截/抢断切换控制权、
>    犯规后的任意球作为新的 `set_piece` 段）已被 #15A 吸收并形式化——这些结论仍成立，
>    实现位置改为 `observation.rs`。
代码：

- `tools/behavior-observer-prototype.mjs`
- `tools/behavior-observer-prototype.test.mjs`

## 当前契约

`observeMatch(events)` 返回两部分：

```text
{
  observations: EventObservation[],
  possessions: Possession[]
}
```

每条 `EventObservation` 包含：

- `event_index`
- `t_start` / `t_end`
- `possession_id` / `possession_team`
- `phase`
- `zone`
- `action_kind` / `action_result`
- `possession_change`
- `chain_index`

每段 `Possession` 包含：

- `id` / `team`
- `start_t` / `end_t`
- `start_reason` / `end_reason`
- `actions[]`
- `phase_segments[]`

## 已确定的边界

- 成功传球：保持同一球权，动作链继续。
- 拦截：在拦截发生的控制权变化处关闭旧球权，下一方开启新球权。
- `lost` 传球：标记 `contested`，不立即宣称对手已经控制；等下一次明确动作决定是否转换。
- 抢断：抢断者作为控制权变化候选。
- 出界：在估算的动作完成时间关闭为 `out`。
- 射门：关闭当前开放比赛球权为 `shot`/死球状态；后续扑救、角球或开球由下一段重开处理。
- 犯规：关闭为 `foul_restart`；任意球 pass 作为新的 `set_piece` 阶段动作。
- `phase` 仍是启发式标签；无法可靠推断时必须允许 `unknown`，不能伪装成真实战术标签。

## 验证

边界测试 6 项全部通过：

```bash
node --test tools/behavior-observer-prototype.test.mjs
```

在一场 600 秒真实引擎输出上的 sanity check：

- 649 个原始事件；
- 56 个可观察动作；
- 13 个球权段；
- 4 次 `control_change`、5 次犯规重开、3 次出界、1 次哨声结束；
- 2 次 `lost`、2 次 `contested`，没有把它们直接误判为对手已控球。

## 当前限制

1. `interception` / `tackle` 的最终控制权仍依赖事件主体语义，正式协议应补统一的 `control_change` 事件或字段。
2. 动作完成时间由距离和速度估算；没有明确的 receive / ball_won 时间点时只能作为诊断近似。
3. 射门后的 saved/rebound/corner 仍需要与死球/松散球状态进一步对齐。
4. 阶段判断当前只使用区域、动作类型和球队变化，下一步应结合 `transition` hint 与空间特征。
5. 当前实现是原型，不应直接作为正式引擎领域模块；先用 `#16` 的空间特征和 `#17` 的报告验证它是否足够稳定。
