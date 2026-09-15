# P34 独立零记忆审阅（第 2 轮 / review-round2）

审阅对象：**HEAD `1d8eae8`**（分支 `p34-same-team-spacing/2026-09-15`），工作区
`/home/happy/.paseo/worktrees/1g1x3st4/p34-same-team-spacing-2026-09-15`。
审阅者无任何前序上下文；以下每个数字均为本轮亲手跑出。审阅期间未改 `engine/src/`
（变异实验全部还原，`git status` 干净，见文末「工作区洁净性」）。

---

## 结论：**不通过（P0 ×1、P1 ×2、P2 ×2、NIT ×1）**

第 1 轮 P0-1 的三条根因**确实修掉了**，新增的拍内中点门
`p53_same_team_spacing_holds_between_anchors` **确实有牙**（5 个变异全部变红，见变异表）。
但**「整场滑窗全零」这一验收结论仍然不成立**：

> `node tools/spacing-sweep.mjs 59` → **18 findings，最恶劣 0.870m**（确定性，两次复跑一致）。

seed 59 **不在**默认 seed 集 `42 1 2 3 7` 内，所以实现者与第 1 轮审阅者都没跑到它。
这不是舍入边缘，是 **1.0m 级的真实同队重叠**——恰好是本 change 要根治的那类缺陷，
**且两道 Rust 门在结构上都看不见它**（见 P0-1 机制）。

---

## 一、必查项逐一核对（含我实际跑的命令与数字）

### 1. 整场滑窗门 —— **默认 seed 全零；自选 seed 命中残留**

| 命令 | 结果 |
|---|---|
| `node tools/spacing-sweep.mjs 42 1 2 3 7` | ✅ **全零**（5 seed × 2157 窗，退出码 0）|
| `node tools/spacing-sweep.mjs 11 13 23 99 100 555 777` | ✅ 全零（7 seed × 2157 窗）|
| `node tools/spacing-sweep.mjs 284 26 6 10` | ✅ 全零 |
| **`node tools/spacing-sweep.mjs 59`** | ❌ **18 findings，worst=0.870m**（复跑两次逐字一致）|

`spacing-sweep.mjs` 读代码确认**确实走真实采集管线**（`config → parseEventStream → Game →
captureObservation → detectPlayerOverlap`），不是自己造几何。我用**独立写的等价脚本**
（`captureObservation` + `detectPlayerOverlap`，整场 ±900s 大窗）复算 seed 11/13/23/42，
与它的口径一致，数字吻合。

### 2. Rust 门 —— 基线全绿；新增中点门**有牙**

```
cd engine && cargo test            # 129 lib 全绿（219.84s）
cargo test --lib p53_              # 10/10 绿
cargo test --test realism --release -- --ignored   # 9/9 绿（L3/L1 统计）
```

变异测试表见第三节。**关键结论：`p53_same_team_spacing_holds_between_anchors` 不是空门**
——关掉扫掠、把阈值调回 2.0、回退任意一条根因修法，它**都变红**。

### 3. 第 1 轮三条根因 —— 逐条复核（读 `engine/src/lib.rs` + 变异）

| 根因 | 复核结果 |
|---|---|
| ① `advance_loose` 预写 `st.pos[chaser]` | ✅ **已修**。`advance_loose` 已改为只产候选（`compute_mover_candidates` + `movers.push`），不再预写；`commit_beat_positions_ex`（`lib.rs:4670-4673`）起点改取各 mover 的 `from_x/from_y`，未产 mover 者才回退 `st.pos`。回退该修法（MUT-F）→ 中点门变红。|
| ② carrier 扫掠豁免过宽 | ✅ **已改成分摊**（`SWEPT_LIGHT_SHARE`），且 `emit_beat_with_main` 仍传 `carrier_swept_light=true` 但语义已从「完全豁免」变为「承担 0.12 份额」（`sweep_pair_lateral` 的 `(true,true)` 分支）。⚠️ 但该常量实测**接近无作用**，见 P1-1。|
| ③ 抢断结算点未与队友分离 | ✅ **已接线**（换修法：推被抢者的**队友**，`lib.rs:3434-3455`）。我实测该路径 200 seed 触发 52 次、4000 seed 触发 922 次，**从未真正推动**（`np != op` 恒假）→ 见 NIT-1。`tackle_stream_participants_not_overlapping` 复核**仍绿**（未破坏跨队结算间距）。|

