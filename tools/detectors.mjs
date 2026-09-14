// Deterministic audit detectors.
//
// P10 vertical slice: unforced_out, inactive_responsibility, plus baseline
// invariants and multi-seed aggregation. Pure functions over fixture
// events/player snapshots. No WASM, no network, no Claude/API calls. When
// evidence cannot prove a conclusion, a detector emits an `unknown` finding
// with a reason instead of guessing.
//
// P32（#36）：`ignored_interception_opportunity` 已**彻底删除**——它的「防守者能跑到走廊
// 就该拦」是确定性语义，与 post-#25 的概率拦截引擎（贴防 7.5% / 中距 4.5% / 远距 2.0%、
// 长传加成、cap）错位，实测 45% 假阳性。拦截概率的自洽硬门已移入**引擎侧**（判定点记账
// + `engine/src/lib.rs` 的 `mod tests` 原生断言），audit 层只保留 `pass_outcomes` 的
// 轻量分层作 L3 软参考。详见 openspec/changes/p32-ignored-interception-calibration/。

import { AUDIT_INPUT_SCHEMA_VERSION } from '../viewer/derive-audit-features.js';

export const DEFAULT_AUDIT_PROFILE = {
  id: 'p10-mvp',
  version: '0.1.0',
  unforced_out: {
    // Defender further than this (meters) from the pass start => unforced.
    pressure_distance: 8.0,
    // Landing within this distance (meters) of a touchline/goal line counts as
    // near-boundary. Coordinates are assumed to span [0, pitch.width] x [0, pitch.height].
    boundary_margin: 3.0,
    // D4 的标定状态必须**显式**声明（isUncalibrated 只认 calibrated:true）。默认对已知可靠
    // 的 detector 标 true，未标定的显式标 false ——「没声明」一律按未标定处理（fail-closed）。
    calibrated: true,
  },
  pitch: { width: 105, height: 68 },
  inactive_responsibility: {
    // Seconds a responsible player may stay stationary before it is a finding.
    static_duration: 3.0,
    // Consecutive snapshots closer than this (meters) count as stationary.
    stationary_epsilon: 0.5,
    calibrated: true,
  },
  player_overlap: {
    // 同队两球员的最小站位间距（米）。真人比赛同队间距通常 ≥2m（issue #35）；引擎当前
    // repulsion（REPULSION_MIN_DIST=1.36m + 盲区）会把同队球员贴到 0.1m 级，引擎侧间距
    // 约束归 #53。detector 只按严格 `<` 判定（恰等于阈值不算重叠）。
    min_distance: 2.0,
    // P21 D4 的显式标定声明：只知道阈值（真实比赛常识），不知道**告警率**的真实区间，
    // 故标未标定——聚合层不因超 band 升级 realism_failure，保持 D3 的 realism_warning
    // 语义。告警率标定归 #36。
    calibrated: false,
  },
  // Baseline invariant checks: things that must hold regardless of realism.
  invariants: {
    // Out-of-order tolerance for same-instant events (kickoff+whistle at t).
    time_order_epsilon: 1e-6,
    // Fraction of the pitch dimension a coordinate may legally exceed (a ball
    // that just crossed the line). Coordinates far beyond this are a bug.
    bounds_tolerance: 0.05,
    // 不变量违规是 bug、不看标定带（band max=0），但 D4 的标记仍显式声明。
    calibrated: true,
  },
  // Multi-seed aggregation reference bands. MVP has no calibrated real-match
  // band (design.md open question), so bands default to "warnings are
  // candidates"; a calibrated band can be supplied at aggregation time.
  aggregation: {
    reference_bands: {
      baseline_invariant: {
        min: 0,
        max: 0,
        source: 'p10-mvp',
        note: 'invariant violations are bugs: any occurrence is a failure',
      },
      unforced_out: { min: 0, max: null, source: 'p10-mvp', note: 'no calibrated band; warnings are candidates' },
      inactive_responsibility: { min: 0, max: null, source: 'p10-mvp', note: 'no calibrated band; warnings are candidates' },
      player_overlap: {
        min: 0,
        max: null,
        source: 'p10-mvp',
        note:
          '#53 修引擎后同队间距应全部 ≥2m，告警归零；告警率本身未用真实比赛标定（#36），故不设 band 上限',
      },
    },
  },
};

const RESPONSIBILITY_TRIGGERS = [
  'ball_entered_zone',
  'possession_transition',
  'defensive_line_moved',
];

// detector_id → profile 里对应配置块的键。二者目前同名，但保留显式映射（历史原因：删掉的
// `ignored_interception_opportunity` 曾映射到 `ignored_interception` 块）。D4 的 calibrated
// 标记就靠它把 finding/detector 摘要挂回配置。
// 新 detector 必须同时补这里和 tools/detector-field-contract.mjs（契约测试会红）。
const DETECTOR_PROFILE_KEY = {
  baseline_invariant: 'invariants',
  unforced_out: 'unforced_out',
  inactive_responsibility: 'inactive_responsibility',
  player_overlap: 'player_overlap',
};

// 未标定判定，严格 fail-closed：**只有显式声明 `calibrated: true` 才算已标定**，其余一律
// 算未标定。三条保守路径：
//   - detector_id 不在映射表（新 detector 忘了登记）→ 未标定；
//   - 映射到块键，但调用方 profile 里整个块缺失（自定义 partial profile）→ 未标定；
//   - 块在、但没有 `calibrated` 键（只部分覆盖了块）→ 未标定。
// 前两条曾各自 fail-open（审阅发现），第三条同理——「没声明」不等于「已标定」。
// 「新 detector 必须登记」由契约测试在测试期兜住（见 detector-field-contract.test.mjs）。
const isUncalibrated = (detectorId, profile) => {
  const blockKey = DETECTOR_PROFILE_KEY[detectorId];
  if (blockKey === undefined) return true;
  const block = profile?.[blockKey];
  if (block === undefined) return true;
  return block.calibrated !== true;
};

const distance = (a, b) =>
  Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));

const round3 = (n) => Math.round(n * 1000) / 1000;

// --- baseline invariants -----------------------------------------------------

