// 同流渲染消融的守护测试。重点是**反证条**：没有它们，「零步伪角」和「t1 复刻」
// 都可能在实现坏掉时仍然全绿。
//
// 覆盖：
//   1. 条件 turn120 的零步反证条：左→停→左，旧口径计 2、条件口径必须计 0；
//   2. 门限边界：步速恰为 0.5 m/s 计入（>=），1.0 档不计；
//   3. 空输入 / 剔门将；
//   4. 五条渲染路径的选择与纯函数：direct=零阶保持、linear 在锚点间、catmull≠linear（曲路径）、
//      t1≠catmull（纹理）、t1 与现行 Game 逐帧一致（复刻自证）；
//   5. 同输入可复现（帧哈希 + PNG 哈希逐位一致）；
//   6. 逐窗采样（121 帧 / 0.2s / 不跨窗拼接）；
//   7. 配对差区间与 R7i 窗表解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, DEFAULT_WINDOW, sha256, sampleEntity, createFrameSampler, sampleWindow,
  windowFeatures, pairedDiff, ablationMarkdown, renderWindowImages, windowsFromR7i,
  sourceHashes, assertStimulusSourcesMatch,
} from './render-ablation.mjs';

const L = 105; const W = 68;
const lineup = Array.from({ length: 22 }, (_, id) => ({
  id, team: id <= 10 ? 'home' : 'away', x: 0.3 + (id % 5) * 0.08, y: 0.25 + Math.floor(id / 5) * 0.1,
}));

// 合成事件流：8 拍 × 0.5s，球员 5 走折线（Catmull 与 T1 都有非零贡献）。
function syntheticEvents() {
  const events = [{ t: 0, type: 'lineup', lineup: lineup.map((p) => ({ ...p })) }];
  for (let k = 0; k < 8; k += 1) {
    const t = k * 0.5;
    const x0 = 0.30 + 0.02 * k; const x1 = 0.30 + 0.02 * (k + 1);
    const y0 = 0.50 + (k % 2 === 0 ? -0.02 : 0.02);
    const y1 = 0.50 + ((k + 1) % 2 === 0 ? -0.02 : 0.02);
    events.push({
      t, type: 'beat',
      movers: [
        { id: 5, from_x: x0, from_y: y0, to_x: x1, to_y: y1 },
        { id: 12, from_x: 0.7 - 0.01 * k, from_y: 0.4, to_x: 0.7 - 0.01 * (k + 1), to_y: 0.4 },
      ],
    });
  }
  return events;
}

// 一维位置序列（米，x 轴）→ 帧（只含指定球员）。
function framesFromXMeters(xs, { id = 5, dt = 0.2, extra = [] } = {}) {
  return xs.map((xm, i) => ({
    t: Math.round(i * dt * 1e6) / 1e6,
    players: [{ id, x: xm / L, y: 0.5 }, ...extra.map((p) => p(i))],
    ball: [0.5, 0.5],
  }));
}

test('条件 turn120 的零步反证条：左→停→左，旧口径计 2、条件口径计 0', () => {
  // 步长 0.5m / 0.2s = 2.5 m/s；中间一帧完全不动。
  const frames = framesFromXMeters([50, 49.5, 49.5, 49]);
  const f = windowFeatures(frames, { dt: 0.2 });
  assert.equal(f.turn120Old, 2, '旧口径（零步也计角）必须复现伪角 2 次');
  assert.equal(f.turn120Cond, 0, '条件口径不得把零步两侧计成转向');
  assert.equal(f.effectiveSteps, 2, '有效步 = 步速 ≥0.5 的两步');
  assert.equal(f.transitions.moveToStop, 1);
  assert.equal(f.transitions.stopToMove, 1);
  assert.ok(Math.abs(f.staticFrac - 1 / 3) < 1e-12);
  // 每球员口径：单球员时总数 == 均值；加一名静止球员后均值减半（对齐 census 口径）。
  assert.equal(f.turn120Old, 2);
  const twoPlayers = frames.map((fr) => ({ ...fr, players: [...fr.players, { id: 12, x: 0.8, y: 0.5 }] }));
  const f2 = windowFeatures(twoPlayers, { dt: 0.2 });
  assert.equal(f2.turn120OldTotal, 2);
  assert.ok(Math.abs(f2.turn120Old - 1) < 1e-12);
});

test('门限边界：步速恰为 0.5 m/s 计入（>=），1.0 档不计', () => {
  // 三步各 0.1m / 0.2s = 0.5 m/s，末步反向 → 在 i=3 处一次 180° 转向。
  const frames = framesFromXMeters([50, 49.9, 49.8, 49.9]);
  const f = windowFeatures(frames, { dt: 0.2 });
  assert.equal(f.turn120CondByThreshold['0.5'], 1);
  assert.equal(f.turn120CondByThreshold['1.0'], 0);
  assert.equal(f.staticFrac, 0, '0.5 m/s 不 <0.5，不得计入静止');
});

