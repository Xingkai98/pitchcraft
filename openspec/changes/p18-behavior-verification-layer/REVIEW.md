# P18 实现期审阅记录

本文件记录 **实现完成后**的独立审阅（`CLAUDE.md` §3 的强制闭环）。
设计期的三轮 grill 记录在 `design.md` §10 / §12 / §14。

## 第一轮（opus，独立零记忆）

**结论：1 BLOCKER + 2 P1 + 5 P2，全部已修。**

| 级别 | 问题 | 处置 |
|---|---|---|
| **BLOCKER** | `verify.sh` 的新门槛步在**干净 checkout / CI 上必红**——它读的引擎产物是 gitignored，而 verify.sh 与 CI 从不生成它 | 缺产物分支也打印「报告期」；产物生成步进 verify.sh（第二轮进一步） |
| **P1** | **假覆盖**：spec 的用户裁定 scenario（C1「每场次数」对照栏）**未实现**，却被一条只查字段**类型**的测试伪装成已覆盖 | 判据器真的打印对照栏；测试改为断言**输出文本** |
| **P1** | design §6 两行标「门槛」但仓库里没有对应测试 | 补 provenance 测试 + **陈旧哨兵**（产物指纹 vs 当前源码） |
| P2 | 变异缺口：护栏 `realKey` 串线 / `dir` 翻反抓不到 | 补两条守卫 |
| P2 | 报告期那步加了 `|| true`，与 P38 先例相反 | 去掉（注入崩溃实测：确实会红） |
| P2 | 文档漂移 / 死字段 / 扫文本只看一个文件 | 逐条修 |

## 第二轮（opus，独立零记忆）

**结论：核心残余是「CI 上 5/24 空转」——已修；其余为如实记录的残余。**

| 级别 | 问题 | 处置 |
|---|---|---|
| **P1** | **CI 上 `gates.test.mjs` 有 5 条走跳过分支**（引擎产物不存在），恰好含第一轮两个 P1 的**修复本体** | **verify.sh 加产物生成步**（30 seed ≈2s）⇒ 干净树模拟：**28/28 全绿，0 跳过** |
| **P1** | 真实侧**发货数据**的 provenance 无门（只测临时坏副本） | 补「发货数据必须带全部 required provenance」测试 |
| P2 | 真实侧无陈旧哨兵（引擎侧有） | 补：`real-behavior.mjs` 的 `CALIBER_VERSION` 必须 == 产物的 `caliberVersion` |
| P2 | `floorFactor` 与 `bound` 算式无人守 | 补两条断言（含用户裁定的 0.8） |
| P2 | 扫文本 ban 列表与自述不符（`Phase` 没禁） | 加进 ban 列表 + 加一致性守卫 |
| P2 | `real-behavior.mjs` 声称有 `--verify` 模式（不存在） | 更正注释（校验实际在 `gates.test.mjs`） |
| P2 | 残留 `engine.json` 文档漂移 | 已清 |

## ⚠️ 如实记录的残余风险（**未修**，按止损纪律）

第二轮审阅指出的以下各项**不影响正确性**，但**降低可审计性**；
按「连续两轮同族 ⇒ 止损」的纪律，**不再迭代**，在此如实记录：

1. **`gates-spec.json` 的死字段**：`engineArtifact.path` / `realArtifact.path` /
   两处 `referenceKeys` / `spec.caliberVersion` / `notRedone` / 各条 `group` /
   `band.note` / `excluded[].evidence` —— 无任何代码消费。
   （判据器**硬编码**路径，故声明的 path 可与实际漂移。）
   ⚠️ 第二轮第一版修法是「改 `referenceKeys` 的错键」——那修的是**没人读的字段的值**，
   改对了也永远测不出来。**这是本仓「死常量当机制」的同型**，故不再投入。
2. **`engineCenter` 对三条主判据（A1/A2/B4）是死字段**（只对护栏 A3/C1 是活的
   ——它定义「目标方向」）。
3. **`pursue_*` / `looseSegCount` / `approachInstances` / `perGame[]` 写了没人读**：
   它们是**报告项的数据源**（design §2.2.2 的 B1–B3/B5 撤销依据），
   但 B1–B3/B5 已撤销 ⇒ 判据器不读、无测试断言。
   **数字烂了不会红。**
4. **`engine/src/` 零改动是事实（`git diff` 为空），但仓库里没有自动守卫**：
   spec 的 `Scenario: 引擎零改动` 无对应测试，也无 pre-commit / CI 检查。
   （最接近的是陈旧哨兵——它只逼你「改了要重生成」，不禁止改。）
5. **扫文本守卫的 token 面**：`Phase` 已加进 ban 列表并有「ban 列表与自述一致」的守卫；
   但该守卫读的是**源码里的字面量**，不是「两个文件真的不含这些词」的独立验证
   （不过 `wording_guard_rejects_phase_vocabulary` 做了后者，两者互补）。

**为什么止损**：这两轮问题**同族**（都是「门/守卫的覆盖半径与它的声明不符」
——第一轮是恒红、第二轮是空转），且第二轮的修复本身又在**引入新失败面**
（加产物生成步 = 给 verify.sh 增加了对 engine 构建的依赖）。
按本仓先例（P17B 九轮不收敛、第 6 轮就该止损），**到此为止**。

## 判别力证据（本 change 唯一的门槛）

- **11 种定向变异全部被抓，0 漏**（A1 band 删空 / A2 串线 / C1 串线 / C1 dir 翻反 /
  B4 带放宽 / A1 engineKey 打错字 / C1 删对照栏 / A3 删 sameThing /
  B4 删 kindClass / excluded 清空 / D-restart 删 toMakeItAvailable）。
- 每种变异后**均还原并 diff 确认 pristine**。
- **CI 场景实测**：干净树（无 `engine/target`）+ verify.sh 的产物生成步 ⇒ **28/28 全绿，0 跳过**。

⚠️ **如实标注**：以上证明的是「**判据没被改坏**」，
**不是**「判据组能分辨真改善」——后者需要「合法配置簇」，
而那要在 `#19` 交付机制之后才存在（design §4）。
