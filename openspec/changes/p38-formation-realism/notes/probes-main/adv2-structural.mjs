// adv2: S1–S5 结构判据，**带口径变体开关**，逐条与 structural-check.mjs 对照。
// 用法: node adv2-structural.mjs <wasmPath> <label>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEngineWasm, simulateStream } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';
const M = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js').href);
const { createGame } = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js').href);
const { PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS } = M;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const sdSample = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

const wasmPath = process.argv[2]; const label = process.argv[3] || 'x';
const load = await loadEngineWasm(wasmPath);
const E = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  E.push(...sampleEngineFrames(game));
}
const R = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) R.push(...w);
}

// 与 structural-check 逐行一致的原实现（用于复现）
function teamXsSC(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length < 7) return null;
  const xs = out.sort((a, b) => a - b);
  return team === 'home' ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
}
function outfieldSC(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}

function analyze(frames, opt = {}) {
  const { yMirrorAway = false, groupBoth = false, spanEdge = 0.2 } = opt;
  const acc = Array.from({ length: 10 }, () => []);
  const spanByBall = [[], [], [], [], []];
  const frontInOwnBox = [];
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = teamXsSC(f, team);
      if (!xs) continue;
      for (let i = 0; i < 10; i += 1) acc[i].push(xs[i]);
      if (!f.ball || !Number.isFinite(f.ball[0])) continue;
      const bx = team === 'home' ? f.ball[0] : 1 - f.ball[0];
      const bi = Math.max(0, Math.min(4, Math.floor(bx * 5)));
      spanByBall[bi].push(xs[9] - xs[0]);
      if (bx < spanEdge) frontInOwnBox.push(xs[9]);
    }
  }
  const P = acc.map(mean);
  const gaps = P.slice(1).map((v, i) => v - P[i]);
  const byId = new Map();
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      for (const p of outfieldSC(f, team)) {
        const key = team + '-' + p.id;
        if (!byId.has(key)) byId.set(key, { team, id: p.id, x: [], y: [] });
        const a = byId.get(key);
        a.x.push(team === 'home' ? p.x * PITCH_LENGTH_M : (1 - p.x) * PITCH_LENGTH_M);
        a.y.push((yMirrorAway && team === 'away' ? 1 - p.y : p.y) * PITCH_WIDTH_M);
      }
    }
  }
  const slotSd = [];
  for (const a of byId.values()) {
    if (a.x.length < 200) continue;
    slotSd.push({ team: a.team, id: a.id, sdX: sd(a.x), sdY: sd(a.y), n: a.x.length });
  }
  const grp = (t, lo, hi) => {
    const sel = slotSd.filter((r) => r.team === t && r.id >= lo && r.id <= hi);
    return sel.length ? { x: mean(sel.map((r) => r.sdX)), y: mean(sel.map((r) => r.sdY)), n: sel.length } : null;
  };
  const teams = groupBoth ? ['home', 'away'] : ['home'];
  const backOf = (t) => (t === 'home' ? grp(t, 1, 4) : grp(t, 17, 20));
  const midOf = (t) => (t === 'home' ? grp(t, 5, 8) : grp(t, 13, 16));
  const nonNull = teams.map(backOf).filter(Boolean); const nonNullM = teams.map(midOf).filter(Boolean);
  if (!nonNull.length || !nonNullM.length) return { fault: NaN, faultAt: -1, gaps: [], midBackRatio: NaN, backSdY: NaN, spans: [], spanRange: NaN, frontInOwnBox: NaN, slotSd };
  const backX = mean(nonNull.map((v) => v.x)); const backY = mean(nonNull.map((v) => v.y));
  const midX = mean(nonNullM.map((v) => v.x));
  const spans = spanByBall.filter((a) => a.length > 50).map(mean);
  return { fault: Math.max(...gaps), faultAt: gaps.indexOf(Math.max(...gaps)) + 1, gaps,
    midBackRatio: midX / backX, backSdY: backY, spans,
    spanRange: spans.length > 1 ? Math.max(...spans) - Math.min(...spans) : NaN,
    frontInOwnBox: frontInOwnBox.length ? mean(frontInOwnBox) : NaN,
    slotSd };
}

const r = analyze(R); const e = analyze(E);
console.log(`\n### ${label}   (pitch ${PITCH_LENGTH_M}x${PITCH_WIDTH_M})`);
const row = (n, rv, ev, f = (v) => v.toFixed(1)) => console.log(`  ${n.padEnd(24)} 真实 ${f(rv).padStart(8)}   引擎 ${f(ev).padStart(8)}`);
console.log('S1 断层');
row('最大相邻间距 (m)', r.fault, e.fault);
row('出现在次序', r.faultAt, e.faultAt, (v) => String(v));
console.log(`    真实   ${r.gaps.map((v) => v.toFixed(1)).join(' / ')}`);
console.log(`    引擎   ${e.gaps.map((v) => v.toFixed(1)).join(' / ')}`);
console.log('S2/S3');
row('中场/后防 x-sd 比', r.midBackRatio, e.midBackRatio, (v) => v.toFixed(2));
row('后防 y-sd (m)', r.backSdY, e.backSdY);
console.log('S4 块跨度随球位');
console.log(`    真实   ${r.spans.map((v) => v.toFixed(1)).join('  ')}`);
console.log(`    引擎   ${e.spans.map((v) => v.toFixed(1)).join('  ')}`);
row('跨度极差', r.spanRange, e.spanRange);
console.log('S5 球在本方 x<21m 时最前一人');
row('最前一人 (m)', r.frontInOwnBox, e.frontInOwnBox);

console.log('  -- 口径变体（引擎） --');
for (const opt of [{}, { yMirrorAway: true }, { groupBoth: true }, { groupBoth: true, yMirrorAway: true }, { spanEdge: 0.1 }]) {
  const x = analyze(E, opt);
  console.log(`    ${JSON.stringify(opt).padEnd(46)} S2=${x.midBackRatio.toFixed(2)} S3=${x.backSdY.toFixed(1)} S5=${x.frontInOwnBox.toFixed(1)}`);
}
console.log('  -- 口径变体（真实） --');
for (const opt of [{}, { yMirrorAway: true }, { groupBoth: true }, { groupBoth: true, yMirrorAway: true }, { spanEdge: 0.1 }]) {
  const x = analyze(R, opt);
  console.log(`    ${JSON.stringify(opt).padEnd(46)} S2=${x.midBackRatio.toFixed(2)} S3=${x.backSdY.toFixed(1)} S5=${x.frontInOwnBox.toFixed(1)}`);
}
console.log('  -- 逐槽位 x/y sd 明细（真实前，引擎后）--');
const fmtSlots = (a) => a.slotSd.filter((s) => s.team === 'home').sort((p, q) => p.id - q.id)
  .map((s) => `id${s.id}:x${s.sdX.toFixed(1)}/y${s.sdY.toFixed(1)}`).join(' ');
console.log('    真实 ' + fmtSlots(r));
console.log('    引擎 ' + fmtSlots(e));
