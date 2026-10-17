// Spike：用「10 Hz + 每球员局部决策 + 连续运动积分」的最小模型，回答一个问题——
// 提高分辨率、把决策下放到每个球员、给运动加上加速度，结构量会不会靠近真实？
//
// 这不是引擎原型，是**证伪实验**：故意做得很笨（无传球物理、无规则、无事件模型），
// 只保留三项与本引擎不同的结构选择：
//   1. 10 Hz 决策（引擎 1 Hz）
//   2. 每球员局部决策（引擎：全体奔向一个全局解析公式的目标点）
//   3. 速度/加速度积分（引擎：每拍直接改坐标、恒速 4 m/s、到目标 2 m 内冻结）
//
// 口径与本仓基准**完全一致**：同一个 `match-metrics.js`、同样 5 Hz 采样、同样 300 s 窗。
// 真实锚 = committed 基线 `viewer/data/benchmark-baseline.json` 的 perMetric.avg。
//
// 用法：node tools/spike-10hz.mjs [秒数]

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const { windowStats } = await import(join(ROOT, 'tools/visual-review/motion-metrics.mjs'));

const L = 105; const W = 68;
const DT = 0.1;            // 10 Hz
const SAMPLE_SEC = 0.2;    // 与基线同口径
const DURATION = Number(process.argv[2] || 1800);
// 显式宽度职责的强度。**默认 0 = 已验证的基线**（§8 的 0.413/0.278 是在 0 上跑出来的）。
// 扫描实测（5400 s）：0 → lat 0.27 / mix 0.75；0.30 → 0.23 / 0.65；0.45 → 0.25 / 0.55；0.60 → 0.28 / 0.55。
// ⇒ **静态拉开宽度不等于横向跑动**（lat 量的是 |dy|/(|dx|+|dy|)，球员到了边线站住就不再产生 dy），
//   且把两队推得更远 → mix（混队度）崩。这个负结果写在报告 §8.7。
const WIDTH_GAIN = Number(process.env.WIDTH_GAIN ?? 0);

const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ── 名义阵型（米，主队进攻 +x；客队镜像）4-4-2 ───────────────────────────
const BASE = [
  [4, 34],                                        // 0 GK
  [30, 14], [30, 27], [30, 41], [30, 54],         // 1-4 后卫（真实球队纵深紧凑，不是 50 m）
  [43, 10], [43, 26], [43, 42], [43, 58],         // 5-8 中场
  [54, 24], [54, 44],                             // 9-10 前锋
];
// 客队镜像（id 11-20 用同一套相对坐标，x 翻转、y 翻转）；21 = 客队门将
const baseOf = (id) => {
  if (id === 0) return BASE[0];
  if (id === 21) return [L - BASE[0][0], BASE[0][1]];
  const home = id <= 10;
  const k = home ? id : id - 10;
  const [x, y] = BASE[k];
  return home ? [x, y] : [L - x, W - y];
};

