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

// P21 D6 之后 runAudit 要求 audit_input 带 schema_version + 合法的 events/players 容器。
// 下面这些用例是手写的合成事件/快照片段，补这些样板是噪音——统一在这里注入，用例正文只
// 描述被测字段。版本门与容器校验本身的行为由文件末尾的 `runAudit rejects ...` 用例用
// runAuditRaw（不带样板）直接覆盖。
const runAudit = (input = {}, profile = undefined) => {
  const full = { schema_version: AUDIT_INPUT_SCHEMA_VERSION, events: [], players: {}, ...input };
  return profile === undefined ? runAuditRaw(full) : runAuditRaw(full, profile);
};

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
    // 每个 finding 必须能归属到某个 detector：缺 detector_id 的 finding 在 viewer 里退化
    // 成占位符、也让「detector_id 全在契约里」的守卫看不见它（审阅发现的假绿通路）。
    assert.equal(typeof f.detector_id, 'string', JSON.stringify(f));
    assert.ok(f.detector_id.length > 0);
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

// --- P26 player_overlap：同队间距（#35 detector 部分） -----------------------
// 同队判定按 id 范围（0-10 home / 11-21 away，与 derive 层 teamOf 一致）；按 t 对齐；
// 按球员对聚合；阈值来自 profile.player_overlap.min_distance（默认 2.0）。

test('real windows report a player_overlap realism_warning where teammates crowd (P26)', () => {
  // 真实 fixture 上只有 corner 窗口同队（home 4/5）贴到 <2m（实测 0.434m）；引擎未修，
  // detector 必须把这件事暴露出来。#53 修引擎后这些 finding 应归零。
  const w = realWindow('corner');
  const { findings } = runAudit(w);
  const overlap = findings.filter((f) => f.detector_id === 'player_overlap');
  assert.equal(overlap.length, 1, JSON.stringify(findings));
  assert.equal(overlap[0].severity, 'realism_warning');
  assert.equal(overlap[0].entity_id, '4,5');
  assert.ok(overlap[0].features.min_distance < DEFAULT_AUDIT_PROFILE.player_overlap.min_distance);
});

test('a window with comfortably spaced teammates reports no player_overlap (P26)', () => {
  // 反面对照：throw_in 窗口的同队 pair 16/17 最小间距 30.257m ≫ 2m → 不产 finding。
  // 缺了这条，「detector 对任何同队 pair 都报警」的假阳性写坏也全绿。
  const w = realWindow('throw_in');
  const { findings } = runAudit(w);
  assert.deepEqual(findings.filter((f) => f.detector_id === 'player_overlap'), []);
});

test('player_overlap threshold is strict < (distance == min_distance is not a finding)', () => {
  // 阈值方向守卫（镜像 P22 的阈值守卫）：恰等于 min_distance 不报，严格小于才报。
  // 用 profile 覆写 min_distance 到与合成间距**精确相等**的整数值，避免浮点尾巴。
  const players = {
    4: [{ t: 10, x: 0, y: 0 }],
    5: [{ t: 10, x: 2, y: 0 }],
  };
  const profile = {
    ...DEFAULT_AUDIT_PROFILE,
    player_overlap: { ...DEFAULT_AUDIT_PROFILE.player_overlap, min_distance: 2 },
  };
  assert.deepEqual(
    runAudit({ players }, profile).findings.filter((f) => f.detector_id === 'player_overlap'),
    [],
    'distance exactly equal to min_distance must not be reported (< is strict)'
  );
  const closer = {
    4: [{ t: 10, x: 0, y: 0 }],
    5: [{ t: 10, x: 1.999, y: 0 }],
  };
  const reported = runAudit({ players: closer }, profile).findings.filter(
    (f) => f.detector_id === 'player_overlap'
  );
  assert.equal(reported.length, 1, 'distance just below min_distance must be reported');
  assert.equal(reported[0].thresholds.min_distance, 2);
});

