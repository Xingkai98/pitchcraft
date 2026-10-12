// `spacing-sweep` 并发路径的守护测试（#152）。
//
// 守的核心不变量：**并发 == 串行**——同一 seed 集合、同一 `DUR`/`STEP`、同一 detector 下，
// ① 每个 seed 的结果逐位相同、② 结果按**入参 seed 序**返回（与完成顺序无关）、
// ③ 每个 seed **恰好跑一次**、④ 退出码语义相同。判据/采样密度/阈值**不在**本测试的守护面内
// （它们本 change 未动，且由 `cargo test` + sweep 门自己守）。
//
// 覆盖边界（如实写，勿当全覆盖）：调度面的性质用**注入的确定性假 runner** 覆盖（快、且能
// 构造「完成顺序颠倒」）；真实 wasm 路径的等价性用**缩小窗口数**的实跑覆盖——`DUR` 保持
// production 的 5400（事件流与 `Game` 构造是真实规模），只把 `STEP` 调粗以少跑几窗。
// 完整的 8 seed × 2157 窗并发/串行对照是 change 报告里的人工复验项，不在单测里（太贵）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_AUDIT_PROFILE } from './detectors.mjs';
import {
  DEFAULT_DUR,
  DEFAULT_SEEDS,
  DEFAULT_STEP,
  WASM_PATH,
  formatSeedLine,
  instantiateWasm,
  parseSeeds,
  resolveConcurrency,
  runConcurrent,
  runPool,
  runSeed,
  runSerial,
  runSweep,
  sweepExitCode,
  totalFindings,
} from './spacing-sweep-core.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'spacing-sweep.mjs');

// 等价判据：**逐位**比较两条路径的结果（含顺序）。compare 反证条见下。
function resultsIdentical(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 收集 log/logError 的假 sink（`runSweep` 的输出注入点）。
function makeSink() {
  const lines = [];
  return { lines, sink: (s) => lines.push(String(s)) };
}

test('parseSeeds：空参数 → 默认 seed 集（顺序不变）；显式参数按给定顺序', () => {
  assert.deepEqual(parseSeeds([]), DEFAULT_SEEDS);
  assert.deepEqual(parseSeeds(['42', '1', '2']), [42, 1, 2]);
});

test('resolveConcurrency：默认 min(4, CPU)；被 seed 数收窄；env=1 → 串行；非法值报错', () => {
  assert.equal(resolveConcurrency({ env: undefined, seedCount: 8, cpus: 4 }), 4);
  assert.equal(resolveConcurrency({ env: undefined, seedCount: 2, cpus: 4 }), 2);
  assert.equal(resolveConcurrency({ env: undefined, seedCount: 8, cpus: 2 }), 2);
  assert.equal(resolveConcurrency({ env: '1', seedCount: 8, cpus: 4 }), 1);
  assert.equal(resolveConcurrency({ env: '8', seedCount: 8, cpus: 4 }), 8);
  assert.equal(resolveConcurrency({ env: '', seedCount: 8, cpus: 4 }), 4); // 空串 = 未设置
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    assert.throws(() => resolveConcurrency({ env: bad, seedCount: 8, cpus: 4 }), /SWEEP_CONCURRENCY/);
  }
});

test('runPool：结果按入参序返回（完成序颠倒也如此）、每 seed 恰好一次、并发不超上限', async () => {
  const seeds = [42, 1, 2, 3, 7];
  const started = [];
  const inflight = { now: 0, max: 0 };
  const results = await runPool({
    seeds,
    concurrency: 2,
    runSeed: async (seed) => {
      started.push(seed);
      inflight.now += 1;
      inflight.max = Math.max(inflight.max, inflight.now);
      // 刻意让**先入参的 seed 后完成**：完成序 ≠ 入参序
      await new Promise((r) => setTimeout(r, seed === 42 ? 40 : 1));
      inflight.now -= 1;
      return { seed, windows: 1, findings: 0, worst: null };
    },
  });
  assert.deepEqual(results.map((r) => r.seed), seeds, '结果必须按入参 seed 序');
  assert.deepEqual([...started].sort((a, b) => a - b), [...seeds].sort((a, b) => a - b), '每 seed 恰好跑一次');
  assert.equal(started.length, seeds.length, '不得多跑');
  assert.ok(inflight.max <= 2, `并发不得超过上限（实测 ${inflight.max}）`);
});

