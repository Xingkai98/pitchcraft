// R4 探针：8 帧口径路径直度（净位移/路径长）——复现 R3 裁判 C 的线索（干净数据，不比像素）。
// 逐场 24s 窗（步 12s）、8 个等距样本（≈3.43s）、剔门将；窗内球员中位 → 场均 → 源均值。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * p; const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function straightnessWindows(frames) {
  const T = frames[frames.length - 1].t;
  const out = [];
  for (let s = 0; s + 24 <= T + 1e-6; s += 12) {
    const w = frames.filter((f) => f.t >= s && f.t < s + 24);
    if (w.length < 97) continue;
    const times = Array.from({ length: 8 }, (_, i) => s + (i * 24) / 7);
    const byId = new Map();
    for (const t of times) {
      const fr = w.reduce((b, f) => (Math.abs(f.t - t) < Math.abs(b.t - t) ? f : b), w[0]);
      for (const p of fr.players) {
        if (p.id === 0 || p.id === 21) continue;
        if (!byId.has(p.id)) byId.set(p.id, []);
        byId.get(p.id).push([p.x * 105, p.y * 68]);
      }
    }
    const vals = [];
    for (const pts of byId.values()) {
      let pl = 0;
      for (let i = 1; i < pts.length; i += 1) pl += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const net = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
      if (pl < 1) continue;
      vals.push(net / pl);
    }
    if (vals.length) out.push(q(vals, 0.5));
  }
  return out;
}

const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('probe-straight.mjs');
if (IS_ENTRY) {
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { Game } = await import(join(ROOT, 'viewer/game.js'));
  const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  if (!ok) { console.error('wasm load fail'); process.exit(2); }
  const seeds = (process.argv[2] || '42,7').split(',').map(Number);
  const eng = [];
  for (const seed of seeds) {
    const { events, lineup } = parseEventStream(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
    const frames = mm.sampleEngineFrames(new Game(events, lineup, 'continuous')).map((f) => ({ t: f.t, players: f.players }));
    eng.push(straightnessWindows(frames));
  }
  const files = ['real-game-1.json', 'real-game-2.json'];
  for (const f of readdirSync(join(ROOT, 'viewer/data'))) if (/^skillcorner-.*\.json$/.test(f)) files.push(f);
  const real = [];
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8'));
    const frames = g.frames.map((fr) => ({ t: fr.t, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)).filter(Boolean) }));
    real.push(straightnessWindows(frames));
  }
  console.log(`engine(seeds ${seeds.join(',')}) straightness:`, eng.map((a) => mean(a).toFixed(3)).join(' / '));
  console.log(`real22 straightness: mean ${mean(real.map((a) => mean(a))).toFixed(3)}  range ${Math.min(...real.map((a) => mean(a))).toFixed(3)}–${Math.max(...real.map((a) => mean(a))).toFixed(3)}`);
  console.log(`engine window p10/p50/p90:`, q(eng.flat(), 0.1).toFixed(3), q(eng.flat(), 0.5).toFixed(3), q(eng.flat(), 0.9).toFixed(3));
  console.log(`real22 window p10/p50/p90:`, q(real.flat(), 0.1).toFixed(3), q(real.flat(), 0.5).toFixed(3), q(real.flat(), 0.9).toFixed(3));
}
