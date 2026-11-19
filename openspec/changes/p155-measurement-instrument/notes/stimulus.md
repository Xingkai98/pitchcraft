# 冻结刺激集（Change 0 / A）

- 协议：`p155-stimulus-v1`，冻结于 2026-11-19
- 引擎：wasm sha256 `f6a9f9ec7a5effaa3b3df6d68e380263f308e7c86e54ad09ea5febb9760ec92f`；MODEL_VERSION=11；TICK_SECONDS=0.5
- 构建：`(cd engine && cargo build --target wasm32-unknown-unknown --release) && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm`（从本 worktree 源码现构建；不拷旧实验产物）
- viewer：config.interpretation.tickSeconds=0.5；源码哈希见 stimulus.json `viewer.sourceHashes`

## 窗口

- 窗长 24s、5Hz、121 帧（步长 0.2s，与 R7i windows.json 同相位：t0 + i×0.2）
- 引擎窗沿用 R7i 包（`c1-trajectory-morphology-2026-10-30/acceptance-r7d48/windows.json`）的 12 seed × 2 anchor 的 seed/t0；不重新选窗。

| # | id | seed | t0 | t1 | slice sha256 |
|---:|---|---:|---:|---:|---|
| 1 | eng-1201-36 | 1201 | 1960 | 1984 | `b604ddc3f7850e8d…` |
| 2 | eng-1201-60 | 1201 | 3240 | 3264 | `2c37b521e79ab2b3…` |
| 3 | eng-1204-36 | 1204 | 1944 | 1968 | `977cf0914d734f0c…` |
| 4 | eng-1204-60 | 1204 | 3240 | 3264 | `3ed3e55c5bd96c26…` |
| 5 | eng-1207-36 | 1207 | 1944 | 1968 | `574e67ace32166ad…` |
| 6 | eng-1207-60 | 1207 | 3240 | 3264 | `89da3380f45a1580…` |
| 7 | eng-1210-36 | 1210 | 1944 | 1968 | `b42d5000f805a743…` |
| 8 | eng-1210-60 | 1210 | 3240 | 3264 | `8c6c04840ff1ff06…` |
| 9 | eng-1213-36 | 1213 | 1944 | 1968 | `825ab2de4d84fb0c…` |
| 10 | eng-1213-60 | 1213 | 3240 | 3264 | `4b8b8f083a5a2696…` |
| 11 | eng-1216-36 | 1216 | 1944 | 1968 | `837ef92357fe1f2f…` |
| 12 | eng-1216-60 | 1216 | 3256 | 3280 | `18761408d5928ea5…` |
| 13 | eng-1219-36 | 1219 | 2010 | 2034 | `b35932c6f3708774…` |
| 14 | eng-1219-60 | 1219 | 3240 | 3264 | `67eff6b26bdfef51…` |
| 15 | eng-1222-36 | 1222 | 1944 | 1968 | `88c550d567c47a6a…` |
| 16 | eng-1222-60 | 1222 | 3240 | 3264 | `3688e64e0b7fd11c…` |
| 17 | eng-1225-36 | 1225 | 2084 | 2108 | `dd4633d9e40be940…` |
| 18 | eng-1225-60 | 1225 | 3242 | 3266 | `587fe4b4d702448d…` |
| 19 | eng-1228-36 | 1228 | 1946 | 1970 | `8801fa2ce9291cb0…` |
| 20 | eng-1228-60 | 1228 | 3240 | 3264 | `15be03334e4ab2ee…` |
| 21 | eng-1231-36 | 1231 | 1976 | 2000 | `30d9bbae29270bab…` |
| 22 | eng-1231-60 | 1231 | 3304 | 3328 | `2c8e20ebab032863…` |
| 23 | eng-1237-36 | 1237 | 2072 | 2096 | `8a0625a8064d4738…` |
| 24 | eng-1237-60 | 1237 | 3240 | 3264 | `69cc317b31956d27…` |

## 真实侧（只登记，不作为 A 的消融输入）

- metrica-1: `/home/shared/deep-research-playground/projects/football-manager-clone/viewer/data/real-game-1.json`，17980866 B，sha256 `46c041fd81faa310726617be81be865aebc0364acdc33079b4f699088df76047`；许可：Metrica sample-data: README 要求注明来源/负责任使用；未声明正式许可
- metrica-2: `/home/shared/deep-research-playground/projects/football-manager-clone/viewer/data/real-game-2.json`，17187632 B，sha256 `6911a12ba363ebd745ef4ddefb7e5659900ee2035ba6f5362000b3d4f8395c45`；许可：Metrica sample-data: README 要求注明来源/负责任使用；未声明正式许可
- skillcorner-10-even: **n/a** — SkillCorner 20 场未下载（~1.8GB，本 change 不下载）；design D1 的 10 场偶数位留待有数据时补登记

## 复现

```bash
node tools/visual-review/render-ablation.mjs freeze --wasm viewer/engine.wasm \
  --windows <R7i windows.json> --out openspec/changes/p155-measurement-instrument/notes
```

同一环境同输入重跑：`stimulus.json` 与 `windows.sha256` 逐位一致（工具内已对每 seed 模拟两次比对流哈希）。

⚠️ 可复现性边界：`windows.sha256` 的**切片哈希**环境无关；其文件头另列 wasm **构建产物**哈希
（随注释行号/工具链变化，不是行为哨兵）。`stimulus.json` 里的 `real.*.path` 是本次机器上的
真实数据绝对路径（数据本身 gitignored），换机器时该字段会不同，但 `real.*.sha256` 才是数据身份。
