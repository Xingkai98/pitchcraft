// R3 诊断：转角分位数 / 转角质量集中度 / 多截止频率高通残差 / C5 开关节对照。
// 目的：把「引擎 vs 真实」的纹理差拆成「高频噪声」与「拐角尖峰 vs 连续曲率」。
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

export function tracks(framesMeters) {
  const byId = new Map();
  for (const f of framesMeters) for (const p of f.players) {
    if (!p || p.id === 0 || p.id === 21) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push([p.x, p.y]);
  }
  return [...byId.values()];
}

// 每个轨迹：滑动平均残差（多截止）、转角序列（有符号，度）
export function analyze(pts) {
  const n = pts.length;
  const v = [];
  for (let i = 1; i < n; i += 1) v.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  const speed = v.map(([dx, dy]) => Math.hypot(dx, dy) / DT);
  const turns = []; // {deg, absDeg}
  for (let i = 1; i < v.length; i += 1) {
    if (!(speed[i] > SPEED_MIN && speed[i - 1] > SPEED_MIN)) continue;
    const da = Math.atan2(v[i][1], v[i][0]) - Math.atan2(v[i - 1][1], v[i - 1][0]);
    let d = ((da * 180) / Math.PI) % 360;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    turns.push(Math.abs(d));
  }
  const hp = {};
  for (const w of [3, 5, 7, 11]) {
    const half = (w - 1) / 2;
    const res = [];
    for (let i = half; i < n - half; i += 1) {
      if (!(speed[Math.min(i, speed.length - 1)] > SPEED_MIN || speed[Math.max(0, i - 1)] > SPEED_MIN)) continue;
      let mx = 0; let my = 0;
      for (let k = i - half; k <= i + half; k += 1) { mx += pts[k][0]; my += pts[k][1]; }
      mx /= w; my /= w;
      res.push(Math.hypot(pts[i][0] - mx, pts[i][1] - my));
    }
    hp[`hp${w}`] = res.length ? Math.sqrt(mean(res.map((x) => x * x))) : null;
  }
  return { turns, hp };
}

export function summarize(trackList) {
  const turns = trackList.flatMap((t) => t.turns);
  const sorted = [...turns].sort((a, b) => a - b);
  const total = turns.reduce((a, b) => a + b, 0);
  // 质量集中度：最大 10% 步占总转角量份额
  const topN = Math.max(1, Math.floor(sorted.length * 0.1));
  const topMass = sorted.slice(-topN).reduce((a, b) => a + b, 0);
  const hp = {};
  for (const k of ['hp3', 'hp5', 'hp7', 'hp11']) {
    const vals = trackList.map((t) => t.hp[k]).filter((x) => x != null);
    hp[k] = vals.length ? mean(vals) : null;
  }
  return {
    n: turns.length,
    p50: q(sorted, 0.5), p90: q(sorted, 0.9), p99: q(sorted, 0.99), max: sorted[sorted.length - 1],
    fracGt20: turns.filter((x) => x > 20).length / Math.max(1, turns.length),
    top10mass: total > 0 ? topMass / total : null,
    ...hp,
  };
}

export const toMeters = (frames, L, W) => frames.map((f) => ({
  t: f.t,
  players: f.players.map((p, i) => {
    if (!p) return null;
    if (Array.isArray(p)) return { id: i, x: p[0] * L, y: p[1] * W };
    return { id: p.id, x: p.x * L, y: p.y * W };
  }).filter(Boolean),
}));

// 24s 窗逐窗分析 → 场均 → 源均值（不跨场拼接）
export function matchTracks(frames, { win = 24, step = 12 } = {}) {
  const T = frames[frames.length - 1].t;
  const per = [];
  for (let s = 0; s + win <= T + 1e-6; s += step) {
    const w = frames.filter((f) => f.t >= s && f.t < s + win);
    if (w.length < (win / DT) * 0.8) continue;
    per.push(summarize(tracks(w).map(analyze)));
  }
  const keys = Object.keys(per[0]);
  const out = {};
  for (const k of keys) out[k] = mean(per.map((x) => x[k]));
  return out;
}

const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('diag-turns.mjs');
if (IS_ENTRY) {
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));

const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`).join(' ');

const seeds = [42, 7];
const engineOn = [];
const engineOff = [];
for (const seed of seeds) {
  const frames = toMeters(mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC))), 105, 68);
  engineOn.push(matchTracks(frames));
  const g = createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
  g._smoothNeighborPositions = () => null; // C5 关
  engineOff.push(matchTracks(toMeters(mm.sampleEngineFrames(g), 105, 68)));
}
const files = ['real-game-1.json', 'real-game-2.json'];
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(join(ROOT, 'viewer/data'))) if (/^skillcorner-.*\.json$/.test(f)) files.push(f);
const real = [];
for (const f of files) {
  const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8'));
  const pm = g.meta && g.meta.pitchMeters;
  real.push(matchTracks(toMeters(g.frames, pm ? pm.length : 105, pm ? pm.width : 68)));
}
console.log('engine C5 ON :', fmt(engineOn[0]));
console.log('engine C5 OFF:', fmt(engineOff[0]));
console.log('real mean    :', fmt(real.reduce((acc, r) => {
  for (const k of Object.keys(r)) acc[k] = (acc[k] || 0) + r[k] / real.length;
  return acc;
}, {})));
console.log('real per-match turnSd-ish p99:', real.map((r) => r.p99.toFixed(1)).join(','));
}
