# 任务

- [x] 跨窗体检判定 `gh > ga` 是地雷（7×200 场不重叠块；`p-landmine-check`）
- [x] 定位根因：进球是复合量，客队射门多 12.6% 稀释把握优势
- [x] 实测冻结窗（401..1000）转化率：主 0.13122 vs 客 0.11642，差 +1.48pp、z = 2.68
- [x] `aggregate` 增按队射门计数 `n_shot_home/away`（含头球口径）
- [x] 断言由 `gh > ga` 改为 `home_conv > away_conv`；保留绝对量带 / 客队下界 / 样本量守卫
- [x] `println!` 增打转化率与差
- [x] 订正 `far == 0`（抢断 ε）的过期注释依据（**只改注释**）
- [x] 规格 delta（MODIFIED 主场优势 requirement，全量复制四条 scenario）
- [ ] `openspec validate` 通过
- [ ] L1 全套（`--ignored`）绿 + 默认 `cargo test` 绿
- [ ] 独立审阅（paseo agent，含反证：把断言改回进球方向必须红 / 把转化率方向写反必须红）
- [ ] `.scratch/notes/p-landmine-check-2026-10-15/REPORT.md` 随本 change 落盘
- [ ] PR + CI 绿
