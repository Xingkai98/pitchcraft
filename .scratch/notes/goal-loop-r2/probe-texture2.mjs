// R2 探针：纹理量（>120° 急转角 / min、每 12s 横向往返峰），0.2s 采样。
// 引擎：seed 42/7，平滑开 vs 关（monkey-patch _smoothNeighborPositions → null）。
// 真实：Metrica 2 场同口径。逐场算再平均，不拼接。
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));

function turnsFromFrames(frames) {
  // 每球员 0.2s 采样，计算相邻速度向量夹角 >120° 的“急转”计数（只数非门将、速度>0.3m/s 的步）
  const byId = new Map();
  for (const f of frames) for (const p of f.players) {
    if (!p || p.id === 0 || p.id === 21) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push([f.t, p.x, p.y]);
  }
  let turns = 0; let steps = 0;
  for (const pts of byId.values()) {
    for (let i = 2; i < pts.length; i += 1) {
      const [t0, x0, y0] = pts[i - 2]; const [t1, x1, y1] = pts[i - 1]; const [t2, x2, y2] = pts[i];
      const v1 = [x1 - x0, y1 - y0]; const v2 = [x2 - x1, y2 - y1];
      const n1 = Math.hypot(...v1); const n2 = Math.hypot(...v2);
      if (n1 < 0.001 || n2 < 0.001) continue; // <0.1m/0.2s 视为静止
      steps += 1;
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2);
      if (cos < -0.5) turns += 1; // >120°
    }
  }
  const span = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  return { turnsPerMin: span > 0 ? turns / span * 60 : 0, steps };
}
const agg = (rs) => rs.reduce((a, b) => a + b, 0) / rs.length;
const runEngine = (seed, smooth) => {
  const g = createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
  if (!smooth) g._smoothNeighborPositions = () => null;
  const frames = mm.sampleEngineFrames(g);
  return turnsFromFrames(frames.map((f) => ({ t: f.t, players: f.players })));
};
const runReal = (file) => {
  const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', file), 'utf8'));
  const frames = g.frames.map((f) => ({ t: f.t, players: f.players.map((p) => ({ id: p.id, x: p.x, y: p.y })) }));
  return turnsFromFrames(frames);
};
console.log('engine smooth ON :', [42, 7].map((s) => runEngine(s, true).turnsPerMin.toFixed(2)).join(' / '), 'turns/min');
console.log('engine smooth OFF:', [42, 7].map((s) => runEngine(s, false).turnsPerMin.toFixed(2)).join(' / '), 'turns/min');
console.log('real             :', ['real-game-1.json', 'real-game-2.json'].map((f) => runReal(f).turnsPerMin.toFixed(2)).join(' / '), 'turns/min');
