# Tasks: 修复 detector 字段契约断裂 + 防再犯

## P1. 契约清单模块（L2 前置）

- [x] P1.1 新增 `tools/detector-field-contract.mjs`：`DETECTOR_FIELD_CONTRACT`（每个 detector 的 reads/producers/known_gaps）+ `schema_version` 常量
- [x] P1.2 契约清单覆盖 4 个现有 detector（baseline_invariant / unforced_out / inactive_responsibility / ignored_interception_opportunity）

## P2. L1 修断裂（tools/detectors.mjs）

- [x] P2.1 `outEvidenceOf` 优先认 `detail` 出界（out_sideline/out_goal_line），保留 result==='out' 与几何出界兼容分支
- [x] P2.2 `classifyPassOutcome` 复用同一出界证据契约
- [x] P2.3 `EXCLUSION_KEYS` → `EXCLUSION_DETAILS`（corner/throw_in/free_kick/clearance），删 dead_ball/contested/goal_kick，布尔位保留兼容
- [x] P2.4 unforced_out 的 `out_reason` 由 detail 推导、`target_distance` 删除
- [x] P2.5 ignored_interception 降级：finding 加 `calibrated:false`，aggregate 加 `calibration:'uncalibrated'` 且不升级 failure
- [x] P2.6 inactive_responsibility 清理死代码（formation_hold 引用）

## P3. audit_input 版本保护（L2）

- [x] P3.1 `derive-audit-features.js` 输出加 `schema_version`
- [x] P3.2 `viewer/observation.js` 生成 bundle 的 audit_input 时带 schema_version
- [x] P3.3 `runAudit` 入口校验 schema_version（缺失/未知 → 抛错）

## P4. 真实 fixture 替换（L2，#33）

- [x] P4.1 从 `.scratch/tasks/*.bundle.json` 抽取真实 audit_input 形状作 fixture（`tools/fixtures/`）
- [x] P4.2 `detectors.test.mjs` 主输入换成真实形状；保留合成边界用例（result:'out' 兼容 / 几何出界防御 / 布尔排除位兼容）
- [x] P4.3 新增契约断言测试：契约清单每个 reads 字段在真实 audit_input 有生产者或登记 known-gap
      （实现口径比本条更严：reads 字段**一律要求有生产者**，known-gap 只在
      `kind:'unproducible'` 时用于豁免无生产者的字段；`semantic`/`removed` 两类 gap 是
      登记说明而非豁免。见 `tools/detector-field-contract.mjs` 的 KNOWN_GAPS。）
      ※ 另有两条超出本任务书的守卫，来自审阅加固：`tools/detector-field-contract.test.mjs`
      的**源码级**扫描（抓「未被输入触发」的新 detector 与分支内未声明读取）与
      `viewer/derived-audit.test.js` 的**派生层活体守卫**（抓「派生层丢字段」——
      契约测试吃冻结快照，看不见这一层）。

## P5. 测试 + 收尾

- [x] P5.1 真实出界传球 → unforced_out 产 realism_warning（不再 unknown）；pass_outcomes.out_count > 0
- [x] P5.2 排除位回归：corner/throw_in/free_kick/clearance detail 被排除
- [x] P5.3 降级回归：calibrated:false + calibration:'uncalibrated'
- [x] P5.4 `verify.sh` 全绿（含 tools 单测）+ `npx openspec validate --all --strict`
- [x] P5.5 审阅闭环（独立 subagent 审阅 → 修复 → 再审阅至无遗留）

## 关联 issue

- 修复 #26；范围由 #28 四决策定稿；拆出 #34/#35/#36；引擎侧归 #25