`separate_target_points`（多点版）**仍是死代码**：全仓唯一调用者是 `separate_target_point`，
恒传单元素切片（`lib.rs:4554`）。`n > 1` 分支不可达 → 见 P2-1。

### 4. 确定性 / 协议 / 其它 —— 零 RNG 成立，无重复 mover id

- **零 RNG**：`same_team_dist_m` / `separate_pair_m` / `sweep_pair_lateral` / `separate_same_team_m` /
  `separate_target_points` 函数体内**无任何 `rng`/`next_u64`**（grep 复核，`lib.rs:4360-4608`）。
- **同 seed 逐字节一致**：自写脚本对 seed 11/13/23 各 `simulate` 两次，JSON 字符串
  **逐字节相同**（`det=true`）。
- **重复 mover id**（`protocol.js:47` 明令禁止）：seeds **1–1500（6,436,648 个 beat）零命中**；
  罚下球员作 mover/main：400 seed 零命中。
- **主 spec 与 delta 的「同队球员间距」段**：`diff` 为空（逐字一致）。
- **`npx openspec validate --all --strict`**：**14 passed, 0 failed (14 items)**。

### 5. 被放宽的三处断言 —— 都有实测依据，但松紧不一

| 断言 | 我的独立复算 | 判定 |
|---|---|---|
| `l1_tackle_dilution_and_slot_mix` 角球上界 8→12 | seeds **401–600**（= `SEEDS_L1_START`）：均值 **2.15/场**、峰值 **9**（seed 423）、旧上界 8 会被 **2/200** 场超过、新上界 12 超过 **0/200** | ✅ **依据属实，放宽合理** |
| `non_demo_produces_fouls_with_valid_shape` `foul==free_kick` 放宽为 ≤0.5% | 40 seed（1–40）实测最大短差 **1**（比例 5.6%），容差公式 `ceil(fouls×0.005)` 恰为 1 | ✅ **依据属实**（我原以为 5.6% 超容差，实为 `ceil` 后容差=1，通过）|
| `p5_approach_cap` 上界放宽为 `步长 + SAME_TEAM_MIN_DIST_M×3` | 10 seed 实测最大超出量 **3.02m**，占新上界 6.6m 的 **45.8%**；移除 cap（MUT-J）→ **变红**（单拍位移 0.137 归一化 = 14.4m）| ✅ **有牙、未放太松** |

---

## 二、P0 / P1 / P2 / NIT

### 🔴 P0-1：「整场滑窗归零」不成立 —— seed 59 有 18 条真实越界（worst 0.870m），且两道 Rust 门结构上看不见

**复现（可复现命令，确定性）**：

```bash
node tools/spacing-sweep.mjs 59
# seed 59: 2157 windows, player_overlap findings=18 worst=0.870m
# FAIL: 18 player_overlap finding(s) over the swept windows
```

**几何证据（我独立复算）**：

- 越界是 **away 队 12/15**（`min=0.870m`，首次 `t=4724.5s`）与 **away 队 15/20**
  （`min=1.379m`，首次 `t=2915s`）。
- 场景：**角球重开准备期**（ball 恒在角旗 `(1.000,1.000)`），**id15 静止**在
  `(0.6035,0.4002)=(63.37m,27.21m)` 不动，**id12 以 ~4m/s 沿 +x 直线跑位**擦过它：
  ```
  t=4724 beat  m12 (0.572,0.379)→(0.609,0.388)
  id15 该时刻无任何锚点，viewer 保持其上一锚点 (0.6035,0.4002)
  → 端点距离 = hypot((0.609−0.6035)×105, (0.388−0.4002)×68) = 1.011 m  ← 真实端点越界
  ```
- 这不是「0.5s 采样的舍入边缘」：**引擎发射的端点本身就是 1.011m**。

**为什么两道 Rust 门都抓不到（机制，读代码确认）**：