test('player_overlap aggregates one finding per teammate pair, not per sample (P26 D2)', () => {
  // 同一 pair 在多个采样点都 < 阈值 → 只报一条；match_time 取首次越界时刻，
  // features.min_distance 取窗口内最小间距（不是首次越界的那个间距）。
  const players = {
    4: [
      { t: 10, x: 0, y: 0 },
      { t: 11, x: 1.5, y: 0 },
      { t: 12, x: 3, y: 0 },
      { t: 13, x: 0.8, y: 0 },
    ],
    5: [
      { t: 10, x: 1.0, y: 0 },
      { t: 11, x: 2.0, y: 0 },
      // t=12 时两人相距 5m ≥ 阈值 → 不越界（这条让「最小间距跨整个窗口」与「首次越界」
      // 区分开：若 features 取了首次越界的间距，min_distance 会假成 1.0）。
      { t: 12, x: 8.0, y: 0 },
      { t: 13, x: 1.5, y: 0 },
    ],
  };
  const overlap = runAudit({ players }).findings.filter(
    (f) => f.detector_id === 'player_overlap'
  );
  assert.equal(overlap.length, 1, 'one finding per pair, not one per sample');
  assert.equal(overlap[0].match_time, 10, 'match_time is the first breaching sample');
  assert.equal(overlap[0].features.min_distance, 0.5, 'min_distance spans the whole window');
  assert.equal(overlap[0].features.first_breach_time, 10);
  assert.equal(overlap[0].features.breach_samples, 3);
  assert.equal(overlap[0].features.aligned_samples, 4);
});

test('player_overlap never pairs cross-team players (id range defines the team, D1)', () => {
  // 间距 <2m 但跨队（home 4 / away 11）→ 不是重叠，是对抗中的贴身，不该报。
  const players = {
    4: [{ t: 10, x: 0, y: 0 }],
    11: [{ t: 10, x: 0.5, y: 0 }],
  };
  assert.deepEqual(
    runAudit({ players }).findings.filter((f) => f.detector_id === 'player_overlap'),
    []
  );
});

test('player_overlap skips snapshots whose teammates have no sample at that t (D6)', () => {
  // 采样点不对齐（某球员某 t 无快照）→ 该 t 跳过，不拿缺失位置当原点。player 5 只在
  // t=12 有快照，与 4 的 t=10 间距 0.2m——若把缺采样当 (0,0) 会造出一条假 finding。
  const players = {
    4: [
      { t: 10, x: 0.2, y: 0 },
      { t: 12, x: 40, y: 0 },
    ],
    5: [{ t: 12, x: 40.2, y: 0 }],
  };
  const overlap = runAudit({ players }).findings.filter(
    (f) => f.detector_id === 'player_overlap'
  );
  assert.equal(overlap.length, 1, JSON.stringify(overlap));
  assert.equal(overlap[0].match_time, 12, 'the unaligned t=10 must be skipped');
});

test('player_overlap ignores snapshots with a non-finite t (NaN/Infinity are not instants)', () => {
  // t=NaN 曾经被收进采样点表：它排序错乱、还能与另一名球员的 NaN 键「对齐」，产出一条
  // match_time 为 null（JSON 化后 NaN→null）的假 finding。位置缺失该跳过是对的，t 缺失
  // 同理——t 不是位置，不算「拿缺失位置当原点」，但它同样不可对齐。
  const players = {
    4: [{ t: NaN, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }],
    5: [{ t: Infinity, x: 0.5, y: 0 }, { t: 1, x: 50, y: 0 }],
  };
  const { findings, stats } = runAudit({ players });
  assert.deepEqual(
    findings.filter((f) => f.detector_id === 'player_overlap'),
    [],
    'non-finite t must not become an aligned sample'
  );
  assert.equal(stats.find((s) => s.detector_id === 'player_overlap').samples, 1);
});