// Invariant checks that must hold for ANY bundle, independent of realism.
// Violations are `invariant_violation` findings (bugs), never warnings.
// 导出供契约漂移守卫（tools/detector-field-contract.test.mjs）逐 detector 断言它只读自己
// 契约里声明的字段——只按并集断言会漏掉「A 读了 B 的字段」这类串读。
export function detectInvariants(events, players, profile) {
  const findings = [];
  const cfg = profile.invariants;
  const eps = cfg.time_order_epsilon;
  const { width, height } = profile.pitch;
  const tolX = Math.max(1, width * cfg.bounds_tolerance);
  const tolY = Math.max(1, height * cfg.bounds_tolerance);

  // 1. Event time ordering is monotonic (non-decreasing).
  for (let i = 1; i < events.length; i++) {
    if (events[i].t < events[i - 1].t - eps) {
      findings.push({
        id: `baseline_invariant:time_order:${events[i].index ?? i}`,
        detector_id: 'baseline_invariant',
        event_index: events[i].index ?? i,
        match_time: events[i].t ?? null,
        entity_id: null,
        severity: 'invariant_violation',
        reason: `event time regresses: t[${i - 1}]=${events[i - 1].t} > t[${i}]=${events[i].t}`,
        features: { prev_t: events[i - 1].t, next_t: events[i].t },
        thresholds: { time_order_epsilon: eps },
      });
    }
  }

  // 2. Coordinates must be finite numbers and inside the pitch (with a small
  //    tolerance for balls that just crossed a line). Findings carry the
  //    event_index (event coords) or entity_id (player coords) so they satisfy
  //    the "event index or entity id per finding" requirement.
  const checkCoords = (coords, sourceLabel, idx, t, ctx = {}) => {
    const { event_index = null, entity_id = null } = ctx;
    for (const [name, value] of Object.entries(coords)) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        findings.push({
          id: `baseline_invariant:non_finite:${sourceLabel}:${name}:${idx}`,
          detector_id: 'baseline_invariant',
          event_index,
          match_time: t ?? null,
          entity_id,
          severity: 'invariant_violation',
          reason: `${sourceLabel} ${name} is not a finite number`,
          features: { source: sourceLabel, coord: name, index: idx },
          thresholds: {},
        });
        continue;
      }
      const maxX = width + tolX;
      const maxY = height + tolY;
      // Axis detection: x2/y2 (and any future trailing-digit variant such as
      // x3/y3) are x/y coordinates; strip trailing digits so they hit the
      // matching pitch dimension instead of falling through.
      const axis = name.replace(/[0-9]+$/, '');
      if (axis.endsWith('x') && (value < -tolX || value > maxX)) {
        findings.push({
          id: `baseline_invariant:out_of_bounds:${sourceLabel}:${name}:${idx}`,
          detector_id: 'baseline_invariant',
          event_index,
          match_time: t ?? null,
          entity_id,
          severity: 'invariant_violation',
          reason: `${sourceLabel} ${name}=${value} is outside pitch [0,${width}] (tol ${tolX})`,
          features: { source: sourceLabel, coord: name, value, index: idx },
          thresholds: { bounds_tolerance: cfg.bounds_tolerance },
        });
      } else if (axis.endsWith('y') && (value < -tolY || value > maxY)) {
        findings.push({
          id: `baseline_invariant:out_of_bounds:${sourceLabel}:${name}:${idx}`,
          detector_id: 'baseline_invariant',
          event_index,
          match_time: t ?? null,
          entity_id,
          severity: 'invariant_violation',
          reason: `${sourceLabel} ${name}=${value} is outside pitch [0,${height}] (tol ${tolY})`,
          features: { source: sourceLabel, coord: name, value, index: idx },
          thresholds: { bounds_tolerance: cfg.bounds_tolerance },
        });
      }
    }
  };

  events.forEach((e, i) => {
    const t = e.t;
    checkCoords(
      { x: e.x, y: e.y, x2: e.x2, y2: e.y2 },
      `event#${e.index ?? i}`,
      i,
      t,
      { event_index: e.index ?? i }
    );
    if (e.type === 'pass' && typeof e.pass_distance === 'number') {
      const diagonal = Math.hypot(width, height);
      if (!Number.isFinite(e.pass_distance) || e.pass_distance <= 0) {
        findings.push({
          id: `baseline_invariant:pass_distance:${e.index ?? i}`,
          detector_id: 'baseline_invariant',
          event_index: e.index ?? i,
          match_time: t ?? null,
          entity_id: null,
          severity: 'invariant_violation',
          reason: `pass_distance=${e.pass_distance} is not a positive finite length`,
          features: { pass_distance: e.pass_distance, index: i },
          thresholds: {},
        });
      } else if (e.pass_distance > diagonal * (1 + cfg.bounds_tolerance)) {
        findings.push({
          id: `baseline_invariant:pass_distance:${e.index ?? i}`,
          detector_id: 'baseline_invariant',
          event_index: e.index ?? i,
          match_time: t ?? null,
          entity_id: null,
          severity: 'invariant_violation',
          reason: `pass_distance=${e.pass_distance} exceeds the pitch diagonal ${diagonal}`,
          features: { pass_distance: e.pass_distance, diagonal, index: i },
          thresholds: { bounds_tolerance: cfg.bounds_tolerance },
        });
      }
    }
  });

  // 3. Player snapshots must carry finite coordinates.
  for (const [rawId, snaps] of Object.entries(players ?? {})) {
    if (!Array.isArray(snaps)) continue;
    const entityId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    snaps.forEach((s, i) => {
      checkCoords({ x: s.x, y: s.y }, `player:${entityId}`, i, s.t, { entity_id: entityId });
    });
  }

  return findings;
}

// --- unforced_out -----------------------------------------------------------

// P21 D2：死球/战术传球的排除位读 `detail` 字符串集合——这是引擎真实的表达方式。
// 此前读的布尔位（dead_ball/clearance/corner/throw_in/goal_kick/contested）引擎一个都不产：
//   - contested：引擎用它表达**出界**（与 detail:out_* 共存），当排除位会误杀真出界 → 删。
//   - dead_ball / goal_kick：无生产者，且死球重开已由 corner/throw_in/free_kick 表达 → 删。
//     （门球开大脚无 detail，无法靠 detail 映射，登记为 known gap K1。）
const EXCLUSION_DETAILS = ['corner', 'throw_in', 'free_kick', 'clearance'];