test('runPool：单 seed 也能跑（concurrency > seed 数）', async () => {
  const results = await runPool({
    seeds: [7],
    concurrency: 4,
    runSeed: async (seed) => ({ seed, windows: 1, findings: 0, worst: null }),
  });
  assert.deepEqual(results.map((r) => r.seed), [7]);
});

test('反证条：等价判据对「少一个 seed / 顺序颠倒 / 数值不同」都有区分度', () => {
  const base = [
    { seed: 42, windows: 10, findings: 0, worst: null },
    { seed: 1, windows: 10, findings: 1, worst: 1.957 },
  ];
  assert.ok(resultsIdentical(base, structuredClone(base)), '自反：相同输入必须判等价');
  assert.ok(!resultsIdentical(base, base.slice(0, 1)), '少一个 seed 必须判不等价');
  assert.ok(!resultsIdentical(base, [base[1], base[0]]), '顺序颠倒必须判不等价');
  assert.ok(
    !resultsIdentical(base, [base[0], { ...base[1], findings: 0 }]),
    'finding 数不同（少报一条）必须判不等价'
  );
  assert.ok(
    !resultsIdentical(base, [base[0], { ...base[1], worst: 1.958 }]),
    '最恶劣间距不同必须判不等价'
  );
});

test('并发 == 串行（真实 wasm，逐位一致）：结果、输出行、退出码', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  // DUR 保持 production 的 5400（事件流与 `Game` 构造是真实规模）；STEP 调粗以少跑窗口
  // ——判据面（DUR/STEP/阈值）在 production 里由 CLI 固定，本测试只比「两条执行路径是否等价」。
  // seed 数(3) > worker 数(2)：同时覆盖「空闲分发 + 多于一轮」。
  const seeds = [42, 59, 1]; // 59 = 含红牌的 seed（覆盖「罚下幽灵」路径）
  const opts = { seeds, dur: 5400, step: 1200 };

  const serial = await runSerial({ ...opts, wasmPath: WASM_PATH });
  const concurrent = await runConcurrent({ ...opts, concurrency: 2, wasmPath: WASM_PATH });

  assert.ok(
    resultsIdentical(serial, concurrent),
    `并发与串行结果必须逐位一致：\nserial=${JSON.stringify(serial)}\nconcurrent=${JSON.stringify(concurrent)}`
  );
  assert.deepEqual(concurrent.map(formatSeedLine), serial.map(formatSeedLine), '输出行必须一致');
  assert.equal(sweepExitCode(totalFindings(concurrent)), sweepExitCode(totalFindings(serial)), '退出码语义必须一致');
});

