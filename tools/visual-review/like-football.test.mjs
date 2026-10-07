// like-football 损失表的守护测试。**纯函数**（不依赖 wasm/真实数据，CI 必跑）。
//
// 本工具存在的理由：飞轮三次「指标变好、画面不变」，根因是①没有离真实的标量、②最大缺口
// （gap 机械分边）不在表里、③阈值与眼睛脱钩。这三个都必须被测试夹死，否则飞轮会再次空转。
import { test } from 'node:test';
import assert from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { lossTable, LOSS_METRICS, SHAPE_KEYS, CAP_LN, shapeFromFrames } = await import('./like-football.mjs');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const bb = await import(join(ROOT, 'tools/benchmark-baseline.mjs'));

// 造一个 profile（形状同 engineProfile/realProfile 的返回）。real 缺省各量 =1，引擎按 override 设。
function prof(realBase = {}, motionBase = {}) {
  const real = { hd: 1, ad: 1, spread: 1, gap: 1, width: 1, ballDist: 1, disp: 1, ...realBase };
  const mot = { disp: 1, dir: 0.7, still: 0, lat: 1, mix: 1, ...motionBase };
  return { shape: Object.fromEntries(SHAPE_KEYS.map(k => [k, real[k]])), motion: mot };
}
const engineWith = (ratioByKey, motion = {}) => {
  const e = prof();
  for (const k of SHAPE_KEYS) if (ratioByKey[k] != null) e.shape[k] = ratioByKey[k];
  Object.assign(e.motion, motion);
  return e;
};

test('loss：完全等于真实 → 距离 0、无缺口', () => {
  const { loss, worst } = lossTable(prof(), prof());   // 引擎=真实，比值全 1
  assert.ok(Math.abs(loss) < 1e-9, `全等真实时距离应为 0，实得 ${loss}`);
  assert.ok(worst.gap < 1e-9, '全等真实时最大缺口应为 0');
});

test('loss：单量 4× → 距离 = ln4/9（对数比，不是线性差）', () => {
  // 9 个幅度量（6 shape + 3 motion）里 1 个 4×、其余 1× → mean|ln| = ln4/9
  const { loss, worst } = lossTable(engineWith({ gap: 4 }), prof());
  assert.ok(Math.abs(loss - Math.log(4) / 9) < 1e-9, `应为 ln4/9，实得 ${loss}`);
  assert.strictEqual(worst.key, 'gap', '最大缺口应是 gap');
});

test('loss：|ln| 对称——0.5× 与 2× 的缺口相同（不奖励过冲）', () => {
  const half = lossTable(engineWith({ gap: 0.5 }), prof()).worst.gap;
  const dbl = lossTable(engineWith({ gap: 2 }), prof()).worst.gap;
  assert.ok(Math.abs(half - dbl) < 1e-9, `0.5× 与 2× 缺口应相等（对称），实得 ${half} vs ${dbl}`);
});

// ── 夹死「飞轮空转」的三种形态 ──────────────────────────────────────────────

test('★ 飞轮守卫：优化一个小量、放任最大量不动 → 距离不许降到「看起来成功」', () => {
  // 复刻 FB4 的真实形态（对基线 skillcorner 锚实测）：disp 从 0.13× 抬到 0.27×（改善），
  // 但 gap（分边）**反而**从 4.42× 恶化到 4.84×、纵深仍 ~2.2×。
  // 关键：距离必须**由最大缺口主导**，不能被那个小改善压到接近 0。
  // （disp 是 motion 量，经第二个参数传；shape 量经第一个参数传。）
  const bad = { hd: 2.19, ad: 2.19, spread: 1.47, gap: 4.42, width: 1.14, ballDist: 1.46 };
  const fb4 = { hd: 2.34, ad: 2.31, spread: 1.59, gap: 4.84, width: 1.23, ballDist: 1.49 };
  const before = lossTable(engineWith(bad, { disp: 0.13 }), prof()).loss;
  const after = lossTable(engineWith(fb4, { disp: 0.27 }), prof()).loss;
  // 改善是真的（距离降了）……
  assert.ok(after < before, 'FB4 的距离应比 main 低（disp 改善是真的）');
  // ……但**距真实仍远**：距离必须 >> 0（最大缺口为主），且 worst 仍是位移或分边这两个大缺口。
  assert.ok(after > 0.5, `距离必须仍显著>0（最大缺口未解决），实得 ${after}——若太小说明被小改善骗了`);
  const w = lossTable(engineWith(fb4, { disp: 0.27 }), prof()).worst;
  assert.ok(['disp', 'gap'].includes(w.key), `最大缺口应是 disp 或 gap，实得 ${w.key}——飞轮必须盯着它们`);
  // 且这条恰好复刻「FB4 把最大缺口从 disp 换成 gap」：改前 worst=disp，改后 worst=gap。
  assert.strictEqual(lossTable(engineWith(bad, { disp: 0.13 }), prof()).worst.key, 'disp', 'main 的最大缺口应是 disp');
  assert.strictEqual(w.key, 'gap', 'FB4 的最大缺口应变成 gap（分边恶化）');
});

