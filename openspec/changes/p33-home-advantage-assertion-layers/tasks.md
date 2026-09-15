# Tasks: 主场优势断言三层重构（#63）

## P1. 短窗口 sanity 改造

- [ ] P1.1 `l1_home_away_goal_asymmetry`：`gh > ga*1.08` → `gh > ga`
- [ ] P1.2 注释改为「短窗口方向 sanity，非 ratio 校准」；保留 gh≥60/ga≥40/体积带/客队下限

## P2. 长期校准 report 测试

- [ ] P2.1 新增 `l3_home_away_goal_calibration`（#[test] #[ignore] report-only），复用 ha_stats()
- [ ] P2.2 输出 H/A 点估计 + log(H/A) + SE + 95% CI（log-scale 正态近似），仅 println 无 ratio 断言

## P3. 主 spec 同步 + 收尾

- [ ] P3.1 match-engine「主场优势（主客进球不对称，L1）」requirement 同步三层语义
- [ ] P3.2 `cargo test --test realism --release -- --ignored` 真跑 + `npx openspec validate --all --strict` 全绿
- [ ] P3.3 独立零记忆 subagent 审阅闭环（发现问题→修复→再审至无遗留）

## 关联

- 修复 issue #63；golden 不变、引擎事件流不变
