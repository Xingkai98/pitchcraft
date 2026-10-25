// 主客事件不对称探针（只读）：模拟 N seed，统计每队事件量。
// 用法：node ha-probe.mjs <wasmPath> <seedStart> <seedCount> [durationSec]
import { loadEngineWasm, simulateStream } from '../../../tools/benchmark-engine.mjs';

const wasmPath = process.argv[2];
const seedStart = Number(process.argv[3] ?? 401);
const seedCount = Number(process.argv[4] ?? 100);
const duration = Number(process.argv[5] ?? 5400);

const w = await loadEngineWasm(wasmPath);
if (!w.ok) { console.log(w.message); process.exit(1); }

const teamOf = (id) => (id == null || id < 0 ? null : (id <= 10 ? 'home' : 'away'));
const acc = {
  home: { shot: 0, goal: 0, tackle: 0, foul: 0, pass: 0, dribble: 0, interception: 0, off_ball_run: 0, corner: 0, throw_in: 0, goal_kick: 0, free_kick: 0 },
  away: { shot: 0, goal: 0, tackle: 0, foul: 0, pass: 0, dribble: 0, interception: 0, off_ball_run: 0, corner: 0, throw_in: 0, goal_kick: 0, free_kick: 0 },
};
const add = (team, key) => { if (team && acc[team][key] !== undefined) acc[team][key] += 1; };

for (let s = 0; s < seedCount; s += 1) {
  const seed = seedStart + s;
  const m = JSON.parse(simulateStream(w.wasm, seed, duration));
  const events = m.events || m;
  for (const e of events) {
    const type = e.type;
    if (type === 'shot') {
      add(teamOf(e.subject), 'shot');
      if (e.result === 'goal') add(teamOf(e.subject), 'goal');
    } else if (type === 'tackle') {
      // subject = 抢断者（防守方）
      add(teamOf(e.subject), 'tackle');
    } else if (type === 'foul') {
      add(teamOf(e.subject), 'foul');
    } else if (type === 'pass') {
      add(teamOf(e.subject), 'pass');
      if (e.detail === 'corner') add(teamOf(e.subject), 'corner');
      if (e.detail === 'throw_in') add(teamOf(e.subject), 'throw_in');
      if (e.detail === 'goal_kick') add(teamOf(e.subject), 'goal_kick');
      if (e.detail === 'free_kick') add(teamOf(e.subject), 'free_kick');
    } else if (type === 'dribble') {
      add(teamOf(e.subject), 'dribble');
    } else if (type === 'interception') {
      add(teamOf(e.subject), 'interception');
    } else if (type === 'off_ball_run') {
      add(teamOf(e.subject), 'off_ball_run');
    }
  }
}

const r = (h, a) => (a > 0 ? (h / a).toFixed(3) : 'n/a');
const fmt = (k) => `${k}: home ${acc.home[k]} away ${acc.away[k]} (H/A ${r(acc.home[k], acc.away[k])}, per-game ${(acc.home[k] / seedCount).toFixed(2)}/${(acc.away[k] / seedCount).toFixed(2)})`;
console.log(`wasm=${wasmPath} seeds=${seedStart}..${seedStart + seedCount - 1} dur=${duration}`);
for (const k of ['shot', 'goal', 'tackle', 'foul', 'pass', 'dribble', 'interception', 'off_ball_run', 'corner', 'throw_in', 'goal_kick', 'free_kick']) {
  console.log(fmt(k));
}
