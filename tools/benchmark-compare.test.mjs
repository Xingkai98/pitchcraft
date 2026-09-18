// P36 对比逻辑单测：数值输出正确 / 越界给出偏离方向与幅度 / 基线缺失时跳过并提示 /
// 基线陈旧（指标模块哈希不匹配）可检出。
//
// 不依赖 wasm 与真实数据——对比是纯函数（buildComparison），基线加载走临时文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADOPTED_METRICS, REPORT_METRICS, compareMetric, driftVsFrozen, buildComparison,
  loadBaseline, renderReport, main,
} from './benchmark-compare.mjs';
import { hashMetricsModule } from './benchmark-baseline.mjs';

// 最小基线骨架（P37 多数据集结构；数值刻意简单，便于手算断言）。
// metrica 数据集作对照、skillcorner 作主数据集。
function makeDataset(n = 13, base = 25) {
  return {
    label: 'dataset',
    nGames: 2,
    nWindows: n,
    framesPerWindow: { nominal: 1500, primary: { median: 400, min: 200, max: 600 }, allPoints: { median: 1400, min: 900, max: 1500 } },
    perMetric: {
      hd: { avg: base, min: 16, max: 30, n },
      ad: { avg: 26, min: 20, max: 29.6, n },
      spread: { avg: 15, min: 10, max: 17, n },
      gap: { avg: 8, min: 6, max: 10, n },
      width: { avg: 39, min: 28, max: 47, n },
      ballDist: { avg: 18, min: 16, max: 20, n },
      ballDistAllFrames: { avg: 19, min: 15, max: 22, n },
    },
    perMetricAllPoints: {
      hd: { avg: base + 7, min: 20, max: 34, n },
      ad: { avg: 30, min: 24, max: 33, n },
      spread: { avg: 18, min: 13, max: 21, n },
      gap: { avg: 10, min: 8, max: 12, n },
      width: { avg: 41, min: 30, max: 49, n },
      ballDist: { avg: 20, min: 18, max: 22, n },
      ballDistAllFrames: { avg: 21, min: 17, max: 24, n },
    },
    elasticity: {
      half: { avgDelta: 3, min: -1, max: 7, n },
      centroid: { avgDelta: -2, min: -6, max: 1, n },
    },
  };
}

function makeBaseline(overrides = {}) {
  return {
    kind: 'p37-multi-dataset-benchmark-baseline',
    schemaVersion: 2,
    primaryDataset: 'skillcorner',
    metricsModule: { sha256: overrides.sha256 || null },
    windows: {
      real: { nGames: 2, nWindows: 13, dataset: 'skillcorner' },
      engine: { seeds: [42, 1, 7, 99, 123], nWindows: 30, windowsPerSeed: 6 },
    },
    datasets: {
      metrica: { ...makeDataset(13, 25), label: 'Metrica sample-data' },
      skillcorner: { ...makeDataset(13, 25), label: 'SkillCorner opendata', nWindows: 139 },
    },
    crossDataset: {
      metricaVsSkillcorner: {
        hd: { aRange: [16, 30], bRange: [16, 30], aInsideB: true, bInsideA: true, overlap: true, gapM: 0 },
      },
    },
    engine: {
      perMetric: {
        hd: { avg: 40, min: 32, max: 48, n: 30 },
        ad: { avg: 39, min: 29.2, max: 46, n: 30 },
        spread: { avg: 20, min: 18, max: 23, n: 30 },
        gap: { avg: 15, min: 12, max: 18, n: 30 },
        width: { avg: 32, min: 30, max: 34, n: 30 },
        ballDist: { avg: 20, min: 16, max: 24, n: 30 },
        ballDistAllFrames: { avg: 20, min: 16, max: 24, n: 30 },
      },
      elasticity: {
        half: { avgDelta: 13, min: 4, max: 25, n: 30 },
        centroid: { avgDelta: 2.5, min: -8, max: 13, n: 30 },
      },
    },
  };
}

function makeEngineStats(hd) {
  const base = makeBaseline();
  return {
    seeds: base.windows.engine.seeds,
    nWindows: 30,
    perMetric: { ...base.engine.perMetric, hd },
    elasticity: base.engine.elasticity,
  };
}

// 主数据集块（buildComparison 的输出按数据集分块）
const primaryBlock = (cmp) => cmp.perDataset.find((d) => d.key === cmp.primaryDataset);