test('player_overlap is registered in the audit stats with a pair count (P26)', () => {
  // statsFor 集成：stats 行必须存在，否则新 detector 的失败会静默不计数。
  const { stats } = runAudit({
    players: {
      4: [{ t: 10, x: 0, y: 0 }],
      5: [{ t: 10, x: 0.4, y: 0 }],
      6: [{ t: 10, x: 50, y: 0 }],
    },
  });
  const stat = stats.find((s) => s.detector_id === 'player_overlap');
  assert.ok(stat, 'player_overlap must appear in stats');
  assert.equal(stat.samples, 3, 'three same-team pairs among 4/5/6');
  assert.equal(stat.determinate, 1);
  assert.equal(stat.unknown, 0);
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
  const out = runAuditRaw({ schema_version: AUDIT_INPUT_SCHEMA_VERSION, events: [], players: {} });
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

test('DEFAULT_AUDIT_PROFILE declares calibration explicitly for every detector (D4)', () => {
  // 标定状态必须**显式**声明（isUncalibrated 只认 calibrated:true；「没声明」= 未标定，
  // fail-closed）。默认 profile 里只有 ignored_interception 未标定，其余显式 true。
  // 配置块 = 与 detector 对应的对象块（非顶层标量/非 pitch/aggregation）。
  for (const blockKey of ['unforced_out', 'inactive_responsibility', 'ignored_interception', 'player_overlap', 'invariants']) {
    const block = DEFAULT_AUDIT_PROFILE[blockKey];
    assert.equal(
      typeof block.calibrated,
      'boolean',
      `DEFAULT_AUDIT_PROFILE.${blockKey} must explicitly declare calibrated`
    );
  }
  assert.equal(DEFAULT_AUDIT_PROFILE.ignored_interception.calibrated, false);
  assert.equal(DEFAULT_AUDIT_PROFILE.unforced_out.calibrated, true);
  assert.equal(DEFAULT_AUDIT_PROFILE.inactive_responsibility.calibrated, true);
  assert.equal(DEFAULT_AUDIT_PROFILE.invariants.calibrated, true);
  // P26：阈值 2.0m 是真实比赛常识，但告警率未用真实比赛标定（标定归 #36）→ 显式未标定。
  assert.equal(DEFAULT_AUDIT_PROFILE.player_overlap.calibrated, false);
  assert.equal(DEFAULT_AUDIT_PROFILE.player_overlap.min_distance, 2.0);
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

test('an unknown detector_id is treated as uncalibrated (D4 fail-closed)', () => {
  // 防 fail-open：新 detector 忘了登记时，绝不能默认被当成「已标定」而允许升级
  // realism_failure。未登记 = 没标定过 → 保守地算未标定。契约测试另在测试期报出
  // 「runAudit 产出的 detector 未登记」，运行时行为则保持保守。
  const agg = aggregateAudit([
    {
      profile: { id: 'p', version: '0' },
      findings: [],
      stats: [{ detector_id: 'detector_not_in_profile_map', samples: 10, determinate: 10, unknown: 0, unknown_reasons: {} }],
      pass_outcomes: {},
    },
  ], { referenceBands: { detector_not_in_profile_map: { min: 0, max: 0.1 } } });
  const d = agg.detectors.find((x) => x.detector_id === 'detector_not_in_profile_map');
  assert.equal(d.calibration, 'uncalibrated');
  assert.equal(d.aggregate_severity, null);
  assert.equal(d.band_state, null);
});

test('a partial custom profile cannot make a known-uncalibrated detector look calibrated (D4)', () => {
  // 审阅发现的第二条 fail-open 通路：detector_id 在映射表里，但调用方传给 aggregateAudit
  // 的 profile 少了对应配置块（例如只给 reference_bands 的 partial profile）。此时「块缺失」
  // 不能被当成「已标定」——无法证明已标定 → 算未标定。否则 known-uncalibrated 的
  // ignored_interception_opportunity 会超 band 升级 realism_failure。
  // 用合成 audit 对象直接打 aggregateAudit（runAudit 需要完整 profile，partial 会在
  // detectInvariants 崩——那是另一回事，不属本用例）。
  const audit = {
    profile: { id: 'p', version: '0' },
    findings: [],
    stats: [
      { detector_id: 'ignored_interception_opportunity', samples: 10, determinate: 10, unknown: 0, unknown_reasons: {} },
    ],
    pass_outcomes: {},
  };
  const partialProfile = { id: 'partial', version: '0', aggregation: { reference_bands: {} } };
  // 先确认这条 detector 在默认 profile 下确实被标为未标定（否则本用例无意义）。
  const withDefault = aggregateAudit([audit], {
    referenceBands: { ignored_interception_opportunity: { min: 0, max: 0.01, source: 't' } },
  });
  assert.equal(
    withDefault.detectors.find((x) => x.detector_id === 'ignored_interception_opportunity').calibration,
    'uncalibrated'
  );
  // 换成缺块的 partial profile：仍须未标定、不升级。
  const agg = aggregateAudit([audit], {
    profile: partialProfile,
    referenceBands: { ignored_interception_opportunity: { min: 0, max: 0.01, source: 't' } },
  });
  const d = agg.detectors.find((x) => x.detector_id === 'ignored_interception_opportunity');
  assert.equal(d.calibration, 'uncalibrated');
  assert.notEqual(d.aggregate_severity, 'realism_failure');
  assert.equal(d.band_state, null);
});

test('a profile block without a calibrated key is not trusted (D4 N5)', () => {
  // 第三条 fail-open 通路：块在、但没声明 calibrated。严格 fail-closed 语义下，
  // 「没声明」不等于「已标定」——只有显式 calibrated:true 才算已标定。
  const audit = {
    profile: { id: 'p', version: '0' },
    findings: [],
    stats: [
      { detector_id: 'ignored_interception_opportunity', samples: 10, determinate: 10, unknown: 0, unknown_reasons: {} },
    ],
    pass_outcomes: {},
  };
  const profileWithoutCalibrationKey = {
    ...DEFAULT_AUDIT_PROFILE,
    // 覆盖掉带 calibrated:false 的默认块，改成「只部分覆盖、没有 calibrated 键」。
    ignored_interception: { defender_speed: 6.0, arrival_margin: 0.5 },
  };
  const agg = aggregateAudit([audit], {
    profile: profileWithoutCalibrationKey,
    referenceBands: { ignored_interception_opportunity: { min: 0, max: 0.01, source: 't' } },
  });
  const d = agg.detectors.find((x) => x.detector_id === 'ignored_interception_opportunity');
  assert.equal(d.calibration, 'uncalibrated');
  assert.notEqual(d.aggregate_severity, 'realism_failure');
  assert.equal(d.band_state, null);
});

test('runAudit rejects malformed events/players containers (fail-loud, not silent)', () => {
  // 与 schema_version 版本门同族的 fail-open：此前 events 缺失/null/非数组会被静默当成
  // 空数组，audit 出全零结果（「静默 = 断裂潜伏」正是本 change 的立项理由）。
  const base = { schema_version: AUDIT_INPUT_SCHEMA_VERSION };
  for (const bad of [
    { ...base }, // events 缺失
    { ...base, events: null },
    { ...base, events: 'nope' },
    { ...base, events: {} },
  ]) {
    assert.throws(() => runAuditRaw(bad), /events must be an array/, JSON.stringify(bad));
  }
  for (const bad of [
    { ...base, events: [], players: null },
    { ...base, events: [], players: [] },
    { ...base, events: [], players: 'x' },
  ]) {
    assert.throws(() => runAuditRaw(bad), /players must be an object/, JSON.stringify(bad));
  }
  // 合法空输入仍正常。
  const ok = runAuditRaw({ ...base, events: [], players: {} });
  assert.deepEqual(ok.findings, []);
});

test('D1 priority: detail out-evidence wins over result==="out" (observable behaviour)', () => {
  // design D1 把「优先认 detail」列为契约的一部分。用一条 result==='out' 且 detail 出界的
  // 输入把优先级钉成可观测行为：out_evidence 必须是 'event.detail'，不是 'event.result'。
  // （否则将来有人把 result 分支提到前面，新引擎数据上 out_evidence 标签会悄悄变形。）
  const { findings } = runAudit({
    events: [
      {
        index: 0, t: 1, type: 'pass',
        result: 'out', detail: 'out_sideline',
        nearest_defender_distance: 12, pass_distance: 25,
      },
    ],
  });
  const f = findings.find((x) => x.detector_id === 'unforced_out');
  assert.equal(f.severity, 'realism_warning');
  assert.equal(f.features.out_evidence, 'event.detail');
  assert.equal(f.features.out_reason, 'out_sideline');
  // pass_outcomes 也走同一契约（分类为 out）。
  const { pass_outcomes } = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'out', detail: 'out_sideline', nearest_defender_distance: 12 },
    ],
  });
  assert.equal(pass_outcomes.unpressured.out_count, 1);
});