test('每米转向率必须是每球员口径（分子除以人数，不能大 nP 倍）', () => {
  // 球员 5 走 3 步各 1m 并折返（2 次 180°）；球员 12 静止（路径 0）。
  // 每球员路径均值 = (3 + 0)/2 = 1.5m；漏掉 /nP 会让每米转向率正好翻倍。
  const base = framesFromXMeters([50, 51, 50, 51]); // 3 步，2 次 180° 折返
  const frames = base.map((fr) => ({ ...fr, players: [...fr.players, { id: 12, x: 0.8, y: 0.5 }] }));
  const f = windowFeatures(frames, { dt: 0.2 });
  assert.equal(f.nPlayers, 2);
  assert.ok(Math.abs(f.turnsPerMeter - f.turn120Old / f.pathLenPerPlayer) < 1e-12,
    `turnsPerMeter ${f.turnsPerMeter} 应等于 turn120Old/pathLenPerPlayer ${f.turn120Old / f.pathLenPerPlayer}`);
  assert.ok(Math.abs(f.condTurnsPerMeter - f.turn120Cond / f.pathLenPerPlayer) < 1e-12,
    `condTurnsPerMeter ${f.condTurnsPerMeter} 应等于 turn120Cond/pathLenPerPlayer`);
  // 反证：若漏了 /nP，值会翻倍（nP=2）。
  const naive = f.turn120OldTotal / f.pathLenPerPlayer;
  assert.ok(Math.abs(f.turnsPerMeter - naive) > 1e-6, '该用例必须能区分「总数/均值」的错误口径');
});

test('空输入与剔门将', () => {
  const empty = windowFeatures([]);
  assert.equal(empty.nPlayers, 0);
  assert.equal(empty.steps, 0);
  assert.equal(empty.turn120Old, 0);
  // 只有门将（id 0/21）→ 无一参与统计。
  const keeperOnly = framesFromXMeters([0, 50, 100], { id: 0 });
  assert.equal(windowFeatures(keeperOnly, { dt: 0.2 }).nPlayers, 0);
});

test('未知渲染模式必须报错（模式选择不是静默回落）', () => {
  assert.throws(() => createFrameSampler(syntheticEvents(), lineup, 'bogus'), /未知渲染模式/);
  assert.deepEqual(MODES, ['movers', 'direct', 'linear', 'catmull', 't1', 'current']);
});

test('direct = 零阶保持：拍内不插值，锚点之间位置不变', () => {
  const events = syntheticEvents();
  const direct = createFrameSampler(events, lineup, 'direct');
  const a = direct.sample(0.55); const b = direct.sample(0.95);
  const p5a = a.players.find((p) => p.id === 5); const p5b = b.players.find((p) => p.id === 5);
  assert.ok(Math.abs(p5a.x - p5b.x) < 1e-12 && Math.abs(p5a.y - p5b.y) < 1e-12, '同一拍内不得变化');
  const linear = createFrameSampler(events, lineup, 'linear');
  const q5 = linear.sample(0.75).players.find((p) => p.id === 5);
  const p5a0 = direct.sample(0.5).players.find((p) => p.id === 5);
  const p5b0 = direct.sample(1.0).players.find((p) => p.id === 5);
  assert.ok(q5.x > Math.min(p5a0.x, p5b0.x) && q5.x < Math.max(p5a0.x, p5b0.x), 'linear 必须落在两锚点之间');
});

test('movers = 只用 beat 端点：拍内线性、未出现者保持', () => {
  const s = createFrameSampler(syntheticEvents(), lineup, 'movers');
  const mid = s.sample(0.25).players.find((p) => p.id === 5);
  assert.ok(Math.abs(mid.x - 0.31) < 1e-12 && Math.abs(mid.y - 0.50) < 1e-12, '拍内线性插值');
  const p7 = s.sample(0.25).players.find((p) => p.id === 7);
  const p7lineup = lineup.find((p) => p.id === 7);
  assert.equal(p7.x, p7lineup.x);
  assert.equal(p7.y, p7lineup.y, '未出现在 movers 的球员保持起点位置');
  const late = s.sample(0.4).players.find((p) => p.id === 5);
  assert.ok(late.x > mid.x && late.x < 0.32, '拍内单调走向 to');
  const to = s.sample(0.5).players.find((p) => p.id === 5);
  assert.ok(Math.abs(to.x - 0.32) < 1e-12 && Math.abs(to.y - 0.52) < 1e-12, '拍末到达 to');
});

