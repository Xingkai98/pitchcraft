// P36 入库基线的哨兵测试（spec「基线标注样本量与边界」+「基线陈旧性可检出」）。
//
// 只读 viewer/data/benchmark-baseline.json（轻量、不跑引擎、不依赖真实原始数据）：
//   - 结构：样本量 / 来源 / 每窗时长 / 残窗记录 / 未覆盖维度声明
//   - 陈旧性：metricsModule.sha256 必须与当前 viewer/match-metrics.js 一致
//     （不一致 = 有人改了指标却没重生成基线；对比工具运行时会拒绝，这里是提前红）
//   - 数值合理性：真实/引擎摘要落在球场量级内、区间有序
//
// 这份入库文件被误改、生成逻辑回归、文档引用漂移时，这里先响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashMetricsModule } from './benchmark-baseline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'viewer', 'data', 'benchmark-baseline.json');
const HAVE_BASELINE = existsSync(BASELINE_PATH);
const SKIP_REASON = '缺少 viewer/data/benchmark-baseline.json —— 生成：node tools/benchmark-baseline.mjs'
  + '（需先 fetch/convert 真实数据 + 构建 engine.wasm，见脚本头部注释）';

const load = () => JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

test('基线：指标模块哈希与当前实现一致（陈旧性哨兵）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  assert.equal(b.metricsModule.sha256, hashMetricsModule(),
    'viewer/match-metrics.js 已变更而基线未重生成 —— 跑 node tools/benchmark-baseline.mjs');
});

test('基线：样本量、来源、每窗时长、残窗记录齐全', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  assert.equal(b.windows.real.nGames, 2);
  assert.equal(b.windows.real.nWindows, 13); // 7 + 6 满窗
  assert.equal(b.windows.engine.nWindows, 30);
  assert.deepEqual(b.windows.engine.seeds, [42, 1, 7, 99, 123]);
  assert.equal(b.windows.engine.durationSec, 5400);
  for (const g of b.windows.real.perGame) {
    assert.ok(g.meta.source, '每场要有数据来源');
    assert.ok(g.windows.length >= 6, `${g.game} 的窗口记录`);
    for (const w of g.windows) assert.ok(w.durationSec > 0 && w.frameCount > 0);
  }
  // game2 尾部 246s 残窗如实记录（design 要求）
  const g2 = b.windows.real.perGame.find((g) => /2$/.test(g.game));
  assert.ok(g2.discardedPartialWindow, 'game2 残窗应被记录');
  assert.ok(Math.abs(g2.discardedPartialWindow.durationSec - 246) < 3,
    `残窗时长 ≈246s（实际 ${g2.discardedPartialWindow.durationSec}）`);
});

test('基线：未覆盖维度声明与控球代理标注在文件内', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  assert.ok(b.declarations.rangeMeaning.includes('不是'),
    'rangeMeaning 必须声明这不是"真实足球的分布"');
  assert.ok(Array.isArray(b.declarations.notCovered) && b.declarations.notCovered.length >= 3);
  assert.ok(b.declarations.notCovered.join().includes('联赛'), '未覆盖维度应含联赛');
  assert.ok(b.declarations.controlProxy.includes('代理'));
  assert.ok(Array.isArray(b.regenerate.steps) && b.regenerate.steps.length >= 4,
    '重生成链路必须写全（fetch → convert → 基线生成）');
});

test('基线：数值在球场量级内、区间有序、均值在区间内', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  for (const side of ['real', 'engine']) {
    for (const [k, s] of Object.entries(b[side].perMetric)) {
      if (!s) continue;
      assert.ok(Number.isFinite(s.avg) && Number.isFinite(s.min) && Number.isFinite(s.max), `${side}.${k} 数值`);
      assert.ok(s.min <= s.avg && s.avg <= s.max, `${side}.${k} 均值应落在区间内`);
      assert.ok(s.n > 0, `${side}.${k} 样本量`);
      if (['hd', 'ad', 'spread', 'gap'].includes(k)) {
        assert.ok(s.max < 105, `${side}.${k} 不应超过场长（实际 ${s.max}）`);
      }
    }
    const w = b[side].perMetric.width;
    assert.ok(w.max <= 68 + 1e-9, `${side}.width 不应超过场宽`);
  }
  // D3 结论哨兵（显式 tripwire）：三项采用指标的分离结论——引擎 min 高于真实 max。
  // 若未来校准 change 合理地缩小了差距，重生成基线时本断言会红——这是**有意的**：
  // 结论变了就必须显式更新 design D3 与本断言，不许静默漂移（同 golden master 的重基线纪律）。
  for (const k of ['hd', 'spread', 'gap']) {
    assert.ok(b.engine.perMetric[k].min > b.real.perMetric[k].max,
      `${k} 的分离结论已变（D3）——校准落地时连同 design D3 与本断言一起更新`);
  }
});

test('基线：弹性两种口径都记录（口径敏感性披露）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  for (const side of ['real', 'engine']) {
    assert.ok(b[side].elasticity.half && b[side].elasticity.centroid, `${side} 两种分桶都要有`);
    assert.ok(b[side].elasticity.half.n > 0);
  }
});
