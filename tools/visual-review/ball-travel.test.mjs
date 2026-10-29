// ball-travel 纯函数守护：口径用可手算的合成帧钉死（不依赖 wasm/真实数据，CI 必跑）。
import { test } from 'node:test';
import assert from 'node:assert';
import { ballTravel, travelWindows, FAST_MS, STATIC_MS } from './ball-travel.mjs';

const PITCH = [100, 50]; // 合成球场：x 100m / y 50m，便于手算

// 帧工具：ball 归一化坐标 + 逐场尺寸。
const frame = (t, x, y) => ({ t, pitchMeters: PITCH, ball: [x, y] });

test('ballTravel: 行程/快慢段/静止占比（手算）', () => {
  // 0→1s: 0.5 归一化 x = 50m，v=50 m/s → 快段
  // 1→2s: +0.01 x = 1m，v=1 m/s → 慢段
  // 2→3s: 不动，v=0 → 静止
  // 3→4s: +0.02 x = 2m → 慢段
  const frames = [frame(0, 0.2, 0.5), frame(1, 0.7, 0.5), frame(2, 0.71, 0.5), frame(3, 0.71, 0.5), frame(4, 0.73, 0.5)];
  const r = ballTravel(frames);
  const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
  close(r.path, 53);
  close(r.fast, 50);
  close(r.slow, 3);
  assert.ok(Math.abs(r.staticShare - 0.25) < 1e-12, `staticShare=${r.staticShare}`);
  assert.ok(Math.abs(r.meanSpeed - 53 / 4) < 1e-12);
  assert.strictEqual(r.steps, 4);
});

test('ballTravel: 球帧缺口处断开，不跨缺口累计', () => {
  // 0→1s 正常；1.5s 缺球；2→3s 正常——1→2 与 1.5→2 的位移**不得**计入。
  const frames = [frame(0, 0.2, 0.5), frame(1, 0.3, 0.5), { t: 1.5, pitchMeters: PITCH, ball: null }, frame(2, 0.9, 0.5), frame(3, 0.95, 0.5)];
  const r = ballTravel(frames);
  assert.ok(Math.abs(r.path - 15) < 1e-9, `path=${r.path}`); // 0.1×100 + 0.05×100；缺口段不计
  assert.strictEqual(r.steps, 2);
  // 静止占比分母也只用连续段时长：2 段 × 1s = 2s（不是全窗 3s）。
  assert.ok(Math.abs(r.staticShare - 0) < 1e-12);
});

test('ballTravel: 快/慢段与静止阈值的判别（避开浮点边界本身）', () => {
  // 1s 内 8.5m（> FAST_MS）→ 快段；再 1s 内 0.4m（< STATIC_MS）→ 慢段且计静止。
  // 注意不测「恰好 = 阈值」：0.08×100 在浮点下可能落 7.999…——边界等值不是本工具的契约。
  const frames = [frame(0, 0.5, 0.5), frame(1, 0.585, 0.5), frame(2, 0.585 + 0.004, 0.5)];
  const r = ballTravel(frames);
  assert.ok(Math.abs(r.fast - 8.5) < 1e-9, `fast=${r.fast}`);
  assert.ok(Math.abs(r.slow - 0.4) < 1e-9, `slow=${r.slow}`);
  assert.ok(r.staticShare > 0.49 && r.staticShare < 0.51, `staticShare=${r.staticShare}`);
  assert.ok(FAST_MS === 8 && STATIC_MS === 0.5);
});

test('travelWindows: 逐窗算、窗数正确、不跨窗拼接', () => {
  const frames = [];
  for (let i = 0; i <= 24; i += 1) frames.push(frame(i, 0.2 + 0.01 * i, 0.5)); // 恒速 1 m/s
  const wins = travelWindows(frames, { win: 12 });
  assert.strictEqual(wins.length, 2); // [0,12] [12,24]
  for (const w of wins) assert.ok(Math.abs(w.path - 12) < 1e-9, JSON.stringify(w));
});