// --- P22: detector 阈值算子方向守卫（issue #38） ------------------------------
//
// P21 的字段契约守卫钉「读的字段有没有生产者」，钉不住「怎么比较」。issue #38：
// 把阈值算子方向（`>`→`>=` 等）改掉，所有测试全绿。下面用「恰好等于阈值」的边界样本
// 钉死每个算子的方向——真实 fixture 里几乎不可能出现恰等于阈值的值（真实坐标连续），
// 必须手写合成输入。每个用例都标注：改成另一个方向会让它红。

test('threshold direction: unforced_out is strict > (equal pressure_distance does not warn)', () => {
  // `nearest_defender_distance > 8.0`：恰等于 8.0 不算无压迫。改成 `>=` 会让本用例红。
  const { findings } = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', detail: 'out_sideline', nearest_defender_distance: 8.0, pass_distance: 25 },
    ],
  });
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 0);
});

test('threshold direction: inactive split is >= (equal stationary_epsilon counts as movement)', () => {
  // `distance >= 0.5` 分割 run：位移恰等于 0.5 算移动，连续 4 点各成单点 run（时长 0），
  // 全部短于 static_duration → 无告警。改成 `>` 会让位移 0.5 不再分割，合成一个时长 3s 的
  // run → 告警，本用例红。
  const input = {
    players: {
      home_7: [
        { t: 0, x: 0, y: 0, responsibility: 'ball_entered_zone' },
        { t: 1, x: 0.5, y: 0, responsibility: 'ball_entered_zone' },
        { t: 2, x: 1.0, y: 0, responsibility: 'ball_entered_zone' },
        { t: 3, x: 1.5, y: 0, responsibility: 'ball_entered_zone' },
      ],
    },
  };
  const { findings } = runAudit(input);
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility' && f.severity === 'realism_warning');
  assert.equal(inactive.length, 0);
});

