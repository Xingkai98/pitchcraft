// Deterministic audit detectors.
//
// P10 vertical slice: unforced_out, inactive_responsibility,
// ignored_interception_opportunity, plus baseline invariants and multi-seed
// aggregation. Pure functions over fixture events/player snapshots. No WASM, no
// network, no Claude/API calls. When evidence cannot prove a conclusion, a
// detector emits an `unknown` finding with a reason instead of guessing.

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
  },
  pitch: { width: 105, height: 68 },
  inactive_responsibility: {
    // Seconds a responsible player may stay stationary before it is a finding.
    static_duration: 3.0,
    // Consecutive snapshots closer than this (meters) count as stationary.
    stationary_epsilon: 0.5,
  },
  ignored_interception: {
    // Defender's sprint speed (m/s) used to derive arrival time.
    defender_speed: 6.0,
    // Extra seconds a defender must arrive early to count as an opportunity.
    arrival_margin: 0.5,
    // P21 D4：本 detector 的告警率尚未用真实比赛标定（标定归 #36）。未标定 → 聚合层
    // 不因超出参考 band 升级为 realism_failure，也不把它当可信线索；仅降级静音。
    calibrated: false,
  },
  // Baseline invariant checks: things that must hold regardless of realism.
  invariants: {
    // Out-of-order tolerance for same-instant events (kickoff+whistle at t).
    time_order_epsilon: 1e-6,
    // Fraction of the pitch dimension a coordinate may legally exceed (a ball
    // that just crossed the line). Coordinates far beyond this are a bug.
    bounds_tolerance: 0.05,
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
      ignored_interception_opportunity: { min: 0, max: null, source: 'p10-mvp', note: 'no calibrated band; warnings are candidates' },
    },
  },
};

const RESPONSIBILITY_TRIGGERS = [
  'ball_entered_zone',
  'possession_transition',
  'defensive_line_moved',
];

// detector_id → profile 里对应配置块的键。两者并不总是同名（历史原因：detector 叫
// `ignored_interception_opportunity`，配置块叫 `ignored_interception`），所以显式映射，
// 别靠字符串拼。D4 的 calibrated 标记就靠它把 finding/detector 摘要挂回配置。
const DETECTOR_PROFILE_KEY = {
  baseline_invariant: 'invariants',
  unforced_out: 'unforced_out',
  inactive_responsibility: 'inactive_responsibility',
  ignored_interception_opportunity: 'ignored_interception',
};

const isUncalibrated = (detectorId, profile) =>
  profile?.[DETECTOR_PROFILE_KEY[detectorId]]?.calibrated === false;

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

// Out-of-play evidence for a pass, in priority order (P21 D1):
//   1. `detail === 'out_sideline' | 'out_goal_line'` — the engine's REAL signal. Real out
//      passes carry `result:"contested"` (no discrimination) + one of these details, and
//      their landing coords are clamp01'd back onto the line, so geometry cannot see it.
//   2. explicit `result === 'out'` — compatibility (old fixtures / a future explicit field).
//   3. geometric evidence: landing strictly beyond the pitch rectangle — defensive branch;
//      usually unreachable after clamp01, but kept for non-clamped inputs.
// A near-boundary-but-inside landing is NOT out-of-play evidence (it may just be a risky
// pass that stayed in).
function outEvidenceOf(event, profile) {
  if (OUT_DETAILS.includes(event.detail)) return 'event.detail';
  if (event.result === 'out') return 'event.result';
  if (
    typeof event.x2 === 'number' &&
    typeof event.y2 === 'number' &&
    isOutOfPitch(event.x2, event.y2, profile.pitch)
  ) {
    return 'landing_out_of_bounds';
  }
  return null;
}

