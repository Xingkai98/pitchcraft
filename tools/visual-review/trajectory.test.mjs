// trajectory 轨迹图的守护测试。**纯函数**（合成帧，CI 必跑）。
//
// 本工具存在的理由：飞轮三版只跑数字、从不渲这张图 → 「引擎球员在铁轨上滑」这种
// **一眼可见的结构缺陷**从没进过我的视野。所以必须夹死「轨迹真的被画出来了」这件事。
import { test } from 'node:test';
import assert from 'node:assert';

const { buildTrajectoryComparison, collectPaths, T } = await import('./trajectory.mjs');

// 合成帧：N 名球员沿 x 匀速右移（水平轨迹），或静止。
function mkFrames(n, { move = true, players = 20 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    t: 1800 + i * 0.2,
    players: Array.from({ length: players }, (_, k) => ({ id: k + 1, x: 0.1 + 0.02 * i * (move ? 1 : 0) + k * 0.03, y: 0.2 + (k % 4) * 0.15 })),
    ball: [0.5, 0.5],
  }));
}
const yellow = () => 0; // 轨迹图不画球；用红/蓝像素计数。
function countColor(img, test) { let n = 0; for (let o = 0; o < img.data.length; o += 4) if (test(img.data[o], img.data[o + 1], img.data[o + 2])) n++; return n; }
const isRed = (r, g, b) => r > 180 && g < 90 && b < 90;
const isBlue = (r, g, b) => b > 180 && r < 90 && g < 160 && g > 60;

test('trajectory：collectPaths 按球员聚点、受 [t0,t0+win] 窗约束（**纯函数**）', () => {
  const frames = mkFrames(100);              // t = 1800..1819.8
  const p = collectPaths(frames, { t0: 1800, win: 5 });   // 只取 t<=1805
  assert.strictEqual(p.length, 20, '20 名球员应各一条轨迹');
  assert.ok(p.every(x => x.pts.length === 26), `每人应 ~26 个点（窗内帧数），实得 ${p[0].pts.length}`);
  // 反证：窗更窄 → 点更少
  const p2 = collectPaths(frames, { t0: 1800, win: 1 });
  assert.ok(p2[0].pts.length < p[0].pts.length, '窄窗点应更少（证明窗约束真的生效）');
});

test('★ trajectory：对比图**左右两面板各自都画出了轨迹**（分面板——缺一侧必红）', () => {
  // 本仓教训：只数全图总量会漏掉「整条引擎/真实面板没画」。按面板行带**分别**数红/蓝像素。
  const eng = mkFrames(200); const real = mkFrames(200);
  const { canvas, panels, W, H } = buildTrajectoryComparison(eng, real, { t0: 1800, win: 30 });
  assert.strictEqual(panels.engine.n, 20, '引擎面板应画 20 条轨迹');
  assert.strictEqual(panels.real.n, 20, '真实面板应画 20 条轨迹');
  const img = canvas.getContext().getImageData(0, 0, W, H);
  // 左面板（引擎）x∈[G, G+PW]，右面板（真实）x∈[G+PW+G, ...]。
  let leftCol = 0, rightCol = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (isRed(img.data[o], img.data[o + 1], img.data[o + 2]) || isBlue(img.data[o], img.data[o + 1], img.data[o + 2])) {
      if (x < T.G + T.PW) leftCol++; else if (x > T.G + T.PW + T.G) rightCol++;
    }
  }
  assert.ok(leftCol > 300, `引擎面板应有轨迹像素（实得 ${leftCol}）`);
  assert.ok(rightCol > 300, `真实面板应有轨迹像素（实得 ${rightCol}）——缺一侧必须在此变红`);
});

test('反证条：引擎面板无球员 → 左面板像素归零（证明分面板断言有区分度）', () => {
  const empty = Array.from({ length: 200 }, (_, i) => ({ t: 1800 + i * 0.2, players: [], ball: [0.5, 0.5] }));
  const real = mkFrames(200);
  const { canvas, panels, W, H } = buildTrajectoryComparison(empty, real, { t0: 1800, win: 30 });
  assert.strictEqual(panels.engine.n, 0, '引擎面板应 0 条轨迹');
  const img = canvas.getContext().getImageData(0, 0, W, H);
  let leftCol = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < T.G + T.PW; x++) { const o = (y * W + x) * 4; if (isRed(img.data[o], img.data[o + 1], img.data[o + 2]) || isBlue(img.data[o], img.data[o + 1], img.data[o + 2])) leftCol++; }
  assert.ok(leftCol < 50, `引擎面板无球员时左带应几乎无轨迹像素（实得 ${leftCol}）——否则分面板断言无区分度`);
});

test('★ trajectory：**静止的轨迹 ≠ 移动的轨迹**（轨迹图能区分「铁轨滑」与「站住」）', () => {
  // 本工具要能看出「动没动」：若某人全程不动，其轨迹是同一点（短）；移动者轨迹长。
  const still = mkFrames(200, { move: false });
  const moving = mkFrames(200, { move: true });
  const box = (frames) => {
    const p = collectPaths(frames, { t0: 1800, win: 30 })[0];
    const xs = p.pts.map(q => q[0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(box(moving) > box(still) * 5, `移动者轨迹跨度应远大于静止者（实得 ${box(moving).toFixed(3)} vs ${box(still).toFixed(3)}）`);
});
