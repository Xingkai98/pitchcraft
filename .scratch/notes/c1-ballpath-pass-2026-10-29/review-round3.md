# C1-ballpath-pass · 独立审阅 Round 3（2026-10-29，收口复审）

审阅者：零上下文独立审阅（只读；未改代码，无变异操作）。
审阅目标：`c150d48 fix(review): Round 2 审阅修复——入口版本号 bump + 注释/容差断言精确化`（HEAD）。
范围：`git diff 3592774..HEAD`（含 `15fcf1e` 的 notes 删除与 `c150d48`）。
工作树：除预先存在的 `.gitignore` 修改（StatsBomb 忽略项，不属本分支审阅范围）外干净；无并发进程改写。

## 结论

- **无遗留 P1 / P2。**
- Round 2 的 P2-R2-1 已修（入口 version chain 完整）。
- Round 2 的 P3-R2-2 / P3-R2-3 / P3-R2-4 已在指出的位置修复并复核。
- **P3-R2-1 实际未修复**：`engine/src/lib.rs:846` 仍是原来的「R5c 读数 regular 19.6–23.1/场」区间表述；`git diff 3592774..HEAD -- engine/src/lib.rs` 在该区域**无改动**。但提交信息与 RECORD 都声称「已把 V1 19.6 与 R5c 23.1 分开表述」——**声明与代码不符**（记录完整性问题；按内容严重度仍是 P3、一行可修，不阻塞）。
- 其余全部核验通过。

已跑（收口命令）：

| 检查 | 读数 |
|---|---|
| `git show HEAD:viewer/index.html \| grep app.js?v=` | `./app.js?v=20261029-2` ✅ |
| `git show HEAD:viewer/app.js \| grep renderer.js` | `./renderer.js?v=20261029-1` ✅；renderer → `config.js?v=20261029-1` ✅ |
| `git diff --stat 3592774..HEAD` | 8 文件：RECORD / lib 注释 / realism 测试 / app.js 注释 / baseline 指纹 / index / 删 summary-2judges / 新增 review-round2.md——无预期外代码 |
| `cargo test --release --test realism l2_pass_fill_constant_matches_engine_tick` | **1 passed** |
| `cargo test --release --test realism gm_` | **4 passed** |
| `node --test tools/benchmark-baseline.test.mjs` | **10/10** |
| `/tmp/r2-stream-hash.mjs`（验收 wasm `ca99edfd` vs HEAD wasm `d71e4592`） | seed 42/7/601 **逐位相同**：`14bccb4a…` / `813de9da…` / `c4871bf2…` |
| HEAD 源码/wasm 指纹 | lib `d1ae722a…` / wasm `d71e4592…`，与 `viewer/data/benchmark-baseline.json` 的 `engineFingerprint` 一致；`cargo build --target wasm32…` 已最新（0.03 s），产物 `d71e4592…` |

---

## 1. 入口版本号与 renderer 链

- `viewer/index.html:537`：`<script type="module" src="./app.js?v=20261029-2"></script>` ✅（`c150d48` 中与 app.js 注释改动同一提交）。
- `viewer/app.js`：`config.js?v=20261029-1`、`renderer.js?v=20261029-1`、`game.js?v=20261029-1`、`observation.js?v=20261029-1`——config 链全部带版本。
- `viewer/renderer.js:4`：`config.js?v=20261029-1`。
- 全仓 `from './config.js` 扫描仍为 11/11 带 `?v=`，无裸路径回流。
- ⇒ 缓存客户端不会再用到「旧 app.js → 旧 renderer（`?v=20260913-1`）→ 裸 config」的双实例链；Round 2 的 P2-R2-1 关闭。

## 2. Round 2 P3 的逐项复核