`p53_same_team_spacing_ge_2m`（`lib.rs:6244`）与 `p53_same_team_spacing_holds_between_anchors`
（`lib.rs:6313`）都先按 tick 聚合，而聚合来源是
`emission_points` / `tick_trajectories` —— **只收「本 tick 发射了锚点」的球员**
（`movers_of(&e)` + `main`）。**id15 静止 → 本 tick 不产 mover → 不在该 tick 的比较集合里**
→ (跑动者 × 静止队友) 这一整类 pair 对**两道门都不可见**。

我的 `r2-scan.mjs`（同样只比 mover 列表）扫 300 seed 全绿，正是栽在同一个盲区；
而 `spacing-sweep.mjs` 走**真实采集管线**（derive 会用**保持位置**补出静止球员的快照），
所以它能看见——这也是它比 Rust 门更强的地方。

**建议修法**（三选一，建议全做）：

1. **测试侧**：把 Rust 门的按-tick 聚合改成「本 tick 的 mover/main **∪ 未发射者的当前
   `st.pos`**」，即与 viewer 的 hold 语义对齐（`lib.rs:6244` 的 `emission_points`、
   `lib.rs:6313` 的 `tick_trajectories`）。
2. **引擎侧**：排查为何 solver 未在 `(12,15)` 上生效。我在 `separate_same_team_m` 里埋点，
   该 pair 每次被评估时 `pa=(0.4035,0.3502) pb=(0.6035,0.4002)`（d=21.27m，达标）——
   **与发射的 mover 位置 `(0.572,0.379)→(0.609,0.388)` 不一致**，说明这条角球跑位路径的
   `st.pos[12]` 与事件锚点不同步。建议按第 1 轮根因①的同一思路排查该路径
   （`advance_restart_prep` 角球分支 / `corner_setup_target`）是否又有「候选终点绕过分离提交」。
3. **门禁**：把 `spacing-sweep.mjs` 的默认 seed 集从 `42 1 2 3 7` 扩到覆盖 `59`
   （或直接纳入 `verify.sh`），否则这类「非默认 seed 残留」会反复漏网。

### 🟠 P1-1：`SWEPT_LIGHT_SHARE`（0.12）实测**近乎无作用**，其注释依据与我的复算不符

注释（`lib.rs:624-626`）称：「**0（完全豁免）会让对穿的中点越界残留**，0.5（对半）破 L3」。

我的复算（把常量改成 0.0 / 0.5，重建 wasm，跑同一套真实管线）：

| `SWEPT_LIGHT_SHARE` | 真实密集管线（seed 11/13/42）最恶劣中点 | `l3_shot_ratios` 禁区占比 |
|---|---|---|
| 0.12（现值） | 2.131–2.136m | 0.775 |
| **0.0** | **2.130–2.136m（相同）** | 0.770 |
| **0.5** | **2.130–2.136m（相同）** | 0.773 |

即：**0.0 / 0.12 / 0.5 三种取值的越界与 L3 指标都在噪声带内**，注释所称的两个失败模式
**我都无法复现**。`sweep_pair_lateral` 的 (true,true) 分支确实被调用（300 seed 触发
1374 万次、其中 3342 次真的改变了结果），但对最终几何**无可见影响**——很可能因为
「近对穿」场景里总有别的环节先把它修好了 / 或该侧总是 `budget` 用尽。
**建议**：要么补一条能区分这三个取值的专测（否则该常量是不可验证的调参），
要么把注释改成实测口径（现在的注释断言了两个我复现不出的结果，属**误导性注释**）。

### 🟠 P1-2：`p53_same_team_spacing_ge_2m` 与中点门**口径不一致**

端点门（`lib.rs:6275`）断言 `≥ detector 阈值 2.0 − ε`，中点门（`lib.rs:6345`）同；
但**内部判定阈值是 2.2m**（`SAME_TEAM_MIN_DIST_M`），拍内扫掠生效线是 2.02m
（`SAME_TEAM_SWEPT_MIN_M`）。三个数字（2.0 / 2.02 / 2.2）叠两套余量（0.08 序列化 +
0.06 扫掠），注释只在常量区各说各的（第 1 轮 P1-2 建议的「余量总账」**未落地**）。
建议在常量区补一句三者的关系与各自来源。

