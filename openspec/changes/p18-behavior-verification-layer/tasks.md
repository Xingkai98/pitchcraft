# P18 任务

> ⚠️ **实现前须先闭合 design §7 的待决策，并经用户确认**（本仓 OpenSpec 流程）。
> Slice 0（侦察）已完成并过第一轮独立 grill（design §10 记录了它抓到的 17 条修订）。

## Slice 0 — 侦察（✅ 已完成 2026-09-30）

- [x] 实测「四类 + restart 各自有没有真实参照」——**推翻了主 session 的前提**
- [x] 落成 note：`.scratch/notes/18-recon-2026-09-30.md`
      （顶部已加**被 grill 推翻条目**的更正横幅）
- [x] 探针**归档且可复现**：`notes/probes/real-behavior-probe.mjs` +
      `engine-behavior-probe.rs.txt` + 两者的 `.out.txt`
- [x] 第一轮独立 grill（opus，自写实现复核）→ **17 条修订**（design §10）
- [x] 落成 change：proposal / design / spec delta / tasks

### 权威数字（**全部来自可复现探针**，逐场算再跨场平均）

| 量 | 引擎（30 seed） | 真实（20 场） | 倍数 | 立？ |
|---|---:|---:|---:|---|
| A1 链墙钟时长 (s) | 49.65 | 17.50 ± 2.03 | **2.84×** | ✅ |
| A2 链内动作间隔 (s) start→start | 12.64 | 5.17 ± 0.69 | **2.44×** | ✅ |
| A2' 同上 end→start（对照） | — | 3.52 ± 0.66 | 3.59× | 并列报 |
| A3 链内动作数 | 3.90 | 3.60（全部）／4.11（正时长） | 1.08× / 0.95× | ⚠️ 护栏 |
| B1 `P(延迟 ≤ 0)` | **0.562** | **0.000** | ∞ | ✅ 结构性 |
| B3 `P(10 s 内无)` | 0.429 | 0.192 ± 0.032 | 2.23× | ✅ |
| C1 以射门**收尾**链占比 | 0.1767 | 0.0661 ± 0.0170 | **2.67×** | ✅ |
| C1' **含**射门（对照） | — | 0.0908 ± 0.0223 | — | 并列报 |
| C2 传球失败率 | 0.173 | 0.166 ± 0.033 | 1.04× | ❌ 不立 |

## Slice 1 — 真实侧参照提炼（**前置：design §7 决策 5/6**）

- [ ] `notes/criteria/real-behavior.mjs`：**生产版**（不是把 `probes/` 那份搬过来，
      见 design §5 的警告）
- [ ] 口径实现（**逐场算再跨场平均**；口径 C1–C6 照 `probes/real-behavior-probe.mjs` 头部）：
      - [ ] 链 = 连续同队 `player_possession` + **排除死球打断**（`game_interruption_before`）
      - [ ] 间隔：**`start→start` 与 `end→start` 两栏都报**（主口径 start→start）
      - [ ] 零时长 pp 行：保留在动作数、排除在时长/间隔外；**`*_all` 与 `*_pos` 两栏都报**
      - [ ] 转换反应：**`P(延迟 ≤ 0)` 与 `P(10 s 内无)`**，且报**延迟的整体分布**
            （不是场均值的分布——这两者容易混，初稿混过）
      - [ ] 射门链：**「收尾」与「含」两栏都报**（差 37%）
      - [ ] 传球失败率：分母 = `end_type == pass` 的行（**空值不是未知**，实测空⟺非 pass）
- [ ] 产出 `real-behavior-reference.json`（**入库**）：每场值 + 跨场分布 + CSV sha256 +
      口径版本 + 场次清单；**不写 gitignored 绝对路径**
- [ ] 跨数据集一致性（若决策 5 选「纳入 Metrica」）
- [ ] 单测：解析器正确性 + 空值语义 + 死球排除 + **两栏都产出**（防单点口径回归）

## Slice 2 — 引擎侧量导出

- [ ] `engine/tests/p18/gates.rs`：`#[path]` 活读 `p17a/metrics.rs`，补测缺的量
      - [ ] **转换反应**是 p17a **没有**的量——**必须按 contest reason 分层**
            （五种成因形态相反，见 design §2.2 的表）
      - [ ] 链内动作间隔：p17a 的 `action_gap_seconds`（核口径一致后）
      - [ ] 射门链：**「收尾」**（末行动是射门），不是「含」
- [ ] `engine/tests/p18_behavior_gates.rs`：`#[ignore]` 落盘 `target/p18-gates/engine.json`
      - [ ] **provenance**：seed 区间 + 引擎源码指纹 + 口径版本 + **生成它的探针名**
