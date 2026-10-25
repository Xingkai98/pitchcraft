# 间距不变量修复（p53）与默认套件红归因

树：`D:\pitchcraft-exp3`（起点 `0fe2989` → R11 提交 `2a14601` → 本修复）
日期：2026-10-25
范围：只改 `engine/src/lib.rs` 的同队间距分离兜底；不改事件类型、协议、tick/beat、判据工具。
表述合规：机制表述为「基于本地真实 tracking 分析 + 本仓判据的自研机制」，参数为先验/扫描值。

---

## 1. p53 失败读数（修复前）

`cargo test --lib p53_same_team_spacing_ge_2m --release`：

```
同队发射位置间距不足: seed=9 t=4799 id=4/0 d=1.969697m (< 2.2)
```

- 缺额 0.2303m（阈值 2.2m）；位置为**发射位置**口径（mover `to` / main `x2y2`）。
- 几何：门将 id0 在 x≈0.005（贴门线）被分离推到 x=0.0（clamp 吃掉位移）；
  中卫 id4 与门将落在同一 y 区间，被推到 (0.0173,0.4864)——两者 1.9697m。

## 2. 根因（solver 既有软保护叠加，不是新约束）

在 `separate_same_team_m` 主循环退出处加临时探针（已删除）得到：

```
[dbgsep] a=0 b=4 d=1.9729 frozen=false/false budget=3.514/0.000 starts=(0.0050,0.5069)/(0.0213,0.5344)
```

- 主循环有两个**软**保护：① 每人每拍分离位移预算 `SAME_TEAM_MIN_DIST_M × 3 = 6.6m`（防横穿球场）；
  ② 边界 `clamp01`。
- id0 已贴 x=0，无处可退（可动侧推不动）；id4 的 6.6m 预算被本拍前面若干 pair（端点修正 +
  拍内扫掠侧推）耗尽（budget=0.000）⇒ pair (0,4) 整拍残留，主循环 `changed=false` 退出。
- R11 的几何（A 层横向分轨 0.70 + B4 档位）把 id4 推到与门将相同的 y 区间，**触发**了这条既有
  solver 弱点；p53 之前之所以绿，只是因为旧几何没在同一拍同时撞上「门将贴线 + 队友预算耗尽」。

## 3. 改法（最小、仅兜底）

`separate_same_team_m` 主循环之后追加**残留 pair 兜底**：

- 触发条件：主循环退出后仍有同队 pair `d < SAME_TEAM_MIN_DIST_M`（正常拍不触发、零漂移）；
- 每名球员额外限额 `SAME_TEAM_MIN_DIST_M`（2.2m）；仍尊重 `frozen`（高亮参与者）与 `sent_off`；
- 迭代 ≤ `SAME_TEAM_SEPARATION_MAX_ROUNDS`（12）轮，`separate_pair_m` 复用既有米制分离；
- 硬不变量（#53 同队发射间距）优先于「单拍位移软预算」。

**没有**改位置更新路径、事件发射、时钟或协议；`p53_separate_pair_clamps_to_pitch` 等既有单测
全部保持原样通过（clamp 语义未动，只在 solver 层兜底）。

## 4. 修复后读数

| 项 | 修复前 | 修复后 |
|---|---|---|
| `p53` 家族（`cargo test --lib p53`） | 10/11（`ge_2m` 红） | **11/11 绿** |
| 最坏同队发射间距（seed 1..10 全扫） | 1.9697m（seed9 t4799 id4/0） | **2.189570m**（seed7 t4979 id13/16；扣除测试注释所述序列化舍入后贴阈值） |
| P38 判据 | 8/8（latSd 7.272 / swarm 0.694） | **8/8**（latSd 8.165 / swarm 0.753） |
| P38 八条（修复后） | — | hd 23.716 / spread 15.066 / gap 7.178 / latSd 8.165 / swarm 0.753 / fault 3.430 / midBack 1.086 / shotsReg 14.599 |
| L1 硬门（`--test realism --ignored`） | 9/9 | **9/9**（200 seed 冻结窗） |
| like-football 距离 / lat | 0.186 / 0.38 | **0.181 / 0.38**（位移/窗 11.81，混队度 0.80） |
| 轨迹图横向 / 纵向 sd（120s 窗） | 8.08 / 13.80 | **8.08 / 13.80**（到 2 位小数不变） |

