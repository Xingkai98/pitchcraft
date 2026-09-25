# 行为真实性：现有事件流可观测性盘点

> 这是 #13 的盘点资产；#15 的正式状态机与边界以 `.scratch/notes/match-behavior-observation-design.md` 为准。

日期：2026-09-22

> **入库注记（2026-09-26）**——本文件是当时的历史盘点，下列事实其后已被更正式的结论取代；
> 原文未改写（保留当时的判断），阅读时以注记为准：
>
> 1. **文中 `engine/src/lib.rs:21` / `:93` 的引用已漂移**（当时指事件类型与事件结构，现在分别是
>    注释行）。实际定义在 `engine/src/lib.rs` 的 `pub enum EventType` / `pub struct Event`；
>    同段 `MatchState` 的状态引用（`:2388` / `:2512`）同样失效。**行号引用不可信，按符号名查。**
>    文末 `viewer/protocol.js:83` 仍指向「校验单条事件的基础字段」，**未漂**。
> 2. **「事件流」一节列出的动作类型里，`dribble` / `interception` / `off_ball_run` 在真实比赛路径
>    中从不产生**——它们保留在 `EventType` 枚举里，但真实路径没有构造点。实测（300 场、175 万条
>    事件）只含 `beat / foul / kickoff / lineup / pass / shot / tackle / whistle`；拦截编码在
>    `pass.result` 内，带球只存在于 `beat.main`。权威表述见
>    `.scratch/notes/behavior-chain-baseline-2026-09-24.md` §4。当时是按「协议里声明的类型」盘点，
>    与本条不矛盾——但重建动作链时**不能假设这些顶类型事件存在**。
> 3. 文末「推荐实现顺序」1–6 步已由 #15A 实现（正式观察层落在 `engine/src/observation.rs`，
>    非事件文本启发式）；本文件的「最小协议提案」是其**草稿形态**，字段名与最终 sidecar 不同。

## 结论

当前引擎内部已经有足够多的状态，可以开始建立行为观察层；主要缺口不是内部状态不存在，而是这些状态没有成为事件流/诊断报告的正式语义。

当前最小路线：**保留正式演绎事件协议，增加只读的诊断投影**。第一轮不改随机决策、不改变事件顺序、不让 viewer 正式渲染依赖诊断字段。

## 已有能力

### 引擎内部

`MatchState` 已维护：

- `possession`：当前控球队；
- `carrier`：当前持球人；
- `ball_pos`：当前球位置；
- `pos[22]`：22 名球员位置；
- `loose` / `dead_ball` / `restart_prep`：松散球、死球和重开阶段；
- `transition`：球权易主后的反击窗口；
- `pressure_state_ticks`：持球者压迫状态；
- `shot_setup` / `shot_pending_after_pass`：射门前置过程。

证据：`engine/src/lib.rs:2388`、`engine/src/lib.rs:2512`。

### 事件流

现有事件已经能表达部分动作关系：

- `pass`：`from`、`to`、`interceptor`、`result`、落点和接球者位置；
- `dribble`：起点、终点、速度和触球频率；
- `shot`：射手、目标、结果、门将位置；
- `tackle`：抢断者、被抢者/持球者、松散球位置和结算位置；
- `foul`：犯规者、被犯规持球者、犯规类型和牌；
- `beat`：带球主体、松散球、跑位 movers。

事件类型和基础字段定义在 `engine/src/lib.rs:21`、`engine/src/lib.rs:93`；viewer 对各类型的必填约束在 `viewer/protocol.js:83`。

## 可重建程度

| 观察对象 | 当前可重建程度 | 说明 |
|---|---:|---|
| 粗粒度球权归属 | 部分可重建 | 可从 `from/to/interceptor/carrier` 和球员 id 推断，但没有显式控制权变化事件 |
| 球权开始/结束原因 | 部分可重建 | 抢断、拦截、出界、射门结果可推断；成功接球、二点球争夺、松散球最终归属缺少统一事件 |
| 动作链 | 可重建 | pass/dribble/shot/tackle 等可按时间串联，但需要处理高亮飞行时间和同一时刻 beat |
| 阶段 phase | 不可靠 | 有 `transition` 和射门前置状态，但没有统一的 build-up/progression/final-third 观察标签 |
| 球场区域 | 可重建 | 事件坐标和球员位置足够支持 zone；需统一主客进攻方向和边界 |
| 压力 | 部分可重建 | viewer 已能从位置推导最近防守人和传球走廊；引擎内部 pressure 状态不出流 |
| 团队宽度/纵深 | 部分可重建 | beat 提供 movers，不一定每拍提供完整 22 人快照；viewer 插值状态可用，但不能把它误称为事件原始观测 |
| 阵型/线间距 | 当前不稳定 | 有静态防线身份和 off-ball 目标，但角色/阵线语义尚未成为协议字段 |

## 关键缺口

1. **没有显式 `possession_id`**：下游需要重复猜测一段动作属于哪个球权。
2. **没有显式 `phase`**：`transition`、射门窗口和区域信息分散在内部逻辑中。
3. **没有统一的球权变化事件**：无法稳定区分“传球未到”“松散球仍在争夺”和“对手已控制”。
4. **事件时间主要是动作开始时间**：传球/射门的完成时间需用距离和速度推算，推算逻辑目前在 viewer 派生层。
5. **压力不是正式观测量**：viewer 的 `nearest_defender_distance`、传球走廊等特征属于事后审计派生，不是引擎诊断契约。
6. **beat 不是完整快照**：它表达变化中的 movers/main/ball，不保证每个时刻都有 22 人位置原样输出。
7. **死球与重开复用了 `pass`**：`corner`、`throw_in`、`free_kick` 依赖 `detail`，语义可用但需要在球权标注器中统一处理。

## 最小协议提案

第一轮不把这些字段塞进正式演绎协议，而是在引擎内部或导出诊断报告时附加：

```text
observation {
  event_index
  t_start
  t_end                // 可推算时填写，否则 null
  possession_id
  possession_team
  phase                // unknown 允许存在
  zone
  action_kind
  action_result
  possession_change    // none / contested / won / lost / dead_ball
  pressure_bucket     // unknown 允许存在
  chain_index
}
```

球权对象单独输出：

```text
possession {
  id
  team
  start_t
  end_t
  start_reason
  end_reason
  actions[]
  phase_segments[]
}
```

## 推荐实现顺序

1. 从正式事件流建立 `EventObservation` 纯函数，不改 `Event` JSON。
2. 先实现粗粒度球权边界：明确控制权变化才切换；争抢状态暂记 `contested`。
3. 用区域 + 动作结果 + 内部可导出的 transition hint 标注 phase；不能判断时写 `unknown`，不强行猜。
4. 把现有 viewer 的最近防守人/传球走廊计算抽成共享的诊断特征定义，避免引擎和 viewer 各自发明压力口径。
5. 生成 JSON/文本球权报告，跑 30–100 个 seed 建立 baseline。
6. 只有 baseline 稳定后，才决定哪些诊断字段值得进入正式协议。

## 不在本票据内

- 不改比赛生成逻辑；
- 不引入完整 tracking 数据管线；
- 不定义最终 tactical AI；
- 不把 `phase` 的不确定推断伪装成真实标签；
- 不先做 viewer overlay。
