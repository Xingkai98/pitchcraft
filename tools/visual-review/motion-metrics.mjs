// 视觉审阅：**运动真实性**指标（对着"球员动没动、怎么动"，不是结果统计）。
//
// ⚠️ 三条口径纪律（都是踩过坑才定的，别图省事改回去）：
//   1. **跨全部窗算，报分布，绝不挑窗**。P143r 主 session 报了"静止率 3%"，其实是
//      单窗（t=600，高活跃窗）挑出来的；同口径全 match 是 56%，裁判复算 35%。挑窗=自欺。
//   2. **位移要用"端点位移/窗"（逐窗算再平均），不是"相邻帧位移"**。相邻帧位移会被
//      0.2s 采样 + 抖动主导，看不出"整块移动"。
//   3. **必须报"方向一致性"**——这是区分"各自跑位"与"整队平移"的唯一判据。
//      = 窗内所有移动球员位移向量两两余弦相似度的均值（1=全体同向, 0=杂乱, 真实~0.6）。
//      P143r 的 v2 加了"个体化相位"却使方向一致性从 0.63 升到 0.80（更整块）——相位不产生个体化。
//
// 用法：node tools/visual-review/motion-metrics.mjs <engine.wasm> [seeds] [winSec]
//   （真实对照自动跑 viewer/data/real-game-1.json）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
const mean = a => a.reduce((u, v) => u + v, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 一帧序列 → 逐窗的 {disp, dirConsist, stillFrac}。窗 = 每 WIN 秒；逐窗算，返回数组。
export function windowStats(frames, WIN) {
  const dt = frames.length > 1 ? frames[1].t - frames[0].t : 0.2;
  const step = Math.max(1, Math.round(WIN / dt));
  const disp = [], dir = [], still = [];
  for (let i = 0; i + step < frames.length; i += step) {
    const a = frames[i], b = frames[i + step];
    const pa = new Map(a.players.map(p => [p.id, p]));
    const vecs = [], mags = [];
    for (const p of b.players) {
      if (p.id === 0 || p.id === 21) continue;      // 剔门将
      const q = pa.get(p.id); if (!q) continue;
      const dx = (p.x - q.x) * 105, dy = (p.y - q.y) * 68, m = Math.hypot(dx, dy);
      mags.push(m);
      if (m > 1) vecs.push([dx / m, dy / m]);       // 只把"真在动"的计入方向一致性
    }
    if (!mags.length) continue;
    disp.push(mean(mags));
    still.push(100 * mags.filter(m => m < 0.5).length / mags.length);   // 静止 = 窗内位移 <0.5m
    if (vecs.length >= 3) {
      let s = 0, n = 0;
      for (let x = 0; x < vecs.length; x++) for (let y = x + 1; y < vecs.length; y++) { s += vecs[x][0] * vecs[y][0] + vecs[x][1] * vecs[y][1]; n++; }
      dir.push(s / n);
    }
  }
  return { disp, dir, still };
}

async function engineFrames(path, seed) {
  const { wasm } = await loadEngineWasm(path);
  return mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)));
}

if (IS_ENTRY) {
  const wasmPath = process.argv[2];
  const realFrames = (() => {
    const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data/real-game-1.json'), 'utf8'));
    return g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean) }));
  })();
  const NSEED = Number(process.argv[3] || 5);
  const WIN = Number(process.argv[4] || 12);
  if (!wasmPath) { console.error('用法: node motion-metrics.mjs <engine.wasm> [seeds] [winSec]'); process.exit(2); }
  const agg = { disp: [], dir: [], still: [] };
  for (let s = 0; s < NSEED; s++) {
    const w = windowStats(await engineFrames(wasmPath, 42 + s), WIN);
    agg.disp.push(...w.disp); agg.dir.push(...w.dir); agg.still.push(...w.still);
  }
  const rw = windowStats(realFrames, WIN);
  const fmt = (v, u = '') => v.length ? `${median(v).toFixed(2)}${u} (n=${v.length})` : 'n/a';
  console.log(`窗口=${WIN}s  引擎 seeds=${NSEED}`);
  console.log(`  [引擎] 端点位移/窗  中位 ${fmt(agg.disp, 'm')}`);
  console.log(`  [引擎] 方向一致性   中位 ${fmt(agg.dir)}   ← 1=整队同向, 真实约 0.6`);
  console.log(`  [引擎] 静止占比(<0.5m) 中位 ${fmt(agg.still, '%')}`);
  console.log(`  [真实] 端点位移/窗  中位 ${fmt(rw.disp, 'm')}`);
  console.log(`  [真实] 方向一致性   中位 ${fmt(rw.dir)}`);
  console.log(`  [真实] 静止占比     中位 ${fmt(rw.still, '%')}`);
}