// 兼容分支：旧合成 fixture 仍可能带布尔排除位。布尔位与 detail 任一命中即排除。
// 只保留语义正确的三个（clearance/corner/throw_in）；contested/dead_ball/goal_kick 不在此列。
const EXCLUSION_LEGACY_KEYS = ['clearance', 'corner', 'throw_in'];

// 判定一个 pass 事件是否被排除（死球重开 / 有意解围）。返回命中的 token 列表，空即未排除。
// token 用 detail 值或布尔键名，便于 reason 里直接可读（如 `excluded: corner`）。
function exclusionTokensOf(event) {
  const tokens = EXCLUSION_DETAILS.filter((d) => event.detail === d);
  for (const k of EXCLUSION_LEGACY_KEYS) {
    if (event[k] === true) tokens.push(k);
  }
  return tokens;
}

// Distance (meters) of a landing point to the nearest pitch boundary. Coordinates
// are assumed to span [0, width] x [0, height]; anything beyond an edge has
// distance 0 (it is already out of play).
function distanceToBoundary(x2, y2, pitch) {
  const dx = Math.min(Math.abs(x2 - 0), Math.abs(x2 - pitch.width));
  const dy = Math.min(Math.abs(y2 - 0), Math.abs(y2 - pitch.height));
  return Math.max(0, Math.min(dx, dy));
}

// A landing point strictly beyond the pitch rectangle is out of play as a matter
// of geometry (a ball crossing the line). Coordinates are meter audit input.
function isOutOfPitch(x2, y2, pitch) {
  return x2 < 0 || x2 > pitch.width || y2 < 0 || y2 > pitch.height;
}

// 出界 detail 值（引擎直出，P21 D1）。
const OUT_DETAILS = ['out_sideline', 'out_goal_line'];

// 出界边枚举（引擎直出，P27 D2）：goal_line 底线 / sideline 边线。
const OUT_SIDES = ['goal_line', 'sideline'];

// Out-of-play evidence for a pass, in priority order (P27 D4 — 迁移自 P21 D1):
//   1. `result === 'out'` — the engine's REAL signal 现在显式声明出界（P27 起
//      emit_pass_out_play_slot / 普通传球出界 / 头球解围出界 都发 result="out"）。
//   2. `out_side` 存在 — 新字段兜底（阶段 2/3 若先带 out_side 再迁 result 的中间态）。
//   3. `detail === 'out_sideline' | 'out_goal_line'` — P21 兼容分支。旧 bundle（本 change
//      之前的引擎输出 / 落盘旧 fixture）只带 result:"contested" + detail + 钳制坐标，
//      几何看不出，必须靠这条分支仍判出界。
//   4. geometric evidence: landing strictly beyond the pitch rectangle — defensive branch;
//      usually unreachable after clamp01, but kept for non-clamped inputs.
// A near-boundary-but-inside landing is NOT out-of-play evidence (it may just be a risky
// pass that stayed in). 注意 `out_pos` **不是**判据——它只是「球实际飞出多远」的几何证据字段。
function outEvidenceOf(event, profile) {
  if (event.result === 'out') return 'event.result';
  // 与 outReasonOf 用同一枚举判据（不是「任意字符串」）——否则 out_side:'' / 非法值会让
  // 证据源与原因不一致（evidence='event.out_side' 但 reason 落到兜底）。
  if (OUT_SIDES.includes(event.out_side)) return 'event.out_side';
  if (OUT_DETAILS.includes(event.detail)) return 'event.detail';
  if (
    typeof event.x2 === 'number' &&
    typeof event.y2 === 'number' &&
    isOutOfPitch(event.x2, event.y2, profile.pitch)
  ) {
    return 'landing_out_of_bounds';
  }
  return null;
}

// 出界原因（P27 D4）：由证据源推导，优先用新字段 out_side（语义最明确），旧 bundle 回退 detail。
// 两个调用点都在 `outEvidence !== null` 之后，而本函数与 outEvidenceOf 用的是同一组判据，
// 所以两支必命中其一——最后两支只是防御性兜底（若将来有人单独改了一侧的判据，这里不会返回
// undefined 而是给出一个可读值）。
function outReasonOf(event, outEvidence) {
  if (OUT_SIDES.includes(event.out_side)) return event.out_side;
  if (OUT_DETAILS.includes(event.detail)) return event.detail;
  if (outEvidence === 'landing_out_of_bounds') return 'out_of_bounds_landing';
  return 'no_pressure_out';
}

export function detectUnforcedOut(events, profile) {
  const findings = [];
  const threshold = profile.unforced_out.pressure_distance;
  for (const event of events) {
    if (event.type !== 'pass') continue;

    const hasLanding = typeof event.x2 === 'number' && typeof event.y2 === 'number';
    const outEvidence = outEvidenceOf(event, profile);
    const base = {
      detector_id: 'unforced_out',
      event_index: event.index,
      match_time: event.t ?? null,
      entity_id: null,
    };
    const markedBase = { out_evidence: outEvidence, out_reason: outReasonOf(event, outEvidence) };

    const excluded = exclusionTokensOf(event);

    if (!outEvidence) {
      // Excluded pass with no out evidence (P21 D2): a corner/throw_in/free_kick/clearance is a
      // dead-ball restart or a deliberate clearance — not an unforced-out candidate at all, so
      // no finding. It still shows up in `pass_outcomes.excluded`. This branch MUST come before
      // the near-boundary check: otherwise an excluded pass landing near a line gets reported as
      // "cannot prove an out event", mislabelling a corner as a doubtful out (and, if handled by
      // emitting an exclusion finding instead, would add one noise `unknown` per restart).
      if (excluded.length > 0) continue;
      // Not recorded out and the landing is inside the pitch. A landing close to
      // the boundary is ambiguous: cannot prove an out event -> unknown.
      if (
        hasLanding &&
        distanceToBoundary(event.x2, event.y2, profile.pitch) <
          profile.unforced_out.boundary_margin
      ) {
        findings.push({
          ...base,
          id: `unforced_out:${event.index}`,
          severity: 'unknown',
          reason: 'pass lands near boundary but result is not out; cannot prove an out event',
          features: {
            landing_x: event.x2,
            landing_y: event.y2,
            boundary_distance: round3(distanceToBoundary(event.x2, event.y2, profile.pitch)),
            pass_distance: event.pass_distance ?? null,
          },
          thresholds: { boundary_margin: profile.unforced_out.boundary_margin },
        });
      }
      continue;
    }

    // Excluded pass that ALSO has out evidence: report the exclusion explicitly (compat with the
    // pre-P21 synthetic fixtures that assert an `excluded: <key>` finding). The common real-data
    // case is the branch above, which stays quiet.
    if (excluded.length > 0) {
      findings.push({
        ...base,
        id: `unforced_out:${event.index}`,
        severity: 'unknown',
        reason: `excluded: ${excluded.join(',')}`,
        features: markedBase,
        thresholds: {},
      });
      continue;
    }

    if (typeof event.nearest_defender_distance !== 'number') {
      findings.push({
        ...base,
        id: `unforced_out:${event.index}`,
        severity: 'unknown',
        reason: 'cannot prove pass-out pressure context (nearest_defender_distance missing)',
        features: markedBase,
        thresholds: {},
      });
      continue;
    }
    if (event.nearest_defender_distance > threshold) {
      const features = {
        out_evidence: outEvidence,
        out_reason: outReasonOf(event, outEvidence),
        pass_distance: event.pass_distance ?? null,
        defender_distance: event.nearest_defender_distance,
        pressure_level: 'none',
        sample_count: 1,
      };
      // Boundary distance is computable whenever the landing point is present.
      if (hasLanding) {
        features.boundary_distance = round3(
          distanceToBoundary(event.x2, event.y2, profile.pitch)
        );
      }
      findings.push({
        ...base,
        id: `unforced_out:${event.index}`,
        severity: 'realism_warning',
        features,
        thresholds: { pressure_distance: threshold },
      });
    }
  }
  return findings;
}