test('门被悄悄放宽必须变红：钉死 DUR / STEP / 默认 seed 集 / 窗口数', () => {
  // 这些常量是**门的判据面**（采样密度与范围）。门自己守不了自己（所有 seed 的 finding 恒 0
  // ⇒ 放宽密度只会让门更容易变绿），`cargo test` 也看不到 JS 常量 ⇒ 只能在这里钉死。
  // #152 审阅 P2-1 实测：把 STEP 改成 25 或 DUR 改成 2700，原套件 8/8 全绿。
  assert.equal(DEFAULT_DUR, 5400);
  assert.equal(DEFAULT_STEP, 2.5);
  assert.deepEqual(DEFAULT_SEEDS, [42, 1, 2, 3, 7, 59, 18, 94]);
  // 采样循环的边界（`t = 5; t <= dur-5; t += step`）也一并钉住：窗口数变了说明循环被改。
  // 用**假 wasm**（线性内存里放一个 `[]` 事件流）+ 注入 detector 走一遍循环，只数窗口数
  // ——不依赖真实引擎，故这条断言在任何环境都能跑（不需要 engine.wasm）。
  const buffer = new ArrayBuffer(4096);
  new Uint8Array(buffer).set([0x5b, 0x5d], 0); // "[]"
  const probe = {
    memory: { buffer },
    simulate: () => {},
    get_json_ptr: () => 0,
    get_json_length: () => 2,
    free_json: () => {},
  };
  const r = runSeed({ wasm: probe, seed: 1, dur: 5400, step: 1200, detect: () => [] });
  assert.equal(r.windows, 5, 'dur=5400 / step=1200 应为 5 窗（t=5,1205,2405,3605,4805）');
  assert.equal(runSeed({ wasm: probe, seed: 1, dur: 5400, step: 2.5, detect: () => [] }).windows, 2157);
});

test('退出码判定：finding ⇒ 1，无 finding ⇒ 0（不是恒 0）', () => {
  // #152 审阅 P1-1：`sweepExitCode` 改成恒返回 0 时原套件全绿——门会永久通过且无人察觉。
  assert.equal(sweepExitCode(0), 0);
  assert.equal(sweepExitCode(1), 1);
  assert.equal(sweepExitCode(7), 1);
  assert.equal(totalFindings([{ findings: 0 }, { findings: 2 }]), 2);
});

test('detector 接线：每窗调用一次、传的 profile 是生产 profile、finding 被计入 worst', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  // #152 审阅 P1-1：把 detector 调用换成 `const f = []` 时原套件全绿——门会失去发现重叠的能力。
  const calls = [];
  const detect = (players, profile) => {
    calls.push({ nPlayers: Object.keys(players).length, profileId: profile.id });
    return [{ features: { min_distance: 1.4 } }];
  };
  const wasm = await instantiateWasm(WASM_PATH);
  const r = runSeed({ wasm, seed: 42, dur: 60, step: 30, detect });
  assert.equal(r.windows, 2, 'dur=60 / step=30 → t=5,35 → 2 窗');
  assert.equal(calls.length, 2, 'detector 必须每窗被调用一次');
  assert.ok(calls.every((c) => c.profileId === DEFAULT_AUDIT_PROFILE.id), '必须传生产 audit profile');
  assert.ok(calls.every((c) => c.nPlayers > 0), '必须把窗口里的球员快照交给 detector');
  assert.equal(r.findings, 2, 'finding 必须被计入');
  assert.equal(r.worst, 1.4, 'worst 必须取 finding 的最小间距');
  assert.equal(formatSeedLine(r), 'seed 42: 2 windows, player_overlap findings=2 worst=1.400m');
});

test('runSweep：干净路径 → 退出码 0、按入参 seed 序打印、末行 OK', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  const out = makeSink();
  const err = makeSink();
  const code = await runSweep({
    seeds: [42, 1, 2],
    concurrency: 2,
    dur: 60,
    step: 30,
    wasmPath: WASM_PATH,
    log: out.sink,
    logError: err.sink,
  });
  assert.equal(code, 0, `干净路径必须返回 0（实得 ${code}）\n${err.lines.join('\n')}`);
  assert.equal(err.lines.length, 0, '干净路径不得写 stderr');
  assert.deepEqual(
    out.lines.slice(0, -1).map((l) => l.split(':')[0]),
    ['seed 42', 'seed 1', 'seed 2'],
    '打印顺序必须等于入参 seed 序'
  );
  assert.equal(out.lines.at(-1), '\nOK: no player_overlap findings over the swept windows');
});

