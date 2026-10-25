# B 层实验报告：无球目标调整层（隔离 worktree `D:\pitchcraft-exp3`）

日期：2026-10-25
起点 commit：`0fe2989`（A 层「球队块定律」+ 标定，已含 EXP1 最终配置）
改动范围：`engine/src/lib.rs`（单文件）；未动事件类型、未改 tick/beat、未改协议/测试/判据工具。
机制表述：**基于本地真实 tracking 分析（离线拟合，仅本 worktree）+ 本仓 P38 判据的自研机制**；参数值为先验/扫描值，非外部实现来源。
最终 wasm sha256：`474A303FEA6AD8F136E0C484538B68CE51153E53A7EE67F0869CB34C17826018`
`git diff --stat`：`engine/src/lib.rs | 254 +++++...`（1 file changed, 249 insertions(+), 5 deletions(-)）

---

## 1. 一句话结论

**预注册验收全部达成（P38 8/8、L1 9/9、like-football 距离 0.186、lf.lat 0.38、轨迹横向 sd 8.08m）**，
但达成方式与设想不同，必须连同两条负结果一起看：

1. **B1+B2+B3（防守方）增量被证伪**：全向收敛把 P38 纵深/间距打出带（3/8）；改成横向分量后结构保住，
   但把「射门体量」从 16.2 打到 9.6（P38 口径）——防守者被拉近持球者 ⇒ 出球硬门触发率上升，
   这正是 A 层标定所依赖的旧几何假设被破坏（**B 层 ↔ 事件层标定耦合**）。
2. **latSd 的主杠杆是 A 层横向分轨重标定（0.32→0.70），不是 B 层本身**：
   A 层 0.65 单独就给出 latSd 8.025，但 swarm 0.905 超上界（0.891）⇒ 必须靠 B4 把 swarm 压回带内。
   **B4 的作用是「守门」（swarm 0.88→0.69）而非「提升」**，代价是 latSd −0.14。
3. 最终配置 = **B4 单独启用 + A 层横向分轨 0.70 + 两条事件标定补偿常数**；B1/B2/B3 代码保留但关闭
   （`B_ENABLE=false`）。这条配置**不是合入结论**，是需要重标定评审的实验解。

---

## 2. 预注册验收对照（最终配置）

| 验收项 | 目标 | 最终读数 | 结果 |
|---|---|---|---|
| P38 `latSd` 横向位移 sd | ≥ 7（当前 3.886） | **7.272** | ✅（余量 0.26） |
| P38 `swarm` y 两两相关 | ∈[0.451, 0.891] | **0.694** | ✅（带内） |
| P38 通过条数 | ≥ 7/8 | **8/8** | ✅ |
| like-football 距离 | ≤ 0.27 | **0.186** | ✅ |
| like-football `lf.lat` 横向占比 | ≥ 0.30（当前 0.25） | **0.38** | ✅ |
| L1 统计门（200 seed 冻结窗） | 9/9 | **9/9** | ✅ |
| 轨迹图横向 sd（120s 窗） | 显著上升（真实 10.04） | **8.08 m**（基线 4.95） | ✅ +63% |

> 口径提醒：P38 是 10 个冻结 seed 的判据口径；L1 是 200 个冻结 seed 的统计门口径；
> 两者不可混读（同一配置 P38 `shotsReg` 与 L1 射门体量读数原本就不同）。

---

## 3. 第一增量：只对防守方做 B1+B2+B3（B4 关闭）

### 3.1 改了什么

在 `compute_mover_candidates` 第一遍算出 `targets[id] = formation_target(...)` 之后、repulsion 之前，
新增 `b_layer_adjust_targets(...)`，只对**防守方**（非控球方）改写 `action=="run"` 的基准目标：

- **B1 分区触发**：球位 3×3（`(2*floor(3*球x), 2*floor(3*球y))` 等价的三区；纵深按攻守方向镜像）
  → 每线（def/mid/att）一个类别 `B_ZONE_CATEGORY[col][row][line]`：0 保持 / 1 收拢 / 2 收敛。
  先验表：球在本方三区 → 后卫收敛、中场收拢；中场三区 → 中场收敛；对方三区 → 锋线收敛（反抢）。
  反侧球员类别 +1（`B_FAR_SIDE_BONUS`，封顶收敛）——让「谁动」依赖球的横向位置。
