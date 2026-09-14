// P10 特征推导证明测试：真实 viewer 形状的捕获 → audit_input → runAudit，
// 在证据确实存在时每个 detector 至少产出一条非 unknown finding；
// 证据缺失时保持 unknown（不伪造引擎内部事实）。
// 无 DOM、无 WASM、无网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';
import { captureObservation } from './observation.js';
import { runAudit } from '../tools/detectors.mjs';
import { validateObservationBundle } from '../tools/bundle.mjs';
import { DETECTOR_FIELD_CONTRACT } from '../tools/detector-field-contract.mjs';

const MATCH_CONFIG = { match_duration_seconds: 2700, demo_mode: false };

const deterministic = () => ({
  idFactory: (() => { let n = 0; return () => `obs-derived-${++n}`; })(),
  now: 1700000000000,
});

// 22 人站位（home 0-10 左半场，away 11-21 右半场）。这是 viewer 可观测的初始站位。
const lineup = [
  [0, 0.02, 0.5], [1, 0.18, 0.3], [2, 0.20, 0.5], [3, 0.18, 0.7],
  [4, 0.30, 0.25], [5, 0.32, 0.5], [6, 0.30, 0.75], [7, 0.40, 0.15],
  [8, 0.40, 0.85], [9, 0.45, 0.5], [10, 0.35, 0.5],
  [21, 0.98, 0.5], [20, 0.85, 0.3], [19, 0.85, 0.7], [18, 0.78, 0.2],
  [17, 0.78, 0.8], [16, 0.72, 0.45], [15, 0.52, 0.75], [14, 0.65, 0.3],
  [13, 0.65, 0.7], [12, 0.60, 0.2], [11, 0.60, 0.8],
];

const lineups = lineup.map(([id, x, y]) => ({ id, team: id <= 10 ? 'home' : 'away', x, y }));

// 有球动作，对应各 detector / derive 层的可观测证据：
//   t=10  无压力传球出界（home 9 在左侧边线传丢，away 防守者全部远在右侧）
//   t=30  横传（home 9 → 落点），用于 **derive 层** corridor_distance /
//         defender_moved_toward_corridor 的生产断言（P32 起 detector 已删，几何事实保留）
//   t=50  责任区站桩（away 15 在球路径上静止 4.5s+，球在 12m 内移动）
//   t=60  几何出界（result=success，落点 x2=1.01 略越右边界 → 米制 106.05 > 105）
const events = [
  { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineups },
  { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
  // unforced_out：落点离左边界 ~0.53m，result=out，最近防守者 ~52m。
  { t: 10, type: 'pass', subject: 9, from: 9, to: 5, x: 0.05, y: 0.5, x2: 0.005, y2: 0.5, speed: 8, result: 'out' },
  // derive 层 corridor 生产：走廊 y=0.5，away 16 (0.72,0.45) 距走廊 ~3.99m。
  { t: 30, type: 'pass', subject: 9, from: 9, to: 5, x: 0.3, y: 0.5, x2: 0.7, y2: 0.5, speed: 8, result: 'success' },
  // inactive_responsibility：球从 (0.45,0.75) 慢速传向 (0.58,0.75)，away 15 在 (0.52,0.75) 静止。
  { t: 50, type: 'pass', subject: 9, from: 9, to: 5, x: 0.45, y: 0.75, x2: 0.58, y2: 0.75, speed: 3, result: 'success' },
  // 几何出界：result=success，但落点略越右边界（engine 用 success，几何证明出界）。
  { t: 60, type: 'pass', subject: 9, from: 9, to: 5, x: 0.05, y: 0.5, x2: 1.01, y2: 0.5, speed: 8, result: 'success' },
];

function makeGame() {
  return new Game(events, lineups, 'continuous');
}

function captureAt(t) {
  const game = makeGame();
  game.seekTo(t);
  return captureObservation({
    game,
    statement: '',
    selectedEntities: [],
    window: { before: 5, after: 5 },
    seed: 42,
    config: MATCH_CONFIG,
    sourceRevision: 'abc123',
    opts: deterministic(),
  });
}

const find = (findings, detectorId, severity) =>
  findings.find((f) => f.detector_id === detectorId && f.severity === severity);

test('viewer capture → audit_input → runAudit: unforced_out produces a realism_warning', () => {
  const bundle = captureAt(10);
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, true, JSON.stringify(errors));
  const { findings } = runAudit(bundle.audit_input);
  const f = find(findings, 'unforced_out', 'realism_warning');
  assert.ok(f, `expected an unforced_out realism_warning; got ${JSON.stringify(findings)}`);
  assert.ok(f.features.defender_distance > 8);
  // boundary_distance is computable for an out pass landing near the line.
  assert.ok(typeof f.features.boundary_distance === 'number');
  assert.ok(f.features.boundary_distance < 3.0);
});

