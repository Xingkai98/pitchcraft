// `panel.mjs` 的**口径守护测试**。纯函数、**不读盘**（无真实数据也能跑），CI 必跑。
//
// 为什么有它：`panel.mjs` 的价值全在**口径**上——本仓实测过"写法一换结论就翻转"
// （P2 残差的单向变体几乎贴上、R4 的 x 跨度是门将常量的导出量）。所以每一条口径都要有
// **有区分度**的断言，并配**反证条**（不给反证条 = 空转断言，本仓踩过）。
import { test } from 'node:test';
import assert from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = await import('./panel.mjs');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));

const L = 105; const W = 68;
const PITCH = { L, W };

// 造一帧：home 外场 id 1..10、away 外场 id 11..20、门将 0/21。
// `spec` = { id: [x, y, extrapolated?] } 覆盖默认位置；默认全部堆在原点附近。
function mk(spec = {}) {
  const out = [];
  for (let id = 0; id <= 21; id += 1) {
    const s = spec[id] || [0.5, 0.5];
    out.push({ id, x: s[0], y: s[1], extrapolated: s[2] === true });
  }
  return out;
}
// 把点按「**引擎侧的真实顺序**」排（按队分组、客队倒序：0,1..10,21,20,…,11）
function engineOrder(players) {
  const home = players.filter((p) => p.id <= 10);
  const away = players.filter((p) => p.id >= 11).sort((a, b) => b.id - a.id);
  return [...home, ...away];
}

test('★ 按 id 取人（回归：引擎侧数组顺序是「按队分组、客队倒序」，按下标取会取错人）', () => {
  const players = engineOrder(mk({ 21: [0.02, 0.5] }));
  // 夹具本身必须是"非 id 序"，否则本测试没有区分度（反证条）
  assert.strictEqual(players[11].id, 21, '夹具前提：下标 11 处应是 id 21（客队倒序）');
  assert.notStrictEqual(players[21].id, 21, '夹具前提：下标 21 处**不是** id 21');
  assert.strictEqual(P.byId(players, 21).x, 0.02, 'byId 必须按 id 取到门将');
  assert.strictEqual(P.byId(players, 11).x, 0.5, 'byId(11) 应取到客队 11 号');
});

test('★ 队形类判据剔门将（口径 R2）', () => {
  const { home, away } = P.outfield(mk());
  assert.strictEqual(home.length, 10);
  assert.strictEqual(away.length, 10);
  for (const p of [...home, ...away]) {
    assert.ok(!P.KEEPER_IDS.includes(p.id), `门将 ${p.id} 不该出现在外场集合里`);
  }
});

test('★ 横向跨度是 **y** 不是 x（口径 R1/R4）——含反证：这个夹具的 x 跨度很大', () => {
  const spec = {};
  for (let i = 0; i < 10; i += 1) spec[1 + i] = [0.05 + 0.1 * i, 0.45 + 0.01 * i]; // x 铺满、y 很窄
  const f = mk(spec);
  const { home } = P.outfield(f);
  assert.ok(P.spanX(home, L) > 80, `夹具前提：x 跨度应很大（实得 ${P.spanX(home, L)}）`);
  assert.ok(P.spanY(home, W) < 8, `spanY 必须是 y 方向跨度（实得 ${P.spanY(home, W)}）`);
});

test('★ primary / allPoints 口径：跳外推点 + 每队 ≥7 名外场才算有效帧（口径 7）', () => {
  const spec = {};
  for (let i = 0; i < 4; i += 1) spec[1 + i] = [0.4, 0.4, true]; // home 4 人标外推
  const f = mk(spec);
  assert.strictEqual(P.keptPoints(f, false).length, 22 - 4, 'primary 应剔除 4 个外推点');
  assert.strictEqual(P.keptPoints(f, true).length, 22, 'allPoints 应全留');
  assert.strictEqual(P.frameValid(f, false), false, 'primary 下 home 只剩 6 名外场 ⇒ 该帧无效');
  assert.strictEqual(P.frameValid(f, true), true, 'allPoints 下两队都够 10 人 ⇒ 有效');
  assert.strictEqual(mm.MIN_OUTFIELD_PLAYERS, 7, '本测试依赖仓内口径 7（若口径改，这里应一起改）');
});

