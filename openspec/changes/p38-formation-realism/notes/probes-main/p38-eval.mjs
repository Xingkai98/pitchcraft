// P38 线 A/B 通用评测器：**路径可移植版**的 eval-criteria.mjs + 场均射门。
//
// 为什么有这个文件：`notes/criteria/eval-criteria.mjs` 把仓库根**硬编码**成
// `/home/happy/.claude/worktrees/wayfinder-realism`——它只读那个 worktree 的 wasm。
// 本分支（worktree `p38-formation-mechanism`）做实验时 wasm 在自己目录里，
// 那个脚本读不到。这里把路径改成**由脚本位置上溯**（复用 `probes/repo-root.mjs`），
// 口径代码**逐行照抄**，避免出现第二个口径实现。
//
// ⚠️ 口径一致性自证：脚本会打印「基线自检」行——干净 main 的 wasm（sha 901da77b）
//    应报 hd≈40.4 / latSd≈0.5 量级。对不上说明口径分叉了，**别用它的数字**。
//
// 用法：
//   node p38-eval.mjs <标签> [种子列表] [时长秒]
//   node p38-eval.mjs --real                # 真实侧（Metrica 2 场）
//
// 输出：一行 JSON，含判据组 7 个键 + shotsPerMatch / goalsPerMatch。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);

const M = await import(`${ROOT}/viewer/match-metrics.js`);
const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const { createGame } = await import(`${ROOT}/viewer/game.js`);

const {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, SAMPLE_INTERVAL_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M,
} = M;

const label = process.argv[2] || 'current';
const isReal = label === '--real';
const seeds = process.argv[3] ? process.argv[3].split(',').map(Number) : BENCHMARK_SEEDS.slice(0, 3);
const durationSec = Number(process.argv[4] || ENGINE_DURATION_SEC);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};

// 统一到「离本方门线距离」的该队 10 名非门将 x（升序）。
//
// ⚠️ **必须恰好 10 人**（原版 `eval-criteria.mjs` 写的是 `< 7`，已被证伪——见下）。
//
// `fault`（断层）是**按深度排名**算的：`acc[i]` 收的是「全队第 i 深」的球员。
// 红牌后该队只剩 9 名外场，`xs[9]` 是 `undefined` → `acc[9]` 混进 undefined →
// 均值 NaN → `fault` 报 `null`。这正是 `notes/criteria/README.md` 待办里那条
// 「fault 在 exp4b 上为 —，需修评测器」的**真正根因**（不是 exp4b 特有：
// 任何产红牌的变体都会中招；本轮 lag=0.05 seed 7 就复现了）。
//
// 口径：**人数不足的帧整帧剔除**——9 人队的「第 9 深」与 10 人队的「第 9 深」
// 不是同一个估计量，混池会同时污染均值与断层。`< 7` 那种宽松守卫只防「全队丢失」，
// 挡不住这个。真实侧数据无红牌，故此修复**不改真实参考值**（5.2 / 4.7 照旧）。
function teamXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length !== 10) return null;
  const xs = out.sort((a, b) => a - b);
  return isHome ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
}

function outfield(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}

// ⚠️ 时间轴口径（本函数头等重要的约定，踩过一次）：
//
// **逐人序列必须"逐场算再平均"，不能把多场拼成一个序列。**
//
// 原实现把所有种子的帧 concat 成一条序列再算 sd / 相关。不同场次的球员 y **均值不同**
// （各自的战术相位、初始条件），拼接后这些**场间偏移全部计入 sd** → 横向 sd 被抬高。
// 实测（`probe-latsd-caliber.mjs`，local R=8 配置）：逐场 **1.73m** vs 拼接 **11.26m**，
// **虚高 6.5×**。而且**动得越多的配置虚高越多**——这个缺陷**奖励**横向大改的 hack。
//
// 真实侧（`eval-criteria.mjs --real`）本来就是**逐场算再平均**
// （real-game1 10.81 / real-game2 10.22 → 10.515）。引擎侧拼接 = 口径分叉，
// 与 P36「口径分叉 = 数字不可比」是同一个错误，只是发生在时间轴上。
//
// `swarm`（y 两两相关）同样受影响：拼接会让所有球员共享"场间台阶"→ 相关虚高。
//
// 故 `frames` 现按**场次分组**传入（`byMatch: Frame[][]`），逐场算再平均。
function evaluateByMatch(byMatch, tag) {
  const perMatch = byMatch.map((frames) => evaluateOneMatch(frames));
  const avg = (k) => mean(perMatch.map((m) => m[k]).filter((v) => Number.isFinite(v)));
  const wins = byMatch.flatMap((frames) => cutWindows(frames).map((w) => windowMetrics(w).primary).filter(Boolean));
  const out = { tag, nWin: wins.length, nMatches: byMatch.length };
  for (const k of ['latSd', 'lonSd', 'swarm', 'straight', 'fault', 'midBack']) out[k] = +avg(k).toFixed(k === 'swarm' || k === 'straight' ? 3 : 2);
  for (const k of ['hd', 'spread', 'gap', 'width']) out[k] = +mean(wins.map((w) => w[k])).toFixed(2);
  out.perMatch = perMatch;
  return out;
}

