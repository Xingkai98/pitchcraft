// 端到端 v2：加载 engine.wasm → 产 v2 事件流 → viewer createGame → 步进无 snap
// verify.sh 第 3 步调用。无视觉依赖：纯断言。
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { parseEventStream } from './protocol.js';
import { Game } from './game.js';

// 关闭调试日志（e2e 只输出结果断言）
config.debug.enabled = false;
// 关闭跳过机制（跳过导致 playTime 跳变是设计行为；e2e 验证引擎→viewer 事件流连续性，不验证跳过）
config.playback.skipThresholdSeconds = Number.MAX_SAFE_INTEGER;

const wasmPath = new URL('./engine.wasm', import.meta.url).pathname;
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const SCRATCH = 1024;

function run(seed, duration) {
  const cfgBytes = encoder.encode(JSON.stringify({ match_duration_seconds: duration }));
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfgBytes.length).set(cfgBytes);
  wasm.simulate(BigInt(seed), SCRATCH, cfgBytes.length);
  const outPtr = wasm.get_json_ptr();
  const outLen = wasm.get_json_length();
  const events = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen)));
  wasm.free_json();
  return events;
}

const events = run(42, 2700);

// ---- v2 协议断言 ----
const types = new Set(events.map((e) => e.type));
for (const t of ['lineup', 'kickoff', 'beat', 'pass', 'shot', 'tackle', 'whistle']) {
  if (!types.has(t)) throw new Error(`缺事件类型: ${t}`);
}
if (types.has('dribble')) throw new Error('v2 不应有顶层 dribble 事件');
if (types.has('off_ball_run')) throw new Error('v2 不应有顶层 off_ball_run 事件');

const beats = events.filter((e) => e.type === 'beat');
if (beats.length < 2000) throw new Error(`beat 数量过少: ${beats.length}`);
const beatWithMain = beats.filter((e) => e.main);
if (beatWithMain.length === 0) throw new Error('beat 应带 main（carrier 带球）');
const beatWithMovers = beats.filter((e) => Array.isArray(e.movers));
if (beatWithMovers.length === 0) throw new Error('beat 应带 movers');
const beatWithLoose = beats.filter((e) => e.ball && e.ball.loose);
// 松散球可选（某些 seed 可能少），不强制非零
const firstBeat = beats[0];
if (firstBeat.t < 1 || firstBeat.t > 2) throw new Error(`beat 应从 tick 1 开始: ${firstBeat.t}`);

// 球所有权唯一：同一 beat 不同时含 main 和 ball
for (const b of beats) {
  if (b.main && b.ball) throw new Error('beat 不应同时含 main 和 ball');
}

// config 生效（60s 与 2700s 事件数不同）
const e60 = run(42, 60);
if (e60.length === events.length) throw new Error('config 未生效：60s 与 2700s 事件数相同');
const last60 = e60[e60.length - 1].t;
const last2700 = events[events.length - 1].t;
if (last60 > 61 || last2700 < 2699) throw new Error(`config 时长未生效: t=${last60}/${last2700}`);

// ---- viewer 端到端：连续播放无 snap（覆盖高亮边界 + 角球/界外球/门球重开）----
// 步进整场（覆盖 seed42 的角球 t≈1067/2492、界外球、门球重开）——P6 批次1 重开路径是 snap 高发区
const { events: parsed, lineup } = parseEventStream(events);
const game = new Game(parsed, lineup, 'continuous');
game.playing = true;
let prevBall = { ...game.ball };
let maxBallJump = 0;
let maxBallJumpT = 0;
const prevPlayers = new Map(game.players.map((p) => [p.id, { x: p.x, y: p.y }]));
let maxPlayerJump = 0;
// 预计算 spec 允许的球瞬移时刻（P6 / P6 批次1）：只豁免设计接受的重开瞬移
// 1) 进球确认（whistle，前一动作是 goal shot）→ 球直接回中圈
// 2) 角球发球前准备期（detail=corner pass 的 t-6..t）→ 球从射门终点/出界点瞬移到角旗
//    （CornerAward / 防方解围出底线重开；RestartPrep 球停固定点）
// 3) 门球开大脚（pass subject=门将、to=None）→ 球瞬移到门将
// 界外球无瞬移（出界落点=边线出界点，球停那连续到掷球），不需豁免。
const allowedTeleportTimes = new Set();
for (let i = 0; i < parsed.length; i++) {
  if (parsed[i].type === 'whistle' && i > 0) {
    let j = i - 1;
    while (j >= 0 && (parsed[j].type === 'beat' || parsed[j].type === 'off_ball_run')) j--;
    if (parsed[j] && parsed[j].type === 'shot' && parsed[j].result === 'goal') {
      allowedTeleportTimes.add(parsed[i].t);
    }
  } else if (parsed[i].type === 'pass' && parsed[i].detail === 'corner') {
    // 角球发球：准备期球从射门终点/出界点瞬移到角旗（CornerAward/解围出底线重开）。
    // 准备期 = 发球者走位 tick（最长 ~7s），豁免 t-7..t 覆盖球到角旗的瞬移时刻
    for (let k = 0; k <= 7; k++) allowedTeleportTimes.add(parsed[i].t - k);
  } else if (parsed[i].type === 'pass' && parsed[i].to === undefined
      && (parsed[i].subject === 0 || parsed[i].subject === 21)) {
    // 门球开大脚：球瞬移到门将（subject=门将、无 to）
    allowedTeleportTimes.add(parsed[i].t);
  }
}
const isAllowedTeleport = (t) => {
  for (const at of allowedTeleportTimes) {
    if (Math.abs(at - t) < 0.1) return true;
  }
  return false;
};
let frames = 0;
const maxFrames = Math.ceil(game.matchEnd * 60) + 60; // 覆盖整场 + 尾部余量
while (game.playing && frames < maxFrames) {
  game.step(1 / 60);
  frames++;
  const bj = Math.hypot(game.ball.x - prevBall.x, game.ball.y - prevBall.y);
  if (!isAllowedTeleport(game.playTime) && bj > maxBallJump) {
    maxBallJump = bj;
    maxBallJumpT = game.playTime;
  }
  prevBall = { ...game.ball };
  for (const p of game.players) {
    const prev = prevPlayers.get(p.id);
    const pj = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (pj > maxPlayerJump) maxPlayerJump = pj;
    prev.x = p.x;
    prev.y = p.y;
  }
}
if (maxBallJump > 0.05) throw new Error(`球事件边界跳变过大 maxBallJump=${maxBallJump} at t=${maxBallJumpT.toFixed(1)}`);
if (maxPlayerJump > 0.05) throw new Error(`球员事件边界跳变过大 maxPlayerJump=${maxPlayerJump}`);

const stats = {
  beat: beats.length,
  main: beatWithMain.length,
  movers: beatWithMovers.length,
  loose: beatWithLoose.length,
  pass: events.filter((e) => e.type === 'pass').length,
  shot: events.filter((e) => e.type === 'shot').length,
  tackle: events.filter((e) => e.type === 'tackle').length,
  goal: events.filter((e) => e.type === 'shot' && e.result === 'goal').length,
};
console.log(`E2E v2 OK：${events.length} 事件 | ${JSON.stringify(stats)} | 无顶层 dribble | config 生效 | 无 snap(球 ${maxBallJump.toFixed(4)}, 球员 ${maxPlayerJump.toFixed(4)})`);
