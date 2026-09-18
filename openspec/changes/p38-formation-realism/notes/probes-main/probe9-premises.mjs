// probe 9：三个方案各自的核心前提的实证
//  (A) 越位线/盯人：本方后 4 的高度 vs 对方前 2 的高度（回归斜率 + 相关）
//  (B) 球队块：块中心 vs 球位的回归（两侧对照），块纵深随球位
//  (C) 支撑距离：每名球员到最近 1/2/3 名队友的距离分布
//  (D) 甲1 的收敛性：迭代「防线 = 对方锋线高度」是否会跑到边界

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const cov = (a, b) => mean(a.map((v, i) => v * b[i])) - mean(a) * mean(b);
const slope = (x, y) => cov(x, y) / (sd(x) ** 2);
const corr = (x, y) => cov(x, y) / (sd(x) * sd(y));

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const EF = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) EF.push(...w);
}
const RF = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) RF.push(...w);
}
// 统一到「攻向 x=1」的坐标；返回该队按深度升序的 10 个 x（米）
function xsSorted(f, team) {
  const isHome = team === 'home';
  const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
  if (ps.length < 10) return null;
  return ps.map((p) => (isHome ? p.x : 1 - p.x) * PITCH_LENGTH_M).sort((a, b) => a - b);
}

// ── (A) 越位线 / 盯人 ──────────────────────────────────────────────────
console.log('=== (A) 主队「后 4」高度 vs 客队「前 2」高度（均在同一「客队攻向 x=1」坐标系下）===');
console.log('  口径：A队后4 = A队最深的 4 人平均 x（离 A 本方门线）；B队前2 = B 队最前的 2 人离 B 本方门线。');
console.log('  若越位线平齐：两个数应当接近（同一条越位线，镜像看待）。');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const ax = []; const ay = []; const bx = []; const by = [];
  const cells = new Map();
  for (const f of FR) {
    const h = xsSorted(f, 'home'); const a = xsSorted(f, 'away');
    if (!h || !a) continue;
    const hRear = mean(h.slice(0, 4)); const hFront = mean(h.slice(8, 10));
    const aRear = mean(a.slice(0, 4)); const aFront = mean(a.slice(8, 10));
    // 主队后4 与 客队前2（客队视角离客队门线的距离 = 105 - x）
    ax.push(hRear); ay.push(aFront);
    bx.push(aRear); by.push(hFront);
    const k = Math.min(9, Math.floor(hRear / 10.5));
    if (!cells.has(k)) cells.set(k, { a: [], b: [] });
    cells.get(k).a.push(mean(h.slice(0, 4))); cells.get(k).b.push(mean(a.slice(8, 10)));
  }
  console.log(`  ${label}  n=${ax.length}`);
  console.log(`    主队后4  vs 客队前2 : 主队后4 = ${mean(ax).toFixed(1)} 客队前2 = ${mean(ay).toFixed(1)}  差 ${(mean(ax) - mean(ay)).toFixed(1)}  corr ${corr(ax, ay).toFixed(2)}  斜率 ${slope(ay, ax).toFixed(2)}`);
  console.log(`    客队后4  vs 主队前2 : 客队后4 = ${mean(bx).toFixed(1)} 主队前2 = ${mean(by).toFixed(1)}  差 ${(mean(bx) - mean(by)).toFixed(1)}  corr ${corr(bx, by).toFixed(2)}  斜率 ${slope(by, bx).toFixed(2)}`);
  console.log('    按主队后4 分箱 → 主队后4 均值 / 客队前2 均值: '
    + [...cells.entries()].sort((p, q) => p[0] - q[0]).map(([k, v]) => `${(k * 10.5).toFixed(0)}m:${mean(v.a).toFixed(0)}/${mean(v.b).toFixed(0)}`).join('  '));
}

// ── (B) 球队块中心 vs 球 ────────────────────────────────────────────────
console.log('\n=== (B) 块中心（10 名非门将 x 的均值，离本方门线）vs 球位 ===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const X = []; const Y = []; const D = [];
  const edges = [0, 21, 42, 63, 84, 105];
  const cells = edges.slice(0, -1).map(() => []);
  for (const f of FR) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const h = xsSorted(f, 'home'); const a = xsSorted(f, 'away');
    if (!h || !a) continue;
    const ballOwn = f.ball[0] * 105;
    X.push(ballOwn); Y.push(mean(h));
    D.push(h[9] - h[0]);
    cells[Math.max(0, Math.min(4, Math.floor(ballOwn / 21)))].push(h[9] - h[0]);
  }
  const s = slope(X, Y); const c = mean(Y) - s * mean(X);
  console.log(`  ${label}  中心 = ${c.toFixed(1)} + ${s.toFixed(3)}·ball    corr ${corr(X, Y).toFixed(3)}`);
  console.log(`    块全跨度 均值 ${mean(D).toFixed(1)} 分箱 ${cells.map((a, i) => `${(edges[i] + 10).toFixed(0)}m:${mean(a).toFixed(1)}`).join('  ')}`);
}

