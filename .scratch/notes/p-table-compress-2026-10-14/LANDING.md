# 本目录的收录范围（落盘说明）

**落盘日期**：2026-10-14。三轮 agent 的产物收在一处：

| 文件 | 来源 |
|---|---|
| `BRIEF.md` | 主 session 的任务书（轴定义 + 解析模型 + 必跑清单） |
| `PREDICTION.md` | **候选**（写于扫点之前，mtime 11:55:42 < 首扫点 11:57:08，判据镜核过时序） |
| `REPORT-table-c.md` | **候选**最终报告 |
| `PROGRESS.md` / `logs/` / `L1-*.txt` / `png/` / `probe/` / `probe-src/` | 候选的读数与探针（原始输出，未加工） |
| `VERDICT-blind.md` | **画面盲测镜**（零上下文；A–F 中性名，顺序已洗牌） |
| `judge/` | **判据镜**（零上下文；`REPORT-judge.md` + `mk.py` + 它自己的读数/探针/渲染） |
| `SYNTHESIS.md` | **主 session ④ 综合**（判决、对抗修正记账、可用结论） |

## 未收录（及原因）

- `wasm/`、`judge/wasm/`（共 ~4.4 MB）：**构建产物**，gitignore 类。本仓纪律是**引源码哈希**定位行为，
  不引 wasm 文件哈希（`design.md` §D0：wasm 哈希随注释行数变）。
  各点指纹见 `judge/fingerprints.txt`、`judge/fp-*.txt`、`logs/`。
- `axis-C.lib.rs`、`axis-A.lib.rs`（各 ~652 KB）：**整份 `engine/src/lib.rs` 的副本**（只差轴的两处改动）。
  复制一份完整源码进 notes 是纯冗余 ⇒ 略去。**轴的精确定义见下**，判据镜的独立实现见 `judge/mk.py`。

## 轴的精确定义（复现用）

`engine/src/lib.rs:522` 的 `default_lineup()`，18 名外场球员（**门将 id 0 / 21 豁免**）：

```
x' = 0.5 + (x - 0.5) * c
```

- **变体 C**：同时把 `center0`（`:3472` 用的 `FORM_CENTER_HOME/AWAY`，`:3417-3418`）改成**新表的队均**
  （`0.5 ∓ 0.142c`；原值 0.358/0.642 是旧表队均的硬编码副本）。
- **变体 A**：表压缩、`FORM_CENTER_*` 保持 0.358/0.642 不动。

扫描点：C ∈ {1.0, 0.70, 0.60, 0.55, 0.50, 0.45, 0.30}，A ∈ {0.60, 0.55}。
每点从本 worktree 源码重建 wasm（`cargo build --target wasm32-unknown-unknown --release`）。