// --- inactive_responsibility ------------------------------------------------

// Split a responsibility-gated contiguous run into findings. A run is a maximal
// sequence of snapshots where (a) responsibility is active, (b) consecutive
// positions are within the stationary epsilon. Runs shorter than the profile
// static_duration, or disqualified (dead ball / gk fixed / formation hold / any
// movement toward goal or ball), produce no finding.
function inactiveRuns(sorted, profile) {
  const cfg = profile.inactive_responsibility;
  const runs = [];
  let start = null;
  for (let i = 0; i < sorted.length; i++) {
    const active = RESPONSIBILITY_TRIGGERS.includes(sorted[i].responsibility);
    if (!active) {
      if (start !== null) {
        runs.push([start, i - 1]);
        start = null;
      }
      continue;
    }
    if (start === null) {
      start = i;
    } else if (distance(sorted[i - 1], sorted[i]) >= cfg.stationary_epsilon) {
      runs.push([start, i - 1]);
      start = i;
    }
  }
  if (start !== null) runs.push([start, sorted.length - 1]);
  return runs;
}

export function detectInactiveResponsibility(players, profile) {
  const findings = [];
  const cfg = profile.inactive_responsibility;
  for (const [rawId, snapshots] of Object.entries(players ?? {})) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) continue;
    // Object.entries stringifies numeric keys; preserve the original id type so a
    // viewer-derived numeric player id stays numeric in the finding.
    const entityId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const sorted = [...snapshots].sort((a, b) => a.t - b.t);

    const hasTrigger = sorted.some((s) => RESPONSIBILITY_TRIGGERS.includes(s.responsibility));
    if (!hasTrigger) {
      findings.push({
        id: `inactive_responsibility:${entityId}`,
        detector_id: 'inactive_responsibility',
        entity_id: entityId,
        match_time: sorted[0].t,
        event_index: null,
        severity: 'unknown',
        reason: 'no responsibility-trigger evidence for player',
        features: {},
        thresholds: {},
      });
      continue;
    }

    for (const [from, to] of inactiveRuns(sorted, profile)) {
      const run = sorted.slice(from, to + 1);
      // P21 D5/K3：此前还判 `formation_hold === true`，但该字段没有任何生产者（引擎内部
      // 决策事实、viewer 不可观测、derive 层不推导）——那句永远是 false，是死代码，删掉。
      // 引擎内部事实无从观测这件事由 done 判定（is_gk / dead_ball / moved_toward_*）+ 责任
      // 触发器共同兜住；契约清单把它登记为 known gap（issue #28）。
      const disqualified = run.some((s) => s.dead_ball === true || s.is_gk === true);
      if (disqualified) continue;
      const moved = run.some(
        (s) => s.moved_toward_goal === true || s.moved_toward_ball === true
      );
      if (moved) continue;
      const start = run[0];
      const end = run[run.length - 1];
      const staticDuration = end.t - start.t;
      if (staticDuration < cfg.static_duration) continue;
      findings.push({
        id: `inactive_responsibility:${entityId}:${start.t}`,
        detector_id: 'inactive_responsibility',
        entity_id: entityId,
        match_time: start.t,
        event_index: null,
        severity: 'realism_warning',
        features: {
          start_time: start.t,
          end_time: end.t,
          static_duration: round3(staticDuration),
          responsibility_trigger: start.responsibility,
          responsibility_source: start.responsibility_source ?? null,
        },
        thresholds: { static_duration: cfg.static_duration },
      });
    }
  }
  return findings;
}

// --- player_overlap ----------------------------------------------------------

// 同队判定（P26 D1）：audit_input.players 的快照字段只有 is_gk/t/x/y，**没有 team**，
// 只能按 id 范围推——与 viewer/derive-audit-features.js 的 teamOf 同一口径（0-10 home /
// 11-21 away）。derive 层还会优先读 lineup 覆盖，detector 侧拿不到 lineup，故用纯 id 范围。
// 范围外的 id（>21 或负数）不属任何队 → 不参与重叠判定。
function teamOfPlayerId(playerId) {
  if (typeof playerId !== 'number' || !Number.isInteger(playerId)) return null;
  if (playerId >= 0 && playerId <= 10) return 'home';
  if (playerId >= 11 && playerId <= 21) return 'away';
  return null;
}