- **B2 参考点收敛**：`target = base + normalize(ref − base) · max(|ref − base| − margin, 0) · gain`，
  ref = 球。先验：`B_PRESS_MARGIN_M = [5.5, 6.0, 7.0]`、`B_CONVERGE_GAIN = [0.50, 0.55, 0.60]`。
  收拢类别 = 只动 y、朝本队外场重心收（`B_COMPACT_MARGIN_M=2.0`、`B_COMPACT_GAIN=0.35`）。
- **B3 单人追抢**：仅当本拍没有既有逼抢者（`close_down_ids` 为空）时补 1 名选出的追抢者；
  选人成本 = 到球米制距离 + 时段固定确定性扰动（`B_CHASER_SWITCH_M=2.5m`，`b_hash01(id, epoch)`，零 RNG），
  目标 = 停距 6.3m（`B_CHASER_STOP_DIST`）。
- 门将/close_down/chase/corner_prep 目标不覆盖；高亮/松散球/重开准备/攻防转换期整层跳过。

### 3.2 v1（全向收敛）读数

P38（10 seed）：**3/8**（`hd`、`gap`、`latSd` 红）

| 指标 | 读数 | 带 | 结果 |
|---|---|---|---|
| hd 纵深 | 22.168 | [23.385, 28.385] | ❌ |
| spread 紧凑度 | 13.544 | [13.41, 17.01] | ✅（贴下沿） |
| gap 重心间距 | 6.348 | [6.54, 10.14] | ❌ |
| **latSd** | **5.039** | [7.015, 14.015] | ❌（3.886→5.039，+1.15） |
| swarm | 0.666 | [0.451, 0.891] | ✅ |
| fault | 3.486 | [2.45, 7.45] | ✅ |
| midBack | 1.101 | [0.84, 1.28] | ✅ |
| shotsReg | **7.600** | ≥ 5.5 | ✅（但相对基线 16.2 崩掉一半） |

判断：latSd 有正向（+1.15），但 2D 收敛把块往球上压 ⇒ **纵深/间距结构入不了带**；射门量崩到 7.6
（P38 单边下界 5.5 只是掩护，L1 带 [14,29] 必破）。

### 3.3 v2（横向加权收敛：x 分量权重 0）读数

把 B2 改成**只收敛横向分量**（`B_CONVERGE_X_GAIN=0.0`、`B_CONVERGE_Y_GAIN=1.0`），
其余先验收紧（margin `[4.5, 5.0, 6.0]`、gain `[0.55, 0.60, 0.65]`）。P38：**2/8**

| 指标 | 读数 | 结果 |
|---|---|---|
| hd | 23.286 | ❌（差下沿 0.10） |
| spread | 13.786 | ✅ |
| gap | 7.051 | ✅（结构恢复） |
| **latSd** | **4.498** | ❌（x 分量去掉后反而低于 v1） |
| swarm | 0.591 | ✅ |
| fault / midBack | 3.690 / 1.076 | ✅ |
| shotsReg | 9.600 | 仍远低于 L1 带 [14,29] |

判断：横向收敛保住结构，但 latSd 提升缩水，射门体量仍崩 ⇒ **B2「朝球收敛」与事件层的
`OPEN_PLAY_PASS_PRESSURE_M=4.0` 硬门强耦合**；该增量按原样不可用（记录为负结果）。

---

## 4. 第二增量：加 B4 角色横向档位 + 定稿

### 4.1 B4 设计（先验，待标定）

- 5 个角色类：中卫 / 边卫 / 中前卫 / 边前卫 / 前锋（按 `is_defender` + 静态基准 y 归线）。
- 球位三区量化：`col = floor(3·球x)`、`row = floor(3·球y)`（0..2）。
- 档位 `level = clamp(2 + B_LANE_DIR[role]·(row−1)·2 + B_LANE_DEPTH_DIR[role]·(col−1), 0, 4)`，
  偏移 `off = (level−2)·B_LANE_STEP_M`，只叠加到 y（保护纵深/间距结构）。
- 先验：`B_LANE_STEP_M=5.0`、`B_LANE_DIR=[+1,+1,−1,−1,+1]`（后卫/中场随球侧、中场反向拉扯空间）、
  `B_LANE_DEPTH_DIR=[0,0,0,0,+1]`。双方、攻守两相位都生效。

