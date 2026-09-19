// P38 #91：判据评测器 —— 在一组候选判据上跑「真实 / 基线 / 各 hack 变体」，
// 看**哪些判据真能区分**（而不是凭直觉立法）。
//
// 用法：node eval-criteria.mjs <标签>      # 对当前 viewer/engine.wasm 求值
//       node eval-criteria.mjs --real      # 对真实比赛数据求值
//
// 输出 JSON 一行，供 drive-criteria.mjs 汇总成表。

import { readFileSync } from 'node:fs';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const HERE = '/home/happy/.claude/worktrees/wayfinder-realism';
const label = process.argv[2] || 'current';
const isReal = label === '--real';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const qs = (s, p) => { const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};

// 统一到「离本方门线距离」的该队 10 名非门将 x（升序）
function teamXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length < 7) return null;
  const xs = out.sort((a, b) => a - b);
  return isHome ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
}

function outfield(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}

function evaluate(frames, tag) {
  // ── 1. 三窗口指标（与 P37 口径一致：q10-q90 纵深等）──
  const wins = cutWindows(frames).map((w) => windowMetrics(w).primary).filter(Boolean);
  const hd = mean(wins.map((w) => w.hd));
  const spread = mean(wins.map((w) => w.spread));
  const gap = mean(wins.map((w) => w.gap));
  const width = mean(wins.map((w) => w.width));

  // ── 2. 窗内个体横向/纵向位移 sd（120s 窗，与视觉探针同口径）──
  const seg = frames.filter((f) => f.t >= 1800 && f.t <= 1920);
  const latSd = []; const lonSd = [];
  for (let id = 1; id <= 10; id += 1) {
    const pts = seg.map((f) => f.players.find((x) => x.id === id)).filter(Boolean);
    if (pts.length < 50) continue;
    latSd.push(sd(pts.map((p) => p.y * PITCH_WIDTH_M)));
    lonSd.push(sd(pts.map((p) => p.x * PITCH_LENGTH_M)));
  }

  // ── 3. swarm：窗内 y 两两相关 ──
  const cors = [];
  const yseq = {};
  for (let id = 1; id <= 10; id += 1) yseq[id] = seg.map((f) => f.players.find((x) => x.id === id)?.y).filter((v) => v != null);
  for (let i = 1; i <= 10; i += 1) {
    for (let j = i + 1; j <= 10; j += 1) if (yseq[i].length > 50 && yseq[j].length > 50) cors.push(corr(yseq[i], yseq[j]));
  }

  // ── 4. 轨迹直线度 ──
  const straight = [];
  for (let id = 1; id <= 10; id += 1) {
    const pts = seg.map((f) => f.players.find((x) => x.id === id)).filter(Boolean).map((p) => [p.x * PITCH_LENGTH_M, p.y * PITCH_WIDTH_M]);
    if (pts.length < 10) continue;
    let path = 0;
    for (let i = 1; i < pts.length; i += 1) path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const net = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
    if (path > 1) straight.push(net / path);
  }

  // ── 5. 断层 + 各线移动量均衡（整段，非窗口）──
  const acc = Array.from({ length: 10 }, () => []);
  const byId = new Map();
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = teamXs(f, team);
      if (!xs) continue;
      for (let i = 0; i < 10; i += 1) acc[i].push(xs[i]);
      for (const p of outfield(f, team)) {
        const key = `${team}-${p.id}`;
        if (!byId.has(key)) byId.set(key, { team, id: p.id, x: [] });
        byId.get(key).x.push(team === 'home' ? p.x * PITCH_LENGTH_M : (1 - p.x) * PITCH_LENGTH_M);
      }
    }
  }
  const P = acc.map(mean);
  const gaps = P.slice(1).map((v, i) => v - P[i]);
  const slotSd = [];
  for (const a of byId.values()) if (a.x.length > 200) slotSd.push({ team: a.team, id: a.id, sdX: sd(a.x) });
  const grp = (t, lo, hi) => {
    const sel = slotSd.filter((r) => r.team === t && r.id >= lo && r.id <= hi);
    return sel.length ? mean(sel.map((r) => r.sdX)) : NaN;
  };
  const midBack = grp('home', 5, 8) / grp('home', 1, 4);

  return {
    tag,
    hd: +hd.toFixed(2), spread: +spread.toFixed(2), gap: +gap.toFixed(2), width: +width.toFixed(2),
    latSd: +mean(latSd).toFixed(2), lonSd: +mean(lonSd).toFixed(2),
    swarm: +mean(cors).toFixed(3),
    straight: +mean(straight).toFixed(3),
    fault: +Math.max(...gaps).toFixed(1),
    midBack: +midBack.toFixed(2),
    nWin: wins.length,
  };
}

if (isReal) {
  for (const g of ['1', '2']) {
    const d = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${g}.json`, 'utf8'));
    const frames = d.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
    console.log(JSON.stringify(evaluate(frames, `real-game${g}`)));
  }
} else {
  const load = await loadEngineWasm(WASM_PATH);
  if (!load.ok) { console.error(load.message); process.exit(1); }
  const { createGame } = await import(`${HERE}/viewer/game.js`);
  const all = [];
  for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
    const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
    all.push(...sampleEngineFrames(game));
  }
  console.log(JSON.stringify(evaluate(all, label)));
}
