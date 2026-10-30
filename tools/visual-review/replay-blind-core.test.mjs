// replay-blind-core 的守护测试。**纯合成帧**（不依赖 wasm / 真实数据）→ CI 必跑。
//
// 夹死的不是“代码能跑”，而是本工具存在的理由：
//   - 窗口规则真的在排除死球/缺球/补全球（有区分度，不是空转）；
//   - 选择真的会向前搜索、无候选时 fallback 而不是静默挑一个；
//   - 盲法 id/顺序不含来源，且呈现顺序通过预注册检查；
//   - 同渲染器真的画了 22 人/球，坐标映射正确，图内无文字；
//   - PNG 等长化真的消掉了文件大小侧信道；
//   - 分析器能把“完美裁判”和“反向裁判”分开。
import { test } from 'node:test';
import assert from 'node:assert';
import * as C from './replay-blind-core.mjs';

// 22 人：0–10 红、11–21 蓝；门将也在（0/21），但运动指标会剔除。
// 球可静止 / 匀速移动；`ballFillAt` 可指定若干帧的球位是补全值。
function mkFrames(n, { tStart = 0, ballSpeed = 0.004, playerSpeed = 0.0002, ballFillAt = new Set() } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const players = Array.from({ length: 22 }, (_, k) => ({
      id: k,
      x: 0.1 + (k % 6) * 0.12 + i * playerSpeed,
      y: 0.08 + Math.floor(k / 6) * 0.16,
    }));
    const ball = [0.2 + i * ballSpeed, 0.5];
    return { t: tStart + i * 0.2, players, ball, ballFill: ballFillAt.has(i) ? 3 : null };
  });
}

const H24 = 121; // 24s / 0.2s + 1

test('nearestFrame：超过容差返回 null（禁止跨 gap 假插值）', () => {
  const f = mkFrames(10);
  assert.ok(C.nearestFrame(f, 0.1, 0.3));
  assert.strictEqual(C.nearestFrame(f, 0.4, 0.3).frame.t, 0.4);
  assert.strictEqual(C.nearestFrame(f, 0.5, 0.05), null);
});

test('evaluateWindow：移动球 + 22 人 → 通过；静止球 → 因球路径不足失败', () => {
  const moving = mkFrames(300);
  const ev = C.evaluateWindow(moving, 10, {});
  assert.ok(ev.stats.ballPathM > 30, `移动球路径应 >30m，实得 ${ev.stats.ballPathM}`);
  assert.ok(ev.pass, `移动窗应通过，stats=${JSON.stringify(ev.stats)}`);
  assert.strictEqual(ev.contactFrames.length, 8);
  assert.ok(ev.contactFrames.every((f) => f && f.players.length === 22 && f.ball));

  const still = mkFrames(300, { ballSpeed: 0 });
  const ev2 = C.evaluateWindow(still, 10, {});
  assert.strictEqual(ev2.stats.ballPathM, 0);
  assert.ok(!ev2.pass, '静止球必须失败（死球/停球窗不能进盲测）');
});

test('evaluateWindow：补全球 / 缺球 / gap 各有区分度', () => {
  const fill = mkFrames(300, { ballFillAt: new Set(Array.from({ length: 300 }, (_, i) => i)) });
  const ef = C.evaluateWindow(fill, 10, {});
  assert.strictEqual(ef.stats.rawBallFrac, 0, '全补全 → 原始球比例 0');
  assert.ok(!ef.pass);

  const half = mkFrames(300);
  for (const f of half.slice(0, 150)) { f.ball = null; f.ballFill = null; }
  const eh = C.evaluateWindow(half, 10, {});
  assert.ok(eh.stats.rawBallFrac < 0.9, '缺球窗原始球比例应低于阈值');
  assert.ok(!eh.pass);

  const gap = mkFrames(300);
  const withGap = gap.filter((f, i) => i < 50 || i > 80);
  const eg = C.evaluateWindow(withGap, 10, {});
  assert.ok(eg.stats.coverage < 0.98, `gap 应降低覆盖率，实得 ${eg.stats.coverage}`);
  assert.ok(!eg.pass);
});