// 原始快照 → 数值点 `{ t, x, y }`；样本不可用（非对象 / t 非有限 / 坐标非有限）返回 null。
//
// 为什么单独抽成函数（不只是为复用）：**这是本 detector 唯一读取原始快照字段的地方**。
// 契约漂移守卫的源码扫描器只把「从已知 audit_input 容器（events/players/sorted/snaps/run）
// 绑定的循环变量」当输入基变量，其余靠调用点传播；所以这里的形参必须叫 `snapshot` 且由
// `for (const snapshot of snaps)` 这种容器循环调用，扫描器才看得见 t/x/y 的读取。若改成在
// 配对循环里读 `a.byT.get(t).x`，变量来自 Map 查找、扫描器看不见——落在不可达分支里的
// 未声明读取会同时逃过源码扫描与行为 Proxy（审阅实测：`if (false) { void sa.zz_x }` 全绿）。
//
// 只收**有限**的 t/x/y：NaN/Infinity 不是可对齐的采样时刻、也不是可用位置。放 NaN t 进来会让
// 该球员的 t 序列排序错乱，并与另一名球员的 NaN 键「对齐」出一条 match_time 为 null 的假
// finding（自测发现）；坐标非有限则 distance 变 NaN，`NaN < threshold` 恒 false 所以不会直接
// 造 finding，但该球员会因「有可用采样点」进入花名册、把 statsFor 的样本分母算进去——
// 与 t 是同一类「无效样本不得计入」的问题，所以一并在这里挡掉。
// t 是采样时刻、不是位置，跳过它不等于「拿缺失位置当原点」。
// 导出供测试钉住**返回形状**（副本只许有 t/x/y）：契约守卫看不见经 Map 取得的变量上的读取，
// 若给副本加了字段又在配对循环里读，守卫会静默失明——这条测试把那个盲区补成「加字段即红」。
export function snapshotPoint(snapshot) {
  if (!snapshot) return null;
  const { t, x, y } = snapshot;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  return { t, x, y };
}

// 有快照的同队球员花名册：{ home: [{playerId, byT}], away: [...] }，byT 是 t → **数值点**。
// detector 与 runAudit 的样本量口径共用这一处枚举（避免两处各自算 pair 造成漂移）。
// 没有任何可用采样点的球员不进花名册——它不构成可评估的 pair 候选。
//
// 存数值点而非原始快照：配对阶段只能通过 Map 查找拿到样本，那种变量无法被源码扫描器识别
// 为输入基变量；只读**本函数造出来的副本键**（t/x/y），就不可能构成「读了 audit_input 里
// 没有的字段」这类漂移——漂移风险全部收敛在上面那处容器循环里。
function sameTeamRoster(players) {
  const roster = { home: [], away: [] };
  const seen = new Set();
  for (const [rawId, snaps] of Object.entries(players ?? {})) {
    if (!Array.isArray(snaps) || snaps.length === 0) continue;
    // Object.entries 会把数字键字符串化；保留数值 id 以便按 id 范围判队并保证输出稳定。
    const playerId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const team = teamOfPlayerId(playerId);
    if (!team) continue;
    // 规范化后同 id 的第二个键（`4` 与 `04`）会让同一名球员入册两次 → 自配对 finding
    // （entity_id "4,4"）。derive 层只按数值 id 写键、产不出这种输入，这里只是防御性去重。
    if (seen.has(playerId)) continue;
    const byT = new Map();
    for (const snapshot of snaps) {
      const point = snapshotPoint(snapshot);
      if (point) byT.set(point.t, point);
    }
    if (byT.size > 0) {
      // 只在**真的入册**后记名：否则一个「键在但采样点全不可用」的重复键会把后面那个
      // 有有效快照的同 id 键挤掉，白丢一名球员。
      seen.add(playerId);
      roster[team].push({ playerId, byT });
    }
  }
  roster.home.sort((x, y) => x.playerId - y.playerId);
  roster.away.sort((x, y) => x.playerId - y.playerId);
  return roster;
}

// 候选单元 = 同队球员对（C(n,2)）。statsFor 的 samples 用这个口径：告警率 =
// 越界的同队 pair 数 / 全部同队 pair 数。
function sameTeamPairCount(roster) {
  const pairs = (list) => (list.length * (list.length - 1)) / 2;
  return pairs(roster.home) + pairs(roster.away);
}

// 同队间距 detector（P26 / issue #35 的 detector 部分）。
//
// 判定：同队两球员在观察窗口内**任一采样点**间距 < profile.player_overlap.min_distance
// （严格 `<`，恰等于阈值不算）→ 该 pair 产出一条 realism_warning。
//   - 按 pair 聚合（D2）：逐采样点报会刷屏（实测阈值 2m 下每窗口可报 10/17/1 对），
//     所以一个 pair 只报一条，match_time 取**首次越界**时刻，features 带窗口内**最小**间距。
//   - severity = realism_warning（D3）：站位重叠是观感问题，不是硬规则违反（区别于
//     baseline_invariant 的 invariant_violation）。#53 修引擎间距后这些 finding 应归零。
//   - t 对齐（D6）：按 pair 内一方（id 较小者）的 t 序列升序遍历；另一方在该 t 无快照
//     则跳过该 t——不拿缺失位置当原点，避免造出假重叠。同理，坐标非有限数也跳过。
export function detectPlayerOverlap(players, profile) {
  const threshold = profile.player_overlap.min_distance;
  const roster = sameTeamRoster(players);
  const findings = [];

  for (const team of ['home', 'away']) {
    const members = roster[team];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        let minDistance = Infinity;
        let firstBreach = null;
        let breachSamples = 0;
        let alignedSamples = 0;
        for (const t of [...a.byT.keys()].sort((x, y) => x - y)) {
          // sa/sb 是 sameTeamRoster 造的数值点副本（见那里的注释）：这两处 .x/.y 不是
          // audit_input 字段读取，字段读取已经全部收在 snapshotPoint 的容器循环里。
          const sa = a.byT.get(t);
          const sb = b.byT.get(t);
          if (!sb) continue;
          alignedSamples += 1;
          const dist = Math.hypot(sa.x - sb.x, sa.y - sb.y);
          if (dist < minDistance) minDistance = dist;
          if (dist < threshold) {
            breachSamples += 1;
            if (firstBreach === null) firstBreach = t;
          }
        }
        if (firstBreach === null) continue;
        findings.push({
          id: `player_overlap:${a.playerId}:${b.playerId}`,
          detector_id: 'player_overlap',
          // 重叠是快照层面的事实，没有单个事件可指——锚在 entity_id（两名球员）上。
          event_index: null,
          match_time: firstBreach,
          entity_id: `${a.playerId},${b.playerId}`,
          severity: 'realism_warning',
          reason:
            `same-team players ${a.playerId} and ${b.playerId} closed to ` +
            `${round3(minDistance)}m (< ${threshold}m)`,
          features: {
            player_ids: [a.playerId, b.playerId],
            team,
            min_distance: round3(minDistance),
            first_breach_time: firstBreach,
            breach_samples: breachSamples,
            aligned_samples: alignedSamples,
          },
          thresholds: { min_distance: threshold },
        });
      }
    }
  }
  return findings;
}

