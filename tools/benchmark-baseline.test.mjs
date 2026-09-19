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
import { hashMetricsModule, realGameWindows, converterFingerprints, engineFingerprints } from './benchmark-baseline.mjs';

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

test('基线：多数据集结构、样本量、来源、每窗记录齐全（P37 D6）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  assert.equal(b.schemaVersion, 2);
  // 两个数据集都在（D6：分别报告，不合并）
  assert.ok(b.datasets.metrica && b.datasets.skillcorner, 'Metrica 与 SkillCorner 应分别报告');
  assert.ok(b.primaryDataset, '必须声明主数据集');
  assert.equal(b.primaryDataset, 'skillcorner', 'P37 起 SkillCorner 为主（样本量决定）');
  // 样本量：13 + 139 = 152 窗
  assert.equal(b.datasets.metrica.nGames, 2);
  assert.equal(b.datasets.metrica.nWindows, 13);
  assert.equal(b.datasets.skillcorner.nGames, 20);
  assert.equal(b.datasets.skillcorner.nWindows, 139, '20 场 900s 步长应为 139 窗');
  assert.equal(b.windows.engine.nWindows, 30);
  assert.deepEqual(b.windows.engine.seeds, [42, 1, 7, 99, 123]);
  // 每个数据集都要有来源、许可、采集方式（spec 的第一个 requirement）
  for (const [key, ds] of Object.entries(b.datasets)) {
    assert.ok(ds.source, `${key} 要有来源`);
    assert.ok(ds.license, `${key} 要有许可`);
    assert.ok(ds.collection, `${key} 要有采集方式`);
    assert.ok(ds.nGames > 0 && ds.nWindows > 0);
    // 每窗记录：frameCount 与主口径有效帧数（可审计）
    for (const g of ds.games) {
      assert.ok(g.meta.source, `${key}/${g.game} 要有来源`);
      assert.ok(g.windows.length >= 6, `${key}/${g.game} 的窗口记录`);
      for (const w of g.windows) {
        assert.ok(w.frameCount > 0, '每窗要有实际帧数');
        assert.ok(w.nominalSec === 300, '名义跨度应为 300s（不是 frameCount/hz）');
        assert.ok(Number.isFinite(w.okPrimary), '每窗要记主口径有效帧数');
      }
    }
    // 逐场 status 记录（审阅 P3-4：不按 status 过滤须显式声明）
    assert.ok(ds.games.every((g) => 'status' in g), `${key} 逐场应有 status 字段`);
  }
  // not_started 的场次如实记录（1953632）
  const ns = b.datasets.skillcorner.games.find((g) => g.status === 'not_started');
  assert.ok(ns, 'not_started 的场次应如实记录（不静默纳入也不静默排除）');
});

test('基线：未覆盖维度声明、口径声明齐备', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  assert.ok(b.declarations.rangeMeaning.includes('不是'),
    'rangeMeaning 必须声明这不是"真实足球的分布"');
  assert.ok(Array.isArray(b.declarations.notCovered) && b.declarations.notCovered.length >= 3);
  assert.ok(b.declarations.notCovered.join().includes('联赛'), '未覆盖维度应含联赛');
  assert.ok(b.declarations.controlProxy.includes('代理'));
  // P37 新增声明（审阅要求）
  assert.ok(Array.isArray(b.declarations.rangeWidthMechanisms)
    && b.declarations.rangeWidthMechanisms.length >= 3,
  'D5 的三条变宽机制都要声明（不能只归因"样本增加"）');
  assert.ok(b.declarations.crossValidation.includes('报告项'),
    'D7：交叉验证须声明为报告项、不是门');
  assert.ok(b.declarations.pitchSize.includes('逐场'), 'D4：逐场尺寸须声明');
  assert.ok(Array.isArray(b.regenerate.steps) && b.regenerate.steps.length >= 4,
    '重生成链路必须写全（fetch → convert → 基线生成）');
});