test('runSweep：出现 finding → 退出码 1、末行 FAIL（门语义）', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  // 串行路径 + 注入 detector（函数无法跨 worker，故用 concurrency=1）。
  const out = makeSink();
  const err = makeSink();
  const code = await runSweep({
    seeds: [42, 1],
    concurrency: 1,
    dur: 60,
    step: 30,
    wasmPath: WASM_PATH,
    detect: () => [{ features: { min_distance: 1.5 } }],
    log: out.sink,
    logError: err.sink,
  });
  assert.equal(code, 1, 'finding 必须让退出码为 1');
  assert.ok(out.lines.some((l) => l.includes('findings=2 worst=1.500m')), `行里须有 worst：${out.lines}`);
  assert.match(err.lines.join('\n'), /FAIL: 4 player_overlap finding\(s\)/, '须打印 FAIL 汇总');
  assert.ok(!out.lines.some((l) => l.includes('OK:')), '有 finding 时不得打印 OK');
});

test('runSweep：执行失败 → 退出码非零、不得打印 OK（崩溃不能变「门通过」）', async () => {
  // #152 审阅 P1-2：CLI 的失败分支改成 `process.exit(0)` 时原套件全绿。
  // 用一份**损坏的 wasm**（文件可读、字节非法）驱动真实的实例化失败路径。
  const dir = mkdtempSync(join(tmpdir(), 'p152-badwasm-'));
  const bad = join(dir, 'engine.wasm');
  writeFileSync(bad, Buffer.from('not a wasm module'));
  const out = makeSink();
  const err = makeSink();
  const code = await runSweep({ seeds: [42], concurrency: 2, dur: 60, step: 30, wasmPath: bad, log: out.sink, logError: err.sink });
  assert.notEqual(code, 0, '损坏产物必须非零退出');
  assert.ok(!out.lines.some((l) => l.includes('OK:')), '失败路径不得打印 OK');
  assert.match(err.lines.join('\n'), /执行失败/);
});

test('runSweep：引擎产物缺失/不可读 → 退出码 2（不是 1、更不是 0）', async () => {
  const out = makeSink();
  const err = makeSink();
  const missing = await runSweep({ seeds: [42], concurrency: 1, wasmPath: '/nonexistent/engine.wasm', log: out.sink, logError: err.sink });
  const dir = mkdtempSync(join(tmpdir(), 'p152-dirwasm-'));
  const isDir = await runSweep({ seeds: [42], concurrency: 1, wasmPath: dir, log: out.sink, logError: err.sink });
  assert.equal(missing, 2, '缺失须为 2');
  assert.equal(isDir, 2, '存在但不可读（目录）也须为 2——与改动前 try/catch 口径一致');
  assert.match(err.lines.join('\n'), /缺少 .*engine\.wasm/);
  assert.equal(out.lines.length, 0, '此路径不得有 stdout 输出');
});

test('detect 注入 + 并发 > 1 必须**报错**（不得静默忽略注入）', async () => {
  // 函数无法跨 worker 传递 ⇒ 并发路径恒用生产 detector。若静默忽略，测试会「以为在测注入
  // 的检测器、其实没测」——这类静默失效正是本仓反复出现的一类缺陷，故 fail-loud。
  await assert.rejects(
    runSweep({
      seeds: [42],
      concurrency: 2,
      dur: 60,
      step: 30,
      detect: () => [],
      log: () => {},
      logError: () => {},
    }),
    /detect 注入只支持串行路径/
  );
});

test('worker 起不来（wasm 路径不存在）必须**失败**，不得静默当成通过', async () => {
  await assert.rejects(
    runConcurrent({ seeds: [42, 1], concurrency: 2, dur: 60, step: 10, wasmPath: '/nonexistent/engine.wasm' }),
    'worker 实例化失败必须让并发路径整体失败'
  );
});

test('CLI：非法 SWEEP_CONCURRENCY 直接报错退出 2（不静默回落成串行）', () => {
  const r = spawnSync(process.execPath, [CLI, '42'], {
    env: { ...process.env, SWEEP_CONCURRENCY: '0' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, `期望退出码 2，实得 ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /SWEEP_CONCURRENCY/);
});
