# P16 代码审阅闭环记录

> 本仓 CLAUDE.md 的强制收尾：**独立只读 subagent 审阅 → 修复 → 再审阅 → 全过**。
> 本文件记录各轮的审阅者、发现、修复与复验证据。
>
> **独立性**：每轮的审阅者都是**新起的独立 subagent**——零本会话记忆、
> 看不到实现者的推理过程、只能读 worktree 文件，并被要求**自己写探针复算**、
> **做定向变异**，不得只读被审者的文档。

---

## 轮次 0（设计层）：位置导出方案 G1

**审阅者**：独立只读 subagent（`general-purpose`），只读 `POSITION-EXPORT-DESIGN.md` +
`engine/src/` + 可复现探针。

**发现（P0 两条，均经实现者复核为真）**：

1. **采样点漏拍**：方案初稿把采样点定在 `emit_beat_with_main` 之后。实测 ≥16.7% 的拍
   走裸 `beat_event`，且 seed 1 有 34/5399 个 tick **根本不产 beat**。
   ⇒ 改到主 tick 循环内、`tick` 返回之后；明确「拍 = tick（5399）不是 beat（5365）」。
2. **`frozen` 无来源、在初稿采样点上恒空**（`beat_movers_main` 传的是 `&[]`）。
   ⇒ 改为取自 `st.highlight.participants` 的 id 列。

**修复轮引入的新问题（第二轮审阅抓到）**：

- 采样点描述**自相矛盾**（同节既写「`tick` 返回之后」又写「`tick()` 内 finalize 之前」——
  二者互斥）⇒ 定死为前者并补理由；
- §4.3 把**已被自身否决**的采样点记成「用户已批准」；
- 声称米数「已删」但 §1/§2.1/§3.2 仍留 4 处违规的单标量换算（探针直接 ×105 或 ×68，
  而球场各向异性，正确换算是 `hypot(dx×105, dy×68)`）；
- `frozen` 的字段注释仍写「防陈旧」，与实测（飞行期位置**不变**，0/269）冲突。

**第三轮**：全部闭合；审阅者独立确认「`tick` 返回之后」这个选择成立。

---

## 轮次 1（实现层）：全 change

**审阅者**：独立只读 subagent，审阅 `cb60cc5..HEAD` 全部改动。

### P0-1 **join bug —— 裁决被算错，两版结论都作废**

`all_refs` 的 episode 下标抬成了**全局**下标（`i + offset`），但 `all_feats` 保留
**逐场本地**下标。`separability` 的 `in_set.contains(i)` 于是把「全局参考下标」与
「本地特征下标」相比——**seed 1 之后逐 seed 全错**，AUC 被摊平到 ~0.5。

审阅者的证据：局部成员命中 629 次（真值 541）；修正后 `forward_m` 池化 AUC
从 0.530 → **0.717**。

⇒ **修正后裁决由「不够」改为「部分够」**（见下）。

### P0-2 「小样本误导」是错的机制（危害更大）

v2 把「1 seed 0.7–0.84、30 seed 塌回 0.5」解释为小样本 AUC 方差。
**没有「塌回」**：逐 seed AUC 稳定在 0.6–0.86，0.5 完全是 join bug 的产物。
若写进永久记录，会把一个可修的 bug 固化成「小样本不可信」的方法论。已改。

### P1-3 源码扫描有盲区

`FORBIDDEN` 只列 `.x2`/`.y2`/`location`，漏了**裸 `.x`/`.y`**（动作主体位置，正是本
change 口径明禁的）。实测往 `reference_set` 塞 `acts.last().map(|e| e.x)` 后 32 条全绿。
⇒ 补 token，复验变红。

### P1-4 `formal_path_produces_no_snapshots` 是假覆盖

它只调 opt-in 路径，**从没调 `simulate()`**。实测删掉 `observe_state` 的
`if !self.enabled { return; }` 后全套仍绿。
⇒ 改为：真跑 `simulate()` 断言事件流逐字节一致 + **直接构造 `disabled()` recorder
断言空操作**（含反证条）。复验变红。

### P2

