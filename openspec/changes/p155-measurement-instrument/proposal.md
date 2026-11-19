# Proposal: 先分清引擎/viewer 的测量仪器（Change 0，GitHub #190）

## Why

2026-11-19 Astra（gpt-6.1-sol）复核发现：`tools/visual-review/` 现有的判别普查对**零位移步也调用 `atan2`**，`atan2(0,0)=0` 会把「向左走 → 静止 → 继续向左」计成两次大角转向；同时普查测的是 **viewer 渲染帧**，不是引擎 mover 意图。于是「24× 折返」既可能是引擎目标反转，也可能是 viewer 插值/纹理，还可能是指标定义的零步伪角——当前无法回答「引擎 / viewer / 指标定义各占多少」。

在 C1（#170，把运动换成连续状态）动引擎之前，必须先修准仪器。否则会把 viewer 伪影当引擎缺口、把引擎缺口当 viewer 问题，重复过去「指标变好、画面不变」的飞轮。

## What Changes

- 新增**同流渲染消融**：同一批事件流/窗口，分别用 linear / Catmull / T1 / 现行渲染 / 直接端点重采样出帧，输出同窗轨迹与指标差。
- 新增**条件 turn120**：只统计双方步速 ≥0.5 m/s 的转向；并列报旧 turn120、有效步数、每有效转向率、邻近门限敏感性。
- 新增**运动状态分解**：move→stop / stop→move / move→move；`staticFrac`、`ballStaticFrac`、速度分位、加速度尾部、球场方向对称性。
- 新增**ballStaticFrac 来源分解**：carrier hold / 正常带球 / 高亮 / loose / restart，报时间权重与条件静止率。
- 新增**L1 带来源审计**：逐条标「真实锚 / 护栏 / 未验证」，建立场景夹具；不删红门、不先放宽。
- 新增**用户尺度基线**：seed42/5min 原始事件计数、最长停球段、逼近/推进可读性、墙钟；90min 聚合并列。
- 新增**冻结 stimulus set**：seed / 窗口 / 事件流 SHA / 源码与协议版本 / 真实数据清单，供 A/B 两条并行工作流共用。

## Capabilities

### New Capabilities

- `match-measurement`: 比赛测量的可复现口径——冻结刺激集、渲染消融、条件运动指标、静止来源分解、L1 带来源审计与用户尺度基线。

### Modified Capabilities

（无。本 change 不改 `match-engine` / `pitch-viewer` / `event-stream-protocol` 的任何行为要求。）

## Impact

- 只动 `tools/visual-review/`、`tools/`（新脚本/测试）与 `openspec/changes/p155-measurement-instrument/notes/`；`engine/`、`viewer/` 行为零改动。
- 新增工具测试；不改 CI 的既有门、不改 L1/ratchet 阈值、不改 detector 阈值。
- 产出的仪器结论将决定 Change 1 是「修 viewer 运动契约」还是「建引擎统一运动执行层」。

## 关联

- GitHub #190（本 change 的票据）；地图 #175；C1 #170；渲染直接消费位置 #122；基线漂移哨兵 #166。
- 证据：`.scratch/notes/handoff-astra-2026-11-19.md`、`.scratch/notes/astra-diagnosis-2026-11-19.md`。
