// R3 探针：轨迹「高频纹理/粗糙度」，0.2s 采样，引擎 vs 真实 22 场并排。
// 口径：
//   - 只算非门将（id 0/21 剔除）、只算运动步（相邻步速 > 0.5 m/s 的都满足）；
//   - 逐场切 24s 窗（步 12s，与盲测窗同尺度），窗内按球员取中位、窗均后场均，再跨场均值±sd
//     —— **跨场绝不拼接**（逐场算再平均）；
//   - 指标：
//     hpRms  = 1s 居中滑动平均（5 样本）残差的 2D rms（米）——亚 1s 高频抖动幅度；
//     d2Med  = 相邻位移向量二阶差分 |Δv| 的中位（米）——折角/抖动强度（与曲率+噪声都相关）；
//     d2Ratio= rms(|Δv|) / rms(|v|) —— 归一化高频占比（对速度尺度不敏感）；
//     turnSd = 0.2s 位移方向转角（有符号）的 sd（度）——「细密抖动 vs 平滑弧」；
//     step   = 0.2s 步长中位（米）——速度上下文。
// 自检（--selftest）：直线 → hpRms≈0、d2≈0；白噪声 σ → hpRms≈σ·√2 量级、turnSd 随 σ 增大；
//   任何 NaN/Inf 直接报错（探针自审：NaN 比较恒假会造出「看起来通过」的假证据）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const ROOT = process.cwd();
const DT = 0.2;
const SPEED_MIN = 0.5;
const WIN = 24;
const STEP = 12;

