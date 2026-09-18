# 审阅探针（可复现证据）

这些脚本是两轮设计审阅用来**实测验证**结论的探针，供后来人复核审阅报告里的每个数字。

## 怎么跑

它们原本在 `viewer/` 下运行（脚本内用相对路径 `./game.js`、`./data/real-game-*.json`、
`./engine.wasm`）。要复现：

```bash
# 1. 确保真实数据与引擎产物就位（都不入库，见 P35）
node tools/fetch-tracking-data.mjs
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json
(cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)

# 2. 拷到 viewer/ 跑（相对路径才对）
cp openspec/changes/p36-match-benchmark/reviews/probes/*.mjs viewer/
cd viewer && node probe9-convention-scan.mjs
```

## 各探针做什么

| 脚本 | 用途 |
|---|---|
| `probe1-methodology.mjs` | 指标方法论体检（分离度、稳定性） |
| `probe2-possession-and-time.mjs` | 控球代理分布 + 时间稳定性 |
| `probe3-interval-and-missing-metrics.mjs` | 区间门可行性 + 缺球指标 |
| `probe4-artifacts-and-anchors.mjs` | 重复坐标伪影是否污染极值 |
| `probe5-seeds-and-phases.mjs` | 种子间波动 + 相位构成 |
| `probe6-robustness-and-identity.mjs` | 抗噪（注入实验）+ 身份映射 |
| `probe7-final.mjs` | 综合验证 |
| `probe8-crossvalidation-and-shape.mjs` | **留一交叉验证**（区间门证伪的关键证据） |
| `probe9-convention-scan.mjs` | **估计量约定扫描**（floor 索引不对称的发现） |
| `probe10-round2.mjs` | 第二轮复审（5400s 采样安全性等） |
| `generate-baseline-numbers.mjs` | 生成 `baseline-numbers.json`（最终口径 × 最终采样） |

## 注意

这些是**审阅期的一次性探针**，不是项目代码——风格与项目测试不同（直接打印数字，
无断言）。正式实现是 P1 的 `viewer/match-metrics.js` + 单测。
