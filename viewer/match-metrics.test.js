// 比赛标尺单测：指标纯函数的已知输入→已知输出、边界、空输入，以及口径守护测试。
//
// 口径守护是本 change 的重点（spec「指标口径固定且显式」）：每一条口径一个测试。
// 这些口径极易在某次重构里悄悄失效——数字只会缓慢漂移，没人会肉眼发现。尤其是
// 「剔除门将」与「trim1 两侧对称」，必须用构造输入断言，而不是靠盯着真实数据比对。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, SAMPLE_INTERVAL_SEC, MIN_OUTFIELD_PLAYERS,
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  fromTrackingFrame, isRawBallFrame, sampleEngineFrames, cutWindows,
  teamShape, possessionProxy, frameMetrics, windowMetrics, elasticity,
  summarizeValues, summarizeWindowMetrics,
  quantileSorted, quantileSpan, trim1Span,
} from './match-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 构造工具 ────────────────────────────────────────────────────────────

// 10 名非门将主队（id 1-10）+ 10 名客队（id 11-20）+ 双方门将；可注入极端位置。
// xs 是 10 个归一化 x（按下标对应 id 1-10）。
function makeFrame({ t = 0, homeXs, awayXs, ball = null, ballFill = null, keeperPos = null } = {}) {
  const players = new Array(22).fill(null);
  const defaultXs = Array.from({ length: 10 }, (_, i) => 0.3 + i * 0.02);
  const hx = homeXs || defaultXs;
  const ax = awayXs || defaultXs;
  players[0] = keeperPos ? { id: 0, x: keeperPos[0], y: keeperPos[1] } : { id: 0, x: 0.02, y: 0.5 };
  players[21] = { id: 21, x: 0.98, y: 0.5 };
  for (let i = 0; i < 10; i += 1) {
    players[1 + i] = { id: 1 + i, x: hx[i], y: 0.5 };
    players[11 + i] = { id: 11 + i, x: ax[i], y: 0.5 };
  }
  const f = { t, players, ball, ballFill };
  return f;
}

// 均匀横排 10 人的 x：步长 step（归一化），从 0.2 起。trim1 纵深 = 7/9 * 跨度
function spreadXs(step) {
  return Array.from({ length: 10 }, (_, i) => 0.2 + i * step);
}

// 从**米制**坐标构造帧（指标公式的手算断言用；x/y 应落在 [0,105]×[0,68] 内）。
// homeMeters/awayMeters 各 10 个 {x,y}，按下标对应 id 1-10 / 11-20。
function makeMetersFrame(homeMeters, awayMeters = null) {
  const players = new Array(22).fill(null);
  players[0] = { id: 0, x: 0.02, y: 0.5 };
  players[21] = { id: 21, x: 0.98, y: 0.5 };
  homeMeters.forEach((p, i) => {
    players[1 + i] = { id: 1 + i, x: p.x / PITCH_LENGTH_M, y: p.y / PITCH_WIDTH_M };
  });
  (awayMeters || spreadXs(0.02).map((x) => ({ x: x * PITCH_LENGTH_M, y: 34 }))).forEach((p, i) => {
    players[11 + i] = { id: 11 + i, x: p.x / PITCH_LENGTH_M, y: p.y / PITCH_WIDTH_M };
  });
  return { t: 0, players, ball: null, ballFill: null };
}

// (dx, dy) 相对重心的偏移表：每个 hypot 都是整数（5×8 个 + 10×2 个，均值 = 6），
// dx/dy 各自求和为 0（重心不动）。列表顺序**刻意不按 dx 排序**——配对 bug
// （排序后的 x 配原序 y）在这个输入上会给出不同值，见「紧凑度配对」守护测试。
const SPREAD_DELTAS = [[3, 4], [-3, -4], [4, -3], [-4, 3], [0, 5], [0, -5], [5, 0], [-5, 0], [6, 8], [-6, -8]];

// ── P1.4 已知输入 → 已知输出 ─────────────────────────────────────────────

test('米制换算：归一化坐标 ×105/×68（已知输入的纵深与宽度精确可算）', () => {
  // x 步长 0.02 → 米制步长 2.1；10 人 x∈[21, 39.9] 米
  const f = makeFrame({ homeXs: spreadXs(0.02) });
  const s = teamShape(f, 'home');
  // 纵深 = q10–q90（P37）：h=(n−1)p → q0.1 = s[0.9] 插值 = 21 + 0.9*2.1 = 22.89；
  // q0.9 = s[8.1] 插值 = 37.8 + 0.1*2.1 = 38.01 → 跨度 15.12m
  assert.ok(Math.abs(s.depth - 15.12) < 1e-9, `实际 ${s.depth}`);
  // 全排 y=0.5 → 宽度 0；重心 x = 21 + 2.1*4.5 = 30.45
  assert.equal(s.width, 0);
  assert.ok(Math.abs(s.cx - 30.45) < 1e-9);
  // spread：到重心的平均距离 = 2.1 * mean|k-4.5| = 2.1*2.5 = 5.25m（y 分量全 0）
  assert.ok(Math.abs(s.spread - 5.25) < 1e-9);
});

test('米制换算：y×68（宽度跨满球场 = 68m）', () => {
  const f = makeFrame();
  f.players[1].y = 0;
  f.players[2].y = 1;
  assert.equal(teamShape(f, 'home').width, PITCH_WIDTH_M);
});

test('重心间距 = 两队重心的欧氏距离（米）', () => {
  // 主队 cx=30.45，客队整体 +0.2 → cx=51.45，同 y=0.5 → 间距 21m
  const f = makeFrame({ homeXs: spreadXs(0.02), awayXs: spreadXs(0.02).map((x) => x + 0.2) });
  const m = frameMetrics(f);
  assert.ok(Math.abs(m.gap - 21) < 1e-9);
});