test('threshold direction: inactive duration is < (equal static_duration still warns)', () => {
  // `staticDuration < 3.0` 才 continue 跳过；恰等于 3.0 不跳过 → 告警。改成 `<=` 会让
  // 时长 3.0 被跳过，本用例红。
  const { findings } = runAudit({
    players: {
      home_8: [
        { t: 0, x: 0, y: 0, responsibility: 'ball_entered_zone' },
        { t: 3, x: 0.1, y: 0, responsibility: 'ball_entered_zone' },
      ],
    },
  });
  const inactive = findings.filter((f) => f.detector_id === 'inactive_responsibility' && f.severity === 'realism_warning');
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].features.static_duration, 3);
});

test('threshold direction: interception is strict < (equal arrival does not flag)', () => {
  // `defenderArrival + margin < ballArrival`：恰等于时不构成机会。改成 `<=` 会让本用例红。
  const { findings } = runAudit({
    events: [
      {
        index: 0, t: 1, type: 'pass', result: 'complete',
        corridor_distance: 9.0, // 9.0 / 6.0 = 1.5；+0.5 margin = 2.0
        pass_distance: 20, pass_speed: 10, // 20 / 10 = 2.0 → 恰好相等
        defender_moved_toward_corridor: false,
      },
    ],
  });
  const inter = findings.filter((f) => f.detector_id === 'ignored_interception_opportunity' && f.severity === 'realism_warning');
  assert.equal(inter.length, 0);
});

test('threshold direction: pass_outcomes is strict > (equal threshold is pressured)', () => {
  // `nearest_defender_distance > 8.0` 才进 unpressured 桶；恰等于 8.0 进 pressured。改成
  // `>=` 会让本用例红。
  const { pass_outcomes } = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', nearest_defender_distance: 8.0 },
    ],
  });
  assert.equal(pass_outcomes.pressured.sample_count, 1);
  assert.equal(pass_outcomes.unpressured.sample_count, 0);
});