### 🟡 P2-1：`separate_target_points`（多点版）仍是**不可达死代码**

`lib.rs:4567` 的 `n>1` 分支没有任何调用者（唯一入口 `separate_target_point` 恒传 1 个 target）。
文档（`lib.rs:4557-4566`）描述的「同一拍多个事件指定终点」场景**当前不存在**。
建议：删掉多点版、把单点逻辑内联，或明确保留并加注释说明它是为哪条未来路径预留。

### 🟡 P2-2：抢断推队友分支经 4000 seed 验证为**恒不触发**

`lib.rs:3439-3455` 的 `pushed` 循环：我埋点统计，4000 seed 内 `same_team_dist_m(pushed_from, op)
< SAME_TEAM_MIN_DIST_M` 成立 **922 次**，但其中**没有一次**真正产生位移（`np != op` 恒假）。
原因是 `separate_pair_m(..., false, true)` 在 `d ≥ min_dist` 时原样返回，而进入分支的前提
就是 `d < min_dist`——**看似应当触发**，实测却零推动。这不影响正确性（分离由后续拍的统一
分离兜底，且第 1 轮的根因③已由 P0-1 修复路径之外的方式覆盖），但**该分支当前是「活代码里的
死逻辑」**，其意图（消除抢断结算点与队友的重叠）**未被证明真的实现**。建议补一条定点单测
直接构造该场景，确认它能推动。

### ⚪ NIT-1：`real-gate.md` 的「整场滑窗（5 seed）全零」表述需限定 seed 集

该表写作「整场滑窗（每 seed 2157 窗 × 5 seed）**全零**」，容易被读成「整场无越界」。
实际只在 `42 1 2 3 7` 成立（seed 59 反例，见 P0-1）。建议表格里显式列出 seed 集。

---

## 三、变异测试表（我自己做的，全部跑完已还原）

| # | 变异 | 新建中点门 `..._holds_between_anchors` | 端点门 `..._ge_2m` | `p5_approach_cap` | 判定 |
|---|---|---|---|---|---|
| A | `sweep_pair_lateral(...)` → `(pa, pb)`（关掉整个拍内扫掠） | ❌ **红**（0.141m @seed1 t=1117） | ✅ 绿 | — | **有牙** |
| B | `SAME_TEAM_MIN_DIST_M` 2.2 → 2.0 | ❌ **红**（1.934m） | ❌ **红**（1.993m） | — | **有牙** |
| C | 删抢断「推队友」循环（根因③回退） | ❌ **红** | ✅ 绿 | — | **有牙** |
| E | `separate_target_point(s)` → 恒等（关事件指定终点分离） | ❌ **红** | ✅ 绿 | — | **有牙** |
| F | `commit_beat_positions_ex` 起点回退 `st.pos`（根因①回退） | ❌ **红** | ✅ 绿 | — | **有牙** |
| G | `foul==free_kick` 恢复严格等式 | — | — | — | ❌ 红（放宽确有必要）|
| J | `SAME_TEAM_SWEPT_PUSH_CAP_M` → 1e9（移除侧推上限） | — | — | ❌ **红**（单拍 0.137 归一化）| **有牙** |
| I | `budget` → 1e9（移除分离预算） | ✅ 绿 | ✅ 绿 | ✅ 绿 | ⚠️ **无牙**（见下）|
| H | `SWEPT_LIGHT_SHARE` → 0.5 / 0.0 | ✅ 绿 | ✅ 绿 | ✅ 绿（L3 亦绿）| ⚠️ **无牙**（见 P1-1）|

**两个无牙变异是关键结论**：

- **MUT-I**（移除分离预算）不红：实测最大超出量仅 3.02m（budget 6.6m 的 46%），
  说明 `budget` 这条防线**当前从未接近饱和**——它的存在是防御性的，不是承重的。
- **MUT-H**（`SWEPT_LIGHT_SHARE`）不红：见 P1-1，该常量当前不可验证。

---

## 四、新增盲区 / 缺陷清单（`file:line` + 建议）

