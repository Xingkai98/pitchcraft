// P36 比赛标尺：对比报告（引擎当前值 vs 真实观测范围基线 / vs 冻结引擎基线）。
//
// **默认形态 = 报告期**（design D5b，用户 2026-09-18 拍板）：只输出数字与对比
// （数值、偏离方向与幅度、口径敏感性），**不产生 pass/fail**。真实样本（2 场 / 13 窗）
// 导出的范围不足以当验收判据（用它验收会把一半真实比赛判为"不像真实足球"），
// 在样本扩大、校准目标确定之前，标尺的职责是量出差距。
// 唯一有断言的地方是指标函数单测（viewer/match-metrics.test.js）——保证"量出来的数是对的"。
//
// 用法（仓库根）：
//   node tools/benchmark-compare.mjs
//   （需要 viewer/engine.wasm；不需要真实原始数据——基线已含真实侧摘要）
// 基线缺失 / 陈旧（指标模块哈希不匹配）/ engine.wasm 缺失 → 跳过并提示，退出码 0
// （对齐 spec「基线缺失时跳过而非失败」）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, SAMPLE_INTERVAL_SEC, WINDOW_SIZE_SEC, WINDOW_STEP_SEC,
} from '../viewer/match-metrics.js';
import { loadEngineWasm, sampleEngineStats, MISSING_WASM_HINT } from './benchmark-engine.mjs';
import { hashMetricsModule } from './benchmark-baseline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE_PATH = join(ROOT, 'viewer', 'data', 'benchmark-baseline.json');

// 三项采用指标（设计 D3：实测分布分离）与报告项（重叠/口径敏感，仅报告）
export const ADOPTED_METRICS = [
  ['hd', '主队纵深(trim1)'],
  ['spread', '紧凑度(到重心)'],
  ['gap', '两队重心间距'],
];
export const REPORT_METRICS = [
  ['ad', '客队纵深(trim1)'],
  ['width', '宽度(主队)'],
  ['ballDist', '重心到球(原始球帧)'],
  ['ballDistAllFrames', '重心到球(全帧对照)'],
];

// 加载基线：{ ok:true, baseline } 或 { ok:false, reason:'missing'|'stale', message }
// stale = 指标模块哈希与基线记录不符（指标实现已变更而基线未重生成，见 design 风险节）。
export function loadBaseline(path = DEFAULT_BASELINE_PATH, { metricsPath } = {}) {
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: 'missing',
      message: `基线不存在：${path}\n`
        + '  生成方式：node tools/benchmark-baseline.mjs（需先 fetch/convert + 构建 engine.wasm，见脚本头部注释）',
    };
  }
  // 损坏/半截 JSON 与结构缺失都走 invalid 跳过路径（与 missing/stale 同为退出 0）——
  // 否则 JSON.parse 异常或 undefined.perMetric 会在 verify.sh（set -e）里把套件整体打红。
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid',
      message: `基线损坏（JSON 解析失败）：${path}\n  ${err.message}\n  重生成：node tools/benchmark-baseline.mjs`,
    };
  }
  if (!baseline || typeof baseline !== 'object'
    || !baseline.real || !baseline.real.perMetric
    || !baseline.engine || !baseline.engine.perMetric) {
    return {
      ok: false,
      reason: 'invalid',
      message: `基线结构不完整（缺 real/engine.perMetric）：${path}\n  重生成：node tools/benchmark-baseline.mjs`,
    };
  }
  const currentHash = metricsPath ? hashMetricsModule(metricsPath) : hashMetricsModule();
  const recorded = baseline.metricsModule && baseline.metricsModule.sha256;
  if (recorded && recorded !== currentHash) {
    return {
      ok: false,
      reason: 'stale',
      message: `基线陈旧：viewer/match-metrics.js 已变更（sha256 ${currentHash.slice(0, 12)}… ≠ 基线记录的 ${recorded.slice(0, 12)}…）。\n`
        + '  指标口径变了，旧基线不再可比 —— 重生成：node tools/benchmark-baseline.mjs',
    };
  }
  return { ok: true, baseline };
}

