// R4 探针：位移方向分布（C 裁判在 R3 验收里用的线索，改成数值口径并两侧并排）。
// 口径：
//   - 两种采样都报：packet 口径（每窗 8 帧、3.43s 间隔，与盲测接触图同）、0.2s 口径（逐帧）；
//   - 逐球员算 |dx| 与 |dy| 的路径和（剔门将）；xShare = Σ|dx| / (Σ|dx|+Σ|dy|)；
//   - hDom = 该窗内 xShare>0.7 的球员占比（就是 C 的「>70% 位移沿单一轴」）；
//   - 转角各向异性：位移方向对 +x 轴的 |cos| 中位（>0.7 即东方/西方为主）；
//   - 逐场切 24s 窗、窗内球员中位、逐场算再平均（跨场不拼接）；Metrica 与 SkillCorner 分开报。
// 自检（--selftest）：纯 x 运动 → xShare=1、hDom=1；纯 y → 0/0；45° → xShare=0.5。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const DT = 0.2;
const WIN = 24;
const GAP = 3.4285714285714284; // packet 接触帧间隔（8 帧跨 24s）

const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const h = (s.length - 1) * p; const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function playerShares(pts) {
  let sx = 0; let sy = 0;
  for (let i = 1; i < pts.length; i += 1) {
    sx += Math.abs(pts[i][0] - pts[i - 1][0]);
    sy += Math.abs(pts[i][1] - pts[i - 1][1]);
  }
  const tot = sx + sy;
  if (!(tot > 1e-9)) return null; // 完全静止的球员不计
  return { xShare: sx / tot, cosAbs: sx / tot }; // 轴对齐运动 ⇒ |cos| = xShare
}

// 每窗：packet 采样（8 帧）与 dense 采样（0.2s）各算一遍
function windowDirection(frames, { dense = false } = {}) {
  const byId = new Map();
  for (const f of frames) for (const p of f.players) {
    if (!p || p.id === 0 || p.id === 21) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push([p.x, p.y]);
  }
  const shares = [];
  for (const all of byId.values()) {
    let pts = all;
    if (!dense) {
      // packet 口径：取与原帧最近的第 0, k, 2k... 帧（8 个等距样本）
      const n = 8;
      const idx = Array.from({ length: n }, (_, i) => Math.round((i * (all.length - 1)) / (n - 1)));
      pts = idx.map((i) => all[i]);
    }
    const s = playerShares(pts);
    if (s) shares.push(s);
  }
  if (!shares.length) return null;
  return {
    xShareMed: q(shares.map((s) => s.xShare), 0.5),
    // 单轴支配度：x 或 y 任一轴占路径 >70%（与 C 的口径一致：不偏向某一轴）
    hDom: shares.filter((s) => Math.abs(s.xShare - 0.5) > 0.2).length / shares.length,
  };
}

export function matchWindows(frames, { dense = false } = {}) {
  const T = frames[frames.length - 1].t;
  const out = [];
  for (let s = 0; s + WIN <= T + 1e-6; s += 12) {
    let w = frames.filter((f) => f.t >= s && f.t < s + WIN);
    if (w.length < (WIN / DT) * 0.8) continue;
    if (!dense) {
      // 8 帧等距（3.43s）：与 packet 接触帧一致的就近取帧
      const times = Array.from({ length: 8 }, (_, i) => s + (i * WIN) / 7);
      w = times.map((t) => w.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), w[0]));
    }
    const d = windowDirection(w, { dense });
    if (d) out.push(d);
  }
  return out;
}

export function summarize(perMatch) {
  const flat = perMatch.flat();
  return {
    windows: flat.length,
    xShareMed: mean(flat.map((x) => x.xShareMed)),
    hDom: mean(flat.map((x) => x.hDom)),
  };
}

const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('probe-direction.mjs');
if (IS_ENTRY) {
  if (process.argv.includes('--selftest')) {
    const line = [{ t: 0, players: [{ id: 1, x: 0, y: 0 }] }];
    for (let i = 1; i < 200; i += 1) line.push({ t: i * DT, players: [{ id: 1, x: i * 0.01, y: 0 }] });
    const d1 = windowDirection(line, { dense: true });
    if (!(Math.abs(d1.xShareMed - 1) < 1e-9 && Math.abs(d1.hDom - 1) < 1e-9)) throw new Error(`selftest x: ${JSON.stringify(d1)}`);
    // 纯 y 也是「单轴支配」——hDom 必须为 1（防只惩罚 x 方向）
    const lineY = []; for (let i = 0; i < 200; i += 1) lineY.push({ t: i * DT, players: [{ id: 1, x: 0, y: i * 0.01 }] });
    const d2 = windowDirection(lineY, { dense: true });
    if (!(d2.xShareMed < 1e-9 && Math.abs(d2.hDom - 1) < 1e-9)) throw new Error(`selftest y: ${JSON.stringify(d2)}`);
    const diag = []; for (let i = 0; i < 200; i += 1) diag.push({ t: i * DT, players: [{ id: 1, x: i * 0.01, y: i * 0.01 }] });
    const d3 = windowDirection(diag, { dense: true });
    if (!(Math.abs(d3.xShareMed - 0.5) < 1e-9 && Math.abs(d3.hDom) < 1e-9)) throw new Error(`selftest diag: ${JSON.stringify(d3)}`);
    console.log('selftest OK', JSON.stringify({ x: d1, y: d2, diag: d3 }));
    process.exit(0);
  }
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { Game } = await import(join(ROOT, 'viewer/game.js'));
  const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const { readdirSync } = await import('node:fs');
  const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  if (!ok) { console.error('wasm 加载失败'); process.exit(2); }
  const seeds = (process.argv[2] || '42,7').split(',').map(Number);
  const engDense = []; const engPacket = [];
  for (const seed of seeds) {
    const { events, lineup } = parseEventStream(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
    const g = new Game(events, lineup, 'continuous');
    const frames = mm.sampleEngineFrames(g).map((f) => ({ t: f.t, players: f.players }));
    engDense.push(matchWindows(frames, { dense: true }));
    engPacket.push(matchWindows(frames, { dense: false }));
  }
  const realDense = []; const realPacket = []; const names = [];
  const files = ['real-game-1.json', 'real-game-2.json'];
  for (const f of readdirSync(join(ROOT, 'viewer/data'))) if (/^skillcorner-.*\.json$/.test(f)) files.push(f);
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8'));
    const frames = g.frames.map((fr) => ({ t: fr.t, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)).filter(Boolean) }));
    realDense.push(matchWindows(frames, { dense: true }));
    realPacket.push(matchWindows(frames, { dense: false }));
    names.push(f);
  }
  const fmt = (s) => `xShare=${s.xShareMed.toFixed(3)} hDom=${s.hDom.toFixed(3)} (win=${s.windows})`;
  console.log(`engine seeds=${seeds.join(',')}`);
  console.log(`  dense :`, fmt(summarize(engDense)));
  console.log(`  packet:`, fmt(summarize(engPacket)));
  console.log(`real 22`);
  console.log(`  dense :`, fmt(summarize(realDense)));
  console.log(`  packet:`, fmt(summarize(realPacket)));
  console.log(`  metrica2 packet:`, fmt(summarize(realPacket.slice(0, 2))));
  console.log(`  skillc20 packet:`, fmt(summarize(realPacket.slice(2))));
}