// --- pass outcome / pressure buckets -----------------------------------------

// Classify a single pass's outcome from observable evidence, reusing the same
// out-evidence contract as unforced_out (P21 D1) so the two never drift: detail
// out_* (the engine's real signal) / explicit result==='out' / geometric out are
// all `out`; success/complete is a success; **intercepted/lost 是 P32 起新增识别的
// 引擎直出结果**（此前落到 unknown_outcome——拦截/传失是真实结果，不是「未知」）。
// 其余/缺失仍归 unknown_outcome（不猜）。
//
// 注：`intercepted` 事件的 x2/y2 是**拦截者实际位置**、不是意图落点（见 grill 复核）。
// 本函数只用 result 字符串判结果，不碰坐标——不需要意图落点重建。
function classifyPassOutcome(event, profile) {
  if (outEvidenceOf(event, profile) !== null) return 'out';
  if (event.result === 'success' || event.result === 'complete') return 'success';
  if (event.result === 'intercepted') return 'intercepted';
  if (event.result === 'lost') return 'lost';
  return 'unknown_outcome';
}

// Bucket ordinary passes by pressure context (using the unforced_out pressure
// threshold and the event's nearest_defender_distance) and by outcome. Tactical/
// dead-ball pass contexts are excluded from the ordinary-pass buckets, matching
// the unforced_out exclusion contract (detail set + legacy boolean keys).
// Missing pressure evidence lands in `unknown_pressure` — never fabricated.
// 导出供契约漂移守卫逐条目断言：pass_outcomes 不是 detector，但和 unforced_out 共享
// 出界/排除位契约，守卫要把它当独立条目归属读键（否则它的 legacy_reads 会成为盲区）。
// P32（#36）D3：软分层。在 pressure×outcome 分桶之外，按**高球 / 长传 / 重开类型**再分层，
// 用于复现或否定 issue body 的「高球标记率 85%」经验症状——**不参与告警升级**（不是 detector，
// 不产 finding、不进 band）。每层只记 sample/out/success/intercepted/unknown_outcome 计数。
//
// 分层判据（各自独立，一条 pass 可同时落入多层）：
//   - high_ball / low_ball：`h > 0` 与否。引擎 `pass_h`：>20m 才 h>0（`engine/src/lib.rs`）。
//     **h 缺失 → unknown_h**（不并入 low_ball：真实引擎每条 pass 都带 h，缺失只出现在旧
//     bundle/合成输入；把「不知道」算成低球会让 high_ball 率系统性偏低——恰是「复现 85%
//     高球」用途最敏感的方向。与 unknown_pressure 同一「不伪造」原则，审阅 P3-7）。
//   - long_pass：`pass_distance > LONG_PASS_M`（22m，与引擎常量同值）。`pass_distance` 缺失
//     的样本不进 long_pass/short_pass 任一层（无法判定，不猜）。
//   - restart_type / open_play：`detail ∈ EXCLUSION_DETAILS`（corner/throw_in/free_kick/
//     clearance）为重开/解围；其余为开放比赛。注意这与 `excluded` 计数**同源**（同一排除契约）。
const LONG_PASS_M = 22.0;

// 单层计数器（与 pressure bucket 同形 + intercepted 计数——P32 新增：入网/拦截的区分是
// 「预期 vs 实际拦截率」的基础，但此处只作软参考）。
const emptyStratum = () => ({
  sample_count: 0, out_count: 0, success_count: 0, intercepted_count: 0, lost_count: 0, unknown_outcome_count: 0,
});

function tallyStratum(stratum, outcome) {
  stratum.sample_count += 1;
  if (outcome === 'out') stratum.out_count += 1;
  else if (outcome === 'success') stratum.success_count += 1;
  else if (outcome === 'intercepted') stratum.intercepted_count += 1;
  else if (outcome === 'lost') stratum.lost_count += 1;
  else stratum.unknown_outcome_count += 1;
}

// 重开/解围类型（detail 值）→ 分层键；未知 detail 归入 open_play。
// **直接引用 EXCLUSION_DETAILS**（不是拷贝字面量）：两者语义就是同一排除契约，引用同一数组
// 才能避免将来改一处忘另一处而漂移（审阅 P3-6）。design D3 字面列了 `goal_kick`，但引擎
// 从不产 `detail:"goal_kick"`（门球开大脚是 `result:"contested"` 且无 detail，见引擎
// `emit_gk_pass`）——沿 EXCLUSION_DETAILS 是正确取舍，已在 design 偏离处记录。
const RESTART_DETAILS = EXCLUSION_DETAILS;

export function computePassOutcomes(events, profile) {
  const buckets = {
    unpressured: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
    pressured: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
    unknown_pressure: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
  };
  const strata = {
    high_ball: emptyStratum(),
    low_ball: emptyStratum(),
    unknown_h: emptyStratum(),
    long_pass: emptyStratum(),
    short_pass: emptyStratum(),
    restart_type: emptyStratum(),
    open_play: emptyStratum(),
  };
  let excluded = 0;
  const threshold = profile.unforced_out.pressure_distance;
  for (const event of events ?? []) {
    if (event.type !== 'pass') continue;
    // 分层（软参考）在**排除判定之前**累计：重开/解围也要进 restart_type 层（否则「重开
    // 类型分层」在排除后为空）。高球/长传层则与排除无关（任何 pass 都可分层）。
    const outcome = classifyPassOutcome(event, profile);
    // 高球：h 是引擎直出的球高度（>20m 才 >0）。h 缺失 → unknown_h（不伪造，见上方注释）。
    let hStratum;
    if (typeof event.h !== 'number') hStratum = strata.unknown_h;
    else if (event.h > 0) hStratum = strata.high_ball;
    else hStratum = strata.low_ball;
    tallyStratum(hStratum, outcome);
    if (typeof event.pass_distance === 'number') {
      tallyStratum(event.pass_distance > LONG_PASS_M ? strata.long_pass : strata.short_pass, outcome);
    }
    tallyStratum(
      RESTART_DETAILS.includes(event.detail) ? strata.restart_type : strata.open_play,
      outcome
    );

    if (exclusionTokensOf(event).length > 0) {
      excluded += 1;
      continue;
    }
    let bucket;
    if (typeof event.nearest_defender_distance === 'number') {
      bucket = event.nearest_defender_distance > threshold ? 'unpressured' : 'pressured';
    } else {
      bucket = 'unknown_pressure';
    }
    buckets[bucket].sample_count += 1;
    if (outcome === 'out') buckets[bucket].out_count += 1;
    else if (outcome === 'success') buckets[bucket].success_count += 1;
    else buckets[bucket].unknown_outcome_count += 1;
  }
  return {
    unpressured: buckets.unpressured,
    pressured: buckets.pressured,
    unknown_pressure: buckets.unknown_pressure,
    excluded: { sample_count: excluded },
    strata,
  };
}

