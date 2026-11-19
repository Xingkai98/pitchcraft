// motion-census 纯函数守护：口径用手算/合成的帧与事件钉死（不依赖 wasm/真实数据，CI 必跑）。
//
// 最关键的一条是「零步反证条」：左→停→左 在旧口径计 2 次大角转向，条件口径必须计 0。
// 这条断言在 `conditional` 分支被改成「不看门限」时会红——定向变异验证见
// `openspec/changes/p155-measurement-instrument/notes/motion-census.md`。
import { test } from 'node:test';
import assert from 'node:assert';
import {
  censusOfWindow, censusWindows, cutTimeWindows, summarizeCensus, quantile,
  phaseTimeline, phaseAt, classifyBallIntervals, aggregateDecomposition, decomposeBallStatic,
  decomposeWindows, BALL_SOURCES, SPEED_GATES, STATIC_GATES, BALL_STATIC_GATES,
  assertStimulusWasmIdentity, assertStimulusEventIdentity, assertStimulusWindowsMatch,
} from './motion-census.mjs';

const PITCH = [100, 50]; // 合成球场：x 100m / y 50m，便于手算
const dt = 0.2;

const P = (t, positions, ball = null) => ({
  t,
  pitchMeters: PITCH,
  players: positions.filter(Boolean).map(([id, x, y]) => ({ id, x, y })),
  ball,
});

// 单球员轨迹：xs 为归一化 x 序列（y 恒 0.5），从 t0 起每 dt 一帧。
const trajectory = (xs, { id = 1, y = 0.5, t0 = 0 } = {}) =>
  xs.map((x, i) => P(t0 + i * dt, [[id, x, y]]));

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('零步反证条：左→停→左 不计条件转向，但旧口径计 2 次', () => {
  // 每步 1.0m / 0.2s = 5 m/s；中间一帧原地（速度 0）。
  const frames = trajectory([0.50, 0.49, 0.49, 0.48]);
  const r = censusOfWindow(frames);
  assert.strictEqual(r.turn120Old, 2, '旧口径必须把两次 atan2 跳变都计入（历史口径）');
  for (const g of SPEED_GATES) {
    assert.strictEqual(r.conditional[g].turnsPerPlayer, 0, `条件口径 @${g} 不应计零步伪角`);
    assert.strictEqual(r.conditional[g].effectivePairs, 0, `@${g} 无有效步对`);
  }
  // 静止档：中间那一步（速度 0）在 0.5 档为静止 → 1/3。
  near(r.staticFrac[0.5], 1 / 3, 1e-12);
});

test('真转向（两步都 ≥0.5 m/s）在旧/条件口径都计 1 次', () => {
  const frames = trajectory([0.50, 0.49, 0.50]); // 左 → 右
  const r = censusOfWindow(frames);
  assert.strictEqual(r.turn120Old, 1);
  for (const g of SPEED_GATES) assert.strictEqual(r.conditional[g].turnsPerPlayer, 1, `@${g}`);
  assert.strictEqual(r.conditional[0.5].effectivePairs, 1);
});

test('门限边界：0.5001 m/s 计入 @0.5，0.4999 m/s 不计入 @0.5', () => {
  // dt=0.2s；dx（归一化）= speed*dt/100。
  const xAt = (speed) => 0.5 + speed * dt / PITCH[0];
  const fast = [0.50, 0.50 - (0.5001 * dt) / PITCH[0], 0.50]; // 左→右，两步 0.5001 m/s
  const slow = [0.50, 0.50 - (0.4999 * dt) / PITCH[0], 0.50]; // 左→右，两步 0.4999 m/s
  const rf = censusOfWindow(trajectory(fast));
  const rs = censusOfWindow(trajectory(slow));
  assert.strictEqual(rf.conditional[0.5].turnsPerPlayer, 1, '≥ 门限应计入（闭区间）');
  assert.strictEqual(rs.conditional[0.5].turnsPerPlayer, 0, '< 门限不应计入');
  assert.strictEqual(rs.conditional[0.3].turnsPerPlayer, 1, '0.4999 应计入 0.3 档');
  assert.strictEqual(rf.conditional[1.0].turnsPerPlayer, 0, '0.5001 不应计入 1.0 档');
  // xAt 只用于把语义写清楚（避免“0.5 怎么来的”歧义）。
  assert.ok(Number.isFinite(xAt(0.5001)));
});

