// micro-motion 测试（P5 S3）：确定性、振幅、启停渐变、渲染偏移、逻辑位置不变
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockCanvas } from './mock-canvas.js';
import { renderFrame } from './renderer.js';
import { config } from './config.js';
import { hashPlayer, microMotionOffset, microMotionFade, resetMicroMotion } from './micro-motion.js';

const W = config.canvas.width;
const H = config.canvas.height;

test('micro-motion: 确定性（同 id 同 t → 同偏移）', () => {
  const a = microMotionOffset(5, 10.5);
  const b = microMotionOffset(5, 10.5);
  assert.deepEqual(a, b);
  // 不同 t → 不同偏移（波形连续变化）
  const c = microMotionOffset(5, 10.6);
  assert.ok(Math.abs(a.dx - c.dx) > 1e-9 || Math.abs(a.dy - c.dy) > 1e-9, '不同时刻偏移应不同');
});

test('micro-motion: 振幅 < 0.002 归一化', () => {
  for (let id = 0; id < 22; id++) {
    for (const t of [0, 0.5, 1.3, 7.7, 100.2]) {
      const off = microMotionOffset(id, t);
      const amp = Math.hypot(off.dx, off.dy);
      assert.ok(amp < 0.002, `id=${id} t=${t} 振幅 ${amp} 应 < 0.002`);
    }
  }
});

test('micro-motion: hashPlayer 确定性且 22 人互异', () => {
  const seen = new Set();
  for (let id = 0; id < 22; id++) {
    const h = hashPlayer(id);
    assert.ok(!seen.has(h), `hash 应互异: id=${id}`);
    seen.add(h);
  }
});

test('micro-motion: 启停渐变（active→1，非 active→0，~0.3s 收敛）', () => {
  resetMicroMotion();
  // 从不 active 开始 → 逼近 0
  let f = microMotionFade(3, false, 1 / 60);
  assert.ok(f === 0, `初始不 active 应为 0，实际 ${f}`);
  // 切换 active → 渐近 1（~0.3s，即 18 帧）
  for (let i = 0; i < 30; i++) f = microMotionFade(3, true, 1 / 60);
  assert.ok(f >= 0.99, `active 后应渐近 1，实际 ${f}`);
  // 切回不 active → 渐近 0
  for (let i = 0; i < 30; i++) f = microMotionFade(3, false, 1 / 60);
  assert.ok(f <= 0.01, `不 active 后应渐近 0，实际 ${f}`);
});

test('renderFrame: 静止球员有 micro-motion 偏移，移动球员无', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  // 球员 5 静止（不在 movingIds），球员 6 移动（在 movingIds）
  const players = [
    { id: 5, x: 0.4, y: 0.5 },
    { id: 6, x: 0.6, y: 0.5 },
  ];
  const movingIds = new Set([6]);
  // 用固定 t 让偏移非零
  const t = 100.0;
  resetMicroMotion();
  // 先让 fade 到 1（对 id5 调一次 active fade 多次）
  for (let i = 0; i < 40; i++) microMotionFade(5, true, 1 / 60);
  renderFrame(ctx, { players, ball: { x: 0.5, y: 0.5 } }, W, H, { playTime: t, movingIds, dt: 1 / 60 });
  const isPlayerArc = (c) =>
    c.method === 'arc' && (c.args[2] === config.render.playerRadius);
  const arcs = ctx.calls.filter(isPlayerArc);
  // 2 个球员圆点
  assert.equal(arcs.length, 2);
  // id5 静止 → 有偏移（px ≠ 逻辑位置像素）；id6 移动 → 无偏移（px == 逻辑位置像素）
  const norm = config.pitchMargin;
  const px5 = norm + 0.4 * (W - 2 * norm);
  const px6 = norm + 0.6 * (W - 2 * norm);
  const arc5 = arcs[0];
  const arc6 = arcs[1];
  assert.ok(Math.abs(arc5.args[0] - px5) > 0.5, `静止球员 5 应有偏移（px=${arc5.args[0]} vs ${px5}）`);
  assert.ok(Math.abs(arc6.args[0] - px6) < 0.5, `移动球员 6 应无偏移（px=${arc6.args[0]} vs ${px6}）`);
});

test('renderFrame: 不修改逻辑位置', () => {
  const c = new MockCanvas(W, H);
  const ctx = c.getContext();
  const players = [{ id: 5, x: 0.4, y: 0.5 }];
  const before = { x: players[0].x, y: players[0].y };
  renderFrame(ctx, { players, ball: { x: 0.5, y: 0.5 } }, W, H, { playTime: 1.5, movingIds: new Set(), dt: 1 / 60 });
  assert.equal(players[0].x, before.x, '逻辑位置不应被 micro-motion 修改');
  assert.equal(players[0].y, before.y);
});
