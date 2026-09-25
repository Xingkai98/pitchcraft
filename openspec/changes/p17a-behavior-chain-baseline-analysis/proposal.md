## Why

#15A 已能可靠输出 `ControlFact` / `PossessionEpisode` / `RestartSequence`，但仓库里还**没有**任何消费这些数据的分析器：现有 `tests/realism.rs` 的 L1/L3 门算的是**场均统计量**（射门数、犯规数、传球成功率），而 `tools/behavior-*.mjs` 是早期**事件文本启发式原型**（`#14` 已明确要求由 #15 重算语义）。结果是：我们知道「射门 6–11/场、犯规 16–30/场在带内」，却不知道一场比赛里球权**如何**建立、延续、争抢、丢失和重开，也无法为 #19 的最小生成改造提供**改动前基线**与**可回放异常样本**。

两类缺陷因此长期不可见：

- **过程缺陷**：动作链形状不像足球（例如持球-出球节奏、丢球后归属、重开后被立即夺回），这些在场均统计上完全看不出来，因为它们不改变任何场均计数。
- **口径漂移**：没有固定的 seed 集、配置与 sidecar schema 指纹，任何「改了之后看起来好一点」的结论都不可复现，也无法区分真实改进与换了一批 seed。

## What changes

- 新增一个 **编译型 Rust 分析器**（`engine/tests/p17a/` + `engine/tests/p17a_behavior_chain_baseline.rs`），只读消费 `simulate_with_behavior_observations()` 返回的公开 `DiagnosticMatch`，**不新增生产 API、不读私有状态**。
- 默认基线固定 **300 seed × 90 分钟**（`1..=300`），另提供 **canary 模式**（`1..=30`，为基线的前缀子集）用于快速迭代。两者都用**同一份**指标口径与同一套异常规则。
- 指标分四组：**possession 形状**、**控制权转换**、**重开质量**、**动作链 motif**（逐条定义见 design.md 的口径表）。
- 产出**机器可读 JSON**（`baseline.json` / `canary.json`）与**人可读 Markdown**（`baseline.md` / `canary.md`），后者含 5–10 条高影响异常模式，每条带数量证据、回放定位（seed/时间/episode/restart/事件下标）、为什么不像足球、最可能的生成机制假设、以及还缺什么 phase/空间证据。
- 产出**可复现命令**：`cargo test --release --test p17a_behavior_chain_baseline -- --ignored`，并把源码 commit、config、sidecar schema 指纹、seed 集与聚合口径写进产物 provenance。
- 增加**快速语义测试**（默认 `cargo test` 跑）与**确定性测试**（同输入两次运行输出逐字节相同），并配**防空转下限**。

## Non-goals

- 不在本 change 内修改比赛生成、RNG 行为、`simulate()`、正式事件流协议或 viewer 正式播放。
- 不修改 `engine/src/observation.rs` 的 sidecar 语义；不新增生产代码路径。
- 不实现 #15B 的 PhaseAnnotator、#16 的空间特征（分析器只在能从 sidecar 可靠取到的字段上计算，缺数据时显式记 `unknown`，不猜）。
- 不把「场均统计偏差」当作异常；异常必须以**动作链**和**可回放样本**为证据。
- 不因为发现异常就调参数——本 change 只做诊断与样本选择（#19 才改生成）。
