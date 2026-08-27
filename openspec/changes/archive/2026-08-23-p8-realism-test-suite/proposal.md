# Proposal: 真实性统计测试套件（realism-test-suite）

## Why

项目现有分层验证（`verify.sh`：引擎 9 项 + viewer 52 项 + WASM e2e）全部验证的是**正确性**，不是**真实性**。比赛效果真实性目前唯一的检查是「浏览器人工验收」——引擎里所有硬编码概率（射门 15/35/50、头球 12/38/50、tackle 50/50、槽位 30/12/18/22/18、扑出 caught/rebound 40/60）只写在代码注释里，没有任何测试守护。改错一个概率或弄反一个分支，人眼要盯几百场才可能发现。

研究报告 `research/2026-08-23-match-realism-testability/` 的 P0 结论：引擎是确定性种子 RNG，同 seed 必产同事件流 → **多 seed 统计分布测试完全可复现、永不 flaky**。真实性可分三层（L1 规格一致性 / L2 过程真实性 / L3 真实数据参考带），本 change 做 A 档的前两层 + golden master；L3 参考带另立 gate（当前集锦模型会大面积不过，需先定目标档位）。

## What Changes

- **`engine/tests/realism.rs`**：新增引擎集成测试（纯 Rust，零新依赖）——
  - **L1 统计分布断言**（200 seed 聚合）：普通射门 goal/saved/off_target ≈ 15/35/50（detail=header 分流）；头球 ≈ 12/38/50（chi-square GOF）；tackle 成功率按稀释模型断言（overall + close 带）；槽位相对 mix（普通射门:tackle 比值）；角球场均带 + 单场硬上界。
  - **L2 过程真实性 / 不变量**（任意 seed 都成立，默认 `cargo test` 就跑）：比分 == goal 事件计数；射门落点在球门矩形内（goal/saved y∈[0.455,0.545]，off_target 贴柱偏出）；beat 间隙 ∈{1,2}s、无 >2s 间隙；射门/传球/头球速度在声明的物理区间；carrier ≤ 5 m/s、跑位 ≤ 8.1 m/s（重开走位 8 m/s 例外）；门将位置贴门线；全部事件 t ∈ [0, dur]。
  - **Golden master**：10 个 canary seed（1..=10）的统计摘要 + 事件流哈希，防静默漂移；`ACCEPT_GOLDEN=1` 显式重基线。
  - **覆盖边界**：统计层直接守护射门/头球结果、tackle 稀释、槽位相对 mix、角球场均带；**扑出 caught/rebound 40/60、槽位 corner/throw_in/pass 比例、出界率等没有统计带**——它们由 golden master 全流哈希守护（seed 1..=10 任何改动即哈希不一致红掉）。
- **`verify.sh`**：加第 4 步跑 realism 套件。

## Capabilities

### New Capabilities

- **引擎统计一致性测试**：硬编码概率的观测比例被置信区间断言守护（实现 vs 规格）。
- **引擎过程真实性测试**：事件流跨事件不变量（比分/落点/节拍/速度/门将/时间范围）。
- **Golden master 防漂移**：10 canary seed 全流哈希对比，任何静默改动即报错。

### Modified Capabilities

- `match-engine`：无引擎逻辑改动；新增测试文件 `engine/tests/realism.rs`。
- `verify.sh`：新增第 4 步。

## Impact

- 引擎：新增 `engine/tests/realism.rs`（不改 `lib.rs` 逻辑，仅修头球注释）。
- 验证脚本：`verify.sh` 加第 4 步（L1 统计 release 显式跑）。
- 测试：新增 4 个测试函数。L2/golden 默认 `cargo test` 自动包含；L1（`#[ignore]`）由 verify.sh 第 4 步 `cargo test --test realism --release -- --ignored` 显式运行——plain `cargo test` 不跑 L1。
