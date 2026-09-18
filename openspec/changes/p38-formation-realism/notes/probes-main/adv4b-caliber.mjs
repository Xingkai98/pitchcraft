// adv4b: 口径等价性 —— 结构判据 S1/S2/S3 在「池化 vs 窗内」「固定 id vs 次序」下是否同值。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js').href);
const { cutWindows, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M,
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames } = M;
const { loadEngineWasm, simulateStream } = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs').href);
const { createGame } = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js').href);
const ROOT = '/home/happy/.claude/worktrees/wayfinder-realism';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(process.argv[2] || '/tmp/wf-probe/engine-PRISTINE-MAIN.wasm');
const EW = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const g = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  EW.push(...cutWindows(sampleEngineFrames(g)));
}
const RW = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${f}.json`, 'utf8'));
  const fr = g.frames.map((x) => ({ t: x.t, ball: x.ball || null,
    players: x.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  RW.push(...cutWindows(fr));
}
const flat = (W) => W.flat();
const outfield = (frame, team) => (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id)
  && (team === 'home' ? p.id <= 10 : p.id >= 11));

console.log('=== S3 后防横向移动：四种口径 ===');
function lateral(W, label) {
  const A = flat(W);
  // a 池化（structural-check 原实现：全部帧的同一 id 放一起）
  const pooled = new Map();
  for (const f of A) for (const p of outfield(f, 'home')) {
    if (!pooled.has(p.id)) pooled.set(p.id, { x: [], y: [] });
    pooled.get(p.id).x.push(p.x * PITCH_LENGTH_M); pooled.get(p.id).y.push(p.y * PITCH_WIDTH_M);
  }
  const pb = [1, 2, 3, 4].map((i) => pooled.get(i)).filter(Boolean);
  const paY = mean(pb.map((a) => sd(a.y))); const paX = mean(pb.map((a) => sd(a.x)));
  // b 窗内（先窗内逐 id sd，再对窗平均）
  const wY = []; const wX = [];
  for (const win of W) {
    const m = new Map();
    for (const f of win) for (const p of outfield(f, 'home')) {
      if (!m.has(p.id)) m.set(p.id, { x: [], y: [] });
      m.get(p.id).x.push(p.x * PITCH_LENGTH_M); m.get(p.id).y.push(p.y * PITCH_WIDTH_M);
    }
    const b = [1, 2, 3, 4].map((i) => m.get(i)).filter((a) => a && a.x.length > 30);
    if (b.length) { wY.push(mean(b.map((a) => sd(a.y)))); wX.push(mean(b.map((a) => sd(a.x)))); }
  }
  // c 帧间位移（"移动量"的本义）
  const sY = []; const sX = [];
  for (const win of W) {
    const prev = new Map();
    for (const f of win) for (const p of outfield(f, 'home')) {
      const c = [p.x * PITCH_LENGTH_M, p.y * PITCH_WIDTH_M];
      if (prev.has(p.id)) { const pv = prev.get(p.id); sY.push(Math.abs(c[1] - pv[1])); sX.push(Math.abs(c[0] - pv[0])); }
      prev.set(p.id, c);
    }
  }
  // d 全队横向重心轨迹 sd（与 id 无关）
  const cy = A.map((f) => mean(outfield(f, 'home').map((p) => p.y * PITCH_WIDTH_M)));
  console.log(`${label}`);
  console.log(`  a 池化逐id y-sd ${paY.toFixed(1)}  x-sd ${paX.toFixed(1)}`);
  console.log(`  b 窗内逐id y-sd ${mean(wY).toFixed(1)}  x-sd ${mean(wX).toFixed(1)}`);
  console.log(`  c 帧间|Δy| ${mean(sY).toFixed(2)}m/tick (${(mean(sY) / 0.2).toFixed(2)} m/s)  |Δx| ${mean(sX).toFixed(2)}m`);
  console.log(`  d 全队y重心sd ${sd(cy).toFixed(2)}`);
  return { paY, wY: mean(wY), sY: mean(sY), cySd: sd(cy), wX: mean(wX) };
}
const rl = lateral(RW, '真实 Metrica'); const el = lateral(EW, '引擎');
console.log(`  → a 池化比 ${(rl.paY / el.paY).toFixed(1)}x  b 窗内比 ${(rl.wY / el.wY).toFixed(1)}x  c 帧间比 ${(rl.sY / el.sY).toFixed(1)}x  d 重心sd比 ${(rl.cySd / el.cySd).toFixed(1)}x`);

console.log('\n=== S2 中场/后防 x-sd 比：分组口径 ===');
function s2(W, label) {
  const agg = (fn) => {
    const b = new Map(); const mi = new Map();
    for (const f of flat(W)) { const r = fn(f); for (const p of r.back) { if (!b.has(p.id)) b.set(p.id, []); b.get(p.id).push(p.x * PITCH_LENGTH_M); } for (const p of r.mid) { if (!mi.has(p.id)) mi.set(p.id, []); mi.get(p.id).push(p.x * PITCH_LENGTH_M); } }
    const bb = [...b.values()].filter((a) => a.length > 200).map(sd);
    const mm = [...mi.values()].filter((a) => a.length > 200).map(sd);
    return { backSd: mean(bb), midSd: mean(mm), ratio: mean(mm) / mean(bb), nB: bb.length, nM: mm.length };
  };
  const idOf = (f) => ({ back: outfield(f, 'home').filter((p) => p.id >= 1 && p.id <= 4), mid: outfield(f, 'home').filter((p) => p.id >= 5 && p.id <= 8) });
  const orderOf = (f) => { const s = outfield(f, 'home').slice().sort((a, b) => a.x - b.x); return { back: s.slice(0, 4), mid: s.slice(4, 8) }; };
  const byId = agg(idOf); const byOrder = agg(orderOf);
  console.log(`${label}  固定id 比 ${byId.ratio.toFixed(2)} (后 ${byId.backSd.toFixed(1)}/中 ${byId.midSd.toFixed(1)}, n=${byId.nB}/${byId.nM})   次序 比 ${byOrder.ratio.toFixed(2)} (后 ${byOrder.backSd.toFixed(1)}/中 ${byOrder.midSd.toFixed(1)}, n=${byOrder.nB}/${byOrder.nM})`);
}
s2(RW, '真实'); s2(EW, '引擎');

console.log('\n=== S1 断层：池化 vs 窗内（真实侧同时给 固定id 与 次序 两口径）===');
function fault(rW, eW) {
  const calc = (frames) => { const acc = Array.from({ length: 10 }, () => []);
    for (const f of frames) { const s = outfield(f, 'home').map((p) => p.x * PITCH_LENGTH_M).sort((a, b) => a - b); if (s.length < 10) continue; for (let i = 0; i < 10; i += 1) acc[i].push(s[i]); }
    const P = acc.map(mean); return P.slice(1).map((v, i) => v - P[i]); };
  const winMean = (W) => mean(W.map((w) => Math.max(...calc(w))));
  const rf = calc(flat(rW)); const ef = calc(flat(eW));
  console.log(`  真实 池化 断层 ${Math.max(...rf).toFixed(1)} 序列 ${rf.map((v) => v.toFixed(1)).join('/')}   窗内均值 ${winMean(rW).toFixed(1)}`);
  console.log(`  引擎 池化 断层 ${Math.max(...ef).toFixed(1)} 序列 ${ef.map((v) => v.toFixed(1)).join('/')}   窗内均值 ${winMean(eW).toFixed(1)}`);
}
fault(RW, EW);

console.log('\n=== S5 球在本方后场时最前一人：分组口径 ===');
function s5(W, label) {
  const res = {};
  for (const [name, team, sel] of [['次序-最前1', 'home', 9], ['固定id10(前锋)', 'home', 10]]) {
    const v = [];
    for (const f of flat(W)) { const bx = f.ball ? f.ball[0] : null; if (bx == null || bx >= 0.2) continue;
      const o = outfield(f, 'home'); if (name.startsWith('次序')) { const s = o.map((p) => p.x).sort((a, b) => a - b); if (s.length >= 10) v.push(s[9] * PITCH_LENGTH_M); }
      else { const p = o.find((q) => q.id === 10); if (p) v.push(p.x * PITCH_LENGTH_M); } }
    res[name] = mean(v);
  }
  console.log(`${label}  次序最前 ${res['次序-最前1'].toFixed(1)}   id10 ${res['固定id10(前锋)'].toFixed(1)}`);
}
s5(RW, '真实'); s5(EW, '引擎');

console.log('\n=== 真实侧：分组口径能差多少（后防 = id1-4 vs 最深4人）===');
function idVsOrder(W, label) {
  const idSet = outfield(W[0][0], 'home').filter((p) => p.id <= 4).map((p) => p.id);
  console.log(`${label} 固定后防 id = ${idSet.join(',')}`);
  // 每帧：固定 id 组 vs 最深 4 人，两者的 (a) 平均 x (b) 组内 y 跨度
  let same = 0; let tot = 0;
  for (const f of flat(W)) { const o = outfield(f, 'home'); const byId = o.filter((p) => idSet.includes(p.id)).map((p) => p.id).sort((a, b) => a - b);
    const byOrd = o.slice().sort((a, b) => a.x - b.x).slice(0, 4).map((p) => p.id).sort((a, b) => a - b);
    tot += 1; if (JSON.stringify(byId) === JSON.stringify(byOrd)) same += 1; }
  console.log(`  固定id 组 == 最深4人 的帧占比: ${(100 * same / tot).toFixed(1)}%`);
}
idVsOrder(RW, '真实 Metrica');
// 引擎：模板上 id1-4 就是后卫
{
  const g = createGame(simulateStream(load.wasm, 42, 60));
  const f = { players: g.players.map((p) => ({ id: p.id, x: p.x, y: p.y })) };
  console.log('引擎 t=60s 主队 id1-4 的 x:', outfield(f, 'home').filter((p) => p.id <= 4).map((p) => p.x.toFixed(3)).join(','));
  console.log('引擎 主队 按 x 排序的 id:', outfield(f, 'home').slice().sort((a, b) => a.x - b.x).map((p) => p.id).join(','));
}
