// Debug: print sample pass/shot events and game API surface (read-only).
import { loadEngineWasm, simulateStream } from '../../../tools/benchmark-engine.mjs';
const { createGame } = await import('../../../viewer/game.js');

const w = await loadEngineWasm(process.argv[2]);
const txt = simulateStream(w.wasm, 401, 5400);
const m = JSON.parse(txt);
const events = m.events || m;
console.log('top keys:', Object.keys(m));
console.log('event count:', events.length);
const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
console.log('types:', types);
const pass = events.find((e) => e.type === 'pass');
const shot = events.find((e) => e.type === 'shot');
console.log('pass sample:', JSON.stringify(pass));
console.log('shot sample:', JSON.stringify(shot));
const g = createGame(txt);
console.log('game keys:', Object.keys(g));
console.log('matchEnd:', g.matchEnd, 'players:', g.players.length);
g.seekTo(1000);
console.log('player sample:', JSON.stringify(g.players[5]));
console.log('ball sample:', JSON.stringify(g.ball));
