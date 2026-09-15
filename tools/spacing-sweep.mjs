// 同队间距**整场滑窗**扫描（#53 / P34 的真实门，比 P26 的稀疏 fixture 密得多）。
//
// 为什么需要它：P26 的 `tools/fixtures/real-audit-input.json` 只在 6–7 个手工挑的窗口上
// 采快照，样本稀疏——引擎可能有大量未采样时刻的同队重叠而不被发现（P34 审阅 P0-1 的教训：
// 实现者曾据此误报「detector 归零」）。本脚本把真实采集窗口（±5s）**滑过整场**，
// 每 `STEP` 秒一窗，用真实采集管线（`captureObservation`）产出 audit_input 再跑 detector，
// 给出「整场口径」的 finding 数与最恶劣间距。
//
// 用法（仓库根，需先构建 viewer/engine.wasm）：
//   (cd engine && cargo build --target wasm32-unknown-unknown --release \
//     && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
//   node tools/spacing-sweep.mjs            # 默认 seed 42 1 2 3 7 59
//   node tools/spacing-sweep.mjs 42 1 2     # 指定 seed
//
// 退出码：任一 seed 出现 finding 即 1（可作 CI 门；默认 seed 集下当前应为 0）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import(join(ROOT, 'viewer', 'config.js'));
const { parseEventStream } = await import(join(ROOT, 'viewer', 'protocol.js'));
const { Game } = await import(join(ROOT, 'viewer', 'game.js'));
const { captureObservation } = await import(join(ROOT, 'viewer', 'observation.js'));
const { DEFAULT_AUDIT_PROFILE, detectPlayerOverlap } = await import(join(ROOT, 'tools', 'detectors.mjs'));

config.debug.enabled = false; // 关调试日志；跳过机制会改 playTime，关掉
config.playback.skipThresholdSeconds = Infinity;

const WASM = join(ROOT, 'viewer', 'engine.wasm');
let wasmBytes;
try {
  wasmBytes = readFileSync(WASM);
} catch {
  console.error(
    `缺少 ${WASM}。先构建 WASM：\n` +
      '  (cd engine && cargo build --target wasm32-unknown-unknown --release)\n' +
      '  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm'
  );
  process.exit(2);
}

const DUR = 5400; // 90 分钟
const STEP = 2.5; // 采样步长（秒）：±5s 窗 = 10s 宽 → 4x 重叠，密到不会漏掉短暂重叠
// 默认 seed 集：含 P34 审阅 R2 命中的 `59`（当年默认集 `42 1 2 3 7` 全零，漏掉了它——
// 那次残留的根因是「罚下球员幽灵」，已在 viewer 侧修复；`59` 是默认集中**唯一**含红牌
// （2 张：15@78、8@3835）的 seed，是幽灵路径的常态覆盖）。
const seeds = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [42, 1, 2, 3, 7, 59];

const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const wasm = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SCRATCH = 1024;

let totalFindings = 0;
for (const seed of seeds) {
  const cfgBytes = encoder.encode(JSON.stringify({ match_duration_seconds: DUR }));
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfgBytes.length).set(cfgBytes);
  wasm.simulate(BigInt(seed), SCRATCH, cfgBytes.length);
  const raw = JSON.parse(
    decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length()))
  );
  wasm.free_json();
  const { events, lineup } = parseEventStream(raw);

  let findings = 0;
  let worst = Infinity;
  let windows = 0;
  for (let t = 5; t <= DUR - 5; t += STEP) {
    const game = new Game(events, lineup, 'continuous');
    game.seekTo(t);
    const bundle = captureObservation({
      game,
      statement: '',
      selectedEntities: [],
      window: { before: 5, after: 5 },
      seed,
      config: { match_duration_seconds: DUR },
      sourceRevision: '<spacing-sweep>',
      opts: { idFactory: () => 'sweep', now: 1 },
    });
    const f = detectPlayerOverlap(bundle.audit_input.players, DEFAULT_AUDIT_PROFILE);
    windows += 1;
    for (const x of f) {
      findings += 1;
      if (x.features.min_distance < worst) worst = x.features.min_distance;
    }
  }
  totalFindings += findings;
  const tail = findings ? ` worst=${worst.toFixed(3)}m` : '';
  console.log(`seed ${seed}: ${windows} windows, player_overlap findings=${findings}${tail}`);
}

if (totalFindings > 0) {
  console.error(`\nFAIL: ${totalFindings} player_overlap finding(s) over the swept windows`);
  process.exit(1);
}
console.log('\nOK: no player_overlap findings over the swept windows');