test('★ 贴身接触只算**异队**对、且先换算成米再比（口径 R9/R10）', () => {
  // 同队两点相距 0.5 m（**不该**计入），异队一点相距 3 m
  const pts = [
    { id: 1, x: 0.5, y: 0.5 },
    { id: 2, x: 0.5 + 0.5 / L, y: 0.5 },
    { id: 11, x: 0.5 + 3 / L, y: 0.5 },
  ];
  const near = P.crossStats(pts, L, W);
  // 异队那一对：id2(x=0.5+0.5/L) 到 id11(x=0.5+3/L) = 2.5 m；同队 id1↔id2 = 0.5 m
  assert.ok(Math.abs(near.dmin - 2.5) < 1e-9, `dmin 必须是**异队**最近距离 2.5 m（实得 ${near.dmin}）——同队的 0.5 m 不算`);
  assert.strictEqual(near.np, 2, '两个主队点各与客队那点成 1 对（3 m 与 2.5 m），均落在 8 m 内 ⇒ 2 对');
  // 反证：把异队那点挪到 9 m ⇒ 恰好越过 8 m 阈值
  const far = P.crossStats([pts[0], pts[1], { id: 11, x: 0.5 + 9 / L, y: 0.5 }], L, W);
  assert.strictEqual(far.np, 0, '异队最近 8.5 m 超出 8 m 阈值 ⇒ 0 对');
  assert.ok(Math.abs(far.dmin - 8.5) < 1e-9, `dmin 应为 8.5 m（实得 ${far.dmin}）`);
  // 单队帧 ⇒ 无定义（不是 0）
  assert.strictEqual(P.crossStats([{ id: 1, x: 0.5, y: 0.5 }], L, W).dmin, null);
});

test('★ 「逐比特冻结」阈值是 0.05 m（口径 R3a）——0.04 m 算冻结、0.06 m 不算', () => {
  const prev = [{ id: 1, x: 0.3, y: 0.5 }, { id: 2, x: 0.7, y: 0.5 }];
  const cur = [
    { id: 1, x: 0.3 + 0.04 / L, y: 0.5 },
    { id: 2, x: 0.7 + 0.06 / L, y: 0.5 },
  ];
  const r = P.p3aStepFrozen(prev, cur, L, W);
  assert.strictEqual(r.frozen, 1, `只有 0.04 m 那位算冻结（实得 ${r.frozen}）`);
  assert.strictEqual(r.total, 2);
  // 反证：阈值放宽到 0.5 m 时两位都算"冻结"⇒ 证明上面那 1 不是恒等式
  assert.strictEqual(P.p3aStepFrozen(prev, cur, L, W, 0.5).frozen, 2);
});

test('★ 队形残差必须先**去重心**（口径 R7）——含反证：整体平移 5 m 不该被算成残差', () => {
  // 稀疏 4 点（间距 ~84 m），平移 5 m：未去重心时最近邻仍是"自己的像"（5 m）⇒ 残差 ≈ 5
  const sparse = [[5, 5], [95, 5], [5, 63], [95, 63]];
  const sparseMoved = sparse.map(([x, y]) => [x + 5, y]);
  const rawR = P.p2Residual(sparse, sparseMoved);
  assert.ok(rawR > 4.9, `未去重心时纯整体平移被读成 ~5 m「残差」（实得 ${rawR}）——这正是口径 R7 要避免的`);
  // 走工具链：同一队形整体平移 ⇒ 去重心后残差必须为 0
  const spec = {};
  for (let i = 0; i < 10; i += 1) spec[1 + i] = [0.2 + 0.05 * i, 0.3 + 0.03 * i];
  const A = mk(spec);
  const B = A.map((p) => ({ ...p, x: p.x + 5 / L }));
  assert.ok(P.p2Residual(P.center(A, L, W), P.center(B, L, W)) < 1e-9, '去重心后整体平移的残差必须是 0');
  // 反证：真改形态（把一人挪 3 m）后残差必须 > 0，否则"残差恒 0"就是空转
  const C = A.map((p, i) => (i === 1 ? { ...p, x: p.x + 3 / L } : p));
  assert.ok(P.p2Residual(P.center(A, L, W), P.center(C, L, W)) > 1e-6, '改形态后残差必须为正');
});