test('基线：数值在球场量级内、区间有序、均值在区间内', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  for (const [key, ds] of Object.entries(b.datasets)) {
    for (const mode of ['perMetric', 'perMetricAllPoints']) {
      for (const [k, s] of Object.entries(ds[mode])) {
        if (!s || !s.n) continue;
        assert.ok(Number.isFinite(s.avg) && Number.isFinite(s.min) && Number.isFinite(s.max), `${key}.${mode}.${k} 数值`);
        assert.ok(s.min <= s.avg && s.avg <= s.max, `${key}.${mode}.${k} 均值应落在区间内`);
        if (['hd', 'ad', 'spread', 'gap'].includes(k)) {
          assert.ok(s.max < 105, `${key}.${mode}.${k} 不应超过场长（实际 ${s.max}）`);
        }
      }
      if (ds[mode].width && ds[mode].width.n) assert.ok(ds[mode].width.max <= 68 + 1e-9, `${key}.${mode}.width 不应超过场宽`);
    }
  }
  for (const [k, s] of Object.entries(b.engine.perMetric)) {
    if (!s) continue;
    assert.ok(s.min <= s.avg && s.avg <= s.max, `engine.${k} 均值应在区间内`);
  }
  // D3 结论哨兵（显式 tripwire）：主数据集三项采用指标的分离结论——引擎 min 高于真实 max。
  // 若未来校准 change 合理地缩小了差距，重生成基线时本断言会红——这是**有意的**：
  // 结论变了就必须显式更新 design D3 与本断言，不许静默漂移（同 golden master 的重基线纪律）。
  const primary = b.datasets[b.primaryDataset];
  for (const k of ['hd', 'spread', 'gap']) {
    assert.ok(b.engine.perMetric[k].min > primary.perMetric[k].max,
      `${k} 的分离结论已变（D3）——校准落地时连同 design D3 与本断言一起更新`);
  }
});

test('基线：外推双口径并列，且全点口径确实更大（P37 D2 的影响可读）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  const sc = b.datasets.skillcorner;
  assert.ok(sc.perMetric && sc.perMetricAllPoints, '两个口径都要有');
  // 全点口径采信外推 → 纵深应 ≥ 主口径（反证：若两口径相同，说明外推标记没生效）
  assert.ok(sc.perMetricAllPoints.hd.avg > sc.perMetric.hd.avg,
    'SkillCorner 全点口径的纵深应大于主口径（否则外推过滤没生效）');
  // Metrica 无外推标记 → 两口径应完全相同（口径只对带标记的源数据起作用）
  const m = b.datasets.metrica;
  assert.equal(m.perMetric.hd.avg, m.perMetricAllPoints.hd.avg,
    'Metrica 无外推标记，两口径应相同');
});

test('基线：弹性两种口径都记录（口径敏感性披露）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  const b = load();
  for (const ds of Object.values(b.datasets)) {
    assert.ok(ds.elasticity.half && ds.elasticity.centroid, '两种分桶都要有');
  }
  assert.ok(b.engine.elasticity.half && b.engine.elasticity.centroid);
});

