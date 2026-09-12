# Proposal: 修复 detector 字段契约断裂（L1）+ 防再犯（L2）

## Why

诊断链路的第一层是**确定性审计**（detector → findings），第二层才是 LLM 根因分析。但四份调研发现：detector 对真实引擎数据**基本是瞎的**——单测全绿，生产全漏。核心病灶是**字段契约断裂**：detector 读的字段，引擎和推导层要么不产、要么换了个写法。

三个铁证（已核实引擎源码 + 真实 bundle）：

1. **出界证据盲点**：真实出界传球长这样（`engine/src/lib.rs:1295`）——`result:"contested"` + `detail:"out_sideline"` + 坐标被 `clamp01` 钳回场内。而 `detectors.mjs` 的 `outEvidenceOf` 只认 `result==='out'` 和「落点在球场外」。两个信号一个引擎从不写、一个被 clamp 销毁 → **unforced_out 对真出界 100% 漏报**，全落 `unknown`。
2. **排除位无生产者**：`EXCLUSION_KEYS` 的 6 个布尔键（dead_ball/clearance/corner/throw_in/goal_kick/contested）全读 `event[k]===true`，但引擎从不产这些布尔字段，引擎用 `detail` 字符串 + `result` 表达。
3. **字段无单一权威**：detector 读 `target_distance`/`out_reason`/`formation_hold`/`zone`，这些字段**没有任何生产者**（引擎直出不产、`derive-audit-features.js` 推导层也不产）。断裂能潜伏几个月不被发现，因为 `detectors.test.mjs` 的 fixture 全是手工合成的（`result:'out'`、布尔键、未钳制坐标），从不用真实形状。

本 change 按 wayfinder 地图 #28 四决策实施（范围已定稿）：
- **L1 修断裂**：让 4 个现有 detector 能读懂真实数据。
- **L2 防再犯**：契约断言 + audit_input 版本保护 + 真实 bundle fixture。

L3（罚下球员/位置重叠新 detector，issue #34/#35）与 ignored_interception 标定（issue #36）**不在本轮**，已拆出独立 issue。

## What Changes

### L1 — 让 detector 活过来

- **出界证据**：`outEvidenceOf` 优先认 `detail === 'out_sideline' | 'out_goal_line'`，保留 `result==='out'` 与几何出界作兼容/防御分支。
- **排除位映射**：`EXCLUSION_KEYS` 从 6 个布尔键改为读 `detail` 字符串集合（corner/throw_in/free_kick/clearance），删除语义错乱的 `contested`（引擎用它表达出界，作排除位会误杀真出界）与无生产者的 `dead_ball`。
- **字段生产对齐**：unforced_out 的 `out_reason`/`target_distance` 字段改为从已有生产字段推导（`out_reason` 由 `detail` 推导，`target_distance` 删除或回退到 `pass_distance`）。
- **ignored_interception 降级静音**：按 #31 决策，本轮将该 detector 告警标记 `calibrated: false` 并降级，不再作为 realism_warning 进诊断报告（标定归 #36）。

### L2 — 防再犯

- **契约断言**：新增字段契约清单模块，声明「每个 detector 读的字段 → 谁产（引擎直出 / 推导层）→ 有无生产者」；测试断言真实 audit_input 上每个读取字段都有生产者或显式 known-gap。
- **audit_input 版本保护**：`audit_input` 携带 `schema_version`，`runAudit` 读取前校验版本，不匹配即报错而非静默漂移。
- **真实 bundle fixture 替换**：`detectors.test.mjs` 的合成输入换成从真实 bundle（`.scratch/tasks/*.bundle.json`）抽取的 audit_input 形状，钉住 `result:'contested'` + `detail` + 钳制坐标。

## Capabilities

### Modified Capabilities

- `diagnosis-runner`: 确定性审计层（detector）的出界证据契约、排除位契约、字段契约权威、audit_input 版本保护、未标定告警降级。

## Impact

- `tools/detectors.mjs`（出界证据、排除位、字段推导、ignored_interception 降级）
- `tools/detectors.test.mjs`（真实 fixture 替换 + 契约断言）
- `tools/detector-field-contract.mjs`（新增：字段契约清单，供断言使用）
- `viewer/derive-audit-features.js`（如需要补产出字段；`audit_input.schema_version`）
- `viewer/observation.js`（bundle 生成处给 audit_input 加 schema_version）
- 不碰引擎（`engine/src/lib.rs` 出界字段编码归 #25）、不碰事件流协议字段语义。

## 关联

- 决策地图：GitHub issue #28（四决策定稿）、#29-#32（已关闭）
- 拆出 issue：#34（罚下球员）、#35（位置重叠）、#36（ignored_interception 标定）
- 引擎侧出界显式字段 / 不 clamp 归 #25（引擎造数重构），不在本 change
- 本 change 修复 issue #26（detector 字段契约审计）
