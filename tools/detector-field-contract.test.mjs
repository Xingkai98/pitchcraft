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
import {
  runAudit,
  detectInvariants,
  detectUnforcedOut,
  detectInactiveResponsibility,
  detectIgnoredInterception,
  computePassOutcomes,
  DEFAULT_AUDIT_PROFILE,
} from './detectors.mjs';
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

test('the contract covers every detector runAudit actually emits (no unregistered detector)', () => {
  // 反向覆盖（防再犯的核心）：runAudit 实际产出的每个 detector_id 都必须在契约里登记。
  // 否则新加一个 detector（issue #34/#35 之类）时，它会静默不受契约保护、不参与漂移守卫、
  // 聚合摘要也不会带 calibration——正是 D5 要防的「代码与清单不一致」。
  const emitted = new Set();
  const { stats, findings } = runAudit({
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [],
    players: {},
  });
  for (const s of stats) emitted.add(s.detector_id);
  for (const f of findings) if (f.detector_id) emitted.add(f.detector_id);
  assert.ok(emitted.size > 0, 'runAudit must emit at least one detector');
  const undeclared = [...emitted].filter((id) => !(id in DETECTOR_FIELD_CONTRACT));
  assert.deepEqual(
    undeclared,
    [],
    `runAudit emits detectors missing from the contract: ${undeclared.join(', ')}`
  );
});

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

