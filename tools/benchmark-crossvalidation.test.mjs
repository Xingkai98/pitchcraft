// P37 交叉验证单测：half-split 与 LOO 的**报告数字**正确、分半可复现（种子冻结）、
// 「容纳」与「不容纳」两组输入如实反映。
//
// ⚠️ 本工具是**报告项**（无绿/红），故断言的是**数字**而非判定——
// 这正是 spec「先落报告项」requirement 的守护（若有人把它改成布尔门，本测试会红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLIT_SEED, CV_METRICS, mulberry32, shuffle, rangeOf, halfSplit, leaveOneGameOut,
  recordsFromBaseline, computeCrossValidation,
} from './benchmark-crossvalidation.mjs';

// 构造 records：{game, metric, value}。
function recs(spec) {
  // spec: { game: {metric: [values]} }
  const out = [];
  for (const [game, byMetric] of Object.entries(spec)) {
    for (const [metric, values] of Object.entries(byMetric)) {
      values.forEach((value, i) => out.push({ game, window: i, metric, value }));
    }
  }
  return out;
}

// ── 基础工具 ────────────────────────────────────────────────────────────

test('分半可复现：同一 seed → 同一分法（种子冻结的立身之本）', () => {
  const games = Array.from({ length: 20 }, (_, i) => `g${i}`);
  const a = shuffle(games, mulberry32(SPLIT_SEED));
  const b = shuffle(games, mulberry32(SPLIT_SEED));
  assert.deepEqual(a, b, '同种子必须给出同一洗牌');
  // 不同种子给出不同（几乎必然）
  const c = shuffle(games, mulberry32(SPLIT_SEED + 1));
  assert.notDeepEqual(a, c);
});

test('halfSplit 真的用了冻结种子【反证】：两次调用给同一分半，改 seed 则不同', () => {
  // 反证条：若 halfSplit 内部忽略 seed（如用 Math.random 或写死另一颗种子），
  // 第一次断言会红——没有它，"种子冻结"就只是注释里的承诺。
  const spec = {};
  for (let g = 0; g < 20; g += 1) spec[`g${g}`] = { hd: [10 + g] };
  const r1 = halfSplit(recs(spec));
  const r2 = halfSplit(recs(spec));
  assert.deepEqual(r1.halfA, r2.halfA, '同种子两次调用必须同分半');
  assert.equal(r1.seed, SPLIT_SEED, '报告里必须记录冻结种子');
  // 换种子 → 分半必须变（否则说明 seed 根本没进 RNG）
  const r3 = halfSplit(recs(spec), { seed: SPLIT_SEED + 1 });
  assert.notDeepEqual(r1.halfA, r3.halfA, '换种子应换分半');
});

test('rangeOf：空输入 null，否则 min/max/n', () => {
  assert.equal(rangeOf([]), null);
  assert.deepEqual(rangeOf([3, 1, 2]), { min: 1, max: 3, n: 3 });
});

// ── half-split：容纳 vs 不容纳 ──────────────────────────────────────────

test('half-split：范围容纳另一半 → 落空 0（报告如实反映）', () => {
  // 构造：A 半的场值域宽、B 半窄且落在其中（用 2 场对 2 场，seed 会决定谁在哪半）。
  // 用极值构造：所有场共享 hd 值域 [10,20]，B 半必然被容纳。
  const spec = {};
  for (let g = 0; g < 20; g += 1) spec[`g${g}`] = { hd: [10, 15, 20] };
  const r = halfSplit(recs(spec), { metrics: ['hd'] });
  const v = r.perMetric.hd;
  assert.ok(v.aContainsB, '全部同值域 → A 必容纳 B');
  assert.ok(v.bContainsA, '反向也容纳');
  assert.equal(v.bOutsideA, 0);
  assert.equal(v.aOutsideB, 0);
});

