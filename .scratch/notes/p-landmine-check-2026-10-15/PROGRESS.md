# 进度：判据体检（p-landmine-check，2026-10-15）

基座：pristine main `784cdd9`。目标：对 `engine/tests/realism.rs` 三条薄余量断言做「地雷 / 弱守卫 / 真守卫」判定。

- [1] 读 `realism.rs`：`aggregate(seed)` 口径、`MatchStats` 字段、三条断言位置（far45:696 / far:808 / gh>ga:977 附近）。
- [2] 读 `engine/src/lib.rs`：45m **无硬上限**（`distance_quality` 在 35m 后斜率放缓，无钳制）；
      `score_tackle` 资格 `dist_m > 12.0 → NEG_INFINITY`；tackle 事件 `x/y`=防守者、`x2/y2`=被铲者**活位置**（lib.rs:4539）；
      主场通道①`clinical_goal_window`（lib.rs:6814）+ 机制层守卫 `home_advantage_channel_semantics`（lib.rs:7644）。
- [3] 探针 v1（`zz_landmine_probe` 追加在 realism.rs 末尾，`#[ignore]`，只 println）：7×200 场，
      401-600/601-800/801-1000/1001-1200/1201-1400/1401-1600/1601-1800。
- [4] 发现 v1 的 POOLED 行标签 bug（拿 7 块合计当 600 场分子）→ v2 修正，并补：射门尾部桶、tackle 裸 12.0 计数、
      主客各侧射门数与转化率、1400 场合并统计。重跑（每块 ~50s）。
- [5] v2 读数到手。关键：`far45`=0 / `far`=0 / `far_raw`=0 全 7 块；最大射门距离 36.61m（33,368 脚）、
      最大抢断距离 1.885m（58,964 次）；冻结 600 窗 gh=891 ga=875（H/A=1.0183，CI [0.928,1.118]）；
      1400 场 gh=1987 ga=2015（H/A=0.9861）。→ 门 1/2 真守卫；门 3 地雷。
- [6] `git checkout engine/tests/realism.rs` 还原（工作区干净）。
- [7] 跑官方 `--ignored` 测试交叉核对：`l1_home_away_goal_asymmetry`（打印 主1.485/客1.458/H-A=1.018）、
      `l3_home_away_goal_calibration`（打印 891/875、CI=[0.928,1.118]）、`l1_tackle_dilution`、`l1_shot_result`
      —— **4/4 ok，且打印值与探针逐位一致**。
- [8] 探针 v3 `zz_ha_bucket_probe`（第一次数组维度写反 → 修 `[[[i64;2];4];2]` 后重跑）：门 3 机制拆解，
      主/客 × 箱/弧/远/头球。结果：通道① 逐桶均不排斥名义 +2pp；聚合差 +1.26pp 的缺口由**主队射门位置构成更差**
      （禁区内占比 47.8% vs 50.2%）解释，残差 −0.40pp。
- [9] 再次 `git checkout engine/tests/realism.rs` 还原（`git diff HEAD -- engine/` 为空）+ 写 `REPORT.md`。