test('catmull 与 linear 可区分（曲路径），t1 与 catmull 可区分（纹理）', () => {
  const events = syntheticEvents();
  const linear = createFrameSampler(events, lineup, 'linear');
  const catmull = createFrameSampler(events, lineup, 'catmull');
  const t1 = createFrameSampler(events, lineup, 't1');
  let maxCL = 0; let maxTC = 0;
  for (let k = 0; k <= 40; k += 1) {
    const t = 1 + k * 0.025;
    const a = linear.sample(t).players.find((p) => p.id === 5);
    const b = catmull.sample(t).players.find((p) => p.id === 5);
    const c = t1.sample(t).players.find((p) => p.id === 5);
    maxCL = Math.max(maxCL, Math.hypot((a.x - b.x) * L, (a.y - b.y) * W));
    maxTC = Math.max(maxTC, Math.hypot((b.x - c.x) * L, (b.y - c.y) * W));
  }
  assert.ok(maxCL > 1e-6, `catmull 应在曲路径上偏离 linear（实测 ${maxCL}）`);
  assert.ok(maxTC > 1e-6, `t1 应有纹理偏移（实测 ${maxTC}）`);
});

test('复刻自证：t1 与现行 Game(current) 逐帧一致', () => {
  const events = syntheticEvents();
  const t1 = createFrameSampler(events, lineup, 't1');
  const current = createFrameSampler(events, lineup, 'current');
  let max = 0;
  for (let k = 0; k <= 100; k += 1) {
    const t = k * 0.025;
    const a = t1.sample(t); const b = current.sample(t);
    assert.equal(a.players.length, b.players.length);
    assert.ok(Math.abs(a.ball[0] - b.ball[0]) < 1e-12 && Math.abs(a.ball[1] - b.ball[1]) < 1e-12);
    for (const p of a.players) {
      const q = b.players.find((x) => x.id === p.id);
      max = Math.max(max, Math.abs(p.x - q.x), Math.abs(p.y - q.y));
    }
  }
  assert.ok(max < 1e-12, `t1 复刻与现行链的最大坐标差 ${max}（应 <1e-12）`);
});

test('球也必须走事件间 hold（漏传 ballBounds 会让 t1≠current）', () => {
  // 两拍之间隔 0.5s 真间隙：球锚点 prev 是 evt0 末锚、next 是 evt1 首锚 → 必须 hold。
  const ev = [
    { t: 0, type: 'lineup', lineup: lineup.map((p) => ({ ...p })) },
    { t: 0, type: 'beat', main: { type: 'dribble', subject: 5, x: 0.4, y: 0.5, x2: 0.45, y2: 0.5 } },
    // 第二拍起点故意不接第一拍终点：若漏了 hold 规则，插值会给出 0.525，hold 才是 0.45。
    { t: 1.0, type: 'beat', main: { type: 'dribble', subject: 5, x: 0.6, y: 0.5, x2: 0.65, y2: 0.5 } },
  ];
  const t1 = createFrameSampler(ev, lineup, 't1');
  const cur = createFrameSampler(ev, lineup, 'current');
  const a = t1.sample(0.75); const b = cur.sample(0.75);
  assert.ok(Math.abs(a.ball[0] - 0.45) < 1e-12, `间隙内球必须 hold 在 0.45（实测 ${a.ball[0]}）`);
  assert.ok(Math.abs(a.ball[0] - b.ball[0]) < 1e-12 && Math.abs(a.ball[1] - b.ball[1]) < 1e-12);
});

test('同输入可复现：帧与 PNG 哈希逐位一致', () => {
  const events = syntheticEvents();
  const runOnce = () => {
    const s = createFrameSampler(events, lineup, 't1');
    const frames = sampleWindow(s, 0, DEFAULT_WINDOW);
    return { frames, hash: sha256(JSON.stringify(frames)) };
  };
  const a = runOnce(); const b = runOnce();
  assert.equal(a.hash, b.hash);
  const imgA = renderWindowImages(a.frames, 0);
  const imgB = renderWindowImages(b.frames, 0);
  assert.equal(sha256(imgA.contactPng), sha256(imgB.contactPng));
  assert.equal(sha256(imgA.trajectoryPng), sha256(imgB.trajectoryPng));
});

test('逐窗采样：121 帧、0.2s 步长、首末时刻固定（不跨窗拼接）', () => {
  const s = createFrameSampler(syntheticEvents(), lineup, 'linear');
  const frames = sampleWindow(s, 3, DEFAULT_WINDOW);
  assert.equal(frames.length, 121);
  assert.equal(frames[0].t, 3);
  assert.ok(Math.abs(frames[1].t - frames[0].t - 0.2) < 1e-12);
  assert.ok(Math.abs(frames[120].t - 27) < 1e-9);
});

