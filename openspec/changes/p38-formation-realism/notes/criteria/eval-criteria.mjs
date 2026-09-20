// P38 #91：判据评测器 —— 在一组候选判据上跑「真实 / 基线 / 各 hack 变体」，
// 看**哪些判据真能区分**（而不是凭直觉立法）。
//
// 用法：node eval-criteria.mjs <标签>      # 对当前 viewer/engine.wasm 求值
//       node eval-criteria.mjs --real      # 对真实比赛数据求值
//
// 输出 JSON 一行，供 drive-criteria.mjs 汇总成表。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';
import { CRITERIA_SEEDS, PER_MATCH_SEC } from './seeds.mjs';

// ⚠️ **不要硬编码 worktree 绝对路径**：脚本拷到新 worktree 后会仍指向旧的，
// 导致"在新 worktree 跑"实际跑的是旧 worktree 的 wasm/数据——**看似有效实则串味**。
// 统一基于脚本自身位置上溯（criteria → notes → change → changes → openspec → ROOT）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
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

// ⚠️ **单场求值**（P38 线 B 的口径修正）：不要跨场拼接帧再算 sd——
// 不同场次的球员 y 均值不同，拼接会把**场间偏移**计进方差，sdf 被灌水。
// 实测（probe-latsd-caliber.mjs）：某配置逐场 1.73m vs 拼接 11.26m（**6.5×**），
// 且**方向是反的**——动得越多场间偏移越大、虚高越多，等于**奖励横向大改的 hack**。
// 与 P36「口径分叉 = 数字不可比」是同一个错误，只是发生在**时间轴**上。
// 真实侧（--real）本来就是逐场算再平均，引擎侧必须同口径。
// **普通射门/场**（阶段 1 新增，口径说明见 README「射门口径」）：
// 逐场算 rate 再对场平均——**不是**把各场射门加总除以总时长，两者在场长不齐时不等价。
// 每场先归一化到 90 分钟（`PER_MATCH_SEC`）再平均。
function meanShotsPer90(shots) {
  const rates = shots.filter((s) => s && s.seconds > 0).map((s) => s.regular / s.seconds * PER_MATCH_SEC);
  return rates.length ? mean(rates) : NaN;
}

function evaluateOne(frames, tag, shots = []) {
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
    // 普通射门/场。⚠️ 单场口径下 `shots` 长度为 1，逐场平均退化为该场自身——
    // 汇总层的平均由 evaluateByMatch / 真实侧调用方完成（`matches` 行）。
    shotsReg: +meanShotsPer90(shots).toFixed(2),
    nWin: wins.length,
  };
}

// 逐场算再平均（**正确口径**）：每个场各自算一遍，再对场取均值。
// 合并时：窗口类指标（hd/spread/gap/width）本就逐窗算再平均，可以合并场后取均值；
// 位移 sd 类必须逐场——它们已经逐场算好了，只需对场平均。
// ⚠️ **不要在这个平均里再次除以场数去"合并"射门**——`shotsReg` 已经是每场的 rate，
// 对场取均值才等于「场均普通射门」。若改成"总射门 / 总时长"，场长不齐时会偏。
function evaluateByMatch(perMatch, tag) {
  const rows = perMatch.map((p, i) => evaluateOne(p.frames, `${tag}#${i}`,
    [{ regular: p.shotsRegular, seconds: p.seconds }]));
  const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number');
  const out = { tag, matches: rows.length };
  for (const k of keys) {
    const vals = rows.map((r) => r[k]).filter(Number.isFinite);
    out[k] = vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3) : NaN;
  }
  return out;
}

// 真实侧每场**普通射门**来自 `real-shots.json`（由 real-shots.mjs 从 Metrica RawEventsData
// 提炼）。缺失即报错而不是静默退化成 NaN——射门是阶段 1 新立的判据，静默缺失 =
// 判据组少一条却仍然"全绿"，正是 P38 反复出现的那类假绿。
function loadRealShots() {
  const p = `${HERE}/openspec/changes/p38-formation-realism/notes/criteria/real-shots.json`;
  if (!existsSync(p)) {
    console.error(`缺 real-shots.json —— 先跑：node ${p.replace(`${HERE}/`, '')}`.replace('real-shots.json', 'real-shots.mjs'));
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  return new Map(doc.games.map((g) => [String(g.game), g.shotsRegular]));
}

if (isReal) {
  const realShots = loadRealShots();
  for (const g of ['1', '2']) {
    const d = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${g}.json`, 'utf8'));
    const frames = d.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
    const span = frames[frames.length - 1].t - frames[0].t;
    console.log(JSON.stringify(evaluateOne(frames, `real-game${g}`,
      [{ regular: realShots.get(g), seconds: span }])));
  }
} else {
  const load = await loadEngineWasm(WASM_PATH);
  if (!load.ok) { console.error(load.message); process.exit(1); }
  const { createGame } = await import(`${HERE}/viewer/game.js`);
  const perMatch = [];
  const crashed = [];
  for (const seed of CRITERIA_SEEDS) {
    const stream = simulateStream(load.wasm, seed, ENGINE_DURATION_SEC);
    // ⚠️ **崩溃的种子要如实报出，不能让脚本死掉、也不能静默少算**。
    // 已知触发条件：队形压缩后队友靠得更近 → `emit_tackle_highlight_impl` 的"推开队友"
    // 分支产出同 id 两条 mover → `protocol.js` 抛 `beat mover id duplicate`
    // （见 notes/patches/README.md 的 `fix-tackle-duplicate-mover`）。
    // 这正是**候选方案该被扣分的地方**——静默丢掉崩溃的种子等于把它算成"没崩的那些场"，
    // 是 P38 早期"10 种子崩 5 个仍报均值"那个错误的复现（当时靠人工发现）。
    // 故：崩了就记进 `crashedSeeds` 并**参与判负**（见 evaluateByMatch）。
    try {
      // ← 每场单独一个数组，不拼接。实际观察到的 `matchEnd` 恒为 5400（=一场 90 分钟），
      // 仍取实测值而非常量：口径与真实侧（按帧跨度归一）保持同一个公式。
      const game = createGame(stream);
      perMatch.push({ frames: sampleEngineFrames(game), events: JSON.parse(stream), seconds: game.matchEnd });
    } catch (e) {
      crashed.push({ seed, error: String(e.message).slice(0, 80) });
    }
  }
  const out = evaluateByMatch(perMatch.map((p) => ({
    frames: p.frames,
    seconds: p.seconds,
    shotsRegular: p.events.filter((e) => e.type === 'shot' && e.detail !== 'header').length,
  })), label);
  out.crashedSeeds = crashed.length;
  // 崩溃率 >0 直接判该配置不可用（`shotsReg` 置 NaN → 判据组必红）。
  // 这不是"从严"：一个会让 viewer 崩的队形方案在真实使用中就是不可用的，
  // 锚在**可用性**而不是判据组的拟合度上。
  if (crashed.length) {
    out.shotsReg = NaN;
    console.error(`⚠ ${crashed.length}/${CRITERIA_SEEDS.length} 个种子崩溃（${crashed[0].error}）——该配置判为不可用`);
  }
  console.log(JSON.stringify(out));
}
