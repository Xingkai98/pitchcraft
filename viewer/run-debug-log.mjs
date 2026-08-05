// 运行 demo 并收集 debug 日志（解耦模式：逐事件点播，每个动作独立播放）
import { readFileSync } from 'fs';
const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
const cfg = enc.encode(JSON.stringify({ match_duration_seconds: 200, demo_mode: true }));
new Uint8Array(wasm.memory.buffer, 1024, cfg.length).set(cfg);
wasm.simulate(42n, 1024, cfg.length);
const stream = dec.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length()));

const { createGame } = await import('./game.js');
const game = createGame(stream);
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(' '));

// 解耦模式：对每个事件，跳到它 → 播放到片段结束 → 下一个
game.speedIndex = 0; // 1x
for (let i = 0; i < game.eventCount; i++) {
  game.jumpToEvent(i);
  game.playing = true;
  // 播放该事件片段（步进 1/30s），直到自动停（playing 变 false）或安全上限
  for (let s = 0; s < 600 && game.playing; s++) {
    game.step(1/30);
  }
}

console.log = origLog;
// 打印全部日志（模拟控制台输出）
logs.forEach(l => console.log(l));
console.log(`\n=== 日志共 ${logs.length} 行，事件数 ${game.eventCount} ===`);
