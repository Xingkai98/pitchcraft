# Tasks: 引擎统一运动执行层（C1 运动学，#170）

> **设计批准前不写实现**（#170 硬要求）。批准 = 用户在 #170 评论「design 批准」或 PR approve；
> 批准链接写回 `design.md` 顶部。

## 1. 提案与设计（当前阶段）

- [x] 1.1 `proposal.md` / `design.md` / `specs/{match-engine,event-stream-protocol,pitch-viewer}/spec.md` / `tasks.md`
- [x] 1.2 `openspec validate p1-motion-integration --strict` → valid
- [x] 1.3 gpt-6.1-sol 零上下文审阅：**Round 10 = 0 High，可批准**（Round 1–9 + post-grill 见 `notes/review-gpt61-2026-11-21.md`；早期 Round 1–6 见 `design.md` D2.2/D2.3/D5.1/D5.4/D6/D8/D9）
- [x] 1.4 用户 **2026-11-23 正式批准 design**（会话；记录写回 `design.md` D12；#170 记录
  https://github.com/Xingkai98/pitchcraft/issues/170#issuecomment-7097790156）
- [x] 1.5 拍板 design D11 的 6 个决策（2026-11-21，全部按推荐；见 `design.md` D11）
- [x] 1.6 正式 spec delta 在**设计批准前**补全（H4）：`event-stream-protocol` 3 MODIFIED + 8 ADDED、`match-engine` 4 MODIFIED + 16 ADDED、`pitch-viewer` 3 MODIFIED + 4 ADDED；全部 MODIFIED 复制主 spec 全部 scenario
- [x] 1.7 归档合并自检：scenario 集合包含检查（D8.1）；`validate --strict` 只作门槛，不作语义批准
- [x] 1.8 M/L 修复：M1 成本预算（D7.5）、M2 运动学数值（D4.2）、M3 单步算法（D4.4）、M4 快照（D2.4）、M5 数据依赖（D7.4）、M6 fill 域（D5.3）、L1 措辞、L2 golden/研究门（D7.3）
- [x] 1.9 Round 2 修复：权威调度与 Trace C（R2-H1）、零位移状态首锚点（R2-H2）、参与者进入 movers + 真实 T/精确到达/finalize 连续（R2-H5）、turnsPerPlayer/等效性盲测/7 真实簇（R2-H6）、总向量预算 A_MAX + 米制边界（R2-N1）、M2 体积上界、M3 save 否决分母、L1/L2 转述（**M1 旧流选择后来被 G3-Q7 改为删除旧流**）
- [ ] 1.10 Phase 0/实现时收紧非阻塞残余：Round 6 的 M1/M2/M3/L1（1.7 对账表、重试成功夹具、RNG 守卫对象、P_eff 摘要）+ Round 9 的 M1/L1（`save_t=1.43→P_save=1.5` 同刻 decision、viewer 段内采样断言）；不阻塞 design 批准

## 2. Phase 0：前置（design 批准后先做）

> **落地粒度（G3-Q6）**：Phase 0 的每块（角球重锚 / 夹具 / 基线与预注册 / `ok_step`）
> SHALL 拆成**独立 PR**，每个 PR **行为零变化**并对照 main v11 验证；改门的 PR 单独列证据。
> 便于区分「门变严/重锚」与「运动导致破带」。

- [x] 2.1 角球带处置：按 D11 #4 **重锚到真实 ~10.27**，保留单场 max 护栏（不得删红门、不得降级为报告项）；证据落盘 `notes/`
- [x] 2.2 p53/p31/p6/p32 改为「显式构造场景 + 条件断言 + 多 seed 置信范围」夹具；保留契约
- [x] 2.1b **规范同步**（Phase 0-B 审阅 P0B-H1）：`specs/match-engine/spec.md` 补两条 MODIFIED——「射门与抢断的体量带」单场角球上界 `≤26`、「涌现频率带的经验体量守卫」角球派生带 `[6.68,13.86]`；`openspec validate --strict` 通过
- [x] 2.3 **权威 L1 基线**（H6）：在 main 同配置跑 200 场，落盘 `notes/l1-baseline-main.json`（`source_commit` + `engineFingerprint` + seed 列表 + 每条带读数 + 红清单）；历史「4 红」只作对照，不作权威
- [ ] 2.4 预注册指标：条件 `turn120` **按 `conditional['0.5'].turnsPerPlayer`（Change 0 原口径：24s/121 帧，`turns/nPlayers`，不除窗长）**；另报 `turnsPerEffectivePair`（0.0000934 口径，不混用）；`staticFrac`、速度分位、加速度尾部、路径效率/回环率、低速转向、残余漂移、ballStatic（viewer 链 caveat）
- [ ] 2.5 保存改动前 ratchet：`node tools/ratchet.mjs save .../notes/ratchet-before.json`
- [x] 2.6 重扫 `realism.rs:453` 的 `ok_step` 假绿分支，改成从 `BEAT_DT` / `DECISION_DT` 字面量推导
  - 落地（2026-11-23）：v11 还没有 `BEAT_DT` 常量，用 test-local `BEAT_INTERVAL_S=0.5`（单一锚）+ 精确 1×/2× 集合；C1 拆分常量时把该值同步到 `BEAT_DT`。定向变异（恒真）已证红