// P32（#36）：`ignored_interception_opportunity` detector 已彻底删除，其「走廊可达 → 告警」
// 的 viewer 端到端用例一并删除。**保留**下面依赖同一 t=30 事件的 derive 层断言
// （`derived pass features are honest…`）——它测的是 corridor_distance /
// defender_moved_toward_corridor 的**生产**仍在（未来防守反应研究用），与 detector 消费无关。

test('viewer capture → audit_input → runAudit: inactive_responsibility produces a realism_warning', () => {
  const bundle = captureAt(51);
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, true, JSON.stringify(errors));
  const { findings } = runAudit(bundle.audit_input);
  const f = findings.find(
    (x) => x.detector_id === 'inactive_responsibility' && x.severity === 'realism_warning' && x.entity_id === 15
  );
  assert.ok(f, `expected an inactive_responsibility realism_warning for player 15; got ${JSON.stringify(findings)}`);
  assert.ok(f.features.static_duration >= 3.0);
  assert.equal(f.features.responsibility_source, 'viewer-derived');
});

test('viewer capture → audit_input → runAudit: geometric out-of-bounds landing yields unforced_out warning', () => {
  const bundle = captureAt(60);
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, true, JSON.stringify(errors));
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass' && e.t === 60);
  assert.ok(pass, 'window should include the t=60 pass');
  assert.ok(pass.x2 > 105, `normalized x2 slightly >1 becomes meter >105, got ${pass.x2}`);
  const { findings } = runAudit(bundle.audit_input);
  const f = find(findings, 'unforced_out', 'realism_warning');
  assert.ok(f, `expected a geometric unforced_out realism_warning; got ${JSON.stringify(findings)}`);
  assert.equal(f.features.out_evidence, 'landing_out_of_bounds');
  assert.equal(f.features.out_reason, 'out_of_bounds_landing');
  assert.equal(f.features.boundary_distance, Math.round((1.01 * 105 - 105) * 1000) / 1000);
});

test('derived pass features are honest and marked with their source', () => {
  const bundle = captureAt(30);
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass' && e.t === 30);
  assert.ok(pass, 'window should include the t=30 pass');
  // 几何事实：米制坐标 + 距离 + 速度 + 来源标注。
  assert.equal(pass.x, 31.5);
  assert.equal(pass.pass_distance, 42);
  assert.equal(pass.pass_speed, 8);
  assert.equal(pass.pass_speed_source, 'event.speed');
  assert.equal(typeof pass.nearest_defender_distance, 'number');
  assert.equal(typeof pass.corridor_distance, 'number');
  assert.equal(pass.defender_moved_toward_corridor, false);
  // bundle 仍过凭证校验。
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('evidence genuinely unavailable still preserves unknown (no fabrication)', () => {
  // 稀疏数据：只有两个主队球员、没有对方防守者锚点 → 无防守压力/走廊证据。
  // result=out 的传球也无法证明无压力 → unforced_out 必须输出 unknown 而非臆断。
  const sparseEvents = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [
      { id: 0, x: 0.02, y: 0.5, team: 'home' }, { id: 1, x: 0.18, y: 0.3, team: 'home' },
    ]},
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 3, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.01, y2: 0.5, speed: 8, result: 'out' },
  ];
  const game = new Game(sparseEvents, [], 'continuous');
  game.seekTo(3);
  const bundle = captureObservation({
    game, seed: 42, config: MATCH_CONFIG, opts: deterministic(),
  });
  const { findings } = runAudit(bundle.audit_input);
  // P32：ignored_interception_opportunity 已删，不再在此列表中（它不产 finding 了）。
  for (const detectorId of ['unforced_out', 'inactive_responsibility']) {
    const real = findings.find((f) => f.detector_id === detectorId && f.severity !== 'unknown');
    assert.equal(real, undefined, `detector ${detectorId} must not fabricate a finding`);
    const unknown = findings.find((f) => f.detector_id === detectorId && f.severity === 'unknown');
    assert.ok(unknown, `detector ${detectorId} should emit unknown when evidence is missing`);
  }
});

