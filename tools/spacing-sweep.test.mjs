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

import { DEFAULT_AUDIT_PROFILE, detectPlayerOverlap } from './detectors.mjs';
import { Game, buildGameIndex } from '../viewer/game.js';
import { captureObservation } from '../viewer/observation.js';
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
  simulateEvents,
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

test('detect / buildIndex 注入 + 并发 > 1 必须**报错**（不得静默忽略注入）', async () => {
  // 函数无法跨 worker 传递 ⇒ 并发路径恒用生产 detector / 生产索引构造。若静默忽略，测试会
  // 「以为在测注入的实现、其实没测」——这类静默失效正是本仓反复出现的一类缺陷，故 fail-loud。
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
    /注入只支持串行路径/
  );
  await assert.rejects(
    runSweep({
      seeds: [42],
      concurrency: 2,
      dur: 60,
      step: 30,
      buildIndex: () => ({}),
      log: () => {},
      logError: () => {},
    }),
    /注入只支持串行路径/
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

// ---------------------------------------------------------------------------------------------
// #154：静态索引缓存的等价守卫
//
// 背景：逐窗 `new Game(events, lineup, 'continuous')` 的 91.5% 是**与窗时刻无关**的静态索引
// （timeline + 按实体分组的锚点索引 + 每事件结束时刻）。`runSeed` 现在把它算一次、逐窗传给
// `new Game(..., { index })`。守的**核心不变量**：这么提出来之后，**逐窗的观测与 finding 必须
// 与「每窗重建」逐位相同**——不是「差不多」、不是「汇总数相同」。
//
// 为什么判据必须落到**每窗**：默认 8 个 seed 的 finding 恒 0（这正是门能绿的原因），任何只看
// 「findings / worst」汇总的判据在这个 change 上**恒真**、没有区分度（#152 审阅 P2-1 的同类教训：
// 判据空转）。故本组用例：
//   ① 逐窗比 `captureObservation` 的**整包**（逐窗重建的参照实现 vs 复用索引的被测实现）；
//   ② 用 `detect` 注入点（#152 已有的测试钩子，非本 change 新增）把**生产路径 `runSeed`** 每窗
//      喂给 detector 的**输入**（`bundle.audit_input.players`：米制、含 ±5s 内 0.2s 采样的整窗
//      快照与派生特征）与输出逐窗抄下来，和参照实现逐位比 ——**比输入而不是只比输出**：
//      本 seed 集下 finding 恒为空，只比输出会恒真；
//   ②b **注入守卫**：上面的等价判据对「优化被整个摘掉」**不可观测**（摘掉后两条路径仍然等价），
//      故必须用 `buildIndex` 注入点正面断言「每 seed **恰好**构造一次」+「注入的索引**真的**被
//      构造消费」（把一个会被观测到的字段改坏，观测必须随之与重建路径不同）；
//   ③ 再钉住 detector 输出的汇总口径（`findings` / `worst`）；
//   ④ 另有一条**结构性**用例覆盖「全部窗口」而非抽样的窗口：`buildGameIndex` 是确定性纯函数、
//      且整轮扫描后索引逐字节未被改写——这是「两条路径在**每一个**窗口上都相等」的根据。
//      抽象地说：构造函数是两条路径**共用的同一段代码**，故只有当**共享索引本身**被污染时
//      两条路径才可能分岔；结构性用例正面守的就是这一点。
//
// 覆盖边界（如实写）：真实 wasm 用例沿用 #152 的口径——`DUR` 与事件流是 production 规模
// （`Game` 构造成本、索引规模都是真的），把 `STEP` 调粗以少跑几窗（2157 → 22）。**全 8 seed ×
// 2157 窗的逐窗对照**是 change 报告里的人工复验项，不在单测里（一次 ≈ 45 分钟 CPU）。

test('缓存索引 == 逐窗重建（真实 wasm，逐窗逐位一致）：captureObservation + detector 输出', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  const dur = DEFAULT_DUR; // production 5400：事件流与索引规模是真的
  const step = 250; // 只调粗**窗口数**（生产 2.5）；判据面（DUR/STEP/阈值）本 change 未动
  const wasm = await instantiateWasm(WASM_PATH);

  for (const seed of [42, 59]) { // 59 = 含红牌 seed（覆盖罚下路径下的窗口）
    const { events, lineup } = simulateEvents({ wasm, seed, dur });
    const index = buildGameIndex(events, lineup, 'continuous');

    const refBundles = []; // 逐窗重建（本 change 之前的行为）：整包 + detector 的输入/输出
    const refInputs = [];
    const refFindings = [];
    const cachedBundles = [];
    for (let t = 5; t <= dur - 5; t += step) {
      const rebuilt = new Game(events, lineup, 'continuous'); // 对照：无索引 → 每次重建
      rebuilt.seekTo(t);
      const refBundle = observe(rebuilt, seed, dur);
      refBundles.push(JSON.stringify(refBundle));
      refInputs.push(JSON.stringify(refBundle.audit_input.players));
      refFindings.push(JSON.stringify(detectPlayerOverlap(refBundle.audit_input.players, DEFAULT_AUDIT_PROFILE)));

      const cached = new Game(events, lineup, 'continuous', { index }); // 被测：复用静态索引
      cached.seekTo(t);
      cachedBundles.push(JSON.stringify(observe(cached, seed, dur)));
    }

    // ① captureObservation 的**整包**（含 audit_input、viewer_snapshot、窗口事件、lineup）逐位相同
    assert.deepEqual(cachedBundles, refBundles, `seed ${seed}：逐窗观测包必须逐位相同`);
    // 反证条（防空转）：判据必须**分得开不同的窗口**——否则「逐窗相同」可能只是签名跨窗恒等
    // （签名写得太平，任何两条路径都比得绿）。相邻两窗的观测包与 detector 输入都必须不同。
    assert.notEqual(refBundles[0], refBundles[1], '相邻窗口的观测包必须不同（判据不得跨窗恒等）');
    assert.notEqual(refInputs[0], refInputs[1], '相邻窗口的 detector 输入必须不同（判据不得跨窗恒等）');

    // ② **生产路径** `runSeed` 真的在用缓存索引，且每窗喂给 detector 的快照与逐窗重建逐位相同。
    //    用注入的 `detect` 抄一份**输入**——注入点不改调用契约（每窗一次、传本窗快照、用生产
    //    profile），故这里测的仍是真实生产循环，而不是测试里另写一遍的循环。
    //    比**输入**而不是只比 finding：本 seed 集下 finding 恒为空（`[]`），只比输出会**恒真**。
    const liveInputs = [];
    const liveFindings = [];
    const seenProfiles = [];
    const result = runSeed({
      wasm,
      seed,
      dur,
      step,
      detect: (players, profile) => {
        liveInputs.push(JSON.stringify(players));
        const f = detectPlayerOverlap(players, profile);
        liveFindings.push(JSON.stringify(f));
        seenProfiles.push(profile);
        return f;
      },
    });
    assert.deepEqual(liveInputs, refInputs, `seed ${seed}：生产路径每窗 detector 输入必须与逐窗重建一致`);
    assert.deepEqual(liveFindings, refFindings, `seed ${seed}：生产路径每窗 detector 输出必须与逐窗重建一致`);
    assert.ok(seenProfiles.every((p) => p === DEFAULT_AUDIT_PROFILE), 'detector 必须每窗收到生产 profile');
    assert.equal(result.windows, refBundles.length, `seed ${seed}：窗口数一致`);

    // ②b **注入守卫**——「生产路径真的在用这份缓存索引」只能靠注入来判：等价判据本身对
    //     「优化被整个摘掉」不可观测（摘掉后两条路径仍然等价，断言照样绿）。
    //     (i) 索引**每 seed 恰好构造一次**（把它挪回窗口循环里 → 这里会变成 2157）；
    let indexCalls = 0;
    runSeed({
      wasm,
      seed,
      dur,
      step,
      detect: () => [],
      buildIndex: (ev, lu, m) => {
        indexCalls += 1;
        return buildGameIndex(ev, lu, m);
      },
    });
    assert.equal(indexCalls, 1, `seed ${seed}：静态索引每 seed 只应构造一次（实测 ${indexCalls} 次）`);
    //     (ii) 注入的索引**真的被构造消费**：把索引的**时间线掏空**——detector 的输入
    //     （`audit_input.players`）由 `deriveAuditInput` 从 `game.timeline` 推出来，掏空后
    //     逐窗输入必须与「逐窗重建」**不同**。若 `runSeed` 丢了 `{ index }`，篡改对观测毫无
    //     影响 ⇒ 输入与重建一致 ⇒ 本断言变红。（先试过改 `playerBounds`：那条**改了也没用**
    //     ——audit 通路用自己从 `timeline` 分组的锚点，不看 `_playerBounds`。判据必须落在
    //     「改了就一定看得见」的字段上，否则这条守卫自己会空转。）
    const tamperedInputs = [];
    runSeed({
      wasm,
      seed,
      dur,
      step,
      detect: (players) => {
        tamperedInputs.push(JSON.stringify(players));
        return [];
      },
      buildIndex: (ev, lu, m) => ({ ...buildGameIndex(ev, lu, m), timeline: [] }),
    });
    // 先钉窗数再比内容：否则「跑成 0 窗」也会让 notDeepEqual 因**错的理由**通过（#154 审阅二轮 NIT-5）。
    assert.equal(
      tamperedInputs.length,
      refInputs.length,
      `seed ${seed}：篡改后的窗口数必须与参照一致（否则下面的「不同」可能是退化造成的）`
    );
    assert.notDeepEqual(
      tamperedInputs,
      refInputs,
      `seed ${seed}：注入的索引必须真的被构造消费（否则「优化被摘掉」在本套件里不可观测）`
    );
    // ③ detector 输出经生产路径汇总后一致（逐窗序列已由 ② 比过，这里钉住汇总口径）
    const refFind = refFindings.flatMap((s) => JSON.parse(s));
    assert.equal(result.findings, refFind.length, `seed ${seed}：finding 数一致`);
    assert.equal(
      result.worst,
      refFind.length ? Math.min(...refFind.map((f) => f.features.min_distance)) : null,
      `seed ${seed}：最恶劣间距一致`
    );
  }
});

function observe(game, seed, dur) {
  return captureObservation({
    game,
    statement: '',
    selectedEntities: [],
    window: { before: 5, after: 5 },
    seed,
    config: { match_duration_seconds: dur },
    sourceRevision: '<spacing-sweep>',
    opts: { idFactory: () => 'sweep', now: 1 },
  });
}

test('静态索引是确定性纯函数，且整轮扫描后逐字节未被改写（真实 wasm）', { skip: !existsSync(WASM_PATH) && '缺 viewer/engine.wasm（先构建）' }, async () => {
  const dur = DEFAULT_DUR;
  const wasm = await instantiateWasm(WASM_PATH);
  const { events, lineup } = simulateEvents({ wasm, seed: 42, dur });

  // 纯函数：同一输入两次构造 → 逐字节相同（缓存能成立的前提）。
  const index = buildGameIndex(events, lineup, 'continuous');
  const again = buildGameIndex(events, lineup, 'continuous');
  assert.equal(digestIndex(index), digestIndex(again), 'buildGameIndex 必须是确定性纯函数');

  const before = digestIndex(index);

  // ① **全部 2157 窗**（生产 `STEP=2.5`）：每窗构造 + `seekTo` + 推进。
  //    这一层是「共享索引被构造/插值路径改写」的正面守卫，且**不抽样**（成本 ~0.2 ms/窗，
  //    与上面那条逐窗等价用例的抽样窗口无关）。#154 审阅 P1-2 指出：原先这里也用 step=250，
  //    于是 design 里「摘要用例覆盖全部窗口」这句话是**假的**（实为 22/2157 = 1.0%）。
  let fullWindows = 0;
  for (let t = 5; t <= dur - 5; t += DEFAULT_STEP) {
    const game = new Game(events, lineup, 'continuous', { index });
    game.seekTo(t);
    game.playing = true;
    game.step(0.05); // 让 _updateFromTimeline 再走一遍
    fullWindows += 1;
  }
  assert.equal(fullWindows, 2157, '全窗对照的窗口数必须等于生产密度下的窗口数（2157）');
  assert.equal(digestIndex(index), before, '全部 2157 窗的构造/seekTo/step 之后索引仍须逐字节相同');

  // ② **采集 + detector 管线**：抽样窗口（每窗 ≈ 12 ms，全覆盖要 ~26 s —— 本条不进 CI 预算；
  //    全窗的管线对照见 design §D6 的人工全量 run，以及审阅者独立跑的 2157 窗深摘要）。
  let sampled = 0;
  for (let t = 5; t <= dur - 5; t += 250) {
    const game = new Game(events, lineup, 'continuous', { index });
    game.seekTo(t);
    const bundle = observe(game, 42, dur);
    detectPlayerOverlap(bundle.audit_input.players, DEFAULT_AUDIT_PROFILE);
    sampled += 1;
  }
  assert.equal(sampled, 22, '抽样窗口数（步长 250s）应为 22');
  assert.equal(digestIndex(index), before, '采集 + detector 管线（抽样窗口）之后索引仍须逐字节相同');
});

// 索引摘要。**Map 必须显式展开**：`JSON.stringify` 把 Map 序列化成 `{}`，直接用它会漏掉
// 「`playerAnchors`/`playerBounds` 被就地改写」这整整一类污染——摘要看着相等，索引其实变了。
// 反证条见下一条用例。
function digestIndex(index) {
  const mapEntries = (m) => [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    mode: index.mode,
    timeline: index.timeline,
    ballAnchors: index.ballAnchors,
    playerAnchors: mapEntries(index.playerAnchors),
    ballBounds: index.ballBounds,
    playerBounds: mapEntries(index.playerBounds),
    eventEnds: index.eventEnds,
    matchEnd: index.matchEnd,
  });
}

