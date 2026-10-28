// ratchet 的纯函数与登记表守护测试（不跑三个慢采集器，故可在 CI 秒级执行）。
//
// 守两件事：
//   1. `judge()` 的方向语义——「变差」必须真的按 dir 判，band 类必须看「离带多远」。
//   2. `METRICS` 登记表自洽——id 唯一、每条有 regex/caliber、band 类必须有 band。
// 采集器本身（collect）依赖 wasm 与真实帧，属本地/change 级工具，不在此测。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { METRICS, judge } = await import(new URL('./ratchet.mjs', import.meta.url));

const byId = Object.fromEntries(METRICS.map((m) => [m.id, m]));

test('higher：下降=变差，上升=改善，相等=持平', () => {
  const m = { dir: 'higher' };
  assert.equal(judge(m, 6.27, 6.0), 'regress');
  assert.equal(judge(m, 6.27, 7.0), 'improve');
  assert.equal(judge(m, 6.27, 6.27), 'same');
});

test('lower：上升=变差，下降=改善', () => {
  const m = { dir: 'lower' };
  assert.equal(judge(m, 0.54, 0.60), 'regress');
  assert.equal(judge(m, 0.54, 0.50), 'improve');
  assert.equal(judge(m, 0.54, 0.54), 'same');
});

test('band：带内=不退化（含朝边缘走）；带外越远越退化、越近越改善', () => {
  const m = { dir: 'band', band: [7.015, 14.015] };
  assert.equal(judge(m, 7.5, 20.0), 'regress');   // 带内 → 带外
  assert.equal(judge(m, 20.0, 7.5), 'improve');   // 带外 → 带内
  assert.equal(judge(m, 7.5, 8.0), 'same');       // 都在带内 → 不退化
  assert.equal(judge(m, 10.5, 13.9), 'same');     // 带内、朝上边缘走 → 不退化（2026-10-28 语义）
  assert.equal(judge(m, 13.9, 10.5), 'same');     // 带内、朝带心走 → 不退化
});

test('band：带外但更接近带 = 改善；带外更远 = 变差', () => {
  const m = { dir: 'band', band: [6.54, 10.14] };
  assert.equal(judge(m, 18.0, 12.0), 'improve');
  assert.equal(judge(m, 12.0, 18.0), 'regress');
});

test('report 类永远不参与退化判定', () => {
  assert.equal(judge({ dir: 'report' }, 5.0, 1.0), 'report');
});

test('抖动容差：极小变化记为持平（避免浮点噪声刷红）', () => {
  const m = { dir: 'higher' };
  assert.equal(judge(m, 0.37, 0.3700001), 'same');
  assert.equal(judge(m, 100, 100.004), 'same');   // 相对容差 1e-4
});

test('登记表：id 唯一', () => {
  const ids = METRICS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
});

test('登记表：每条都有 label / source / dir / caliber / regex', () => {
  for (const m of METRICS) {
    assert.ok(m.label, `${m.id} 缺 label`);
    assert.ok(['like', 'criteria', 'p18'].includes(m.source), `${m.id} source 非法：${m.source}`);
    assert.ok(['higher', 'lower', 'band', 'report'].includes(m.dir), `${m.id} dir 非法：${m.dir}`);
    assert.ok(m.caliber && m.caliber.length > 4, `${m.id} 缺口径说明`);
    assert.ok(m.re instanceof RegExp, `${m.id} 缺 regex`);
  }
});

test('登记表：band 类必须给出二元 band，其余不得有 band', () => {
  for (const m of METRICS) {
    if (m.dir === 'band') {
      assert.ok(Array.isArray(m.band) && m.band.length === 2, `${m.id} 缺 band`);
      assert.ok(m.band[0] < m.band[1], `${m.id} band 顺序反了`);
    } else {
      assert.equal(m.band, undefined, `${m.id} 非 band 类不该有 band`);
    }
  }
});

test('登记表：口径必须能区分来源（不允许 source 相同但口径文案看不出种子/锚）', () => {
  for (const m of METRICS) {
    assert.match(m.caliber, /(seed|canary|10 seed|5 seed)/, `${m.id} 口径未写种子数：${m.caliber}`);
  }
});

test('关键指标在册（防止误删导致 ratchet 静默少测）', () => {
  for (const id of ['lf.disp', 'lf.lat', 'lf.distance', 'p38.latSd', 'p38.gap', 'p38.shotsReg', 'p18.a1', 'p18.a2', 'p18.b4']) {
    assert.ok(byId[id], `缺关键指标 ${id}`);
  }
});
