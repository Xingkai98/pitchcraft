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

// 一帧序列 → 逐窗的 {disp, dir, still, lat, mix}。窗 = 每 WIN 秒；逐窗算，返回数组。
//   disp = 端点位移/窗（动没动）；dir = 方向一致性；still = 静止占比
//   lat  = **横向运动占比** = Σ|dy| / (Σ|dx|+Σ|dy|) —— 「铁轨」信号：球员在水平线上滑 ⇒ 趋 0。
//          2026-10-05 飞轮诊断：实测 main 0.12 / FB4 0.25 / 真实 0.43（眼睛「水平短线」的直接编码；FB4 的 0.25 是「抖动刷分」，见 mix）。
//   mix  = **混队度** = 最近邻是对手的球员占比（逐帧、非门将）—— 「两队是否混在一起」。
//          实测 main 0.65 / FB4 0.61 / 真实 0.80（FB4 没改善、反降 ⇒ 眼睛说「两队仍分开」）。
//          ⚠️ lat 与 mix 缺一不可：**FB4 只改好 lat（抖动刷分）、mix 没动** ⇒ 单看 lat 会被骗。
export function windowStats(frames, WIN) {
  const dt = frames.length > 1 ? frames[1].t - frames[0].t : 0.2;
  const step = Math.max(1, Math.round(WIN / dt));
  const disp = [], dir = [], still = [], lat = [], mix = [];
  for (let i = 0; i + step < frames.length; i += step) {
    const a = frames[i], b = frames[i + step];
    const pa = new Map(a.players.map(p => [p.id, p]));
    const vecs = [], mags = [];
    let sx = 0, sy = 0;
    for (const p of b.players) {
      if (p.id === 0 || p.id === 21) continue;      // 剔门将
      const q = pa.get(p.id); if (!q) continue;
      const dx = (p.x - q.x) * 105, dy = (p.y - q.y) * 68, m = Math.hypot(dx, dy);
      mags.push(m); sx += Math.abs(dx); sy += Math.abs(dy);
      if (m > 1) vecs.push([dx / m, dy / m]);       // 只把"真在动"的计入方向一致性
    }
    if (!mags.length) continue;
    disp.push(mean(mags));
    still.push(100 * mags.filter(m => m < 0.5).length / mags.length);   // 静止 = 窗内位移 <0.5m
    lat.push(sy / (sx + sy + 1e-9));                                     // 横向运动占比
    mix.push(mixing(b));                                                 // 混队度（末帧）
    if (vecs.length >= 3) {
      let s = 0, n = 0;
      for (let x = 0; x < vecs.length; x++) for (let y = x + 1; y < vecs.length; y++) { s += vecs[x][0] * vecs[y][0] + vecs[x][1] * vecs[y][1]; n++; }
      dir.push(s / n);
    }
  }
  return { disp, dir, still, lat, mix };
}

// 混队度：非门将球员里，**最近邻是对手**的比例（逐帧）。0=两队完全分离，0.5=随机混，1=全是异队相邻。
// 用真实的米制距离（x×105 / y×68）——归一化口径在 105×68 球场上会偏 x 方向（本仓 #53 教训）。
export function mixing(frame) {
  const ps = (frame.players || []).filter(p => p && p.id !== 0 && p.id !== 21);
  if (ps.length < 4) return null;
  let opp = 0, tot = 0;
  for (const p of ps) {
    let best = Infinity, bid = -1;
    for (const q of ps) { if (q.id === p.id) continue; const d = Math.hypot((p.x - q.x) * 105, (p.y - q.y) * 68); if (d < best) { best = d; bid = q.id; } }
    if (bid < 0) continue;
    if ((p.id <= 10) !== (bid <= 10)) opp++;
    tot++;
  }
  return tot ? opp / tot : null;
}

async function engineFrames(path, seed) {
  const { wasm } = await loadEngineWasm(path);
  return mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)));
}

if (IS_ENTRY) {
  const wasmPath = process.argv[2];
  // 真实运动锚 = **两场 Metrica 帧，逐场算窗再并**（与 `like-football.mjs` 的 `realMotionFromFrames`
  // **同一组同口径**）——本仓头号纪律：两个工具报的「真实」必须同口径，否则跨工具不可比
  // （review-2 P3：曾一单一双 → 13.3 vs 13.46）。⚠️ **逐场**算窗：两场拼接后再切窗会
  // 跨「场与场」的缝（不同比赛），产生假窗。
  const realByGame = [];
  for (const fn of ['real-game-1.json', 'real-game-2.json']) {
    let g; try { g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', fn), 'utf8')); } catch { continue; }
    realByGame.push(g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean) })));
  }
  const NSEED = Number(process.argv[3] || 5);
  const WIN = Number(process.argv[4] || 12);
  if (!wasmPath) { console.error('用法: node motion-metrics.mjs <engine.wasm> [seeds] [winSec]'); process.exit(2); }
  const agg = { disp: [], dir: [], still: [], lat: [], mix: [] };
  for (let s = 0; s < NSEED; s++) {
    const w = windowStats(await engineFrames(wasmPath, 42 + s), WIN);
    for (const k of Object.keys(agg)) agg[k].push(...w[k]);
  }
  // 真实：**逐场**算窗再并（与 like-football 同口径，见上）。
  const rw = { disp: [], dir: [], still: [], lat: [], mix: [] };
  for (const frames of realByGame) {
    const w = windowStats(frames, WIN);
    for (const k of Object.keys(rw)) rw[k].push(...w[k]);
  }
  const fmt = (v, u = '') => v.length ? `${median(v).toFixed(2)}${u} (n=${v.length})` : 'n/a';
  const fx = (v) => v.length ? median(v).toFixed(3) : 'n/a';
  console.log(`窗口=${WIN}s  引擎 seeds=${NSEED}  真实锚=real-game-1+2（与 like-football 同口径）`);
  console.log(`  [引擎] 端点位移/窗  中位 ${fmt(agg.disp, 'm')}`);
  console.log(`  [引擎] 方向一致性   中位 ${fmt(agg.dir)}   ← 1=整队同向, 真实约 0.6`);
  console.log(`  [引擎] 静止占比(<0.5m) 中位 ${fmt(agg.still, '%')}`);
  console.log(`  [引擎] **横向运动占比 中位 ${fx(agg.lat)}   ← 「铁轨」信号: 趋 0=只水平滑, 真实 ~0.44**`);
  console.log(`  [引擎] **混队度(最近邻异队) ${fx(agg.mix)}   ← 真实 ~0.80**`);
  console.log(`  [真实] 端点位移/窗  中位 ${fmt(rw.disp, 'm')}`);
  console.log(`  [真实] 方向一致性   中位 ${fmt(rw.dir)}`);
  console.log(`  [真实] 静止占比     中位 ${fmt(rw.still, '%')}`);
  console.log(`  [真实] 横向运动占比 中位 ${fx(rw.lat)}`);
  console.log(`  [真实] 混队度       中位 ${fx(rw.mix)}`);
  console.log('');
  console.log(`⚠ 别只信「方向一致性」与「静止占比」：main 的 dir 本就≈真实=没信号；`);
  console.log(`  「静止 <0.5m」阈值=真实位移的 ~1/27（FB4 位移≈真实的 27% 也算"在动"）。`);
  console.log(`  「横向运动占比」能被"抖动"刷分（FB4 0.35）——必须**同时看混队度**（FB4 没改善）。`);
  console.log(`  → **先跑 like-football.mjs**（real-anchored 距离 + 最大缺口），它才是飞轮的头。`);
}
