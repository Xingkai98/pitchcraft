# P5.4 真实门（detector）验收记录

design D3 第 3 项：跑真实 diagnosis，`player_overlap` finding 应归零。

## 怎么跑（**脚本已入库**，可复现）

`tools/spacing-sweep.mjs`——把真实采集窗口（±5s）**滑过整场**（每 2.5s 一窗），用真实采集
管线（`protocol.parseEventStream → Game → observation.captureObservation → buildAuditInput`）
产出 audit_input 再跑 `tools/detectors.mjs` 的 `player_overlap`。比 P26 的稀疏 fixture 密得多
（后者只在 6–7 个手工挑的窗口采样，会漏掉大量时刻——P34 审阅 P0-1 的教训）。

```bash
# 仓库根，先有 viewer/engine.wasm（下方命令重建）
node tools/spacing-sweep.mjs          # 默认 seed 42 1 2 3 7（各 2157 窗）
node tools/spacing-sweep.mjs 42 1 2   # 指定 seed
# 退出码：任一 finding 即 1（可作 CI 门）
```

WASM 重建：

```bash
(cd engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
```

Rust 侧同口硬门：`engine/src/lib.rs` 的
`p53_same_team_spacing_ge_2m`（端点）与 `p53_same_team_spacing_holds_between_anchors`（整条
轨迹含拍内中点）。

## 结果（终版）

| 口径 | 结果 |
|---|---|
| 真实采集窗口（7 窗 × 6 seed） | **全零** |
| 整场滑窗（每 seed 2157 窗 × 5 seed） | **全零** |
| Rust 端点门 `p53_same_team_spacing_ge_2m`（10 seed 整场） | 绿 |
| Rust 拍内中点门 `p53_same_team_spacing_holds_between_anchors`（8 seed） | 绿 |

修复历程（对应审阅 review-paseo.md）：初版只在 6–7 个手挑窗口验证、误报归零；扩到整场
滑窗后暴露三条根因（loose 追逐者预写起点污染扫掠输入、carrier 扫掠豁免过宽、抢断结算点
未分离），逐条修复（见 `fix-round-1.md`）。

## 关键参数与取舍

- `SAME_TEAM_MIN_DIST_M = 2.2`：端点阈值。含 JSON 4 位小数序列化 + 0.5s 采样插值的余量。
- 拍内扫掠阈值 `= 阈值 − 0.06`；侧推上限 `= 阈值 × 3`（近对穿的侧推需数倍阈值才收敛）。
- **carrier 在拍内侧推中只承担 `SWEPT_LIGHT_SHARE`（0.12）**，队友吸收其余：carrier 在射门
  推进/起脚窗口刻意奔向球门，对半分摊会把禁区内进球占比从 0.758 压到 0.693、破 L3 参考带
  [0.72,0.92]；完全豁免又会让对穿的中点越界残留。0.12 两边都过（L3 实测 0.775）。
- 拍内中点门限取 detector 的 `2.0m`（不是端点阈值 2.2）——只保证不跌破 detector 阈值。

## 已知边界（非阻断）

- 拍内扫掠的侧推上限（`阈值 × 3`）：两名同队球员本拍轨迹近乎**对穿**且需要超过该上限的侧移
  时，本拍不修正、留给下一拍。终版实测该情形未在 5 seed × 2157 窗中出现。