test('反证条：索引摘要对「锚点被增删改 / 分组被改写 / 结束时刻被改」都有区分度', () => {
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [] },
    { t: 1, type: 'beat', x: 0.5, y: 0.5, movers: [{ id: 0, x: 0.6, y: 0.5 }] },
    { t: 2, type: 'beat', x: 0.5, y: 0.5, movers: [{ id: 0, x: 0.7, y: 0.5 }] },
  ];
  const lineup = [{ id: 0, team: 'home', x: 0.5, y: 0.5 }];
  const base = buildGameIndex(events, lineup, 'continuous');
  const d = digestIndex(base);
  assert.equal(digestIndex(buildGameIndex(events, lineup, 'continuous')), d, '自反：同输入必须判相同');
  // ① 锚点表被删一条 / 某个锚点的 t 被改 / 球锚点表被增补
  assert.notEqual(digestIndex({ ...base, timeline: base.timeline.slice(0, -1) }), d, '锚点被删必须判不同');
  assert.notEqual(
    digestIndex({ ...base, timeline: base.timeline.map((a, i) => (i === 0 ? { ...a, t: a.t + 0.5 } : a)) }),
    d,
    '锚点被改必须判不同'
  );
  assert.ok(base.ballAnchors.length === 0, '前提：本 fixture 无球锚点（否则下一条会变成空转）');
  assert.notEqual(
    digestIndex({ ...base, ballAnchors: [{ t: 0, kind: 'ball', x: 0.5, y: 0.5, evt: 0 }] }),
    d,
    '球锚点表被增补必须判不同'
  );
  // ② 分组（Map）被改写——这正是裸 `JSON.stringify` 看不见的那一类
  const dropped = new Map(base.playerAnchors);
  dropped.delete(0);
  assert.notEqual(digestIndex({ ...base, playerAnchors: dropped }), d, '分组 Map 被改写必须判不同');
  const shrunk = new Map(base.playerAnchors);
  shrunk.set(0, shrunk.get(0).slice(0, -1));
  assert.notEqual(digestIndex({ ...base, playerAnchors: shrunk }), d, '分组内锚点被删必须判不同');
  // ③ 每事件结束时刻被改
  const ends = base.eventEnds.slice();
  ends[1] += 1;
  assert.notEqual(digestIndex({ ...base, eventEnds: ends }), d, '结束时刻被改必须判不同');
  assert.notEqual(digestIndex({ ...base, matchEnd: base.matchEnd + 1 }), d, '比赛总时长被改必须判不同');
});

test('索引缓存失效条件：索引与本次 (events, lineup, mode) 不同源 → 报错（不静默用错）', () => {
  const mk = () => ({
    events: [
      { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [] },
      { t: 1, type: 'beat', x: 0.5, y: 0.5, movers: [{ id: 0, x: 0.6, y: 0.5 }] },
    ],
    lineup: [{ id: 0, team: 'home', x: 0.5, y: 0.5 }],
  });
  const a = mk();
  const index = buildGameIndex(a.events, a.lineup, 'continuous');
  // 同源 → 正常复用（否则守卫会误伤唯一合法用法）
  assert.ok(new Game(a.events, a.lineup, 'continuous', { index }) instanceof Game);
  // 另一条事件流的索引喂进来 → 必须报错：拿错索引会产出「看起来正常但错」的位置与 finding，
  // 静默回落重建会把这类误用藏起来（本仓「工具不得静默走已知缺失路径」纪律）。
  const b = mk();
  assert.throws(() => new Game(b.events, b.lineup, 'continuous', { index }), /不同源/);
  assert.throws(() => new Game(a.events, [...a.lineup], 'continuous', { index }), /不同源/);
  assert.throws(() => new Game(a.events, a.lineup, 'clip', { index }), /不同源/);
});