裁决测试 doc 自相矛盾（声称抓量化、实际不抓）；对**不存在**的测试
`motifs_and_features_are_disjoint` 的死引用；`has_state_snapshots` 硬编码 `true`；
死代码 `arr`。**另发现时长混淆**（见下）。

---

## 轮次 2（独立重审，修复后）：全 change

**审阅者**：**新的**独立只读 subagent（零上文），独立复算 + 定向变异 + 跑产物门。

### 核验通过（审阅者独立复现，非采信文档）

- `cargo test` 全绿；P16 32 passed / 2 ignored；
- **裁决独立复算**：`final_third vs 其余 fwd/s` = **0.855**（声称 0.862）；
  `build_up vs progression fwd/s` = **0.461**（声称 0.46）；未归一 0.738（声称 0.738）；
- **裁决强度**：审阅者扫了 9 个替代特征（`backward_m/s` 0.634 最强）——
  **没有任何空间量能把 `build_up`/`progression` 分开** ⇒ 是「空间量不足以判」，
  不是「特征选得不好」（这是裁决强度的关键区分）；
- **时长混淆真实存在**（raw duration 的 build-vs-prog AUC = 0.750），归一对，
  且 `final_third` 在四个时长分层内 AUC 仍 0.94/0.93/0.85/0.78（未引入新问题）；
- **铁律**：`viewer/` 与 `openspec/specs/` 的 diff **为空**；
  `plain_and_opt_in_paths_agree_byte_for_byte` 绿；`engine/src` 无插桩残留；
- 探针对 `NaN` 显式 `throw`，`n = 19668 = 894×22` 说明**零静默跳过**；
- 产物除 `source_commit` 外**逐字节可复现**。

### P1-1（本轮唯一阻断）源码扫描仍可绕过 —— **已结构性修复**

中间版本的守卫扫的是 `reference_set` 的**函数体**。审阅者实测：把位置读取放进
**体外 helper**（`fn __pos_helper`）再在体内调用，**全套 32 条仍绿**，
而参考集已真的用上位置（`build_up` vs `progression` 的 AUC 从 0.461 移到 0.552）。

⇒ **结构性修复**：参考集（含全部 helper）**拆到独立文件 `p16/reference.rs`**，
守卫 `include_str!` 扫**该文件全文**。任何 helper 都必须在文件内，故全文扫描
**覆盖调用闭包**。复验：同一变异现在**红**。

⚠️ **能力边界（已写进守卫 doc）**：这仍不是形式化证明（无调用图分析）——
挡「不小心写循环论证」够用，挡「刻意用晦涩别名读位置」不够；那需要类型级隔离。

### P2（本轮，均已修）

- **P2-1 产物 `source_commit` 与实际源码不符且无哨兵**：`engine_source_fingerprint`
  只哈希 `engine/src/*`，**对测试文件改动是盲区** ⇒ 新增
  `test_source_fingerprint`（哈希 `tests/p16/*` 全部源码），使「产物内容 ↔ 产出源码」
  双向可核对；产物门另断言 `source_commit != "unknown"`。
- **P2-2 产物里的时长中位数是硬编码**（算出的 `db/dp/df` 是 unused variable）⇒
  改为活计算传入 `to_markdown`。
- **P2-3 join 的 offset 依赖「起点恒 100% 可得」**（`feats.len()` vs
  `possession_episodes.len()`）⇒ 改用**下标空间**并加断言，不等即红。
- **P2-4 裁决守卫容差偏宽**（±0.12 会让 P1-1 的 0.552 漏过）⇒ 收窄至 ±0.06，
  并**钉住方向**（实测 AUC < 0.5，即 build_up 的推进速率**更低**——这条方向本身是证据）。

---

## 最终状态

- **审阅全过**（轮次 2 的 P1-1 与全部 P2 已修并复验）。
- 定向变异累计 **17 条**实跑均红（证据分散在各测试文件头/函数 doc），
  其中 **4 条是「假覆盖」被审阅抓到后重写并复验**的。
- `cargo test` 全绿；`openspec validate --all --strict` 13/13；`git diff --check` 干净。