test('基线生成按逐场尺寸换算【反证条】（审阅发现的未守护路径）', () => {
  // 反证：若 realGameWindows 丢弃 meta.pitchMeters（退回硬编码 105），104m 与 105m 的
  // 米制纵深会**相同** → 这条红。用合成数据（不依赖 gitignored 的真实帧序列）。
  const mk = (pm) => {
    const frames = [];
    for (let i = 0; i < 1510; i += 1) {
      const players = new Array(22).fill(null);
      players[0] = [0.05, 0.5];
      for (let j = 1; j <= 10; j += 1) players[j] = [0.2 + j * 0.02, 0.5];
      players[21] = [0.95, 0.5];
      for (let j = 11; j <= 20; j += 1) players[j] = [0.6 + j * 0.01, 0.5];
      frames.push({ t: i * 0.2, players, ball: [0.5, 0.5] });
    }
    return { meta: { keyframeHz: 5, source: 'synthetic', pitchMeters: pm ? { length: pm[0], width: pm[1] } : undefined }, frames };
  };
  const a = realGameWindows(mk([105, 68]), 'a');
  const b = realGameWindows(mk([104, 68]), 'b');
  assert.deepEqual(a.pitchMeters, [105, 68]);
  assert.deepEqual(b.pitchMeters, [104, 68], '逐场尺寸须记入基线');
  const ratio = a.metrics[0].hd / b.metrics[0].hd;
  assert.ok(Math.abs(ratio - 105 / 104) < 1e-9,
    `105m/104m 纵深比应恰为 105/104（实际 ${ratio}）——不等说明没按逐场尺寸换算`);
});

test('基线：转换器输入指纹与当前实现一致（审阅 P3-3 的陈旧性哨兵）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  // 转换器是基线的直接输入（改拼接/朝向/身份 → 基线数字变），但基线原先只 pin 指标模块。
  // 这条哨兵让"只改转换器不重生成基线"能被检出——与指标模块的 sha256 哨兵同一纪律。
  const b = load();
  assert.ok(b.metricsModule.converters, '基线须记录转换器指纹');
  const current = converterFingerprints();
  // **两侧都比**（审阅复审 P3-②）：只遍历 current 的键，则「转换器被改名/删除」不会告警
  // （current 少一个键、基线多一个键，循环仍绿）。故先断言键集相同，再逐键比哈希。
  assert.deepEqual(
    Object.keys(b.metricsModule.converters).sort(),
    Object.keys(current).sort(),
    '基线记录的转换器集合应恰为当前全部转换器（改名/删除也会被这条抓到）',
  );
  for (const [file, hash] of Object.entries(current)) {
    assert.equal(b.metricsModule.converters[file], hash,
      `${file} 已变更而基线未重生成 —— 跑 node tools/benchmark-baseline.mjs`);
  }
});

