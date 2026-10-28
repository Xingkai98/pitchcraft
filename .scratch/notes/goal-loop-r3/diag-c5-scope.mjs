// R3 归因：C5 的 Catmull–Rom 只在「均匀拍链」启用；非均匀段退回线性 ⇒ 硬折角。
// 本探针把条件放宽成「无邻居就线性、有邻居就 CR」（monkey-patch），看尖角长尾是否由
// 未覆盖段贡献。口径同 diag-turns（24s 窗、运动步、剔门将）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const DT = 0.2;
const SPEED_MIN = 0.5;
const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const h = (s.length - 1) * p; const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function turnStats(framesMeters, { win = 24, step = 12 } = {}) {
  const T = framesMeters[framesMeters.length - 1].t;
  const perWin = [];
  for (let s = 0; s + win <= T + 1e-6; s += step) {
    const w = framesMeters.filter((f) => f.t >= s && f.t < s + win);
    if (w.length < (win / DT) * 0.8) continue;
    const byId = new Map();
    for (const f of w) for (const p of f.players) {
      if (!p || p.id === 0 || p.id === 21) continue;
      if (!byId.has(p.id)) byId.set(p.id, []);
      byId.get(p.id).push([p.x, p.y]);
    }
    const turns = [];
    for (const pts of byId.values()) {
      const v = [];
      for (let i = 1; i < pts.length; i += 1) v.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
      const sp = v.map(([dx, dy]) => Math.hypot(dx, dy) / DT);
      for (let i = 1; i < v.length; i += 1) {
        if (!(sp[i] > SPEED_MIN && sp[i - 1] > SPEED_MIN)) continue;
        const da = Math.atan2(v[i][1], v[i][0]) - Math.atan2(v[i - 1][1], v[i - 1][0]);
        let d = ((da * 180) / Math.PI) % 360;
        if (d > 180) d -= 360; if (d < -180) d += 360;
        turns.push(Math.abs(d));
      }
    }
    const sorted = [...turns].sort((a, b) => a - b);
    const total = turns.reduce((a, b) => a + b, 0);
    const topN = Math.max(1, Math.floor(sorted.length * 0.1));
    perWin.push({
      p50: q(sorted, 0.5), p90: q(sorted, 0.9), p99: q(sorted, 0.99),
      fracGt20: turns.filter((x) => x > 20).length / Math.max(1, turns.length),
      top10mass: sorted.slice(-topN).reduce((a, b) => a + b, 0) / (total || 1),
    });
  }
  const out = {};
  for (const k of Object.keys(perWin[0])) out[k] = mean(perWin.map((x) => x[k]));
  return out;
}

const toMeters = (frames, L, W) => frames.map((f) => ({
  t: f.t,
  players: f.players.map((p, i) => (p ? { id: Array.isArray(p) ? i : p.id, x: (Array.isArray(p) ? p[0] : p.x) * L, y: (Array.isArray(p) ? p[1] : p.y) * W } : null)).filter(Boolean),
}));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ');

const frames = toMeters(mm.sampleEngineFrames(createGame(simulateStream(wasm, 42, mm.ENGINE_DURATION_SEC))), 105, 68);
console.log('engine C5 现状      :', fmt(turnStats(frames)));

// 放宽：任何有前后邻居的段都 CR（邻居找法不变，只去掉 0.5–1.5s / 2.2× 均匀性门槛）
const g = createGame(simulateStream(wasm, 42, mm.ENGINE_DURATION_SEC));
const orig = g._smoothNeighborPositions.bind(g);
g._smoothNeighborPositions = (arr, pos, prev, next) => {
  let lo = 0; let hi = arr.length - 1; let p0i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < prev.t - 1e-6) { p0i = mid; lo = mid + 1; } else hi = mid - 1; }
  lo = 0; hi = arr.length - 1; let p3i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t > next.t + 1e-6) { p3i = mid; hi = mid - 1; } else lo = mid + 1; }
  if (p0i < 0 || p3i < 0) return orig(arr, pos, prev, next);
  return { p0: arr[p0i], p3: arr[p3i] };
};
console.log('engine C5 放宽（全段）:', fmt(turnStats(toMeters(mm.sampleEngineFrames(g), 105, 68))));

// 完全关掉（线性插值）
const g2 = createGame(simulateStream(wasm, 42, mm.ENGINE_DURATION_SEC));
g2._smoothNeighborPositions = () => null;
console.log('engine C5 全关      :', fmt(turnStats(toMeters(mm.sampleEngineFrames(g2), 105, 68))));

const files = ['real-game-1.json', 'real-game-2.json'];
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(join(ROOT, 'viewer/data'))) if (/^skillcorner-.*\.json$/.test(f)) files.push(f);
const per = [];
for (const f of files) {
  const gg = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8'));
  const pm = gg.meta && gg.meta.pitchMeters;
  per.push(turnStats(toMeters(gg.frames, pm ? pm.length : 105, pm ? pm.width : 68)));
}
const realMean = {};
for (const k of Object.keys(per[0])) realMean[k] = mean(per.map((x) => x[k]));
console.log('real 22 场均值     :', fmt(realMean));