test('重心间距 = 欧氏距离而非 Manhattan（y 不同时两公式数值不同——公式守护）', () => {
  // 主队重心 (50, 30)、客队重心 (74, 62)：dx=24, dy=32 → hypot = 40（3-4-5 的 8 倍）；
  // Manhattan 会是 24+32 = 56。若断言只在 y 相同的输入上做，两公式恒等、对换公式免疫。
  const home = SPREAD_DELTAS.map(([dx, dy]) => ({ x: 50 + dx, y: 30 + dy }));
  const away = SPREAD_DELTAS.map(([dx, dy]) => ({ x: 74 + dx * 0.5, y: 62 + dy * 0.5 }));
  const m = frameMetrics(makeMetersFrame(home, away));
  assert.ok(Math.abs(m.home.cx - 50) < 1e-9);
  assert.ok(Math.abs(m.home.cy - 30) < 1e-9);
  assert.ok(Math.abs(m.away.cx - 74) < 1e-9);
  assert.ok(Math.abs(m.away.cy - 62) < 1e-9);
  assert.ok(Math.abs(m.gap - 40) < 1e-9);
  const manhattan = Math.abs(m.home.cx - m.away.cx) + Math.abs(m.home.cy - m.away.cy);
  assert.ok(Math.abs(manhattan - 56) < 1e-9); // 反证：两公式在此输入上可区分
});

test('紧凑度按同一球员的 (x,y) 配对（历史 bug 守护：排序 x 配原序 y 会给出不同值）', () => {
  // 实现期真实发生过并修掉的 bug（probes/README「实现期发现」）：spread 曾把**排序后的 x**
  // 与**未排序的 y** 按下标配对。旧断言让全队 y 相同且 x 已按序 → 配错与正确恒等，对 bug
  // 免疫；这里用 dx 乱序 + y 各异 的输入，让错误配对必然给出不同数值。
  const home = SPREAD_DELTAS.map(([dx, dy]) => ({ x: 50 + dx, y: 30 + dy }));
  const s = teamShape(makeMetersFrame(home), 'home');
  // 正确配对：每个 (dx,dy) 的 hypot ∈ {5×8, 10×2} → 均值 (40+20)/10 = 6
  assert.ok(Math.abs(s.spread - 6) < 1e-9);
  // 反证：错误配对（排序 x 配原序 y）给出 ≈5.929，差 0.071 —— 输入对配错有区分度
  const xsSorted = SPREAD_DELTAS.map(([dx]) => dx).sort((a, b) => a - b);
  const ysInOrder = SPREAD_DELTAS.map(([, dy]) => dy);
  const scrambled = xsSorted.reduce((a, x, i) => a + Math.hypot(x, ysInOrder[i]), 0) / xsSorted.length;
  assert.ok(Math.abs(scrambled - 6) > 0.05, `错误配对应给出不同值（实际 ${scrambled}）`);
});

test('重心到球距离：主队重心到球的米制距离', () => {
  // 球在 (0.5, 0.5) → 米制 (52.5, 34)；主队重心 (30.45, 34) → 距离 22.05m
  const f = makeFrame({ homeXs: spreadXs(0.02), ball: [0.5, 0.5] });
  assert.ok(Math.abs(frameMetrics(f).ballDist - 22.05) < 1e-9);
  // 无球帧 → null（球相关指标不进非球帧聚合）
  assert.equal(frameMetrics(makeFrame()).ballDist, null);
});

test('均值聚合：窗口值 = 各帧指标的算术平均（不是中位/最大）', () => {
  // 三个帧的 q10–q90 纵深：7.56 / 15.12 / 22.68 → 均值 15.12
  const frames = [
    makeFrame({ t: 0, homeXs: spreadXs(0.01) }),
    makeFrame({ t: 0.2, homeXs: spreadXs(0.02) }),
    makeFrame({ t: 0.4, homeXs: spreadXs(0.03) }),
  ];
  // P37：windowMetrics 返回 { primary, allPoints }；无外推标记时两者相同
  const { primary, allPoints } = windowMetrics(frames);
  assert.ok(Math.abs(primary.hd - 15.12) < 1e-9, `实际 ${primary.hd}`);
  assert.equal(primary.frameCount, 3);
  assert.equal(allPoints.frameCount, 3);
});

test('窗口聚合接线：hd 取主队、ad 取客队（两侧纵深不同时不可互换）', () => {
  // 主队 15.12（步长 0.02）、客队 22.68（步长 0.03）：互换接线会立刻被这两条断言打红
  const frames = [
    makeFrame({ t: 0, homeXs: spreadXs(0.02), awayXs: spreadXs(0.03) }),
    makeFrame({ t: 0.2, homeXs: spreadXs(0.02), awayXs: spreadXs(0.03) }),
  ];
  const w = windowMetrics(frames).primary;
  assert.ok(Math.abs(w.hd - 15.12) < 1e-9);
  assert.ok(Math.abs(w.ad - 22.68) < 1e-9);
});

test('控球代理聚合取值：possessionHome = 主队最近帧占比（不只计数）', () => {
  // 客队整体 +0.5（0.7–0.88）；球 0.305 → 主队最近；球 0.9 → 客队最近。
  const away = spreadXs(0.02).map((x) => x + 0.5);
  const nearHome = makeFrame({ t: 0, homeXs: spreadXs(0.02), awayXs: away, ball: [0.305, 0.5] });
  const nearAway = makeFrame({ t: 0.2, homeXs: spreadXs(0.02), awayXs: away, ball: [0.9, 0.5] });
  const w = windowMetrics([nearHome, nearAway, nearAway]).primary;
  assert.equal(w.possessionFrames, 3);
  assert.ok(Math.abs(w.possessionHome - 1 / 3) < 1e-9);
  const w2 = windowMetrics([nearHome, nearHome, nearAway]).primary;
  assert.ok(Math.abs(w2.possessionHome - 2 / 3) < 1e-9);
});