// 单指标对比：引擎窗口分布 vs 真实观测范围。只输出事实，无判定。
//   direction: 引擎整体在真实范围之上（'above'）/ 之下（'below'）/ 重叠（'overlap'）
//   marginM:   above → 引擎最低窗 − 真实最高窗（正 = 完全不重叠的余量）；below 对称；overlap → null
export function compareMetric(engineSummary, realSummary) {
  if (!engineSummary || !realSummary) return null;
  const deltaAvgM = engineSummary.avg - realSummary.avg;
  const deltaPct = realSummary.avg !== 0 ? (deltaAvgM / realSummary.avg) * 100 : null;
  let direction = 'overlap';
  let marginM = null;
  if (engineSummary.min > realSummary.max) {
    direction = 'above';
    marginM = engineSummary.min - realSummary.max;
  } else if (engineSummary.max < realSummary.min) {
    direction = 'below';
    marginM = realSummary.min - engineSummary.max;
  }
  return {
    direction,
    deltaAvgM,
    deltaPct,
    marginM,
    engine: { avg: engineSummary.avg, min: engineSummary.min, max: engineSummary.max, n: engineSummary.n },
    real: { avg: realSummary.avg, min: realSummary.min, max: realSummary.max, n: realSummary.n },
  };
}

// 引擎当前 vs 冻结引擎基线（防恶化只报告、不断言——ratchet 门待样本扩大后评估，design D6）
export function driftVsFrozen(engineSummary, frozenSummary) {
  if (!engineSummary || !frozenSummary || frozenSummary.avg === 0) return null;
  return {
    frozenAvg: frozenSummary.avg,
    currentAvg: engineSummary.avg,
    deltaM: engineSummary.avg - frozenSummary.avg,
    deltaPct: ((engineSummary.avg - frozenSummary.avg) / frozenSummary.avg) * 100,
  };
}

// 结构化对比结果（纯函数：给定基线 + 引擎当前统计 → 报告对象；渲染与它解耦，便于单测）。
export function buildComparison(baseline, engineStats) {
  const adopted = ADOPTED_METRICS.map(([key, name]) => ({
    key,
    name,
    comparison: compareMetric(engineStats.perMetric[key], baseline.real.perMetric[key]),
    drift: driftVsFrozen(engineStats.perMetric[key], baseline.engine.perMetric[key]),
  }));
  const reported = REPORT_METRICS.map(([key, name]) => ({
    key,
    name,
    comparison: compareMetric(engineStats.perMetric[key], baseline.real.perMetric[key]),
  }));
  const elasticity = ['half', 'centroid'].map((k) => ({
    divider: k,
    label: k === 'half' ? '球在哪个半场' : '球相对本队重心前后',
    real: baseline.real.elasticity[k],
    engine: engineStats.elasticity[k],
  }));
  return {
    adopted,
    reported,
    elasticity,
    possessionProxyNote: '控球相位来自"离球最近者所属队"这一代理，不等于真实持球权',
    sampleNote: `真实基线 = ${baseline.windows.real.nGames} 场 / ${baseline.windows.real.nWindows} 个满窗；`
      + `引擎 = ${(engineStats.seeds || BENCHMARK_SEEDS).length} 种子 × ${baseline.windows.engine.windowsPerSeed} 窗（${ENGINE_DURATION_SEC}s @ ${SAMPLE_INTERVAL_SEC}s 采样）`,
  };
}

const fmtN = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const dirLabel = { above: '高于真实观测范围', below: '低于真实观测范围', overlap: '落在真实观测范围内（重叠）' };