test('threshold direction: band escalation is strict > (rate == band.max does not escalate)', () => {
  // `rate > band.max`（aggregateAudit 里）：baseline_invariant 默认 band max=0（不变量违规
  // 是 bug，零容忍）。干净输入 rate=0，`0 > 0` false → within，aggregate_severity 保持 null。
  // 改成 `>=` 会让 `0 >= 0` → above + realism_failure——每次干净聚合都被翻成失败。
  const audits = [
    runAudit({
      events: [{ index: 0, t: 1, type: 'pass', result: 'success', x: 50, y: 30, x2: 80, y2: 40, pass_distance: 40 }],
    }),
  ];
  const agg = aggregateAudit(audits);
  const inv = agg.detectors.find((d) => d.detector_id === 'baseline_invariant');
  assert.equal(inv.anomaly_count, 0);
  assert.equal(inv.anomaly_rate, 0);
  assert.equal(inv.aggregate_severity, null);
  assert.equal(inv.band_state, 'within');
});

test('threshold direction: geometric out is strict > (x2 == pitch.width is not out)', () => {
  // `isOutOfPitch` 用 `x2 > pitch.width`。引擎 clamp 把出界落点钳回边界线（x2=105 或
  // y2=0），所以 x2 恰等于 105 是真实数据上会出现的值。改成 `>=` 会把 x2=105 当几何出界
  // 证据（landing_out_of_bounds）。这里钉：x2 恰等于 pitch.width 不构成几何出界。
  const { findings } = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'contested', x2: 105, y2: 30, pass_distance: 40 },
    ],
  });
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 1);
  assert.equal(unforced[0].severity, 'unknown');
  assert.match(unforced[0].reason, /near boundary/);
});

test('threshold direction: near-boundary is strict < (distance == margin is not near)', () => {
  // `distanceToBoundary(...) < boundary_margin(3.0)`：落点距右边线恰 3.0 不算 near-boundary。
  // 改成 `<=` 会多产一条 near-boundary unknown。这里钉：distance 恰等于 margin 不产。
  const { findings } = runAudit({
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', x2: 102, y2: 30, pass_distance: 40 },
    ],
  });
  const unforced = findings.filter((f) => f.detector_id === 'unforced_out');
  assert.equal(unforced.length, 0);
});

// golden finding 签名：真实窗口的 finding 集合逐条一致。改判据方向/阈值/删分支，只要让
// 真实数据上的 finding 集合变化（含「现有边界测试没覆盖到的那一处」），本用例当场红。
// 签名基于 P21 落盘的 tools/fixtures/real-audit-input.json（逐字节可复现），值由当前正确
// 实现产出。有意改阈值（#36 标定）时需同步更新——这正是「改了就红」的预期代价。
const GOLDEN_FINDINGS = [
  'clearance | ignored_interception_opportunity | realism_warning | ev=3412 | ent=12',
  'corner | ignored_interception_opportunity | realism_warning | ev=1687 | ent=7',
  'corner | player_overlap | realism_warning | ev=null | ent=4,5',
  'free_kick | ignored_interception_opportunity | realism_warning | ev=474 | ent=15',
  'free_kick | inactive_responsibility | unknown | ev=null | ent=6',
  'out_goal_line | ignored_interception_opportunity | realism_warning | ev=2523 | ent=17',
  'out_goal_line | inactive_responsibility | unknown | ev=null | ent=1',
  'out_goal_line | inactive_responsibility | unknown | ev=null | ent=2',
  'out_goal_line | unforced_out | realism_warning | ev=2523 | ent=null',
  'out_sideline | ignored_interception_opportunity | realism_warning | ev=263 | ent=16',
  'out_sideline | inactive_responsibility | unknown | ev=null | ent=9',
  'out_sideline | unforced_out | realism_warning | ev=263 | ent=null',
  'throw_in | inactive_responsibility | unknown | ev=null | ent=17',
  'whistle_dead_ball | inactive_responsibility | realism_warning | ev=null | ent=17',
  'whistle_dead_ball | inactive_responsibility | unknown | ev=null | ent=0',
];

test('golden finding signature over real windows catches threshold/semantics drift', () => {
  const actual = [];
  for (const w of REAL_FIXTURE.windows) {
    const { findings } = runAudit(w.audit_input);
    for (const f of findings) {
      actual.push(`${w.label} | ${f.detector_id} | ${f.severity} | ev=${f.event_index} | ent=${f.entity_id}`);
    }
  }
  actual.sort();
  assert.deepEqual(actual, GOLDEN_FINDINGS);
});
