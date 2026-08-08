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
  const players = [
    { id: 5, x: 0.4, y: 0.5 },
    { id: 6, x: 0.6, y: 0.5 },
  ];
  const movingIds = new Set([6]);
  resetMicroMotion();
  for (let i = 0; i < 40; i++) microMotionFade(5, true, 1 / 60);
  const norm = config.pitchMargin;
  const px5 = norm + 0.4 * (W - 2 * norm);
  const px6 = norm + 0.6 * (W - 2 * norm);
  const pyMid = norm + 0.5 * (H - 2 * norm);
  // 幅度断言（与相位无关）：扫多个 t，静止球员 5 至少在某个 t 偏移 > 0.5px；移动球员 6 始终无偏移
  let anyOffset = false;
  for (const t of [100.0, 100.5, 101.0, 101.7]) {
    const c2 = new MockCanvas(W, H);
    const ctx2 = c2.getContext();
    renderFrame(ctx2, { players, ball: { x: 0.5, y: 0.5 } }, W, H, { playTime: t, movingIds, dt: 1 / 60 });
    const isPlayerArc = (cc) => cc.method === 'arc' && cc.args[2] === config.render.playerRadius;
    const arcs = c2.getContext().calls.filter(isPlayerArc);
    assert.equal(arcs.length, 2);
    // 按 x 归属：靠近 px5 的是 id5，靠近 px6 的是 id6
    const sorted = [...arcs].sort((a, b) => a.args[0] - b.args[0]); // 左(id5)右(id6)
    const arc5 = sorted[0];
    const arc6 = sorted[1];
    const off6 = Math.hypot(arc6.args[0] - px6, arc6.args[1] - pyMid);
    assert.ok(off6 < 0.5, `移动球员 6 应无偏移（px=${arc6.args[0]},py=${arc6.args[1]}）`);
    const off5 = Math.hypot(arc5.args[0] - px5, arc5.args[1] - pyMid);
    if (off5 > 0.5) { anyOffset = true; break; }
  }
  assert.ok(anyOffset, '静止球员 5 应有 micro-motion 偏移（幅度 > 0.5px，相位无关）');
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