| 编号 | 位置 | 状态 | 证据 |
|---|---|---|---|
| P3-R2-1（ENGAGE 19.6/23.1 分开表述） | `engine/src/lib.rs:846` | **未修复** | 仍为「R5c 读数 regular 19.6–23.1/场、L1 200 场 23.1 ∈ [14,29]」；`git diff 3592774..HEAD -- engine/src/lib.rs` 只有 `shot_bucket` 一处（见下方 diff） |
| P3-R2-2（shot_bucket 首行旧值） | `engine/src/lib.rs:7100-7103` | 已修 | 首行改为「当前值：禁区内 (7,48)、禁区弧 (2,32)、远射 (1,14)」；M5 段显式标注「上一代取值…不是当前值」 |
| P3-R2-3（容差断言缺坐标项） | `engine/tests/realism.rs:1338-1348` | 已修 | `let quant_bound = 0.0126 + PASS_FILL_FLIGHT_S * 0.05;` + `assert!(EPS >= quant_bound)`；实跑 1 passed |
| P3-R2-4（app.js「传递依赖」措辞） | `viewer/app.js:6-9` | 已修 | 改为「**config 链**（config / game / interpretation / observation / derive-audit-features / renderer）…；未改动的 geometry/micro-motion/protocol 等仍是裸路径」 |

P3-R2-1 的复现：

```bash
sed -n '845,847p' engine/src/lib.rs
# /// 射门体量下滑，按 C1 的水平重锚拉回；R5c 读数 regular 19.6–23.1/场、L1 200 场 23.1 ∈ [14,29]。
git diff 3592774..HEAD -- engine/src/lib.rs   # 只有 shot_bucket 的注释块
git log -1 --format=%B c150d48 | grep 'P3-R2-1'
# - P3-R2-1：ENGAGE_SHIFT 注释把 V1 的 19.6 与 R5c 的 23.1 分开表述（原来是两个树的数被写成区间）。
```

来源事实不变：19.6 是 V1（RECORD `:765`），23.1 是 R5c（RECORD `:889`）。修法是一行：把 `:846` 改为「V1 19.6 → R5c 23.1」或类似；或者撤回 commit/RECORD 里的「已修」声明。内容严重度 = P3（不阻塞），但这是本轮唯一「声称修复、实际未改」的项，建议不要留到下一次复述。

## 3. `3592774..HEAD` 新问题扫描

`git diff --stat 3592774..HEAD`：

```
 .scratch/notes/RECORD.md                           | 22 +-
 .../acceptance/summary-2judges.json                | 926 ------------
 .../c1-ballpath-pass-2026-10-29/review-round2.md   | 207 +++
 engine/src/lib.rs                                  |   5 +-
 engine/tests/realism.rs                            |   9 +-
 viewer/app.js                                      |   7 +-
 viewer/data/benchmark-baseline.json                |   4 +-
 viewer/index.html                                  |   2 +-
```

逐项：

- `15fcf1e`：只删 `acceptance/summary-2judges.json`（以三裁判 `summary.json` 为准）——与 RECORD `:1073` 一致，消除中间态歧义。
- `c150d48` 的 lib.rs 改动：**仅注释**（shot_bucket 文档，见上）；realism.rs：**仅测试内注释 + 容差断言**；app.js：**仅注释**；index.html：版本号；baseline：指纹。**无生产代码改动**。
- 基线指纹 `d71e4592…/d1ae722a…` 与当前 `viewer/engine.wasm` / `engine/src/lib.rs` 逐一相等；sentinel 10/10。
- RECORD 新增 Round 2 闭环段与终版构建记录，读数与本次复核一致（除 P3-R2-1 的「已修」表述）。
- 没有发现新的 P1/P2/P3（除上述 P3-R2-1 声明不符）。

## 4. 行为等同（事件流哈希，不用 wasm 文件哈希）

- 验收包 wasm（`ca99edfd…`，lib `240f6900…`）vs HEAD 树最新构建（`d71e4592…`，lib `d1ae722a…`）：
  - seed 42：`14bccb4ab2f66b42` == `14bccb4ab2f66b42`
  - seed 7： `813de9da86b8c93b` == `813de9da86b8c93b`
  - seed 601：`c4871bf28386e604` == `c4871bf28386e604`
- 哈希取的是 wasm 输出的**原始 JSON 字节**（`/tmp/r2-stream-hash.mjs`），与 RECORD `:959-962` 的三行记录一致。
- 另有静态支撑：`3592774..HEAD` 的 lib.rs 改动全部是 `///` 注释（脚本/人工核对）；生产代码零改动。
- ⇒ 终版树的行为 = 验收 wasm 的行为；验收包对终版仍有效。

## 最终判定

**无遗留 P1 / P2。** 唯一残留是 P3-R2-1 的「声明已修、代码未改」——一行注释或撤回声明即可，不影响行为/门禁/验收。