const quantile = (sorted, p) => {
  const n = sorted.length;
  if (n === 0) return null;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function meanSd(a) {
  const m = mean(a);
  if (m == null) return { mean: null, sd: null, n: 0 };
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  return { mean: m, sd, n: a.length };
}

// 单球员轨迹（pts=[[x,y],...] 连续 0.2s）→ 该轨迹的原始样本：
//   返回 { d1:[|v|...], d2:[|Δv|...], turn:[deg...], hp:[{t index, residual 2D}], stepMed }
function trackSamples(pts) {
  const n = pts.length;
  const v = [];
  for (let i = 1; i < n; i += 1) v.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  const speed = v.map(([dx, dy]) => Math.hypot(dx, dy) / DT);
  const d1 = []; const d2 = []; const turn = [];
  for (let i = 1; i < v.length; i += 1) {
    if (!(speed[i] > SPEED_MIN && speed[i - 1] > SPEED_MIN)) continue;
    const dx = v[i][0] - v[i - 1][0]; const dy = v[i][1] - v[i - 1][1];
    d1.push(Math.hypot(v[i][0], v[i][1]));
    d2.push(Math.hypot(dx, dy));
    const a0 = Math.atan2(v[i - 1][1], v[i - 1][0]);
    const a1 = Math.atan2(v[i][1], v[i][0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    turn.push((da * 180) / Math.PI);
  }
  // 1s 居中滑动平均残差（5 样本，i=2..n-3）；同样是运动步（中心样本局部速度 > 阈值）
  const hp = [];
  for (let i = 2; i < n - 2; i += 1) {
    if (!(speed[i - 1] > SPEED_MIN || speed[i] > SPEED_MIN)) continue;
    let mx = 0; let my = 0;
    for (let k = i - 2; k <= i + 2; k += 1) { mx += pts[k][0]; my += pts[k][1]; }
    mx /= 5; my /= 5;
    hp.push(Math.hypot(pts[i][0] - mx, pts[i][1] - my));
  }
  return { d1, d2, turn, hp };
}

function windowStats(frames) {
  const byId = new Map();
  for (const f of frames) {
    for (const p of f.players) {
      if (!p || p.id === 0 || p.id === 21) continue;
      if (!byId.has(p.id)) byId.set(p.id, []);
      byId.get(p.id).push([p.x, p.y]);
    }
  }
  const per = { hpRms: [], d2Med: [], d2Ratio: [], turnSd: [], step: [] };
  for (const pts of byId.values()) {
    if (pts.length < 8) continue;
    const s = trackSamples(pts);
    if (s.hp.length >= 5) per.hpRms.push(Math.sqrt(mean(s.hp.map((h) => h * h))));
    if (s.d2.length >= 3) {
      const sorted = [...s.d2].sort((a, b) => a - b);
      per.d2Med.push(quantile(sorted, 0.5));
      const rms2 = Math.sqrt(mean(s.d2.map((x) => x * x)));
      const rms1 = Math.sqrt(mean(s.d1.map((x) => x * x)));
      per.d2Ratio.push(rms2 / rms1);
    }
    if (s.turn.length >= 5) {
      const m = mean(s.turn);
      per.turnSd.push(Math.sqrt(mean(s.turn.map((x) => (x - m) * (x - m)))));
    }
    if (s.d1.length >= 3) {
      const sorted = [...s.d1].sort((a, b) => a - b);
      per.step.push(quantile(sorted, 0.5));
    }
  }
  const out = {};
  for (const [k, arr] of Object.entries(per)) {
    out[k] = arr.length ? quantile([...arr].sort((a, b) => a - b), 0.5) : null;
  }
  return out;
}

// 一场比赛 → 窗统计数组（窗内中位；逐窗，不拼接）
export function matchWindowStats(frames) {
  const T = frames.length ? frames[frames.length - 1].t : 0;
  const out = [];
  for (let s = 0; s + WIN <= T + 1e-6; s += STEP) {
    const w = frames.filter((f) => f.t >= s && f.t < s + WIN);
    if (w.length < WIN / DT * 0.8) continue; // 帧缺口 >20% 的窗不计（如实丢弃，不静默补）
    out.push(windowStats(w));
  }
  return out;
}

export function aggMatches(perMatch) {
  const out = {};
  for (const k of ['hpRms', 'd2Med', 'd2Ratio', 'turnSd', 'step']) {
    const vals = perMatch.map((w) => mean(w.map((x) => x[k]).filter((v) => v != null))).filter((v) => v != null);
    out[k] = meanSd(vals);
  }
  return out;
}

function selfTest() {
  const mk = (fn, n = 400) => Array.from({ length: n }, (_, i) => fn(i));
  // 直线匀速 0.75 m/s（0.15 m/步）
  const line = [];
  for (let i = 0; i < 400; i += 1) line.push({ t: i * DT, players: [{ id: 1, x: i * 0.15, y: 0.5 }] });
  const a = windowStats(line);
  if (!(a.hpRms != null && a.hpRms < 1e-9)) throw new Error(`selftest line: ${JSON.stringify(a)}`);
  if (!(a.turnSd != null && a.turnSd < 1e-9)) throw new Error(`selftest line turn: ${JSON.stringify(a)}`);
  // 固定种子的白噪声叠加直线（每轴均匀 ±0.115m → σ≈0.066m）
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const sig = 0.115;
  const noisy = [];
  for (let i = 0; i < 400; i += 1) {
    noisy.push({ t: i * DT, players: [{ id: 1, x: i * 0.15 + sig * rnd() * 2, y: 0.5 + sig * rnd() * 2 }] });
  }
  const b = windowStats(noisy);
  // 白噪声 σ_axis≈0.066m → 1s 滑动平均残差 hpRms ≈ 1.26σ ≈ 0.08m 量级
  if (!(b.hpRms > 0.03 && b.hpRms < 0.3)) throw new Error(`selftest noise hpRms=${b.hpRms}`);
  if (!(b.turnSd > 20)) throw new Error(`selftest noise turnSd=${b.turnSd}`);
  for (const v of Object.values(b)) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('selftest NaN');
  console.log('selftest OK', JSON.stringify({ line: a, noise: b }));
}

const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('probe-roughness.mjs');
if (IS_ENTRY) {
  if (process.argv.includes('--selftest')) { selfTest(); process.exit(0); }
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { createGame } = await import(join(ROOT, 'viewer/game.js'));
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const SEEDS = (process.argv[2] || '42,7').split(',').map(Number);
  const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  if (!ok) { console.error('wasm 加载失败'); process.exit(2); }
  const t0 = Date.now();
  // 真实帧球员是 [x,y]（或 [x,y,extrap]），引擎帧是 {id,x,y}——两种都吃。
  const toMeters = (frames, L, W) => frames.map((f) => ({
    t: f.t,
    players: f.players.map((p, i) => {
      if (!p) return null;
      if (Array.isArray(p)) return { id: i, x: p[0] * L, y: p[1] * W };
      return { id: p.id, x: p.x * L, y: p.y * W };
    }).filter(Boolean),
  }));
  const enginePerMatch = [];
  for (const seed of SEEDS) {
    const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)));
    enginePerMatch.push(matchWindowStats(toMeters(frames, 105, 68)));
  }
  const files = ['real-game-1.json', 'real-game-2.json'];
  const { readdirSync, statSync } = await import('node:fs');
  for (const f of readdirSync(join(ROOT, 'viewer/data'))) if (/^skillcorner-.*\.json$/.test(f)) files.push(f);
  const realPerMatch = [];
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8'));
    const pm = g.meta && g.meta.pitchMeters;
    const L = pm ? pm.length : 105; const W = pm ? pm.width : 68;
    realPerMatch.push(matchWindowStats(toMeters(g.frames, L, W)));
  }
  // 探针自审：任一源/任一指标拿不到窗统计 = 采集失败，**报错**而不是静默 n/a
  //（合同 §2：缺数据先补齐再跑，绝不静默跳过）。
  const e = aggMatches(enginePerMatch); const r = aggMatches(realPerMatch);
  for (const [name, agg, per] of [['engine', e, enginePerMatch], ['real', r, realPerMatch]]) {
    if (!per.length || per.every((w) => w.length === 0)) throw new Error(`${name}: 没有任何可用窗`);
    for (const [k, v] of Object.entries(agg)) {
      if (v.mean == null || !Number.isFinite(v.mean)) throw new Error(`${name}.${k}: 无有效读数（采集失败）`);
    }
  }
  const fmt = (s) => (s.mean == null ? 'n/a' : `${s.mean.toFixed(3)}±${s.sd.toFixed(3)}(n=${s.n})`);
  console.log(`engine seeds=${SEEDS.join(',')} wasm=${createHash('sha256').update(readFileSync(join(ROOT, 'viewer/engine.wasm'))).digest('hex').slice(0, 8)}`);
  console.log(`engine  ${Object.keys(e).map((k) => `${k}=${fmt(e[k])}`).join(' ')}`);
  console.log(`real22  ${Object.keys(r).map((k) => `${k}=${fmt(r[k])}`).join(' ')}`);
  console.log(`ratio(engine/real) ${Object.keys(e).map((k) => `${k}=${e[k].mean != null && r[k].mean ? (e[k].mean / r[k].mean).toFixed(2) : 'n/a'}`).join(' ')}`);
  // 分数据集对照（Metrica vs SkillCorner）
  const met = aggMatches(realPerMatch.slice(0, 2));
  const skc = aggMatches(realPerMatch.slice(2));
  console.log(`metricа2 ${Object.keys(met).map((k) => `${k}=${fmt(met[k])}`).join(' ')}`);
  console.log(`skillc20 ${Object.keys(skc).map((k) => `${k}=${fmt(skc[k])}`).join(' ')}`);
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