### 4.2 增量读数组（P38，10 seed）

| # | 配置（相对 A 层） | hd | spread | gap | **latSd** | swarm | fault | midBack | shotsReg | P38 |
|---|---|---|---|---|---|---|---|---|---|---|
| R0 | 基线（EXP1 标定后） | 23.691 | 15.458 | 7.151 | 3.886 | 0.736 | 3.567 | 1.081 | 16.200 | 7/8 |
| R1 | 增量1-v1（B1+B2 全向+B3） | 22.168 | 13.544 | 6.348 | 5.039 | 0.666 | 3.486 | 1.101 | 7.600 | 3/8 |
| R2 | 增量1-v2（横向收敛+B3） | 23.286 | 13.786 | 7.051 | 4.498 | 0.591 | 3.690 | 1.076 | 9.600 | 2/8 |
| R3 | 增量2：R2 + B4（track 0.32） | 23.581 | 13.985 | 7.047 | 5.645 | 0.477 | 3.600 | 1.088 | 7.200 | **7/8** |
| R4 | R3 + track 0.40 + step 5.0 | 23.604 | 14.302 | 7.031 | 6.114 | 0.463 | 3.570 | 1.087 | 7.900 | 7/8 |
| R5 | R4 + track 0.55 | 23.504 | 14.117 | 7.059 | **8.178** | 0.638 | 3.570 | 1.093 | 7.800 | **8/8** |
| R6 | track 0.55，B 全关 | 23.900 | 15.158 | 7.224 | 6.554 | 0.782 | 3.667 | 1.083 | 11.500 | 7/8 |
| R7 | track 0.55，仅 B4 | 23.593 | 15.253 | 7.076 | 6.291 | 0.602 | 3.371 | 1.087 | 16.900 | 7/8 |
| R8 | track 0.65，仅 B4 | 23.428 | 15.113 | 7.048 | 7.071 | 0.709 | 3.412 | 1.086 | 16.399 | **8/8** |
| R9 | track 0.65，B 全关 | 23.827 | 15.062 | 7.241 | 8.025 | **0.905 ❌** | 3.520 | 1.080 | 12.400 | 7/8 |
| R10 | track 0.70，仅 B4（未加事件补偿） | 23.765 | 15.139 | 7.140 | 7.582 | 0.748 | 3.433 | 1.087 | 16.000 | **8/8** |
| **R11** | **track 0.70 + B4 + 事件补偿（最终）** | 23.578 | 15.024 | 7.200 | **7.272** | **0.694** | 3.420 | 1.086 | 13.800 | **8/8** |
| R12 | R11 的消融：B4 关 | 23.818 | 14.860 | 7.219 | 7.412 | **0.880**（贴 0.891） | 3.622 | 1.078 | 12.800 | 8/8 |

R10 的 L1（实跑）：**7/9**（`禁区弧 off 比例 0.758 ∉ [0.61,0.75]`、`shot/tackle 0.479 ∉ [0.5,1.5]`）
⇒ 加两条事件标定补偿后 R11：**L1 9/9**。

### 4.3 关键发现（消融）

1. **射门体量崩的元凶是 B1/B2（防守收敛），不是 B4**：
   track 0.55 下，B 全关 shots 11.5 / 仅 B4 16.9；R9（0.65）B 全关 12.4 / R8 仅 B4 16.4。
   B1/B2 关闭后事件层回到基线水平（16 上下），P38 只剩 latSd 一条红。
2. **A 层横向分轨（`EXP1_LATERAL_TRACK`）是 latSd 主杠杆**：
   R6（0.55，B 全关）6.554 → R9（0.65，B 全关）8.025；但 swarm 同步升到 0.782 → 0.905（0.65 时出界）。
3. **B4 的真实作用是压 swarm**：0.65 时 B 全关 swarm 0.905 ❌，仅 B4 0.709 ✅（latSd 8.025→7.071）；
   0.70+事件补偿时 0.880→0.694。B4 用约 0.14–0.96 的 latSd 换 0.19–0.21 的 swarm 余量。
