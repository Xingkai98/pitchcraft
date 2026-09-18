// P36/P37 比赛标尺：基线生成（真实侧观测范围 + 引擎侧冻结值 → viewer/data/benchmark-baseline.json）。
//
// 基线 = 真实样本的满窗观测范围（min/max/均值/样本量）+ 冻结种子集的引擎当前值。
// **只入库摘要，不入原始数据**（原始 tracking 与转换产物都不入库，见 P35 与 .gitignore）。
//
// P37 变更（用户拍板，见 change design D2/D4/D5/D6）：
//   - **多数据集**：Metrica（2 场）+ SkillCorner（20 场）**分别报告**（D6），
//     SkillCorner 为主报告；各自记录来源/许可/采集方式/逐场 status。
//   - **逐场球场尺寸**：指标换算按每场自己的 pitch_length/width（D4）。
//   - **外推口径**：主口径跳过外推点；全点口径并列（D2）。
//   - **逐窗记录** frameCount 与「主口径可用帧数」。
//   - **跨数据集可比性检查**显式输出（D6）。
//
// 生成链路（缺一不可，否则"可复现"只是口号）：
//   node tools/fetch-tracking-data.mjs
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json
//   node tools/convert-skillcorner-to-frames.mjs --match <.../<id>_match.json> --out viewer/data/skillcorner-<id>.json   # 20 场
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
  QUANTILE_LO, QUANTILE_HI,
  fromTrackingFrame, cutWindows, windowMetrics, summarizeWindowMetrics, elasticity,
} from '../viewer/match-metrics.js';
import { loadEngineWasm, sampleEngineStats, MISSING_WASM_HINT } from './benchmark-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_PATH = join(ROOT, 'viewer', 'match-metrics.js');
const DATA_DIR = join(ROOT, 'viewer', 'data');
const DEFAULT_OUT = join(DATA_DIR, 'benchmark-baseline.json');

// 数据集定义：文件名前缀 → 数据集键。**分开报告**（D6）——两套数据的生成过程不同，
// 混在一起算 min/max 等于假设"它们来自同一分布"，而这个假设没有依据。
export const DATASETS = {
  metrica: {
    label: 'Metrica Sports sample-data',
    source: 'https://github.com/metrica-sports/sample-data',
    license: '未声明正式许可；README 要求使用时注明来源并负责任使用（开发/研究用途）',
    collection: '25 Hz，人工标注/半自动；0-1 归一化坐标；球场恒 105×68',
    matchFile: /^real-game-.*\.json$/,
    primary: false,
  },
  skillcorner: {
    label: 'SkillCorner opendata（澳超 2024/25）',
    source: 'https://github.com/SkillCorner/opendata',
    license: 'MIT（仓库根 LICENSE）',
    collection: '10 fps，广播 CV 重建；米制中心原点；球场 104/105/106 三种；点带 is_detected 外推标记',
    matchFile: /^skillcorner-.*\.json$/,
    primary: true,
  },
};

const MISSING_REAL_HINT = '缺少真实侧帧序列（viewer/data/real-game-*.json 与 skillcorner-*.json）—— 先生成：\n'
  + '  node tools/fetch-tracking-data.mjs\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json\n'
  + '  node tools/convert-skillcorner-to-frames.mjs --match <.../<id>_match.json> --out viewer/data/skillcorner-<id>.json（每场一次）';