test('half-split：范围不容纳 → 落空数 > 0（反证：不是恒绿的空转断言）', () => {
  // 构造一个**离群场**（值甩到 1000，其余都在 10–20）。无论分半把它放在哪边，
  // 它所在那半的范围都会撑大、而它自己落在另一半范围之外 → **至少一个方向不容纳**。
  // （不押注具体分法：随机分半可能把两簇合并，故用"至少一个方向"而非"两个方向都"。）
  const spec = {};
  for (let g = 0; g < 19; g += 1) spec[`g${g}`] = { hd: [10, 15, 20] };
  spec.outlier = { hd: [1000, 1005, 1010] };
  const r = halfSplit(recs(spec), { metrics: ['hd'] });
  const v = r.perMetric.hd;
  // 离群场必落在某一半：若在 A，则 A 的值落空于 B（aOutsideB>0）；若在 B，则 bOutsideA>0。
  assert.ok(v.aOutsideB > 0 || v.bOutsideA > 0, '有离群场时至少一个方向必须落空');
  assert.ok(!(v.aContainsB && v.bContainsA), '不应两个方向都"容纳"（那说明离群场被忽略了）');
  const totalOutside = v.aOutsideB + v.bOutsideA;
  assert.ok(totalOutside >= 3, `离群场的窗口应全部落空（实际落空 ${totalOutside}）`);
});

test('half-split：落空数与独立算出的期望一致【差分，反证恒零变异】', () => {
  // 差分测试：在测试里**独立**算一遍「B 有多少窗口落在 A 范围外」，与工具输出比对。
  // 若实现把落空数写死（如 bOutsideA = 0），这里会红——「报告数字正确」的直接守护。
  //
  // 构造用 **2 场**（分半后每半恰好 1 场，与 seed 无关）且两簇完全分离：
  // 两个方向的落空都**必然非零**，故对任一方向的恒零变异都有区分度。
  const spec = { lo: { hd: [0, 5, 10] }, hi: { hd: [100, 105, 110] } };
  const records = recs(spec);
  const r = halfSplit(records, { metrics: ['hd'] });
  const v = r.perMetric.hd;
  assert.equal(r.halfA.length, 1, '2 场 → 每半 1 场');
  // 独立复算
  const aVals = records.filter((x) => r.halfA.includes(x.game)).map((x) => x.value);
  const bVals = records.filter((x) => !r.halfA.includes(x.game)).map((x) => x.value);
  const expectBOutsideA = bVals.filter((x) => x < Math.min(...aVals) || x > Math.max(...aVals)).length;
  const expectAOutsideB = aVals.filter((x) => x < Math.min(...bVals) || x > Math.max(...bVals)).length;
  assert.equal(v.bOutsideA, expectBOutsideA, 'B 落空 A 的计数应与独立复算一致');
  assert.equal(v.aOutsideB, expectAOutsideB, 'A 落空 B 的计数应与独立复算一致');
  assert.equal(v.bOutsideA, 3);
  assert.equal(v.aOutsideB, 3);
});

test('half-split：分半按**场次**而非窗口（窗口不独立，独立样本是场次）', () => {
  // 一场的多个窗口必须同属半边——构造一场 3 个窗口，看它是否整体在某半。
  const spec = { g0: { hd: [1, 2, 3] }, g1: { hd: [4, 5, 6] } };
  const r = halfSplit(recs(spec), { metrics: ['hd'] });
  // 2 场分半 → 各 1 场；A 的窗口数应 = 3（该场的全部窗口），不是按窗口打散
  const total = r.perMetric.hd.nA + r.perMetric.hd.nB;
  assert.equal(total, 6, '窗口总数守恒');
  assert.ok([r.perMetric.hd.nA, r.perMetric.hd.nB].every((n) => n === 3), '每半场次含一整场的窗口');
});

// ── LOO ─────────────────────────────────────────────────────────────────

test('LOO：异类场不被其余场容纳，且能被定位', () => {
  const spec = {};
  for (let g = 0; g < 19; g += 1) spec[`g${g}`] = { hd: [10, 15, 20] };
  spec.outlier = { hd: [100, 105, 110] }; // 一场离群
  const r = leaveOneGameOut(recs(spec), { metrics: ['hd'] });
  const s = r.perMetricSummary.hd;
  assert.equal(s.gamesTotal, 20);
  assert.equal(s.gamesFailing, 1, '恰好 1 场落空（那个异类）');
  const outEntry = r.perGame.find((g) => g.game === 'outlier');
  assert.equal(outEntry.perMetric.hd.contained, false, '异类场应被标记为不被容纳');
  assert.equal(outEntry.perMetric.hd.outside, 3, '它的 3 个窗口全落空');
  // 反证：非异类场都应被容纳
  const good = r.perGame.find((g) => g.game === 'g0');
  assert.equal(good.perMetric.hd.contained, true);
});