// --- P21 派生层字段保留契约（活体守卫） -------------------------------------
// 契约清单（tools/detector-field-contract.mjs）声明 `detail` 等字段由某层生产。但
// tools/detector-field-contract.test.mjs 吃的是**冻结的** fixture 快照 + 只扫
// tools/detectors.mjs 源码——**它看不见 viewer/derive-audit-features.js 是否真的把
// 字段保留下来**。审阅实测：在 derivePassEvent 里 `delete out.detail` 后，tools 368 绿、
// viewer 288 绿，而真实出界球完整复现原始症状（unknown + out_count=0）。
// 这一组测试走**真实 derive 链路**（现场 capture，不读落盘 fixture），把那一层钉住。

test('derive layer preserves the fields the contract says it produces (live capture)', () => {
  // 引擎直出字段必须原样保留到 audit_input（derive 层用 {...e} 复制，不得删改）。
  // 对事件本身携带的每个字段都断言保留——不预设某一事件带哪些字段。
  const bundle = captureAt(30);
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass');
  assert.ok(pass, 'window should include a pass');
  const engineEvent = events.find((e) => e.type === 'pass' && e.t === 30);
  for (const f of Object.keys(engineEvent)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(pass, f),
      `derive layer dropped engine field "${f}" — audit_input no longer carries it`
    );
  }
  // 对带 detail 的真实形状单独钉（下面那条用例覆盖出界场景）。
});

test('P27: derive layer meter-izes out_pos to match x2/y2 units (live guard)', () => {
  // 审计层坐标单位必须一致：x2/y2 归一化 → 米制，out_pos 也必须米制（且保留越界符号）。
  // 若 derive 层漏了 out_pos，它会留在归一化单位、与 x2/y2 混用两套单位（阶段 2/3 埋雷）。
  const outEvents = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineups },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    // P27 新形状：result=out + out_side + out_pos（真实越界，y 为负）+ x2/y2 场内投影。
    // 起点放主队后场无人区（防守者全在右半场 x≥0.52）→ 无压力，unforced_out 才产 warning。
    { t: 20, type: 'pass', subject: 9, from: 9, x: 0.1, y: 0.1, x2: 0.1, y2: 0, speed: 15,
      result: 'out', out_side: 'sideline', out_pos: [0.1, -0.03], detail: 'out_sideline' },
  ];
  const game = new Game(outEvents, lineups, 'continuous');
  game.seekTo(20);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass');
  // 米制：0.1×105 = 10.5；-0.03×68 ≈ -2.04（越界符号保留）。
  assert.ok(Math.abs(pass.x2 - 10.5) < 0.01, `x2 应米制: ${pass.x2}`);
  assert.ok(Array.isArray(pass.out_pos), 'out_pos must survive the derive layer');
  assert.ok(Math.abs(pass.out_pos[0] - 10.5) < 0.01, `out_pos[0] 应米制: ${pass.out_pos[0]}`);
  assert.ok(pass.out_pos[1] < 0, `out_pos[1] 应为负（越界符号保留）: ${pass.out_pos[1]}`);
  // 出界分类不受影响（走 result 主路径）。
  const { findings } = runAudit(bundle.audit_input);
  const f = findings.find((x) => x.detector_id === 'unforced_out' && x.event_index === pass.index);
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.features.out_evidence, 'event.result');
});

