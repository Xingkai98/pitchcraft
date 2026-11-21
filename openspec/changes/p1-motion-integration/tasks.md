# Tasks: 引擎统一运动执行层（C1 运动学，#170）

> **设计批准前不写实现**（#170 硬要求）。批准 = 用户在 #170 评论「design 批准」或 PR approve；
> 批准链接写回 `design.md` 顶部。

## 1. 提案与设计（当前阶段）

- [x] 1.1 `proposal.md` / `design.md` / `specs/{match-engine,event-stream-protocol,pitch-viewer}/spec.md` / `tasks.md`
- [x] 1.2 `openspec validate p1-motion-integration --strict` → valid
- [ ] 1.3 gpt-6.1-sol 零上下文审阅：High 收敛到 0（Round 1 H1–H6 见 `design.md` D2.3/D5.1/D6/D8/D5.4/D9；Round 2 的 R2-H1/H2/H5/H6/N1 见 D2.2/D2.3/D5.1/D5.4/D4.4/D9）
- [ ] 1.4 用户在 #170 / PR 批准 design；批准链接写回 `design.md`
- [x] 1.5 拍板 design D11 的 6 个决策（2026-11-21，全部按推荐；见 `design.md` D11）
- [x] 1.6 正式 spec delta 在**设计批准前**补全（H4）：`event-stream-protocol` 2 MODIFIED + 4 ADDED、`match-engine` 4 MODIFIED + 6 ADDED、`pitch-viewer` 2 MODIFIED + 3 ADDED；全部 MODIFIED 复制主 spec 全部 scenario
- [x] 1.7 归档合并自检：scenario 集合包含检查（D8.1）；`validate --strict` 只作门槛，不作语义批准
- [x] 1.8 M/L 修复：M1 成本预算（D7.5）、M2 运动学数值（D4.2）、M3 单步算法（D4.4）、M4 快照（D2.4）、M5 数据依赖（D7.4）、M6 fill 域（D5.3）、L1 措辞、L2 golden/研究门（D7.3）
- [x] 1.9 Round 2 修复：权威调度与 Trace C（R2-H1）、零位移状态首锚点（R2-H2）、参与者进入 movers + 真实 T/精确到达/finalize 连续（R2-H5）、turnsPerPlayer/等效性盲测/7 真实簇（R2-H6）、总向量预算 A_MAX + 米制边界（R2-N1）、M1 旧流选择、M2 体积上界、M3 save 否决分母、L1/L2 转述

## 2. Phase 0：前置（design 批准后先做）

- [ ] 2.1 角球带处置：按 D11 #4 **重锚到真实 ~10.27**，保留单场 max 护栏（不得删红门、不得降级为报告项）；证据落盘 `notes/`
- [ ] 2.2 p53/p31/p6/p32 改为「显式构造场景 + 条件断言 + 多 seed 置信范围」夹具；保留契约
- [ ] 2.3 **权威 L1 基线**（H6）：在 main 同配置跑 200 场，落盘 `notes/l1-baseline-main.json`（`source_commit` + `engineFingerprint` + seed 列表 + 每条带读数 + 红清单）；历史「4 红」只作对照，不作权威
- [ ] 2.4 预注册指标：条件 `turn120` **按 `turnsPerPlayer`（次数/球员/窗，0.829/0.0104 口径）**，另报 `turnsPerEffectivePair` 占比（0.0000934 口径，不混用）；`staticFrac`、速度分位、加速度尾部、路径效率/回环率、低速转向、残余漂移、ballStatic（viewer 链 caveat）
- [ ] 2.5 保存改动前 ratchet：`node tools/ratchet.mjs save .../notes/ratchet-before.json`
- [ ] 2.6 重扫 `realism.rs:453` 的 `ok_step` 假绿分支，改成从 `BEAT_DT` / `DECISION_DT` 字面量推导
- [ ] 2.7 **基线数据前置**（M5）：确认 Metrica 2 场 + SkillCorner 20 场的授权位置/文件身份/离线可用；缺数据则停在 Phase 0（D7.4）
- [ ] 2.8 **测试成本实测**（M1）：用 v11 同配置测 debug/release、p124、L1、spacing-sweep、5min/90min viewer（加载/seek/帧耗时、JSON 字节、峰值内存），替换 D7.5 的「估算」列