test('★ evaluateWindow：contact 帧是补全球时也必须失败（不能把启发式球位画进刺激集）', () => {
  const frames = mkFrames(300);
  // t0=10 的 8 个 contact 时刻 → 帧下标；只把这些帧标成补全，rawBallFrac 仍 >0.9。
  const times = [];
  for (let c = 0; c < 8; c += 1) times.push(10 + (c * 24) / 7);
  const idx = new Set(times.map((t) => Math.round(t / 0.2)));
  for (const i of idx) frames[i].ballFill = 3;
  const ev = C.evaluateWindow(frames, 10, {});
  assert.ok(ev.stats.rawBallFrac > 0.9, `raw 应仍 >0.9，实得 ${ev.stats.rawBallFrac}`);
  assert.strictEqual(ev.contactRawBall, false, 'contact 帧有补全球 → contactRawBall=false');
  assert.ok(!ev.pass, 'contact 帧补全球必须让窗口失败');
});

test('★ evaluateWindow：contact 帧球在场外时必须失败（否则面板里画不出球）', () => {
  const frames = mkFrames(300);
  const times = [];
  for (let c = 0; c < 8; c += 1) times.push(10 + (c * 24) / 7);
  for (const t of times) frames[Math.round(t / 0.2)].ball = [1.02, 0.5];
  const ev = C.evaluateWindow(frames, 10, {});
  assert.strictEqual(ev.contactBallInField, false);
  assert.ok(!ev.pass, 'contact 球在场外必须让窗口失败');
});

test('selectWindow：anchor 落在死球段时向前搜索到第一个开放窗', () => {
  // 前 100 帧（20s）球静止，之后移动；anchor=10s 应在 10s 之后找到通过窗。
  const frames = Array.from({ length: 400 }, (_, i) => {
    const players = Array.from({ length: 22 }, (_, k) => ({
      id: k, x: 0.1 + (k % 6) * 0.12 + i * 0.0002, y: 0.08 + Math.floor(k / 6) * 0.16,
    }));
    const bx = 0.2 + Math.max(0, i - 100) * 0.004;
    return { t: i * 0.2, players, ball: [bx, 0.5], ballFill: null };
  });
  const sel = C.selectWindow(frames, 10, { usableMarginSec: 5 });
  assert.strictEqual(sel.fallback, false, '应找到通过窗而不是 fallback');
  assert.ok(sel.t0 > 10, `应向前移动，实得 t0=${sel.t0}`);
  assert.ok(sel.pass);
});

test('反证：全静止时 selectWindow 走 fallback（不抛错、不静默挑“好看”）', () => {
  const frames = mkFrames(300, { ballSpeed: 0, playerSpeed: 0 });
  const sel = C.selectWindow(frames, 10, { maxSearchOffsetSec: 20, usableMarginSec: 5 });
  assert.strictEqual(sel.fallback, true);
  assert.strictEqual(sel.pass, false);
  assert.ok(sel.quality > 0);
});

test('makeItemId：确定性、不含来源/seed/match', () => {
  const a = C.itemId('salt', 'real|metrica|metrica-1|42|0.2');
  const b = C.itemId('salt', 'real|metrica|metrica-1|42|0.2');
  const c = C.itemId('salt', 'engine|engine|seed-42|42|0.2');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.match(a, /^rb-[0-9a-f]{10}$/);
  assert.ok(!/real|engine|metrica|seed|42/i.test(a));
});

test('mainOrderCheck / orderWithCheck：18/18 的呈现顺序通过预注册检查', () => {
  const items = [];
  for (let i = 0; i < 18; i += 1) items.push({ id: `r${i}`, source: 'real' });
  for (let i = 0; i < 18; i += 1) items.push({ id: `e${i}`, source: 'engine' });
  const res = C.orderWithCheck(items, 'order', C.mainOrderCheck);
  assert.ok(res.check.ok);
  assert.ok(res.check.realInFirstHalf >= 6 && res.check.realInFirstHalf <= 12);
  assert.ok(res.check.maxRun <= 4);
  // 反证：按来源分组排 → 检查必须不过
  const grouped = [...items].sort((a, b) => a.source.localeCompare(b.source));
  assert.strictEqual(C.mainOrderCheck(grouped).ok, false);
});