function createSpike(seed = 1) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const players = [];
  for (let id = 0; id < 22; id += 1) {
    const [x, y] = baseOf(id);
    players.push({ id, x, y, vx: 0, vy: 0, team: id <= 10 ? 0 : 1 });
  }
  let posTeam = 0;               // 0 主队持球
  let carrier = 9;               // 主队前锋
  let ball = [players[carrier].x, players[carrier].y];
  let nextSwitch = 3;
  let t = 0;

  const goalX = (team) => (team === 0 ? L : 0);
  const clampPitch = (p) => { p.x = Math.max(1, Math.min(L - 1, p.x)); p.y = Math.max(1, Math.min(W - 1, p.y)); };

  function steer(p, tx, ty, maxSpeed = 7, accel = 5) {
    const dx = tx - p.x; const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const desired = d < 1e-6 ? 0 : maxSpeed * Math.min(1, d / 3);
    const ux = d > 1e-6 ? dx / d : 0; const uy = d > 1e-6 ? dy / d : 0;
    const dvx = ux * desired - p.vx; const dvy = uy * desired - p.vy;
    const dv = Math.hypot(dvx, dvy); const cap = accel * DT;
    if (dv > cap) { p.vx += (dvx / dv) * cap; p.vy += (dvy / dv) * cap; } else { p.vx += dvx; p.vy += dvy; }
    p.x += p.vx * DT; p.y += p.vy * DT;
    clampPitch(p);
  }

  function tick() {
    t += DT;
    // ── 球权与球推进（粗：无飞行，球跟着持球者；每 3-6 s 一次"传球"）──
    if (t >= nextSwitch) {
      nextSwitch = t + 2 + rnd() * 4;
      const mates = players.filter((p) => p.team === posTeam && p.id !== carrier);
      const near = mates.filter((p) => Math.hypot(p.x - ball[0], p.y - ball[1]) < 28);
      if (near.length) {
        // 25% 传失 → 球权转移
        if (rnd() < 0.25) {
          posTeam = 1 - posTeam;
          const opps = players.filter((p) => p.team === posTeam && p.id !== 0 && p.id !== 21);
          let best = opps[0]; let bd = Infinity;
          for (const p of opps) { const d = Math.hypot(p.x - ball[0], p.y - ball[1]); if (d < bd) { bd = d; best = p; } }
          carrier = best.id;
        } else {
          let best = near[0]; let bd = Infinity;
          for (const p of near) { const d = Math.hypot(p.x - ball[0], p.y - ball[1]); if (d < bd) { bd = d; best = p; } }
          carrier = best.id;
        }
      }
    }
    const c = players[carrier];
    // 持球者带球朝对方球门推进（带一点纵向摆动）
    const gx = goalX(posTeam); const gy = W / 2;
    steer(c, gx, gy + Math.sin(t * 0.35 + seed) * 14, 5, 4);
    // 球 = 持球者脚下（略偏进攻方向）
    ball = [c.x + (gx > c.x ? 0.6 : -0.6), c.y];

    // ── 每球员局部决策 ──
    for (const p of players) {
      if (p.id === carrier) continue;
      if (p.id === 0 || p.id === 21) {           // 门将：跟球 y，站门线附近
        const home = p.team === 0;
        steer(p, home ? 2 : L - 2, W / 2 + (ball[1] - W / 2) * 0.45, 4, 5);
        continue;
      }
      if (p.team === posTeam) {
        // 攻方：2 名最近者提供接应，其余按阵型随球平移
        const mates = players.filter((q) => q.team === p.team && q.id !== carrier && q.id !== 0 && q.id !== 21);
        const byDist = [...mates].sort((a, b) => Math.hypot(a.x - ball[0], a.y - ball[1]) - Math.hypot(b.x - ball[0], b.y - ball[1]));
        const rank = byDist.findIndex((q) => q.id === p.id);
        if (rank === 0) {
          // 接应点：持球者前方 10 m、侧向拉开
          const dir = goalX(posTeam) > ball[0] ? 1 : -1;
          const side = (p.id % 2 === 0 ? 1 : -1) * 10;
          steer(p, ball[0] + dir * 10, Math.max(4, Math.min(W - 4, ball[1] + side)), 7, 5);
        } else {
          const [bx, by] = baseOf(p.id);
          // 阵型随球纵向平移 + 横向保持（这是"局部"的：只读球位，不读队友全局）
          const shiftX = (ball[0] - L / 2) * 0.62;
          // ← §8.4：显式宽度职责。按名义站位的"边路程度"把球员往外推，
          //   这是 agent 自己的属性，不是全局公式。GAIN=0 即退化为加宽前的版本。
          const widen = by + (by - W / 2) * WIDTH_GAIN;
          steer(p, bx + shiftX, widen + (ball[1] - W / 2) * 0.22, 6, 5);
        }
      } else {
        // 守方：最近 3 人压迫持球者（站在球与自家球门之间），其余盯人 + 保持越位线
        const mine = players.filter((q) => q.team === p.team && q.id !== 0 && q.id !== 21);
        const byDist = [...mine].sort((a, b) => Math.hypot(a.x - ball[0], a.y - ball[1]) - Math.hypot(b.x - ball[0], b.y - ball[1]));
        const rank = byDist.findIndex((q) => q.id === p.id);
        const gx = goalX(posTeam);
        const towardOwn = gx > ball[0] ? -1 : 1;   // 自家球门方向
        if (rank < 3) {
          // 压迫点：持球者向自家球门方向 1.5 m
          steer(p, ball[0] + towardOwn * 1.5, ball[1], 7.5, 6);
        } else {
          // 盯人：找最近的对方非持球球员，站位在球门侧 2 m；同时受越位线约束
          const opps = players.filter((q) => q.team !== p.team && q.id !== carrier && q.id !== 0 && q.id !== 21);
          let mark = null; let bd = Infinity;
          for (const q of opps) {
            const d = Math.hypot(q.x - p.x, q.y - p.y) + Math.abs(q.y - p.y) * 0.4;
            if (d < bd) { bd = d; mark = q; }
          }
          const lineX = Math.max(12, Math.min(L - 12, ball[0] + towardOwn * 9));
          const tx = mark ? mark.x + towardOwn * 2 : lineX;
          // ← §8.4：盯人不给宽度。与自己的名义站位混合，才能保住防线横向结构。
          const [dbx, dby] = baseOf(p.id);
          const wideTarget = dby + (ball[1] - W / 2) * 0.3;
          const ty = mark ? (1 - WIDTH_GAIN) * mark.y + WIDTH_GAIN * wideTarget : wideTarget;
          steer(p, tx, ty, 6.5, 5.5);
        }
      }
    }
    // 同队分离（避免叠点，模拟"不站一起"）
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const a = players[i]; const b = players[j];
        if (a.team !== b.team) continue;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6 && d < 2.5) {
          const push = (2.5 - d) / 2;
          a.x -= (dx / d) * push; a.y -= (dy / d) * push;
          b.x += (dx / d) * push; b.y += (dy / d) * push;
        }
      }
    }
  }

  function frame(tNow) {
    return {
      t: tNow,
      players: players.map((p) => ({ id: p.id, x: p.x / L, y: p.y / W })),
      ball: [ball[0] / L, ball[1] / W],
      ballFill: null,
      pitchMeters: [L, W],
    };
  }

  return {
    step: () => tick(),
    frame,
    get t() { return t; },
  };
}