## 3. 运动执行层

- [ ] 3.1 新建 `engine/src/motion.rs`：`MotionState { pos_m, vel_mps, heading, mode }`
- [ ] 3.2 实现 `dv/dt = A0(1−v/S0)`、`|ω| ≤ a_lat/max(v,1)`、制动曲线/到达半径；参数按 D4.2 标注「文献值/工程初值/待标定」
- [ ] 3.3 删除「dead-zone 整拍冻结」；保留到达半径；速度/位置内部米制
- [ ] 3.4 确定性单步算法按 D4.4：期望速度 → 反向/制动（不转向）→ 朝向 → 速度 → 位置（半隐式）→ 三层分离 → **总向量预算**；子步零 RNG
- [ ] 3.5 三层分离（目标/预测/投影）；所有修正计入 `|Δv_total| ≤ A_MAX·SIM_DT`；不可行置 `constraint_infeasible`（不静默推端点）
- [ ] 3.6 权威调度按 D2.2：上段终态 → finalize/事件 → decision → snapshot → 积分/缓存 → 发下一段 beat；段边界/`beat.dt` 按 D2.3
- [ ] 3.7 统一 carrier / 无球 / 高亮参与者 / 门将 / 重开走位 / 同队分离；**参与者进入 movers（action=highlight）**，事件锚点 = 连续积分（含分离）到 t_end 的位置（D5.4）
- [ ] 3.8 所有 `*_TICKS` 重新挂到 decision 拍；核 17 个换域常量（#170 清单 + v11 现状）
- [ ] 3.9 `p16` / `p124` 观测快照按 D2.4：边界状态（事件/decision 后），同 t 对 `beat.from`，不是窗口末态
- [ ] 3.10 新状态首段强制发 `main`/`ball`（状态键：球权/carrier id/controlled↔loose/mode/重开/save-caught），零位移也发（D5.1）
- [ ] 3.11 `reachable()` 用真实 T（整步 + 部分步，不用 ceil）；参与者用 `PRECISION_ARRIVE_RADIUS_M`；finalize 取连续积分结果（D5.4）
- [ ] 3.12 save 几何否决只在固定球路内：不改 off-target；三分母（全部 shot / 原 save / 尝试修复的 save）+ 逐 seed + ≤2% 原 save + L1 非恶化门（D5.4/D9.1）

## 4. 协议与 spec delta（实现）

- [x] 4.1 `event-stream-protocol`：beat 段合同、`dt`、稀疏 main/ball、新状态首段、重开准备期（设计阶段已写 delta）
- [x] 4.2 `match-engine`：L2 段边界/速度带、mover 位移、dead-zone、tackle/save 高亮、单步算法、总预算、可达性（设计阶段已写 delta）
- [x] 4.3 `pitch-viewer`：`beatSeconds`/`legacyBeatSeconds`/`tackleSeconds`/`highlightSeconds`、参与者用 mover、只插值同一轨迹、T1/Catmull 默认关（设计阶段已写 delta）
- [x] 4.4 MODIFIED requirements 复制主 spec 的全部 scenario（D8 清单已核对）
- [ ] 4.5 `MODEL_VERSION 11→12`；新建 `engine/tests/golden-v12/`；`golden_dir()` 加 `12 => "tests/golden-v12"`；`ACCEPT_GOLDEN=1` 重基线（已提交的树、干净工作树）
- [ ] 4.6 协议字段：第一阶段只发端点；`beat.dt` 为段长时序字段；若加 `vx/vy/heading`，bump 协议版本并补测试
- [ ] 4.7 填拍域 `FILL_FLIGHT_S=0.95×BEAT_DT`；速度带守卫（dist/FILL 不在 [10,25) 则不填）；finalize = 第一个 ≥ t_end 的 0.1s 网格步
- [ ] 4.8 终场末段 `dt = dur − t_last`（0<dt≤0.2）；死球 gap 约束相邻已发 beat；链式 finalize 去重终态事件
- [ ] 4.9 旧流：`buildTimeline` 按第一条 beat 是否有 `dt` 做流级选择（旧流 0.5 / 新流逐条 dt / 混用报错）

