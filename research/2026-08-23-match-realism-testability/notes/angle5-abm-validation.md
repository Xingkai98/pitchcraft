# Angle 5 — Agent-based model / 仿真验证方法论

## 结论摘要
仿真 V&V 的标准框架（Sargent 及其后文献）把「模型建得对吗」（verification）与「模型对吗」（validation）分开；validation 的客观手段 = **用统计检验把模型输出与真实系统数据对比**。ABM 文献进一步给出三种 validity（replicative / structural / predictive）与 pattern-oriented modeling（多模式同时匹配）。这些直接支撑本项目「多 seed 统计分布验证 + 机制检查 + 视觉抽查」的分层思路。

## 来源与要点

### Sargent 框架（奠基）
- **Verification**（"building the model right"）：计算机模型是否正确实现概念模型。
- **Validation**（"building the right model"）：模型是否准确代表真实系统、满足用途。
- **Operational validation**：模型输出是否充分回答目标问题——用统计检验（ANOVA、置信区间、KS、Cramér–von Mises、chi-square、Mann-Whitney、回归、Theil 系数、时序分析、图形法）；Balci & Sargent (1984) 用同步置信区间做多响应验证。
- **Data validity / conceptual model validity** 区分开。
- **内部有效性（internal validity）**：对随机仿真，重复运行之间的一致性要用统计技术检验——单次运行不能代表模型。→ 这就是「多 seed」的学术正当性。
- **校准 ≠ 验证**：只把参数调到「看起来对」不能算验证（Sargent 将 calibration 与 validation 分开）。→ 本项目「人眼看」只是主观校验，必须补客观统计。
- **至少两种验证技术**；验证不绝对（no absolute validity），credibility 是程度问题。
- 来源：Sargent 2010/2012/2013；BISS 讲义 https://people.cs.nott.ac.uk/pszps/biss2013/resources/BISS_Lec28.pdf ；COVID 护理仿真文（引 Sargent 42）https://pmc.ncbi.nlm.nih.gov/articles/PMC9560613/

### ABM 的三种 validity（哲学/方法论文献）
- **Replicative validity**：模型能否复现已观测案例/数据。
- **Structural validity**：因果结构是否真实（与 Pearl 因果阶梯相关）；对干预/机制探究重要。
- **Predictive validity**：能否预测未见数据（out-of-sample）。
- 三者不一定一致：好复现 ≠ 好预测（ML 可预测同系统未来数据但无机制解释）。
- 主观方法（专家判断、Turing 式评估）常见但**不可扩展、易偏倚**——尤其对黑盒 LLM agent 模型。
- 来源：SEP "Agent-Based Modeling in the Philosophy of Science" https://plato.stanford.edu/archives/Win2023/entries/agent-modeling-philscience/ ；M&S handbook (SCS) https://www.hsdl.org/?view&did=716478

### Pattern-Oriented Modeling (POM)
- 源于理论生态学（Grimm et al.）：只匹配单一输出变量不够，模型要**同时复现多个尺度上的多个模式**（filter 掉结构错误模型）。「trajectory validity」= 仿真穿过与实证数据相同的 validity regions。
- → 对本项目：不要只断言场均进球；同时断言射门、射正、角球、控球、射门位置分布、节奏，多模式同时匹配才可信。这也是对抗「调参过拟合单指标」的手段。
- 来源：search 摘要汇总（Pampas Model validation 一文亦印证多策略组合）；https://www.semanticscholar.org/paper/Using-Empirical-Data-for-Designing%2C-Calibrating-and-Troitzsch/f5c55efea2b05a9e115fb2384a1d82190bd385d3

### 实践案例
- **Pampas Model（阿根廷农业 ABM）**：先复现结构性方向，校准后复现幅度；教训 = 需要 process/component validation + empirical validation 多策略组合。
  - https://bdu.siu.edu.ar/bdu/Record/B-22-47031
- **CATS 模型 ex-post validation**：历史期（1982-2000）模拟 vs 实际数据，分布/拟合优度/图形工具比较。
- **验证技术大表**：ANOVA、置信区间、Hotelling T²、多元 ANOVA、非参拟合优度（KS、Cramér–von Mises、chi-square）、非参均值检验（Mann-Whitney-Wilcoxon）、回归、Theil、时序谱分析、t-test、图形法（Balci & Sargent）。→ 本项目最相关：chi-square（分类计数）与置信区间（连续/计数均值）。

## 对本项目的可迁移性
- 直接可用：Sargent internal validity = 多 seed 重复运行一致性；operational validation = 统计对比目标区间；「至少两种验证技术」= 统计 + 不变式 + golden master 组合。
- 直接可用：POM 多模式同时匹配（进球+射门+射正+控球+位置分布一起断言）。
- 校准≠验证的警告：本项目的「视觉验收」是主观校验，不能作为真实性验证的唯一依据。
- 不成立：replicative/predictive 需要真实系统数据做基准——本项目只有公开联赛均值（aggregate），没有逐场比赛的真实事件流，所以做「复现」只能到分布级，做不了事件级复现。