function simFrames(durationSec) {
  const sim = createSpike(7);
  const frames = [];
  const steps = Math.round(durationSec / DT);
  const every = Math.round(SAMPLE_SEC / DT);
  for (let i = 0; i < steps; i += 1) {
    sim.step();
    if (i % every === 0) frames.push(sim.frame(sim.t));
  }
  return frames;
}

function shapeOf(frames) {
  const wins = mm.cutWindows(frames);
  const acc = {};
  for (const w of wins) {
    const p = mm.windowMetrics(w).primary;
    if (!p) continue;
    for (const k of ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist']) if (p[k] != null) (acc[k] ||= []).push(p[k]);
  }
  const out = {};
  for (const k of ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist']) out[k] = acc[k] ? mean(acc[k]) : null;
  return { shape: out, windows: wins.length };
}

// ── 引擎侧（真引擎，同口径同种子集）────────────────────────────────────
async function engineShape() {
  const { wasm } = await loadEngineWasm();
  const acc = {};
  for (const seed of mm.BENCHMARK_SEEDS) {
    const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)));
    const { shape } = shapeOf(frames);
    for (const k of Object.keys(shape)) if (shape[k] != null) (acc[k] ||= []).push(shape[k]);
  }
  const out = {};
  for (const k of Object.keys(acc)) out[k] = mean(acc[k]);
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const baseline = JSON.parse(readFileSync(join(ROOT, 'viewer/data/benchmark-baseline.json'), 'utf8'));
// 两个口径都打：primary 跳过外推点（P38 指出它系统性削掉队形两端 → 纵深被构造性压小），
// perMetricAllPoints 采信外推点（P38 认定这才是公平靶子：全点 25.4 ≈ Metrica 25.94）。
const CALIBERS = ['perMetric', 'perMetricAllPoints'];
const realBy = {};
for (const c of CALIBERS) {
  realBy[c] = {};
  for (const k of ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist']) realBy[c][k] = baseline.datasets[baseline.primaryDataset][c][k].avg;
}
const real = baseline.datasets[baseline.primaryDataset].perMetric;
const realShape = realBy.perMetric;

console.error('跑引擎（5 seed × 5400 s）…');
const engine = await engineShape();

console.error(`跑 spike（${DURATION} s @10 Hz）…`);
const spikeFrames = simFrames(DURATION);
const { shape: spike, windows } = shapeOf(spikeFrames);

const LAT = ['lat', 'mix', 'disp'];
const engineMotion = (() => {
  // 复用引擎帧（已在上面的循环里丢弃，这里重跑一个 seed 取运动量）
  return null;
})();

const rows = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist'];
console.log(`\n口径：match-metrics.js，300 s 窗，5 Hz 采样；真实锚 = skillcorner 基线（${real.hd.n} 窗）`);
console.log(`spike 窗口数：${windows}（${DURATION} s）`);
for (const c of CALIBERS) {
  const R = realBy[c];
  console.log(`\n── 口径 ${c} ──`);
  console.log('指标       真实     引擎     引擎比    spike    spike比');
  console.log('---------  ------   ------   ------   ------   ------');
  for (const k of rows) {
    const r = R[k]; const e = engine[k]; const s = spike[k];
    const ratio = (v) => (v == null || r == null ? '—' : (v / r).toFixed(2) + '×');
    console.log(
      `${k.padEnd(9)}  ${r.toFixed(1).padStart(6)}   ${(e ?? NaN).toFixed(1).padStart(6)}   ${ratio(e).padStart(6)}   ${(s ?? NaN).toFixed(1).padStart(6)}   ${ratio(s).padStart(6)}`,
    );
  }
  const meanAbsLn = (obj) => {
    const vals = rows.map((k) => (obj[k] && R[k] ? Math.abs(Math.log(obj[k] / R[k])) : null)).filter((v) => v != null);
    return mean(vals);
  };
  console.log(`\nmean|ln(引擎/真实)| = ${meanAbsLn(engine).toFixed(3)}`);
  console.log(`mean|ln(spike/真实)| = ${meanAbsLn(spike).toFixed(3)}`);
}

// 运动量（"铁轨"信号）
const es = windowStats(mm.sampleEngineFrames(createGame(simulateStream((await loadEngineWasm()).wasm, 42, mm.ENGINE_DURATION_SEC))), 12);
const ss = windowStats(spikeFrames, 12);
console.log('');
console.log('运动量（12 s 窗中位）      引擎    spike');
console.log('横向位移占比 lat             ' + median(es.lat).toFixed(2) + '     ' + median(ss.lat).toFixed(2));
console.log('混队度 mix                   ' + median(es.mix).toFixed(2) + '     ' + median(ss.mix).toFixed(2));
console.log('每窗端点位移 disp (m)        ' + median(es.disp).toFixed(1) + '    ' + median(ss.disp).toFixed(1));