## 5. Viewer

- [ ] 5.1 `viewer/config.js`：`tickSeconds` → `beatSeconds=0.2` / `legacyBeatSeconds=0.5` / `tackleSeconds=0.5` / `highlightSeconds=0.5`（删除旧键）
- [ ] 5.2 `interpretation.js:186/192/219/304/350` 逐点按 D6.1 归属切换；`game.js` 的 Catmull/T1 默认关
- [ ] 5.3 稀疏 main/ball：`buildTimeline` 不补锚点、插值保持；`currentCarrier()` 向后扫描 + 失效事件停止（D6.2）
- [ ] 5.4 seek 重建：球用高亮锚点/`main`/`ball`，参与者用 mover；事件终点续接；**旧流无 `dt` 用 `legacyBeatSeconds=0.5`（不是 beatSeconds）**
- [ ] 5.5 缓存版本号 bump（`index.html` + app.js import specifier）
- [ ] 5.6 tackle 0.5s 跨 3 段的 viewer 断言（D6.1 时间线）
- [ ] 5.7 **参与者用 mover 端点**渲染（不合成事件直线）；事件锚点只作 `t_end` 对账；删除 `highlight_frozen_segs` 的显示线用途
- [ ] 5.8 内部间距 vs 显示间距两路断言：`st.pos` == mover 端点；viewer 插值后 `player_overlap` findings = 0
- [ ] 5.9 新状态首锚点的 seek 属性测试（save-caught 零速持球 / 原地拾取 / 新 loose 球静止）

## 6. 验证

- [ ] 6.1 `cargo test` 默认套件：迁移/重钉受影响的 golden、L2、p53/p31/p6/p32、p16/p124/p17b
- [ ] 6.2 `realism --ignored` L1 200 场：与 Phase 0 的权威基线逐条对照；**已有真实机制红**过预注册非恶化门；**新增破带失败**；角球带按 2.1 重锚；不得放宽真实带；不强迫修所有旧红
- [ ] 6.3 `ratchet diff`：无退化（有退化 exit 1；缺数据 exit 2）
- [ ] 6.4 `spacing-sweep`：player_overlap findings = 0；确定性/无 snap
- [ ] 6.5 `benchmark-baseline.json` 重生成；`engineFingerprint` 覆盖 `lib.rs` + `motion.rs` + wasm；哨兵绿
- [ ] 6.6 条件指标：`motion-census` frozen 24 窗（公开回归集），`turn120` **按 turnsPerPlayer**、另报 `turnsPerEffectivePair`；`staticFrac`、速度谱、加速度尾部、路径效率/回环、低速转向、残余漂移
- [ ] 6.7 视觉：trajectory + contact-sheet（开放/转换/长传/禁区/松散球/死球）
- [ ] 6.8 用户尺度：`viewer-match` seed42/5min + 90min 聚合
- [ ] 6.9 验收决策表（D9.1）：调参 seed 1–160 / 留出 321–440；真实 Metrica 1/1、SkillCorner 14/6；cluster bootstrap；最小有意义改善与不退化边界逐条
- [ ] 6.10 盲测：预注册等价边 **δ=0.15**；通过 = 95% CI **完全落入 [0.35,0.65]**；CI 完全在 0.5 任一侧且超界（含完全低于 0.5）= 失败；其他 = 无结论；**真实独立源只有 7 簇**，按 source match × seed/window 多向聚类，不承诺 72 独立真实源
- [ ] 6.11 独立审阅闭环：High 收敛到 0
- [ ] 6.12 save 否决统计：三分母（全部 shot / 原 save / 尝试修复的 save）+ 逐 seed + ≤2% 原 save + L1 射门结果非恶化
- [ ] 6.13 总向量预算：子步 `|Δv_total| ≤ A_MAX·SIM_DT` 的数值例与属性测试；米制边界 `[0,105]×[0,68]`

## 7. 收尾

- [ ] 7.1 更新 #170 与本 change 的 design 批准记录
- [ ] 7.2 更新 #175 地图的 C1 状态
- [ ] 7.3 归档（滞后独立步骤，不在实现 PR 里顺手做）
