# Tasks: 引擎统一运动执行层（C1 运动学，#170）

> **设计批准前不写实现**（#170 硬要求）。批准 = 用户在 #170 评论「design 批准」或 PR approve；
> 批准链接写回 `design.md` 顶部。

## 1. 提案与设计（当前阶段）

- [x] 1.1 `proposal.md` / `design.md` / `specs/{match-engine,event-stream-protocol,pitch-viewer}/spec.md` / `tasks.md`
- [x] 1.2 `openspec validate p1-motion-integration --strict` → valid
- [ ] 1.3 gpt-6.1-sol 零上下文审阅：High 收敛到 0（本轮 H1–H6 的设计答案见 `design.md` D2.3/D5.1/D6/D8/D5.4/D9）
- [ ] 1.4 用户在 #170 / PR 批准 design；批准链接写回 `design.md`
- [x] 1.5 拍板 design D11 的 6 个决策（2026-11-21，全部按推荐；见 `design.md` D11）
- [x] 1.6 正式 spec delta 在**设计批准前**补全（H4）：`event-stream-protocol` 2 MODIFIED + 3 ADDED、`match-engine` 4 MODIFIED + 5 ADDED、`pitch-viewer` 2 MODIFIED + 1 ADDED；全部 MODIFIED 复制主 spec 全部 scenario
- [x] 1.7 归档合并自检：scenario 集合包含检查（D8.1）；`validate --strict` 只作门槛，不作语义批准
- [x] 1.8 M/L 修复：M1 成本预算（D7.5）、M2 运动学数值（D4.2）、M3 单步算法（D4.4）、M4 快照（D2.4）、M5 数据依赖（D7.4）、M6 fill 域（D5.3）、L1 措辞、L2 golden/研究门（D7.3）

## 2. Phase 0：前置（design 批准后先做）

- [ ] 2.1 角球带处置：按 D11 #4 **重锚到真实 ~10.27**，保留单场 max 护栏（不得删红门、不得降级为报告项）；证据落盘 `notes/`
- [ ] 2.2 p53/p31/p6/p32 改为「显式构造场景 + 条件断言 + 多 seed 置信范围」夹具；保留契约
- [ ] 2.3 **权威 L1 基线**（H6）：在 main 同配置跑 200 场，落盘 `notes/l1-baseline-main.json`（`source_commit` + `engineFingerprint` + seed 列表 + 每条带读数 + 红清单）；历史「4 红」只作对照，不作权威
- [ ] 2.4 预注册指标：条件 `turn120`、`staticFrac`、速度分位、加速度尾部、路径效率/回环率、低速转向、残余漂移、ballStatic（viewer 链 caveat）
- [ ] 2.5 保存改动前 ratchet：`node tools/ratchet.mjs save .../notes/ratchet-before.json`
- [ ] 2.6 重扫 `realism.rs:453` 的 `ok_step` 假绿分支，改成从 `BEAT_DT` / `DECISION_DT` 字面量推导
- [ ] 2.7 **基线数据前置**（M5）：确认 Metrica 2 场 + SkillCorner 20 场的授权位置/文件身份/离线可用；缺数据则停在 Phase 0（D7.4）
- [ ] 2.8 **测试成本实测**（M1）：用 v11 同配置测 debug/release、p124、L1、spacing-sweep、5min/90min viewer（加载/seek/帧耗时、JSON 字节、峰值内存），替换 D7.5 的「估算」列

## 3. 运动执行层

- [ ] 3.1 新建 `engine/src/motion.rs`：`MotionState { pos_m, vel_mps, heading, mode }`
- [ ] 3.2 实现 `dv/dt = A0(1−v/S0)`、`|ω| ≤ a_lat/max(v,1)`、制动曲线/到达半径；参数按 D4.2 标注「文献值/工程初值/待标定」
- [ ] 3.3 删除「dead-zone 整拍冻结」；保留到达半径；速度/位置内部米制
- [ ] 3.4 确定性单步算法按 D4.4：到达 → 期望速度 → 反向制动 → 半隐式速度/朝向/位置 → 三层分离；子步零 RNG
- [ ] 3.5 三层分离（目标/预测/投影）；`|Δv| ≤ a_max·SIM_DT`；不可行置 `constraint_infeasible`（不静默推端点）
- [ ] 3.6 三层 cadence：`SIM_DT=0.1` / `DECISION_DT=0.5` / `BEAT_DT=0.2`；段边界与 `beat.dt` 按 D2.3
- [ ] 3.7 统一 carrier / 无球 / 高亮参与者 / 门将 / 重开走位 / 同队分离；高亮参与者按 D5.4 的可达性表
- [ ] 3.8 所有 `*_TICKS` 重新挂到 decision 拍；核 17 个换域常量（#170 清单 + v11 现状）
- [ ] 3.9 `p16` / `p124` 观测快照按 D2.4（tick=decision，A 案定死）

