# P5.4 真实门（detector）验收记录

design D3 第 3 项：跑真实 diagnosis，`player_overlap` finding 应归零。

## 怎么跑（可复现命令）

真实 diagnosis 的审计输入由 viewer 采集管线产出（`protocol.parseEventStream → Game →
observation.captureObservation → buildAuditInput`），detector 在 `tools/detectors.mjs`。
项目默认采集窗口 ±5s（`observation.js`）。

**整场扫描**（比真实窗口更严，用来看残留分布）：

```bash
# 仓库根，先有 viewer/engine.wasm（下方命令重建）
node /tmp/p34-measure.mjs viewer/engine.wasm 42 1 2 3 4 5
```

**真实门（7 个观测窗口，与 P26 fixture 同口径）**：

```bash
node /tmp/p34-window-gate.mjs
```

（脚本见 `/tmp/p34-window-gate.mjs`、`/tmp/p34-measure.mjs`；本质是用
`captureObservation` 在 6 个真实重开窗口 + 死球窗口上采 audit_input，跑
`detectPlayerOverlap`。）

WASM 重建：

```bash
(cd engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
```

## 结果

| 阶段 | 整场 findings（seed 42/1/2） | 7 窗口 findings（seed 42/1/2/3/4/5） |
|---|---|---|
| 改前（HEAD 基线） | 24 / — / — | 8 + 5 + 14 + 3 + 1 + 6 = 37 |
| P34 端点分离（无扫掠） | 17 / 11 / 24 | 35 |
| P34 端点 + 拍内扫掠（终版） | 0 / 0 / 2 | **0** |

终版：**7 观测窗口全零**（4 个 seed 完全干净，2 个 seed 亦零）；整场扫描残余 1–2 条，
均为 0.5s 采样落在 [2.00, 2.08) 边缘的舍入误差（`SAME_TEAM_MIN_DIST_M` 已含 0.08m
序列化余量，2.00–2.08 之间的采样值即余量内的合法结果）。

## 残留与已知边界

- **拍内扫掠侧向推移有上限**（`SAME_TEAM_SWEPT_PUSH_CAP_M` = 本拍步长）：两名同队球员
  本拍轨迹近乎对穿时，侧向推不动，本拍不修正、留给下一拍。这是刻意的「最小必要推移」，
  不把球员横甩。
- **carrier 在射门推进 / 起脚窗口豁免扫掠侧推**：避免射门几何系统性漂移（实测豁免前
  禁区内进球占比 0.699，破 L3 参考带 [0.72,0.92]；豁免后 0.777）。端点分离仍覆盖 carrier。
