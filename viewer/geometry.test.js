// 几何纯函数单测（tasks 6.1：坐标映射）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedToPixels, pixelsToNormalized, pitchLines } from './geometry.js';

const W = 700, H = 450, M = 20;

test('normalizedToPixels: (0,0)→左下角', () => {
  const { px, py } = normalizedToPixels(0, 0, W, H, M);
  assert.equal(px, M);
  assert.equal(py, H - M); // y=0 是下边线 → py 大
});

test('normalizedToPixels: (1,1)→右上角', () => {
  const { px, py } = normalizedToPixels(1, 1, W, H, M);
  assert.equal(px, W - M);
  assert.equal(py, M);
});

test('normalizedToPixels: (0.5,0.5)→中心', () => {
  const { px, py } = normalizedToPixels(0.5, 0.5, W, H, M);
  assert.ok(Math.abs(px - W / 2) < 1e-6);
  assert.ok(Math.abs(py - H / 2) < 1e-6);
});

test('normalizedToPixels: 越界钳制到边界（不抛错）', () => {
  // 球进网 x 可略超 1.0，应钳制到画布右缘而非崩溃
  const p1 = normalizedToPixels(1.1, 0.5, W, H, M);
  assert.equal(p1.px, W - M); // 钳到右缘
  const p2 = normalizedToPixels(0.5, -0.1, W, H, M);
  assert.equal(p2.py, H - M); // 钳到底部
  const p3 = normalizedToPixels(-0.1, 0.5, W, H, M);
  assert.equal(p3.px, M); // 钳到左缘
});

test('pixelsToNormalized 与 normalizedToPixels 互逆', () => {
  const orig = { x: 0.37, y: 0.62 };
  const px = normalizedToPixels(orig.x, orig.y, W, H, M);
  const back = pixelsToNormalized(px.px, px.py, W, H, M);
  assert.ok(Math.abs(back.x - orig.x) < 1e-6);
  assert.ok(Math.abs(back.y - orig.y) < 1e-6);
});

test('pitchLines: 有边线/中线/中圈/禁区', () => {
  const lines = pitchLines();
  assert.ok(lines.some((l) => l.type === 'line' && l.x1 === 0 && l.y1 === 0)); // 下边线
  assert.ok(lines.some((l) => l.type === 'line' && l.x1 === 0.5)); // 中线
  assert.ok(lines.some((l) => l.type === 'circle')); // 中圈
  assert.ok(lines.some((l) => l.type === 'line' && l.x1 === 1 - 0.16)); // 右禁区
});
