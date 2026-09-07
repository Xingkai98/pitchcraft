// 视觉抽查管线：把 engine.wasm 的真实事件流 → game.js 状态 → 渲染成 PNG 帧
// 供多模态子代理（image-reader）做空间观感审计。复用 renderer.js 的绘制函数（drawPitch/
// drawPlayer/drawBall/drawCard + renderFrame 逻辑），但光栅到 SoftCanvas（无浏览器依赖）。
//
// 用法：
//   node visual-probe.js <seed> <outdir> [--frames-per-event 4] [--win-t0s t1,t2,...]
// 对给定 seed：跑完整事件流 → 遍历事件 → 对每类目标事件（shot/tackle/pass-intercepted/
// pass-lost/foul/free_kick/header/battle）在事件前中后各取数帧渲染 → 写 PNG。
// 不做像素级视觉判断（那交给 image-reader 子代理）；本脚本只负责"产出真实、几何正确、覆盖
// 目标机制的帧"。
//
// 注意：仅开发期抽查用，不参与 verify.sh；保持无第三方依赖。

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { parseEventStream } from './protocol.js';
import { Game } from './game.js';
import { renderFrame } from './renderer.js';
import { SoftCanvas, canvasToPng } from './soft-canvas.js';

// 渲染参数（与 viewer 对齐）
const W = config.canvas.width;
const H = config.canvas.height;
const DT = 1 / 30; // 抽查步长（秒）

// 目标事件类型/结果 —— 视觉抽查关心的机制
const WATCH = new Set(['shot', 'tackle', 'foul', 'pass', 'header']);

async function run(seed, duration) {
  const wasmPath = new URL('./engine.wasm', import.meta.url).pathname;
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
  const cfg = enc.encode(JSON.stringify({ match_duration_seconds: duration }));
  const SCRATCH = 1024;
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfg.length).set(cfg);
  wasm.simulate(BigInt(seed), SCRATCH, cfg.length);
  const out = dec.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length()));
  wasm.free_json();
  const { events, lineup } = parseEventStream(out);
  return { events, lineup };
}

function findTargetIndices(events) {
  const idx = [];
  events.forEach((e, i) => {
    const isFoul = e.type === 'foul';
    const isIntercept = e.type === 'pass' && e.result === 'intercepted';
    const isLost = e.type === 'pass' && e.result === 'lost';
    const isFreeKick = e.type === 'pass' && e.detail === 'free_kick';
    const isShot = e.type === 'shot';
    const isTackle = e.type === 'tackle';
    const isCorner = e.type === 'pass' && e.detail === 'corner';
    if (isFoul || isIntercept || isLost || isFreeKick || isShot || isTackle || isCorner) {
      idx.push({ i, kind: e.type === 'foul' ? 'foul' : e.type === 'shot' ? 'shot' : e.type === 'tackle' ? 'tackle' : e.type === 'pass' ? e.detail || e.result : 'other' });
    }
  });
  return idx;
}

// 渲染一帧并返回 SoftCanvas（供 --single 单帧模式）
function renderOne(game, tCenter) {
  const canvas = new SoftCanvas(W, H);
  const t = Math.max(0, Math.min(tCenter, game.matchEnd));
  game.seekTo(t); // seekTo 内部调 _updateFromTimeline()，把 playTime 插值出的球员/球位置写入 players/ball
  renderFrame(canvas.ctx, { players: game.players, ball: game.ball }, W, H, {
    playTime: t,
    movingIds: new Set(game.currentHighlightParticipants?.() || []),
    dt: DT,
    cards: game.activeCards?.(),
  });
  return canvas;
}

// 各类事件的运动条窗口（贴合单个高亮事件，避免跨事件边界导致"球员静止+球乱跳"）。
// 拦截/传失/射门/抢断：球飞行 ~0.5-0.9s → 收窄到事件开始后 [0, +0.9]。
// 角球/任意球：发球后落点争夺 → [0, +1.0]。犯规：犯规 tick 无 beat，画面保持到重开 → 看犯规瞬间贴防，[-0.2, +0.4]。
const KIND_WINDOW = {
  intercepted: [0, 0.9], lost: [0, 0.9], shot: [0, 0.9], tackle: [0, 0.8],
  corner: [0, 1.0], free_kick: [0, 1.0], foul: [-0.2, 0.4],
  default: [0, 0.9],
};

