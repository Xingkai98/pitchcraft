import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_AUDIT_PROFILE,
  runAudit as runAuditRaw,
  aggregateAudit,
} from './detectors.mjs';
import { AUDIT_INPUT_SCHEMA_VERSION } from './detector-field-contract.mjs';

// P21 D6 之后 runAudit 要求 audit_input 带 schema_version。下面这些用例是手写的合成
// 事件/快照片段，补版本号是噪音——统一在这里注入，用例正文保持只描述被测字段。
// 版本门本身的行为由文件末尾的 `runAudit rejects ...` 用例用 runAuditRaw 直接覆盖。
const runAudit = (input = {}) =>
  runAuditRaw({ schema_version: AUDIT_INPUT_SCHEMA_VERSION, ...input });

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURE = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'real-audit-input.json'), 'utf8')
);
// 真实引擎采集链路产出的 audit_input 窗口（生成器见 tools/fixtures/generate-real-audit-fixture.mjs）。
const realWindow = (label) => {
  const w = REAL_FIXTURE.windows.find((x) => x.label === label);
  assert.ok(w, `fixture should contain a window labelled ${label}`);
  return w.audit_input;
};

test('runAudit flags an unforced ordinary pass out of play', () => {
  const input = {
    events: [
      {
        index: 10,
        t: 100,
        type: 'pass',
        result: 'out',
        nearest_defender_distance: 12.0,
        pass_distance: 25,
        target_distance: 20,
        contested: false,
        dead_ball: false,
        clearance: false,
        corner: false,
        throw_in: false,
        goal_kick: false,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1);
  assert.equal(unforced[0].severity, 'realism_warning');
  assert.equal(unforced[0].event_index, 10);
  assert.equal(unforced[0].features.defender_distance, 12.0);
  assert.equal(unforced[0].thresholds.pressure_distance, DEFAULT_AUDIT_PROFILE.unforced_out.pressure_distance);
});

test('every finding carries profile_id and profile_version', () => {
  const input = {
    events: [
      {
        index: 10,
        t: 100,
        type: 'pass',
        result: 'out',
        nearest_defender_distance: 12.0,
      },
    ],
    players: {
      home_4: [
        { t: 10, x: 5, y: 5, responsibility: 'ball_entered_zone' },
        { t: 13, x: 5.05, y: 5, responsibility: 'ball_entered_zone' },
      ],
    },
  };
  const { findings } = runAudit(input);
  assert.ok(findings.length >= 2);
  for (const f of findings) {
    assert.equal(f.profile_id, DEFAULT_AUDIT_PROFILE.id);
    assert.equal(f.profile_version, DEFAULT_AUDIT_PROFILE.version);
  }
});

test('runAudit reports unknown for a near-boundary pass with no explicit out evidence', () => {
  const input = {
    events: [
      {
        index: 30,
        t: 300,
        type: 'pass',
        result: 'complete',
        // Lands 2m from the right touchline (pitch width 105, margin 3.0).
        x2: 103,
        y2: 30,
        pass_distance: 20,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1);
  assert.equal(unforced[0].severity, 'unknown');
  assert.match(unforced[0].reason, /near boundary/);
  assert.equal(unforced[0].features.boundary_distance, 2);
});

test('runAudit ignores a pass landing well inside the pitch (not near boundary)', () => {
  const input = {
    events: [
      {
        index: 31,
        t: 310,
        type: 'pass',
        result: 'complete',
        x2: 50,
        y2: 30,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 0);
});

test('runAudit excludes a tactical clearance from unforced_out', () => {
  const input = {
    events: [
      {
        index: 11,
        t: 110,
        type: 'pass',
        result: 'out',
        nearest_defender_distance: 15.0,
        clearance: true,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1);
  assert.equal(unforced[0].severity, 'unknown');
  assert.match(unforced[0].reason, /excluded: clearance/);
});

test('runAudit reports unknown when pressure evidence is missing for an out', () => {
  const input = {
    events: [
      {
        index: 12,
        t: 120,
        type: 'pass',
        result: 'out',
        clearance: false,
        contested: null,
        dead_ball: null,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1);
  assert.equal(unforced[0].severity, 'unknown');
  assert.match(unforced[0].reason, /cannot prove pass-out pressure context/);
});

test('runAudit flags a geometric out-of-bounds landing as unforced_out realism_warning', () => {
  const input = {
    events: [
      {
        index: 40,
        t: 400,
        type: 'pass',
        result: 'success', // engine uses success; landing proves it went out
        x: 50,
        y: 30,
        x2: 105.5, // 0.5m past the right touchline
        y2: 30,
        nearest_defender_distance: 12.0,
        pass_distance: 60,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.equal(unforced[0].severity, 'realism_warning');
  assert.equal(unforced[0].features.out_evidence, 'landing_out_of_bounds');
  assert.equal(unforced[0].features.out_reason, 'out_of_bounds_landing');
  assert.equal(unforced[0].features.boundary_distance, 0.5);
});

test('runAudit reports unknown for a geometric out with no pressure evidence', () => {
  const input = {
    events: [
      {
        index: 41,
        t: 410,
        type: 'pass',
        result: 'success',
        x: 50,
        y: 30,
        x2: 105.5,
        y2: 30,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.equal(unforced[0].severity, 'unknown');
  assert.equal(unforced[0].features.out_evidence, 'landing_out_of_bounds');
  assert.match(unforced[0].reason, /cannot prove pass-out pressure context/);
});

test('runAudit keeps a near-boundary-but-inside non-out pass as unknown, not warning', () => {
  const input = {
    events: [
      {
        index: 42,
        t: 420,
        type: 'pass',
        result: 'success',
        x: 50,
        y: 30,
        x2: 103, // 2m inside the touchline (boundary_margin 3)
        y2: 30,
        nearest_defender_distance: 12.0,
        pass_distance: 55,
      },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.equal(unforced[0].severity, 'unknown');
  assert.match(unforced[0].reason, /near boundary/);
});

test('runAudit flags a responsibility-gated stationary defender', () => {
  const snap = (t, x, y, over = {}) => ({
    t,
    x,
    y,
    responsibility: 'ball_entered_zone',
    is_gk: false,
    formation_hold: false,
    dead_ball: false,
    moved_toward_goal: false,
    ...over,
  });
  const input = {
    players: {
      home_4: [snap(10, 5, 5), snap(11, 5.1, 5), snap(12, 5.05, 5), snap(13, 5.1, 5)],
    },
  };
  const { findings } = runAudit(input);
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility');
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].entity_id, 'home_4');
  assert.equal(inactive[0].severity, 'realism_warning');
  assert.equal(inactive[0].features.static_duration, 3);
});

test('runAudit no longer keys off formation_hold (dead code removed, K3)', () => {
  // P21 P2.6/K3：`formation_hold` 没有任何生产者（引擎内部事实、viewer 不可观测），
  // 此前 disqualified 判定里的 `s.formation_hold === true` 永远为 false。删掉后，只带
  // formation_hold 的球员不再被豁免——这是**故意的行为变化**：那条豁免过去只对合成
  // fixture 生效，对真实数据从未生效。防回潮由 detector-field-contract.test.mjs 的漂移
  // 守卫负责（formation_hold 已从 reads 移除，代码再读它会立刻报「未声明字段」）。
  const input = {
    players: {
      home_5: [
        { t: 10, x: 0, y: 0, responsibility: 'ball_entered_zone', formation_hold: true },
        { t: 14, x: 0.1, y: 0, responsibility: 'ball_entered_zone', formation_hold: true },
      ],
    },
  };
  const { findings } = runAudit(input);
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility');
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].severity, 'realism_warning');
});

test('runAudit reports unknown when no responsibility trigger is present', () => {
  const input = {
    players: {
      home_6: [
        { t: 10, x: 0, y: 0, responsibility: null },
        { t: 14, x: 0, y: 0, responsibility: null },
      ],
    },
  };
  const { findings } = runAudit(input);
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility');
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].severity, 'unknown');
  assert.match(inactive[0].reason, /no responsibility-trigger evidence/);
});

test('runAudit flags an ignored interception opportunity', () => {
  const input = {
    events: [
      {
        index: 20,
        t: 200,
        type: 'pass',
        result: 'complete',
        defender_id: 'away_3',
        corridor_distance: 2.0,
        pass_distance: 20,
        pass_speed: 10,
        defender_moved_toward_corridor: false,
      },
    ],
  };
  const { findings } = runAudit(input);
  const inter = findings.filter((f) => f.detector_id === 'ignored_interception_opportunity');
  assert.equal(inter.length, 1);
  assert.equal(inter[0].entity_id, 'away_3');
  assert.equal(inter[0].severity, 'realism_warning');
  // ball arrives in 2.0s; defender arrives in 2.0/6.0 = 0.333s + 0.5 margin < 2.0.
  assert.ok(inter[0].features.ball_arrival_time > inter[0].features.defender_arrival_time);
});

test('runAudit reports unknown when interception corridor evidence is missing', () => {
  const input = {
    events: [{ index: 21, t: 210, type: 'pass', result: 'complete', defender_id: 'away_3' }],
  };
  const { findings } = runAudit(input);
  const inter = findings.filter((f) => f.detector_id === 'ignored_interception_opportunity');
  assert.equal(inter.length, 1);
  assert.equal(inter[0].severity, 'unknown');
  assert.match(inter[0].reason, /cannot prove interception corridor/);
});

test('runAudit is deterministic across repeated runs of the same bundle', () => {
  const input = {
    events: [
      {
        index: 10,
        t: 100,
        type: 'pass',
        result: 'out',
        nearest_defender_distance: 12.0,
        pass_distance: 25,
      },
    ],
    players: {
      home_4: [
        { t: 10, x: 5, y: 5, responsibility: 'ball_entered_zone' },
        { t: 13, x: 5.05, y: 5, responsibility: 'ball_entered_zone' },
      ],
    },
  };
  const a = runAudit(input);
  const b = runAudit(input);
  assert.deepEqual(b, a);
});

test('runAudit sorts responsibility snapshots by time regardless of input order', () => {
  const input = {
    players: {
      home_4: [
        { t: 13, x: 5.05, y: 5, responsibility: 'ball_entered_zone' },
        { t: 10, x: 5, y: 5, responsibility: 'ball_entered_zone' },
      ],
    },
  };
  const { findings } = runAudit(input);
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility');
  assert.equal(inactive[0].features.static_duration, 3);
});

// --- baseline invariants (task 2.2) ----------------------------------------

test('runAudit flags a non-monotonic event time as invariant_violation', () => {
  const input = {
    events: [
      { index: 0, t: 100, type: 'pass' },
      { index: 1, t: 90, type: 'pass' },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].severity, 'invariant_violation');
  assert.match(inv[0].reason, /time regresses/);
});

test('runAudit flags a non-finite coordinate as invariant_violation', () => {
  const input = {
    events: [{ index: 0, t: 100, type: 'pass', x: NaN, y: 0.5 }],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].severity, 'invariant_violation');
  assert.match(inv[0].reason, /not a finite number/);
});

test('runAudit flags a coordinate far outside the pitch as invariant_violation', () => {
  const input = {
    events: [{ index: 0, t: 100, type: 'pass', x: 5, y: 9999 }],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].severity, 'invariant_violation');
  assert.match(inv[0].reason, /outside pitch/);
});

test('runAudit flags an out-of-bounds pass landing x2 as invariant_violation', () => {
  const input = {
    events: [
      { index: 1, t: 1, type: 'pass', x: 50, y: 30, x2: 10000, y2: 30, pass_distance: 10 },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].severity, 'invariant_violation');
  assert.match(inv[0].reason, /x2=10000/);
  assert.match(inv[0].reason, /outside pitch/);
  // Coordinate invariant findings must carry the source event index.
  assert.equal(inv[0].event_index, 1);
});

test('runAudit flags an out-of-bounds pass landing y2 as invariant_violation', () => {
  const input = {
    events: [
      { index: 2, t: 2, type: 'pass', x: 50, y: 30, x2: 80, y2: 9999, pass_distance: 10 },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].severity, 'invariant_violation');
  assert.match(inv[0].reason, /y2=9999/);
  assert.match(inv[0].reason, /outside pitch/);
  assert.equal(inv[0].event_index, 2);
});

test('runAudit does not flag in-bounds x2/y2 (landing coordinates are checked)', () => {
  const input = {
    events: [
      { index: 3, t: 3, type: 'pass', x: 50, y: 30, x2: 80, y2: 40, pass_distance: 40 },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 0, JSON.stringify(findings));
});

test('player coordinate invariants carry entity_id, not a null anchor', () => {
  const input = {
    players: {
      15: [{ t: 1, x: 50, y: 9999 }],
    },
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].entity_id, 15);
  assert.match(inv[0].reason, /player:15 y=9999/);
});

test('time-order invariant carries event_index even when events lack an explicit index', () => {
  const input = {
    events: [
      { t: 2, type: 'pass' },
      { t: 1, type: 'pass' },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].event_index, 1);
  assert.equal(inv[0].entity_id, null);
});

test('pass-distance invariant carries event_index even when the event lacks an explicit index', () => {
  const input = {
    events: [{ t: 1, type: 'pass', pass_distance: 0 }],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].event_index, 0);
});

test('pass-distance diagonal-exceeded invariant carries event_index', () => {
  const input = {
    events: [{ index: 9, t: 1, type: 'pass', pass_distance: 9999 }],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1, JSON.stringify(findings));
  assert.equal(inv[0].event_index, 9);
});

test('runAudit flags a non-positive pass_distance as invariant_violation', () => {
  const input = {
    events: [{ index: 0, t: 100, type: 'pass', pass_distance: 0 }],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].severity, 'invariant_violation');
});

test('runAudit does not flag a legal in-bounds bundle for invariants', () => {
  const input = {
    events: [
      { index: 0, t: 100, type: 'pass', x: 50, y: 30, x2: 80, y2: 40, pass_distance: 40 },
    ],
  };
  const { findings } = runAudit(input);
  const inv = findings.filter((f) => f.detector_id === 'baseline_invariant');
  assert.equal(inv.length, 0);
});

// --- multi-seed aggregation (task 2.6) --------------------------------------

test('runAudit exposes per-detector stats', () => {
  const input = {
    events: [
      { index: 0, t: 100, type: 'pass', result: 'out', nearest_defender_distance: 12 },
    ],
  };
  const { stats } = runAudit(input);
  const unforced = stats.find((s) => s.detector_id === 'unforced_out');
  assert.equal(unforced.samples, 1);
  assert.equal(unforced.determinate, 1);
  assert.equal(unforced.unknown, 0);
  const inv = stats.find((s) => s.detector_id === 'baseline_invariant');
  assert.equal(inv.samples, 1);
});

test('aggregateAudit sums samples, anomalies, and unknown reasons across seeds', () => {
  const seedA = runAudit({
    events: [
      { index: 0, t: 100, type: 'pass', result: 'out', nearest_defender_distance: 12, pass_distance: 25 },
      { index: 1, t: 110, type: 'pass', result: 'complete', x2: 50, y2: 30 },
    ],
  });
  const seedB = runAudit({
    events: [
      { index: 0, t: 100, type: 'pass', result: 'out' }, // missing pressure -> unknown
    ],
  });
  const agg = aggregateAudit([seedA, seedB]);
  const unforced = agg.detectors.find((d) => d.detector_id === 'unforced_out');
  assert.equal(unforced.sample_count, 3);
  assert.equal(unforced.anomaly_count, 1);
  assert.equal(unforced.anomaly_rate, Math.round((1 / 3) * 1000) / 1000);
  assert.equal(unforced.unknown_count, 1);
  assert.ok(unforced.unknown_reasons['cannot prove pass-out pressure context (nearest_defender_distance missing)'] === 1);
  assert.ok(unforced.reference_band);
  assert.equal(unforced.reference_band.max, null);
  assert.equal(unforced.aggregate_severity, 'realism_warning');
});

test('aggregateAudit escalates to realism_failure when a calibrated band is exceeded', () => {
  const audits = [1, 2, 3].map((i) =>
    runAudit({
      events: [
        {
          index: i,
          t: 100 + i,
          type: 'pass',
          result: 'out',
          nearest_defender_distance: 12 + i,
          pass_distance: 25,
        },
      ],
    })
  );
  // Baseline invariant rate stays 0; a calibrated unforced_out band of max 0.1
  // is exceeded by a 1.0 anomaly rate -> escalate to realism_failure.
  const agg = aggregateAudit(audits, {
    referenceBands: { unforced_out: { min: 0, max: 0.1, source: 'calibrated-test' } },
  });
  const unforced = agg.detectors.find((d) => d.detector_id === 'unforced_out');
  assert.equal(unforced.aggregate_severity, 'realism_failure');
  assert.equal(unforced.band_state, 'above');
  assert.equal(unforced.anomaly_rate, 1);
});

test('aggregateAudit is deterministic and reports unknown when no samples exist', () => {
  const audits = [runAudit({ events: [] }), runAudit({ events: [] })];
  const a = aggregateAudit(audits);
  const b = aggregateAudit(audits);
  assert.deepEqual(a, b);
  const unforced = a.detectors.find((d) => d.detector_id === 'unforced_out');
  assert.equal(unforced.sample_count, 0);
  assert.equal(unforced.anomaly_rate, null);
  assert.equal(unforced.aggregate_severity, 'unknown');
});

test('aggregateAudit reports null severity (clean) when samples exist but anomalies are zero', () => {
  // Both seeds contain a well-aimed pass that stays in play: samples counted,
  // no unforced_out finding -> zero anomalies.
  const audits = [
    runAudit({ events: [{ index: 0, t: 1, type: 'pass', result: 'success', x: 50, y: 30, x2: 80, y2: 40, pass_distance: 40 }] }),
    runAudit({ events: [{ index: 1, t: 2, type: 'pass', result: 'success', x: 20, y: 30, x2: 40, y2: 30, pass_distance: 21 }] }),
  ];
  const agg = aggregateAudit(audits);
  const unforced = agg.detectors.find((d) => d.detector_id === 'unforced_out');
  assert.equal(unforced.sample_count, 2);
  assert.equal(unforced.anomaly_count, 0);
  assert.equal(unforced.anomaly_rate, 0);
  assert.equal(unforced.aggregate_severity, null);
});

// --- pass outcome / pressure buckets (match-audit aggregation scenario) ------

test('runAudit buckets ordinary passes by pressure and outcome', () => {
  const input = {
    events: [
      { index: 0, t: 1, type: 'pass', result: 'out', nearest_defender_distance: 12 }, // unpressured out
      { index: 1, t: 2, type: 'pass', result: 'success', nearest_defender_distance: 2 }, // pressured success
      { index: 2, t: 3, type: 'pass', result: 'complete' }, // unknown_pressure success
      { index: 3, t: 4, type: 'pass', result: 'success', clearance: true }, // excluded (clearance)
    ],
  };
  const { pass_outcomes } = runAudit(input);
  assert.deepEqual(pass_outcomes.unpressured, { sample_count: 1, out_count: 1, success_count: 0, unknown_outcome_count: 0 });
  assert.deepEqual(pass_outcomes.pressured, { sample_count: 1, out_count: 0, success_count: 1, unknown_outcome_count: 0 });
  assert.deepEqual(pass_outcomes.unknown_pressure, { sample_count: 1, out_count: 0, success_count: 1, unknown_outcome_count: 0 });
  assert.deepEqual(pass_outcomes.excluded, { sample_count: 1 });
});

test('runAudit counts a geometric out-of-bounds landing as out even when result is success', () => {
  const input = {
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', x2: 105.5, y2: 30, nearest_defender_distance: 12 },
    ],
  };
  const { pass_outcomes } = runAudit(input);
  assert.equal(pass_outcomes.unpressured.sample_count, 1);
  assert.equal(pass_outcomes.unpressured.out_count, 1);
  assert.equal(pass_outcomes.unpressured.success_count, 0);
});

test('aggregateAudit merges pass_outcomes across seeds and derives out/success rates', () => {
  const seedA = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'out', nearest_defender_distance: 12 },
      { index: 1, t: 2, type: 'pass', result: 'success', nearest_defender_distance: 15 },
    ],
  });
  const seedB = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', nearest_defender_distance: 3 },
      { index: 1, t: 2, type: 'pass', result: 'complete', clearance: true },
    ],
  });
  const agg = aggregateAudit([seedA, seedB]);
  const po = agg.pass_outcomes;
  assert.deepEqual(po.unpressured, {
    sample_count: 2,
    out_count: 1,
    out_rate: 0.5,
    success_count: 1,
    success_rate: 0.5,
    unknown_outcome_count: 0,
  });
  assert.deepEqual(po.pressured, {
    sample_count: 1,
    out_count: 0,
    out_rate: 0,
    success_count: 1,
    success_rate: 1,
    unknown_outcome_count: 0,
  });
  assert.equal(po.unknown_pressure.sample_count, 0);
  assert.equal(po.excluded.sample_count, 1);
  assert.equal(po.total_ordinary_passes, 3);
});