- [ ] 2.7 **基线数据前置**（M5）：确认 Metrica 2 场 + SkillCorner 20 场的授权位置/文件身份/离线可用；缺数据则停在 Phase 0（D7.4）
- [ ] 2.8 **测试成本实测**（M1）：用 v11 同配置测 debug/release、p124、L1、spacing-sweep、5min/90min viewer（加载/seek/帧耗时、JSON 字节、峰值内存），替换 D7.5 的「估算」列
  - 第一刀（2026-11-23）：v11 分母已落盘 `notes/phase0-perf-smoke.md`（L1/release/realism、5min/90min viewer、JSON、RSS）；p124、spacing-sweep、C1「5×+规划」待后续
- [ ] 2.9 **盲测/旧红预注册**（R3-M3/R5-M2）：冻结 source×seed 配对矩阵、裁判/重复窗处理、多向聚类 bootstrap、证据等级 A/B/C、扩样上限 140 clip、7 真实簇下限；在候选调参前冻结每个已有红的逐指标非恶化边界（来源=base 逐 seed 分布不确定度/预注册扰动块/领域容忍，见 D9.3）；**存储合同=JSON 0–1 比例/粒度 0.001、展示 0.1pp、向恶化侧 ceiling 到 0.001**；计数类每场次数/0.1
- [ ] 2.10 **前视规划 smoke**（R4-M1）：1 seed 专测规划次数/平均与最大视野/候选拒绝与重试/缓存内存/执行复用率/计划段测试时长；超预算只优化或停止设计，不得回退「先写锚点再推位置」
- [x] 2.11 **移植 motion-census**（G1-Q4）：从 `p155-measurement-instrument/2026-11-19` 移植 `tools/visual-review/motion-census.mjs`；引擎侧过滤 `action:"highlight"`；在 v11 上复算并与 Change 0 对齐（不一致则停止说明，不静默换锚）；补口径守护测试
- [x] 2.12 **L1 带分类审计**（G3-Q9）：把每条带分为真实拟合/护栏/过时，落盘 `notes/l1-bands.md`；护栏按方向判、过时重标/退役但不删塌缩守卫；候选调参前冻结
- [ ] 2.13 **性能门**（G2-Q5）：Phase 0 1 seed release+wasm 实测「活体 5×+规划」；硬门 L1 ≤2× v11、wasm 90min simulate ≤10s；超预算只允许保真度不变的优化，不达标停在 Phase 0
  - 第一刀（2026-11-23）：v11 分母（L1 11m11s、wasm 90min simulate 0.909s、viewer 加载/seek/RSS）已落盘 `notes/phase0-perf-smoke.md`；C1 的「5×+规划」须待 C1a，Phase 0 不提前判

## 3. 运动执行层（C1a → 视觉门/Go-No-Go → C1b）

> **C1a（先做）**：运动核心 + live scheduler + 参与者确定性前视终点，**不建全状态
> `CommittedPlan` 缓存**。C1a 通过视觉门后才做 C1b（D1.3）。

### C1a（先做）

