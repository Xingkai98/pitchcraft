# Design: 修复 detector 字段契约断裂 + 防再犯

## Context

诊断审计第一层（deterministic detector）对真实引擎数据失效的根因，是「detector 读的字段」与「引擎/推导层实际产出的字段」之间没有单一权威、靠人脑心算对齐。四份调研（issue #26）已把断裂点、字段契约真相表、覆盖缺口、测试覆盖缺口摸清；wayfinder 地图 #28 四决策把范围收敛为 L1（修断裂）+ L2（防再犯）。

本文档把 L1 的映射细节、L2 的机制、以及本轮明确不做/known gap 定稿。

## 已验证的事实（来自引擎源码 + 真实 bundle）

### 出界 pass 事件的实际形状

```
// engine/src/lib.rs:1295（emit_pass_out_play_slot，corner/throw_in 槽）
result: Some("contested"),          // 无区分度
detail: Some("out_sideline" | "out_goal_line"),   // 唯一出界证据
x2/y2: clamp01(raw_x), clamp01(raw_y)             // 几何出界被销毁
```

普通传球落点出界（P6 批次1，lib.rs:1344-1368）与头球解围出界（lib.rs:2329-2344）同样用 `result:"contested"` + `detail:out_*`。

### 引擎 pass 事件的 detail 值全集

| detail | 场景 | 语义 |
|---|---|---|
| `out_sideline` | 传球/解围出边线 | 出界 |
| `out_goal_line` | 传球/解围出底线 | 出界 |
| `corner` | 角球发球（lib.rs:2008） | 死球重开 |
| `throw_in` | 界外球掷球（lib.rs:2044） | 死球重开 |
| `free_kick` | 任意球发球（lib.rs:2079） | 死球重开 |
| `clearance` | 头球解围不出界（lib.rs:2350） | 有意解围 |
| （无 detail） | 门将开大脚（start_goal_kick 不写 detail） | 死球重开 |
| `header` | 头球**射门**（lib.rs:2237，非 pass） | — |

`foul_*`（foul_trip/tackle/push/hold/handball）只出现在 foul 事件，非 pass。

### 字段契约真相表（谁产、谁读）

| 字段 | 生产方 | detector 读取 | 断裂 |
|---|---|---|---|
| `detail` | 引擎直出 | ✗（现状不读） | L1 修复目标 |
| `result` | 引擎直出（contested/success/intercepted/lost/goal/saved/off_target） | `result==='out'`（引擎不产 'out'） | L1 修复 |
| `x2/y2` | 引擎直出 + derive 层转米（clamp01 后无出界几何） | 几何出界判断 | 已失效，保留防御 |
| `nearest_defender_distance` | derive 层（derive-audit-features.js） | unforced_out / pass_outcomes | ✅ 有生产 |
| `pass_distance` | derive 层 | unforced_out / ignored_interception | ✅ 有生产 |
| `pass_speed` | derive 层 | ignored_interception | ✅ 有生产 |
| `corridor_distance` | derive 层 | ignored_interception | ✅ 有生产 |
| `defender_id` / `defender_moved_toward_corridor` | derive 层 | ignored_interception | ✅ 有生产 |
| `target_distance` | **无人产** | unforced_out features | L1 修复（删/回退） |
| `out_reason` | **无人产** | unforced_out features | L1 修复（由 detail 推导） |
| `dead_ball`/`clearance`/`corner`/`throw_in`/`goal_kick`/`contested` 布尔位 | **无人产** | EXCLUSION_KEYS | L1 修复（改读 detail） |
| `formation_hold` / `zone` | **无人产** | inactive_responsibility（部分） | 评估 |

## Goals / Non-Goals

**Goals:**
- unforced_out 对真实出界传球能产出 finding（不再 100% 漏报）。
- 排除位与引擎真实表达对齐（detail 字符串）。
- 每个 detector 读取的字段都有明确生产方或显式 known-gap。
- 测试用真实 bundle 形状钉住契约，防再犯。

**Non-Goals:**
- 不碰引擎出界字段编码（发显式 out / 不 clamp）→ #25。
- 不新增 detector（罚下球员/位置重叠 → #34/#35）。
- 不标定 ignored_interception（→ #36），只降级静音。
- 不写完整契约规范文档（→ 留 #25 前）。

## Decisions

### D1: 出界证据契约（outEvidenceOf 读 detail）

`outEvidenceOf(event, profile)` 判定顺序：

1. `detail === 'out_sideline' || detail === 'out_goal_line'` → 返回 `'event.detail'`（真实出界的主证据）。
2. `result === 'out'` → 返回 `'event.result'`（兼容旧 fixture / 未来引擎显式字段）。
3. 几何出界（`x2/y2` 严格在球场外）→ 返回 `'landing_out_of_bounds'`（防御分支；clamp01 后通常不触发，但保留以防非 clamp 输入）。
4. 否则 `null`。

`classifyPassOutcome` 同步复用同一证据契约（`result==='out'` → 改用「detail 出界或 result==='out' 或几何出界」→ `'out'`）。

### D2: 排除位映射（EXCLUSION_KEYS → detail 集合）

`EXCLUSION_DETAILS = ['corner', 'throw_in', 'free_kick', 'clearance']`，判定改为 `event.detail ∈ EXCLUSION_DETAILS`。