test('★ 表里必须有「机械分边」(gap)「动没动」(disp)「铁轨」(lat)「混队」(mix) —— 四个关键量都要在', () => {
  const keys = LOSS_METRICS.map(m => m.key);
  for (const [k, why] of [['gap', '机械分边(两队重心间距)'], ['disp', '动没动(端点位移)'], ['lat', '铁轨(横向占比)'], ['mix', '两队是否混(混队度)']]) {
    assert.ok(keys.includes(k), `${k}（${why}）必须在损失表里`);
  }
  // ⚠️ 本条的**区分度**由外部变异矩阵证明（真删 LOSS_METRICS 里的行 → 本测试红），
  // **不能**用「对 filter 副本断言」的本地反证条冒充——那是恒真式（飞轮 review P2a）。
});

test('★ 损失表**身份唯一**：key 不重复、且 lat/mix 标 motion 口径（防「换行不换数」蒙混）', () => {
  // 第 3 轮审阅 M19：把 lat 行换成 disp 的**重复行**（行数不变）→ 旧断言（只查 key 存在）全绿。
  // 守卫：key 必须两两不同；且 lat/mix 必须 from:'motion'（与 disp 同源口径，误标 shape 即错）。
  const keys = LOSS_METRICS.map(m => m.key);
  assert.strictEqual(new Set(keys).size, keys.length, `LOSS_METRICS 的 key 不得重复（实得 ${keys.join(',')}）`);
  for (const k of ['lat', 'mix']) {
    const row = LOSS_METRICS.find(m => m.key === k);
    assert.strictEqual(row.from, 'motion', `${k} 必须 from:'motion'（运动口径），实得 '${row.from}'`);
  }
});

test('★ 退化引擎（某量为 0）不被静默剔除——记 CAP_LN 罚、进 worst（否则「完全静止」得最低距离）', () => {
  // P2b：旧实现对 `e>0` 为假的行**直接剔除** → 引擎位移为 0（完全静止）时该行消失，
  // 距离被其余 6 行拉低 = **奖励最坏情形**。修复后：0 值按 CAP_LN 罚、排进 worst。
  const dead = engineWith({}, { disp: 0 });        // 引擎位移 = 0（完全静止）
  const { rows, worst, coverage } = lossTable(dead, prof());
  const dispRow = rows.find(r => r.key === 'disp');
  assert.ok(dispRow.gap != null && dispRow.gap >= CAP_LN - 1e-9, `引擎=0 的行必须记 CAP_LN 罚，实得 ${dispRow.gap}`);
  assert.strictEqual(coverage.used, coverage.total, '0 值行**不该**被剔除（coverage 应满）');
  assert.strictEqual(worst.key, 'disp', '完全静止的引擎，最坏缺口必须是 disp（不能被隐藏）');
});

test('★ coverage：两侧都缺的行才剔除，且 coverage 如实下降（防「9 行均值 vs 6 行均值」盲比）', () => {
  // P2c：本地无运动帧时 3 个 motion 行该 n/a、coverage 该 6/9；有帧时 9/9。距离**必须带 coverage 读**。
  const noMotion = { shape: prof().shape, motion: { disp: null, dir: null, still: null, lat: null, mix: null } };
  const t = lossTable(engineWith({}), noMotion);
  assert.strictEqual(t.coverage.used, 6, `无运动帧时覆盖率应为 6，实得 ${t.coverage.used}`);
  assert.strictEqual(t.coverage.total, 9);
  const t2 = lossTable(engineWith({}), prof());
  assert.strictEqual(t2.coverage.used, 9, '有运动帧时应满覆盖 9');
});