export function renderReport(cmp) {
  const L = [];
  L.push('=== P36 比赛标尺（报告期：只输出数字与对比，不判定符合性） ===');
  L.push('');
  L.push(`窗口 ${WINDOW_SIZE_SEC}s / 步长 ${WINDOW_STEP_SEC}s | 采样 ${SAMPLE_INTERVAL_SEC}s | ${cmp.sampleNote}`);
  L.push('');
  L.push('[三项采用指标] 引擎 vs 真实（"观测范围"= 本基线 min–max，非"真实足球的分布"）');
  for (const { name, comparison: c, drift } of cmp.adopted) {
    if (!c) { L.push(`  ${name}：缺数据`); continue; }
    const margin = c.marginM != null ? `，余量 ${fmtN(c.marginM)}m` : '';
    const driftStr = drift ? `　| 冻结基线 ${fmtN(drift.frozenAvg)}（漂移 ${drift.deltaPct >= 0 ? '+' : ''}${fmtN(drift.deltaPct, 1)}%）` : '';
    L.push(`  ${name.padEnd(16)} 引擎 ${fmtN(c.engine.avg)} [${fmtN(c.engine.min)}–${fmtN(c.engine.max)}]`
      + `　真实 ${fmtN(c.real.avg)} [${fmtN(c.real.min)}–${fmtN(c.real.max)}]`
      + `　${dirLabel[c.direction]}（均值 ${c.deltaPct >= 0 ? '+' : ''}${fmtN(c.deltaPct, 1)}%）${margin}${driftStr}`);
  }
  L.push('');
  L.push('[报告项]（不作校准目标、不进断言）');
  for (const { name, comparison: c } of cmp.reported) {
    if (!c) { L.push(`  ${name}：缺数据`); continue; }
    L.push(`  ${name.padEnd(16)} 引擎 ${fmtN(c.engine.avg)} [${fmtN(c.engine.min)}–${fmtN(c.engine.max)}]`
      + `　真实 ${fmtN(c.real.avg)} [${fmtN(c.real.min)}–${fmtN(c.real.max)}]`
      + `　${dirLabel[c.direction]}（均值 ${c.deltaPct >= 0 ? '+' : ''}${fmtN(c.deltaPct, 1)}%）`);
  }
  L.push('');
  L.push('[口径敏感性：弹性]（纵深随球位置的变化；数值随分桶口径变化 → 不作校准目标）');
  for (const e of cmp.elasticity) {
    const r = e.real ? `${fmtN(e.real.avgDelta)} [${fmtN(e.real.min)}–${fmtN(e.real.max)}]` : '—';
    const g = e.engine ? `${fmtN(e.engine.avgDelta)} [${fmtN(e.engine.min)}–${fmtN(e.engine.max)}]` : '—';
    L.push(`  ${e.label.padEnd(14)} 真实 Δ ${r}　引擎 Δ ${g}`);
  }
  L.push('');
  L.push(`注：${cmp.possessionProxyNote}。`);
  L.push('本报告不产生 pass/fail —— 唯一断言在指标单测（viewer/match-metrics.test.js）。');
  return L.join('\n');
}

// CLI：跳过（基线缺失/陈旧、wasm 缺失）一律退出码 0（套件不失败），消息说明生成方式。
export async function main({ baselinePath = DEFAULT_BASELINE_PATH } = {}) {
  const loaded = loadBaseline(baselinePath);
  if (!loaded.ok) {
    const label = { missing: '基线缺失', stale: '基线陈旧', invalid: '基线损坏' }[loaded.reason] || loaded.reason;
    console.log(`P36 标尺：跳过（${label}）\n${loaded.message}`);
    return 0;
  }
  const wasmLoad = await loadEngineWasm();
  if (!wasmLoad.ok) {
    console.log(`P36 标尺：跳过（engine.wasm 缺失）\n${MISSING_WASM_HINT}`);
    return 0;
  }
  const engineStats = await sampleEngineStats({ wasm: wasmLoad.wasm });
  const cmp = buildComparison(loaded.baseline, engineStats);
  console.log(renderReport(cmp));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
