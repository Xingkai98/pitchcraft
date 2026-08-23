# Angle 1 — FM/SI 怎么校准比赛真实性

## 结论摘要
SI 用 **data benchmarking**（把引擎产出的比赛统计对真实联赛数据做 min/max/mean/std 对比）来保证真实性。社区 mod 团队（FMTweak、FM Match Lab、TrueSim）是「单人/小团队做统计+视觉双轨校准」的最接近模板。

## 来源与要点

### SI 官方（一级来源）
- **Analytics FC Podcast / Elliott Stapley（SI 比赛引擎软件工程师）**：访谈主题明确包含 "how Sports Interactive use data benchmarking to guarantee the realism of Football Manager"。搜索摘要补充：SI 员工做全量统计分解（min/max/mean/standard deviations），对比真实世界数据（如 Prem 各队场均射门 ~5-15 因队而异），按风格/级别/国家区分。
  - https://podcasts.apple.com/us/podcast/episode-45-elliott-stapley-sports-interactive-and/id991610009?i=1000558151151
  - 注：前一份报告（2026-08-04）已引用同一访谈 + ESPN Alan Granger。新报告 based_on 它。
- SI 引擎机制：每秒 7-8 次决策（每 1/6 秒模拟每个球员想做什么 + 球物理），无剧本、结果涌现；flocking 移动 + emitting 通信。→ 与 FM 校准无关但解释为何统计分布是引擎涌现结果。
  - SI 论坛回帖：https://community.sports-interactive.com/forums/topic/596466-when-will-the-match-engine-be-made-more-realistic/

### 社区 mod 团队（「小团队校准」模板）
- **FM Tweak / FM Match Lab**：自述校准 = 双重测试（double pivot of testing）：
  1. 统计测试：模拟多个联赛至少到 2050 年，逐赛季数字对比真实数据，防止结果 "wildly off-piste"；
  2. 视觉测试：几百场 comprehensive highlights / full match 逐场看有没有 "weird" 行为。
  - https://fmtweak.com/how-to-change-a-match-engine-fmtweak-dev-blog/（WebFetch 被网络策略拦截，仅用搜索结果摘要）
  - https://fmmatchlab.co.uk/about/（同上拦截）
- **TrueSim（FM24 match engine mod）**：给出了具体校准数字——场均射门每队 ~10.5-17.2（均 ~13.5-13.8）、射门转化率 9%-15.6%、每队场均犯规 11-13、黄牌每队 2.1-2.4、角球/任意球进球率等，逐项对照真实值微调。
  - https://www.fmscout.com/a-truesim-fm24-match-engine-mod.html

### FM xG 集成
- FM21 起与 SciSports 合作，把专用 xG 模型内建进比赛引擎（首个这么做的主机游戏），按距离/角度/防守者距离/球高评估机会质量。
  - https://www.scisports.com/scisports-continues-innovative-partnership-with-sports-interactive-in-fm22/
  - FM22 加 Data Hub（Momentum、Possession Gained、Pass Network）→ 数据驱动的真实性可视化。https://shapes.inc/fandom/football-manager-2021/deep-dive

### 争议
- 社区质疑属性平衡（有用户称"只有 Pace/Acceleration 起作用"）；SI 员工回应"所有游戏都可被极端阵容 exploit"。→ 校准不是一劳永逸，需持续。
- SI 员工澄清 FM24 引擎 mod 只改数据文件（physical constraints 文件：最大速度/加速度/减速度），AI 逻辑/引擎代码不可改；FM26 重构到 Unity 后连该文件也没了。

## 对本项目的可迁移性
- 可迁移：TrueSim 式的「把引擎常数输出统计与真实区间对照」——本项目引擎里已有硬编码概率（shot 15/35/50、tackle 50/50、槽位 30/12/18/22/18）和目标标定注释（"tackle 目标 8-15 次/场"）。
- 可迁移：FM Match Lab 的统计+视觉双轨（自动统计闸门 + 人工抽查）。
- 不成立：SI 的完整 data benchmarking 需要数据团队 + 数据授权；单人从零项目用公开联赛均值 + 自己定的目标区间即可。
