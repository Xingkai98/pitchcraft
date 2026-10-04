// visual-review 工具的守护测试。
//
// 设计原则（都是被独立审阅抓过才定的，别退回）：
//   - **不依赖 wasm / 真实数据 / PIL**：用**合成帧**直接调 `buildComparison`，
//     断言走 `getImageData`（纯 JS）→ 测试在 CI 上必跑，不会因数据缺席静默跳过。
//   - **分排断言**：像素按「引擎行带 / 真实行带」**分别**计数、分别断言——
//     只丢一排（正是本工具要防的原 bug 形态：「引擎那排球漏画」）必须变红。
//   - **反证条**：每个守护都带一条「故意破坏必红」的对照断言，证明它不是空转。
import { test } from 'node:test';
import assert from 'node:assert';

const { buildComparison, ballXY, LAYOUT } = await import('./render.mjs');
const { windowStats } = await import('./motion-metrics.mjs');

// —— 合成帧：可控的球员位置与球 ——
// mkFrames(ballPositions)：frames[i] = {t:i*0.2, players, ball:ballPositions[i]}
// 默认 20 名球员**铺开**（避免叠在同一点）；moveFn 可给每人每帧的位置。
function mkFrames(balls, { moveFn = null, nPlayers = 20 } = {}) {
  return balls.map((b, i) => ({
    t: i * 0.2,
    players: Array.from({ length: nPlayers }, (_, k) => {
      const pos = moveFn ? moveFn(k, i) : { x: 0.08 + (k % 5) * 0.18, y: 0.15 + Math.floor(k / 5) * 0.2 };
      return { id: k + 1, x: pos.x, y: pos.y };   // id 1..n（避开门将 0/21）
    }),
    ball: b, // [x,y] 或 null
  }));
}

// 数一块像素区带里的「亮黄球」像素（#ffe400）。
function countYellow(img, y0, y1) {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (img.data[o] > 200 && img.data[o + 1] > 180 && img.data[o + 2] < 80) n++;
    }
  }
  return n;
}
function countRed(img) {
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    if (img.data[o] > 180 && img.data[o + 1] < 90 && img.data[o + 2] < 90) n++;
  }
  return n;
}

test('render：引擎排与真实排**各自**都画出球（单排丢球必红）', () => {
  const eng = mkFrames([[0.30, 0.40], [0.32, 0.40]]);
  const real = mkFrames([[0.70, 0.60], [0.72, 0.60]]);
  const { canvas, bands } = buildComparison(eng, real, { t0: 0, win: 12, n: 2 });
  const img = canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  const eY = countYellow(img, bands.engine[0], bands.engine[1]);
  const rY = countYellow(img, bands.real[0], bands.real[1]);
  // 两排各自都要有球——**分别**断言，这样「只在引擎排丢球」（原 bug 形态）会红。
  assert.ok(eY > 100, `引擎排没画球（黄像素 ${eY}）——ball 是数组 [x,y]，别用 ball.x`);
  assert.ok(rY > 100, `真实排没画球（黄像素 ${rY}）`);
  assert.ok(countRed(img) > 500, '球员点没画出来');
});

test('render：反证条——把某排的球置 null，那一排的黄像素必须归零', () => {
  // 直接构造「引擎排无球」的输入，断言引擎行带无黄、真实行带有黄。
  // 这证明上面的「引擎排 > 100」断言有区分度（不是恒真）。
  const engNoBall = mkFrames([null, null]);
  const realBall = mkFrames([[0.6, 0.5], [0.62, 0.5]]);
  const { canvas, bands } = buildComparison(engNoBall, realBall, { t0: 0, win: 12, n: 2 });
  const img = canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  assert.strictEqual(countYellow(img, bands.engine[0], bands.engine[1]), 0, '引擎排无球时不该有黄像素（否则断言无区分度）');
  assert.ok(countYellow(img, bands.real[0], bands.real[1]) > 100, '真实排有球应有黄像素');
});

test('render：ballXY 统一 [x,y] 与 {x,y}，null → null', () => {
  assert.deepStrictEqual(ballXY([0.3, 0.4]), [0.3, 0.4]);
  assert.deepStrictEqual(ballXY({ x: 0.3, y: 0.4 }), [0.3, 0.4]);
  assert.strictEqual(ballXY(null), null);
  assert.strictEqual(ballXY(undefined), null);
});

// —— 运动指标：数值断言 + 反证 + 跨窗守卫 ——

// 方向一致性：N 人里 a 个向东、b 个向西 → 两两余弦均值
//   = (C(a,2) + C(b,2) − a·b) / C(a+b,2)
function expectDir(a, b) { const N = a + b; const c = (n) => n * (n - 1) / 2; return (c(a) + c(b) - a * b) / c(N); }

test('motion：方向一致性数值正确（全体同向=1 / 反向按公式）', () => {
  const NF = 60; // 帧数 > step(=20)，保证有窗
  const allEast = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]), { moveFn: (k, i) => ({ x: 0.5 + i * 0.002, y: 0.5 }) });
  assert.ok(Math.abs(windowStats(allEast, 4).dir[0] - 1) < 1e-6, '全同向应 =1');

  // 4 人：2 东 2 西 → -1/3（4 人时为整数情形的经典值）
  const four = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]), { nPlayers: 4, moveFn: (k, i) => ({ x: 0.5 + (k < 2 ? 1 : -1) * i * 0.002, y: 0.5 }) });
  assert.ok(Math.abs(windowStats(four, 4).dir[0] - (-1 / 3)) < 1e-6, `2东2西应 =-1/3，实得 ${windowStats(four, 4).dir[0]}`);

  // 20 人：10 东 10 西 → 按公式 = (45+45−100)/190
  const twenty = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]), { moveFn: (k, i) => ({ x: 0.5 + (k < 10 ? 1 : -1) * i * 0.002, y: 0.5 }) });
  const exp20 = expectDir(10, 10);
  assert.ok(Math.abs(windowStats(twenty, 4).dir[0] - exp20) < 1e-6, `10东10西应 =${exp20}，实得 ${windowStats(twenty, 4).dir[0]}`);
});

