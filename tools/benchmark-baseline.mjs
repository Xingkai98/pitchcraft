// P36 比赛标尺：基线生成（真实侧观测范围 + 引擎侧冻结值 → viewer/data/benchmark-baseline.json）。
//
// 基线 = 真实 2 场的 13 个满窗观测范围（min/max/均值/样本量）+ 冻结种子集的引擎当前值。
// **只入库摘要，不入原始数据**（原始 tracking 与转换产物都不入库，见 P35 与 .gitignore）。
//
// 生成链路（缺一不可，否则"可复现"只是口号）：
//   node tools/fetch-tracking-data.mjs
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json
//   (cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
//   node tools/benchmark-baseline.mjs
//
// 基线记录指标模块的 sha256（陈旧性校验）——指标实现变更后必须重跑本脚本，
// 否则 tools/benchmark-compare.mjs 会拒绝拿旧分布对照新实现（对齐 P28 教训）。
//
// 用法：node tools/benchmark-baseline.mjs [--out viewer/data/benchmark-baseline.json]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  WINDOW_SIZE_SEC, WINDOW_STEP_SEC, SAMPLE_INTERVAL_SEC, MIN_OUTFIELD_PLAYERS,
  KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, ENGINE_DURATION_SEC, BENCHMARK_SEEDS,
  fromTrackingFrame, cutWindows, windowMetrics, summarizeWindowMetrics, elasticity,
} from '../viewer/match-metrics.js';
import { loadEngineWasm, sampleEngineStats, MISSING_WASM_HINT } from './benchmark-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_PATH = join(ROOT, 'viewer', 'match-metrics.js');
const DATA_DIR = join(ROOT, 'viewer', 'data');
const DEFAULT_OUT = join(DATA_DIR, 'benchmark-baseline.json');

const MISSING_REAL_HINT = '缺少真实侧帧序列（viewer/data/real-game-*.json）—— 先生成：\n'
  + '  node tools/fetch-tracking-data.mjs\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json';