4. **「A 层系数扫描」这条最简解本身不够**：R9 证明单靠 A 层 0.65 会撞 swarm 上界；
   R12 说明 0.70 + 事件补偿后 A 层单独也能 8/8，但 swarm 只剩 0.011 余量（脆弱），
   B4 把余量扩到 0.20。

### 4.4 最终配置（R11）与 like-football / 轨迹

- like-football（5 seed / 12s 窗）：**距离 0.186**（基线 0.252）；`lf.lat` **0.38**（基线 0.25，真实 0.43）；
  位移/窗 11.56（真实 13.46）；混队度 0.80（真实 0.80）；结构：纵深(主) 23.59 / 紧凑度 15.01 / 分边 7.22。
  （未加事件补偿的 R10 同口径为 距离 0.172 / lat 0.38 / 位移 12.19 ——标定补偿使距离略退 0.014。）
- 轨迹图（`render-trajectories.mjs`，120s 窗 t∈[1800,1920]）：**横向 sd 8.08 m / 纵向 sd 13.80 m**
  （基线 EXP1：横向 4.95 / 纵向 15.92；真实：10.04 / 14.35）。
  ⇒ 横向 +63%，但纵向 −13%：**移动预算在 x/y 间被重新分配**（每拍步长上限按归一化欧氏距离，
  横向多了纵向就少）——这是需要记录的副作用。
  图：`.scratch/exp3/out/traj-final2.png`（最终）、`traj-exp1-baseline.png`（基线）☆
  ☆ 实验产物不入库（`.scratch/exp3/` 为新增未跟踪目录）。

---

## 5. 最终配置 diff 摘要（相对 `0fe2989`）

1. **新增 B 层**（`engine/src/lib.rs`，约 250 行，含注释）：`B_*` 私有常量块；
   `b_line_of` / `b_hash01` / `b_role_of` / `b_layer_adjust_targets`（B1+B2+B3，**关闭**）/
   `b_lane_adjust_targets`（B4，启用）；在 `compute_mover_candidates` 第一遍之后、repulsion 之前调用。
2. **A 层横向分轨**：`EXP1_LATERAL_TRACK: 0.32 → 0.70`
   （⚠ 0.32 是拟合值；0.70 是**先验扫描值，超出拟合值约 2×，属补偿而非新机制**，
   真实 tracking 的队侧横向跟球斜率锚为 0.33–0.38，见 `openspec/changes/p38-formation-realism/notes/real-lateral-laws.md` §1.1）。
3. **事件层标定补偿**（B 层几何改动后的联合重标定）：
   - `BASE_DEF_TACKLE: -1.40 → -1.47`（抢断体量/比值；shot/tackle 0.479→带内）
   - `shot_bucket` 禁区弧 saved `22 → 23`（禁区弧 off 0.758→≤0.75）
4. 开关现状：`B_ENABLE=false`（B1/B2/B3 保留代码但不生效）、`B_LANE_ENABLE=true`、
   `B_LANE_STEP_M=5.0`、`B_LANE_DIR=[+1,+1,−1,−1,+1]`、`B_LANE_DEPTH_DIR=[0,0,0,0,+1]`。

wasm：`viewer/engine.wasm` sha256 `474A303FEA6AD8F136E0C484538B68CE51153E53A7EE67F0869CB34C17826018`
（快照 `.scratch/exp3/out/final.wasm`）。

---

## 6. 耦合、权衡与残余风险（必须随结论一起读）

1. **B 层 ↔ 事件层强耦合（已实测）**：防守方目标朝球收敛 ⇒ 最近防守者距离分布左移 ⇒
   `OPEN_PLAY_PASS_PRESSURE_M=4.0` 硬门触发率上升 ⇒ tier② 射门推进机会减少。
   同一机制也让抢断量上升（B 全关 shot/tackle 0.479 的失败正是抢断变多）。
   ⇒ **任何加「防守收敛」的 B 层都必须与事件层概率常数一起重标定**，不能当纯队形改动合入。
2. **A 层横向分轨 0.70 超出拟合锚（0.33–0.38）约 2×**：latSd/swarm 双达标是**在这条补偿系数上**
   达到的；它同时把整队横移幅度做成拟合值的两倍，画面观感与 P18 类行为门需要另行复核
   （本实验时间盒内未跑 P18 canary / 全量 `--ignored`）。
