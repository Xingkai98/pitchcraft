// P38 线 B：**"铁轨"的定量判据**——轨迹形状的 2D 各向异性。
//
// ── 为什么需要这个量 ────────────────────────────────────────────────────
//
// `findings-final.md` §4b 用**看图**发现引擎球员在"水平细线（铁轨）"上移动。
// 线 B 把 `ty`（横向）接上球 y 之后，**latSd 从 0.55 涨到 5.68**（10 倍），
// 但图（`visual/cmp-gated.png` 右）显示：**铁轨转了个 90 度，变成竖直的**。
// 数字大幅改善，病理没变——"看图"再一次看见数字看不见的东西。
//
// 把这件事变成可进 CI 的数：对每个球员 120s 的 (x,y) 点云做 PCA，
// **第二主成分解释的方差占比** `pc2`：
//
//     pc2 ≈ 0   → 点云是一条线（铁轨，无论横竖）
//     pc2 ≈ 0.5 → 点云各向同性（2D 面）
//
// 这个量**同时**抓住"水平铁轨"（基线）和"竖直铁轨"（线 B 的 gated 变体），
// 而 latSd 只抓前者。这正是判据组缺的那一条。
//
// 另附 `area`（凸包面积近似 = 点云标准差椭圆的面积 π·σ1·σ2），
// 以及 x/y 位移比，便于读图对不上时定位。
//
// 用法：node probe-rail-ness.mjs [种子列表]

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const { createGame } = await import(`${ROOT}/viewer/game.js`);
const { sampleEngineFrames, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

// 2×2 协方差矩阵的特征值（闭式解），返回 { l1, l2 } 降序
function eig2(cxx, cxy, cyy) {
  const tr = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr / 2) ** 2 - det));
  return { l1: tr / 2 + disc, l2: tr / 2 - disc };
}

function rails(points) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const mx = mean(xs); const my = mean(ys);
  let cxx = 0; let cxy = 0; let cyy = 0;
  for (const [x, y] of points) { cxx += (x - mx) ** 2; cxy += (x - mx) * (y - my); cyy += (y - my) ** 2; }
  const n = points.length;
  const { l1, l2 } = eig2(cxx / n, cxy / n, cyy / n);
  return { pc2: l1 > 0 ? l2 / (l1 + l2) : NaN, s1: Math.sqrt(Math.max(0, l1)), s2: Math.sqrt(Math.max(0, l2)), area: Math.PI * Math.sqrt(Math.max(0, l1) * Math.max(0, l2)) };
}

function report(label, perPlayer) {
  const pc2 = mean(perPlayer.map((r) => r.pc2));
  const area = mean(perPlayer.map((r) => r.area));
  const s1 = mean(perPlayer.map((r) => r.s1));
  const s2 = mean(perPlayer.map((r) => r.s2));
  console.log(`${label.padEnd(22)} pc2 = ${pc2.toFixed(3)}   主轴σ ${s1.toFixed(1)}m  次轴σ ${s2.toFixed(1)}m  面积 ${area.toFixed(0)}m²`);
  return { pc2, area, s1, s2 };
}

// ── 真实（Metrica 两场）──
const realRes = [];
for (const g of ['1', '2']) {
  const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
  const seg = d.frames.filter((f) => f.t >= 1800 && f.t <= 1920);
  const per = [];
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    if (KEEPER_IDS.includes(id)) continue;
    const pts = seg.map((f) => f.players[id]).filter(Boolean).map((p) => [p[0] * PITCH_LENGTH_M, p[1] * PITCH_WIDTH_M]);
    if (pts.length < 50) continue;
    per.push(rails(pts));
  }
  realRes.push(report(`真实 game${g}`, per));
}
report('真实（两场平均）', [
  { pc2: mean(realRes.map((r) => r.pc2)), area: mean(realRes.map((r) => r.area)), s1: mean(realRes.map((r) => r.s1)), s2: mean(realRes.map((r) => r.s2)) },
]);

// ── 引擎（当前 wasm）──
const seeds = (process.argv[2] || '42,1,7').split(',').map(Number);
const load = await loadEngineWasm(`${ROOT}/viewer/engine.wasm`);
if (!load.ok) { console.error(load.message); process.exit(1); }
const perMatch = [];
for (const seed of seeds) {
  const game = createGame(simulateStream(load.wasm, seed, 5400));
  const frames = sampleEngineFrames(game);
  const seg = frames.filter((f) => f.t >= 1800 && f.t <= 1920);
  const per = [];
  for (let id = 1; id <= 10; id += 1) {
    const pts = seg.map((f) => f.players.find((x) => x.id === id)).filter(Boolean).map((p) => [p.x * PITCH_LENGTH_M, p.y * PITCH_WIDTH_M]);
    if (pts.length < 50) continue;
    per.push(rails(pts));
  }
  perMatch.push(report(`引擎 seed ${seed}`, per));
}
report(`引擎（${seeds.length} 场平均）`, perMatch);
console.log('\n判读：pc2 ≈ 0 = 铁轨（不分横竖）；真实 ≈ 0.5 = 2D 面。');
console.log('      latSd 只能抓"水平铁轨"；pc2 横竖都抓——这是判据组缺的一条。');
