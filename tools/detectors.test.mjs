import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AUDIT_PROFILE, runAudit, aggregateAudit } from './detectors.mjs';

const findingsByDetector = (findings) => {
  const out = {};
  for (const f of findings) {
    (out[f.detector_id] ??= []).push(f);
  }
  return out;
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

test('runAudit excludes a stationary defender holding formation', () => {
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
  assert.equal(inactive.length, 0);
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
