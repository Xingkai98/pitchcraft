# Tasks: 引擎统一运动执行层（C1 运动学，#170）

> **设计批准前不写实现**（#170 硬要求）。批准 = 用户在 #170 评论「design 批准」或 PR approve；
> 批准链接写回 `design.md` 顶部。

## 1. 提案与设计（当前阶段）

- [x] 1.1 `proposal.md` / `design.md` / `specs/match-engine/spec.md` / `specs/event-stream-protocol/spec.md` / `tasks.md`
- [ ] 1.2 `openspec validate p1-motion-integration --strict` → valid
- [ ] 1.3 gpt-6.1-sol 零上下文审阅：P0/P1（high）收敛到 0
- [ ] 1.4 用户在 #170 / PR 批准 design；批准链接写回 `design.md`
- [ ] 1.5 拍板 design D11 的 6 个决策（cadence / beat / 协议字段 / 角球带 / 守卫前置 / C1 范围）

## 2. Phase 0：前置（design 批准后先做）

- [ ] 2.1 角球带处置：重锚到真实 ~10.27 或降级为报告项（不得删红门）
- [ ] 2.2 p53/p31/p6/p32 改为「显式构造场景 + 条件断言 + 多 seed 置信范围」夹具；保留契约
- [ ] 2.3 预注册指标：条件 `turn120`、`staticFrac`、速度分位、加速度尾部、ballStatic（viewer 链 caveat）
- [ ] 2.4 保存改动前 ratchet：`node tools/ratchet.mjs save .../notes/ratchet-before.json`
- [ ] 2.5 重扫 `realism.rs` 的 `ok_step` 假绿分支，改成从 `BEAT_DT` 字面量推导

## 3. 运动执行层

- [ ] 3.1 新建 `engine/src/motion.rs`：`MotionState { pos_m, vel_mps, heading, mode }`
- [ ] 3.2 实现 `dv/dt = A0(1−v/S0)`、`|ω| ≤ a_lat/max(v,1)`、制动曲线/到达半径
- [ ] 3.3 删除「dead-zone 整拍冻结」；保留到达半径；速度/位置内部米制
- [ ] 3.4 三层 cadence：`SIM_DT=0.1` / `DECISION_DT=0.5` / `BEAT_DT=0.2`；仿真子步零 RNG
- [ ] 3.5 统一 carrier / 无球 / 高亮参与者 / 门将 / 重开走位 / 同队分离；分离不绕过加速度
- [ ] 3.6 所有 `*_TICKS` 重新挂到 decision 拍；核 17 个换域常量（#170 清单 + v11 现状）
- [ ] 3.7 `p16` / `p124` 观测快照按 design D2.2 A 案（decision 拍），不改两个既有 change 的契约

## 4. 协议与 spec delta

- [ ] 4.1 `event-stream-protocol`：beat 0.2s、`movers` 语义、`main`/`ball` 携带规则
- [ ] 4.2 `match-engine`：L2 beat gap、mover 单拍位移、dead-zone、tackle/save 高亮、三层 cadence
- [ ] 4.3 `pitch-viewer`：5Hz beat、只插值同一轨迹、关闭 T1/Catmull 默认
- [ ] 4.4 **MODIFIED requirements 必须复制主 spec 的全部 scenario**（archive 已知坑）
- [ ] 4.5 `MODEL_VERSION 11→12`；新建 `engine/tests/golden-v12/`；`ACCEPT_GOLDEN=1` 重基线
- [ ] 4.6 协议字段决策：第一阶段只发端点；若加 `vx/vy/heading`，bump 协议版本并补测试

## 5. Viewer

- [ ] 5.1 `viewer/config.js` 的 `tickSeconds` → `beatSeconds=0.2`
- [ ] 5.2 `game.js` / `interpretation.js` 的 beat 铺满、Catmull 邻窗、T1 纹理以 `beatSeconds` 为准
- [ ] 5.3 第一阶段关闭 T1/Catmull 默认；只线性插值同一运动轨迹
- [ ] 5.4 缓存版本号 bump（`index.html` + app.js import specifier）
- [ ] 5.5 传球/接球者滑行锚点与运动层同语义；若引擎已给轨迹，viewer 不再合成

## 6. 验证

- [ ] 6.1 `cargo test` 默认套件：迁移/重钉受影响的 golden、L2、p53/p31/p6/p32、p16/p124/p17b
- [ ] 6.2 `realism --ignored` L1 200 场：既有 4 红列清单；新增偏离按真实锚联合重标定；护栏检查退化
- [ ] 6.3 `ratchet diff`：无退化（有退化 exit 1；缺数据 exit 2）
- [ ] 6.4 `spacing-sweep`：player_overlap findings = 0；确定性/无 snap
- [ ] 6.5 `benchmark-baseline.json` 重生成；`engineFingerprint` 哨兵绿
- [ ] 6.6 条件指标：`motion-census` frozen 24 窗，旧/条件 `turn120`、`staticFrac`、速度谱、加速度尾部
- [ ] 6.7 视觉：trajectory + contact-sheet（开放/转换/长传/禁区/松散球/死球）
- [ ] 6.8 用户尺度：`viewer-match` seed42/5min + 90min 聚合
- [ ] 6.9 盲测：48–72 项、≥5 名零上下文裁判、预注册、含负控、base vs 候选配对
- [ ] 6.10 独立审阅闭环：P0/P1 收敛到 0

## 7. 收尾

- [ ] 7.1 更新 #170 与本 change 的 design 批准记录
- [ ] 7.2 更新 #175 地图的 C1 状态
- [ ] 7.3 归档（滞后独立步骤，不在实现 PR 里顺手做）