// --- stats + aggregation ----------------------------------------------------

// Per-detector statistics for aggregation. `samples` is the count of candidate
// units the detector evaluated (pass events / players with snapshots / events),
// independent of whether each produced a finding.
function statsFor(detectorId, samples, findings) {
  const unknown = findings.filter((f) => f.severity === 'unknown');
  const reasons = {};
  for (const f of unknown) {
    const r = f.reason ?? 'unknown';
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  return {
    detector_id: detectorId,
    samples,
    determinate: findings.length - unknown.length,
    unknown: unknown.length,
    unknown_reasons: reasons,
  };
}

// 提示：旧 bundle（本 change 之前用旧 viewer 采集的）没有版本号。设计上必须**响亮失败**
// 而不是拿陈旧形状的数据静默审计（那正是字段断裂潜伏的机制）。给一句可操作的补救话，
// 免得只看到一句版本号对不上。
const AUDIT_INPUT_VERSION_HINT =
  're-capture the observation with the current viewer (older bundles predate the versioned audit_input)';

export function runAudit(input, profile = DEFAULT_AUDIT_PROFILE) {
  // P21 D6：audit_input 必须携带已知 schema_version。缺失/未知 → 抛错，而不是按默认
  // 静默继续——静默正是字段断裂能潜伏几个月的原因（detector 读空字段、输出全 unknown）。
  const version = input?.schema_version;
  if (version === undefined) {
    throw new Error(
      `audit_input is missing schema_version (expected "${AUDIT_INPUT_SCHEMA_VERSION}"): ` +
        AUDIT_INPUT_VERSION_HINT
    );
  }
  if (version !== AUDIT_INPUT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported audit_input schema_version ${JSON.stringify(version)} ` +
        `(expected "${AUDIT_INPUT_SCHEMA_VERSION}"): ${AUDIT_INPUT_VERSION_HINT}`
    );
  }

  // P21：容器形状也 fail-loud。此前 `Array.isArray(events) ? ... : []` 会把 events 缺失 /
  // null / 非数组静默当成空数组，audit 出全零结果——「静默 = 断裂潜伏」正是本 change 的
  // 立项理由（同一个 runAudit 的版本门就是为此 fail-loud）。audit_input 的负载容器必须
  // 是 events: 数组、players: 对象，否则拒绝。
  const events = input?.events;
  const players = input?.players;
  if (!Array.isArray(events)) {
    throw new Error(
      `audit_input.events must be an array (got ${events === null ? 'null' : typeof events})`
    );
  }
  if (players === null || typeof players !== 'object' || Array.isArray(players)) {
    throw new Error(`audit_input.players must be an object (got ${Array.isArray(players) ? 'array' : typeof players})`);
  }

  const invariantFindings = detectInvariants(events, players, profile);
  const unforcedFindings = detectUnforcedOut(events, profile);
  const inactiveFindings = detectInactiveResponsibility(players, profile);
  const overlapFindings = detectPlayerOverlap(players, profile);

  const findings = [
    ...invariantFindings,
    ...unforcedFindings,
    ...inactiveFindings,
    ...overlapFindings,
  ].map((f) => ({ ...f, profile_id: profile.id, profile_version: profile.version }));

  // P21 D4：未标定 detector（calibrated:false）的告警带 calibrated:false 出厂，聚合层据此
  // 降级。标记按 detector 逐条加上，保证「未标定」这件事跟着 finding 走，不靠调用方记住。
  for (const f of findings) {
    if (isUncalibrated(f.detector_id, profile)) f.calibrated = false;
  }

  const stats = [
    statsFor('baseline_invariant', events.length, invariantFindings),
    statsFor(
      'unforced_out',
      events.filter((e) => e.type === 'pass').length,
      unforcedFindings
    ),
    statsFor(
      'inactive_responsibility',
      Object.values(players).filter((v) => Array.isArray(v)).length,
      inactiveFindings
    ),
    // 样本口径 = 同队球员对（C(n,2)），与 detectPlayerOverlap 内部枚举候选 pair 的方式
    // 共用 sameTeamRoster，避免两处各自算 n 造成 stats 与 finding 口径漂移。
    statsFor('player_overlap', sameTeamPairCount(sameTeamRoster(players)), overlapFindings),
  ];

  return {
    profile: { id: profile.id, version: profile.version },
    findings,
    stats,
    pass_outcomes: computePassOutcomes(events, profile),
  };
}

// Merge per-audit pass outcome buckets across seeds and derive out/success rates.
// Deterministic: fixed bucket order, counts summed, rates rounded to 3dp.
function mergePassOutcomes(list) {
  const out = {};
  let totalOrdinary = 0;
  for (const key of ['unpressured', 'pressured', 'unknown_pressure', 'excluded']) {
    let sample_count = 0;
    let out_count = 0;
    let success_count = 0;
    let unknown_outcome_count = 0;
    for (const audit of list) {
      const bucket = audit?.pass_outcomes?.[key];
      if (!bucket) continue;
      sample_count += bucket.sample_count ?? 0;
      out_count += bucket.out_count ?? 0;
      success_count += bucket.success_count ?? 0;
      unknown_outcome_count += bucket.unknown_outcome_count ?? 0;
    }
    if (key === 'excluded') {
      out.excluded = { sample_count };
      continue;
    }
    out[key] = {
      sample_count,
      out_count,
      out_rate: sample_count > 0 ? round3(out_count / sample_count) : null,
      success_count,
      success_rate: sample_count > 0 ? round3(success_count / sample_count) : null,
      unknown_outcome_count,
    };
    totalOrdinary += sample_count;
  }
  out.total_ordinary_passes = totalOrdinary;
  // P32（#36）D3：软分层合并——**只加不减**，不改上面四个既有键。分层键固定（顺序稳定），
  // 缺失层按零计（旧 audit 报告无 strata → 零，不崩）。不参与 band/告警。
  const STRATA_KEYS = ['high_ball', 'low_ball', 'unknown_h', 'long_pass', 'short_pass', 'restart_type', 'open_play'];
  out.strata = {};
  for (const key of STRATA_KEYS) {
    let sample_count = 0, out_count = 0, success_count = 0, intercepted_count = 0, lost_count = 0, unknown_outcome_count = 0;
    for (const audit of list) {
      // 变量名不用单字母 `s`：契约漂移守卫的源码扫描器把 `s` 当作输入基变量（fallback 名），
      // 会把 `s.sample_count` 误判成「读了未声明的 audit_input 字段」。用 `stratumPart`
      // 避开该启发式，无需给白名单开口子。
      const stratumPart = audit?.pass_outcomes?.strata?.[key];
      if (!stratumPart) continue;
      sample_count += stratumPart.sample_count ?? 0;
      out_count += stratumPart.out_count ?? 0;
      success_count += stratumPart.success_count ?? 0;
      intercepted_count += stratumPart.intercepted_count ?? 0;
      lost_count += stratumPart.lost_count ?? 0;
      unknown_outcome_count += stratumPart.unknown_outcome_count ?? 0;
    }
    out.strata[key] = {
      sample_count,
      out_count,
      success_count,
      intercepted_count,
      lost_count,
      unknown_outcome_count,
      // 高球标记率（issue body 的「85%」症状对照）等比率由消费方按样本自算；此处只给计数。
    };
  }
  return out;
}

// Aggregate detector metrics across multiple deterministic replays (seeds).
// Reports sample counts, anomaly counts/rates, reference bands/thresholds,
// aggregated unknown reasons, and ordinary-pass outcome/pressure buckets.
// `referenceBands` may override the profile's bands (e.g. a calibrated
// real-match band) at aggregation time.
export function aggregateAudit(
  audits,
  { profile = DEFAULT_AUDIT_PROFILE, referenceBands = null } = {}
) {
  const list = Array.isArray(audits) ? audits : [];

  const ids = [];
  const seen = new Set();
  for (const audit of list) {
    for (const stat of audit?.stats ?? []) {
      if (!seen.has(stat.detector_id)) {
        seen.add(stat.detector_id);
        ids.push(stat.detector_id);
      }
    }
  }
  ids.sort();

  const detectors = [];
  for (const id of ids) {
    let samples = 0;
    let unknown = 0;
    const unknownReasons = {};
    const severities = {};
    for (const audit of list) {
      const stat = (audit?.stats ?? []).find((s) => s.detector_id === id);
      if (stat) {
        samples += stat.samples;
        unknown += stat.unknown;
        for (const [reason, count] of Object.entries(stat.unknown_reasons)) {
          unknownReasons[reason] = (unknownReasons[reason] ?? 0) + count;
        }
      }
      for (const f of audit?.findings ?? []) {
        if (f.detector_id !== id || f.severity === 'unknown') continue;
        severities[f.severity] = (severities[f.severity] ?? 0) + 1;
      }
    }
    const anomalyCount =
      (severities.realism_warning ?? 0) +
      (severities.realism_failure ?? 0) +
      (severities.invariant_violation ?? 0);
    const rate = samples > 0 ? round3(anomalyCount / samples) : null;

    const band =
      (referenceBands && referenceBands[id]) ||
      profile.aggregation?.reference_bands?.[id] ||
      null;

    // P21 D4：未标定 detector 的告警不参与 band 升级——band 是「真实比赛标定过的参考区间」
    // 概念，拿未标定的 detector 去比会产出不可信的 realism_failure。这里只降级、不隐藏：
    // anomaly_count/rate 照常计入，摘要额外带 calibration:'uncalibrated' 供报告层识别。
    const calibrated = !isUncalibrated(id, profile);

    let bandState = null;
    // Aggregate severity is about anomalies. No samples -> unknown (no data);
    // samples but zero anomalies -> null (clean, nothing to report); anomalies
    // present -> realism_warning unless a calibrated band is exceeded, which
    // escalates to realism_failure.
    let aggregateSeverity =
      samples === 0 ? 'unknown' : anomalyCount > 0 ? 'realism_warning' : null;
    if (calibrated && band && typeof band.max === 'number' && rate !== null) {
      if (rate > band.max) {
        bandState = 'above';
        aggregateSeverity = 'realism_failure';
      } else {
        bandState = 'within';
      }
    }

    const sortedReasons = Object.keys(unknownReasons).sort();
    const unknownSummary = {};
    for (const reason of sortedReasons) unknownSummary[reason] = unknownReasons[reason];

    detectors.push({
      detector_id: id,
      sample_count: samples,
      anomaly_count: anomalyCount,
      anomaly_rate: rate,
      severity_counts: Object.keys(severities).sort().reduce((acc, k) => {
        acc[k] = severities[k];
        return acc;
      }, {}),
      unknown_count: unknown,
      unknown_reasons: unknownSummary,
      reference_band: band
        ? {
            min: band.min ?? 0,
            max: band.max ?? null,
            source: band.source ?? 'profile',
            note: band.note ?? null,
          }
        : null,
      band_state: bandState,
      aggregate_severity: aggregateSeverity,
      // P21 D4：'uncalibrated' = 该 detector 的告警率尚无真实比赛标定，报告层不应把它
      // 当可信线索（如未标定的 player_overlap）。'calibrated' = 常规。
      calibration: calibrated ? 'calibrated' : 'uncalibrated',
    });
  }

  return {
    profile: { id: profile.id, version: profile.version },
    detectors,
    pass_outcomes: mergePassOutcomes(list),
  };
}