test('有效步/分母并列：条件转向率不是无分母比值', () => {
  const frames = trajectory([0.50, 0.49, 0.50, 0.49, 0.48]); // 每步 5 m/s，4 步
  const r = censusOfWindow(frames);
  const c = r.conditional[0.5];
  assert.strictEqual(c.effectiveSteps, 4);
  assert.strictEqual(c.effectivePairs, 3);
  near(c.turnsPerEffectivePair, c.turnsPerPlayer / 3, 1e-12);
  near(c.turnsPerEffectiveStep, c.turnsPerPlayer / 4, 1e-12);
  // 每米转向率分母 = 有效步路径（4 × 1m）。
  near(c.turnsPerMeter, c.turnsPerPlayer / 4, 1e-12);
  assert.ok(c.effectivePathM > 0);
});

test('move/stop 转移：move→stop / stop→move / move→move 计数（0.5 门限）', () => {
  // 步速：5, 0, 5, 5 → 转移 m→s, s→m, m→m 各 1。
  const frames = trajectory([0.50, 0.49, 0.49, 0.48, 0.47]);
  const r = censusOfWindow(frames);
  assert.strictEqual(r.transitions.moveStop, 1);
  assert.strictEqual(r.transitions.stopMove, 1);
  assert.strictEqual(r.transitions.moveMove, 1);
  assert.strictEqual(r.transitions.stopStop, 0);
  assert.strictEqual(r.transitions.n, 3);
  near(r.transitions.moveStopShare, 1 / 3, 1e-12);
});

test('空输入 / 单帧 / 全缺帧不炸，返回零值', () => {
  for (const frames of [[], [P(0, [[1, 0.5, 0.5]])], [{ t: 0, players: [] }, { t: 0.2, players: [] }]]) {
    const r = censusOfWindow(frames);
    assert.strictEqual(r.turn120Old, null);
    assert.strictEqual(r.nSteps, 0);
    assert.strictEqual(r.ball.nSteps, 0);
  }
  assert.deepStrictEqual(censusWindows([], { windowSec: 24 }), []);
});

test('缺帧/采样缺口不跨缺口求方向差', () => {
  // 第 2 帧缺该球员 → 两侧步都不应参与步对。
  const frames = [P(0, [[1, 0.50, 0.5]]), P(0.2, [[1, 0.49, 0.5]]), P(0.4, []), P(0.6, [[1, 0.48, 0.5]]), P(0.8, [[1, 0.49, 0.5]])];
  const r = censusOfWindow(frames);
  // 只有最后两步连续（0.48→0.49），方向与孤立步不组成步对 → 条件/旧都不计转向。
  assert.strictEqual(r.turn120Old, 0);
  assert.strictEqual(r.conditional[0.5].turnsPerPlayer, 0);
  assert.strictEqual(r.nSteps, 2); // 只有 0→0.2 与 0.6→0.8 两个连续步（缺口两侧各断一次）
});

test('球静止档：0.2/0.5/2.0 各自分母为球步数', () => {
  // 球速：1 m/s（0.1s 内 0.1m）与 0 m/s 两段。
  const frames = [
    P(0, [[1, 0.5, 0.5]], [0.5, 0.5]),
    P(0.2, [[1, 0.5, 0.5]], [0.502, 0.5]), // 0.2m / 0.2s = 1 m/s
    P(0.4, [[1, 0.5, 0.5]], [0.502, 0.5]), // 0 m/s
  ];
  const r = censusOfWindow(frames);
  assert.strictEqual(r.ball.nSteps, 2);
  near(r.ballStaticFrac[0.2], 0.5, 1e-12);
  near(r.ballStaticFrac[0.5], 0.5, 1e-12);
  near(r.ballStaticFrac[2.0], 1, 1e-12); // 1 m/s 也 <2
});

test('ballFill 帧不参与球指标主口径（补全球位是启发式，不是观测）', () => {
  const frames = [
    P(0, [[1, 0.5, 0.5]], [0.5, 0.5]),
    { ...P(0.2, [[1, 0.5, 0.5]], [0.6, 0.5]), ballFill: 1 }, // 补全帧：应断开
    P(0.4, [[1, 0.5, 0.5]], [0.61, 0.5]),
  ];
  const r = censusOfWindow(frames);
  // 原始球帧只有 0 与 0.4 两帧，但中间被 fill 帧断开 → 没有连续区间，球步数 0。
  assert.strictEqual(r.ball.nSteps, 0);
  // 采信补全时才有 2 段。
  const rAll = censusOfWindow(frames, { rawBallOnly: false });
  assert.strictEqual(rAll.ball.nSteps, 2);
});