// ── (C) 支撑距离 ────────────────────────────────────────────────────────
console.log('\n=== (C) 到最近 k 名队友的欧氏距离（米）===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const acc = { 1: [], 2: [], 3: [] };
  for (const f of FR) {
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
      if (ps.length < 10) continue;
      for (const p of ps) {
        const ds = ps.filter((q) => q !== p).map((q) => Math.hypot((p.x - q.x) * 105, (p.y - q.y) * 68)).sort((a, b) => a - b);
        acc[1].push(ds[0]); acc[2].push(ds[1]); acc[3].push(ds[2]);
      }
    }
  }
  console.log(`  ${label}  最近1 ${mean(acc[1]).toFixed(1)} (p10 ${pctl(acc[1], 0.1).toFixed(1)} p90 ${pctl(acc[1], 0.9).toFixed(1)})`
    + `  最近2 ${mean(acc[2]).toFixed(1)}  最近3 ${mean(acc[3]).toFixed(1)}`);
  // 同队最近邻距离 < 2.2m 的比例（分离约束的触发率）
  console.log(`    最近邻 <2.2m 比例 ${(acc[1].filter((d) => d < 2.2).length / acc[1].length * 100).toFixed(1)}%   <5m ${(acc[1].filter((d) => d < 5).length / acc[1].length * 100).toFixed(1)}%   >15m ${(acc[1].filter((d) => d > 15).length / acc[1].length * 100).toFixed(1)}%`);
}

// ── (D) 甲1 的收敛性：迭代映射 f(rear) = clamp(对方前2, ...) ────────────
console.log('\n=== (D) 甲1 收敛性：把「防线=对方锋线」写成迭代映射，看不动点 ===');
console.log('  映射：ownRear(t+1) = clamp(oppFront(t) + OFF, JARDIN_LO, BALL_LIMIT)');
console.log('        oppFront(t+1) = clamp(opponentRear_of_me + ownRear(t) + OFF_F, ...)  —— 简化为单侧：');
console.log('  单侧不动点：若 ownRear = ownFront - band, 且 ownRear → oppFront + OFF，则系统要收敛需 |d(oppFront)/d(ownRear)| < 1');
{
  // 简化模型：我方前沿 = 我方后沿 + 25（实测块纵深）；对方后沿 = 对方前沿 - 25；
  // 我方后沿 = 对方前沿 + OFF（盯人）；对方前沿 = 我方后沿 + 25 + OFF_opp
  // 迭代：R_{n+1} = (R_n + 25 + OFF_opp) + OFF
  const OFF = -5; const OPF = 3;
  let R = 30;
  console.log(`   逐步迭代（OFF=${OFF}, 对方前沿 = 我方后沿+25+${OPF}）：`);
  const traj = [];
  for (let i = 0; i < 12; i += 1) { traj.push(R.toFixed(1)); R = Math.min(Math.max(R + 25 + OPF + OFF, 16.5), 95); }
  console.log(`   ${traj.join(' → ')}`);
  console.log('   → 每步增益 25+OPF+OFF = ' + (25 + OPF + OFF).toFixed(1) + '，>0 时单调推进到上限（无不动点）→ 必须引入「球/越位」上限约束才有界。');
}

// ── (E) 基线里的 SkillCorner 数字（交叉验证，不重下数据）────────────────
console.log('\n=== (E) 冻结基线快照（viewer/data/benchmark-baseline.json）===');
try {
  const b = JSON.parse(readFileSync('/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/benchmark-baseline.json', 'utf8'));
  const walk = (o, path = '') => {
    if (o == null || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && 'avg' in v) console.log(`  ${path}${k}: avg ${typeof v.avg === 'number' ? v.avg.toFixed(1) : v.avg} [${v.min != null ? Number(v.min).toFixed(1) : '-'}, ${v.max != null ? Number(v.max).toFixed(1) : '-'}] n=${v.n}`);
      else if (v && typeof v === 'object') walk(v, `${path}${k}.`);
    }
  };
  walk(b);
} catch (e) { console.log('  读取失败:', e.message); }