test('sampleEntity 的 direct/linear 差异只在拍内（锚点时刻相等）', () => {
  const arr = [
    { t: 0, x: 0.2, y: 0.5, evt: 0 },
    { t: 0.5, x: 0.3, y: 0.5, evt: 0 },
    { t: 1.0, x: 0.4, y: 0.5, evt: 1 },
  ];
  const atAnchor = sampleEntity('direct', arr, null, 0.5, 5);
  assert.equal(atAnchor.x, 0.3);
  const mid = sampleEntity('linear', arr, null, 0.25, 5);
  assert.ok(Math.abs(mid.x - 0.25) < 1e-12);
});

test('配对差：区间包含均值、逐窗不应答跨窗拼接', () => {
  const d = pairedDiff([3, 4, 5], [1, 1, 1]);
  assert.equal(d.n, 3);
  assert.equal(d.mean, 3);
  assert.ok(d.lo <= d.mean && d.hi >= d.mean);
  assert.equal(d.nonZero, 3);
  const zero = pairedDiff([2, 2], [2, 2]);
  assert.equal(zero.nonZero, 0);
  assert.equal(zero.mean, 0);
});

test('R7i 窗表解析：12 seed × 2 anchor，id 稳定', () => {
  const fixture = {
    items: [
      { source: 'real', t0: 999, t1: 1023, anchorFrac: 0.35 },
      { source: 'engine', seed: 1204, t0: 3240, t1: 3264, anchorFrac: 0.6 },
      { source: 'engine', seed: 1204, t0: 1944, t1: 1968, anchorFrac: 0.36 },
    ],
  };
  const ws = windowsFromR7i(fixture);
  assert.deepEqual(ws.map((w) => `${w.id}:${w.t0}`), ['eng-1204-36:1944', 'eng-1204-60:3240']);
});

test('★ stimulus 源码哈希硬校验：改一个 viewer 源码哈希必须拒绝拼表（P1-7）', () => {
  const current = sourceHashes();
  const stim = { viewer: { sourceHashes: { ...current } } };
  assert.deepStrictEqual(assertStimulusSourcesMatch(stim), { ok: true, checked: Object.keys(current).length });
  // 单个字段被改（模拟「viewer 源码变了但 wasm 没变」）→ 硬错误。
  const tampered = { viewer: { sourceHashes: { ...current, 'viewer/game.js': '0'.repeat(64) } } };
  assert.throws(() => assertStimulusSourcesMatch(tampered), /源码哈希与当前树不一致/);
  // P1-A：match-metrics.js 也决定全部运动读数，必须在跟踪清单里且被校验。
  const tamperedMetrics = { viewer: { sourceHashes: { ...current, 'viewer/match-metrics.js': 'f'.repeat(64) } } };
  assert.throws(() => assertStimulusSourcesMatch(tamperedMetrics), /viewer\/match-metrics\.js/);
  // 缺清单 / 漏一个已跟踪文件都不得静默通过。
  assert.throws(() => assertStimulusSourcesMatch({ viewer: {} }), /缺少 viewer\.sourceHashes/);
  const partial = { viewer: { sourceHashes: { ...current } } };
  delete partial.viewer.sourceHashes['viewer/game.js'];
  assert.throws(() => assertStimulusSourcesMatch(partial), /缺少已跟踪文件/);
});

test('ablationMarkdown 能渲染合成结果（表格生成不崩）', () => {
  const mk = (v) => Object.fromEntries(
    ['turn120Old', 'turn120Cond', 'turnsPerEffectiveStep', 'staticFrac', 'pathLenPerPlayer', 'speedP50',
      'speedP90', 'speedP99', 'accelP95', 'accelP99', 'rotationTurns', 'rotationPerMeter', 'ballStaticFrac']
      .map((k) => [k, v]),
  );
  const feat = {
    ...mk(1), turn120CondByThreshold: { 0.3: 1, 0.5: 1, 1.0: 1 },
    turn120CondByThresholdPerPlayer: { 0.3: 0.1, 0.5: 0.1, 1.0: 0.1 },
  };
  const r = {
    version: 'test', stimulus: { wasmSha256: 'ab'.repeat(32) }, modes: MODES,
    metrics: [{ key: 'turn120Old', label: '旧 turn120' }, { key: 'staticFrac', label: 'staticFrac' }],
    t1VsCurrent: { maxAbsDelta: 0, mismatchedFrames: 0, checkedFrames: 10 },
    perWindow: [{ id: 'w', seed: 1, t0: 0, features: Object.fromEntries(MODES.map((m) => [m, feat])) }],
    diffs: { 'current-direct': { turn120Old: { mean: 1, lo: 0, hi: 2, n: 1, nonZero: 1 }, staticFrac: { mean: 0, lo: 0, hi: 0, n: 1, nonZero: 0 } } },
  };
  const md = ablationMarkdown(r);
  assert.match(md, /逐窗配对差/);
  assert.match(md, /current-direct/);
});
