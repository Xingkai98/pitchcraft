// 视觉审阅：**球的行程与静止占比**——2026-10-28 盲测里裁判的头号线索（球路长 vs 球路短）。
//
// ── 为什么有它 ────────────────────────────────────────────────────────────
// 2026-10-28 双盲包（replay-goal-loop/base）的裁判 B 以 **24/24 = 100%** 分出引擎/真实，
// 其首要依据是「球路长度」：真实每 24s 球行程 ~163m、快段（传球）~101m、球静止时间 1.5%；
// 本分支引擎球行程 ~71m、快段 ~41m、**球静止时间 25.7%**。而 `like-football` / `panel` 的表
// 里都没有「球自己走了多远 / 停了多久」——它们量队形与球员位移，所以此前「距离 0.149 全绿」
// 测不到这个最大缺口（与 SKILL.md「缺陷 B：最大缺口不在视野里」同型）。
//
// ── 口径 ─────────────────────────────────────────────────────────────────
//   - 球总行程：相邻**原始球帧**（`ball` 非空）的米制位移和；原始球帧缺口的跨段不计（不插值补）；
//   - 快段：瞬时速度 >= `FAST_MS`（默认 8 m/s，传球/射门尺度）的那部分行程；慢段 = 其余；
//   - 球静止时间占比：球在场（有原始球帧）的相邻区间里，速度 < `STATIC_MS`（默认 0.5 m/s）的时长占比；
//   - 逐场/逐窗算，**跨场只对窗级标量取均值**（不拼接，P38 教训）；两侧同一段代码。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node tools/visual-review/ball-travel.mjs <engine.wasm> [seeds=5] [win=12]
//   （真实侧 = viewer/data/real-game-*.json，12s 窗逐场滑动；缺文件时真实行报 n/a 并退出码 0）
// 报告项：**不进 ratchet、不产生 pass/fail**——它的用途是把「球停着」拉进视野。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAST_MS = 8;
export const STATIC_MS = 0.5;

// 纯函数：一段帧（`{t, ball:[x,y]|null, pitchMeters}`）→ 球行程/静止统计。
// 球帧缺失处断开（prev 重置），不跨缺口累计——避免把「球看不见」当成球在飞。
export function ballTravel(frames, { fastMs = FAST_MS, staticMs = STATIC_MS } = {}) {
  let path = 0; let fast = 0; let slow = 0; let span = 0; let still = 0; let steps = 0;
  let prev = null;
  for (const f of frames) {
    const pm = f.pitchMeters;
    const pitch = pm ? (Array.isArray(pm) ? pm : [pm.length, pm.width]) : [105, 68];
    const ball = f && f.ball;
    if (!ball || !Number.isFinite(ball[0]) || !Number.isFinite(ball[1])) { prev = null; continue; }
    if (prev) {
      const dt = f.t - prev.t;
      if (dt > 1e-9) {
        const d = Math.hypot((ball[0] - prev.x) * pitch[0], (ball[1] - prev.y) * pitch[1]);
        const v = d / dt;
        path += d; span += dt; steps += 1;
        if (v >= fastMs) fast += d; else slow += d;
        if (v < staticMs) still += dt;
      }
    }
    prev = { x: ball[0], y: ball[1], t: f.t };
  }
  return {
    path, fast, slow, steps, span,
    staticShare: span > 0 ? still / span : null,
    meanSpeed: span > 0 ? path / span : null,
  };
}

// 窗化：逐窗算再对窗级标量取均值（跨场不拼接）。
export function travelWindows(frames, { win = 12, step = null } = {}) {
  const st = step ?? win;
  if (!frames.length) return [];
  const t0 = frames[0].t; const tEnd = frames[frames.length - 1].t;
  const out = [];
  for (let t = t0; t + win <= tEnd + 1e-9; t += st) {
    const seg = frames.filter((f) => f.t >= t && f.t <= t + win + 1e-9);
    if (seg.length >= 3) out.push({ t0: t, ...ballTravel(seg) });
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));

function realGameFrames() {
  const dir = join(ROOT, 'viewer/data');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^real-game-\d+\.json$/.test(n)).sort().map((n) => {
    const g = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    const pm = g.meta && g.meta.pitchMeters;
    const pitch = pm ? (Array.isArray(pm) ? pm : [pm.length, pm.width]) : [105, 68];
    return g.frames.map((f) => ({ t: f.t, pitchMeters: pitch, ball: f.ball || null }));
  });
}

async function main() {
  const [wasmPath, seedsArg, winArg] = process.argv.slice(2);
  if (!wasmPath) { console.error('用法: node ball-travel.mjs <engine.wasm> [seeds=5] [win=12]'); process.exit(2); }
  const seeds = Number(seedsArg || 5); const win = Number(winArg || 12);
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { createGame } = await import(join(ROOT, 'viewer/game.js'));
  const { wasm, ok } = await loadEngineWasm(wasmPath);
  if (!ok) { console.error('加载 wasm 失败'); process.exit(2); }

  // 引擎：BNECHMARK_SEEDS 前 N 个（与 like-football 同 seed 集口径）。
  const engWins = [];
  for (let s = 0; s < seeds; s += 1) {
    const seed = mm.BENCHMARK_SEEDS[s % mm.BENCHMARK_SEEDS.length];
    const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)))
      .map((f) => ({ t: f.t, pitchMeters: [105, 68], ball: f.ball }));
    engWins.push(...travelWindows(frames, { win }));
  }
  // 真实：Metrica 2 场（运动锚口径，gitignore；缺则 n/a）。
  const realWins = [];
  const games = realGameFrames();
  for (const frames of games) realWins.push(...travelWindows(frames, { win }));

  const agg = (wins) => ({
    n: wins.length,
    path: mean(wins.map((w) => w.path)),
    fast: mean(wins.map((w) => w.fast)),
    slow: mean(wins.map((w) => w.slow)),
    staticShare: mean(wins.map((w) => w.staticShare).filter((v) => v != null)),
    meanSpeed: mean(wins.map((w) => w.meanSpeed).filter((v) => v != null)),
  });
  const e = agg(engWins); const r = agg(realWins);
  console.log(`═══ 球的行程 / 静止（${win}s 窗，逐窗算再均值）═══`);
  console.log(`引擎 wasm=${wasmPath}  seeds=${seeds}  窗数 ${e.n}`);
  console.log(`真实 Metrica ${games.length} 场  窗数 ${r.n}${games.length < 2 ? '  ⚠ 缺真实帧：运动锚覆盖不足' : ''}`);
  const row = (label, ev, rv, d = 1, suffix = '') => {
    const ratio = rv && ev != null ? (ev / rv).toFixed(2) + '×' : '—';
    console.log(`  ${label.padEnd(14)} 引擎 ${fmt(ev, d).padStart(8)}${suffix}  真实 ${fmt(rv, d).padStart(8)}${suffix}  E/R ${ratio}`);
  };
  row('球总行程(m)', e.path, r.path);
  row('快段(>=8m/s)', e.fast, r.fast);
  row('慢段', e.slow, r.slow);
  row('平均球速(m/s)', e.meanSpeed, r.meanSpeed, 2);
  row('球静止占比(%)', e.staticShare == null ? null : e.staticShare * 100, r.staticShare == null ? null : r.staticShare * 100, 1, '%');
  console.log('（报告项：不进 ratchet、不判 pass/fail。口径见文件头；原始球帧缺失处断开，不插值。）');
}

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (IS_ENTRY) await main();
