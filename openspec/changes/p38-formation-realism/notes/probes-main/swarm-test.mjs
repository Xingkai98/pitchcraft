// 判定「整队像一群鱼一样同步移动」（swarm）还是「各司其职」
//
// 动机：exp5 把横向 sd 从 0.53 提到 5.30m（数字接近真实 10.04），但轨迹图看起来是
// 整队横移的长直线，不像足球。本脚本量化：
//   1. 球员 y 的**两两相关**（swarm 指标：大家一起动 → 相关高）
//   2. 轨迹**直线度** = 净位移 / 路径长度（1=直线，越小越曲折）
//   3. 球员间距（是否挤成一团）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, KEEPER_IDS } from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
};

function analyze(frames, label) {
  const seg = frames.filter((f) => f.t >= 1800 && f.t <= 1920);
  const ids = [];
  for (let i = 1; i <= 10; i += 1) ids.push(i);
  // 每人的 y 序列
  const ys = {};
  for (const id of ids) ys[id] = seg.map((f) => { const p = f.players.find((x) => x.id === id); return p ? p.y : null; }).filter((v) => v !== null);
  // 两两相关
  const cors = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) cors.push(corr(ys[ids[i]], ys[ids[j]]));
  }
  // 轨迹直线度 + 平均球员间距
  const straight = [];
  let gapSum = 0; let gapN = 0;
  for (const id of ids) {
    const pts = seg.map((f) => f.players.find((x) => x.id === id)).filter(Boolean).map((p) => [p.x * 105, p.y * 68]);
    if (pts.length < 10) continue;
    let path = 0;
    for (let i = 1; i < pts.length; i += 1) path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const net = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
    if (path > 1) straight.push(net / path);
  }
  for (const f of seg) {
    const ps = f.players.filter((p) => p && !KEEPER_IDS.includes(p.id));
    for (let i = 0; i < ps.length; i += 1) {
      for (let j = i + 1; j < ps.length; j += 1) {
        gapSum += Math.hypot((ps[i].x - ps[j].x) * 105, (ps[i].y - ps[j].y) * 68); gapN += 1;
      }
    }
  }
  console.log(`${label.padEnd(12)} y两两相关 ${mean(cors).toFixed(3)} (max ${Math.max(...cors).toFixed(2)})  轨迹直线度 ${mean(straight).toFixed(3)}  平均球员间距 ${(gapSum / gapN).toFixed(1)}m`);
}

// 真实
const rg = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-1.json`, 'utf8'));
const rframes = rg.frames.map((f) => ({ t: f.t, ball: f.ball, players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
analyze(rframes, '真实 Metrica');

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
for (const seed of [42, 1]) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  analyze(sampleEngineFrames(game), `引擎 s${seed}`);
}
console.log('\n判读：y两两相关高 = 整队同步横移（swarm）；真实足球应各司其职（相关低-中）');
console.log('      轨迹直线度接近 1 = 走直线（不像真人的迂回）；真实应明显小于 1');
