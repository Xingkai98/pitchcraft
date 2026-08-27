# Angle 2 — 足球比赛仿真模型的学术验证（分布验证）

## 结论摘要
学术上对「进球数/场」的建模验证主流是 **Poisson / negative binomial 分布拟合 + goodness-of-fit**（比较观测与期望频数）。Maher 1982 是奠基作。对本项目最相关的是：**验证产出的比赛结果分布「像不像足球」= 对比分布，而非单场**。

## 来源与要点

### 奠基作
- **Maher (1982), Statistica Neerlandica**：独立 Poisson 模型（每队攻/防强度参数）对足球比分「reasonably accurate」，但有小的系统性偏差；bivariate Poisson（两队比分相关）可改进。此前作者们曾倾向 negative binomial。
- **Loyola eCommons 研究（发表在 NEJSDS 2023）**：验证 EPL 进球符合 Poisson 过程——单场进球数（Poisson）、进球间隔（exponential）、进球时刻（uniform）"do a great job"。
  - https://ecommons.luc.edu/grs/2021/Sciences/1/ 与 https://nejsds.nestat.org/journal/NEJSDS/article/1/info

### 反例/来源分歧
- **FIFA 世界杯 1938-2006 数据分析（arXiv 0909.4555）**：与同均值 Poisson 相比存在「高比分过量」，**negative binomial 拟合更好**（NB = Gamma 混合 Poisson）。该数据两队的比分间无相关性 → 支持独立 Poisson 假设。
  - https://ar5iv.labs.arxiv.org/html/0909.4555
- → 结论：Poisson 是常用基线但低估大比分；对「进球总数范围校验」这种粗粒度用途，Poisson/NB 都够用；对「引擎硬编码进球率实现是否正确」的测试，用**二项分布**（每射门独立同概率）而不是 Poisson。

### 预测性模型（如何验证 sim 的输出）
- **Dyte & Clarke (2000), JORS**：基于 FIFA 排名 + 主场的 ratings-based Poisson 模型，成功复现 1998 世界杯比分分布。验证方式 = 模拟 vs 实际结果分布比较。
- **Champions League 格式研究（arXiv 2508.08290）**：Poisson "one of the most used statistical models for simulating football results"，λ 用 Elo；验证 = train/validation 切分（2005-23 vs 2023-25），比较 outcome 预测正确率与 Rank Probability Score。
  - https://ar5iv.labs.arxiv.org/html/2508.08290
- **蒙特卡洛赛季模拟（LUT bachelor thesis）**：以 xG 为 Poisson λ，重复模拟（如 10 万赛季）出联赛积分/降级概率分布。→ 「重复运行 + 统计分布输出」的范式。
  - https://lutpub.lut.fi/bitstream/handle/10024/167419/Bachelors_Thesis_Peltola_Eetu.pdf

## 对本项目的可迁移性
- 可迁移：用「模拟 N 场 → 统计分布 → 与目标分布/区间对比」的范式验证引擎的射门/进球产出。
- 可迁移：比较观测频数与期望频数（chi-square / 似然比）——本项目硬编码概率正好可做。
- 不成立：不需要建立攻防强度参数模型（当前引擎无属性差异）；Poisson 全赛程分布拟合对「当前集锦式引擎」过于精细，先用带容忍带的计数断言。