test('a P21 legacy out-of-play bundle keeps its detail through the derive layer (D1 compat guard)', () => {
  // 用 detail 型出界（不是几何型）：这正是 P21 D1 修的形状，**P21 时代的引擎形状**（当前引擎
  // 自 P27 起改发 result="out"；见上面那条 P27 用例）。此用例的价值是钉住 **P21 兼容分支**：
  // 旧 bundle（只有 detail，无 result/out_side）经 derive 层仍必须保住 detail 并被判出界——
  // 若 derive 层丢掉 detail，这里会从 realism_warning 退化成 unknown。这是兼容路径的活体守卫，
  // 不是当前引擎形状的描述。
  const outEvents = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineups },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    // P21 旧形状：result=contested + detail=out_* + 落点被 clamp 到边界（y2=0）。
    // home 9 在左半场无人区传球，防守者都在右半场 → 无压力（nearest_defender_distance > 8）。
    { t: 20, type: 'pass', subject: 9, from: 9, x: 0.42, y: 0.72, x2: 0.42, y2: 0, speed: 15, result: 'contested', detail: 'out_sideline' },
  ];
  const game = new Game(outEvents, lineups, 'continuous');
  game.seekTo(20);
  const bundle = captureObservation({
    game, seed: 42, config: MATCH_CONFIG, opts: deterministic(),
  });
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass');
  assert.equal(pass.detail, 'out_sideline', 'derive layer must preserve the engine detail field');
  const { findings, pass_outcomes } = runAudit(bundle.audit_input);
  const f = findings.find((x) => x.detector_id === 'unforced_out' && x.event_index === pass.index);
  assert.ok(f, JSON.stringify(findings));
  assert.notEqual(f.severity, 'unknown', 'a real out pass must not degrade to unknown');
  assert.equal(f.features.out_evidence, 'event.detail');
  assert.ok(
    pass_outcomes.unpressured.out_count + pass_outcomes.pressured.out_count >= 1,
    'the out pass must be counted as out'
  );
});

// 契约声称「derive 层生产」的每个字段，都必须能被真实 capture 产出。只钉 t/x/y 是不够的：
// 审阅实测，删掉 is_gk / dead_ball / moved_toward_goal / moved_toward_ball /
// defender_moved_toward_corridor / defender_id 的生产者，tools+viewer 两套全绿，而
// detector 行为实际会变（如 is_gk 位丢失 → 门将被当站桩候选，产 realism_warning）。
// 这组守卫把契约里 producer:'derive' 的字段逐个用真实 capture 钉住。
const DEAD_BALL_EVENTS = [
  { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineups },
  { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
  { t: 10, type: 'pass', subject: 9, from: 9, to: 5, x: 0.3, y: 0.5, x2: 0.7, y2: 0.5, speed: 8, result: 'success' },
  { t: 50, type: 'pass', subject: 9, from: 9, to: 5, x: 0.45, y: 0.75, x2: 0.58, y2: 0.75, speed: 3, result: 'success' },
  { t: 80, type: 'whistle', subject: 0, x: 0.5, y: 0.5 },
];

function collectCapturedKeys(times) {
  const eventKeys = new Set();
  const snapshotKeys = new Set();
  for (const t of times) {
    const game = new Game(DEAD_BALL_EVENTS, lineups, 'continuous');
    game.seekTo(t);
    const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
    for (const e of bundle.audit_input.events) {
      for (const k of Object.keys(e)) eventKeys.add(k);
    }
    for (const s of Object.values(bundle.audit_input.players).flat()) {
      for (const k of Object.keys(s)) snapshotKeys.add(k);
    }
  }
  return { eventKeys, snapshotKeys };
}

test('derive layer produces every field the contract marks producer:derive (live capture)', () => {
  // t=51 触发 responsibility/moved_toward_*，t=80 触发 dead_ball；pass 事件触发 defender_*。
  const { eventKeys, snapshotKeys } = collectCapturedKeys([51, 80]);
  const produced = new Set([...eventKeys, ...snapshotKeys]);
  assert.ok(snapshotKeys.size > 3, 'capture should produce more than the skeleton snapshot fields');

  for (const [entryId, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const [field, producer] of Object.entries(entry.producers)) {
      if (producer !== 'derive') continue;
      assert.ok(
        produced.has(field),
        `${entryId} contract says "${field}" is produced by the derive layer, but no live ` +
          `capture ever emits it — the derive layer dropped its producer`
      );
    }
  }
  // 逐字段点名断言（比上面更直白，失败时一眼看出丢了哪个）。
  for (const f of [
    'is_gk', 'dead_ball', 'moved_toward_goal', 'moved_toward_ball',
    'responsibility', 'responsibility_source',
  ]) {
    assert.ok(snapshotKeys.has(f), `derive layer dropped snapshot field "${f}"`);
  }
  for (const f of ['defender_id', 'defender_moved_toward_corridor']) {
    assert.ok(eventKeys.has(f), `derive layer dropped pass-event field "${f}"`);
  }
});

test('derive layer produces defender_moved_toward_corridor:true when a defender closes (live)', () => {
  // 真实数据里该字段全是 false（实测 fixture true=0 / false=4），所以「删掉 true 分支」
  // 不会被任何真实窗口发现。这里构造一个防守者确实朝走廊移动的 capture，把 true 分支钉住
  // ——否则删掉 `out.defender_moved_toward_corridor = true;` 两套测试全绿（审阅实测）。
  const movLineup = [
    { id: 0, team: 'home', x: 0.02, y: 0.5 },
    { id: 9, team: 'home', x: 0.45, y: 0.5 },
    { id: 16, team: 'away', x: 0.72, y: 0.2 },
  ];
  const movEvents = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: movLineup },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    // home 9 沿 y=0.5 直传；away 16 从 y=0.2 跑到 y=0.5（朝走廊移动）。
    { t: 30, type: 'pass', subject: 9, from: 9, to: 5, x: 0.3, y: 0.5, x2: 0.7, y2: 0.5, speed: 8, result: 'success' },
    { t: 30, type: 'beat', movers: [{ id: 16, from_x: 0.72, from_y: 0.2, to_x: 0.72, to_y: 0.5, speed: 8, action: 'run' }] },
    { t: 40, type: 'beat', movers: [{ id: 16, from_x: 0.72, from_y: 0.5, to_x: 0.72, to_y: 0.5, speed: 8, action: 'run' }] },
  ];
  const game = new Game(movEvents, movLineup, 'continuous');
  game.seekTo(30);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const pass = bundle.audit_input.events.find((e) => e.type === 'pass');
  assert.equal(
    pass.defender_moved_toward_corridor,
    true,
    'derive layer must set the true branch when a defender closes on the corridor'
  );
});