test('aggregateAudit pass_outcomes is deterministic and preserves unknown_outcome when result is missing', () => {
  const audits = [
    runAudit({ events: [{ index: 0, t: 1, type: 'pass', nearest_defender_distance: 12 }] }),
    runAudit({ events: [{ index: 1, t: 2, type: 'pass', nearest_defender_distance: 12 }] }),
  ];
  const a = aggregateAudit(audits);
  const b = aggregateAudit(audits);
  assert.deepEqual(a.pass_outcomes, b.pass_outcomes);
  assert.deepEqual(a.pass_outcomes.unpressured, {
    sample_count: 2,
    out_count: 0,
    out_rate: 0,
    success_count: 0,
    success_rate: 0,
    unknown_outcome_count: 2,
  });
});

// --- P21 L1：真实 audit_input 形状回归（P4.2/P5.1） ---------------------------
// 前面的合成输入覆盖边界；下面这组用真实引擎采集链路产出的 audit_input
// （tools/fixtures/real-audit-input.json），钉住「detector 对真实数据不再瞎」这件事。
// 真实出界传球形状：result:"contested" + detail:"out_*" + 落点被 clamp01 钳回边界。

test('real out-of-play pass yields an unforced_out realism_warning, not unknown', () => {
  const w = realWindow('out_sideline');
  const pass = w.events.find((e) => e.detail === 'out_sideline');
  const { findings } = runAudit(w);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.equal(unforced[0].severity, 'realism_warning');
  assert.equal(unforced[0].event_index, pass.index);
  assert.equal(unforced[0].features.out_evidence, 'event.detail');
  assert.equal(unforced[0].features.out_reason, 'out_sideline');
  // 出界原因由 detail 给，不靠几何；落点被钳在边线上 → 边界距离 0。
  assert.equal(unforced[0].features.boundary_distance, 0);
  assert.equal(unforced[0].features.defender_distance, pass.nearest_defender_distance);
});

