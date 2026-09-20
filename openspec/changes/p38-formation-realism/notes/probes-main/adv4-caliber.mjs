// adv4: 口径等价性检验 —— 结构判据 S2/S3/S5 在「池化 vs 窗内」「固定 id vs 次序」下是否同值。
// 这一步直接决定 findings-so-far 里「后防横向移动 24 倍」这类数字能不能用。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { fromTrackingFrame, cutWindows, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M,
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames } = M;
const { loadEngineWasm, simulateStream } = await import(pathToFileURL('../../../../../tools/benchmark-engine.mjs').href);
const { createGame } = await import(pathToFileURL('../../../../../viewer/game.js').href);
const ROOT = '../../../../..';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(process.argv[2] || '/tmp/wf-probe/engine-PRISTINE-MAIN.wasm');
const E = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const g = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(g))) E.push(...w);
}
const EW = E;
const RW = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${f}.json`, 'utf8'));
  const fr = g.frames.map((x) => ({ t: x.t, ball: x.ball || null,
    players: x.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(fr)) RW.push(...w);
}

const outfield = (frame, team) => (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id)
  && (team === 'home' ? p.id <= 10 : p.id >= 11));

// —— S3：后防横向移动 sd，三种口径 ——
function lateral(frames, label) {
  // (a) 池化：structural-check 的原实现（跨窗、跨场全部帧放一起）
  const pooled = new Map();
  for (const f of frames) for (const p of outfield(f, 'home')) {
    if (!pooled.has(p.id)) pooled.set(p.id, { x: [], y: [] });
    pooled.get(p.id).x.push(p.x * PITCH_LENGTH_M); pooled.get(p.id).y.push(p.y * PITCH_WIDTH_M);
  }
  const pooledBack = [1, 2, 3, 4].map((i) => pooled.get(i)).filter(Boolean);
  const pooledY = mean(pooledBack.map((a) => sd(a.y)));
  const pooledX = mean(pooledBack.map((a) => sd(a.x)));
  // (b) 窗内：先对每窗算逐 id sd，再对窗取均值（消除场间/窗间膨胀）
  const perWinY = []; const perWinX = [];
  for (const w of frames) {
    const m = new Map();
    for (const f of w) for (const p of outfield(f, 'home')) {
      if (!m.has(p.id)) m.set(p.id, { x: [], y: [] });
      m.get(p.id).x.push(p.x * PITCH_LENGTH_M); m.get(p.id).y.push(p.y * PITCH_WIDTH_M);
    }
    const b = [1, 2, 3, 4].map((i) => m.get(i)).filter((a) => a && a.x.length > 30);
    if (b.length) { perWinY.push(mean(b.map((a) => sd(a.y)))); perWinX.push(mean(b.map((a) => sd(a.x)))); }
  }
  // (c) 帧间位移（每 0.2s 一拍的实际横向跑动），最接近"移动量"的本义
  const stepY = []; const stepX = [];
  for (const w of frames) {
    const prev = new Map();
    for (const f of w) for (const p of outfield(f, 'home')) {
      const k = p.id; const c = [p.x * PITCH_LENGTH_M, p.y * PITCH_WIDTH_M];
      if (prev.has(k)) { const pv = prev.get(k); stepY.push(Math.abs(c[1] - pv[1])); stepX.push(Math.abs(c[0] - pv[0])); }
      prev.set(k, c);
    }
  }
  // (d) 全队横向重心轨迹的 sd（与 id 无关）
  const cy = frames.map((w) => mean(w.map((f) => mean(outfield(f, 'home').map((p) => p.y * PITCH_WIDTH_M)))));
  console.log(`${label}`);
  console.log(`  S3-a 池化逐 id y-sd   ${pooledY.toFixed(1)}m   (x-sd ${pooledX.toFixed(1)}m)`);
  console.log(`  S3-b 窗内逐 id y-sd   ${mean(perWinY).toFixed(1)}m   (x-sd ${mean(perWinX).toFixed(1)}m)`);
  console.log(`  S3-c 帧间 |Δy| 均值    ${mean(stepY).toFixed(2)}m/tick (${mean(stepY) / 0.2} m/s)  |Δx| ${mean(stepX).toFixed(2)}m`);
  console.log(`  S3-d 全队 y 重心 sd    ${sd(cy).toFixed(2)}m  (池化)`);
  return { pooledY, winY: mean(perWinY), stepY: mean(stepY), cySd: sd(cy) };
}
console.log('=== S3 后防横向移动：口径对照 ===');
const rl = lateral(RW, '真实 Metrica'); const el = lateral(EW, '引擎 PRISTINE-MAIN');
console.log(`  → 池化比 ${(rl.pooledY / el.pooledY).toFixed(1)}x   窗内比 ${(rl.winY / el.winY).toFixed(2)}x   帧间比 ${(rl.stepY / el.stepY).toFixed(2)}x`);

// —— S2：中场/后防 x-sd 比，固定 id vs 次序分组 ——
function s2(frames, label) {
  const idOf = (f) => ({ back: outfield(f, 'home').filter((p) => p.id >= 1 && p.id <= 4), mid: outfield(f, 'home').filter((p) => p.id >= 5 && p.id <= 8) });
  const orderOf = (f) => { const s = outfield(f, 'home').slice().sort((a, b) => a.x - b.x); return { back: s.slice(0, 4), mid: s.slice(4, 8) }; };
  const run = (fn) => {
    const m = new Map();
    for (const f of frames) { const { back, mid } = fn(f); for (const p of [...back, ...mid]) { if (!m.has(p.id)) m.set(p.id, { x: [], g: p }); m.get(p.id).x.push(p.x * PITCH_LENGTH_M); } }
    // 用逐帧归属累加（次序分组下 id 会变）
    const bx = []; const mx = [];
    for (const f of frames) { const { back, mid } = fn(f); for (const p of back) bx.push(p.x * PITCH_LENGTH_M); for (const p of mid) mx.push(p.x * PITCH_LENGTH_M); }
    return { bx, mx };
  };
  const pooled = (arr) => { const m = new Map(); for (const v of arr) m.set(v.id ?? 0, v); return null; };
  // 简化：直接用逐帧 pooled 位置序列的 sd（同一 id 在次序分组下会换人 → 用逐帧归属的均值轨迹）
  const agg = (fn) => {
    const b = new Map(); const mi = new Map();
    for (const f of frames) { const r = fn(f); for (const p of r.back) { if (!b.has(p.id)) b.set(p.id, []); b.get(p.id).push(p.x * PITCH_LENGTH_M); } for (const p of r.mid) { if (!mi.has(p.id)) mi.set(p.id, []); mi.get(p.id).push(p.x * PITCH_LENGTH_M); } }
    const bb = [...b.values()].filter((a) => a.length > 200).map(sd);
    const mm = [...mi.values()].filter((a) => a.length > 200).map(sd);
    return { backSd: mean(bb), midSd: mean(mm), ratio: mean(mm) / mean(bb), nB: bb.length, nM: mm.length };
  };
  const byId = agg(idOf); const byOrder = agg(orderOf);
  console.log(`${label}  S2 固定id ${byId.ratio.toFixed(2)} (后防 ${byId.backSd.toFixed(1)}/中场 ${byId.midSd.toFixed(1)}, n=${byId.nB}/${byId.nM})   次序分组 ${byOrder.ratio.toFixed(2)} (${byOrder.backSd.toFixed(1)}/${byOrder.midSd.toFixed(1)}, n=${byOrder.nB}/${byOrder.nM})`);
  return { byId, byOrder };
}
console.log('\n=== S2 中场/后防移动比：分组口径对照 ===');
const rs2 = s2(RW, '真实'); const es2 = s2(EW, '引擎');

// —— 断层：池化 vs 窗内，以及两侧的分组口径 ——
function fault(frames, label) {
  const pooled = Array.from({ length: 10 }, () => []);
  const perWin = [];
  const winFault = (w) => {
    const acc = Array.from({ length: 10 }, () => []);
    for (const f of w) { const s = outfield(f, 'home').map((p) => p.x * PITCH_LENGTH_M).sort((a, b) => a - b); if (s.length < 10) continue; for (let i = 0; i < 10; i += 1) acc[i].push(s[i]); }
    const P = acc.map(mean); const g = P.slice(1).map((v, i) => v - P[i]); return Math.max(...g);
  };
  for (const f of frames) { const s = outfield(f, 'home').map((p) => p.x * PITCH_LENGTH_M).sort((a, b) => a - b); if (s.length < 10) continue; for (let i = 0; i < 10; i += 1) pooled[i].push(s[i]); }
  const Pf = pooled.map(mean); const gf = Pf.slice(1).map((v, i) => v - Pf[i]);
  for (const w of frames) { const v = winFault(w); if (Number.isFinite(v)) perWin.push(v); }
  console.log(`${label}  断层 池化 ${Math.max(...gf).toFixed(1)} (序列 ${gf.map((v) => v.toFixed(1)).join('/')})   窗内均值 ${mean(perWin).toFixed(1)}`);
  return { pooled: Math.max(...gf), win: mean(perWin), gf };
}
console.log('\n=== S1 断层：池化 vs 窗内 ===');
fault(RW, '真实 Metrica'); fault(EW, '引擎');
