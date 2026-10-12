# Spec: match-audit

## ADDED Requirements

### Requirement: 整场滑窗门（spacing-sweep）并发执行与串行等价

`tools/spacing-sweep.mjs`（同队间距整场滑窗门）SHALL 支持按 seed 并发执行，且并发结果与串行**逐位一致**：每个 seed 的窗口数、finding 数、最恶劣间距、输出行（`stdout`）内容与顺序（= 入参 seed 序，与完成顺序无关）以及进程退出码 SHALL 全部相同。

并发 SHALL 以「每个并发单元持有独立引擎实例」实现——引擎实例是**有状态**的（`simulate` 写线性内存，随后由 `get_json_ptr`/`get_json_length` 读回），同一实例 SHALL NOT 被跨 seed 并发复用。

SHALL NOT 为提速改动 `DUR`、`STEP`、默认 seed 集、detector 阈值或 audit profile；并发度 SHALL 可配置（`SWEEP_CONCURRENCY`），非法值 SHALL 报错而非静默回落到某个默认值。

退出码语义 SHALL 保持：任一 seed 出现 finding ⇒ `1`；引擎产物缺失 ⇒ `2`；否则 `0`。并发单元的异常退出或失败 SHALL 导致**非零**退出码，SHALL NOT 被静默当作「门通过」。

#### Scenario: 并发与串行逐位一致

- **WHEN** 以同一 seed 集合、同一 `DUR`/`STEP` 分别跑并发与串行路径
- **THEN** 两条路径的「每 seed 窗口数 / finding 数 / 最恶劣间距」逐位相同，输出行逐字相同，退出码相同

#### Scenario: 结果按入参 seed 序输出

- **WHEN** 以种子顺序 `[42, 1, 2]` 并发执行，且 seed 1 先于 seed 42 完成
- **THEN** 输出行序仍为 `42, 1, 2`（完成顺序不影响输出顺序）

#### Scenario: 每个 seed 恰好执行一次

- **WHEN** seed 数多于并发单元数（需要多轮分发）
- **THEN** 每个 seed 恰好被扫描一次，既不遗漏也不重复

#### Scenario: finding 仍使退出码为 1

- **WHEN** 任一 seed 的任一滑窗产出 `player_overlap` finding
- **THEN** 进程退出码为 `1`（并发不改变门语义）