test('real goal-line out pass also yields an unforced_out realism_warning', () => {
  const w = realWindow('out_goal_line');
  const pass = w.events.find((e) => e.detail === 'out_goal_line');
  const { findings } = runAudit(w);
  const f = findings.find((x) => x.detector_id === 'unforced_out' && x.event_index === pass.index);
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.severity, 'realism_warning');
  assert.equal(f.features.out_evidence, 'event.detail');
  assert.equal(f.features.out_reason, 'out_goal_line');
});

test('real pass_outcomes counts a real out pass as out (out_count > 0)', () => {
  const { pass_outcomes } = runAudit(realWindow('out_sideline'));
  const ordinary =
    pass_outcomes.unpressured.sample_count + pass_outcomes.pressured.sample_count;
  assert.equal(ordinary, 1, 'the out pass is the only ordinary pass in this window');
  assert.equal(pass_outcomes.unpressured.out_count + pass_outcomes.pressured.out_count, 1);
  assert.equal(pass_outcomes.excluded.sample_count, 0);
});

test('real corner/throw_in/free_kick/clearance passes are all excluded (D2)', () => {
  for (const label of ['corner', 'throw_in', 'free_kick', 'clearance']) {
    const w = realWindow(label);
    const { pass_outcomes, findings } = runAudit(w);
    assert.ok(pass_outcomes.excluded.sample_count >= 1, `${label}: expected an excluded pass`);
    const pass = w.events.find((e) => e.detail === label);
    const warned = findings.find(
      (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index && f.severity !== 'unknown'
    );
    assert.equal(warned, undefined, `${label}: must not be reported as unforced out`);
  }
});

test('a real contested out pass is not excluded by the contested result (D2)', () => {
  const w = realWindow('out_sideline');
  const pass = w.events.find((e) => e.detail === 'out_sideline');
  assert.equal(pass.result, 'contested');
  const { pass_outcomes } = runAudit(w);
  assert.equal(pass_outcomes.excluded.sample_count, 0);
});

// --- P21 D3：不再读无生产者的字段 --------------------------------------------

test('unforced_out features no longer carry target_distance (D3)', () => {
  const { findings } = runAudit(realWindow('out_sideline'));
  const f = findings.find((x) => x.detector_id === 'unforced_out');
  assert.ok(f);
  assert.equal(Object.prototype.hasOwnProperty.call(f.features, 'target_distance'), false);
  assert.equal(f.features.out_reason, 'out_sideline');
});

test('a legacy synthetic target_distance never reaches features (D3)', () => {
  const { findings } = runAudit({
    events: [
      {
        index: 0,
        t: 1,
        type: 'pass',
        result: 'out',
        nearest_defender_distance: 12,
        target_distance: 20,
      },
    ],
  });
  const f = findings.find((x) => x.detector_id === 'unforced_out');
  assert.equal(f.severity, 'realism_warning');
  assert.equal(Object.prototype.hasOwnProperty.call(f.features, 'target_distance'), false);
});

// --- P21 P3.3：audit_input 版本门 -------------------------------------------

test('runAudit rejects an audit_input without schema_version', () => {
  assert.throws(
    () => runAuditRaw({ events: [], players: {} }),
    /missing schema_version.*re-capture/s
  );
});

test('runAudit rejects an audit_input with an unknown schema_version', () => {
  assert.throws(
    () => runAuditRaw({ schema_version: 'audit-input/999', events: [], players: {} }),
    /unsupported audit_input schema_version.*re-capture/s
  );
});

test('runAudit accepts the known schema_version', () => {
  const out = runAuditRaw({ schema_version: AUDIT_INPUT_SCHEMA_VERSION, events: [] });
  assert.ok(Array.isArray(out.findings));
});

// --- P21 D4：未标定 detector 降级 --------------------------------------------

const ignoredInterceptionEvent = (index) => ({
  events: [
    {
      index,
      t: 200 + index,
      type: 'pass',
      result: 'complete',
      defender_id: 11,
      corridor_distance: 2.0,
      pass_distance: 20,
      pass_speed: 10,
      defender_moved_toward_corridor: false,
    },
  ],
});

test('ignored_interception findings are marked calibrated:false (D4)', () => {
  const { findings } = runAudit(ignoredInterceptionEvent(20));
  const inter = findings.filter((f) => f.detector_id === 'ignored_interception_opportunity');
  assert.equal(inter.length, 1);
  assert.equal(inter[0].severity, 'realism_warning');
  assert.equal(inter[0].calibrated, false);
  // 其它 detector 的 finding 不受影响（不被打上该标记）。
  for (const f of findings) {
    if (f.detector_id !== 'ignored_interception_opportunity') assert.equal(f.calibrated, undefined);
  }
});

test('DEFAULT_AUDIT_PROFILE marks only ignored_interception as uncalibrated (D4)', () => {
  assert.equal(DEFAULT_AUDIT_PROFILE.ignored_interception.calibrated, false);
  // 其余 detector 的配置块不带 calibrated 字段（缺席 = 已标定）。用严格断言钉住「缺席」，
  // 而不是 `notEqual(false)`——后者对 undefined 也成立，等于没测。
  assert.equal(DEFAULT_AUDIT_PROFILE.unforced_out.calibrated, undefined);
  assert.equal(DEFAULT_AUDIT_PROFILE.inactive_responsibility.calibrated, undefined);
  assert.equal(DEFAULT_AUDIT_PROFILE.invariants.calibrated, undefined);
});

test('aggregateAudit does not escalate an uncalibrated detector, even above band (D4)', () => {
  // 3 个 seed 各有一条 ignored_interception 告警，并给一个 max=0.1 的「已标定」band。
  // detector 未标定 → band 判定不生效 → 不升级 realism_failure。
  const audits = [1, 2, 3].map((i) => runAudit(ignoredInterceptionEvent(i)));
  const agg = aggregateAudit(audits, {
    referenceBands: {
      ignored_interception_opportunity: { min: 0, max: 0.1, source: 'calibrated-test' },
    },
  });
  const inter = agg.detectors.find((d) => d.detector_id === 'ignored_interception_opportunity');
  assert.equal(inter.anomaly_count, 3);
  assert.equal(inter.calibration, 'uncalibrated');
  assert.equal(inter.aggregate_severity, 'realism_warning');
  assert.equal(inter.band_state, null);
});

test('aggregateAudit still escalates a calibrated detector above band (D4 regression)', () => {
  const audits = [1, 2, 3].map((i) =>
    runAudit({
      events: [
        { index: i, t: 100 + i, type: 'pass', result: 'out', nearest_defender_distance: 12 + i },
      ],
    })
  );
  const agg = aggregateAudit(audits, {
    referenceBands: { unforced_out: { min: 0, max: 0.1, source: 'calibrated-test' } },
  });
  const unforced = agg.detectors.find((d) => d.detector_id === 'unforced_out');
  assert.equal(unforced.calibration, 'calibrated');
  assert.equal(unforced.aggregate_severity, 'realism_failure');
  assert.equal(unforced.band_state, 'above');
});

test('aggregateAudit reports calibration for every detector summary (D4)', () => {
  const agg = aggregateAudit([runAudit({ events: [] })]);
  for (const d of agg.detectors) {
    assert.ok(['calibrated', 'uncalibrated'].includes(d.calibration), d.detector_id);
  }
});

test('an excluded pass near the boundary is not mislabelled as a doubtful out (D2 ordering)', () => {
  // 回归：排除位判定曾排在「出界证据门」之后，导致一个没有出界证据的角球（落点离边线 2m、
  // 在界内）掉进 near-boundary 分支，被报成「cannot prove an out event」——把死球重开
  // 误标成「无法判断的疑似出界」。
  // 正确行为：排除位传球不是 unforced out 候选 → 不产 finding（只在 pass_outcomes.excluded
  // 里计数）。这样既不误标，也不会给每个死球重开都塞一条 unknown 噪音（实测一场约 36 次）。
  const { findings, pass_outcomes } = runAudit({
    events: [
      // 角球：无出界证据、落点在边界附近（会命中 near-boundary 分支的条件）。
      {
        index: 0, t: 1, type: 'pass', detail: 'corner', result: 'success',
        x2: 103, y2: 30, nearest_defender_distance: 12, pass_distance: 20,
      },
    ],
  });
  assert.deepEqual(
    findings.filter((f) => f.detector_id === 'unforced_out'),
    [],
    JSON.stringify(findings)
  );
  assert.equal(pass_outcomes.excluded.sample_count, 1);
  assert.equal(pass_outcomes.unpressured.sample_count, 0);
});

test('excluded passes do not inflate the unknown count (D2 noise guard)', () => {
  // 死球重开在一场比赛里约 36 次。若每次都给 unforced_out 塞一条 unknown finding，
  // 诊断报告会被噪音淹没。排除位传球必须完全静默（只计入 pass_outcomes.excluded）。
  const events = [];
  for (let i = 0; i < 36; i++) {
    events.push({
      index: i,
      t: i * 10,
      type: 'pass',
      detail: ['corner', 'throw_in', 'free_kick', 'clearance'][i % 4],
      result: 'success',
      x2: 50,
      y2: 34,
      nearest_defender_distance: 12,
      pass_distance: 20,
    });
  }
  const { findings, stats, pass_outcomes } = runAudit({ events });
  assert.deepEqual(findings.filter((f) => f.detector_id === 'unforced_out'), []);
  const uf = stats.find((s) => s.detector_id === 'unforced_out');
  assert.equal(uf.unknown, 0);
  assert.equal(uf.samples, 36);
  assert.equal(pass_outcomes.excluded.sample_count, 36);
});

test('an excluded pass WITH out evidence still reports the exclusion (D2 compat)', () => {
  // 旧合成 fixture 的兼容语义：带出界证据的排除位传球仍产出一条 `excluded: <key>` unknown
  // finding（P10 既有测试钉住的行为），不被 near-boundary 或 pressure 分支抢走。
  const input = {
    events: [
      { index: 11, t: 110, type: 'pass', result: 'out', nearest_defender_distance: 15.0, clearance: true },
    ],
  };
  const { findings } = runAudit(input);
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.match(unforced[0].reason, /excluded: clearance/);
});
