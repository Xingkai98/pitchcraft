// [探针·用完即删] 复刻 e2e-v2 的 checkNoSnap，报到 (id, t, 值) 级
import { readFileSync } from 'node:fs';
const { config } = await import('./config.js');
const { parseEventStream } = await import('./protocol.js');
const { Game } = await import('./game.js');
const bytes = readFileSync(new URL('./engine.wasm', import.meta.url).pathname);
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
const seed = Number(process.argv[2] || 1);
const cb = enc.encode(JSON.stringify({ match_duration_seconds: 5400 }));
new Uint8Array(wasm.memory.buffer, 1024, cb.length).set(cb);
wasm.simulate(BigInt(seed), 1024, cb.length);
const events = JSON.parse(dec.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length())));

config.debug.enabled = false;
const { events: parsed, lineup } = parseEventStream(events);
const game = new Game(events, lineup, 'continuous', { skipThreshold: Infinity });
game.playing = true;
const allowed = new Set();
for (let i = 0; i < parsed.length; i++) {
  const e = parsed[i];
  if (e.type === 'whistle' || e.type === 'foul') allowed.add(e.t);
  else if (e.type === 'pass' && e.detail === 'corner') { let j = i - 1; while (j >= 0 && parsed[j].type === 'beat') j--; const st = j >= 0 ? parsed[j].t : e.t - 20; for (let k = 0; e.t - k >= st; k++) allowed.add(e.t - k); }
  else if (e.type === 'pass' && e.to === undefined && (e.subject === 0 || e.subject === 21)) allowed.add(e.t);
}
const ok = t => { for (const a of allowed) if (Math.abs(a - t) < 0.1) return true; return false; };
let prev = new Map(game.players.map(p => [p.id, { x: p.x, y: p.y }]));
let worst = { v: 0 };
const n = Math.ceil(game.matchEnd * 60) + 60;
for (let f = 0; f < n && game.playing; f++) {
  game.step(1 / 60);
  for (const p of game.players) {
    const q = prev.get(p.id);
    const j = Math.hypot(p.x - q.x, p.y - q.y);
    if (!ok(game.playTime) && p.id !== 0 && p.id !== 21 && j > worst.v) worst = { v: j, t: game.playTime, id: p.id, from: { ...q }, to: { x: p.x, y: p.y } };
    q.x = p.x; q.y = p.y;
  }
}
const evt = parsed.filter(e => Math.abs(e.t - worst.t) < 0.6 && e.type !== 'beat');
console.log(`seed ${seed}: maxPlayerJump=${worst.v.toFixed(6)} id=${worst.id} t=${worst.t.toFixed(2)}`);
console.log(`  from (${worst.from.x.toFixed(4)},${worst.from.y.toFixed(4)}) → to (${worst.to.x.toFixed(4)},${worst.to.y.toFixed(4)})  Δ=(${((worst.to.x-worst.from.x)*105).toFixed(2)}m, ${((worst.to.y-worst.from.y)*68).toFixed(2)}m)`);
console.log(`  豁免集内 850-856s: ${[...allowed].filter(a=>a>850&&a<856).join(',')}`);
for (const e of evt) console.log(`  邻域事件: t=${e.t} ${e.type} ${e.detail || e.result || ''} subj=${e.subject}`);
