// Read-only probe v2: near-goal carrier decisions vs goal-side space (fixed box counting).
// Usage: node probe-shot-zone2.mjs <wasmPath> <seedStart> <seedCount>
import { loadEngineWasm, simulateStream } from '../../../tools/benchmark-engine.mjs';
const { createGame } = await import('../../../viewer/game.js');

const wasmPath = process.argv[2];
const seedStart = Number(process.argv[3] ?? 401);
const seedCount = Number(process.argv[4] ?? 20);
const w = await loadEngineWasm(wasmPath);
if (!w.ok) { console.log(w.message); process.exit(1); }

const PL = 105, PW = 68;
const GK = new Set([0, 21]);
const BOX = 16.5, ARC = 25, CLEAR_R = 8, FRONT_COS = Math.cos(Math.PI / 4);
const ACTION_TYPES = new Set(['pass', 'shot', 'tackle', 'foul', 'interception', 'loose_ball', 'whistle', 'kickoff', 'corner', 'throw_in', 'goal_kick', 'free_kick', 'offside']);

const A = {};
const resetA = () => ({
  boxPass: 0, boxShot: 0,
  cleanBoxPass: 0, cleanBoxShot: 0,
  cleanArcPass: 0, cleanArcShot: 0,
  passNearDef: [0, 0, 0, 0, 0],
  shotNearDef: [0, 0, 0, 0, 0],
  passBehind: 0, passBehindNear: 0,
  passGap4: 0, shotGap4: 0,
  openPass: 0, openShot: 0,          // clean & nearest>4m & gap<4s (truly open, not stalled)
  dispPassOpen: 0, dispShotOpen: 0,  // clean & nearest>4m (any gap)
  passFwdSum: 0, passLateral: 0, passBackward: 0, passN: 0,
  passGoalDistSum: 0, shotGoalDistSum: 0, shotN: 0,
});
Object.assign(A, resetA());

for (let si = 0; si < seedCount; si += 1) {
  const seed = seedStart + si;
  const txt = simulateStream(w.wasm, seed, 5400);
  const events = JSON.parse(txt);
  const g = createGame(txt);
  let prevActionT = -Infinity;
  for (const e of events) {
    const isAct = ACTION_TYPES.has(e.type) && typeof e.t === 'number';
    if (!isAct) continue;
    if (!['pass', 'shot'].includes(e.type) || e.subject == null) { prevActionT = e.t; continue; }
    const subject = e.subject;
    if (e.type === 'pass' && e.detail && ['corner', 'throw_in', 'goal_kick', 'free_kick'].includes(e.detail)) { prevActionT = e.t; continue; }
    const home = subject <= 10;
    const cx = e.x, cy = e.y;
    const dirX = home ? 1 : -1;
    const goal = home ? [1, 0.5] : [0, 0.5];
    const gdx = (goal[0] - cx) * PL, gdy = (goal[1] - cy) * PW;
    const gdist = Math.hypot(gdx, gdy);
    if (gdist > ARC) { prevActionT = e.t; continue; }
    const gap = e.t - prevActionT;
    g.seekTo(Math.max(0, e.t - 0.01));
    const players = g.players;
    let nearD = Infinity, nearBehind = false, goalSideClear = true;
    const gl = Math.hypot(gdx, gdy) || 1;
    for (const p of players) {
      if (p.id === subject || GK.has(p.id)) continue;
      const opp = home ? p.id >= 11 : p.id <= 10;
      if (!opp) continue;
      const dx = (p.x - cx) * PL, dy = (p.y - cy) * PW;
      const d = Math.hypot(dx, dy);
      if (d < nearD) { nearD = d; nearBehind = (dx * gdx + dy * gdy) < 0; }
      const cos = (dx * gdx + dy * gdy) / (d * gl || 1);
      if (d <= CLEAR_R && cos >= FRONT_COS) goalSideClear = false;
    }
    const isPass = e.type === 'pass';
    if (gdist <= BOX) { if (isPass) A.boxPass += 1; else A.boxShot += 1; }
    const bucket = nearD <= 4 ? 0 : nearD <= 6 ? 1 : nearD <= 8 ? 2 : nearD <= 12 ? 3 : 4;
    if (isPass) {
      if (gdist <= BOX) {
        if (goalSideClear) {
          A.cleanBoxPass += 1; A.passN += 1;
          A.passGoalDistSum += gdist;
          A.passNearDef[bucket] += 1;
          if (nearBehind) A.passBehind += 1;
          if (nearBehind && nearD <= 4.5) A.passBehindNear += 1;
          if (gap >= 4) A.passGap4 += 1;
          if (nearD > 4) { A.dispPassOpen += 1; if (gap < 4) A.openPass += 1; }
          const fwdM = (e.x2 - e.x) * dirX * PL;
          const latM = Math.abs((e.y2 - e.y) * PW);
          A.passFwdSum += fwdM;
          if (latM >= 6 && Math.abs(fwdM) <= 3) A.passLateral += 1;
          if (fwdM <= -3) A.passBackward += 1;
        }
      } else if (goalSideClear) A.cleanArcPass += 1;
    } else {
      A.shotN += 1; A.shotGoalDistSum += gdist; A.shotNearDef[bucket] += 1;
      if (gdist <= BOX) { if (goalSideClear) { A.cleanBoxShot += 1; if (gap >= 4) A.shotGap4 += 1; } }
      else if (goalSideClear) A.cleanArcShot += 1;
      if (goalSideClear && nearD > 4) { A.dispShotOpen += 1; if (gap < 4) A.openShot += 1; }
    }
    prevActionT = e.t;
  }
}

const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const arr = (a, n) => `<=4m ${pct(a[0], n)} | 4-6m ${pct(a[1], n)} | 6-8m ${pct(a[2], n)} | 8-12m ${pct(a[3], n)}, >12m ${pct(a[4], n)}`;
console.log(`wasm=${wasmPath}`);
console.log(`seeds=${seedStart}..${seedStart + seedCount - 1} matches=${seedCount}`);
console.log(`box actions: pass=${A.boxPass} shot=${A.boxShot}`);
console.log(`box & goal-side-clear: pass=${A.cleanBoxPass} shot=${A.cleanBoxShot}  => pass share=${pct(A.cleanBoxPass, A.cleanBoxPass + A.cleanBoxShot)}`);
console.log(`arc & goal-side-clear: pass=${A.cleanArcPass} shot=${A.cleanArcShot}`);
console.log(`clean-box passes nearest defender (any dir): ${arr(A.passNearDef, A.passN)}`);
console.log(`clean-box shots  nearest defender (any dir): ${arr(A.shotNearDef, A.shotN)}`);
console.log(`clean-box passes: nearest defender BEHIND carrier ${pct(A.passBehind, A.passN)}; behind & <=4.5m ${pct(A.passBehindNear, A.passN)}; gap>=4s ${pct(A.passGap4, A.passN)}`);
console.log(`clean-box & nearest>4m: pass=${A.dispPassOpen} shot=${A.dispShotOpen}; of those gap<4s: pass=${A.openPass} shot=${A.openShot}`);
console.log(`clean-box pass dirs: mean forward=${(A.passFwdSum / Math.max(1, A.passN)).toFixed(2)}m; lateral(|fwd|<=3,|lat|>=6) ${pct(A.passLateral, A.passN)}; backward(<=-3m) ${pct(A.passBackward, A.passN)}`);
console.log(`mean goal-dist: pass ${(A.passGoalDistSum / Math.max(1, A.passN)).toFixed(1)}m shot ${(A.shotGoalDistSum / Math.max(1, A.shotN)).toFixed(1)}m`);
