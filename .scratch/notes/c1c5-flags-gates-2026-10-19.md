---
title: C1–C4 开关打开的验收回路（L1 体量 / P38 判据 / C3–C4 探针）
date: 2026-10-19
branch: feat/c1-c5-match-realism
based_on_commit: 1cc056b0e6330fce617d4c5c5b37f8e170ff9293
status: report-phase
---

# C1–C4 开关打开的验收回路

补这条回路的原因：`verify.sh` 的 L1 只在 `realism` 全关下跑；C1–C4 打开后的射门/抢断/
犯规三条带会破，但旧回路**看不见**（#175 评论已记录「开关默认关 ⇒ 打开时没有统计带保护」）。

本文件记录回路本身与 2026-10-19 的实测读数。**回路只加旁路探针 / 测试，不改引擎决策**；
`realism_probe_is_sidecar_only` 守住「加探针前后事件流逐字节相同」。

> **后续（2026-10-19）**：探针发现的 C3 身份错位与 C4 仲裁已被修复，修复后读数见
> `c3c4-arbitration-2026-10-19.md`。**本文件的数字保留为修复前基线**，不要与修复后混用。


## 怎么跑

```sh
# 1) 开关打开的 L1 体量报告（默认 60 场，约 60s；REALISM_GATES 未设时测试自动跳过）
REALISM_GATES=1 REALISM=motion+formation+marking+press \
  cargo test --manifest-path engine/Cargo.toml --test realism --release \
  -- --ignored l1_volume_bands_with_realism_flags --nocapture

#    严格门：与主 L1 相同的 200 场窗口（约 157s），任一破带 exit 非 0
REALISM_GATES=1 REALISM_GATES_STRICT=1 REALISM=motion+formation+marking+press \
  cargo test --manifest-path engine/Cargo.toml --test realism --release \
  -- --ignored l1_volume_bands_with_realism_flags --nocapture

# 2) C3/C4 旁路探针（3 场，约 2s）
cargo test --manifest-path engine/Cargo.toml --test realism --release \
  -- --ignored realism_probes_report --nocapture

# 3) P38 八条判据（经 tools/benchmark-engine.mjs 读 REALISM）
REALISM=motion+formation+marking+press \
  node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs
```

`verify.sh` 已接为 7b/7c/7d 三个步骤：**7b/7d 是报告期**（不阻塞；7b 的破带/样本不足
在默认模式只打印），**7c 是探针接线检查**（断言探针不变量，不是引擎达标门）。
C2/C3 修到带内后，运行 `REALISM_GATES_STRICT=1 ./verify.sh` 即把 7b 升为硬门。

## 修复前基线（2026-10-19，HEAD 1cc056b + 本回路改动；后续 C3/C4 修复见另一份 note）

### L1 体量（seed 窗口 401..600，与主 L1 相同）

| 配置 | 普通射门/场 | 抢断/场 | 犯规/场 | 传球成功率 | 通过 |
|---|---|---|---|---|---|
| L1 带 | [14, 29] | [24, 50] | [16, 30] | [0.82, 0.90] | — |
| 全关（旧路径，参照） | 21.97* | 41.5* | 19.57* | 0.842* | 4/4 |
| C1–C4 全开，200 场 | **8.195** | **126.325** | **36.245** | 0.8391 | **1/4** |
| C1–C4 全开，60 场（报告步默认） | 7.783 | 125.400 | 36.017 | 0.8382 | 1/4 |

\* 全关读数是 30 seed × 5400s 的独立探针（Node，seed 1..30），只作参照；同一 wasm 上
C1–C4 的 30 seed 读数为 7.53 / 121.37 / 34.90 / 0.8395，与上表的 seed 窗口读数一致。

### P38 八条判据（10 seed，报告期）

P38 内部 4/8 未达标：纵深 20.802（带 [23.385, 28.385]）、紧凑度 12.625（[13.41, 17.01]）、
横向位移 sd 5.643（[7.015, 14.015]）、y 两两相关 0.191（[0.451, 0.891]）。
其余四条按 P38 自己的阈值通过：重心间距 10.093、断层幅度 6.578、各线均衡 1.117、
普通射门/场 6.0。⚠️ 射门 6.0 **只过 P38 的单边 ≥5.5 报告期护栏**，既不是 L1 的 [14,29]
体量带，也不代表引擎射门体量已接近真实（L1 全开读数 8.195，见上表）。

### C3/C4 探针（3 场，seeds 401–403，C1–C4 全开）

| 量 | 读数 |
|---|---|
| marking 调用 | 16,012（≈5,332/场，正常开放局一拍一次） |
| 盯人分配 / 调用 | 145,284 / 16,012 ≈ 9.07 人 |
| **换盯人对象 / 调用** | **20,312 / 16,012 ≈ 1.27**（几乎每次 mover 生成都有换人；按防守者 id → **进攻者 id** 对齐；跨未匹配段换目标仍计数，`Some→None` 本身不计） |
| 未匹配防守者 / 调用 | 6,571 / 16,012 ≈ 0.41 人 |
| **换人惩罚下标错位 / 分配** | **10,787 / 145,284 ≈ 7.4%**（`mark_prev` 的下标在当前 `att_ids` 里指向另一个进攻者、已越界，或 `prev` 位置已属于另一名防守者） |
| press 调用 / 门控通过 | 16,012 / **8,927**（门控通过率 55.8%） |
| **门控通过后实际派出压迫者的调用** | **308 / 8,927 ≈ 3.5%**（直方图 `[15704, 308, 0, …]`；当前最多 1 人/次，故调用数 = 人次 308） |

两个机制诊断（由探针直接给出，下一轮 design 要处理）：

