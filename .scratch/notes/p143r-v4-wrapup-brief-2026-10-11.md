# P143r-v4 收尾任务书：把落地分支做到 merge-ready（修不变量 + 复绿 + 起 PR）

## 用户在拍板

用户选 **甲**：**接受 `ratio` 边际红**（0.484，差带下界 3%；保主场优势），**照常落地**。
（原话：「按建议」= 按主 session 的建议 = 甲。）

## 现状（你从这接手）

四层已**手写进干净源码**，在 worktree `/tmp/p143r-v4`（从 pristine `origin/main` = `8e6e292` 起，**未 commit、未 push**）。
- change：`openspec/changes/p143r-v4-four-layer-team-behavior/`（proposal/design/tasks/spec delta 已写）
- `MODEL_VERSION 7→8` + `engine/tests/golden-v8/` 已建；若干 seed 门已按同判据重钉
- wasm：`/tmp/p143r-v3/viewer/engine-v4.wasm`（sha16 `b4d1d607`，流哈希 `adaad7a7b98e99a0`）
- 报告：`.scratch/notes/p143r-v4-landing-2026-10-07.md`（含**硬前沿**：ratio≥0.5 与 home>away 不可兼得；
  取 `BASE_DEF_TACKLE=-0.86` 保 home、ratio 差 3%）

**官方 L1 = 4/5**（唯一红 = ratio 0.484，**已接受**）。
**默认 `cargo test --tests --no-fail-fast` 还有红**（上一次全量：lib 199/201）：
- **A 真不变量 2 条（合入前必须处置）**：
  - `p53_same_team_spacing_holds_between_anchors`：同队拍内 1.765m<2.0m（seed8 t0.719，**越界对含 carrier**）。
    隔离：关掉 evt 传球选择即绿 ⇒ 触发面=evt。**根因=P34 的 carrier 拍内扫掠豁免**（为保 L3 射门几何）。
  - `realism::l2_cross_event_invariants`：seed1 一例**射门落点 y2 越界**。
- **B seed 覆盖门 ~6 条**（重钉 seed，**换样本不换判据**，留证据）
- **C 口径/体量快照 ~8 条**（密度层改了基数，需按新基数重标定，留依据）

## 你要做的

### 1. 处置 2 条真不变量（**逐条给「修 or 缩小守卫 + 依据」，不许静默放宽**）

**`p53` 同队间距**——二选一，**给出你的判断与证据**：
- **(a) 真修**：让 `carrier` 在不处于「射门推进/起脚窗口」时**也参与**拍内扫掠分离
  （现有 `carrier_swept_light` 机制只在射门 tick 豁免；或让 `carrier_move` 的目标避让近旁队友）。
  **验证**：修后 `p53` 绿 **且** L3 射门几何不破（禁区内进球占比 ∈ 带，`l1_*` 不新增红）。
- **(b) 缩守卫**：若证明「同队 ≥2m」这条**对 carrier 从来不成立**（P34 刻意豁免，pristine 只是没触发），
  则把测试**显式排除 carrier 对**并**写明依据**（引用 P34 的取舍 + 本 change 只是让它首次可观测）。
  ⚠️ 这是「缩守卫」，**必须留反证**：证明缩掉的那部分确实是「P34 豁免的 carrier 对」、不是「任意同队对」。

**`l2_cross_event_invariants` 射门落点越界**：**先根因**（哪个层的几何让 `y2` 越界：shot 目标采样？carrier 位置？
对手位置？）。**能修则修**；若属「新几何下合法但守卫过严」，给依据后按仓惯例处置（改守卫要留反证）。

### 2. B/C 类红：重钉/重标定（**每条留证据**）
- B（pinned seed）：重跑扫描找仍触发该形态的新 seed，**说明「换的是样本不是判据」**。
- C（快照/口径）：密度层把基数抬了 → 按**新基数**重标定带/快照，**给出真实锚或新基数依据**（别为绿而放宽）。
- 参考先例：p143r-v2 的「爆炸半径」note（`.scratch/notes/p143r-v2-blast-radius-2026-10-05.md`）。

### 3. 目标：`cargo test`（默认全量）**绿**（或只剩**有据可查、已写进报告**的红）
- `cargo test`（默认）+ `cargo test --test realism --release -- --ignored l1_`（**接受 ratio 一条红**，其余绿）。
- `tools/benchmark-baseline.test.mjs` 的 `engineFingerprint` 哨兵会红（引擎源码变了、基线未重生成）——
  重生成需真实 tracking 数据（gitignored）。**如实记**（列为合入后步骤，或若本机有数据则重生成）。
- 视觉再确认：`trajectory.mjs` + `contact-sheet.mjs` + `viewer-match.mjs`（seed42/5min），先看图后引数。

### 4. 落盘 + 起 PR
- 在 `/tmp/p143r-v4` **commit**（日志写清四层 + 联合常数 + 硬前沿 + 接受 ratio 红的决定）。
- **push 分支** `p143r-v4-four-layer-team-behavior/2026-10-11`，**开 PR 到 main**（title/body 写清：四层、L1 4/5 接受 ratio、blast-radius 处置、review 待跑）。
- ⚠️ **不要自己 merge**——留给主 session 跑**独立审阅闭环**后再合。
- 把改动后的报告更新到**主仓** `.scratch/notes/p143r-v4-landing-2026-10-07.md`（或新日期）。

## 硬约束 / 坑

- **真实锚纪律**：改任何 L1 带/快照前，**先查 `realism.rs` 注释里的真实锚**（例：ratio 带 [0.5,1.5] 的真实锚 ~0.52；
  角球 10.27）。**没有真实锚的带，别当「重标定」借口**。
- **别静默放宽**：缩守卫/改带 = 用户级动作，**留依据 + 反证**。
- **浮点重排**：改源码注释/顺序会改事件流（预期），**清完必须重跑全套**。
- worktree 缺 gitignored 产物：`viewer/engine.wasm` 自 build；`node_modules` 自指 symlink；真实数据从主仓拷。
- **长任务易打转**：某方向连试 5 次无进展就换/收敛。