- [ ] 3.1 新建 `engine/src/motion.rs`：`MotionState { pos_m, vel_mps, heading, mode }`
- [ ] 3.2 实现 `dv/dt = A0(1−v/S0)`、`|ω| ≤ a_lat/max(v,1)`、制动曲线/到达半径；按 D4.2 v1 常量钉死 `S0=9.8`、`a_brake=6.4`、`V_EPS=1e-3`、`MAX_TURN_RATE=4.0`，补 `S0≥V_MAX` 不变量与低速大转向裁剪有界单测；`A_MAX` 预算优先、裁剪率仅报告
- [ ] 3.3 删除「dead-zone 整拍冻结」；保留到达半径；速度/位置内部米制
- [ ] 3.4 确定性单步算法按 D4.4：期望速度 → 反向/制动（不转向）→ 朝向 → 速度指令 → **运动预算** → 位置（`pos += vel·dt`）→ 三层分离 → **总向量预算**；从最终 `vel` 恢复 speed/heading；子步零 RNG
- [ ] 3.5 三层分离（目标/预测/投影）；所有修正计入 `|Δv_total| ≤ A_MAX·SIM_DT`；边界清零后重做总预算；不可行置 `constraint_infeasible`（不静默推端点）
- [ ] 3.6 权威调度按 D2.2：上段终态 → finalize/事件 → decision → snapshot → 积分/缓存 → 发下一段 beat；段边界/`beat.dt` 按 D2.3
- [ ] 3.7 统一 carrier / 无球 / 高亮参与者 / 门将 / 重开走位 / 同队分离；**参与者进入 movers（action=highlight）**，事件锚点 = 连续积分（含分离）到 t_end 的位置（D5.4）
- [ ] 3.8 所有 `*_TICKS` 重新挂到 decision 拍；核 17 个换域常量（#170 清单 + v11 现状）
- [ ] 3.9 `p16` / `p124` 观测快照按 D2.4：边界状态（事件/decision 后），同 t 对 `beat.from`，不是窗口末态
- [ ] 3.10 新状态首段强制发 `main`/`ball`（状态键：球权/carrier id/controlled↔loose/mode/重开/save-caught），零位移也发（D5.1）
- [ ] 3.11 `reachable()` 用真实 T（整步 + 部分步，不用 ceil）；参与者用 `PRECISION_ARRIVE_RADIUS_M`；finalize 取连续积分结果（D5.4）
- [ ] 3.12 save 几何否决只在固定球路内：不改 off-target；三分母（全部 shot / 原 save / 尝试修复的 save）+ 逐 seed + ≤2% 原 save + L1 非恶化门（D5.4/D9.1）
- [ ] 3.14 四态驱动状态机（R3-H2）：`controlled`/`loose`/`highlight`/`restart`；高亮开始事件=首锚点、禁 main/ball；高亮结束后首个 controlled/loose 段强制 main/ball（D5.1）
- [ ] 3.18 扑救/到达语义（G2-Q2/Q4）：saved shot 调度 `t_end=save_t`、扑救点写 `save_x/save_y`、状态在 `P_end` 提交；`x2/y2` 仅 L2 门线投影；settle/impact 判据；save 否决只对原 save、三分母/≤2% 原 save
- [ ] 3.21 分离预算（G2-Q3）：先 A——预测视野 ≥0.75s（或到最近接近时间），投影触发预注册 20 seed 0 次、触发即停；B 作预注册应急（每 0.1s ≤2.2m + `separation_push`），不得静默放宽 A0/a_lat
- [ ] 3.22 save_t/P_end（R8-H1/R9-H1）：saved shot 调度 `t_end=save_t`；save_t 精确锚点；P_end=ceil(t_end/SIM_DT)·SIM_DT；save_t→P_end 门将零速保持在 save_x/save_y、球停扑救点、不发事件/decision；P_end 提交 save-caught/transition；`x2/y2` 仅 L2 投影、不产生第二终点；save_t 不切 beat 段

### 视觉门 + Go/No-Go（C1a 后）

- [ ] 3.19 **视觉门**（G3-Q4）：1 seed × 5min 回放 + trajectory/contact-sheet（开放/转换/长传/禁区/松散球/死球）→ 用户先看
- [ ] 3.20 **Go/No-Go**（G3-Q10）：用户看 5min 回放 + 24 窗指标 + L1 非恶化；No-Go = 停止、分支留档；触发条件在此点汇总由用户判

### C1b（视觉门通过后）

- [ ] 3.13 事件提交协议（R3-H5）：候选只定意图 → 含分离的 22 人前视规划到 t_end（`PLAN_HORIZON`）→ 验证 → 原子提交事件+计划 → 执行核对；偏差置 `plan_divergence`，提交后不改已承诺锚点
- [ ] 3.15 唯一权威执行规则（R4-H1）：`CommittedPlan` 覆盖 `[t_c, P_eff=min(P_end,dur)]`，逐边界状态/decision/事件/RNG checkpoints；覆盖内只消费缓存、不调 `decision()`/不掷骰；逐边界核对；`P_eff` 用 `cp_end` 原子交还 live；偏差 `plan_divergence`
- [ ] 3.16 follow-on 计划链（R4-H1）：新高亮从 `P_eff` 起无重叠；`t<P_eff` 必须合并或拒绝；`MAX_PLAN_CHAIN=3` / `PLAN_CHAIN_MAX_S=30s` 超限 `highlight_infeasible`
- [ ] 3.17 交接边界（R5-H1）：A 边界事件/decision 一次 → B 同迭代接管首段（`start_marker`）→ C snapshot → D 缓存/live 推进；`P_end` decision 归 live、`cp_end` 在其前；`P_eff=min(P_end,dur)` 终场短 dt/无未来 decision；`plan_divergence` 三路核对（状态/事件账本/RNG）