1. **`engine/src/lib.rs:6244`（`emission_points`）与 `:6313`（`tick_trajectories`）**：
   按-tick 集合只含「发射了锚点者」，**静止球员不可见** → (跑动者 × 静止队友) 整类 pair
   无门。建议按 `st.pos` 补全未发射者（P0-1）。
2. **`engine/src/lib.rs:624-626`（`SWEPT_LIGHT_SHARE` 注释）**：断言的两个失败模式复现不出，
   属误导性注释。建议改为实测口径或补区分性测试（P1-1）。
3. **`engine/src/lib.rs:4557`（`separate_target_points` 多点版）**：不可达死代码（P2-1）。
4. **`engine/src/lib.rs:3439-3455`（抢断推队友）**：4000 seed 零实际推动，意图未证实（P2-2）。
5. **`tools/spacing-sweep.mjs:46`**：默认 seed 集 `42 1 2 3 7` 太窄（漏掉 59）。建议扩容或
   接入 `verify.sh`（P0-1 修法 3）。
6. **`engine/src/lib.rs:6268` 附近（边界 clamp）**：第 1 轮已记录的「边界分离不足」已知残留，
   本轮未再触发（scan 300 seed 最恶劣端点 2.189m），维持已知缺口记录。

---

## 五、复核过的「没问题」项（供归档参考）

- 新建中点门**真能抓变异**（上表 A/B/C/E/F 五红），不是空门——第 1 轮 P0-1 的最大盲区**已补上**。
- 第 1 轮三条根因**逐条修复属实**，且都可被中点门守护。
- 零 RNG / 固定遍历顺序成立；同 seed 两次模拟**逐字节一致**（seeds 11/13/23）。
- 无重复 mover id（seeds 1–1500，6.44M beat）；无 `main`+`ball` 同时出现；无罚下球员作 mover。
- 主 spec 与 delta 的「同队球员间距」段**逐字一致**；`openspec validate --all --strict` **14/14**。
- `cargo test` 129 lib + 4 realism 全绿；release `--ignored` L1/L3 9/9 全绿。
- 三处放宽断言**均有实测依据**，且 `p5_approach_cap` / 角球上界在更坏的变异下**仍能变红**。
- `spacing-sweep.mjs` 走真实采集管线（`captureObservation`），非自造几何；带退出码可作 CI 门。
- 确定性 golden v6 已有；`gm_legacy_baselines_preserved_and_differs` 守 v1–v5 差异。

---

## 六、工作区洁净性

所有变异实验（A/B/C/E/F/G/H/I/J + 两轮埋点）均在 `/tmp` 保存基线
（`/tmp/lib.rs.orig`）后还原，并重新构建 `viewer/engine.wasm`：

```
git status --porcelain                    # 空
md5sum engine/src/lib.rs                  # 181f646270c79711bdbb31e01be433a1
git show HEAD:engine/src/lib.rs | md5sum  # 181f646270c79711bdbb31e01be433a1  ✓ 一致
md5sum viewer/engine.wasm                 # b0c9dc325a689962dceac62c1961ee51（= HEAD 构建产物）
engine/tests/ 无新增文件（r2probe.rs 已删）
```

---

## 七、复现命令（审阅者实际用的）

```bash
export PATH="$HOME/.cargo/bin:$PATH"

# 1) 整场滑窗：默认 seed 全零；seed 59 命中 18 条
node tools/spacing-sweep.mjs 42 1 2 3 7      # OK（退出码 0）
node tools/spacing-sweep.mjs 11 13 23 99 100 555 777   # OK
node tools/spacing-sweep.mjs 59              # FAIL：18 findings worst=0.870m

# 2) Rust
(cd engine && cargo test)                    # 129 全绿
(cd engine && cargo test --lib p53_)         # 10/10 绿
(cd engine && cargo test --test realism --release -- --ignored)   # 9/9 绿

# 3) 验收文档
npx openspec validate --all --strict         # 14/14
```

**回归建议**：把 `spacing-sweep.mjs` 纳入 `verify.sh` 门槛，并把默认 seed 集扩到
至少覆盖 `59`——否则 P0-1 这类「非默认 seed 残留」会反复漏网。
