// viewer-match 的守护测试。**纯函数/纯解析**（不依赖 wasm，CI 必跑）。
//
// 本模块存在的理由：主 session 一直量 90 分钟聚合、用户看 5 分钟窗口 → 「你看的和我看的不一样」。
// 唯一的防重犯手段：**把「用户看到的那场」钉成常量，且从 viewer 源码读 + 漂移即红**。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { VIEWER, viewerConfig } = await import('./viewer-match.mjs');

test('★ viewer-match：VIEWER 钉在**已验证的常量**（seed=42 / 5 分钟）——viewer 改了配置，此测试红、强迫你重跑对照', () => {
  // ⚠️ 关键：VIEWER 是**从真文件解析**出来的（读了文件）。若本测试也只用解析值比对，两侧同读一个
  // 被改过的文件 → 永远一致 → **恒真、变异抓不到**（本仓教训：反证条必须对目标变异有区分度）。
  // 所以这里把**我们验证过的那场**（seed 42 / 5 分钟）写成**字面常量**：viewer 一改配置，
  // 解析值与字面值不符 → 红 → 强迫「重跑 5 分钟对照 + 有意更新这里」（防静默漂移，正是本问题根因）。
  const VALIDATED = { seed: 42, matchMinutes: 5 };
  assert.strictEqual(VIEWER.seed, VALIDATED.seed, `真 viewer 的 FIXED_SEED 变成 ${VIEWER.seed}（验证时是 ${VALIDATED.seed}）——viewer 那场换了，重跑 5 分钟对照并更新 VALIDATED`);
  assert.strictEqual(VIEWER.matchMinutes, VALIDATED.matchMinutes, `真 viewer 的 matchDuration 变成 ${VIEWER.matchMinutes} 分钟（验证时是 ${VALIDATED.matchMinutes}）——同上`);
  // 顺带确认解析正则**确实命中了真文件**（不是靠缺省值蒙混）。
  assert.strictEqual(typeof VIEWER.durationSec, 'number');
  assert.ok(VIEWER.durationSec > 0);
});

test('viewerConfig 与导出的 VIEWER 一致（同一真值）', () => {
  assert.deepStrictEqual(viewerConfig(ROOT), VIEWER);
});