## 4. 协议与 spec delta（实现）

- [x] 4.1 `event-stream-protocol`：beat 段合同、`dt`、稀疏 main/ball、重开准备期（设计阶段已写 delta）
- [x] 4.2 `match-engine`：L2 段边界/速度带、mover 位移、dead-zone、tackle/save 高亮、单步算法、可达性（设计阶段已写 delta）
- [x] 4.3 `pitch-viewer`：`beatSeconds`/`tackleSeconds`/`highlightSeconds`、只插值同一轨迹、T1/Catmull 默认关（设计阶段已写 delta）
- [x] 4.4 MODIFIED requirements 复制主 spec 的全部 scenario（D8 清单已核对）
- [ ] 4.5 `MODEL_VERSION 11→12`；新建 `engine/tests/golden-v12/`；`golden_dir()` 加 `12 => "tests/golden-v12"`；`ACCEPT_GOLDEN=1` 重基线（已提交的树、干净工作树）
- [ ] 4.6 协议字段：第一阶段只发端点；`beat.dt` 为段长时序字段；若加 `vx/vy/heading`，bump 协议版本并补测试
- [ ] 4.7 填拍域 `FILL_FLIGHT_S=0.95×BEAT_DT`；速度带守卫（dist/FILL 不在 [10,25) 则不填）；finalize = 第一个 ≥ t_end 的段边界

## 5. Viewer

- [ ] 5.1 `viewer/config.js`：`tickSeconds` → `beatSeconds=0.2` / `tackleSeconds=0.5` / `highlightSeconds=0.5`（删除旧键）
- [ ] 5.2 `interpretation.js:186/192/219/304/350` 逐点按 D6.1 归属切换；`game.js` 的 Catmull/T1 默认关
- [ ] 5.3 稀疏 main/ball：`buildTimeline` 不补锚点、插值保持；`currentCarrier()` 向后扫描 + 失效事件停止（D6.2）
- [ ] 5.4 seek 重建：高亮锚点优先、事件终点续接；老流无 `dt` 回退 `beatSeconds`
- [ ] 5.5 缓存版本号 bump（`index.html` + app.js import specifier）
- [ ] 5.6 tackle 0.5s 跨 3 段的 viewer 断言（D6.1 时间线）

## 6. 验证

- [ ] 6.1 `cargo test` 默认套件：迁移/重钉受影响的 golden、L2、p53/p31/p6/p32、p16/p124/p17b
- [ ] 6.2 `realism --ignored` L1 200 场：与 Phase 0 的权威基线逐条对照；角球带按 2.1 重锚；新增偏离按真实锚联合重标定；护栏检查退化
- [ ] 6.3 `ratchet diff`：无退化（有退化 exit 1；缺数据 exit 2）
- [ ] 6.4 `spacing-sweep`：player_overlap findings = 0；确定性/无 snap
- [ ] 6.5 `benchmark-baseline.json` 重生成；`engineFingerprint` 覆盖 `lib.rs` + `motion.rs` + wasm；哨兵绿
- [ ] 6.6 条件指标：`motion-census` frozen 24 窗（公开回归集），旧/条件 `turn120`、`staticFrac`、速度谱、加速度尾部、路径效率/回环、低速转向、残余漂移
- [ ] 6.7 视觉：trajectory + contact-sheet（开放/转换/长传/禁区/松散球/死球）
- [ ] 6.8 用户尺度：`viewer-match` seed42/5min + 90min 聚合
- [ ] 6.9 验收决策表（D9.1）：调参 seed 1–160 / 留出 321–440；真实 Metrica 1/1、SkillCorner 14/6；cluster bootstrap；最小有意义改善与不退化边界逐条
- [ ] 6.10 盲测：48–72 clip × ≥5 裁判、按源比赛/seed 计有效样本、预注册、含负控；按 D9.1 的「不可区分」判据（CI，不按点估计）
- [ ] 6.11 独立审阅闭环：High 收敛到 0

## 7. 收尾

- [ ] 7.1 更新 #170 与本 change 的 design 批准记录
- [ ] 7.2 更新 #175 地图的 C1 状态
- [ ] 7.3 归档（滞后独立步骤，不在实现 PR 里顺手做）
