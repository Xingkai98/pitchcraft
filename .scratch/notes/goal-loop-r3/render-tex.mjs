// R3：按给定纹理幅度渲 trajectory 对比图（引擎 vs 真实），用于「先看」。
// 用法：node render-tex.mjs <amp> <out.png> [seed=42] [t0=1800] [win=90] [realFile=real-game-1.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const [ampArg, out, seedArg, t0Arg, winArg, realArg, modeArg, blockArg] = process.argv.slice(2);
const amp = Number(ampArg); const seed = Number(seedArg || 42);
const t0 = Number(t0Arg || 1800); const win = Number(winArg || 90);
const { buildTrajectoryComparison } = await import(join(ROOT, 'tools/visual-review/trajectory.mjs'));
const { canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
const g = createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
g._textureAmpM = amp;
if (modeArg) g._textureMode = modeArg;
if (blockArg) g._textureBlockSec = Number(blockArg);
if (process.argv[9]) g._crTension = Number(process.argv[9]);
const ef = mm.sampleEngineFrames(g);
const rg = JSON.parse(readFileSync(join(ROOT, 'viewer/data', realArg || 'real-game-1.json'), 'utf8'));
const rf = rg.frames.map((f) => ({ t: f.t, players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)).filter(Boolean) }));
const { canvas } = buildTrajectoryComparison(ef, rf, { t0, win });
writeFileSync(out, canvasToPng(canvas));
console.log(out);
