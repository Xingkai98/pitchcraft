// Read-only probe: near-goal carrier decisions vs goal-side space.
// Usage: node probe-shot-zone.mjs <wasmPath> <seedStart> <seedCount>
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

const acc = {
  seeds: 0,
  passes: 0, shots: 0,
  boxPass: 0, boxShot: 0,
  cleanPass: 0, cleanShot: 0, cleanArcPass: 0, cleanArcShot: 0,
  cleanPassNearDef: [0, 0, 0, 0, 0],  // <=4, 4-6, 6-8, 8-12, >12
  cleanPassBehind: 0, cleanPassBehindNear: 0,
  cleanPassStall: 0, cleanPassForwardSum: 0, cleanPassLateral: 0, cleanPassBackward: 0,
  cleanPassN: 0,
  cleanShotDistSum: 0, cleanShotN: 0,
  cleanPassGoalDistSum: 0,
};
const push = (arr, idx) => { arr[idx] += 1; };

for (let si = 0; si < seedCount; si += 1) {
  const seed = seedStart + si;
  const txt = simulateStream(w.wasm, seed, 5400);
  const events = JSON.parse(txt);
  const g = createGame(txt);
  const lastActionT = new Map();
  for (const e of events) {
    if (!['pass', 'shot'].includes(e.type)) continue;
    const subject = e.subject;
    if (subject == null) continue;
    const home = subject <= 10;
    const cx = e.x, cy = e.y;
    const dirX = home ? 1 : -1;
    const goal = home ? [1, 0.5] : [0, 0.5];
    const gdx = (goal[0] - cx) * PL, gdy = (goal[1] - cy) * PW;
    const gdist = Math.hypot(gdx, gdy);
    if (gdist > ARC) continue; // only near-goal actions
    // snapshot positions just before the action
    g.seekTo(Math.max(0, e.t - 0.01));
    const players = g.players;
    let nearD = Infinity, nearBehind = false, goalSideClear = true;
    for (const p of players) {
      if (p.id === subject || GK.has(p.id)) continue;
      const opp = home ? p.id >= 11 : p.id <= 10;
      if (!opp) continue;
      const dx = (p.x - cx) * PL, dy = (p.y - cy) * PW;
      const d = Math.hypot(dx, dy);
      if (d < nearD) { nearD = d; nearBehind = (dx * gdx + dy * gdy) < 0; }
      const gl = Math.hypot(gdx, gdy) || 1;
      const cos = (dx * gdx + dy * gdy) / (d * gl || 1);
      if (d <= CLEAR_R && cos >= FRONT_COS) goalSideClear = false;
    }
    const isPass = e.type === 'pass';
    if (isPass) { acc.passes += 1; acc.boxPass += 1; } else { acc.shots += 1; acc.boxShot += 1; }
    if (gdist <= BOX) {
      if (isPass) { if (goalSideClear) acc.cleanPass += 1; } else { if (goalSideClear) acc.cleanShot += 1; }
    } else {
      if (isPass) { if (goalSideClear) acc.cleanArcPass += 1; } else { if (goalSideClear) acc.cleanArcShot += 1; }
    }
    if (!goalSideClear) continue;
    if (isPass) {
      acc.cleanPassN += 1;
      acc.cleanPassGoalDistSum += gdist;
      const bucket = nearD <= 4 ? 0 : nearD <= 6 ? 1 : nearD <= 8 ? 2 : nearD <= 12 ? 3 : 4;
      push(acc.cleanPassNearDef, bucket);
      if (nearBehind) acc.cleanPassBehind += 1;
      if (nearBehind && nearD <= 4.5) acc.cleanPassBehindNear += 1;
      const last = lastActionT.get(subject);
      if (last != null && e.t - last >= 4) acc.cleanPassStall += 1;
      const fwd = (e.x2 - e.x) * dirX * PL;
      acc.cleanPassForwardSum += fwd;
      const lat = Math.abs((e.y2 - e.y) * PL / 1.05 * 1.05); // keep simple: normalized y * PW
      const latM = Math.abs((e.y2 - e.y) * PW);
      if (latM >= 6 && Math.abs(fwd) <= 3) acc.cleanPassLateral += 1;
      if (fwd <= -3) acc.cleanPassBackward += 1;
    } else {
      acc.cleanShotN += 1;
      acc.cleanShotDistSum += gdist;
    }
    if (['pass', 'shot', 'tackle', 'foul', 'loose_ball', 'interception'].includes(e.type)) {
      lastActionT.set(subject, e.t);
    }
  }
  acc.seeds += 1;
}

const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
console.log(`wasm=${wasmPath}`);
console.log(`seeds=${seedStart}..${seedStart + seedCount - 1} matches=${acc.seeds}`);
console.log(`near-goal actions (<=25m): pass=${acc.passes} shot=${acc.shots}`);
console.log(`  box (<=16.5m): pass=${acc.boxPass} shot=${acc.boxShot}`);
console.log(`  box + goal-side-clear(8m,45deg): pass=${acc.cleanPass} shot=${acc.cleanShot}`);
console.log(`  arc 16.5-25 + goal-side-clear: pass=${acc.cleanArcPass} shot=${acc.cleanArcShot}`);
console.log(`clean box passes=${acc.cleanPassN}`);
console.log(`  nearest defender any direction: <=4m ${pct(acc.cleanPassNearDef[0], acc.cleanPassN)}, 4-6m ${pct(acc.cleanPassNearDef[1], acc.cleanPassN)}, 6-8m ${pct(acc.cleanPassNearDef[2], acc.cleanPassN)}, 8-12m ${pct(acc.cleanPassNearDef[3], acc.cleanPassN)}, >12m ${pct(acc.cleanPassNearDef[4], acc.cleanPassN)}`);
console.log(`  nearest defender BEHIND carrier: ${pct(acc.cleanPassBehind, acc.cleanPassN)}; behind & <=4.5m: ${pct(acc.cleanPassBehindNear, acc.cleanPassN)}`);
console.log(`  stalled >=4s before pass: ${pct(acc.cleanPassStall, acc.cleanPassN)}`);
console.log(`  pass direction: mean forward=${(acc.cleanPassForwardSum / Math.max(1, acc.cleanPassN)).toFixed(2)}m; lateral-only(|fwd|<=3 & |lat|>=6): ${pct(acc.cleanPassLateral, acc.cleanPassN)}; backward(<=-3m): ${pct(acc.cleanPassBackward, acc.cleanPassN)}`);
console.log(`  mean distance-to-goal at pass: ${(acc.cleanPassGoalDistSum / Math.max(1, acc.cleanPassN)).toFixed(1)}m`);
console.log(`clean box shots=${acc.cleanShotN}; mean distance-to-goal at shot=${(acc.cleanShotDistSum / Math.max(1, acc.cleanShotN)).toFixed(1)}m`);
