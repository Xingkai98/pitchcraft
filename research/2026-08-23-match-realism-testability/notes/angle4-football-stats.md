# Angle 4 — 真实足球数据参考区间（真实性目标）

## 结论摘要
顶级联赛（EPL 为主）的可公开引用的场均指标。注意：各赛季/各联赛有波动，报告引用时标注赛季；「对单人从零项目」用区间而非精确值，容忍带设宽。

## 参考区间（EPL，除非注明）

| 指标 | 值 | 来源 |
|---|---|---|
| 场均总进球 | **2.75**（主 1.53 / 客 1.22） | Kopacak（近期完整赛季）；StatMuse 2025-26 |
| 场均 xG | **2.88**（主 1.57 / 客 1.31） | 同上；每队典型 1.2-1.5 |
| 场均射门（双方） | **24.97**（主 13.82 / 客 11.15）；2023-24 为 27.6（每队 ~13.8） | Kopacak；The Athletic (NYT) |
| 场均射正（双方） | **8.37**（主 4.50 / 客 3.87）≈ 总射门 1/3 | Kopacak |
| 射门转化率 | 全部射门 ~**10%**；射正 ~**30%**；禁区外 2024-25 **4.2%**、近十年 3.5%；禁区内 2024-25 **14.7%**、近十年 15.2% | PL 官方 2024-25 分析；Opta Analyst |
| 进球来源 | **~85-88% 来自禁区内**（2024-25 禁区外进球 11.7%；StatsBomb 多赛季 ~14-15% 来自禁区外）；~42-45% 的射门来自禁区外 | PL 官方；StatsBomb |
| xG by 位置 | 6 码区 ~**0.80**；点球 ~**0.75-0.79**；禁区中央 ~0.10-0.30；禁区弧顶 ~0.05-0.10；禁区外 20-25 码 ~0.02-0.05；30+ 码 ~0.01-0.02 | Liverpool.com；Kiqiq；Tactiq；PSSA；TheBallIsSquare |
| 传球成功率 | PL 2024-25 队级 78.7%（森林，最低）- **89.9%**（曼城，最高）；榜首队 ~85-90%，下游 ~78-80%；联赛均值 ~80%+ | FotMob 2024-25/2025-26；BBC/Opta |
| 控球率 | 联赛场均主 50.78 / 客 49.22；队级范围 ~42%-64.5%（曼城 64.5%） | Kopacak；BBC/Opta；StatMuse |
| 场均抢断 | **~15-17/队/场**（WhoScored 两例 15.9、16.6） | WhoScored 2025/26 队档案 |
| 场均角球 | **~10**（双方） | Kopacak |
| 场均犯规 | ~21（双方）；黄牌 ~3.8；红牌 0.12 | Kopacak |

### 物理量（动画层真实性目标）
- 带球速度上限 5 m/s（本项目常量）vs 人类无球冲刺 ~9-10 m/s、带球跑 ~7 m/s 左右、慢速带球 4-5 m/s。
- 射门速度：本项目 22-29.8 m/s（22 + rng%80/10）。现实职业球员硬射 ~30 m/s（约 108 km/h），普通射门 20-28 m/s 合理区间。
- 传球：本项目 pass 速度常量（引擎 normal_pass_highlight / pass_h）。现实短传 15-25 m/s、长传可达 30 m/s。可对比。
- 全场跑动距离：职业 ~10-12 km/人/场。

## 来源 URL
- Kopacak（联赛统计聚合）：https://kopacak.com/soutez/statistiky-souteze?id=287&soutez=premier-league
- StatMuse（2025-26）：https://www.statmuse.com/fc/ask?q=premier+league+teams+average+corners%2C+average+goals...
- The Athletic "Why winning the Premier League shots battle..."（2023-24 场均 27.6 射门）：https://www.nytimes.com/athletic/5728926/2024/08/30/more-shots-more-victories-premier-league/
- Euro Football Rumours（2023-24 各队射门）：https://eurofootballrumours.com/premier-league-teams-ranked-by-most-shots-season-2023-24-29-05-2024-37167/
- PL 官方 "Why are players shooting less from long range?"（转化率/禁区外进球占比）：https://www.premierleague.com/en/news/4272809
- Opta Analyst "Finding Their Range: Where Premier League Teams Are Shooting From in 2024-25"：https://theanalyst.com/articles/premier-league-2024-25-shot-data
- StatsBomb "Premier League Shot Benchmarks"：https://blogarchive.statsbomb.com/articles/soccer/premier-league-shot-benchmarks/
- FotMob 2024/25 accurate passes（队级传球成功率）：https://www.fotmob.com/leagues/47/stats/season/23685/teams/accurate_pass_team/team
- BBC "Premier League 2024 stats breakdown"（曼城 90.6% 传球、64.5% 控球）：https://www.bbc.com/sport/football/articles/c4g3yp9j80go
- WhoScored（抢断/传球/控球队档案）：https://www.whoscored.com/
- xG 位置值：https://www.liverpool.com/liverpool-fc-news/features/liverpool-jurgen-klopp-goals-shots-17696491 ；https://kiqiq.com/blog/football-shot-maps ；https://www.tactiq.club/en/blog/xg-calculator-shot-types-deep-dive/ ；https://thepssa.us/blog/understanding-expected-goals-xg-in-soccer ；https://theballissquare.co.uk/what-is-expected-goals-xg-in-football-n54433 ；https://www.baltimoresun.com/2020/08/23/how-to-bet-on-soccer-using-expected-goals-to-find-value/

## 对本项目的可迁移性
- 可迁移：场均进球/射门/射正/角球/控球区间做引擎聚合统计的参考带。
- 可迁移：xG 位置分布 → 引擎 shot 事件目标坐标分布的目标（射门落点应集中在禁区、进球应集中在门内）。引擎已把 goal/saved 瞄准球门、off_target 偏离球门——可以断言「进球落点在球门矩形内」。
- 注意：当前引擎是「槽位集锦」模型（~24 高亮/场），场均射门天然远低于真实（~7 射门/场）；全场比赛统计现实主义是 P3 之后的目标，不是当前缺陷。报告要明确区分「集锦分布」与「全场比赛分布」两个目标档位。
