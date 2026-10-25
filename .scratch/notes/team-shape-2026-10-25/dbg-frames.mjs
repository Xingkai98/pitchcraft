// Debug: create game from wasm stream and seek frames with progress logs.
import { simulateStream, loadEngineWasm } from '../../../tools/benchmark-engine.mjs';
const { createGame } = await import('../../../viewer/game.js');

const wasmPath = process.argv[2];
const w = await loadEngineWasm(wasmPath);
const txt = simulateStream(w.wasm, 42, 5400);
console.error('sim bytes=' + txt.length);
const game = createGame(txt);
console.error('game ok matchEnd=' + game.matchEnd + ' players=' + game.players.length);
const end = game.matchEnd;
const steps = Math.round(end / 0.2);
for (let i = 0; i <= steps; i += 1) {
  const t = Math.round(i * 0.2 * 1e6) / 1e6;
  game.seekTo(t);
  if (i % 2000 === 0) console.error('frame ' + i + '/' + steps + ' t=' + t);
}
console.error('frames done ' + (steps + 1));