test('every declared legacy read is genuinely read by its detector', () => {
  // legacy_reads 允许无生产者，但不能是没人读的僵尸条目（否则清单在自说自话）。
  // 这里也逐 detector 归属：读到的键必须落在**那个 detector** 的 legacy_reads 里。
  const perDetector = {};
  for (const id of Object.keys(DETECTOR_ENTRY)) perDetector[id] = new Set();
  const inputs = [
    syntheticLegacyInput(),
    ...FIXTURE.windows.map((w) => w.audit_input),
    ...BRANCH_COVERAGE_INPUTS,
  ];
  for (const input of inputs) {
    for (const [id, run] of Object.entries(DETECTOR_ENTRY)) {
      for (const k of recordReads(input, run)) perDetector[id].add(k);
    }
  }
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    // 不静默跳过：没有 runner 的条目由「every contract entry has a drift-guard runner」兜住。
    const reads = perDetector[id];
    assert.ok(reads, `no drift-guard runner for ${id}`);
    for (const field of entry.legacy_reads) {
      assert.ok(
        reads.has(field),
        `${id} declares legacy read "${field}" but its implementation never reads it`
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
function recordReads(input, fn) {
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
  fn(wrap(input));
  return reads;
}

const recordAuditReads = (input) => recordReads(input, (pi) => runAudit(pi));

// 逐条目直接调用，把读键**归属到具体条目**——按并集断言会漏掉
// 「条目 A 读了契约里只属于 B 的字段」这类串读（审阅发现的守卫盲区）。
// 注意：pass_outcomes 不是 detector，但它和 unforced_out 共享出界/排除位契约，
// 也必须有自己的 runner；否则它在守卫里会被静默跳过（审阅发现的第二个盲区）。
const DETECTOR_ENTRY = {
  baseline_invariant: (pi) =>
    detectInvariants(pi.events ?? [], pi.players ?? {}, DEFAULT_AUDIT_PROFILE),
  unforced_out: (pi) => detectUnforcedOut(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
  inactive_responsibility: (pi) =>
    detectInactiveResponsibility(pi.players ?? {}, DEFAULT_AUDIT_PROFILE),
  ignored_interception_opportunity: (pi) =>
    detectIgnoredInterception(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
  pass_outcomes: (pi) => computePassOutcomes(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
};

// 真实窗口是主输入，但真实数据不一定走遍每个分支（例如真实 pass 都带 detail，于是
// 「无 detail 的普通传球」这条读 result 的路径就不会被走到）。守卫要断言「契约声明的读
// 确实被实现读到」，就必须把这几个分支也喂进去——否则会把真实存在但未被 fixture 覆盖的
// 读误判成僵尸声明。这些合成输入是**为分支覆盖而造**，形状取自 protocol.js 的合法枚举。
const BRANCH_COVERAGE_INPUTS = [
  // 普通传球（无 detail）：走 classifyPassOutcome 的 result 分支。
  {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', x: 50, y: 30, x2: 60, y2: 30, nearest_defender_distance: 12, pass_distance: 10 },
      { index: 1, t: 2, type: 'pass', x: 50, y: 30, x2: 60, y2: 30, nearest_defender_distance: 12, pass_distance: 10 },
    ],
    players: {},
  },
  // 责任快照：走 inactive_responsibility 的 disqualified/moved 分支。
  {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [],
    players: {
      4: [
        { t: 1, x: 5, y: 5, responsibility: 'ball_entered_zone' },
        { t: 4.5, x: 5.05, y: 5, responsibility: 'ball_entered_zone', dead_ball: true },
        { t: 6, x: 5.1, y: 5, responsibility: 'ball_entered_zone', is_gk: true },
        { t: 8, x: 9, y: 5, responsibility: 'ball_entered_zone', moved_toward_goal: true },
        { t: 10, x: 9, y: 9, responsibility: 'ball_entered_zone', moved_toward_ball: true },
      ],
    },
  },
];

test('every contract entry has a drift-guard runner (no silently-skipped entry)', () => {
  // 防「条目没有 runner → 逐条目断言里被静默 continue 跳过」这个盲区：
  // 契约里每个条目都必须能在 DETECTOR_ENTRY 里找到归属 runner。
  for (const id of Object.keys(DETECTOR_FIELD_CONTRACT)) {
    assert.ok(
      typeof DETECTOR_ENTRY[id] === 'function',
      `contract entry ${id} has no runner in the drift guard — its reads would go unchecked`
    );
  }
});

// 逐条目跑遍真实窗口 + 分支覆盖输入，返回 { 条目 id: Set(读到的键) }。
function recordReadsPerDetector() {
  const perDetector = {};
  for (const id of Object.keys(DETECTOR_ENTRY)) perDetector[id] = new Set();
  const inputs = [...FIXTURE.windows.map((w) => w.audit_input), ...BRANCH_COVERAGE_INPUTS];
  for (const input of inputs) {
    for (const [id, run] of Object.entries(DETECTOR_ENTRY)) {
      for (const k of recordReads(input, run)) perDetector[id].add(k);
    }
  }
  return perDetector;
}

// 全部窗口的并集读键（用于「清单里没有僵尸字段」的反向覆盖）。
function recordReadsAcrossFixture() {
  const reads = new Set();
  for (const w of FIXTURE.windows) {
    for (const k of recordAuditReads(w.audit_input)) reads.add(k);
  }
  return reads;
}

test('each detector only reads fields its own contract entry declares', () => {
  // 逐 detector 归属断言（不是并集）：A 读了只登记在 B 名下的字段 → 这条会红。
  const perDetector = recordReadsPerDetector();
  for (const [id, reads] of Object.entries(perDetector)) {
    const entry = DETECTOR_FIELD_CONTRACT[id];
    assert.ok(entry, `detector ${id} has no contract entry`);
    const allowed = allowedReadKeys(entry);
    const undeclared = [...reads].filter((k) => !allowed.has(k) && !AUDIT_INPUT_TOP_LEVEL_KEYS.includes(k));
    assert.deepEqual(
      undeclared,
      [],
      `${id} reads fields not declared in its own contract entry: ${undeclared.join(', ')}`
    );
  }
});

test('no contract read is declared by an entry that does not read it (cross-entry guard)', () => {
  // 反向：契约说条目 X 读字段 F，但 X 实际没读 F（F 只在别的条目下出现）→ 僵尸声明。
  const perDetector = recordReadsPerDetector();
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    // 不静默跳过（pass_outcomes 也有 runner）；缺 runner 由专门用例报错。
    const reads = perDetector[id];
    assert.ok(reads, `no drift-guard runner for ${id}`);
    for (const field of entry.reads) {
      if (AUDIT_INPUT_TOP_LEVEL_KEYS.includes(field)) continue;
      assert.ok(
        reads.has(field),
        `${id} declares read "${field}" but its implementation never reads it`
      );
    }
  }
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
  // 逐 detector 归属守卫的自检：跨 detector 的字段必须被逐 detector 判定拒绝。
  // 例：`corridor_distance` 只登记在 ignored_interception_opportunity 名下，
  // 逐 detector 的允许集里 unforced_out 不该有它。
  const unforcedAllowed = allowedReadKeys(DETECTOR_FIELD_CONTRACT.unforced_out);
  assert.equal(unforcedAllowed.has('corridor_distance'), false);
  assert.equal(unforcedAllowed.has('detail'), true);
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

test('a gap that names a produced field records why the producer is not enough', () => {
  // dead_ball 有生产者（whistle 路径有效），但 isDeadBallEvent 里还有同类死分支
  // （result==="out" / kickoff x2），真实数据里出界/进球后被标成死球。这不是「字段没人产」，
  // 而是「产出的覆盖面不够」——登记为 semantic gap，并断言它的字段确实有生产者，
  // 免得有人把它误当 unproducible 去改 detector（该修的是 derive 层）。
  const gap = KNOWN_GAPS.dead_ball_event_detection;
  assert.equal(gap.kind, 'semantic');
  assert.equal(gap.detector_fields.inactive_responsibility, 'dead_ball');
  const entry = DETECTOR_FIELD_CONTRACT.inactive_responsibility;
  assert.ok(entry.producers.dead_ball, 'dead_ball has a (partial) producer, hence a semantic gap');
  assert.ok(entry.known_gaps.includes('dead_ball_event_detection'));
  // 反向：真实 fixture 确实产出了 dead_ball（whistle 窗口），所以不能登记成 unproducible。
  const dead = allRealSnapshots().filter((s) => s.dead_ball === true);
  assert.ok(dead.length > 0, 'the real fixture must carry produced dead_ball snapshots');
});