test('★ 残差必须是**双向对称** NN（口径 R7）——单向变体会给出完全不同的数（反例：两侧点数不等）', () => {
  // A = 10 点等距铺 0..9 m；C = 只有两端两点（0 与 9）⇒ 两侧点数不等、密度不对称：
  //   单向 A→C：每个 A 点到最近端点的距离均值 ≈2.25；单向 C→A：两端点各自最近就是自己 ⇒ 0
  //   双向 = (2.25+0)/2 ≈ 1.125 ⇒ **既不是 0 也不是 2.25**，单向实现必被抓住
  const A = [...Array(10)].map((_, i) => [i, 0]);
  const C = [[0, 0], [9, 0]];
  const r = P.p2Residual(A, C);
  const oneWayAC = A.reduce((s, a) => s + Math.min(...C.map((c) => Math.hypot(a[0] - c[0], a[1] - c[1]))), 0) / A.length;
  const oneWayCA = C.reduce((s, c) => s + Math.min(...A.map((a) => Math.hypot(a[0] - c[0], a[1] - c[1]))), 0) / C.length;
  assert.ok(Math.abs(r - (oneWayAC + oneWayCA) / 2) < 1e-12, `应为双向均值（实得 ${r}）`);
  assert.ok(Math.abs(r - oneWayAC) > 0.5, `不得等于单向 A→C（${oneWayAC}）`);
  assert.ok(r > 0.5, `不得等于单向 C→A 的 0（实得 ${r}）`);
});

test('★ `center()` 用各自轴的真实尺寸（x×L、y×W）——含反证：把 y 也乘 L 会被抓住', () => {
  const players = [{ id: 1, x: 0.5, y: 0.4 }, { id: 2, x: 0.5, y: 0.6 }];
  const c = P.center(players, L, W);
  assert.ok(Math.abs(c[0][1] + (0.1 * W)) < 1e-12, `去重心后 y 应为 ∓0.1·W=${0.1 * W} m（实得 ${c[0][1]}）`);
  assert.ok(Math.abs(c[0][1] + 0.1 * W - (c[0][1] + 0.1 * L)) > 1, 'L≠W ⇒ 用错轴会给出不同的数（本夹具因此有区分度）');
  assert.ok(L !== W, '夹具前提：球场长宽不等');
});

test('★ 有效帧的边界是 `>=7` 名外场（口径 7）——恰好 7 人**必须**算有效', () => {
  const spec = {};
  for (let i = 1; i <= 7; i += 1) spec[i] = [0.4, 0.4];          // home 恰 7 名外场
  for (let i = 11; i <= 17; i += 1) spec[i] = [0.6, 0.6];        // away 恰 7 名外场
  const players = Object.keys(spec).map((id) => ({ id: Number(id), x: spec[id][0], y: spec[id][1] }));
  players.push({ id: 0, x: 0.02, y: 0.5 }, { id: 21, x: 0.98, y: 0.5 });
  assert.strictEqual(P.frameValid(players, true), true, '恰好 7 名外场 ⇒ 有效（`>=7`，不是 `>7`）');
  assert.strictEqual(mm.MIN_OUTFIELD_PLAYERS, 7, '本测试依赖仓内口径 7');
});

test('★ 分布摘要走仓内分位口径（与基线同源，R type-7）', () => {
  const s = P.distSummary([...Array(10)].map((_, i) => i + 1));
  assert.strictEqual(s.n, 10);
  assert.strictEqual(s.min, 1);
  assert.strictEqual(s.max, 10);
  assert.ok(Math.abs(s.median - mm.quantileSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)) < 1e-12);
  assert.strictEqual(P.distSummary([]), null, '空输入返回 null（不是 0——0 会被当成真实读数）');
});

test('★ 冻结阈值与面板常量写死在 `FROZEN`（改口径必须改这里，且本测试会一起红）', () => {
  assert.strictEqual(P.FROZEN.P1_T, 44);
  assert.strictEqual(P.FROZEN.P3A_FREEZE_M, 0.05);
  assert.strictEqual(P.FROZEN.P5_NEAR_M, 2);
  assert.strictEqual(P.FROZEN.P5_PAIR_D_M, 8);
  assert.strictEqual(P.FROZEN.P5_PAIR_K, 5);
  // 12 s 窗 / 2.4 s 一栏 ⇒ 下标步长必须是 12（来自 keyframeHz=5，见 REAL-CORPUS §5.1）
  assert.strictEqual(P.FINE_COL_STEP, Math.round(2.4 / mm.SAMPLE_INTERVAL_SEC));
  assert.strictEqual(P.FINE_COL_STEP, 12);
});