test('the dropped-snapshot-field guard has teeth (self-check)', () => {
  // 自检：手工构造一个「缺 is_gk 的快照集合」，确认上面的断言会拒绝它。防「守卫永远绿」。
  const { snapshotKeys } = collectCapturedKeys([51]);
  assert.equal(snapshotKeys.has('is_gk'), true, 'real capture must produce is_gk');
  const withoutGk = new Set(snapshotKeys);
  withoutGk.delete('is_gk');
  const dropped = ['is_gk'].filter((f) => !withoutGk.has(f));
  assert.deepEqual(dropped, ['is_gk'], 'guard must surface a dropped snapshot field');
});

test('both goalkeepers are marked is_gk, not just the home one (live)', () => {
  // 只断言「is_gk 键存在」太弱：把标记改成只打主队门将（删掉 `|| id === 21`）仍会全绿，
  // 而真实数据上客队门将（id 21）若丢位会被 inactive_responsibility 当站桩候选
  // （审阅实测：60 次真实 capture 里有 1 次告警数从 2 变 3）。逐个断言两台门将都带位。
  const { snapshotKeys } = collectCapturedKeys([51, 80]);
  assert.ok(snapshotKeys.has('is_gk'), 'capture must produce is_gk');
  const game = new Game(DEAD_BALL_EVENTS, lineups, 'continuous');
  game.seekTo(51);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const players = bundle.audit_input.players;
  for (const gkId of [0, 21]) {
    const snaps = players[gkId];
    assert.ok(Array.isArray(snaps) && snaps.length > 0, `expected snapshots for keeper ${gkId}`);
    assert.ok(
      snaps.every((s) => s.is_gk === true),
      `keeper ${gkId} snapshots must all carry is_gk:true`
    );
  }
});