- 删除 `dead_ball`、`contested`、`goal_kick` 三个布尔位：
  - `contested`：引擎用 `result:"contested"` 表达**出界**（与 detail 出界共存），把它当排除位会误杀真出界——语义错乱，删除。
  - `dead_ball`：布尔位无人产，且死球重开已由 corner/throw_in/free_kick 表达，删除。
  - `goal_kick`：门将开大脚**无 detail**，无法靠 detail 映射（见 Known Gap K1）。
- 兼容：若未来 fixture 仍带布尔位 `event.clearance === true` 等，保留布尔位作为**次要**兼容分支（布尔位与 detail 任一命中即排除）。这样旧合成测试与新真实数据都兼容。

### D3: unforced_out 字段推导对齐

- `out_reason`：不再读 `event.out_reason`（无人产），改为从证据源推导——`event.detail === 'out_goal_line' ? 'out_goal_line' : event.detail === 'out_sideline' ? 'out_sideline' : <保留原逻辑>`。
- `target_distance`：从 features 中删除（无人产，且出界球 `to===null` 无目标）。保留 `pass_distance`。

### D4: ignored_interception 降级静音（#36 前置）

- `DEFAULT_AUDIT_PROFILE.ignored_interception` 加 `calibrated: false`。
- `runAudit` 产出该 detector 的 finding 时，`severity` 仍为 `realism_warning`，但 finding 加 `calibrated: false`。
- `aggregateAudit` 对 `calibrated === false` 的 detector：`aggregate_severity` 不升级为 `realism_failure`（band 判定对未标定 detector 不生效），并在 detector 摘要里加 `calibration: 'uncalibrated'` 字段。诊断报告层据此不把该 detector 的 warning 当可信线索。
- 具体「诊断报告是否展示 uncalibrated 告警」在实现时与 runner 对齐：本轮目标只是**不污染**，标定恢复归 #36。

### D5: 字段契约单一权威（轻量，防再犯）

新增 `tools/detector-field-contract.mjs`，导出结构化契约清单：

```js
export const DETECTOR_FIELD_CONTRACT = {
  unforced_out: {
    reads: ['detail', 'result', 'x2', 'y2', 'nearest_defender_distance', 'pass_distance'],
    producers: {
      detail: 'engine', result: 'engine', x2: 'derive', y2: 'derive',
      nearest_defender_distance: 'derive', pass_distance: 'derive',
    },
  },
  // ignored_interception / inactive_responsibility / baseline_invariant 同理
  // + known_gaps: ['goal_kick_exclusion']（K1）
};
```

契约清单是**单一事实来源**：detector 代码与契约清单不一致 → 测试红。测试断言（见 D6）遍历契约清单，对真实 bundle 的 audit_input 检查每个 `reads` 字段要么存在于真实事件/快照，要么登记在 `known_gaps`。

### D6: audit_input 版本保护 + 真实 fixture

- `deriveAuditInput` 输出加 `schema_version`（当前定为 `'audit-input/1'`）。
- `runAudit` 入口校验 `input.schema_version`：缺失或未知版本 → 抛错（而非静默用默认）。真实 bundle 的 audit_input 由 viewer/observation.js 生成，随本 change 同步加 `schema_version`。
- `detectors.test.mjs` 的合成输入改为：
  1. 从 `.scratch/tasks/*.bundle.json` 抽取真实 audit_input 形状的 **fixture 文件**（`tools/fixtures/*.audit.json` 或直接从 bundle 读），测真实出界传球 `result:'contested'` + `detail:'out_sideline'` + clamp 坐标能被 unforced_out 识别。
  2. 保留少数合成输入用于边界（`result:'out'` 兼容分支、几何出界防御分支），但真实形状为主。

## Known Gaps（本轮明确不做，登记进契约清单 known_gaps）

- **K1 goal_kick 排除**：门将开大脚 pass 无 detail，无法靠 detail 排除。影响：pass_outcomes 统计把门球开大脚计入普通传球（minor 统计偏差，非漏报）。归 #25 引擎给门球 pass 加显式 detail 或类型。
- **K2 解围出界细分**：头球解围出界事件 detail 也是 `out_*`（与普通传球出界同形，`source=Clearance` 只在 Highlight 里、不进事件 JSON）。影响：解围出界会被 unforced_out 当普通出界报（防守方有意解围被当失误）。归 #25 引擎出界事件加显式 source/意图字段。
- **K3 formation_hold / zone**：inactive_responsibility 排除逻辑引用了 `formation_hold`（无生产者）。评估后：`formation_hold` 是引擎内部事实、viewer 不可观测（derive 层已注释「不推导，保持 unknown」）。本轮确认 detector 对该字段的引用是**死代码**（永远 false），清理掉或显式 known-gap，不新增推导。

## 测试策略

- **真实 fixture 回归**：真实出界传球 → `unforced_out` 产 `realism_warning`（不再是 unknown）；`pass_outcomes.out_count > 0`。
- **排除位回归**：corner/throw_in/free_kick/clearance detail 的 pass 被排除，不计入 ordinary pass、不产 unforced_out。
- **契约断言**：契约清单里每个 `reads` 字段在真实 audit_input 有生产者或登记 known-gap；`runAudit` 拒绝缺 `schema_version` 的输入。
- **降级回归**：ignored_interception 的 finding 带 `calibrated:false`，aggregate 摘要带 `calibration:'uncalibrated'` 且不升级 failure。
- **兼容回归**：旧合成输入（`result:'out'`、布尔排除位）仍按原语义通过。