// 运动条：把单个事件前后连续帧横向拼接成一条（帧间白缝 + 帧序号），让看图器能看出运动/瞬移/重叠。
// 每事件一张。窗口按事件类型贴合（见 KIND_WINDOW），N 帧（默认 4）。
function renderStrip(game, kind, tCenter, outPath, nFrames) {
  const n = nFrames || 4;
  const GAP = 4; // 帧间隔（px，白缝）
  const H_MARGIN = 26; // 顶部留白（写时间轴刻度用）
  const stripW = n * W + (n - 1) * GAP;
  const stripH = H_MARGIN + H;
  const canvas = new SoftCanvas(stripW, stripH);
  const ctx = canvas.ctx;
  // 背景
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, stripW, stripH);
  const [dw0, dw1] = KIND_WINDOW[kind] || KIND_WINDOW.default;
  const t0 = tCenter + dw0;
  const t1 = tCenter + dw1;
  for (let f = 0; f < n; f++) {
    const frac = n === 1 ? 0.5 : f / (n - 1);
    const t = t0 + (t1 - t0) * frac;
    const sub = new SoftCanvas(W, H);
    game.seekTo(Math.max(0, Math.min(t, game.matchEnd)));
    renderFrame(sub.ctx, { players: game.players, ball: game.ball }, W, H, {
      playTime: Math.max(0, Math.min(t, game.matchEnd)),
      movingIds: new Set(game.currentHighlightParticipants?.() || []),
      dt: DT,
      cards: game.activeCards?.(),
    });
    // 拷贝子画布像素到条（带 y 偏移 H_MARGIN）
    const src = sub.ctx._px;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 4;
        const dx = f * (W + GAP) + x;
        const dy = H_MARGIN + y;
        const d = (dy * stripW + dx) * 4;
        ctx._px[d] = src[s]; ctx._px[d + 1] = src[s + 1]; ctx._px[d + 2] = src[s + 2]; ctx._px[d + 3] = 255;
      }
    }
    // 帧下标刻度
    const tag = `${t.toFixed(2)}s`;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${f}`, f * (W + GAP) + W / 2, 12);
    ctx.font = '10px sans-serif';
    ctx.fillText(tag, f * (W + GAP) + W / 2, 23);
  }
  writeFileSync(outPath, canvasToPng(canvas));
}

export async function main() {
  const seed = Number(process.argv[2] ?? 42);
  const outDir = process.argv[3] ?? '/tmp/fm-frames';
  const stripN = Number(process.argv.find((a, i) => process.argv[i - 1] === '--strip-frames') ?? 4);
  const cap = Number(process.argv.find((a, i) => process.argv[i - 1] === '--cap') ?? 3);
  const singleMode = process.argv.includes('--single');
  mkdirSync(outDir, { recursive: true });

  // 跑整场拿事件流
  const { events, lineup } = await run(seed, 5400);
  const game = new Game(events, lineup);

  const targets = findTargetIndices(events);
  const byKind = {};
  for (const { i, kind } of targets) {
    (byKind[kind] = byKind[kind] || []).push(i);
  }
  let rendered = 0;
  const meta = [];
  for (const kind of Object.keys(byKind)) {
    const capN = { foul: 3, shot: 3, tackle: 2, intercepted: 3, lost: 2, free_kick: 2, corner: 2 }[kind] ?? 1;
    const chosen = byKind[kind].slice(0, Math.min(capN, cap));
    for (const evIdx of chosen) {
      const e = events[evIdx];
      const t0 = e.t;
      const safeKind = kind.replace(/[^a-z0-9_]/gi, '_');
      if (singleMode) {
        // 单帧模式：事件瞬间
        const fname = `${seed}_${safeKind}_${evIdx}.png`;
        const canvas = renderOne(game, t0);
        writeFileSync(join(outDir, fname), canvasToPng(canvas));
        meta.push({ file: fname, kind, evIdx, t: +t0.toFixed(2), eventType: e.type, result: e.result ?? null, detail: e.detail ?? null });
        rendered++;
      } else {
        // 运动条模式：事件前后连续帧拼一条
        const fname = `${seed}_${safeKind}_${evIdx}.png`;
        renderStrip(game, kind, t0, join(outDir, fname), stripN);
        meta.push({ file: fname, kind, evIdx, t: +t0.toFixed(2), eventType: e.type, result: e.result ?? null, detail: e.detail ?? null, stripFrames: stripN });
        rendered++;
      }
    }
  }
  writeFileSync(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[visual-probe] seed ${seed}: rendered ${rendered} images (${singleMode ? 'single' : `strip x${stripN}`}) -> ${outDir}`);
  console.log(`[visual-probe] kinds: ${Object.keys(byKind).join(', ')}`);
  return { rendered, kinds: Object.keys(byKind) };
}

// 让脚本可被 import 也可直接跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
