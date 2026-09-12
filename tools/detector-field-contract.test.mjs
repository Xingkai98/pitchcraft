// P21 D5/D6 契约断言 + 实现漂移守卫。
//
// 这份测试是「detector 读的字段」与「真实数据真有的字段」之间的看门人：
//   1) 契约清单里每个 reads 字段，在真实 audit_input（tools/fixtures/real-audit-input.json）
//      上必须有生产者、或登记为 known-gap —— 且真的能在真实数据里找到。
//   2) 实现漂移守卫：用记录型 Proxy 跑一遍 runAudit，把 detector 真正读到的键抓出来，
//      必须落在契约清单的 reads ∪ legacy_reads 内。detector 代码改了字段而清单没跟上 → 红。
//   3) legacy_reads（D2 布尔兼容位）在真实数据里必须从不出现 —— 它们是旧合成 fixture 的遗物。
//
// 真实 fixture 由 tools/fixtures/generate-real-audit-fixture.mjs 从真实引擎采集链路生成。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAudit } from './detectors.mjs';
import {
  DETECTOR_FIELD_CONTRACT,
  KNOWN_GAPS,
  AUDIT_INPUT_SCHEMA_VERSION,
  AUDIT_INPUT_TOP_LEVEL_KEYS,
  allowedReadKeys,
  allAllowedReadKeys,
  fieldsWithoutProducer,
} from './detector-field-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'real-audit-input.json'), 'utf8'));

const windowNamed = (label) => {
  const w = FIXTURE.windows.find((x) => x.label === label);
  assert.ok(w, `fixture should contain a window labelled ${label}`);
  return w;
};

const allRealEvents = () => FIXTURE.windows.flatMap((w) => w.audit_input.events);
const allRealSnapshots = () =>
  FIXTURE.windows.flatMap((w) => Object.values(w.audit_input.players).flat());

// --- 1. 契约清单自身的完整性 ------------------------------------------------