test('逐窗不拼接：summarizeCensus 对窗级标量取均值，不是池化', () => {
  const rows = [{ v: 0, n: 1 }, { v: 10, n: 1000 }];
  const s = summarizeCensus(rows);
  assert.strictEqual(s.v.mean, 5); // (0+10)/2，不是 (0*1+10*1000)/1001
  assert.strictEqual(s.v.n, 2);
  // 窗口切分：48s 恒速轨迹 → 2 个 24s 窗。
  const frames = trajectory(Array.from({ length: 241 }, (_, i) => 0.2 + i * 0.002));
  const wins = cutTimeWindows(frames, { windowSec: 24 });
  assert.strictEqual(wins.length, 2);
});

test('速度分位用 R type-7（与 match-metrics 同口径）', () => {
  const sorted = [1, 2, 3, 4];
  near(quantile(sorted, 0.5), 2.5);
  near(quantile(sorted, 0.9), 3.7); // h=(4-1)*0.9=2.7 → 3 + 0.7*(4-3)
  assert.strictEqual(quantile([], 0.5), null);
});

test('方向对称性：底/顶与左/右使用率可手算', () => {
  // 4 个样本：底 1、顶 1、左 2、右 2。
  const frames = [
    P(0, [[1, 0.25, 0.05], [2, 0.25, 0.95], [3, 0.75, 0.5], [4, 0.75, 0.5]]),
  ];
  const r = censusOfWindow([frames[0], P(0.2, [[1, 0.25, 0.05], [2, 0.25, 0.95], [3, 0.75, 0.5], [4, 0.75, 0.5]])]);
  near(r.symmetry.bottomShare, 0.25, 1e-12);
  near(r.symmetry.topShare, 0.25, 1e-12);
  near(r.symmetry.bottomMinusTop, 0, 1e-12);
  near(r.symmetry.leftShare, 0.5, 1e-12);
  near(r.symmetry.leftMinusRight, 0, 1e-12);
  // 门将不计入对称性样本。
  const withGk = censusOfWindow([P(0, [[0, 0.02, 0.5], [1, 0.5, 0.5]]), P(0.2, [[0, 0.02, 0.5], [1, 0.5, 0.5]])]);
  assert.strictEqual(withGk.symmetry.n, 2);
});

// ── 球静止来源分解 ───────────────────────────────────────────────────────

test('phaseTimeline：五类来源与同 t 的 beat 不覆盖动作事件', () => {
  const events = [
    { t: 0, type: 'kickoff', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 },
    { t: 0.5, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.503, y2: 0.5 } }, // 0.3m → hold
    { t: 1, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.53, y2: 0.5 } }, // 3m → dribble
    { t: 1.5, type: 'beat', ball: { x: 0.6, y: 0.5, loose: true } },
    { t: 2, type: 'pass', x: 0.5, y: 0.5, x2: 0.6, y2: 0.5, speed: 14 },
    { t: 2.5, type: 'beat', movers: [{ id: 1 }] }, // 飞行中的 beat：不重置
    { t: 3, type: 'pass', result: 'out', detail: 'out_sideline', x: 0.5, y: 0.9, x2: 1.0, y2: 0.9, speed: 14 },
    { t: 4, type: 'foul' },
    { t: 4.5, type: 'pass', detail: 'free_kick', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 },
  ];
  const tl = phaseTimeline(events);
  assert.strictEqual(phaseAt(tl, 0.1), 'highlight_flight');
  assert.strictEqual(phaseAt(tl, 0.7), 'carrier_hold');
  assert.strictEqual(phaseAt(tl, 1.2), 'carrier_dribble');
  assert.strictEqual(phaseAt(tl, 1.7), 'loose');
  assert.strictEqual(phaseAt(tl, 2.2), 'highlight_flight');
  assert.strictEqual(phaseAt(tl, 2.7), 'highlight_flight', '飞行中的空 beat 不应把相位重置');
  // 出界 pass 先飞、后死球（dx=0.5×105=52.5m / 14 ≈ 3.75s → 6.75 起死球）
  assert.strictEqual(phaseAt(tl, 6.0), 'highlight_flight');
  assert.strictEqual(phaseAt(tl, 6.9), 'restart_dead');
  // 犯规 → 死球；free_kick → 飞行。
  const tl2 = phaseTimeline([
    { t: 4, type: 'foul' },
    { t: 4.5, type: 'pass', detail: 'free_kick', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 },
  ]);
  assert.strictEqual(phaseAt(tl2, 4.2), 'restart_dead');
  assert.strictEqual(phaseAt(tl2, 4.6), 'highlight_flight');
  // hold 阈值：1.0m 以下 hold，以上 dribble。
  const tlHold = phaseTimeline([{ t: 1, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.5094, y2: 0.5 } }]); // ~0.99m
  const tlDrib = phaseTimeline([{ t: 1, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.5106, y2: 0.5 } }]); // ~1.11m
  assert.strictEqual(tlHold[tlHold.length - 1].why.startsWith('main'), true);
  assert.strictEqual(tlHold[tlHold.length - 1].phase, 'carrier_hold');
  assert.strictEqual(tlDrib[tlDrib.length - 1].phase, 'carrier_dribble');

  // 同 t：动作事件（pass）必须覆盖 beat.main（否则会把飞行误判成持球）。
  const tlSameT = phaseTimeline([
    { t: 1, type: 'pass', x: 0.5, y: 0.5, x2: 0.6, y2: 0.5, speed: 14 },
    { t: 1, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.53, y2: 0.5 } },
  ]);
  assert.strictEqual(phaseAt(tlSameT, 1.05), 'highlight_flight');

  // 预约的 restart（出界飞行结束）在同一 t 遇到 beat.main 时，应让恢复比赛的 beat 覆盖，
  // 不能把已恢复的持球误判为死球。
  const tlResume = phaseTimeline([
    { t: 1, type: 'pass', result: 'out', detail: 'out_sideline', x: 0.50, y: 0.9, x2: 0.51, y2: 0.9, speed: 14 },
    { t: 1.5, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.503, y2: 0.5 } },
  ]);
  assert.strictEqual(phaseAt(tlResume, 1.6), 'carrier_hold');
});