test('LOO：正常数据（全部同值域）→ 全部被容纳（不是恒红）', () => {
  const spec = {};
  for (let g = 0; g < 20; g += 1) spec[`g${g}`] = { hd: [10, 15, 20], spread: [5, 8, 11] };
  const r = leaveOneGameOut(recs(spec), { metrics: ['hd', 'spread'] });
  assert.equal(r.perMetricSummary.hd.gamesFailing, 0);
  assert.equal(r.perMetricSummary.spread.gamesFailing, 0);
});

// ── 报告项语义守护（防止被改成布尔门） ──────────────────────────────────

test('报告项语义：输出是数字结构，不是布尔判定（spec 要求）', () => {
  const spec = {};
  for (let g = 0; g < 20; g += 1) spec[`g${g}`] = { hd: [10 + g, 15 + g, 20 + g] };
  const r = halfSplit(recs(spec), { metrics: ['hd'] });
  const v = r.perMetric.hd;
  // 必须给出数字（落空数、比例），而不只是 true/false
  assert.equal(typeof v.bOutsideA, 'number');
  assert.equal(typeof v.bOutsideAPct, 'number');
  assert.equal(typeof v.aRange[0], 'number');
  // 布尔字段只是**派生**的便捷位，数字才是主体
  assert.equal(typeof v.aContainsB, 'boolean');
  // 工具不得返回「通过/失败」这类判定字段
  assert.ok(!('pass' in v) && !('fail' in v) && !('ok' in v), '报告项不应有 pass/fail 字段');
});

test('CV_METRICS：采用三项与 benchmark-compare 一致（口径同源）', () => {
  assert.deepEqual(CV_METRICS.map(([k]) => k), ['hd', 'spread', 'gap']);
});

// ── 基线消费 ────────────────────────────────────────────────────────────

test('recordsFromBaseline：缺逐窗指标 → 返回 null（调用方跳过而非崩）', () => {
  assert.equal(recordsFromBaseline({ datasets: { x: { games: [{ game: 'g', windows: [{ startSec: 0 }] }] } } }, 'x'), null);
  assert.equal(recordsFromBaseline({ datasets: {} }, 'x'), null);
});

test('recordsFromBaseline：有逐窗指标 → 提取 {game, metric, value}', () => {
  const baseline = {
    datasets: {
      x: {
        games: [
          { game: 'a', windows: [{ windowMetrics: { hd: 1, spread: 2, gap: 3 } }, { windowMetrics: null }] },
        ],
      },
    },
  };
  const r = recordsFromBaseline(baseline, 'x');
  assert.ok(Array.isArray(r));
  // 2 个窗，第 2 个 metric 为 null 跳过 → 3 条记录（hd/spread/gap 各 1）
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.metric).sort(), ['gap', 'hd', 'spread']);
});

test('recordsFromBaseline：结构异常一律按"无数据"返回 null（不抛异常，审阅 P3-1）', () => {
  // 各种结构畸形：windows 不是数组 / 是数字数组 / game 缺失 / 全部窗口无指标
  const cases = [
    { datasets: { x: { games: [{ game: 'a', windows: 5 }] } } },
    { datasets: { x: { games: [{ game: 'a', windows: [1, 2, 3] }] } } },
    { datasets: { x: { games: [{ windows: [{ windowMetrics: { hd: 1 } }] }] } } },
    { datasets: { x: { games: [{ game: 'a', windows: [{ windowMetrics: { hd: null } }] }] } } },
    { datasets: { x: { games: 'not-an-array' } } },
  ];
  for (const b of cases) {
    assert.doesNotThrow(() => recordsFromBaseline(b, 'x'));
    assert.equal(recordsFromBaseline(b, 'x'), null, `应返回 null：${JSON.stringify(b).slice(0, 60)}`);
  }
});

test('computeCrossValidation：对合成 records 给出完整报告结构（不依赖文件）', () => {
  const spec = {};
  for (let g = 0; g < 20; g += 1) spec[`g${g}`] = { hd: [10 + g, 15 + g] };
  const cv = computeCrossValidation(recs(spec));
  assert.ok(cv.halfSplit && cv.loo);
  assert.equal(cv.halfSplit.seed, SPLIT_SEED);
  assert.ok(cv.loo.perMetricSummary.hd);
  assert.equal(cv.loo.perMetricSummary.hd.gamesTotal, 20);
});