// ── compareMetric：方向与幅度 ───────────────────────────────────────────

test('compareMetric：引擎整体在真实范围之上 → above + 正余量 + 偏离幅度', () => {
  const c = compareMetric({ avg: 40, min: 32, max: 48, n: 30 }, { avg: 25, min: 16, max: 30, n: 13 });
  assert.equal(c.direction, 'above');
  assert.equal(c.deltaAvgM, 15);
  assert.equal(c.deltaPct, 60);
  assert.equal(c.marginM, 2); // 32 - 30
  assert.deepEqual(c.real, { avg: 25, min: 16, max: 30, n: 13 });
});

test('compareMetric：引擎整体低于真实范围 → below + 正余量（真实最低 − 引擎最高）', () => {
  const c = compareMetric({ avg: 5, min: 4, max: 6, n: 30 }, { avg: 10, min: 8, max: 12, n: 13 });
  assert.equal(c.direction, 'below');
  assert.equal(c.marginM, 2); // 8 - 6
  assert.equal(c.deltaPct, -50);
});

test('compareMetric：区间重叠 → overlap 且不给余量（余量只对不重叠有意义）', () => {
  const c = compareMetric({ avg: 12, min: 9, max: 15, n: 30 }, { avg: 10, min: 8, max: 12, n: 13 });
  assert.equal(c.direction, 'overlap');
  assert.equal(c.marginM, null);
  // 端点相接（引擎 min == 真实 max）也算重叠而非 above——不重叠是严格不等式；余量 0 会误导
  const touch = compareMetric({ avg: 12, min: 12, max: 15, n: 30 }, { avg: 10, min: 8, max: 12, n: 13 });
  assert.equal(touch.direction, 'overlap');
});

test('compareMetric：缺数据返回 null', () => {
  assert.equal(compareMetric(null, { avg: 1, min: 0, max: 2, n: 1 }), null);
  assert.equal(compareMetric({ avg: 1, min: 0, max: 2, n: 1 }, null), null);
});

test('driftVsFrozen：引擎当前 vs 冻结基线的漂移（防恶化只报告）', () => {
  const d = driftVsFrozen({ avg: 44, min: 40, max: 48, n: 30 }, { avg: 40, min: 36, max: 43, n: 30 });
  assert.equal(d.deltaM, 4);
  assert.equal(d.deltaPct, 10);
  assert.equal(d.frozenAvg, 40);
  assert.equal(driftVsFrozen(null, { avg: 40 }), null);
  assert.equal(driftVsFrozen({ avg: 40 }, { avg: 0 }), null);
});

// ── buildComparison：报告结构 ───────────────────────────────────────────

test('buildComparison：逐数据集三项采用指标 + 报告项 + 弹性，数值正确接线', () => {
  const baseline = makeBaseline();
  const cmp = buildComparison(baseline, makeEngineStats({ avg: 40, min: 32, max: 48, n: 30 }));
  assert.equal(cmp.perDataset.length, 2, '两个数据集分别报告');
  const ds = primaryBlock(cmp);
  assert.equal(ds.adopted.length, ADOPTED_METRICS.length);
  assert.equal(ds.reported.length, REPORT_METRICS.length);
  assert.equal(ds.elasticity.length, 2);
  const hd = ds.adopted.find((a) => a.key === 'hd');
  assert.equal(hd.comparison.direction, 'above');
  assert.equal(hd.drift.frozenAvg, 40, '主数据集附冻结漂移');
  // 非主数据集不附冻结漂移（引擎基线是全局的，只在主数据集展示一次）
  const other = cmp.perDataset.find((d) => d.key !== cmp.primaryDataset);
  assert.equal(other.adopted.find((a) => a.key === 'hd').drift, null);
  const width = ds.reported.find((r) => r.key === 'width');
  assert.equal(width.comparison.real.avg, 39);
  assert.equal(width.comparison.direction, 'overlap');
  // 全点口径对照也在（P37 D2）
  assert.ok(hd.allPoints && hd.allPoints.real.avg === 32, '全点口径对照的真实值应上进');
  // 控球代理必须显式标注为代理（spec scenario）
  assert.match(cmp.possessionProxyNote, /代理/);
  assert.match(cmp.possessionProxyNote, /不等于真实持球权/);
});

