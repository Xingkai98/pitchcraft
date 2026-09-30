# P17B 审阅记录（Slice 5）

本文件按本仓强制流程（`CLAUDE.md` §3）记录**独立审阅**：每轮由**零本 change 上文**的
独立 agent 审查 → 修复 → 再审阅 → 直到全部通过。

**审阅者须知（如果你是审阅者，先读这段）**：

- 你**没有**本 change 的任何上文。全部信息在仓库文件里，**以文件为准，不以本文件的转述为准**。
- **不要相信本文档的任何断言**——它是被审者写的。你要独立核对。
- 本仓最常犯的三族缺陷（`[[conclusion-right-mechanism-wrong]]` /
  `[[false-coverage-handoff-claims]]` / `[[mutation-red-must-rule-out-compile-error]]`）：
  1. **结论对但机制错**：注释/文档说的机制，代码里不存在或不是那样。**读注释时要连
     「因为/原因是」一起核**——去代码里找那个机制；
  2. **假覆盖声明**：文档说「这一面由测试 X 覆盖」，而 X 的断言体根本管不到那一面。
     **读 X 的断言体**，必要时**做定向变异**看 X 会不会红；
  3. **变异判红要排除编译失败**：Rust 的 exit 101 兼含编译错误。要见到目标测试名 + `panicked at`，
     否则那是「没跑成」而不是「判红了」。
- **读代码会错**（本仓实测四次）。关键结论要**实跑**。探针用完即删，不入库。

## 本 change 的范围（供你定位，不是供你采信）

| 文件 | 是什么 |
|---|---|
| `engine/tests/p17b_diagnosis_report.rs` | 入口测试 + 全部门槛（25 条默认 + 2 条 `#[ignore]` 产物门） |
| `engine/tests/p17b/evidence.rs` | 证据边界表 + `Locus` 枚举 |
| `engine/tests/p17b/episode.rs` | 逐 episode 派生（动作链 / 尾部窗口 / 松散球段 / 异常筛选） |
| `engine/tests/p17b/reasons.rs` | 覆盖声明（争抢成因 / P17A 异常规则）+ 措辞规则 |
| `engine/tests/p17b/report.rs` | JSON / Markdown / provenance / L2 聚合 |
| `openspec/changes/p17b-explainable-diagnosis-report/` | design / proposal / spec / tasks |

**三条不可越界**（设计定死，你必须独立核实）：
1. **零 `engine/src/` 改动**（`git diff main --stat -- engine/src` 应为空）；
2. **不报相位**（`build_up` / `progression` / `final_third` / `attacking_transition` / `Phase`
   不得出现在 `tests/p17b/{evidence,episode,reasons}.rs` 的**非注释**行；`report.rs` 被排除，
   因为它经 `crate::model` 的 sidecar 指纹**正确地**触及 `Phase`）；
3. **不产生 pass/fail**（产物里不得有通过/失败判定或好坏标签）。

## 审阅轮次

（每轮由审阅 agent 追加自己的段落到下方；被审者不代写。）

### 轮次 1 — 待审