1. **换人惩罚没有压住抖动**：`SWITCH_PENALTY_S=0.8` 小于「5m 距离差 ≈ 0.9s」，
   贪心几乎每次都能找到一个更近的对手 ⇒ **1.27 次/调用**。这与方向一致性从 0.72 掉到 0.49
   （真实 0.70）一致。
   ⚠️ **归因混淆项（审阅 P2，已量化）**：换人惩罚本身仍用现有的 **`att_ids` 下标口径**
   `mark_prev`，持球者变化时同一下标可能指向另一个进攻者。探针的只读计数显示
   **7.4% 的分配存在这种错位（含越界/防守者位置变化）**——惩罚可能被施加到错误目标上。因此 1.27 只能说明
   「换人频繁」，**不能单独证明是惩罚常数太小**；下一轮修 C3 时先把 `mark_prev`
   也改成进攻者 id 口径（与探针一致）再归因。本回路不改行为。
2. **C4 压迫被 C3 架空**：`apply_marking` 先把约 9 名防守者标成 `mark`，`apply_pressure`
   只从 `action == "run"` 里选人。**门控通过的 8,927 次里只有 308 次（3.5%）还能找到人**；
   其余不是「球不在本方半场」（已由 `press_gate_passed` 单独计数），而是没有空闲防守者。
   这正是 C4 对 like-football 距离增量 ≈0 的机制解释（0.245 → 0.246）。

## 改动清单

- `engine/src/lib.rs`
  - `RealismProbeReport`（`marking_calls/assignments/switches/unmatched/
    prev_index_mismatches`、`press_calls/press_gate_passed/pressers_total/press_players_hist`）；
  - `simulate_with_realism_probe(seed, cfg) -> (json, probe)`（旁路；事件流不变）；
  - `match_events` 内部返回 `(events, probe)`；`simulate` 签名与行为不变；
  - `apply_marking` 计数（`mark_prev_ids` 按防守者 id → **进攻者 id** 对齐；换防守方时
    `mark_prev_team` 重置探针状态）；`apply_pressure` 返回实际压迫人数并累计门控通过；
  - 判别性单测 `c3_probe_switch_counts_by_attacker_id_not_index`（下标平移不得误计、
    真实换人必须计、跨防守回合必须重置）与 `c3_probe_switch_survives_unmatched_defender`
    （`out[k]=None` 不得清空上次目标）；对「存下标」「去掉回合重置」「None 分支清空」
    三个变异均实测变红。
- `engine/tests/realism.rs`
  - `aggregate_with(seed, flags)` / `run_many_with`；
  - `l1_volume_bands_with_realism_flags`（报告/严格门，`REALISM_GATES` 控制；
    破带与样本不足在报告模式只打印）；
  - `l1_volume_band_evaluator_rejects_bad_input`（反证条：空输入全 FAIL、带内输入全 PASS）；
  - `realism_probes_report`（换人 / 未匹配 / 门控通过 / 压迫直方图；跟随 `REALISM`）；
  - `realism_probe_is_sidecar_only`（加探针前后事件流逐字节相同）。
- `verify.sh`：7b/7c/7d 接入；第 7 步 `--skip` 掉两条专用测试（避免重复/误红）；
  7d 前打印 `src/wasm` 的 sha 前缀，并对「wasm 旧于源码」给出（弱）mtime 警告。
- `check-criteria.mjs`：头部写清 `REALISM` 跑法；wasm 缺失仍跳过，**评测器真崩时 exit 2**
  （不再静默 exit 0）。

## 口径与限制（如实记）

- 探针计数单位是**每次 `compute_mover_candidates` 调用**（代码按调用计；实测 3 场
  `marking_calls=5332–5342 < 5400 tick`，未见一拍多次；若未来特殊分支一拍多次，`calls`
  会大于 tick 数）。报告里同时印 `calls` 作分母。
- 探针报告跟随 `REALISM`（不设 = C1–C4 全开），并在每行印出开关组合；关掉的项
  断言其探针恒为 0（兼作「探针只在开关打开时接线」的守卫）。`verify.sh` 7c 跟随
  `REALISM_FLAGS`，与 7b/7d 同配置。
- L1 报告步默认 60 场（约 60s），严格门 200 场（约 157s）；两者同一 seed 窗口。
- 7b/7d 是**报告期**：当前 C1–C4 全开 1/4 通过。把 `REALISM_GATES_STRICT=1` 打开会立刻红——
  这是预期的，等 C2/C3 机制修正后再升门。7c 是**探针接线检查**（断言探针不变量），
  预期常绿；它的红表示探针坏了，不是引擎达标了。

## Provenance

- 基线 commit：`1cc056b0e6330fce617d4c5c5b37f8e170ff9293`；落地 commit **`2bcb082`**
  （`feat/c1-c5-match-realism`）。
- `sha256(engine/src/lib.rs)` = `a1584799cfc7dc7d03870929cb6d21cdea9ed3354212a0f9d4039cd14ff3bf00`
- `sha256(viewer/engine.wasm)` = `6196ce3ed8c3939c9c5037344eb88b56d66c6cd97d56687b20c21953a780bd9d`
- `sha256(git diff)` = `e41d171d43572c2d6d5a8bd55fbd5c17e25aba8af51a9cee12f8eaee8b4fed99`
- L1 表来自 `cargo test` 现编译源码；P38 表来自 `viewer/engine.wasm`。两者行为一致由
  `realism_probe_is_sidecar_only`（探针旁路）与 golden/L2（默认路径）守护。
- 除非另注，所有表/探针的 `REALISM` = `motion+formation+marking+press`（不含 C5）。
  全关参照是 Node 探针的 30 seed × 5400s（seed 1..30）。