export function hashMetricsModule(path = METRICS_PATH) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// 一场真实比赛 → 逐窗指标与元数据（窗口列表、残窗、尾部未覆盖秒数）。
export function realGameWindows(data, gameName) {
  const frames = data.frames.map(fromTrackingFrame);
  const hz = data.meta && data.meta.keyframeHz ? data.meta.keyframeHz : 5;
  const endSec = frames[frames.length - 1].t;
  const windows = cutWindows(frames);
  const windowRecords = [];
  const metrics = [];
  const elasticities = { half: [], centroid: [] };
  let lastEnd = 0;
  for (const w of windows) {
    const startSec = w[0].t;
    const durationSec = w.length / hz;
    windowRecords.push({ startSec: Math.round(startSec * 100) / 100, durationSec: Math.round(durationSec * 100) / 100, frameCount: w.length });
    metrics.push(windowMetrics(w));
    const eh = elasticity(w, { divider: 'half' });
    const ec = elasticity(w, { divider: 'centroid' });
    if (eh) elasticities.half.push(eh.delta);
    if (ec) elasticities.centroid.push(ec.delta);
    lastEnd = Math.max(lastEnd, startSec + WINDOW_SIZE_SEC);
  }
  // 残窗：若还有候选窗起点落在比赛结束前但不足 300s，如实记录（design 要求：game2 的 246s）
  let discardedPartialWindow = null;
  const lastStart = windowRecords.length ? windowRecords[windowRecords.length - 1].startSec : -WINDOW_STEP_SEC;
  const nextStart = lastStart + WINDOW_STEP_SEC;
  if (nextStart <= endSec + 1) {
    const partialSec = endSec - nextStart;
    if (partialSec > 1) {
      discardedPartialWindow = {
        startSec: nextStart,
        durationSec: Math.round(partialSec * 100) / 100,
        reason: '不足 300s 的残窗，不入统计',
      };
    }
  }
  return {
    game: gameName,
    meta: {
      source: data.meta && data.meta.source,
      format: data.meta && data.meta.format,
      hz: data.meta && data.meta.hz,
      keyframeHz: hz,
      frameCount: frames.length,
      startSec: Math.round(frames[0].t * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
    },
    windows: windowRecords,
    tail: {
      lastWindowEndSec: lastEnd,
      uncoveredSec: Math.round((endSec - lastEnd) * 100) / 100,
      note: '步长 900s/窗宽 300s：窗间 600s 间隔是切片设计（非连续段）；uncoveredSec 含该间隔与残窗',
    },
    discardedPartialWindow,
    metrics,
    elasticities,
  };
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const elasticitySummary = (deltas) => (deltas.length
  ? { avgDelta: avg(deltas), min: Math.min(...deltas), max: Math.max(...deltas), n: deltas.length }
  : null);

export async function generateBaseline({ dataDir = DATA_DIR } = {}) {
  const files = readdirSync(dataDir).filter((f) => /^real-game-.*\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error(MISSING_REAL_HINT);

  const games = files.map((f) => realGameWindows(JSON.parse(readFileSync(join(dataDir, f), 'utf8')), f.replace(/\.json$/, '')));
  const allMetrics = games.flatMap((g) => g.metrics);
  const allHalf = games.flatMap((g) => g.elasticities.half);
  const allCentroid = games.flatMap((g) => g.elasticities.centroid);

  const engineLoad = await loadEngineWasm();
  if (!engineLoad.ok) throw new Error(MISSING_WASM_HINT);
  const engine = await sampleEngineStats({ wasm: engineLoad.wasm });

  const baseline = {
    kind: 'p36-match-benchmark-baseline',
    schemaVersion: 1,
    generatedBy: 'tools/benchmark-baseline.mjs',
    metricsModule: {
      path: 'viewer/match-metrics.js',
      sha256: hashMetricsModule(),
      convention: 'trim1 depth (drop deepest+highest, span of remaining 8); keepers excluded (id 0/21)',
      aggregation: 'per-frame instantaneous shape → mean over frames; frames with <7 outfield players dropped',
      pitchMeters: [PITCH_LENGTH_M, PITCH_WIDTH_M],
      sampleIntervalSec: SAMPLE_INTERVAL_SEC,
      minOutfieldPlayers: MIN_OUTFIELD_PLAYERS,
      keeperIds: KEEPER_IDS,
    },
    windows: {
      sizeSec: WINDOW_SIZE_SEC,
      stepSec: WINDOW_STEP_SEC,
      real: {
        nWindows: allMetrics.length,
        nGames: games.length,
        perGame: games.map((g) => ({
          game: g.game,
          meta: g.meta,
          windows: g.windows,
          tail: g.tail,
          discardedPartialWindow: g.discardedPartialWindow,
        })),
      },
      engine: {
        nWindows: engine.nWindows,
        seeds: engine.seeds,
        durationSec: ENGINE_DURATION_SEC,
        windowsPerSeed: engine.nWindows / engine.seeds.length,
        note: '5 种子 × 6 窗；同一种子内的窗口不独立（同一次模拟），引用时勿当作 30 个独立样本',
      },
    },
    real: {
      perMetric: summarizeWindowMetrics(allMetrics),
      elasticity: {
        convention: 'rawBallFramesOnly（球相关口径：只用原始观测球帧）',
        half: elasticitySummary(allHalf),
        centroid: elasticitySummary(allCentroid),
      },
    },
    engine: {
      perMetric: engine.perMetric,
      elasticity: engine.elasticity,
      perSeed: engine.perSeed,
    },
    declarations: {
      rangeMeaning: `本基线是 ${games.length} 场真实比赛（${files.join('、')}）的 ${allMetrics.length} 个 ${WINDOW_SIZE_SEC}s 窗口的观测范围，`
        + '不是"真实足球的分布"。区间自身不确定性大（bootstrap CI 宽度 ≈ 区间宽度），只可用于报警与量差距，不可作为验收判据。',
      notCovered: [
        '联赛/球队风格/球队实力未知（Metrica 匿名样本）',
        '比分状态未知（数据无比分，无法按追分/领先分桶）',
        '换人前后、天气、场地条件未分层',
        '仅 2 场，且采样为中段 5 分钟切片（步长 900s），非连续时段',
      ],
      controlProxy: '控球相位 = 离球最近者所属队（代理，非真实持球权）',
      ballFrames: '球相关指标主口径只用原始观测球帧；全帧对照见 perMetric.ballDistAllFrames',
    },
    regenerate: {
      steps: [
        'node tools/fetch-tracking-data.mjs',
        'node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json',
        'node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json',
        '(cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)',
        'node tools/benchmark-baseline.mjs',
      ],
      note: '原始数据与转换产物不入库（.gitignore）；换用更多真实比赛时：把转换产物放进 viewer/data/ 并重跑本脚本',
    },
  };
  return baseline;
}

export function renderBaselineSummary(b) {
  const fmt = (s, d = 2) => (s ? `${s.avg.toFixed(d)} [${s.min.toFixed(d)}–${s.max.toFixed(d)}] n=${s.n}` : '—');
  const names = { hd: '主队纵深(trim1)', ad: '客队纵深(trim1)', spread: '紧凑度(到重心)', gap: '两队重心间距', width: '宽度(主队)', ballDist: '重心到球(原始球帧)', ballDistAllFrames: '重心到球(全帧对照)' };
  const lines = [`真实 ${b.windows.real.nGames} 场 / ${b.windows.real.nWindows} 满窗   vs   引擎 ${b.windows.engine.seeds.join(',')} / ${b.windows.engine.nWindows} 窗`];
  for (const [k, name] of Object.entries(names)) {
    lines.push(`  ${name.padEnd(18)} 真实 ${fmt(b.real.perMetric[k]).padEnd(28)} 引擎 ${fmt(b.engine.perMetric[k])}`);
  }
  for (const [k, name] of [['half', '弹性Δ(半场分桶)'], ['centroid', '弹性Δ(重心分桶)']]) {
    const r = b.real.elasticity[k];
    const e = b.engine.elasticity[k];
    lines.push(`  ${name.padEnd(18)} 真实 ${r ? r.avgDelta.toFixed(2) : '—'}  引擎 ${e ? e.avgDelta.toFixed(2) : '—'}`);
  }
  return lines.join('\n');
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : DEFAULT_OUT;
  const baseline = await generateBaseline();
  // 目录可能不存在（干净 worktree 里 viewer/data/ 被 gitignore）
  if (!existsSync(dirname(out))) throw new Error(`输出目录不存在：${dirname(out)}`);
  writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(renderBaselineSummary(baseline));
  console.log(`\n→ ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