## 4. 协议与 spec delta（实现）

- [x] 4.1 `event-stream-protocol`：beat 段合同、`dt`、稀疏 main/ball、新状态首段、重开准备期（设计阶段已写 delta）
- [x] 4.2 `match-engine`：L2 段边界/速度带、mover 位移、dead-zone、tackle/save 高亮、单步算法、总预算、可达性（设计阶段已写 delta）
- [x] 4.3 `pitch-viewer`：`beatSeconds`/`tackleSeconds`/`highlightSeconds`、参与者用 mover、只插值同一轨迹、T1/Catmull 默认关、缺 `dt` 报错（设计阶段已写 delta）
- [x] 4.4 MODIFIED requirements 复制主 spec 的全部 scenario（D8 清单已核对）
- [ ] 4.5 `MODEL_VERSION 11→12`；新建 `engine/tests/golden-v12/`；`golden_dir()` 加 `12 => "tests/golden-v12"`；`ACCEPT_GOLDEN=1` 重基线（已提交的树、干净工作树）
- [ ] 4.6 协议字段：第一阶段只发端点；`beat.dt` 为段长时序字段；若加 `vx/vy/heading`，bump 协议版本并补测试
- [ ] 4.7 填拍域 `FILL_FLIGHT_S=0.95×BEAT_DT`；速度带守卫（dist/FILL 不在 [10,25) 则不填）；finalize = 第一个 ≥ t_end 的 0.1s 网格步
- [ ] 4.8 终场末段 `dt = dur − t_last`（0<dt≤0.2）；死球 gap 约束相邻已发 beat；链式 finalize 去重终态事件
- [ ] 4.9 旧流：**删除 v11 兼容路径**（G3-Q7 拍板）——缺 `dt` 直接报错；删除 `legacyBeatSeconds`、旧五段式兼容、旧序 tackle 回溯分支；若有仓外消费者再回退 B
- [ ] 4.10 扑救协议（G2-Q4）：`result=saved` 的 shot 增加 `save_x/save_y/save_t`；finalize 在 `save_t`；`x2/y2` 仍门线；L2 saved x2 语义不变；协议 bump（MODEL_VERSION 11→12）

## 5. Viewer

- [ ] 5.1 `viewer/config.js`：`tickSeconds` → `beatSeconds=0.2` / `tackleSeconds=0.5` / `highlightSeconds=0.5`（删除旧键；**不保留 `legacyBeatSeconds`**，G3-Q7）
- [ ] 5.2 `interpretation.js:186/192/219/304/350` 逐点按 D6.1 归属切换；`game.js` 显式 `interpolation.smooth=false` / `textureAmpM=0`（不靠 0.5s 门槛）
- [ ] 5.3 稀疏 main/ball：`buildTimeline` 不补锚点、插值保持；`currentCarrier()` 向后扫描 + 失效事件停止（D6.2）
- [ ] 5.4 seek 重建：球用高亮锚点/`main`/`ball`，参与者用 mover；事件终点续接；**缺 `dt` 直接报错，删除 `legacyBeatSeconds` 与旧流回退**（G3-Q7）
- [ ] 5.5 缓存版本号 bump（`index.html` + app.js import specifier）
- [ ] 5.6 tackle 0.5s 跨 3 段的 viewer 断言（D6.1 时间线）
- [ ] 5.7 **参与者用 mover 端点**渲染（不合成事件直线）；事件锚点只作 `t_end` 对账；删除 `highlight_frozen_segs` 的显示线用途
- [ ] 5.8 内部间距 vs 显示间距两路断言：`st.pos` == mover 端点；viewer 插值后 `player_overlap` findings = 0
- [ ] 5.9 新状态首锚点的 seek 属性测试（save-caught 零速持球 / 原地拾取 / 新 loose 球静止）
- [ ] 5.10 `事件演绎遵循剧本` 迁移（R3-H5/G3-Q7）：人物用 `movers`、事件锚点只驱动球；**删除旧流五段式兼容**（缺 `dt` 报错）；6 个原 scenario 全覆盖
- [ ] 5.11 同步测试迁移（G2-Q8）：`interpretation.test.js` 改为 `beatSeconds↔BEAT_DT` / `tackleSeconds↔DECISION_DT`；新流停发事件派生球员锚点
- [ ] 5.12 `derive-audit-features` 改读 `beat.dt`（不再用 `tickSeconds` 铺 beat 时长）；补一条守卫测试
- [ ] 5.13 扑救演绎（R8-H1）：saved shot 用 save_t/save_x/save_y；save_t→P_end 保持；不把 x2/y2 门线当球终点、不闪回门线