test('报告期：引擎值远在真实范围之外也不产生失败语义（不抛错、不返回判定）', () => {
  const baseline = makeBaseline();
  const cmp = buildComparison(baseline, makeEngineStats({ avg: 999, min: 900, max: 1000, n: 30 }));
  const text = renderReport(cmp);
  assert.match(text, /高于真实观测范围/);
  assert.match(text, /不产生 pass\/fail/);
  // 报告文本不得出现"合格/通过/失败"类判定词
  assert.doesNotMatch(text, /合格|通过|FAIL|PASS|失败/);
});

test('renderReport：数值、方向、样本量、跨数据集检查都上屏', () => {
  const baseline = makeBaseline();
  const cmp = buildComparison(baseline, makeEngineStats({ avg: 40, min: 32, max: 48, n: 30 }));
  const text = renderReport(cmp);
  assert.match(text, /40\.00 \[32\.00–48\.00\]/); // 引擎分布
  assert.match(text, /25\.00 \[16\.00–30\.00\]/); // 真实观测范围
  assert.match(text, /\+60\.0%/); // 偏离幅度
  assert.match(text, /余量 2\.00m/);
  assert.match(text, /SkillCorner opendata/); // 数据集分别报告
  assert.match(text, /主数据集/);
  assert.match(text, /跨数据集可比性/); // P37 D6：显式检查
  assert.match(text, /Metrica ⊆ SkillCorner/);
  assert.match(text, /代理/); // 控球代理标注
});

// ── loadBaseline：缺失 / 陈旧 / 正常 ────────────────────────────────────

test('loadBaseline：基线缺失 → reason=missing 且提示生成方式', () => {
  const r = loadBaseline(join(tmpdir(), 'p36-no-such-baseline.json'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  assert.match(r.message, /benchmark-baseline\.mjs/);
});

test('loadBaseline：指标模块哈希不匹配 → reason=stale 且提示重生成（陈旧性可检出）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p36-baseline-'));
  const p = join(dir, 'baseline.json');
  writeFileSync(p, JSON.stringify(makeBaseline({ sha256: 'deadbeef'.repeat(8) })));
  const r = loadBaseline(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
  assert.match(r.message, /陈旧/);
  assert.match(r.message, /重生成/);
});

test('loadBaseline：哈希匹配 → ok（正常加载）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p36-baseline-'));
  const p = join(dir, 'baseline.json');
  // 拿当前 viewer/match-metrics.js 的真实哈希写进临时基线 → 应通过
  const realHash = hashMetricsModule();
  writeFileSync(p, JSON.stringify(makeBaseline({ sha256: realHash })));
  const r = loadBaseline(p);
  assert.equal(r.ok, true);
  assert.equal(r.baseline.metricsModule.sha256, realHash);
  // 基线不带哈希（人工构造/老版本）→ 跳过校验、允许加载
  writeFileSync(p, JSON.stringify({ ...makeBaseline(), metricsModule: {} }));
  assert.equal(loadBaseline(p).ok, true);
});

test('loadBaseline：基线损坏/结构缺失 → reason=invalid（跳过而非异常，退出码 0 路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p36-baseline-'));
  const p = join(dir, 'baseline.json');
  // 半截 JSON：JSON.parse 抛错 → 必须被捕获成 invalid，而不是把 verify.sh 打红
  writeFileSync(p, '{ this is not json');
  const r1 = loadBaseline(p);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'invalid');
  assert.match(r1.message, /重生成/);
  // 合法 JSON 但结构缺失（无 real/engine.perMetric）
  writeFileSync(p, JSON.stringify({ kind: 'x' }));
  const r2 = loadBaseline(p);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'invalid');
});

test('main：基线损坏 → 打印跳过提示、退出码 0（不把套件打红）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p36-baseline-'));
  const p = join(dir, 'baseline.json');
  writeFileSync(p, '{ broken');
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    assert.equal(await main({ baselinePath: p }), 0);
  } finally {
    console.log = orig;
  }
  assert.match(logs.join('\n'), /跳过（基线损坏）/);
});

// ── main：基线缺失时跳过而非失败（退出码 0） ───────────────────────────

test('main：基线缺失 → 打印跳过提示、退出码 0（套件不失败，spec scenario）', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    const code = await main({ baselinePath: join(tmpdir(), 'p36-no-such-baseline.json') });
    assert.equal(code, 0);
  } finally {
    console.log = orig;
  }
  const text = logs.join('\n');
  assert.match(text, /跳过/);
  assert.match(text, /基线缺失/);
  assert.match(text, /benchmark-baseline\.mjs/);
});