test('基线：引擎源码指纹与当前一致（P38 #87 的 wasm 来源哨兵）', { skip: !HAVE_BASELINE && SKIP_REASON }, async () => {
  // **为什么加这条**：P37 的基线曾用**未合入分支**（demo/off-ball-movement）构建的 wasm 生成——
  // 引擎侧 gap 偏 +55.8%、宽度偏 +25.9%，而这些错误数字进了 README。当时**没有任何哨兵**
  // 能发现：指标模块哈希只管指标口径、转换器哈希只管真实侧，两者都管不到"wasm 从哪来"。
  //
  // **判据是行为，不是文本**（P38 #87 的第二次修正）：只比源码哈希会**对注释过敏**——
  // 改一行注释就要重下 1.8GB 数据才能消红（实测：`adc3b4d` 纯注释改动就把这条打红了，
  // 而那还是 main 上的正常提交）。故：
  //   源码哈希一致          → 通过（快路径）
  //   源码哈希不一致        → **重算引擎侧指标**与基线比对：
  //       指标一致（±容差）  → 放行（仅注释/重构），提示下次重生成刷新指纹
  //       指标不一致        → **硬失败**，要求重生成基线
  // 重算只需要 wasm（CI 本来就构建），不碰真实数据——所以这条判据在 CI 上廉价且可靠。
  const b = load();
  assert.ok(b.engineFingerprint, '基线须记录引擎指纹（P38 #87）');
  assert.equal(typeof b.engineFingerprint.sourceSha256, 'string',
    '基线须记录 engine/src/lib.rs 的哈希');

  const cur = engineFingerprints(
    join(ROOT, 'viewer', 'engine.wasm'),
    join(ROOT, 'engine', 'src', 'lib.rs'),
  );
  if (b.engineFingerprint.sourceSha256 === cur.sourceSha256) return; // 快路径：源码未变

  // 源码变了——判断**行为**是否也变了。缺 wasm 时无法判断，保守失败并说明。
  const wasmPath = join(ROOT, 'viewer', 'engine.wasm');
  if (!existsSync(wasmPath)) {
    assert.fail('engine/src/lib.rs 已变更，但缺少 viewer/engine.wasm 无法判定行为是否也变 —— '
      + '先构建 wasm 再跑，或重生成基线：node tools/benchmark-baseline.mjs');
  }
  const { loadEngineWasm, sampleEngineStats } = await import('./benchmark-engine.mjs');
  const loaded = await loadEngineWasm(wasmPath);
  if (!loaded.ok) assert.fail(`加载 engine.wasm 失败：${loaded.message}`);
  const fresh = await sampleEngineStats({ wasm: loaded.wasm });

  // 逐指标比均值（基线记录的是 30 窗摘要的 avg）。容差取 1e-6 —— 引擎是确定性的，
  // 行为没变就应当**逐位相同**；给极小容差只为容忍浮点求和顺序差异。
  const KEYS = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist'];
  const drift = [];
  for (const k of KEYS) {
    const was = b.engine.perMetric[k] && b.engine.perMetric[k].avg;
    const now = fresh.perMetric[k] && fresh.perMetric[k].avg;
    if (was == null || now == null) continue;
    if (Math.abs(was - now) > 1e-6) drift.push(`${k}: 基线 ${was.toFixed(4)} → 现 ${now.toFixed(4)}`);
  }
  if (drift.length === 0) {
    // 行为没变 —— 放行，但留在输出里（提示刷新指纹，免得每次 CI 都走这条慢路径）
    console.log('注：engine/src/lib.rs 已变更但引擎指标逐位一致（仅注释/重构）。'
      + '\n    建议下次重生成基线以刷新指纹：node tools/benchmark-baseline.mjs');
    return;
  }
  assert.fail(`引擎行为已变而基线未重生成 —— 跑 node tools/benchmark-baseline.mjs\n`
    + `  漂移：${drift.join('；')}`);
});

test('基线：时间缺口声明与逐场实测一致（审阅复审 P3-③ 的守护）', { skip: !HAVE_BASELINE && SKIP_REASON }, () => {
  // timeGaps 声明是**动态计算**的（timeGapDeclaration），但此前无测试守护——硬编码回
  // 旧文案也不会红。这里从逐场实测独立复算，与声明里的数字比对。
  const b = load();
  const ds = b.datasets[b.primaryDataset];
  const gaps = ds.games.map((g) => g.meta.timeGaps).filter(Boolean);
  const totalGap = gaps.reduce((a, g) => a + (g.totalSec || 0), 0);
  const seam = ds.games.reduce((a, g) => a + ((g.meta.timeAxis && g.meta.timeAxis.seamGapSec) || 0), 0);
  const span = ds.games.reduce((a, g) => a + (g.meta.endSec || 0), 0);
  const pct = (100 * totalGap / span).toFixed(1);
  // 声明里必须出现实测的总时长与占比（数字来自实测，不是写死的）
  assert.match(b.declarations.timeGaps, new RegExp(`${totalGap.toFixed(0)}s`),
    '声明应含实测的无观测总时长');
  assert.match(b.declarations.timeGaps, new RegExp(`${pct}%`), '声明应含实测占比');
  assert.match(b.declarations.timeGaps, /接缝/, '声明应给出接缝间隙的归因');
  assert.match(b.declarations.timeGaps, new RegExp(`${seam.toFixed(1)}s`), '声明应含实测接缝合计');
  // 反证：若把声明硬编码回"接缝贡献 0"，上面 seam 的断言会红（seam 实测 > 0）
  assert.ok(seam > 0, 'SkillCorner 20 场接缝合计应 > 0（否则测不出"接缝贡献 0"的回归）');
});