> 修复前后 P38 有微差（latSd 7.272→8.165、shotsReg 13.8→14.6）：兜底在极少数拍多推了几厘米到
> 2m 级位移，事件流轻微漂移；两版都满足全部判据。**B-LAYER-REPORT.md 的 R11 表是修复前读数**，
> 最终口径以本文件为准。

P38 完整读数（修复后 wasm `e28d51e0f2be4ad47d49e1c011b7f22dfcb1aa8043be9427744e2e3e1d0905f7`，10 冻结 seed）：

```
✅ 纵深 23.716 / 紧凑度 15.066 / 重心间距 7.178 / 横向位移 sd 8.165
✅ y 两两相关 0.753 / 断层幅度 3.430 / 各线均衡 1.086 / 普通射门 14.599   → 8/8
```

## 5. 两条默认套件红：归因（只定位，不改）

**结论：两条都是基座 `0fe2989` 就有的环境性红（Windows checkout 的 CRLF 行尾），不是 R11 引入，也不是真问题。**

| 红 | 现象 | 归因证据 |
|---|---|---|
| lib `p15_recorder_stays_out_of_the_decision_path` | `找不到 recorder impl 块的结尾` | 守卫在 `observation.rs` 源码里搜 `"\n}\n"`；该文件在本 checkout 是 **CRLF**（`file` 实测 `with CRLF line terminators`），`}\r\n` 永远匹配不到。`git diff 0fe2989 HEAD -- engine/src/observation.rs` **为空**。在基座 worktree（`D:\pitchcraft-exp1`，HEAD=0fe2989）复跑：**同样 panic**（行号 7649，同一句）。 |
| p124 `intent_features_cannot_reach_positions` | `match_intents 的签名变了` | 守卫搜的是 LF 拼接字面量 `"pub fn match_intents(\n    snaps: ..."`；`engine/tests/p124/intent.rs` 也是 CRLF。`git diff 0fe2989 HEAD -- engine/tests/p124/` **为空**。基座 worktree 复跑：**同样 panic**（同一句）。 |

**全量默认 lib 套件对比**（`cargo test --lib --release`）：

| 树 | 结果 | 失败项 |
|---|---|---|
| 基座 `0fe2989`（exp1） | 197 passed / **4 failed** | p15、`observation::tests::truncated_stream_produces_a_full_time_gap_by_design`、`observation::tests::every_episode_and_restart_object_has_event_indexes_or_a_documented_exception`、`p30_foul_cooldown_decays_every_tick` |
| R11 + 本次修复 | 198 passed / **3 failed** | 同上三条中除 p30（R11 下偶然变绿）；**无新增失败** |

（另：p124 是 integration test，不在 lib 套件内；其基座红与上表同源。）

## 6. 残余风险

1. 兜底允许单拍位移**超出软预算**最多 2.2m/人，仅发生在「主循环退出后仍违规」的拍；
   `p5_approach_cap`（位移上限）在本次全量 lib 套件中通过。
2. `frozen`（高亮参与者）之间的 pair 仍可能 <2.2m——它们不可动、也不作为 mover 发射；
   p53 只扫发射位置，本轮未改这一语义。
3. 修复改变了极少数拍的事件流：若走 golden 基线需重基线（本实验未跑 golden master）。
4. 修复只保证**同队发射位置** ≥2.2m；拍内插值中点（detector 口径 2.0m）由既有扫掠约束负责，
   本次未改其构造。

## 7. 复现

```powershell
cd D:\pitchcraft-exp3
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --lib p53 --release'
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/pitchcraft-exp3/engine && cargo test --lib --release'   # 全量默认 lib 套件
$env:Path='D:\Software\node-v24.22.1-win-x64;'+$env:Path
$env:NODE_OPTIONS='--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs        # 8/8
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12                  # 距离 0.181
# 基座对比（只读复跑）：cd D:\pitchcraft-exp1 后同上
```