## 6. 验证

- [ ] 6.1 `cargo test` 默认套件：迁移/重钉受影响的 golden、L2、p53/p31/p6/p32、p16/p124/p17b
- [ ] 6.2 `realism --ignored` L1 200 场：与 Phase 0 的权威基线逐条对照；**已有真实机制红**过预注册非恶化门；**新增破带失败**；角球带按 2.1 重锚；不得放宽真实带；不强迫修所有旧红
- [ ] 6.3 `ratchet diff`：无退化（有退化 exit 1；缺数据 exit 2）
- [ ] 6.4 `spacing-sweep`：player_overlap findings = 0；确定性/无 snap
- [ ] 6.5 `benchmark-baseline.json` 重生成；`engineFingerprint` 覆盖 `lib.rs` + `motion.rs` + wasm；哨兵绿
- [ ] 6.6 条件指标：`motion-census` frozen 24 窗（公开回归集），`turn120` **按 `conditional['0.5'].turnsPerPlayer`（24s/121 帧，不除窗长）**、另报 `turnsPerEffectivePair`；`staticFrac`、速度谱、加速度尾部、路径效率/回环、低速转向、残余漂移
- [ ] 6.7 视觉：trajectory + contact-sheet（开放/转换/长传/禁区/松散球/死球）
- [ ] 6.8 用户尺度：`viewer-match` seed42/5min + 90min 聚合
- [ ] 6.9 验收决策表（D9.1）：调参 seed 1–160 / 留出 321–440；真实 Metrica 1/1、SkillCorner 14/6；cluster bootstrap；最小有意义改善与不退化边界逐条
- [ ] 6.10 盲测：预注册等价边 **δ=0.15**；通过 = 95% CI **完全落入 [0.35,0.65]**；CI 完全在 0.5 任一侧且超界（含完全低于 0.5）= 失败；其他 = 无结论；**真实独立源只有 7 簇**，按 source match × seed/window 多向聚类，不承诺 72 独立真实源
- [ ] 6.11 独立审阅闭环：High 收敛到 0
- [ ] 6.12 save 否决统计：三分母（全部 shot / 原 save / 尝试修复的 save）+ 逐 seed + ≤2% 原 save + L1 射门结果非恶化
- [ ] 6.13 总向量预算：子步 `|Δv_total| ≤ A_MAX·SIM_DT` 的数值例与属性测试；米制边界 `[0,105]×[0,68]`
- [ ] 6.14 微位移/体积（G2-Q10）：`ε_move=1e-3 m/段`；`movers/beat` 报告量；核对 JSON 正常 ≤3×、密集 ≤5×
- [ ] 6.15 高亮期零事件决策（G2-Q6）：单测证明高亮内不评估机会/不掷事件 RNG；`plan_divergence` 状态核对标注为接线守卫
- [ ] 6.16 观察层 frozen 标签（G1-Q3）：`observe_state.frozen` 保留为活跃高亮参与者标签；p16 改断言（非空/仅高亮拍/少数拍），删「位置冻结」语义
- [ ] 6.17 旧流删除验收（G3-Q7）：缺 `dt` 报错；`legacyBeatSeconds`/旧五段式/旧序 tackle 回溯分支均为 0 引用；若发现仓外消费者再回退 B
- [ ] 6.18 加速度尾部（G3-Q8）：从**已发射 beat 端点**算主口径 + 内部子步对照口径；内部 p99 仅作构造不变量，不冒充现实指标
- [ ] 6.19 修复/拒绝率（G3-Q1）：逐事件类型/逐 seed 统计修复率与 `highlight_infeasible` 率，各 ≤5%；超预算停止定位
- [ ] 6.20 非网格 save_t（R8-H1/R9-H1）：save_t=1.03、P_end=1.1；1.03 扑救锚点、1.03–1.1 零速保持、1.1 状态提交；门线投影 1.08 **不产生额外边界**；`x2/y2` 仅 L2 投影（守护测试）；viewer 球/门将不闪回门线

## 7. 收尾

- [ ] 7.1 更新 #170 与本 change 的 design 批准记录
- [ ] 7.2 更新 #175 地图的 C1 状态
- [ ] 7.3 归档（滞后独立步骤，不在实现 PR 里顺手做）