test('a goalkeeper snapshot is never flagged as an inactive defender (is_gk live)', () => {
  // is_gk 位丢失的**行为后果**：门将（id 0/21）静止时会被 inactive_responsibility 当站桩
  // 候选产 realism_warning。真实 capture 里门将位必须存在，且门将不产该告警。
  const { snapshotKeys } = collectCapturedKeys([80]);
  assert.ok(snapshotKeys.has('is_gk'), 'capture must mark goalkeeper snapshots with is_gk');
  const game = new Game(DEAD_BALL_EVENTS, lineups, 'continuous');
  game.seekTo(80);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const { findings } = runAudit(bundle.audit_input);
  const warnings = findings.filter(
    (f) => f.detector_id === 'inactive_responsibility' && f.severity === 'realism_warning'
  );
  // 死球窗口（whistle）下不应有站桩告警（dead_ball 位 + is_gk 位共同兜住）。
  assert.deepEqual(warnings, [], JSON.stringify(warnings));
});

test('derive layer produces moved_toward_goal:true when a player advances (live)', () => {
  // 与 defender_moved_toward_corridor 同理：真实 fixture 里这两个位可能全 false，
  // 「删掉 true 分支」不会被真实窗口发现。构造一个球员明确朝球门推进的 capture 钉住它——
  // 否则该位若退化，inactive_responsibility 会把移动中的球员误报为站桩。
  const lineup = [
    { id: 0, team: 'home', x: 0.02, y: 0.5 },
    { id: 2, team: 'home', x: 0.30, y: 0.5 },
    { id: 9, team: 'home', x: 0.45, y: 0.5 },
    { id: 16, team: 'away', x: 0.72, y: 0.45 },
    { id: 15, team: 'away', x: 0.52, y: 0.75 },
  ];
  const evts = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 50, type: 'pass', subject: 9, from: 9, to: 5, x: 0.45, y: 0.75, x2: 0.58, y2: 0.75, speed: 3, result: 'success' },
    { t: 50, type: 'beat', movers: [{ id: 2, from_x: 0.30, from_y: 0.5, to_x: 0.62, to_y: 0.5, speed: 8, action: 'run' }] },
    { t: 55, type: 'beat', movers: [{ id: 2, from_x: 0.62, from_y: 0.5, to_x: 0.95, to_y: 0.5, speed: 8, action: 'run' }] },
  ];
  const game = new Game(evts, lineup, 'continuous');
  game.seekTo(51);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const snaps = Object.values(bundle.audit_input.players).flat();
  assert.ok(
    snaps.some((s) => s.moved_toward_goal === true),
    'derive layer must set moved_toward_goal:true for a player advancing toward goal'
  );
});

test('derive layer produces moved_toward_ball:true when a player closes on the ball (live)', () => {
  const lineup = [
    { id: 0, team: 'home', x: 0.02, y: 0.5 },
    { id: 2, team: 'home', x: 0.30, y: 0.2 },
    { id: 9, team: 'home', x: 0.45, y: 0.5 },
    { id: 16, team: 'away', x: 0.72, y: 0.45 },
    { id: 15, team: 'away', x: 0.52, y: 0.75 },
  ];
  const evts = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 50, type: 'pass', subject: 9, from: 9, to: 5, x: 0.45, y: 0.75, x2: 0.58, y2: 0.75, speed: 3, result: 'success' },
    // id 2 从 (0.30,0.20) 跑向球的落点附近 (0.58,0.70) → 到球距离明显减小。
    { t: 50, type: 'beat', movers: [{ id: 2, from_x: 0.30, from_y: 0.2, to_x: 0.58, to_y: 0.7, speed: 8, action: 'run' }] },
    { t: 55, type: 'beat', movers: [{ id: 2, from_x: 0.58, from_y: 0.7, to_x: 0.58, to_y: 0.75, speed: 8, action: 'run' }] },
  ];
  const game = new Game(evts, lineup, 'continuous');
  game.seekTo(51);
  const bundle = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const snaps = Object.values(bundle.audit_input.players).flat();
  assert.ok(
    snaps.some((s) => s.moved_toward_ball === true),
    'derive layer must set moved_toward_ball:true for a player closing on the ball'
  );
});
