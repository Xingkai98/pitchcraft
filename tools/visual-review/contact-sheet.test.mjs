// contact-sheet 的守护测试。**纯函数** buildContactSheet（吃合成帧）→ CI 必跑。
//
// 本工具存在的理由：单张图装不下跨时间的形态。要夹死的是「多窗」这件事本身——
// 若它退化成只渲一窗，就变回 render.mjs，"机械分边是否每窗都在" 又看不见了。
import { test } from 'node:test';
import assert from 'node:assert';

const { buildContactSheet, CS_PW, CS_PH, CS_G, CS_HDR, CS_TOP } = await import('./contact-sheet.mjs');

const mkFrames = (n, off = 0) => Array.from({ length: n }, (_, i) => ({
  t: i * 0.2,
  players: Array.from({ length: 20 }, (_, k) => ({ id: k + 1, x: 0.1 + (k % 5) * 0.18 + off, y: 0.15 + Math.floor(k / 5) * 0.2 })),
  ball: [0.5, 0.5],
}));

function countYellow(img) {
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) if (img.data[o] > 200 && img.data[o + 1] > 180 && img.data[o + 2] < 80) n++;
  return n;
}

test('contact-sheet：布局——高度随窗数、宽度随帧数', () => {
  const ef = mkFrames(2000); const rf = mkFrames(2000);
  const one = buildContactSheet(ef, rf, { t0s: [200], win: 12, n: 6 });
  const three = buildContactSheet(ef, rf, { t0s: [200, 1200, 3000], win: 12, n: 6 });
  // ⚠️ H 由 t0s.length 算出，**不是**「实际画了几窗」的证据（见下一条：内容断言才是）。
  assert.strictEqual(three.H - one.H, 2 * 2 * (CS_PH + CS_TOP), '每窗应加「引擎+真实」两行的高度');
  assert.strictEqual(three.W, 6 * CS_PW + 7 * CS_G, '宽度应 = n×面板宽 + (n+1)×间距');
});

test('★ contact-sheet：**每一窗都真的画了**（数已画内容，不数布局——布局是空转）', () => {
  // 本仓教训：「能数的量才夹得死」。H 由 t0s.length 算出，即使循环只画 1 窗 H 也不变 →
  // 高度断言会**漏掉**「退化成单窗」的变异。所以这里数**黄球像素总数**，要求它随窗数线性增长：
  // 三窗的球像素 ≈ 三倍单窗。若循环被改成只画第一窗，比值会掉回 ~1 → 变红。
  const img = ({ canvas }) => canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  const y1 = countYellow(img(buildContactSheet(mkFrames(2000), mkFrames(2000), { t0s: [200], win: 12, n: 6 })));
  const y3 = countYellow(img(buildContactSheet(mkFrames(2000), mkFrames(2000), { t0s: [200, 1200, 3000], win: 12, n: 6 })));
  assert.ok(y3 > y1 * 2.5, `三窗球像素应 ≈3× 单窗（证明三窗都画了），实得 y1=${y1} y3=${y3}——只画一窗会掉回 ~1×`);
});

test('★ contact-sheet：**引擎行与真实行各自都画了球**（分排——删掉整条 REAL 行必红）', () => {
  // 本仓 render.mjs 的纪律：「单排丢球」是最该防的原 bug 形态——网格图（对比工具）更不能丢一排。
  // 只数全图总量是空转：删掉整条 REAL 行后总量仍 >1000（12 球），4 条测试全绿（飞轮 review P1）。
  // 故**按 rows 的行带分别数**：引擎各行、真实各行都必须有球。
  const { canvas, rows } = buildContactSheet(mkFrames(2000), mkFrames(2000), { t0s: [200, 1200], win: 12, n: 6 });
  const img = canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  const yIn = (y0, y1) => { let n = 0; for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 4; if (img.data[o] > 200 && img.data[o + 1] > 180 && img.data[o + 2] < 80) n++; } return n; };
  const engineRows = rows.filter(r => r.src === 'E'), realRows = rows.filter(r => r.src === 'R');
  assert.strictEqual(engineRows.length, 2, '应有 2 条引擎行');
  assert.strictEqual(realRows.length, 2, '应有 2 条真实行');
  for (const r of engineRows) assert.ok(yIn(r.y0, r.y1) > 100, `引擎行 t0=${r.t0} 没画球（黄像素 ${yIn(r.y0, r.y1)}）`);
  for (const r of realRows) assert.ok(yIn(r.y0, r.y1) > 100, `真实行 t0=${r.t0} 没画球（黄像素 ${yIn(r.y0, r.y1)}）——删掉 REAL 行必须在此变红`);
});

test('★ contact-sheet：rows 覆盖「每一窗 × 两个源」（缺行/漏窗必红）', () => {
  const { rows } = buildContactSheet(mkFrames(2000), mkFrames(2000), { t0s: [200, 1200, 3000], win: 12, n: 6 });
  for (const t0 of [200, 1200, 3000]) for (const src of ['E', 'R']) {
    assert.ok(rows.some(r => r.src === src && r.t0 === t0), `缺行：src=${src} t0=${t0}——rows 与实际画出的行同源，缺了就是真没画`);
  }
});

test('反证条：**行带之外的空白带黄像素 ≈0**（证明分排阈值的 >100 是真信号，非噪声）', () => {
  // 分排断言的区分度靠外部变异证明（删掉 REAL 行 → 上一条红，飞轮 review M4 实跑确认）。
  // 这里补一条**输入级**反证：行与行之间的**间隙带**（不画任何球）黄像素必须 ≈0——
  // 若间隙带也有 >100 黄，则「某行带 >100」就不能证明该行真的画了球（阈值无区分度）。
  const { canvas, rows } = buildContactSheet(mkFrames(2000), mkFrames(2000), { t0s: [200, 1200], win: 12, n: 6 });
  const img = canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  const yIn = (y0, y1) => { let n = 0; for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 4; if (img.data[o] > 200 && img.data[o + 1] > 180 && img.data[o + 2] < 80) n++; } return n; };
  // 第 0 行底 到 第 1 行顶 之间是纯间隙（CS_TOP 高的横条，无面板）。
  const gapBand = yIn(rows[0].y1, rows[1].y0);
  assert.ok(gapBand < 20, `行间隙带不该有球像素（实得 ${gapBand}）——否则分排阈值无区分度`);
  // 对照：真实行带确实 >100（证明阈值两侧确有差别）。
  const r0 = rows.find(r => r.src === 'R');
  assert.ok(yIn(r0.y0, r0.y1) > 100, '对照：真实行带应 >100（否则反证条无意义）');
});

test('contact-sheet：反证条——球全 null 时黄像素归零（证明球断言有区分度）', () => {
  const noBall = Array.from({ length: 2000 }, (_, i) => ({ t: i * 0.2, players: mkFrames(1)[0].players, ball: null }));
  const { canvas } = buildContactSheet(noBall, noBall, { t0s: [200, 1200], win: 12, n: 6 });
  const img = canvas.getContext().getImageData(0, 0, canvas.width, canvas.height);
  assert.strictEqual(countYellow(img), 0, '球全 null 时不该有黄像素（否则球断言无区分度）');
});