test('orderControls：9 对 A/B 随机化后 A 侧 real 数在 [3,6]', () => {
  const mk = (i, source) => ({ id: `w${i}`, source, dataset: source, match: `m${i}`, t0: i });
  const pairs = [];
  for (let i = 0; i < 3; i += 1) pairs.push({ id: `p${i}`, type: 'real-real', aItem: mk(i, 'real'), bItem: mk(i + 10, 'real') });
  for (let i = 0; i < 3; i += 1) pairs.push({ id: `q${i}`, type: 'engine-engine', aItem: mk(i + 20, 'engine'), bItem: mk(i + 30, 'engine') });
  for (let i = 0; i < 3; i += 1) pairs.push({ id: `m${i}`, type: 'real-engine', aItem: mk(i + 40, 'real'), bItem: mk(i + 50, 'engine') });
  const res = C.orderControls(pairs, 'ctl');
  assert.ok(res.check.ok);
  assert.ok(res.check.aReal >= 3 && res.check.aReal <= 6);
  assert.strictEqual(res.pairs.length, 9);
});

test('★ 渲染自证：标定图 11 红 + 11 蓝 + 1 黄球，质心误差 <=1.5px', () => {
  const cal = C.verifyCalibration();
  assert.ok(cal.pass, JSON.stringify(cal));
  assert.strictEqual(cal.redComponents, 11);
  assert.strictEqual(cal.blueComponents, 11);
  assert.strictEqual(cal.yellowComponents, 1);
  assert.ok(cal.centroidErrMax <= 1.5);
});

test('★ 渲染自证：contact 每个面板恰 1 个球、红蓝像素/连通块充足、无白字、调色板干净', () => {
  const frames = mkFrames(300);
  const ev = C.evaluateWindow(frames, 10, {});
  const img = C.buildContactImage(ev.contactFrames);
  const check = C.verifyContactImage(img.canvas, img);
  assert.ok(check.pass, JSON.stringify(check.panels));
  assert.strictEqual(check.panels.length, 8);
  for (const p of check.panels) {
    assert.strictEqual(p.yellowComponents, 1, `面板 ${p.x} 应恰 1 个球`);
    assert.ok(p.redPixels > 250 && p.bluePixels > 250, '红蓝两侧都要画出来');
    assert.ok(p.redComponents >= 5 && p.blueComponents >= 5, '两侧都要有多个球员连通块');
  }
  assert.strictEqual(check.whitePixels, 0);
  assert.deepStrictEqual(check.paletteViolations, []);
});

test('反证：contact 少一人必须抛错（不允许静默丢点）', () => {
  const frames = mkFrames(300).slice(0, 8).map((f) => ({ ...f, players: f.players.slice(0, 21) }));
  assert.throws(() => C.buildContactImage(frames), /21 人/);
});

test('★ 渲染自证：轨迹图 22 条轨迹 + 球路径；无白字；调色板干净', () => {
  const frames = mkFrames(300);
  const samples = C.canonicalWindow(frames, 10, { windowSec: 24 });
  const img = C.buildTrajectoryImage(samples);
  const check = C.verifyTrajectoryImage(img.canvas, img);
  assert.ok(check.pass, JSON.stringify(check));
  assert.strictEqual(check.playersDrawn, 22);
  assert.ok(check.ballPathPoints > 20);
  assert.strictEqual(check.whitePixels, 0);
  assert.deepStrictEqual(check.paletteViolations, []);
});