3. **轨迹纵向 sd 从 15.92 降到 13.80**：拍内步长预算被横向吃掉；真实侧为 14.35，
   即最终配置的纵向其实更接近真实，但这是「预算重分配」的副作用而非设计目标，需记录。
4. **P38 是 10 seed 判据口径**：`latSd 7.272` 距下界仅 0.26；`swarm 0.694` 距上界 0.20。
   换 seed 集/窗位置可能翻边——**不构成合入结论**。
5. **主客不对称/进球总量**（EXP1 已记录的残余风险）本轮未跟踪；事件常数再动一次，需重跑
   600 场冻结窗确认 H/A 与总进球，本轮未做。
6. B1/B2/B3 的代码保留在树内但被 `B_ENABLE=false` 关闭：保留是为了让审阅者能复现负结果；
   若后续要启用，必须先解决 §6.1。

---

## 7. 未做 / 负结果清单

- ❌ **B1+B2+B3（防守方）**：原样不可用（P38 结构退化 / 射门体量崩）。已如实记录两个子版本读数。
- ❌ **B 层单独（A 层 0.32 不动）**：最优也只到 R3/R4（7/8，latSd 5.6/6.1，且射门体量仍崩）。
- ❌ **B 层作为「独立新机制」的假设**：数据不支持——latSd 主杠杆是 A 层常数扫描；
  B4 是 swarm 守门器。**这是本实验最重要的负结果**。
- ⬜ 未跑：默认 `cargo test` 全量、P18 canary 产物门（需要干净树 + source_commit）、
  like-football 盲测/panel、P38 判据 ratchet 升格评估（本实验不涉及）、600 场主客/进球复核。
- ⬜ 未做 B4 的「真实 tracking 分布拟合」版（当前 5 档表是先验，未做逐位拟合）；
  B4 档位与球区的映射只做了 2 组粗调（0.32/0.40/0.55/0.65/0.70 是 A 层扫描，不是 B4 档位拟合）。

---

## 8. 复现

```powershell
cd D:\pitchcraft-exp3
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
# 构建（最终配置）
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm'
# P38 判据
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
# L1 硬门
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --test realism --release -- --ignored 2>&1 | tail -20'
# like-football / 轨迹
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine .scratch\exp3\out\traj-final2.png EXP3-final2 120
```

实验记录：`.scratch/exp3/`（wasm 快照 `final.wasm`、轨迹 PNG、只读探针 `probe-latsd.mjs`）。
探针 `probe-latsd.mjs` 的用途：在 P38 的 latSd 窗口上拆分「主队防守帧占比 + 逐人 y sd」，
用于判断「B 层为什么只涨 1 点几」（结论：窗口内约 40–60% 的帧主队不处于防守相位，防守-only 层被稀释）。

---

## 9. 数字出处

| 数字 | 出处（本轮实跑） |
|---|---|
| 基线（R0）P38 八条 + like-football 0.252 / lat 0.25 | 起点 `0fe2989` 的 `check-criteria.mjs` / `like-football.mjs`；同值见 `EXP1-CALIBRATION.md` §1 |
| R1–R12 全部 P38 读数 | 本 worktree `check-criteria.mjs` 逐次实跑（每次重建 wasm 后立即跑；命令见 §8） |
| R10 的 L1 7/9 与 R11 的 L1 9/9 | 本 worktree `cargo test --test realism -- --ignored` 实跑输出（R10：禁区弧 off 0.758、shot/tackle 0.479；R11：9 passed / 0 failed） |
| like-football 0.186 / lat 0.38 / 位移 11.56 / 混队 0.80 | 最终 wasm 上 `node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12` |
| 轨迹横向 sd 8.08 / 纵向 13.80（最终）；4.95 / 15.92（基线 exp1） | `render-trajectories.mjs`（120s 窗）；基线在 `D:\pitchcraft-exp1` 同脚本同参数实跑 |
| 真实侧 10.04（窗内）/ 14.35、队侧横向跟球斜率 0.33–0.38、个体横向方差三分法 | 仓内既有：`notes/real-lateral-laws.md` §1.1/§2.1、`findings-final.md` §4b；本实验未重跑真实侧 |
| 基线 EXP1 事件常数（`BASE_DEF_TACKLE -1.40` 等） | `EXP1-CALIBRATION.md` §2 |