test('分布摘要：summarizeValues 的 avg/min/max/n', () => {
  assert.deepEqual(summarizeValues([3, 1, 2]), { avg: 2, min: 1, max: 3, n: 3 });
  assert.equal(summarizeValues([]), null);
  assert.equal(summarizeValues(undefined), null);
});

test('summarizeWindowMetrics：跳过 null 项、逐指标计数', () => {
  const list = [
    { hd: 10, ad: 5, ballDist: null },
    { hd: 20, ad: 7, ballDist: 30 },
  ];
  const s = summarizeWindowMetrics(list);
  assert.deepEqual(s.hd, { avg: 15, min: 10, max: 20, n: 2 });
  assert.deepEqual(s.ballDist, { avg: 30, min: 30, max: 30, n: 1 });
});

// ── P1.2 口径守护 ───────────────────────────────────────────────────────

test('口径·剔除门将：门将放到极端位置不影响任何队形指标', () => {
  const base = makeFrame({ ball: [0.5, 0.5] });
  const moved = makeFrame({ ball: [0.5, 0.5], keeperPos: [-1.4, 1.4] }); // 门将在场外极端位置
  const b = frameMetrics(base);
  const m = frameMetrics(moved);
  assert.equal(m.home.depth, b.home.depth);
  assert.equal(m.home.width, b.home.width);
  assert.equal(m.home.spread, b.home.spread);
  assert.equal(m.home.cx, b.home.cx);
  assert.equal(m.gap, b.gap);
  assert.equal(m.ballDist, b.ballDist);
  // 反证：门将若参与，depth 会差出 ~150m（这条命令测试对口径敏感）
  const naive = moved.players.filter((p) => p && p.id <= 10).map((p) => p.x * PITCH_LENGTH_M);
  assert.ok(Math.max(...naive) - Math.min(...naive) > 150);
});

test('口径·剔除门将：门将缺失（null）时指标不变', () => {
  const withKeeper = makeFrame({ ball: [0.5, 0.5] });
  const noKeeper = makeFrame({ ball: [0.5, 0.5] });
  noKeeper.players[0] = null;
  const a = frameMetrics(withKeeper);
  const b = frameMetrics(noKeeper);
  assert.equal(b.home.depth, a.home.depth);
  assert.equal(b.home.spread, a.home.spread);
  assert.equal(b.ballDist, a.ballDist);
});