test('motion：反证条——方向公式退化成常数必被此断言抓', () => {
  const NF = 60;
  const four = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]), { nPlayers: 4, moveFn: (k, i) => ({ x: 0.5 + (k < 2 ? 1 : -1) * i * 0.002, y: 0.5 }) });
  const d = windowStats(four, 4).dir[0];
  assert.notStrictEqual(d, 1, '恒 1 的公式会被这条抓');
  assert.notStrictEqual(d, 0, '恒 0 的公式会被这条抓');
});

test('motion：跨全窗（窗数 = floor((N-1)/step)，单窗实现必红）', () => {
  // 200 帧、dt=0.2s、win=4s → step=20 → 期望窗数 = floor((200-1)/20) = 9
  const N = 200;
  const frames = mkFrames(Array.from({ length: N }, () => [0.5, 0.5]), { moveFn: (k, i) => ({ x: 0.5 + i * 0.002, y: 0.5 }) });
  const w = windowStats(frames, 4);
  const step = Math.round(4 / 0.2);
  const expected = Math.ceil((N - step) / step); // 循环 i += step，i+step<N
  assert.strictEqual(w.disp.length, expected, `应跨全窗（${expected} 个），实得 ${w.disp.length}——退回单窗实现会变红`);
  assert.strictEqual(w.dir.length, expected, '方向一致性也应在每个有移动的窗上报');
});

test('motion：端点位移数值正确（步数 × 每帧位移）', () => {
  // 每人每帧 x 增 0.002 归一化 → 每帧 0.002*105 = 0.21m；窗 step=20 → 位移 4.2m
  const frames = mkFrames(Array.from({ length: 41 }, () => [0.5, 0.5]), { moveFn: (k, i) => ({ x: 0.5 + i * 0.002, y: 0.5 }) });
  const w = windowStats(frames, 4);
  assert.ok(Math.abs(w.disp[0] - 20 * 0.002 * 105) < 1e-6, `端点位移应 ≈4.2m，实得 ${w.disp[0]}`);
  assert.strictEqual(w.still[0], 0, '一直在动 → 静止占比应为 0');
});

test('motion：静止阈值被真守——含「小幅移动」（>0.05 但 <0.5m）的用例夹死阈值', () => {
  // 关键：要有一个球员**窗内位移落在 0.05 与 0.5 之间**——阈值 0.5 判他"静止"、0.05 判他"在动"。
  // 窗 step=20 帧、每帧位移 d（归一化）→ 窗内 = 20·d·105 m。
  //   想要窗内 0.3m → d = 0.3/(20·105) = 1.4286e-4。
  const NF = 41;
  const d = 0.3 / (20 * 105);
  const frames = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]), {
    moveFn: (k, i) => ({
      // k<10：小幅动 0.3m（阈值 0.5 下算静止）；10<=k<20：大幅动 4.2m（都算在动）
      x: k < 10 ? 0.5 + i * d : 0.5 + i * 0.002,
      y: 0.5,
    }),
  });
  const w = windowStats(frames, 4);
  // 10 人小幅(0.3m) 在 0.5 阈值下算静止 + 10 人大幅在动 → still = 10/20 = 50。
  // 若阈值被改成 0.05：小幅那 10 个（0.3m > 0.05）也算"在动" → still = 0 → 断言变红。
  assert.strictEqual(w.still[0], 50, `0.5 阈值下：10 人 0.3m 算静止 → still=50，实得 ${w.still[0]}（阈值改小会变 0）`);

  const none = mkFrames(Array.from({ length: NF }, () => [0.5, 0.5]));   // 全不动
  assert.strictEqual(windowStats(none, 4).still[0], 100, '全不动应 still=100');
});

test('motion：门将剔除被真守——id 0/21 不参与（含门将位移的对照）', () => {
  // 造 22 人（含门将 0 与 21）：门将**大步移动**，外场不动。
  // 若实现不剔门将，静止占比会 <100；剔了门将，外场全不动 → still=100。
  const NF = 41;
  const frames = Array.from({ length: NF }, (_, i) => {
    const players = [{ id: 0, x: 0.02 + i * 0.02, y: 0.5 }, { id: 21, x: 0.98 - i * 0.02, y: 0.5 }];
    for (let k = 1; k <= 20; k++) players.push({ id: k, x: 0.08 + (k % 5) * 0.18, y: 0.15 + Math.floor(k / 5) * 0.2 });
    return { t: i * 0.2, players, ball: [0.5, 0.5] };
  });
  const w = windowStats(frames, 4);
  assert.strictEqual(w.still[0], 100, `门将移动但已被剔除 → 外场全不动应 still=100，实得 ${w.still[0]}（不剔门将会 <100）`);
  assert.strictEqual(w.disp[0], 0, '外场不动 → 端点位移 0（门将不计入）');
});