export function hashMetricsModule(path = METRICS_PATH) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// 一场真实比赛 → 逐窗指标与元数据（窗口列表、残窗、尾部未覆盖秒数）。
// **逐场尺寸**：从帧上取（转换器写入 meta.pitchMeters）→ 传给 cutWindows 之后的指标层。
export function realGameWindows(data, gameName) {
  const pitchMeters = data.meta && data.meta.pitchMeters
    ? [data.meta.pitchMeters.length, data.meta.pitchMeters.width] : null;
  const frames = data.frames.map((f) => fromTrackingFrame(f, { pitchMeters }));
  const hz = data.meta && data.meta.keyframeHz ? data.meta.keyframeHz : 5;
  const endSec = frames[frames.length - 1].t;
  const windows = cutWindows(frames);
  const windowRecords = [];
  const metrics = []; // 主口径（跳过外推点）
  const metricsAll = []; // 全点口径（对照）
  const elasticities = { half: [], centroid: [] };
  let lastEnd = 0;
  for (const w of windows) {
    const startSec = w[0].t;
    // nominalSec = 窗口名义跨度（300s）；frameCount 是**实际帧数**。二者在有缺口的数据上
    // 差别很大（SkillCorner 约 27% 时段无观测）——P37 审阅 P1-2：旧实现的 durationSec =
    // frameCount/hz 会把"帧数"当"时长"（300s 窗算出 ~199s），误导读者。改记名义跨度。
    const { primary, allPoints } = windowMetrics(w);
    windowRecords.push({
      startSec: Math.round(startSec * 100) / 100,
      nominalSec: WINDOW_SIZE_SEC,
      frameCount: w.length,
      okPrimary: primary ? primary.frameCount : 0, // 主口径可用帧（外推过滤 + 人数阈值之后）
      okAllPoints: allPoints ? allPoints.frameCount : 0,
    });
    metrics.push(primary);
    metricsAll.push(allPoints);
    const eh = elasticity(w, { divider: 'half' });
    const ec = elasticity(w, { divider: 'centroid' });
    if (eh) elasticities.half.push(eh.delta);
    if (ec) elasticities.centroid.push(ec.delta);
    lastEnd = Math.max(lastEnd, startSec + WINDOW_SIZE_SEC);
  }
  // 残窗：若还有候选窗起点落在比赛结束前但不足 300s，如实记录（design 要求）
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
    status: (data.meta && data.meta.status) || null,
    pitchMeters: pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M],
    meta: {
      source: data.meta && data.meta.source,
      format: data.meta && data.meta.format,
      hz: data.meta && data.meta.hz,
      keyframeHz: hz,
      frameCount: frames.length,
      startSec: Math.round(frames[0].t * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
      timeGaps: (data.meta && data.meta.timeAxis && data.meta.timeAxis.gaps) || null,
    },
    windows: windowRecords,
    tail: {
      lastWindowEndSec: lastEnd,
      uncoveredSec: Math.round((endSec - lastEnd) * 100) / 100,
      note: '步长 900s/窗宽 300s：窗间 600s 间隔是切片设计（非连续段）；uncoveredSec 含该间隔与残窗',
    },
    discardedPartialWindow,
    metrics,
    metricsAll,
    elasticities,
  };
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const elasticitySummary = (deltas) => (deltas.length
  ? { avgDelta: avg(deltas), min: Math.min(...deltas), max: Math.max(...deltas), n: deltas.length }
  : null);

// 一个数据集 → 完整统计块。files 是该数据集的帧序列文件名。
export function summarizeDataset(key, files, readJson) {
  const def = DATASETS[key];
  const games = files.map((f) => realGameWindows(readJson(f), f.replace(/\.json$/, '')));
  const allMetrics = games.flatMap((g) => g.metrics);
  const allMetricsAllPoints = games.flatMap((g) => g.metricsAll);
  const allHalf = games.flatMap((g) => g.elasticities.half);
  const allCentroid = games.flatMap((g) => g.elasticities.centroid);
  const okPrimary = games.flatMap((g) => g.windows.map((w) => w.okPrimary));
  const okAll = games.flatMap((g) => g.windows.map((w) => w.okAllPoints));
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const q = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  return {
    label: def.label,
    source: def.source,
    license: def.license,
    collection: def.collection,
    nGames: games.length,
    nWindows: allMetrics.length,
    games: games.map((g) => ({
      game: g.game,
      status: g.status,
      pitchMeters: g.pitchMeters,
      meta: g.meta,
      windows: g.windows,
      tail: g.tail,
      discardedPartialWindow: g.discardedPartialWindow,
    })),
    // 每窗有效帧分布：让「139 个窗」这个数字可审计（P37 审阅 P1-2(c)）
    framesPerWindow: {
      nominal: WINDOW_SIZE_SEC * (games[0] ? games[0].meta.keyframeHz : 5),
      primary: { median: q(okPrimary, 0.5), min: Math.min(...okPrimary), max: Math.max(...okPrimary) },
      allPoints: { median: q(okAll, 0.5), min: Math.min(...okAll), max: Math.max(...okAll) },
    },
    perMetric: summarizeWindowMetrics(allMetrics), // 主口径（跳过外推点）
    perMetricAllPoints: summarizeWindowMetrics(allMetricsAllPoints), // 全点口径（对照）
    elasticity: {
      convention: 'rawBallFramesOnly（球相关口径：只用原始观测球帧；外推球位按 ballFill 标记排除）',
      half: elasticitySummary(allHalf),
      centroid: elasticitySummary(allCentroid),
    },
  };
}

