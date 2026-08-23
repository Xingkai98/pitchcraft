# Angle 3 — 自动化游戏测试 / 不靠人玩的验证技术

## 结论摘要
不靠人眼维护真实性的四类成熟技术：(1) **golden master / characterization**（冻结基线输出防漂移）；(2) **property-based / 不变式测试**（对任意 seed 断言不变量）；(3) **统计分布断言**（chi-square / 置信区间，对确定性引擎的多 seed 聚合）；(4) **自动化 playtesting**（AI 代理代替人类玩家生成数据做平衡/回归分析）。对本项目，前三类全是「确定性引擎 + 事件流」的直接红利。

## 来源与要点

### Golden master / characterization testing
- Michael Feathers《Working Effectively with Legacy Code》(2004) 提出 characterization test：先捕获旧版输出为 golden master，再对比新输出，任何差异都视为回归。
- 要点：
  - 对比冻结基线而非「上次绿 build」（防止质量逐小步退化）；
  - 重新基线必须是人工审查后的刻意动作（不能自动接受新输出）；
  - 非确定性输出需 scrub（时间戳/浮点/随机）再比较；
  - 常用工具：ApprovalTests、Jest snapshots、pytest-snapshot、TextTest。
  - 局限：只检测「变了」，不验证「对不对」——正确性判断仍靠人。→ 与统计/不变式测试互补。
- https://github.com/chicio/Golden-Master-Testing-Characterization-Test （README 概述）；https://deepwiki.com/franiglesias/golden/3.3-golden-master-testing ；https://ep2020.europython.eu/talks/4ALvmfv-tests-that-almost-write-themselves/

### Property-based testing
- QuickCheck/PropEr：随机生成输入 + 断言性质 + shrinking 找最小反例。著名论文来源 Handley thesis（Nottingham）。
  - https://people.cs.nott.ac.uk/pszgmh/handley-thesis.pdf
- 对本项目：确定性引擎让「随机生成输入」变成「多 seed + 每 seed 断言不变式」——不需要引入框架，for 循环即可（引擎快，百万 seed 也不贵）。现有测试已在用多 seed 扫（tackle 语义），把这一模式推广到所有不变式即可。

### 统计分布断言（测试随机/RNG 驱动代码）
- **Apache Commons RNG**：用 chi-square 断言采样器分布符合预期。`MarsagliaTsangWangDiscreteSamplerTest` 生成 10,000 样本，`chiSquareTest(probabilities, samples, 0.001)` 断言不拒绝 H0（样本分布与目标概率不可区分）。
  - https://commons.apache.org/proper/commons-rng/commons-rng-sampling/xref-test/org/apache/commons/rng/sampling/MarsagliaTsangWangDiscreteSamplerTest.html
- **dipy test_rng.py**：10,000 样本 + scipy.stats.chisquare，断言 p≈1（均匀）。
  - https://browse.dgit.debian.org/dipy.git/tree/dipy/core/tests/test_rng.py
- 警告：均匀直方图 ≠ 随机（`prng(x) = (x+1)%6` 也均匀）；分布测试需补独立性测试（runs test）、固定 seed 确定性测试。→ 本项目不是测 RNG 质量，而是测「引擎按声明概率掷骰」的实现正确性，chi-square/二项 CI 正合适。
- SoftwareEngineering.SE：单元测试不是测随机性的理想工具；固定 seed + 统计套件（Diehard/ENT/KS）+ 均值/标准差范围断言是常见组合。https://softwareengineering.stackexchange.com/

### 自动化 playtesting / ABM 作为测试
- 学术/业界用 AI 代理（RL、ABM、search-based）代替人类 playtester，生成大量对局数据做平衡分析（胜率目标 50%、fairness、skill expression）。RL 代理的问题：收敛到重复、非人类的次优行为，需要约束/引导。
  - UBCL（RL 可控多样行为）：https://ar5iv.labs.arxiv.org/html/2512.10835
  - RuleSmith（LLM 多代理 + Bayesian 优化调平衡）：https://arxiv.org/pdf/2602.06232
  - "Playtesting Without Humans: ABM as a Testing Tool for Game Spaces"：https://dl7-productive.gi.de/items/f6dc7146-b791-4495-a448-1ec8031177e8/full
  - 通用流程：设计目标 → 代理模拟 → 遥测统计作 filter → 人工抽查验证。https://jisem-journal.com/index.php/journal/article/view/13664
- 对本项目：当前引擎没有策略/属性空间，RL/LLM playtesting 属于杀鸡用牛刀；「代理模拟 + 统计 + 人工抽查」的流程骨架可用，但代理换成多 seed 引擎即可。

## 对本项目的可迁移性
- 高：golden master（canary seeds 的事件流哈希/统计摘要）、property-based（多 seed 不变式）、统计分布断言（引擎声明概率）。
- 中：common random numbers（同 seed 前后对比，隔离参数调优效应）——单人调参时最省钱。
- 低：RL/LLM playtesting（无属性/战术空间，过度设计）。