test('contract covers every detector and every entry is internally consistent', () => {
  const ids = Object.keys(DETECTOR_FIELD_CONTRACT);
  for (const expected of [
    'baseline_invariant',
    'unforced_out',
    'inactive_responsibility',
    'ignored_interception_opportunity',
    'pass_outcomes',
  ]) {
    assert.ok(ids.includes(expected), `contract must cover ${expected}`);
  }
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    assert.ok(Array.isArray(entry.reads) && entry.reads.length > 0, `${id}.reads`);
    assert.ok(Array.isArray(entry.legacy_reads), `${id}.legacy_reads`);
    assert.ok(entry.producers && typeof entry.producers === 'object', `${id}.producers`);
    assert.ok(Array.isArray(entry.known_gaps), `${id}.known_gaps`);
    // reads 与 legacy_reads 不重叠：一个字段要么「必须有人产」要么「允许没人产」。
    for (const f of entry.legacy_reads) {
      assert.ok(!entry.reads.includes(f), `${id}: ${f} cannot be both reads and legacy_reads`);
    }
    // producers 里的生产方必须是已知取值。
    for (const [field, producer] of Object.entries(entry.producers)) {
      assert.ok(
        ['engine', 'derive', 'viewer'].includes(producer),
        `${id}.producers.${field} has unknown producer ${producer}`
      );
    }
    // known_gaps 条目必须在 KNOWN_GAPS 里登记，且该条确实指向本 detector。
    for (const gapId of entry.known_gaps) {
      const gap = KNOWN_GAPS[gapId];
      assert.ok(gap, `${id} references unregistered known gap ${gapId}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(gap.detector_fields, id),
        `known gap ${gapId} must declare which field it excuses for ${id}`
      );
    }
  }
});

test('every field without a producer is excused by an unproducible known gap', () => {
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    const missing = fieldsWithoutProducer(entry);
    for (const field of missing) {
      const excused = entry.known_gaps.some((gapId) => {
        const gap = KNOWN_GAPS[gapId];
        return gap.kind === 'unproducible' && gap.detector_fields[id] === field;
      });
      assert.ok(
        excused,
        `${id} reads "${field}" but declares no producer and no 'unproducible' known gap for it`
      );
    }
  }
});

test('known gaps are internally consistent with reads/producers', () => {
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const gapId of entry.known_gaps) {
      const gap = KNOWN_GAPS[gapId];
      const field = gap.detector_fields[id];
      if (gap.kind === 'unproducible') {
        // 无生产者 = 必须在 reads 里、且没有 producers 登记。
        assert.ok(entry.reads.includes(field), `${id}: unproducible gap ${gapId} field must be in reads`);
        assert.ok(!entry.producers[field], `${id}: unproducible gap ${gapId} field must have no producer`);
      } else if (gap.kind === 'semantic') {
        // 有生产者，只是表达力不足。
        assert.ok(entry.producers[field], `${id}: semantic gap ${gapId} field must have a producer`);
      } else if (gap.kind === 'removed') {
        // 死代码已删：该字段不应再出现在 reads/legacy_reads 里。
        assert.ok(
          !entry.reads.includes(field) && !entry.legacy_reads.includes(field),
          `${id}: removed gap ${gapId} means the field must no longer be read`
        );
      } else {
        assert.fail(`${id}: known gap ${gapId} has unknown kind ${gap.kind}`);
      }
    }
  }
  // 反向覆盖：没有漏登记的 unproducible 字段（靠上一个测试兜住），也没有孤儿 gap id。
  for (const gapId of Object.keys(KNOWN_GAPS)) {
    const referenced = Object.values(DETECTOR_FIELD_CONTRACT).some((e) =>
      e.known_gaps.includes(gapId)
    );
    assert.ok(referenced, `known gap ${gapId} is registered but no detector references it`);
  }
});

// --- 2. 真实数据上的生产者断言 ----------------------------------------------

test('every contract read is actually produced by the real audit_input', () => {
  const eventKeys = new Set(allRealEvents().flatMap((e) => Object.keys(e)));
  const snapshotKeys = new Set(allRealSnapshots().flatMap((s) => Object.keys(s)));
  const topKeys = new Set(AUDIT_INPUT_TOP_LEVEL_KEYS);

  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const field of entry.reads) {
      const produced =
        eventKeys.has(field) || snapshotKeys.has(field) || topKeys.has(field);
      assert.ok(
        produced,
        `${id} declares read "${field}" but the real audit_input never produces it ` +
          `(event keys ∪ snapshot keys do not contain it)`
      );
      // 有生产者的字段必须有明确生产方登记。
      assert.ok(
        entry.producers[field],
        `${id} reads "${field}" (present in real data) but declares no producer`
      );
    }
  }
});

test('the real fixture actually carries the out/restart shapes this change fixes', () => {
  const events = allRealEvents();
  const byDetail = (d) => events.filter((e) => e.type === 'pass' && e.detail === d);
  // 真实出界：result 无区分度（contested）+ detail 唯一证据 + 坐标被钳到边界。
  for (const detail of ['out_sideline', 'out_goal_line']) {
    const sample = byDetail(detail)[0];
    assert.ok(sample, `fixture must carry a real ${detail} pass`);
    assert.equal(sample.result, 'contested', `${detail}: engine uses contested, not out`);
    const clamped = sample.x2 === 0 || sample.x2 === 105 || sample.y2 === 0 || sample.y2 === 68;
    assert.ok(clamped, `${detail}: landing must be clamped onto a boundary, got x2=${sample.x2} y2=${sample.y2}`);
  }
  // 四类排除位 detail 都在（证明排除位契约有真实数据可依）。
  for (const detail of ['corner', 'throw_in', 'free_kick', 'clearance']) {
    assert.ok(byDetail(detail).length > 0, `fixture must carry a real ${detail} pass`);
  }
});

test('legacy boolean exclusion keys never appear in real engine data', () => {
  const eventKeys = new Set(allRealEvents().flatMap((e) => Object.keys(e)));
  for (const key of ['dead_ball', 'goal_kick', 'contested', 'clearance', 'corner', 'throw_in']) {
    // 这些布尔排除位是 D2 删掉的语义错乱/无生产者键；真实数据里若出现说明契约又漂了。
    const asEventField = eventKeys.has(key) && allRealEvents().some(
      (e) => e.type === 'pass' && typeof e[key] === 'boolean'
    );
    assert.equal(
      asEventField,
      false,
      `real pass events must not carry the legacy boolean key "${key}"`
    );
  }
});

// 合成边界输入（P4.2 保留的少数人造用例之一）：真实数据里已经没有布尔排除位，但 detector
// 仍声明兼容它们。喂一份带布尔位的输入，证明兼容分支确实被代码读到（不是僵尸声明）。
function syntheticLegacyInput() {
  return {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [
      { index: 0, t: 1, type: 'pass', result: 'out', nearest_defender_distance: 12, clearance: true },
      { index: 1, t: 2, type: 'pass', result: 'out', nearest_defender_distance: 12, corner: true },
      { index: 2, t: 3, type: 'pass', result: 'out', nearest_defender_distance: 12, throw_in: true },
    ],
    players: {},
  };
}

test('every declared legacy read is genuinely read by some detector', () => {
  // legacy_reads 允许无生产者，但不能是没人读的僵尸条目（否则清单在自说自话）。
  const recorded = recordReads(syntheticLegacyInput());
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const field of entry.legacy_reads) {
      assert.ok(
        recorded.has(field),
        `${id} declares legacy read "${field}" but no detector code ever reads it`
      );
    }
  }
});

// --- 3. 实现漂移守卫 --------------------------------------------------------

// 允许被「读到」的非字段属性：数组/对象方法、迭代器、JSON 钩子。这些不是字段契约。
const NON_FIELD_PROPS = new Set([
  'length', 'then', 'toJSON', 'constructor', 'toString', 'valueOf',
  'filter', 'map', 'some', 'every', 'find', 'findIndex', 'forEach', 'reduce',
  'slice', 'splice', 'concat', 'join', 'push', 'pop', 'shift', 'unshift',
  'sort', 'reverse', 'includes', 'indexOf', 'lastIndexOf', 'flat', 'flatMap',
  'entries', 'values', 'keys', 'hasOwnProperty', 'propertyIsEnumerable',
  'isPrototypeOf', 'at', 'fill', 'copyWithin', 'splice',
]);

// 用记录型 Proxy 包住 audit_input，跑一遍 runAudit，收集所有被 get 到的键。
// 只记录「普通对象上的非数字字符串键」——数组下标与数组/对象方法是结构访问，不是字段读取。
function recordReads(input) {
  const reads = new Set();
  const cache = new WeakMap();
  const wrap = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (cache.has(value)) return cache.get(value);
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !NON_FIELD_PROPS.has(prop)) {
          const numeric = /^\d+$/.test(prop);
          if (!numeric) reads.add(prop);
        }
        return wrap(Reflect.get(target, prop, receiver));
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  runAudit(wrap(input));
  return reads;
}

// 跑遍所有真实窗口（含各有标记的快照），合并读到的键——覆盖比单窗口更全。
function recordReadsAcrossFixture() {
  const reads = new Set();
  for (const w of FIXTURE.windows) {
    for (const k of recordReads(w.audit_input)) reads.add(k);
  }
  return reads;
}

test('detector implementations only read fields declared in the contract', () => {
  const recorded = recordReadsAcrossFixture();
  const allowed = allAllowedReadKeys();
  const undeclared = [...recorded].filter((k) => !allowed.has(k));
  assert.deepEqual(
    undeclared,
    [],
    `detector code reads fields missing from detector-field-contract.mjs: ${undeclared.join(', ')}`
  );
});

test('the drift guard actually catches an undeclared read (self-check)', () => {
  // 防「守卫本身永远绿」：先确认记录器真的能观测到已知读取……
  const recorded = recordReadsAcrossFixture();
  assert.ok(recorded.has('detail'), 'recorder must observe real reads such as "detail"');
  assert.ok(recorded.has('nearest_defender_distance'));
  // ……再确认契约的允许集确实排除了本 change 删掉的字段（写了就红）。
  const allowed = allAllowedReadKeys();
  assert.equal(allowed.has('target_distance'), false, 'target_distance must not be declared (D3 removes it)');
  assert.equal(allowed.has('dead_ball'), true, 'dead_ball snapshot flag is a declared read');
  // 反向自检：从允许集里剔除一个确实被读取的字段，守卫必须立刻把它报成「未声明」。
  // （直接验证「契约少了字段 → 判决非空」这条因果，而不是猜 detector 会读什么。）
  const withoutDetail = new Set(allowed);
  withoutDetail.delete('detail');
  const flagged = [...recorded].filter((k) => !withoutDetail.has(k));
  assert.deepEqual(
    flagged,
    ['detail'],
    'the guard must surface a read field that the contract fails to declare'
  );
});

test('every contract read is exercised by the fixture-driven drift guard', () => {
  // 反向覆盖：契约声明的 reads 若一个都没被真读到，说明清单里有僵尸字段。
  const recorded = recordReadsAcrossFixture();
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const field of entry.reads) {
      assert.ok(
        recorded.has(field),
        `${id} declares read "${field}" but no detector code reads it in the drift guard`
      );
    }
  }
});

// --- 4. schema_version 版本保护 (D6) ----------------------------------------

test('AUDIT_INPUT_SCHEMA_VERSION is a non-empty string and matches the fixture', () => {
  assert.equal(typeof AUDIT_INPUT_SCHEMA_VERSION, 'string');
  assert.ok(AUDIT_INPUT_SCHEMA_VERSION.length > 0);
  // 真实采集现在必须带版本号，否则 runner 会拒绝。
  for (const w of FIXTURE.windows) {
    // 生成器落盘时冻结的是当时采集到的 audit_input；版本字段由 derive 层加。
    assert.ok(
      w.audit_input.schema_version === undefined ||
        w.audit_input.schema_version === AUDIT_INPUT_SCHEMA_VERSION,
      `${w.label}: unexpected schema_version ${w.audit_input.schema_version}`
    );
  }
});

// --- 5. 契约驱动的行为回归（真实数据） ---------------------------------------

test('real out-of-play pass is classified out, not unknown (D1)', () => {
  const w = windowNamed('out_sideline');
  const { findings, pass_outcomes } = runAudit(w.audit_input);
  const pass = w.audit_input.events.find((e) => e.detail === 'out_sideline');
  assert.equal(pass.result, 'contested', 'real out passes use result:"contested"');
  assert.equal(pass.y2, 0, 'real out landing is clamped to the goal line');
  const unforced = findings.filter(
    (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index
  );
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.notEqual(unforced[0].severity, 'unknown', 'must no longer be unknown');
  assert.equal(unforced[0].features.out_evidence, 'event.detail');
  assert.equal(unforced[0].features.out_reason, 'out_sideline');
  assert.equal(pass_outcomes.unpressured.out_count + pass_outcomes.pressured.out_count, 1);
});

test('real out-of-play pass on the goal line is also classified out (D1)', () => {
  const w = windowNamed('out_goal_line');
  const { findings } = runAudit(w.audit_input);
  const pass = w.audit_input.events.find((e) => e.detail === 'out_goal_line');
  assert.equal(pass.x2, 105, 'real goal-line out landing is clamped to the touch line');
  const unforced = findings.find(
    (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index
  );
  assert.ok(unforced, 'out_goal_line must produce an unforced_out finding');
  assert.notEqual(unforced.severity, 'unknown');
  assert.equal(unforced.features.out_evidence, 'event.detail');
  assert.equal(unforced.features.out_reason, 'out_goal_line');
});

test('real dead-ball details are excluded from the ordinary-pass buckets (D2)', () => {
  for (const label of ['corner', 'throw_in', 'free_kick', 'clearance']) {
    const w = windowNamed(label);
    const { pass_outcomes, findings } = runAudit(w.audit_input);
    const pass = w.audit_input.events.find((e) => e.detail === label);
    assert.ok(pass, `${label}: fixture should carry the pass`);
    assert.ok(pass_outcomes.excluded.sample_count >= 1, `${label} must be excluded`);
    const unforced = findings.find(
      (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index && f.severity !== 'unknown'
    );
    assert.equal(unforced, undefined, `${label} must not produce an unforced_out finding`);
  }
});

test('a contested result alone never excludes a real out pass (D2)', () => {
  const w = windowNamed('out_sideline');
  const pass = w.audit_input.events.find((e) => e.detail === 'out_sideline');
  assert.equal(pass.result, 'contested');
  const { pass_outcomes } = runAudit(w.audit_input);
  assert.equal(pass_outcomes.excluded.sample_count, 0, 'the out pass must not be excluded');
});

test('real dead-ball snapshots carry the produced dead_ball flag', () => {
  const w = windowNamed('whistle_dead_ball');
  const snaps = Object.values(w.audit_input.players).flat();
  const dead = snaps.filter((s) => s.dead_ball === true);
  assert.ok(dead.length > 0, 'whistle window must carry snapshots with dead_ball:true');
  // 该位有生产者（derive 层 isDeadBallEvent + 球静止）→ 是契约里的正常 reads，
  // 不是 legacy 布尔位。detector 的资格判定仍会读它（见漂移守卫）。
  assert.equal(recordReadsAcrossFixture().has('dead_ball'), true);
});

test('a real out pass is not misclassified as excluded-by-contested (D2 regression)', () => {
  // 出界球 result 也是 contested。若把 contested 当排除位，真出界会被静默丢掉——
  // 这条测试钉住「contested 不是排除位」这个语义（P21 D2）。
  for (const label of ['out_sideline', 'out_goal_line']) {
    const w = windowNamed(label);
    const { pass_outcomes, findings } = runAudit(w.audit_input);
    assert.equal(pass_outcomes.excluded.sample_count, 0, `${label} must not be excluded`);
    const pass = w.audit_input.events.find((e) => e.detail === label);
    const f = findings.find((x) => x.detector_id === 'unforced_out' && x.event_index === pass.index);
    assert.ok(f, `${label} must yield an unforced_out finding`);
    assert.doesNotMatch(f.reason ?? '', /excluded/, `${label} must not be excluded`);
  }
});
