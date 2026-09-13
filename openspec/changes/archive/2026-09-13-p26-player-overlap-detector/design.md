# Design: player_overlap 同队间距 detector

## Context

#35 的 detector 部分。引擎侧间距约束（#53）等 #25 后做；本 change 只加 detector 暴露现状（实测窗口内同队最小间距 0.54m 等，均 <2m）。

## Goals / Non-Goals

**Goals:**
- `player_overlap` detector 对「观察窗口内同队球员间距 < 2m」产出 finding。
- 契约清单登记，discoverability 守卫通过。

**Non-Goals:**
- 不修引擎间距（#53）。
- 不做整场扫描（那是引擎侧 L2 的事）；detector 只跑观察窗口 audit_input。

## Decisions

### D1: team 判定按 id 范围

audit_input.players 快照无 team 字段（字段只有 `is_gk/t/x/y`）。team 按 id 推：`0-10 home` / `11-21 away`，与 protocol.js / derive-audit-features.js 的 `teamOf` 一致。不新增 team 字段。

### D2: 按「球员对」聚合

实测阈值 2m 下每窗口 10/17/1 对重叠，若逐采样点报会刷屏。聚合粒度 = 球员对：一个同队 pair 在窗口内任一时点 `dist < min_distance` → 报一条 finding，`match_time` 取该 pair 首次 <阈值的时刻，`features` 携带最小间距与首次越界时刻。

### D3: severity = realism_warning

位置重叠是「观感问题」（球员贴太近不好看，不违反足球硬规则、不 panic），区别于罚下球员（违反规则 → invariant_violation）。用 `realism_warning`。等 #53 修引擎后这些 finding 应归零（成为引擎间距达标的反向验收）。

### D4: 阈值 2.0 放 profile

`DEFAULT_AUDIT_PROFILE` 增 `player_overlap: { min_distance: 2.0 }`。与 issue #35 的「应 ≥2m」一致。detector 读 profile 阈值，不硬编码。

### D5: 契约登记

contract 增 `player_overlap` 条目：
- reads = `['t', 'x', 'y']`（快照字段）
- producers: `t: 'viewer'`、`x: 'derive'`、`y: 'derive'`（快照由 derive-audit-features 采样生成，t/x/y 都是 viewer/derive 层产）
- known_gaps = []
- notes 说明「同队判定按 id 范围，无需 team 字段」

### D6: 采样点对齐前提

audit_input.players 各球员快照 t 序列对齐（derive 层固定 step 采样，实测同一窗口各球员 t 序列一致）。detector 按「t 相同的快照」配对比较：按第一个球员的 t 序列遍历，每 t 收集各球员位置，同队两两算距。若某球员某 t 无快照（插值缺锚点），跳过该 t。

## 测试策略

- 真实 fixture：断言现状（引擎未修）有 `player_overlap` realism_warning（暴露问题）。
- 阈值边界：间距恰等于 2.0 → 不报（严格 <）；间距 1.99 → 报。
- 聚合：同一 pair 多采样点重叠 → 只报一条。
- 契约：discoverability 守卫通过（新 detector 已登记）。