// 出界原因（P21 D3）：不再读 `event.out_reason`（无人产），改由证据源推导。
function outReasonOf(event, outEvidence) {
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

    // Exclusion comes FIRST (P21 D2): a corner/throw_in/free_kick/clearance pass is a dead-ball
    // restart or a deliberate clearance, never an "unforced out" candidate — whether or not it
    // carried out evidence. Checking it only after the out-evidence gate used to let an excluded
    // pass with no out evidence fall into the near-boundary branch and be reported as
    // "cannot prove an out event", which mislabels it.
    const excluded = exclusionTokensOf(event);
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

    if (!outEvidence) {
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

// --- ignored_interception_opportunity ---------------------------------------

export function detectIgnoredInterception(events, profile) {
  const findings = [];
  const cfg = profile.ignored_interception;
  for (const event of events) {
    if (event.type !== 'pass') continue;
    const base = {
      detector_id: 'ignored_interception_opportunity',
      event_index: event.index,
      match_time: event.t ?? null,
      entity_id: event.defender_id ?? null,
    };
    const { corridor_distance, pass_distance, pass_speed } = event;
    if (
      typeof corridor_distance !== 'number' ||
      typeof pass_distance !== 'number' ||
      typeof pass_speed !== 'number'
    ) {
      findings.push({
        ...base,
        id: `ignored_interception_opportunity:${event.index}`,
        severity: 'unknown',
        reason: 'cannot prove interception corridor (corridor_distance/pass_distance/pass_speed missing)',
        features: {},
        thresholds: {},
      });
      continue;
    }
    const ballArrival = pass_distance / pass_speed;
    const defenderArrival = corridor_distance / cfg.defender_speed;
    if (
      defenderArrival + cfg.arrival_margin < ballArrival &&
      event.defender_moved_toward_corridor !== true
    ) {
      findings.push({
        ...base,
        id: `ignored_interception_opportunity:${event.index}`,
        severity: 'realism_warning',
        features: {
          corridor_distance,
          ball_arrival_time: round3(ballArrival),
          defender_arrival_time: round3(defenderArrival),
          actual_displacement: event.defender_moved_toward_corridor ? 'toward_corridor' : 'none',
        },
        thresholds: {
          defender_speed: cfg.defender_speed,
          arrival_margin: cfg.arrival_margin,
        },
      });
    }
  }
  return findings;
}

// --- pass outcome / pressure buckets -----------------------------------------

// Classify a single pass's outcome from observable evidence, reusing the same
// out-evidence contract as unforced_out (P21 D1) so the two never drift: detail
// out_* (the engine's real signal) / explicit result==='out' / geometric out are
// all `out`; success/complete is a success; anything else/missing is unknown.
function classifyPassOutcome(event, profile) {
  if (outEvidenceOf(event, profile) !== null) return 'out';
  if (event.result === 'success' || event.result === 'complete') return 'success';
  return 'unknown_outcome';
}

// Bucket ordinary passes by pressure context (using the unforced_out pressure
// threshold and the event's nearest_defender_distance) and by outcome. Tactical/
// dead-ball pass contexts are excluded from the ordinary-pass buckets, matching
// the unforced_out exclusion contract (detail set + legacy boolean keys).
// Missing pressure evidence lands in `unknown_pressure` — never fabricated.
function computePassOutcomes(events, profile) {
  const buckets = {
    unpressured: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
    pressured: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
    unknown_pressure: { sample_count: 0, out_count: 0, success_count: 0, unknown_outcome_count: 0 },
  };
  let excluded = 0;
  const threshold = profile.unforced_out.pressure_distance;
  for (const event of events ?? []) {
    if (event.type !== 'pass') continue;
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
    const outcome = classifyPassOutcome(event, profile);
    buckets[bucket].sample_count += 1;
    if (outcome === 'out') buckets[bucket].out_count += 1;
    else if (outcome === 'success') buckets[bucket].success_count += 1;
    else buckets[bucket].unknown_outcome_count += 1;
  }
  return { unpressured: buckets.unpressured, pressured: buckets.pressured, unknown_pressure: buckets.unknown_pressure, excluded: { sample_count: excluded } };
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

  const events = Array.isArray(input?.events) ? input.events : [];
  const players = input?.players ?? {};

  const invariantFindings = detectInvariants(events, players, profile);
  const unforcedFindings = detectUnforcedOut(events, profile);
  const inactiveFindings = detectInactiveResponsibility(players, profile);
  const interceptionFindings = detectIgnoredInterception(events, profile);

  const findings = [
    ...invariantFindings,
    ...unforcedFindings,
    ...inactiveFindings,
    ...interceptionFindings,
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
    statsFor(
      'ignored_interception_opportunity',
      events.filter((e) => e.type === 'pass').length,
      interceptionFindings
    ),
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
      // 当可信线索（ignored_interception）。'calibrated' = 常规。
      calibration: calibrated ? 'calibrated' : 'uncalibrated',
    });
  }

  return {
    profile: { id: profile.id, version: profile.version },
    detectors,
    pass_outcomes: mergePassOutcomes(list),
  };
}