- [ ] 守卫：`p18` 的引擎侧量与 `p17a` **同源**（防复制后漂移）
- [ ] **零 `engine/src/` 改动**

## Slice 3 — 判据组与判据器

- [ ] `notes/criteria/gates-spec.json`：
      - [ ] A 组：A1 链时长、A2 间隔、**A3 守恒护栏**（带 `structuralExemption` 理由）
      - [ ] B 组：B1 `P(≤0)`、B2 分布形态、B3 `P(10s 内无)`——**按 contest reason 分层**
      - [ ] C 组：C1 射门收尾链占比（带 `structuralExemption` 理由）
      - [ ] **每条带 `sameThing`**（两侧定义 + 为什么可相减）
      - [ ] **`excluded` 逐条留档**（「`P(10s 内无)` 单独」= 不同义、「动作数」= 落带内、
            「传球失败率」= 两侧都在 L1 带内）＋**理由与实测数字**
      - [ ] D 组 restart：**显式声明不可得**（含可得部分的实测值 + 缺什么）
      - [ ] **零方差量的例外**：`P(≤0)` 真实恒 0 ⇒ **不套 `mean ± 3sd`**，按采样栅格定（design §3.1）
- [ ] `notes/criteria/check-behavior-gates.mjs`：成组否决 → 打印倍数/分位 →
      **退出码恒 0**（报告期）
- [ ] `notes/criteria/calibrate.mjs`：标定 + 合成变体 + 真实历史变体

## Slice 4 — 判别力证明（**本 change 唯一的门槛**）

- [ ] `notes/criteria/gates.test.mjs` 反证条（逐条）：
      - [ ] 每条判据构造「越该条限、不越其余条限」的输入 ⇒ **只有该条红**
      - [ ] 反证条**有区分度**（P36 教训）
- [ ] 成组否决测试
- [ ] 合成变体测试：改 A 组不影响 B/C 组的判定
- [ ] 真实历史变体测试：间隔 12.64 → 8.54 s（`#17A` 实测）**仍然全红**
      （8.54 / 5.17 = 1.65×）
- [ ] 同源测试：参照 JSON 的 sha256 与 CSV 一致；缺 CSV 时判据器仍可跑
- [ ] **provenance 测试**：引擎侧 JSON 缺 seed 区间/源码指纹 ⇒ 判据器拒绝（不静默用）
- [ ] 口径回归守卫：两侧都是「逐场再跨场」（防池化）；**两栏都产出**（防口径单点）
- [ ] ⚠️ **在产物说明里如实写**：这些测试证明的是「判据没被改坏」，
      **不是**「判据组能分辨真改善」（design §4）

## Slice 5 — 接入与收尾

- [ ] `verify.sh`：加一步跑 `gates.test.mjs`（**门槛**）+
      一步跑 `check-behavior-gates.mjs`（**报告期，不阻塞**）
- [ ] **不改** `tools/fetch-tracking-data.mjs` / `convert-*.mjs`（源码指纹哨兵）
- [ ] 走 `CLAUDE.md` §3 代码审阅闭环（独立 subagent → 修复 → 再审阅，全过才算完成）
      ⚠️ **设轮次上限**：连续 2 轮问题在同一族且修复在引入新失败面 ⇒ 止损，
      回退到能工作的版本 + 如实记为「已知残余风险」
      （⚠️ 本仓先例：P17B 跑了 9 轮不收敛、第 6 轮就该止损）
- [ ] 更新 `.scratch/notes/behavior-realism-analysis-roadmap.md` §6/§8 与 `.scratch/map.md`
      ——**改 route 时要扫全文**（roadmap §8 的教训），且**必须记两条**：
      ① 本 change 交付**四类**（restart 那类如实声明不可得，是对 `map.md` 五类授权的偏离）；
      ② **#15B 的重开前提可能已满足**（`phases_of_play` 这个从未盘点的观测来源）
- [ ] 把「引擎侧产物必须带 provenance」这条 spec requirement 对上本仓既有教训
      （P38 #87「引擎数字来自未合入分支而无人发现」）

## Slice 6 — 升门路径（**不在本 change 范围，写清楚即可**）

- [ ] 在 design / 判据器注释里写死：`#19` 交付合格机制后 →
      用它标定工程带宽（P38 `calibrate.mjs` 形态）→ 把 exit 码接进 `verify.sh`
- [ ] **不得**为了让判据"现在绿"而放宽成 `[未标定]` 或拍一个宽到没判别力的带
- [ ] ⚠️ **对 `#19` 的如实提醒**：本 change 交付**报告期判据**（退出码恒 0），
      `#19` 拿到的是「报告 + 倍数」而非可阻塞的门