test('classifyBallIntervals 在事件时刻切分区间；aggregate 份额自洽', () => {
  const frames = [];
  for (let i = 0; i <= 10; i += 1) frames.push(P(i * 0.2, [[1, 0.5, 0.5]], [0.5, 0.5])); // 球不动
  const events = [
    { t: 0, type: 'kickoff', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 },
    { t: 1.0, type: 'beat', beat: {}, main: { x: 0.5, y: 0.5, x2: 0.503, y2: 0.5 } },
  ];
  const iv = classifyBallIntervals(frames, events);
  assert.ok(iv.length >= 2);
  const agg = aggregateDecomposition(iv);
  // 所有时间权重之和 = 2.0s（10 段 × 0.2s）。
  near(agg.totalTimeSec, 2.0, 1e-9);
  near(agg.totalStaticSec, 2.0, 1e-9);
  const shareSum = BALL_SOURCES.reduce((s, k) => s + (agg.sources[k].timeShare || 0), 0);
  near(shareSum, 1, 1e-12);
  const contribSum = BALL_SOURCES.reduce((s, k) => s + (agg.sources[k].staticContribution || 0), 0);
  near(contribSum, 1, 1e-12);
});

test('decomposeWindows：逐窗不跨窗拼接（裁剪边界）', () => {
  const frames = [];
  for (let i = 0; i <= 50; i += 1) frames.push(P(i * 0.2, [[1, 0.5, 0.5]], [0.5, 0.5])); // 10s
  const events = [{ t: 0, type: 'kickoff', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 }];
  const wins = decomposeWindows(frames, events, { windowSec: 5 });
  assert.strictEqual(wins.length, 2);
  for (const w of wins) near(w.totalTimeSec, 5, 1e-9);
  const whole = decomposeBallStatic(frames, events);
  near(whole.totalTimeSec, 10, 1e-9);
  near(whole.ballStaticFrac, 1, 1e-12);
});

test('decomposeBallStatic 五类都应可达（合成事件链）', () => {
  const frames = [];
  for (let i = 0; i <= 40; i += 1) frames.push(P(i * 0.2, [[1, 0.5, 0.5]], [0.5, 0.5]));
  const events = [
    { t: 0, type: 'kickoff', x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14 },
    { t: 0.5, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.503, y2: 0.5 } },
    { t: 1.0, type: 'beat', main: { x: 0.5, y: 0.5, x2: 0.53, y2: 0.5 } },
    { t: 1.5, type: 'beat', ball: { loose: true } },
    { t: 2.0, type: 'pass', x: 0.5, y: 0.5, x2: 0.505, y2: 0.5, speed: 14 },
    { t: 3.0, type: 'pass', result: 'out', detail: 'out_sideline', x: 0.5, y: 0.9, x2: 0.55, y2: 0.9, speed: 14 },
  ];
  const d = decomposeBallStatic(frames, events);
  assert.ok(d.totalTimeSec > 0);
  for (const k of BALL_SOURCES) assert.ok(d.sources[k].nIntervals > 0, `${k} 应有区间`);
});

