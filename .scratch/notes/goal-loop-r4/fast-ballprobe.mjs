// R4 快速探针：直接从**事件流**算球程与事件混合（不跑 viewer；用于候选快速筛选）。
// 口径：球程 = 相邻 ball 锚点（ball 事件位置 / beat.ball 起止）的米制位移和，按 5400s 折 24s；
// 事件混合 = pass/dribble(beat.main)/shot/tackle/foul 计数；传球成功率 = success/(pass)。
// 与 viewer 口径交叉校验过一次（C3 后 seed42 86.7 m/24s，误差来自 tick 边界锚点合并）。
import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));

export function analyzeEvents(wasm, seed, duration = 5400) {
  const { events } = parseEventStream(simulateStream(wasm, seed, duration));
  // 球锚点序列：pass 事件的 (x,y)->(x2,y2)；beat 的 ball 起止；其余事件用 x,y（在球位）
  const pts = [];
  let passes = 0; let passSuccess = 0; let dribbles = 0; let shots = 0; let tackles = 0; let fouls = 0; let looseTicks = 0;
  for (const e of events) {
    if (e.type === 'pass') {
      passes += 1;
      if (e.result === 'success') passSuccess += 1;
      if (e.x !== undefined) pts.push([e.t, e.x, e.y]);
      if (e.x2 !== undefined) pts.push([e.t + 1e-6, e.x2, e.y2]);
    } else if (e.type === 'beat') {
      if (e.main && e.main.type === 'dribble') dribbles += 1;
      if (e.ball) {
        if (e.ball.loose) looseTicks += 1;
        pts.push([e.t, e.ball.x, e.ball.y]);
        pts.push([e.t + 1e-6, e.ball.x2, e.ball.y2]);
      }
    } else if (e.type === 'shot') {
      shots += 1;
    } else if (e.type === 'tackle') {
      tackles += 1;
    } else if (e.type === 'foul') {
      fouls += 1;
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  let path = 0;
  for (let i = 1; i < pts.length; i += 1) {
    path += Math.hypot((pts[i][1] - pts[i - 1][1]) * 105, (pts[i][2] - pts[i - 1][2]) * 68);
  }
  return {
    ballPathPer24: (path / duration) * 24,
    per24: {
      pass: (passes / duration) * 24,
      dribble: (dribbles / duration) * 24,
      shot: (shots / duration) * 24,
      tackle: (tackles / duration) * 24,
      foul: (fouls / duration) * 24,
      loose: (looseTicks / duration) * 24,
    },
    per90: { pass: passes / (duration / 5400), shot: shots / (duration / 5400), tackle: tackles / (duration / 5400), foul: fouls / (duration / 5400) },
    passSuccessRate: passes ? passSuccess / passes : null,
  };
}

const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('fast-ballprobe.mjs');
if (IS_ENTRY) {
  const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  const seeds = (process.argv[2] || '42').split(',').map(Number);
  for (const seed of seeds) {
    const r = analyzeEvents(wasm, seed);
    console.log(`seed ${seed}: ballPath/24s=${r.ballPathPer24.toFixed(1)}  per24=${JSON.stringify(r.per24)}  per90=${JSON.stringify(r.per90)}  passSucc=${r.passSuccessRate.toFixed(4)}`);
  }
}
