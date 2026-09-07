// 渲染层测试（task 6.2 像素断言：无视觉依赖）
// 用 MockCanvas 记录绘制调用，断言球员/球渲染在正确位置。
// 覆盖：开球时主客队位置、传球后球移动、球场白线绘制。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockCanvas } from './mock-canvas.js';
import { drawPitch, drawPlayer, drawBall, drawCard, renderFrame } from './renderer.js';
import { config } from './config.js';

const W = config.canvas.width;
const H = config.canvas.height;

function mockState(players, ball) {
  return { players, ball };
}

test('drawPitch: 绘制了草地 + 白线', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  drawPitch(ctx, W, H);
  const calls = ctx.calls;
  // 草地 fillRect
  assert.ok(calls.some((c) => c.method === 'fillRect'), '应绘制草地');
  // 白线 stroke
  assert.ok(calls.some((c) => c.method === 'stroke'), '应绘制白线');
});

test('drawPlayer: home 球员用主队色', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  drawPlayer(ctx, 0.5, 0.5, 5, W, H);
  const arc = ctx.calls.find((c) => c.method === 'arc');
  assert.ok(arc, '应绘制球员圆点');
  // 绘制球员时设置了主队色
  const colored = ctx.calls.find((c) => c.fillStyle === config.render.homeColor);
  assert.ok(colored, 'home 球员应主队色');
});

test('renderFrame: 开球时 22 球员渲染在主客队位置', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  // 构造一个简单的开球状态：home 在左半场，away 在右半场
  const players = [];
  for (let i = 0; i < 11; i++) players.push({ id: i, x: 0.2, y: 0.3 + i * 0.05 });
  for (let i = 11; i < 22; i++) players.push({ id: i, x: 0.8, y: 0.3 + (i - 11) * 0.05 });
  const ball = { x: 0.5, y: 0.5 };
  renderFrame(ctx, mockState(players, ball), W, H);
  // 断言 home 球员圆点中心在左半场，away 在右半场
  // 只匹配球员/门将圆点（radius = playerRadius 或 keeperRadius，排除点球点/中圈等球场元素）
  const isPlayerArc = (c) =>
    c.method === 'arc' && (c.args[2] === config.render.playerRadius || c.args[2] === config.render.keeperRadius);
  const arcs = ctx.calls.filter(isPlayerArc);
  const homeArcs = arcs.filter((c) => c.fillStyle === config.render.homeColor);
  const awayArcs = arcs.filter((c) => c.fillStyle === config.render.awayColor);
  assert.equal(homeArcs.length, 11, `应有 11 个主队圆点，实际 ${homeArcs.length}`);
  assert.equal(awayArcs.length, 11, `应有 11 个客队圆点，实际 ${awayArcs.length}`);
  for (const a of homeArcs) assert.ok(a.args[0] < W / 2, `主队应在左半场，px=${a.args[0]}`);
  for (const a of awayArcs) assert.ok(a.args[0] > W / 2, `客队应在右半场，px=${a.args[0]}`);
});

test('renderFrame: 传球后球像素位置移动', () => {
  // 直接断言球在不同归一化位置时，arc 的中心像素不同
  const c1 = new MockCanvas(W, H);
  const ctx1 = c1.getContext();
  const p1 = { x: 0.4, y: 0.5 };
  drawBall(ctx1, p1.x, p1.y, W, H);
  const arc1 = ctx1.calls.find((c) => c.method === 'arc');
  const cx1 = arc1.args[0];

  const c2 = new MockCanvas(W, H);
  const ctx2 = c2.getContext();
  const p2 = { x: 0.6, y: 0.5 };
  drawBall(ctx2, p2.x, p2.y, W, H);
  const arc2 = ctx2.calls.find((c) => c.method === 'arc');
  const cx2 = arc2.args[0];

  assert.notEqual(cx1, cx2, '球位置不同，像素应不同');
});

test('P6 批次1 drawBall: h 大小表示高度（h=0 基础半径，h>0 放大）', () => {
  const radiusOf = (h) => {
    const c = new MockCanvas(W, H);
    const ctx = c.getContext();
    drawBall(ctx, 0.5, 0.5, W, H, h);
    const arc = ctx.calls.find((x) => x.method === 'arc');
    return arc.args[2];
  };
  const r0 = radiusOf(0);
  const rHigh = radiusOf(0.8);
  // 公式：半径 × (1 + h × 1.5)，h=0.8 → 放大 2.2 倍
  assert.ok(rHigh > r0 * 1.5, `h=0.8 球应显著放大（r0=${r0}, rHigh=${rHigh}）`);
  // h=0 用基础半径
  assert.equal(r0, config.render.ballRadius);
});

test('drawCard: 黄牌画黄色圆角矩形、红牌画红色，位置在球员上方', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  drawCard(ctx, 0.5, 0.5, 'yellow', W, H);
  const yellowRect = ctx.calls.find((x) => x.method === 'fillRect');
  assert.ok(yellowRect, '牌应画矩形（fillRect）');
  assert.equal(yellowRect.fillStyle, '#ffd43b', '黄牌矩形应使用黄色填充');

  const c2 = new MockCanvas(W, H);
  const ctx2 = c2.getContext();
  drawCard(ctx2, 0.5, 0.5, 'red', W, H);
  const redRect = ctx2.calls.find((x) => x.method === 'fillRect');
  assert.ok(redRect, '牌应画矩形（fillRect）');
  assert.equal(redRect.fillStyle, '#e03131', '红牌矩形应使用红色填充');
});

test('renderFrame: 传入 cards 时画出牌（叠加在球员之上）', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  const players = [{ id: 15, x: 0.5, y: 0.5 }];
  renderFrame(ctx, mockState(players, { x: 0.6, y: 0.5 }), W, H, { cards: [{ x: 0.5, y: 0.5, card: 'red' }] });
  const redRect = ctx.calls.find((x) => x.method === 'fillRect' && x.fillStyle === '#e03131');
  assert.ok(redRect, 'renderFrame 传 cards 应画出红牌');
});