// 跨数据集可比性检查（P37 D6，审阅 P2-4 要求"操作化"）：某数据集的范围是否落在另一个里。
// 复用 compareMetric 的语义（direction/marginM），但这里的两侧都是真实侧基线。
export function crossDatasetCheck(a, b) {
  const keys = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist'];
  const out = {};
  for (const k of keys) {
    const x = a.perMetric[k];
    const y = b.perMetric[k];
    if (!x || !y) { out[k] = null; continue; }
    // 注意：这里比的是**主口径基线**（SkillCorner 主口径跳过外推点）与 Metrica 的区间
    out[k] = {
      aRange: [x.min, x.max], bRange: [y.min, y.max],
      aInsideB: x.min >= y.min && x.max <= y.max,
      bInsideA: y.min >= x.min && y.max <= x.max,
      overlap: x.min <= y.max && y.min <= x.max,
      gapM: x.min > y.max ? x.min - y.max : (y.min > x.max ? y.min - x.max : 0),
    };
  }
  return out;
}

export async function generateBaseline({ dataDir = DATA_DIR } = {}) {
  const files = readdirSync(dataDir).filter((f) => f.endsWith('.json') && f !== 'benchmark-baseline.json');
  const readJson = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
  const datasets = {};
  for (const [key, def] of Object.entries(DATASETS)) {
    const dsFiles = files.filter((f) => def.matchFile.test(f)).sort();
    if (dsFiles.length === 0) {
      if (def.primary) throw new Error(`${MISSING_REAL_HINT}\n（数据集 ${key} 没有任何帧序列文件）`);
      console.warn(`⚠ 数据集 ${key} 无帧序列文件，跳过`);
      continue;
    }
    datasets[key] = summarizeDataset(key, dsFiles, readJson);
  }
  if (Object.keys(datasets).length === 0) throw new Error(MISSING_REAL_HINT);

  const engineLoad = await loadEngineWasm();
  if (!engineLoad.ok) throw new Error(MISSING_WASM_HINT);
  const engine = await sampleEngineStats({ wasm: engineLoad.wasm });

  const primaryKey = Object.keys(DATASETS).find((k) => DATASETS[k].primary && datasets[k]) || Object.keys(datasets)[0];
  const primary = datasets[primaryKey];
  const cross = datasets.metrica && datasets.skillcorner
    ? { metricaVsSkillcorner: crossDatasetCheck(datasets.metrica, datasets.skillcorner) } : null;

  const baseline = {
    kind: 'p37-multi-dataset-benchmark-baseline',
    schemaVersion: 2,
    generatedBy: 'tools/benchmark-baseline.mjs',
    primaryDataset: primaryKey,
    metricsModule: {
      path: 'viewer/match-metrics.js',
      sha256: hashMetricsModule(),
      convention: `q${QUANTILE_LO * 100}–q${QUANTILE_HI * 100} 线性插值分位跨度（R type-7；P37 换口径，见 match-metrics.js 头注释）`,
      aggregation: 'per-frame instantaneous shape → mean over frames; frames with <7 outfield players dropped',
      pitchMeters: 'per-game（逐场尺寸，P37 D4）；缺省 [105,68]',
      sampleIntervalSec: SAMPLE_INTERVAL_SEC,
      minOutfieldPlayers: MIN_OUTFIELD_PLAYERS,
      keeperIds: KEEPER_IDS,
      extrapolationPolicy: '主口径跳过源数据标 is_detected=false 的外推点（与「缺失不参与」同口径）；全点口径并列于 perMetricAllPoints',
    },
    windows: {
      sizeSec: WINDOW_SIZE_SEC,
      stepSec: WINDOW_STEP_SEC,
      real: { nWindows: primary.nWindows, nGames: primary.nGames, dataset: primaryKey },
      engine: {
        nWindows: engine.nWindows,
        seeds: engine.seeds,
        durationSec: ENGINE_DURATION_SEC,
        windowsPerSeed: engine.nWindows / engine.seeds.length,
        note: '5 种子 × 6 窗；同一种子内的窗口不独立（同一次模拟），引用时勿当作 30 个独立样本',
      },
    },
    datasets,
    crossDataset: cross,
    engine: {
      perMetric: engine.perMetric,
      elasticity: engine.elasticity,
      perSeed: engine.perSeed,
    },
    declarations: {
      rangeMeaning: `本基线是真实比赛的观测范围，不是"真实足球的分布"。区间自身不确定性大`
        + `（bootstrap CI 宽度 ≈ 区间宽度），只可用于报警与量差距，不可作为验收判据。`,
      // ⚠️ P37 审阅 D5 的三条「范围变宽/变窄」候选机制——不能只归因于"样本增加"
      rangeWidthMechanisms: [
        '① 样本增加暴露更多变异（P36 预期的那条）',
        '② 每窗样本量下降导致窗口均值方差上升（SkillCorner 主口径每窗有效帧远少于 Metrica 的恒 1500）',
        '③ 口径差异（P37 D2 的估计量与两侧外推/缺失处理不同）',
      ],
      notCovered: [
        '联赛/球队风格/球队实力（Metrica 匿名；SkillCorner 已知澳超 2024/25，20 场）',
        '比分状态未按追分/领先分桶',
        '换人前后、天气、场地条件未分层',
        '窗口步长 900s：窗间是散点切片、非连续时段；同一场的相邻窗高度相关，独立样本数 = 场次数',
      ],
      controlProxy: '控球相位 = 离球最近者所属队（代理，非真实持球权）',
      ballFrames: '球相关指标主口径只用原始观测球帧；全帧对照见 perMetric.ballDistAllFrames',
      timeGaps: '拼接后仍有约 27% 无观测时段（回放/特写），全部来自源数据缺口、接缝贡献 0；不被插值，按实际帧取样',
      pitchSize: '逐场尺寸换算（P37 D4）：SkillCorner 有 104/105/106 三种场地，各按自己的尺寸归一化与换算，不折算到统一名义尺寸',
      crossValidation: '交叉验证（half-split / LOO）本阶段是**报告项、不是门**：min/max 包含门的通过率与样本量无关（N=20 时约 0.25），数据正常时也会频繁变红——升格为门须先刻画门的零分布（见 change design D7）',
    },
    regenerate: {
      steps: [
        'node tools/fetch-tracking-data.mjs',
        'node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json',
        'node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json',
        'node tools/convert-skillcorner-to-frames.mjs --match <.../<id>_match.json> --out viewer/data/skillcorner-<id>.json（20 场）',
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
  const names = { hd: '主队纵深(q10-q90)', ad: '客队纵深', spread: '紧凑度(到重心)', gap: '两队重心间距', width: '宽度(主队)', ballDist: '重心到球(原始球帧)', ballDistAllFrames: '重心到球(全帧对照)' };
  const L = [];
  for (const [key, ds] of Object.entries(b.datasets)) {
    L.push(`【${key}】${ds.label}：${ds.nGames} 场 / ${ds.nWindows} 满窗`
      + `（主口径每窗有效帧 中位 ${ds.framesPerWindow.primary.median}，全距 ${ds.framesPerWindow.primary.min}–${ds.framesPerWindow.primary.max}）`);
    for (const [k, name] of Object.entries(names)) {
      L.push(`  ${name.padEnd(18)} ${fmt(ds.perMetric[k])}`);
    }
    L.push('');
  }
  const p = b.datasets[b.primaryDataset];
  L.push(`主数据集 = ${b.primaryDataset}；引擎 ${b.engine.perMetric ? `${b.windows.engine.seeds.join(',')} / ${b.windows.engine.nWindows} 窗` : '—'}`);
  for (const [k, name] of Object.entries(names)) {
    L.push(`  ${name.padEnd(18)} 引擎 ${fmt(b.engine.perMetric[k])}`);
  }
  return L.join('\n');
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : DEFAULT_OUT;
  const baseline = await generateBaseline();
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