test('flag：dir 接近真实判 OK，偏离判不 OK；dispRatio 正确', () => {
  const { flags } = lossTable(engineWith({}, { disp: 3.60, dir: 0.68 }), prof({}, { disp: 13.46, dir: 0.70 }));
  assert.ok(Math.abs(flags.dispRatio - 3.60 / 13.46) < 1e-9, `dispRatio 应为 disp/realDisp，实得 ${flags.dispRatio}`);
});

test('★ P3：`shapeFromFrames` 与基线**同一聚合**——合成帧过两条路，结果必须逐位相等', () => {
  // 本工具的全部可比性建立在「引擎/真实用与基线同一聚合方法」这一主张上（无守卫=空口）。
  // 这里用**合成 tracking 帧**（不依赖 wasm/真实数据，CI 必跑）同时喂两条路：
  //   路 A（本工具）：fromTrackingFrame → shapeFromFrames
  //   路 B（基线）：realGameWindows → summarizeWindowMetrics(...).<k>.avg
  // 两条都纯函数、同输入 → 必须逐位相等。**定向反证**见下一条。
  // 造 600s 的合成场（覆盖完整 300s 窗），22 人 + 球。
  const rawFrames = Array.from({ length: 7505 }, (_, i) => ({
    t: i * 0.2,
    players: Array.from({ length: 22 }, (_, k) => [0.1 + (k % 11) * 0.07 + 0.02 * Math.sin(i * 0.1 + k), 0.15 + Math.floor(k / 11) * 0.5 + 0.01 * Math.sin(i * 0.07 + k)]),
    ball: [0.5, 0.5],
  }));
  const unified = rawFrames.map(f => mm.fromTrackingFrame(f));
  const mine = shapeFromFrames(unified);
  const base = bb.realGameWindows({ frames: rawFrames, meta: { keyframeHz: 5 } }, 'synthetic');
  const sum = mm.summarizeWindowMetrics(base.metrics);
  assert.ok(base.metrics.length >= 2, `合成场应切出 ≥2 个 300s 窗，实得 ${base.metrics.length}`);
  for (const k of SHAPE_KEYS) {
    assert.ok(Math.abs(mine[k] - sum[k].avg) < 1e-9, `${k}: 本工具 ${mine[k]} vs 基线 ${sum[k].avg}——两条路不同聚合（可比性主张破了）`);
  }
});

test('反证条：破坏聚合（窗口改成 100s）→ 上一条的相等必红', () => {
  // 证明「同一聚合」断言有区分度：把 shapeFromFrames 用的切窗尺寸换掉就会不等。
  // 关键：合成场的**纵深跨度必须随时间变**（此处队形绕中心周期性收放）。
  // 线性平移不改 q10–q90 跨度 → 任何窗尺寸都算出同一 hd → 反证条空转（踩过）。
  const rawFrames = Array.from({ length: 7505 }, (_, i) => ({
    t: i * 0.2,
    players: Array.from({ length: 22 }, (_, k) => [0.5 + (0.1 + (k % 11) * 0.07 - 0.5) * (1 + 0.4 * Math.sin(i * 0.002)), 0.15 + Math.floor(k / 11) * 0.5]),
    ball: [0.5, 0.5],
  }));
  const unified = rawFrames.map(f => mm.fromTrackingFrame(f));
  // 用 100s 窗自算（错误口径）→ 与基线 300s 窗的 hd 必然不等（除非巧合，此处场形随窗变化）。
  const wrong = {};
  const wins100 = mm.cutWindows(unified, { sizeSec: 100, stepSec: 900 });
  const acc = [];
  for (const w of wins100) { const p = mm.windowMetrics(w).primary; if (p) acc.push(p.hd); }
  wrong.hd = acc.reduce((a, b) => a + b, 0) / acc.length;
  const sum = mm.summarizeWindowMetrics(bb.realGameWindows({ frames: rawFrames, meta: { keyframeHz: 5 } }, 'synthetic').metrics);
  assert.ok(Math.abs(wrong.hd - sum.hd.avg) > 1e-6, '不同窗尺寸应产出不同 hd（证明相等断言有区分度）');
});