test('★ 外推点默认跳过（design D3）：extrapolated 帧按缺帧处理，includeExtrapolated 才参与', () => {
  // 三帧：左 →（外推点）→ 右。默认口径把中间点当缺帧 ⇒ 无步、无转向；
  // 采信外推时才有 2 步、1 次折返。这条断言在过滤被摘掉时会红（P1-3 的反证条）。
  const mk = (t, x, extrapolated) => ({
    t, pitchMeters: PITCH, ball: null,
    players: [{ id: 1, x, y: 0.5, ...(extrapolated ? { extrapolated: true } : {}) }],
  });
  const frames = [mk(0, 0.50), mk(0.2, 0.49, true), mk(0.4, 0.50)];
  const skipped = censusOfWindow(frames);
  assert.strictEqual(skipped.nSteps, 0, '外推点两侧的步都必须断开');
  assert.strictEqual(skipped.turn120Old, null, '断开后没有球员有连续步');
  assert.strictEqual(skipped.skippedExtrapolatedPoints, 1);
  assert.strictEqual(skipped.symmetry.n, 2, '外推球员帧不进对称性样本（只剩首末两帧）');
  const kept = censusOfWindow(frames, { includeExtrapolated: true });
  assert.strictEqual(kept.nSteps, 2);
  assert.strictEqual(kept.turn120Old, 1);
  assert.strictEqual(kept.skippedExtrapolatedPoints, 0);
  assert.strictEqual(kept.symmetry.n, 3);
});

test('★ --windows 源身份：wasm 与逐 seed 事件流 SHA 不符必须抛错（P1-B）', () => {
  const stim = { engine: { wasmSha256: 'a'.repeat(64) }, perSeed: { 1201: { eventStreamSha256: 'b'.repeat(64) } } };
  assertStimulusWasmIdentity(stim, 'a'.repeat(64));
  assertStimulusEventIdentity(stim, 1201, 'b'.repeat(64));
  assert.throws(() => assertStimulusWasmIdentity(stim, 'c'.repeat(64)), /wasm 与 stimulus 不同源/);
  assert.throws(() => assertStimulusEventIdentity(stim, 1201, 'd'.repeat(64)), /事件流 SHA 与 stimulus 不一致/);
  // 没登记身份的 seed 同样拒绝（不能靠「没记录」蒙混过关）。
  assert.throws(() => assertStimulusEventIdentity(stim, 1204, 'b'.repeat(64)), /不在 stimulus 的 perSeed/);
  assert.throws(() => assertStimulusWasmIdentity({ engine: {} }, 'a'.repeat(64)), /缺少 engine\.wasmSha256/);
});

test('★ --windows 相位身份：(seed,t0) 集合必须与 stimulus 完全一致（P2-2）', () => {
  const stim = { windows: [{ seed: 1201, t0: 1960 }, { seed: 1204, t0: 1944 }] };
  assert.deepStrictEqual(assertStimulusWindowsMatch(stim, [
    { seed: 1201, t0: 1960 }, { seed: 1204, t0: 1944 },
  ]), { ok: true, n: 2 });
  // t0 漂移（同 seed、错相位）必须拒绝。
  assert.throws(() => assertStimulusWindowsMatch(stim, [{ seed: 1201, t0: 1961 }, { seed: 1204, t0: 1944 }]),
    /相位漂移/);
  // 少一个窗 / 多一个窗都必须拒绝（不能「包含即可」）。
  assert.throws(() => assertStimulusWindowsMatch(stim, [{ seed: 1201, t0: 1960 }]), /stimulus 有、windows 无/);
  assert.throws(() => assertStimulusWindowsMatch(stim, [
    { seed: 1201, t0: 1960 }, { seed: 1204, t0: 1944 }, { seed: 1207, t0: 1944 },
  ]), /windows 有、stimulus 无/);
  assert.throws(() => assertStimulusWindowsMatch({}, []), /缺少 windows/);
});

test('门限/档位常量冻结（改口径必须显式改这里）', () => {
  assert.deepStrictEqual(SPEED_GATES, [0.3, 0.5, 1.0]);
  assert.deepStrictEqual(STATIC_GATES, [0.2, 0.5, 1.0]);
  assert.deepStrictEqual(BALL_STATIC_GATES, [0.2, 0.5, 2.0]);
});