test('口径·q10–q90 有界抗离群：单个极端点的影响 ≤ 一个分位步长（P37 估计量守护）', () => {
  // ⚠️ 诚实的权衡：q10–q90 **不是**完全免疫离群（那是 trim1 的性质：两极值权重恒为 0）。
  // 作为位置统计量，极端点落在 q0.1/q0.9 的插值区间里、权重约 1/n。本测试把这个影响
  // **量化并锁住**——既证明它有界（远小于 max-min），也防止有人误以为它零影响。
  const base = makeFrame();
  const baseDepth = teamShape(base, 'home').depth; // 15.12
  const front = makeFrame();
  front.players[10].x = 1.4; // 越出对方门线（极端追踪伪影）
  const frontDepth = teamShape(front, 'home').depth; // 24.78：+9.66（≈0.1×96m 的尾部间隔）
  // 有界：单点影响 < 极端点偏移量的 15%（不会像 max-min 那样被完全支配）
  const offset = (1.4 - 0.48) * PITCH_LENGTH_M;
  assert.ok(frontDepth - baseDepth < 0.15 * offset,
    `单点影响 ${(frontDepth - baseDepth).toFixed(2)}m 应 < 15% × ${offset.toFixed(1)}m`);
  // 反证：max-min 被同一注入剧烈支配（是「别退回 max-min」的守护）
  const mm = (f) => {
    const xs = f.players.filter((p) => p && p.id >= 1 && p.id <= 10).map((p) => p.x * PITCH_LENGTH_M);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(mm(front) - mm(base) > 50);
  // trim1 对同一注入免疫（这正是它被换掉时**失去**的性质；换口径是拿它有界换 n 不变）
  assert.equal(trim1Span([...Array.from({ length: 10 }, (_, i) => 0.3 + i * 0.02).slice(0, 9), 1.4]
    .map((x) => x * PITCH_LENGTH_M).sort((a, b) => a - b)),
  trim1Span(Array.from({ length: 10 }, (_, i) => 0.3 + i * 0.02).map((x) => x * PITCH_LENGTH_M)));
});

test('口径·q10–q90 插值规则写死（R type-7）：已知输入 → 精确值', () => {
  // [0, 10]：n=2，h=(2−1)*0.1=0.1 → q0.1 = 0 + 0.1*(10−0) = 1；
  // q0.9 = 0 + 0.9*10 = 9 → span = 8（不是 10、也不是别的插值约定）
  assert.ok(Math.abs(quantileSpan([0, 10]) - 8) < 1e-12, `实际 ${quantileSpan([0, 10])}`);
  // n=1 → 无跨度（null）；空数组同理
  assert.equal(quantileSpan([7]), null);
  assert.equal(quantileSpan([]), null);
  // 边界：p=1 恰好落在最后一点 → 取该点，不越界插值
  assert.equal(quantileSorted([1, 2, 3], 1), 3);
  // 1–10：h=0.9*9=8.1 → q0.1 = 1 + 0.9 = 1.9；q0.9 = 9 + 0.1 = 9.1 → 7.2
  assert.ok(Math.abs(quantileSpan([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) - 7.2) < 1e-12);
});

test('口径·q10–q90 对参与人数 n 的依赖弱于 trim1（P37 换口径的立身之本）', () => {
  // 同形状队形，10 点与 7 点（等比例）：trim1 保留比例变（8/10 vs 5/7）→ 值变；
  // q10–q90 作为位置统计量，跨度几乎不变。**这条是换口径的理由，必须锁住。**
  const ten = Array.from({ length: 10 }, (_, i) => i * 10); // 0..90
  const seven = Array.from({ length: 7 }, (_, i) => i * 15); // 0..90（等比例取点）
  const qDiff = Math.abs(quantileSpan(ten) - quantileSpan(seven));
  const tDiff = Math.abs(trim1Span(ten) - trim1Span(seven));
  assert.ok(qDiff < tDiff, `q 差 ${qDiff} 应小于 trim1 差 ${tDiff}`);
  // 且 q 的差异是「小」的（不是仅仅比 trim1 小一点）——实测量级
  assert.ok(qDiff < 2, `q 差 ${qDiff} 应在 2m 内`);
});

test('口径·瞬时队形而非整场分布：两帧各 7.56m → 窗口值 7.56m（合并不等于分位）', () => {
  // 两帧队形完全相同，但整体平移 0.4（20m 距离）。逐帧算再平均 = 7.56m（q10–q90）；
  // 若把整场位置合并算跨度，会得到 20m 量级的数字。
  const xs = spreadXs(0.01);
  const frames = [
    makeFrame({ t: 0, homeXs: xs }),
    makeFrame({ t: 0.2, homeXs: xs.map((x) => x + 0.4) }),
  ];
  const w = windowMetrics(frames).primary;
  assert.ok(Math.abs(w.hd - 7.56) < 1e-9, `实际 ${w.hd}`);
});

test('口径·弹性两种分桶口径都给结果且可以不同（口径敏感，D4 的核心现象）', () => {
  // 三组各 30 帧，球位固定、纵深不同（q10–q90：A=15.12 B=22.68 C=30.24）：
  //   A（球 x=0.31）半场口径 own；重心口径 opp（32.55m > 重心 30.45m）
  //   B（球 x=0.2） 两种口径都 own（21m < 重心）
  //   C（球 x=0.8） 两种口径都 opp
  // 半场 Δ = 30.24 − (15.12+22.68)/2 = 11.34；重心 Δ = (15.12+30.24)/2 − 22.68 = 0
  const frames = [];
  const push = (n, step, ballX) => {
    for (let i = 0; i < n; i += 1) frames.push(makeFrame({ t: frames.length * 0.2, homeXs: spreadXs(step), ball: [ballX, 0.5] }));
  };
  push(30, 0.02, 0.31);
  push(30, 0.03, 0.2);
  push(30, 0.04, 0.8);
  const half = elasticity(frames, { divider: 'half' });
  const centroid = elasticity(frames, { divider: 'centroid' });
  assert.ok(half && centroid);
  assert.ok(Math.abs(half.delta - 11.34) < 1e-9, `实际 ${half.delta}`);
  assert.ok(Math.abs(centroid.delta - 0) < 1e-9, `实际 ${centroid.delta}`);
  assert.notEqual(half.delta, centroid.delta);
});

test('口径·控球代理：离球最近者所属队（含门将参与判定），无球帧 null', () => {
  // 客队整体 +0.5（0.8..0.98），球在 0.305 时主队 id1（0.30）以 0.525m 唯一最近
  const away = spreadXs(0.02).map((x) => x + 0.5);
  const f = makeFrame({ homeXs: spreadXs(0.02), awayXs: away, ball: [0.305, 0.5] });
  assert.equal(possessionProxy(f), 'home');
  f.ball = [0.9, 0.5]; // 客队 id16 恰在 x=0.9 → 0m
  assert.equal(possessionProxy(f), 'away');
  assert.equal(possessionProxy(makeFrame()), null);
  // 门将参与最近者判定：构造「只有门将严格最近、且剔除门将后最近者会是客队」的帧——
  // 主队非门将整体压到 x=0.6、客队整体在 x=0.05、主队门将贴门线 x=0.02、球在 x=0.021。
  // 含门将 → 门将 0.105m 最近（主队）；若剔除门将 → 最近者变成客队 id16（3.045m，
  // 其 y=0.5 与球同排）→ 结论反转。
  const nearKeeper = makeFrame({ ball: [0.021, 0.5] });
  for (let id = 1; id <= 10; id += 1) { nearKeeper.players[id].x = 0.6; nearKeeper.players[id].y = 0.4 + (id - 1) * 0.02; }
  for (let id = 11; id <= 20; id += 1) { nearKeeper.players[id].x = 0.05; nearKeeper.players[id].y = 0.4 + (id - 11) * 0.02; }
  assert.equal(possessionProxy(nearKeeper), 'home');
  // 反证：剔除门将（id 0/21）后最近者属于客队 —— 该输入对「漏掉门将」的变异有区分度
  let nearestNonKeeper = null;
  for (const p of nearKeeper.players) {
    if (!p || p.id === 0 || p.id === 21) continue;
    const d = Math.hypot((p.x - 0.021) * PITCH_LENGTH_M, (p.y - 0.5) * PITCH_WIDTH_M);
    if (!nearestNonKeeper || d < nearestNonKeeper.d) nearestNonKeeper = { d, id: p.id };
  }
  assert.ok(nearestNonKeeper.id >= 11 && nearestNonKeeper.d > 3);
});

test('口径·采样间隔 0.2s：sampleEngineFrames 按固定步长 seekTo，帧时刻精确', () => {
  assert.equal(SAMPLE_INTERVAL_SEC, 0.2);
  const seeks = [];
  const game = {
    matchEnd: 1,
    players: makeFrame().players.map((p, id) => (p ? { id, x: p.x, y: p.y } : { id, x: 0, y: 0 })),
    ball: { x: 0.5, y: 0.5 },
    seekTo(t) { seeks.push(t); },
  };
  const frames = sampleEngineFrames(game);
  assert.deepEqual(seeks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(frames.map((f) => f.t), [0, 0.2, 0.4, 0.6, 0.8, 1]);
});

test('口径·非门将不足 7 人丢帧；frameCount 只计有效帧', () => {
  assert.equal(MIN_OUTFIELD_PLAYERS, 7);
  // 6 人主队（id 1-6 在场，7-10 缺席）→ 队形无效 → 整帧无效
  const short = makeFrame();
  for (let id = 7; id <= 10; id += 1) short.players[id] = null;
  assert.equal(teamShape(short, 'home'), null);
  assert.equal(frameMetrics(short), null);
  const w = windowMetrics([makeFrame({ t: 0 }), { ...short, t: 0.2 }]).primary;
  assert.equal(w.frameCount, 1);
  // 恰好 7 人 → 有效。q10–q90：n=7、h=0.6 → q0.1 = 31.5+0.6*2.1 = 32.76；
  // h=5.4 → q0.9 = 42.0+0.4*2.1 = 42.84 → 跨度 10.08
  const seven = makeFrame();
  for (let id = 8; id <= 10; id += 1) seven.players[id] = null;
  const s = teamShape(seven, 'home');
  assert.equal(s.n, 7);
  assert.ok(Math.abs(s.depth - 10.08) < 1e-9, `实际 ${s.depth}`);
});

test('口径·球相关指标主口径只用原始球帧，补全帧只进全帧对照', () => {
  const raw = makeFrame({ t: 0, ball: [0.5, 0.5] });
  const filled = makeFrame({ t: 0.2, ball: [0.9, 0.5], ballFill: 14 }); // 补全帧
  assert.equal(isRawBallFrame(raw), true);
  assert.equal(isRawBallFrame(filled), false);
  const w = windowMetrics([raw, filled]).primary;
  assert.equal(w.ballDistFrames, 1);
  assert.equal(w.ballDistAllFramesCount, 2);
  // 主口径值 = raw 帧值；全帧对照 = 两帧均值
  const rawDist = frameMetrics(raw).ballDist;
  const fillDist = frameMetrics(filled).ballDist;
  assert.ok(Math.abs(w.ballDist - rawDist) < 1e-9);
  assert.ok(Math.abs(w.ballDistAllFrames - (rawDist + fillDist) / 2) < 1e-9);
  // 控球代理同样只取原始球帧
  assert.equal(w.possessionFrames, 1);
});

// ── P1.4 边界与空输入 ───────────────────────────────────────────────────

test('空输入：空帧数组 → 两口径均为 null，切窗为空', () => {
  // P37：windowMetrics 返回 { primary, allPoints }；空输入时两者都是 null
  assert.deepEqual(windowMetrics([]), { primary: null, allPoints: null });
  assert.equal(summarizeWindowMetrics([]).hd, null);
  assert.deepEqual(cutWindows([]), []);
});

test('summarizeWindowMetrics：跳过 null 窗口并如实报数（P37 新失败模式）', () => {
  // 整窗 0 可用帧时 windowMetrics.primary 为 null；旧实现直接 m[k] 会抛 TypeError。
  const list = [
    { hd: 10, ad: 5 },
    null, // 一个整窗没有可用帧
    { hd: 20, ad: 7 },
  ];
  const s = summarizeWindowMetrics(list);
  assert.equal(s.skippedWindows, 1);
  assert.deepEqual(s.hd, { avg: 15, min: 10, max: 20, n: 2 }, '跳过 null 后仍正确摘要');
});

test('全 null 球员的帧：队形与帧指标均为 null', () => {
  const empty = { t: 0, players: new Array(22).fill(null), ball: null, ballFill: null };
  assert.equal(teamShape(empty, 'home'), null);
  assert.equal(teamShape(empty, 'away'), null);
  assert.equal(frameMetrics(empty), null);
});

test('fromTrackingFrame：数组下标即 id，ballFill 透传', () => {
  const raw = { t: 3.2, players: new Array(22).fill(null), ball: [0.5, 0.5] };
  raw.players[0] = [0.02, 0.5];
  raw.players[13] = [0.7, 0.3];
  const f = fromTrackingFrame(raw);
  assert.equal(f.t, 3.2);
  assert.equal(f.players[0].id, 0);
  assert.deepEqual([f.players[13].x, f.players[13].y], [0.7, 0.3]);
  assert.equal(f.players[1], null);
  assert.equal(f.ballFill, null);
  const filled = fromTrackingFrame({ ...raw, ballFill: 13 });
  assert.equal(filled.ballFill, 13);
  assert.equal(isRawBallFrame(filled), false);
});

test('cutWindows：只取完整窗（尾部残窗由循环边界排除，非 minFrames）', () => {
  // 帧序列 t=0..5646（5Hz，i/5 精确）→ 与真实 game2 相同时长：6 个满窗。
  // 尾部 246s 残窗是被循环边界 s + sizeSec <= T + 1 排除的——它根本进不了循环，
  // 与 minFrames 门槛无关（1232 帧的残窗远高于 100 的门槛）。
  const frames = [];
  for (let i = 0; i * 0.2 <= 5646 + 1e-9; i += 1) frames.push({ t: i / 5 });
  const ws = cutWindows(frames);
  assert.equal(ws.length, 6);
  assert.deepEqual(ws.map((w) => w[0].t), [0, 900, 1800, 2700, 3600, 4500]);
  for (const w of ws) assert.equal(w.length, 1500);
  // 更长时长（game1 类）→ 7 窗
  const long = [];
  for (let i = 0; i / 5 <= 5700 + 1e-9; i += 1) long.push({ t: i / 5 });
  assert.equal(cutWindows(long).length, 7);
});

test('cutWindows：贴边容差 T+1（T 略小于窗右界时整窗仍保留）', () => {
  // 采样相位差让最后一帧的 t 比窗右界小一丁点（如 T=5699.999 而窗右界 5700）：
  // 容差 +1 必须让 [5400, 5700) 这一整窗保留下来（丢它 = 少一个样本且静默）。
  const frames = [];
  for (let i = 0; i / 5 <= 5699.999 + 1e-9; i += 1) frames.push({ t: i / 5 });
  const ws = cutWindows(frames);
  assert.equal(ws.length, 7);
  assert.equal(ws[ws.length - 1][0].t, 5400);
});

test('cutWindows：minFrames 安全网——数据缺口导致的短窗被丢弃', () => {
  // 构造「窗起点可切但帧大量缺失」：t=0..3000 里只有 s=0 窗是满的，
  // s=900 与 s=1800 窗内各只放 50 帧（<100 门槛）→ 被丢弃；s=2700 窗满 → 保留。
  const frames = [];
  for (let i = 0; i / 5 < 300; i += 1) frames.push({ t: i / 5 });          // [0,300) 满窗 1500 帧
  for (let i = 0; i < 50; i += 1) frames.push({ t: 900 + i / 5 });         // [900,1200) 仅 50 帧
  for (let i = 0; i < 50; i += 1) frames.push({ t: 1800 + i / 5 });        // [1800,2100) 仅 50 帧
  for (let i = 0; i / 5 < 300; i += 1) frames.push({ t: 2700 + i / 5 });   // [2700,3000) 满窗
  const ws = cutWindows(frames);
  assert.deepEqual(ws.map((w) => w[0].t), [0, 2700]);
});

test('sampleEngineFrames：帧数由 round(end/step) 决定，不因浮点累加抖动', () => {
  const game = { matchEnd: 0.6, players: [], ball: { x: 0.5, y: 0.5 }, seekTo() {} };
  const frames = sampleEngineFrames(game, { stepSec: 0.2 });
  // 0.6/0.2 在浮点下是 2.999...，round 到 3 → t=0,0.2,0.4,0.6（不用累加，帧数确定）
  assert.equal(frames.length, 4);
  assert.equal(frames[frames.length - 1].t, 0.6);
});

test('弹性：任一侧样本不足 30 帧 → null（报告质量守卫）', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    frames.push(makeFrame({ t: i * 0.2, ball: i < 20 ? [0.3, 0.5] : [0.7, 0.5] }));
  }
  assert.equal(elasticity(frames, { divider: 'half' }), null);
});

test('弹性：两桶样本充足时 Δ = opp - own', () => {
  const frames = [];
  for (let i = 0; i < 80; i += 1) {
    const own = i < 40;
    frames.push(makeFrame({
      t: i * 0.2,
      homeXs: spreadXs(own ? 0.02 : 0.03), // own 纵深 15.12 / opp 纵深 22.68（q10–q90）
      ball: own ? [0.3, 0.5] : [0.7, 0.5],
    }));
  }
  const e = elasticity(frames, { divider: 'half', rawBallOnly: true });
  assert.ok(Math.abs(e.delta - 7.56) < 1e-9, `实际 ${e.delta}`);
  assert.equal(e.nOwn, 40);
  assert.equal(e.nOpp, 40);
});

// ── P37 外推点口径（P2.2 守护：默认跳过 + 反证条） ──────────────────────
//
// 对齐 P36 的教训（match-metrics 的「空转断言」坑）：断言输入必须对目标变异**有区分度**，
// 并给**反证条**——否则把「跳过外推点」的实现删掉，测试照样绿。

// 造一个「外推点会显著改变纵深」的帧：主队 10 人，其中 4 人被标外推且位置离群。
// 默认口径（跳过）剩 6 人 → 低于 MIN_OUTFIELD_PLAYERS → **整帧无效**；
// 全点口径（采信）10 人 → 有效且纵深被外推点撑大。两者可区分。
function makeExtrapolatedFrame() {
  const f = makeFrame({ ball: [0.5, 0.5] });
  // id 1-6 真检测、贴在一段；id 7-10 外推、甩到远端
  for (let id = 7; id <= 10; id += 1) {
    f.players[id] = { id, x: 0.85 + (id - 7) * 0.01, y: 0.5, extrapolated: true };
    f.players[id - 6] = { id: id - 6, x: 0.30 + (id - 7) * 0.01, y: 0.5 };
  }
  return f;
}

test('口径·外推点默认跳过：仅 6 真检测（<7）→ 该队队形无效', () => {
  const f = makeExtrapolatedFrame();
  // 默认：6 个真检测 < MIN_OUTFIELD_PLAYERS → null
  assert.equal(teamShape(f, 'home'), null);
  assert.equal(teamShape(f, 'home', { includeExtrapolated: false }), null);
  // 全点：10 人 → 有效，且纵深包含外推点的远端（width 反映离群）
  const all = teamShape(f, 'home', { includeExtrapolated: true });
  assert.ok(all, '全点口径应当有效');
  assert.equal(all.n, 10);
});

test('口径·外推点守护【反证条】：全点口径与默认口径**必须不同**', () => {
  // 反证：若「跳过外推点」的实现被删（默认变成全点），这条会红——
  // 否则测试对「是否跳过」无区分度（P36 踩过的空转断言）。
  const f = makeExtrapolatedFrame();
  const skipped = teamShape(f, 'home'); // null（6 人）
  const all = teamShape(f, 'home', { includeExtrapolated: true }); // 有值（10 人）
  assert.notEqual(skipped, all, '两种口径必须给出不同结果');
  assert.equal(skipped, null);
  assert.ok(all != null);
  // 更强的区分度：构造 7 真检测 + 3 外推（默认仍有效），断言纵深不同
  const g = makeFrame({ ball: [0.5, 0.5] });
  for (let id = 8; id <= 10; id += 1) {
    g.players[id] = { id, x: 0.95, y: 0.5, extrapolated: true }; // 远端外推
    g.players[id - 7] = { id: id - 7, x: 0.3 + (id - 8) * 0.01, y: 0.5 };
  }
  const dep = teamShape(g, 'home').depth;
  const depAll = teamShape(g, 'home', { includeExtrapolated: true }).depth;
  assert.notEqual(dep, depAll, '默认与全点口径的纵深必须不同');
  assert.ok(depAll > dep, '采信远端外推点会撑大纵深');
});

test('口径·windowMetrics 并列输出两口径（primary 跳过 / allPoints 采信）', () => {
  const f = makeExtrapolatedFrame();
  const frames = [f, f, f];
  const { primary, allPoints } = windowMetrics(frames);
  // primary：6 真检测 <7 → 整帧无效 → 0 可用帧 → null
  assert.equal(primary, null, 'primary 应跳过外推点导致无有效帧');
  // allPoints：采信外推（10 人）→ 有效
  assert.ok(allPoints && allPoints.frameCount === 3);
  // 反证：两口径必须不同（若 primary 也采信外推，这条会红）
  assert.notDeepEqual(primary, allPoints);
});

test('口径·控球代理也跳过外推点【反证条】（审阅发现的未守护项）', () => {
  // 构造：距球**最近**的球员是外推点、次近的是真检测且属于**另一队**。
  // 默认口径（跳过外推）→ 最近者 = 次近的真检测球员 → 客队；
  // 若采信外推 → 最近者 = 外推的点 → 主队。两口径**结论相反**，故对变异有区分度。
  const f = makeFrame({ ball: [0.5, 0.5] });
  // 主队一人贴球（x=0.51），但标为外推；其余主队甩远
  for (let id = 1; id <= 10; id += 1) f.players[id] = { id, x: 0.05, y: 0.5 };
  f.players[1] = { id: 1, x: 0.51, y: 0.5, extrapolated: true };
  // 客队一人次近（x=0.6），真检测
  for (let id = 11; id <= 20; id += 1) f.players[id] = { id, x: 0.95, y: 0.5 };
  f.players[11] = { id: 11, x: 0.6, y: 0.5 };
  // 默认口径：跳过外推 → 最近 = 客队 id11
  assert.equal(possessionProxy(f), 'away', '默认应跳过外推点，最近者为客队');
  // 全点口径：采信外推 → 最近 = 主队 id1（贴球）
  assert.equal(possessionProxy(f, { includeExtrapolated: true }), 'home', '采信外推则主队最近');
  // 反证：两口径必须给出**不同**结论（若实现忽略了 includeExtrapolated，这条会红）
  assert.notEqual(possessionProxy(f), possessionProxy(f, { includeExtrapolated: true }));
});

test('口径·逐场尺寸全链路贯通【反证条】（frameMetrics/windowMetrics 都按帧上尺寸换算）', () => {
  // 同一组**归一化**坐标，在 105m 与 104m 场地上应给出不同的米制纵深。
  // 反证：若哪一环漏掉 pitchMeters（退回硬编码 105），两场的米制纵深会**相同** → 测试红。
  const xs = spreadXs(0.02);
  const mkFrame = (pm) => {
    const f = makeFrame({ homeXs: xs, ball: [0.5, 0.5] });
    if (pm) f.pitchMeters = pm;
    return f;
  };
  const d105 = frameMetrics(mkFrame([105, 68])).home.depth;
  const d104 = frameMetrics(mkFrame([104, 68])).home.depth;
  assert.ok(Math.abs(d105 - d104) > 0.1, '不同尺寸应给出不同米制纵深（否则没按逐场换算）');
  assert.ok(d104 < d105, '104m 场地的米制纵深应更小');
  assert.ok(Math.abs(d105 / d104 - 105 / 104) < 1e-9, '比例应恰为 105/104');

  // windowMetrics：帧上带 pitchMeters 时须自动采用（不传 opts）
  const w105 = windowMetrics([mkFrame([105, 68])]).primary;
  const w104 = windowMetrics([mkFrame([104, 68])]).primary;
  assert.ok(Math.abs(w105.hd - w104.hd) > 0.1, 'windowMetrics 须从帧上取尺寸');
  assert.ok(Math.abs(w105.hd / w104.hd - 105 / 104) < 1e-9);

  // **ballDist 也走逐场尺寸**（审阅 M12：`frameMetric` 的球距用 `framePitchMeters(eff)` 取尺寸，
  // 若那一环退回缺省 105，depth 仍对（它走 opts.pitchMeters 分支）但 ballDist 会静默错。
  // 只断言 depth 会让这条路径无守护——故这里单独锁 ballDist。）
  const b105 = frameMetrics(mkFrame([105, 68])).ballDist;
  const b104 = frameMetrics(mkFrame([104, 68])).ballDist;
  assert.ok(Math.abs(b105 - b104) > 1e-9, `ballDist 也应随逐场尺寸变（105=${b105} 104=${b104}）`);
  assert.ok(Math.abs(b105 / b104 - 105 / 104) < 1e-9, 'ballDist 的 105/104 比应恰为 105/104');
  const wb105 = windowMetrics([mkFrame([105, 68])]).primary.ballDist;
  const wb104 = windowMetrics([mkFrame([104, 68])]).primary.ballDist;
  assert.ok(Math.abs(wb105 / wb104 - 105 / 104) < 1e-9, '窗口聚合的 ballDist 也须按逐场尺寸');

  // 引擎侧帧不带 pitchMeters → 退回缺省 105（P36 行为不变）
  const engineLike = makeFrame({ homeXs: xs, ball: [0.5, 0.5] });
  assert.ok(Math.abs(frameMetrics(engineLike).home.depth - d105) < 1e-9,
    '不带尺寸的帧应退回 105×68（引擎侧口径不变）');
});

test('口径·弹性按逐场尺寸换算【反证条】（审阅 P3-2 的未守护路径）', () => {
  // 弹性（纵深随球位的变化）也走 teamShape 的 depth（米制，用 L）。
  // 构造「球在主队半场」与「球在对方半场」两桶**纵深不同**（spreadXs 步长 0.02 vs 0.03），
  // 使 Δ 非零；再断言 105m / 104m 的 Δ 之比恰为 105/104。
  // 反证：若 elasticity 忽略帧上 pitchMeters（退回 105），两场 Δ 相同 → 比值 1 ≠ 105/104 → 红。
  const mk = (pm) => {
    const frames = [];
    for (let i = 0; i < 80; i += 1) {
      const inOwnHalf = i < 40;
      const f = makeFrame({
        t: i * 0.2,
        homeXs: spreadXs(inOwnHalf ? 0.02 : 0.03), // 两桶纵深不同 → Δ 非零
        ball: inOwnHalf ? [0.1, 0.5] : [0.9, 0.5],
      });
      if (pm) f.pitchMeters = pm;
      frames.push(f);
    }
    return frames;
  };
  const d105 = elasticity(mk([105, 68]), { divider: 'half' });
  const d104 = elasticity(mk([104, 68]), { divider: 'half' });
  assert.ok(d105 && d104, '两场都应有弹性结果');
  assert.ok(d105.delta > 0, `Δ 应非零（实际 ${d105.delta}）`);
  assert.ok(Math.abs(d105.delta / d104.delta - 105 / 104) < 1e-9,
    `弹性 Δ 的 105/104 比应恰为 105/104（实际 ${d105.delta / d104.delta}）——不等说明没按逐场尺寸`);
  // 显式传 opts.pitchMeters 也要生效（与从帧上取等价）
  const viaOpts = elasticity(mk(null), { divider: 'half', pitchMeters: [104, 68] });
  assert.ok(Math.abs(viaOpts.delta - d104.delta) < 1e-9, '显式传入应等价于帧上带');
});

test('口径·fromTrackingFrame 透传外推标记（坐标第三位=1）', () => {
  const raw = { t: 1, players: new Array(22).fill(null), ball: [0.5, 0.5] };
  raw.players[3] = [0.4, 0.5]; // 真检测（2 元素）
  raw.players[7] = [0.8, 0.5, 1]; // 外推（3 元素，第三位 1）
  const f = fromTrackingFrame(raw);
  assert.equal(f.players[3].extrapolated, undefined, '真检测点不应带外推标记');
  assert.equal(f.players[7].extrapolated, true, '外推点必须带标记');
  // 标记经 JSON 往返后仍在（P37 审阅 P1-5：数组自定义属性会消失，第三位不会）
  const roundTripped = fromTrackingFrame(JSON.parse(JSON.stringify(raw)));
  assert.equal(roundTripped.players[7].extrapolated, true, 'JSON 往返后标记必须仍在');
});

// ── 冻结约定（两侧共用的常数） ──────────────────────────────────────────

test('冻结种子集与引擎时长（禁止按结果重挑）', () => {
  assert.deepEqual(BENCHMARK_SEEDS, [42, 1, 7, 99, 123]);
  assert.equal(ENGINE_DURATION_SEC, 5400);
});

// ── 真实数据冒烟（数据不入库，缺失时跳过；不依赖视觉） ──────────────────

const DATA1 = join(HERE, 'data', 'real-game-1.json');
const DATA2 = join(HERE, 'data', 'real-game-2.json');
const HAVE_DATA = existsSync(DATA1) && existsSync(DATA2);
const SKIP_REASON = '缺少 viewer/data/real-game-{1,2}.json —— 先生成：'
  + 'node tools/fetch-tracking-data.mjs && node tools/convert-tracking-to-frames.mjs '
  + '--in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json'
  + '（game2 同理）';

test('真实数据冒烟：切窗数 7+6=13，指标在球场量级内', { skip: !HAVE_DATA && SKIP_REASON }, () => {
  for (const [path, expectWindows] of [[DATA1, 7], [DATA2, 6]]) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const frames = data.frames.map(fromTrackingFrame);
    const windows = cutWindows(frames);
    assert.equal(windows.length, expectWindows, `${path} 的满窗数`);
    for (const w of windows) {
      const m = windowMetrics(w).primary;
      assert.ok(m.hd > 0 && m.hd < PITCH_LENGTH_M);
      assert.ok(m.spread > 0 && m.spread < PITCH_LENGTH_M);
      assert.ok(m.gap >= 0 && m.gap < PITCH_LENGTH_M);
      assert.ok(m.width >= 0 && m.width <= PITCH_WIDTH_M);
    }
  }
});