function evaluateOneMatch(frames) {
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
    latSd: +mean(latSd).toFixed(2), lonSd: +mean(lonSd).toFixed(2),
    swarm: +mean(cors).toFixed(3),
    straight: +mean(straight).toFixed(3),
    fault: +Math.max(...gaps).toFixed(1),
    midBack: +midBack.toFixed(2),
  };
}

// 场均射门：从事件流直接数（5400s 一场 → 直接就是「每场」，不折算）。
//
// **拆普通/头球**（`detail === 'header'`）——真实侧 Metrica 两场都是
// **18 普通 + 6 头球 = 24**，而引擎自己的 L1 门断言的是**普通射门 6–11/场**
// （`realism.rs` `l1_shot_result_distributions`）。不拆就直接对比 = 拿两个口径
// 不同的量比大小，是 P36「口径分叉 = 数字不可比」的翻版。
function shotStats(load, usableSeeds) {
  const rows = [];
  for (const s of usableSeeds) {
    const json = JSON.parse(simulateStream(load.wasm, s, durationSec));
    const evs = json.events || json;
    const shots = evs.filter((e) => e.type === 'shot');
    const header = shots.filter((e) => e.detail === 'header');
    rows.push({
      seed: s,
      shotsRegular: shots.length - header.length,
      shotsHeader: header.length,
      shotsTotal: shots.length,
      goals: shots.filter((e) => e.result === 'goal').length,
    });
  }
  const m = (k) => +mean(rows.map((r) => r[k])).toFixed(2);
  return {
    shotsRegularPerMatch: m('shotsRegular'),
    shotsHeaderPerMatch: m('shotsHeader'),
    shotsPerMatch: m('shotsTotal'),
    goalsPerMatch: m('goals'),
    perSeed: rows,
  };
}

// 有些变体下 `createGame` 会**抛错**（`viewer/protocol.js` 的 `beat mover id duplicate`）。
// 这是引擎侧真实缺陷（见 lag-sweep.md §崩溃），但评测器不该因此整批挂掉——
// 否则一个坏种子会把整个扫描打断，而"哪个 lag 会崩"本身就是要测的量。
// 口径：抛错的种子**整场剔除**（不混入均值），种子列表单独记进 `crashedSeeds`；
// 均值同时记 `nSeeds` —— 跨行比较时必须先看 nSeeds 是否一致。
//
// `manDownFrames` 同理要记：红牌后的帧被 `teamXs` 整帧剔除（见该函数注释），
// 场次里红牌越多，`fault` 的有效样本越少——不报出来就看不出 `fault` 何时不可信。
function trySample(load, seed) {
  try {
    const game = createGame(simulateStream(load.wasm, seed, durationSec));
    const frames = sampleEngineFrames(game);
    const manDownFrames = frames.filter(
      (f) => (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id)).length < 20,
    ).length;
    return { ok: true, frames, manDownFrames };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

if (isReal) {
  for (const g of ['1', '2']) {
    const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
    const frames = d.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
    // 真实侧本来就逐场（每场一个文件）——与引擎侧现在的口径一致
    console.log(JSON.stringify(evaluateByMatch([frames], `real-game${g}`)));
  }
} else {
  const load = await loadEngineWasm(`${ROOT}/viewer/engine.wasm`);
  if (!load.ok) { console.error(load.message); process.exit(1); }
  const byMatch = [];
  const crashed = [];
  let manDownFrames = 0;
  for (const seed of seeds) {
    const r = trySample(load, seed);
    if (r.ok) { byMatch.push(r.frames); manDownFrames += r.manDownFrames; } else crashed.push({ seed, reason: r.reason });
  }
  const usable = seeds.filter((s) => !crashed.some((c) => c.seed === s));
  // ⚠️ 逐场分组传入（**不是拼接**）——见 `evaluateByMatch` 头注释：拼接会让 latSd 虚高 6.5×
  const out = evaluateByMatch(byMatch, label);
  out.seeds = usable;
  out.nSeeds = usable.length;
  out.crashedSeeds = crashed;
  out.manDownFrames = manDownFrames;
  Object.assign(out, shotStats(load, usable));
  console.log(JSON.stringify(out));
}