test('★ PNG：等长化后大小精确、IEND 仍在最后、无禁用元数据块', () => {
  const frames = mkFrames(300);
  const ev = C.evaluateWindow(frames, 10, {});
  const img = C.buildContactImage(ev.contactFrames);
  const png = C.canvasToPngBuffer(img.canvas);
  assert.deepStrictEqual(C.pngChunks(png).map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepStrictEqual(C.forbiddenPngChunks(png), []);
  const target = png.length + 123;
  const padded = C.padPngToSize(png, target);
  assert.strictEqual(padded.length, target);
  const chunks = C.pngChunks(padded);
  assert.strictEqual(chunks.at(-1).type, 'IEND');
  assert.ok(chunks.some((c) => c.type === 'prVt'));
  assert.deepStrictEqual(C.forbiddenPngChunks(padded), []);
  // 反证：target 小于原图必须报错，不能静默截断
  assert.throws(() => C.padPngToSize(png, png.length - 1), /target/);
});

test('analyzeJudgments：完美裁判准确率 1 / AUC 1 / 负控 balanced 1；反向裁判准确率 0', () => {
  const key = {
    items: [
      { id: 'a', source: 'real' }, { id: 'b', source: 'real' },
      { id: 'c', source: 'engine' }, { id: 'd', source: 'engine' },
    ],
    controls: [
      { id: 'p1', type: 'real-real', A: { source: 'real' }, B: { source: 'real' } },
      { id: 'p2', type: 'engine-engine', A: { source: 'engine' }, B: { source: 'engine' } },
      { id: 'p3', type: 'real-engine', A: { source: 'real' }, B: { source: 'engine' } },
    ],
  };
  const perfect = {
    judge_id: 'perfect',
    items: [
      { id: 'a', A_guess: 'real', A_confidence: 5, B_score: 4, cues: '间距' },
      { id: 'b', A_guess: 'real', A_confidence: 4, B_score: 5, cues: '球与人关系' },
      { id: 'c', A_guess: 'engine', A_confidence: 5, B_score: 2, cues: '水平车道' },
      { id: 'd', A_guess: 'engine', A_confidence: 4, B_score: 1, cues: '水平车道, 整队同步' },
    ],
    controls: [
      { id: 'p1', same_source: 'same', confidence: 5 },
      { id: 'p2', same_source: 'same', confidence: 4 },
      { id: 'p3', same_source: 'different', confidence: 5, more_real: 'A' },
    ],
  };
  const s = C.analyzeJudgments(key, perfect);
  assert.strictEqual(s.main.n, 4);
  assert.strictEqual(s.main.accuracy, 1);
  assert.strictEqual(s.main.confusion.real_as_real, 2);
  assert.strictEqual(s.main.confusion.engine_as_engine, 2);
  assert.strictEqual(s.main.bScore.aucRealHigher, 1);
  assert.strictEqual(s.controls.balancedAccuracy, 1);
  assert.strictEqual(s.controls.mixedMoreRealAccuracy, 1);
  assert.ok(s.cues.find((x) => x.cue === '水平车道').count === 2);

  const reverse = {
    judge_id: 'reverse',
    items: [
      { id: 'a', A_guess: 'engine', B_score: 1 },
      { id: 'b', A_guess: 'engine', B_score: 1 },
      { id: 'c', A_guess: 'real', B_score: 5 },
      { id: 'd', A_guess: 'real', B_score: 5 },
    ],
    controls: [
      { id: 'p1', same_source: 'different' },
      { id: 'p2', same_source: 'different' },
      { id: 'p3', same_source: 'same', more_real: 'B' },
    ],
  };
  const r = C.analyzeJudgments(key, reverse);
  assert.strictEqual(r.main.accuracy, 0);
  assert.strictEqual(r.main.bScore.aucRealHigher, 0);
  assert.strictEqual(r.controls.balancedAccuracy, 0);
});

test('wilsonInterval：0/0 返回 null；全对区间上界 1', () => {
  assert.strictEqual(C.wilsonInterval(0.5, 0), null);
  const w = C.wilsonInterval(1, 20);
  assert.ok(w.hi > 0.999 && w.lo > 0.8);
});
