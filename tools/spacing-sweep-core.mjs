// `spacing-sweep` 的**纯逻辑核心**（#152 提速拆分）。
//
// 为什么拆出来：CLI（`tools/spacing-sweep.mjs`）、worker（`tools/spacing-sweep-worker.mjs`）
// 与守护测试（`tools/spacing-sweep.test.mjs`）必须跑**同一份** `runSeed`。并发与串行的
// 等价性因此是**结构性**的（同一函数、同一参数、同一 detector），而不是靠对齐两份实现。
// 详见 `openspec/changes/p152-sweep-perf/design.md` §D3。
//
// 本模块做「读事件流 → 逐窗采集 → detector」的计算与调度，以及**一次 sweep 的编排**
// （`runSweep`：跑 → 打印 → 返回退出码）。它**不调用 `process.exit`、不直接写 console**：
// 输出走注入的 `log`/`logError`，退出码**返回**给 CLI。这样「打印顺序 / OK·FAIL 文案 /
// 退出码」这些门语义能在单测里被真正执行（#152 审阅 P1-2：CLI 只被跑到一条 exit 2 分支）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import { config } from '../viewer/config.js';
import { parseEventStream } from '../viewer/protocol.js';
import { Game, buildGameIndex } from '../viewer/game.js';
import { captureObservation } from '../viewer/observation.js';
import { DEFAULT_AUDIT_PROFILE, detectPlayerOverlap } from './detectors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 关调试日志；跳过机制会改 playTime，关掉。
// 注：`config` 是单例对象，这里改写会影响**本模块所在进程/线程**的所有使用者。CLI 与 worker
// 都只跑 sweep，故无碍；测试若同进程复用其它 config 消费者须留意（见 design §D3）。
config.debug.enabled = false;
config.playback.skipThresholdSeconds = Infinity;

export const WASM_PATH = join(ROOT, 'viewer', 'engine.wasm');

export const DEFAULT_DUR = 5400; // 90 分钟
export const DEFAULT_STEP = 2.5; // 采样步长（秒）：±5s 窗 = 10s 宽 → 4x 重叠，密到不会漏掉短暂重叠
export const DEFAULT_CONCURRENCY = 4; // CI runner（ubuntu-latest 公开仓）= 4 vCPU

// 默认 seed 集：含 P34 审阅 R2 命中的 `59`（当年默认集 `42 1 2 3 7` 全零，漏掉了它——
// 那次残留的根因是「罚下球员幽灵」，已在 viewer 侧修复）。红牌 seed 取 `59`（2 张）+
// `18` + `94`（各 1 张）——单点覆盖太脆（审阅 R3/R4 NIT），三个 seed 的幽灵路径互为兜底。
// 1..200 内共 12 个含红牌 seed：18 33 59 78 85 94 95 113 121 145 186 190。
export const DEFAULT_SEEDS = [42, 1, 2, 3, 7, 59, 18, 94];

const SCRATCH = 1024;

// seed 参数解析：空 → 默认集；否则按命令行给的数字（顺序即输出顺序）。
export function parseSeeds(argv = []) {
  return argv.length ? argv.map(Number) : [...DEFAULT_SEEDS];
}

// 并发度：`SWEEP_CONCURRENCY` 显式指定优先（1 = 串行、进程内）；否则
// `min(DEFAULT_CONCURRENCY, CPU 数)`；最后按 seed 数收窄（多于 seed 的 worker 无意义）。
// 非法值**报错**而非静默回落——静默回落会让「以为开了并发、其实没有」不被察觉。
export function resolveConcurrency({ env, seedCount, cpus = availableParallelism() }) {
  const raw = env === undefined || env === null || String(env) === '' ? null : Number(env);
  if (raw !== null && (!Number.isInteger(raw) || raw < 1)) {
    throw new Error(`SWEEP_CONCURRENCY 必须是 >=1 的整数，收到 ${JSON.stringify(env)}`);
  }
  const base = raw ?? Math.min(DEFAULT_CONCURRENCY, Math.max(1, cpus));
  return Math.max(1, Math.min(base, seedCount));
}

// 实例化一个独立的 wasm 引擎实例（**每个实例有独立线性内存**）。
// 引擎 exports 是**有状态**的：`simulate` 写线性内存，随后 `get_json_ptr`/`get_json_length`
// 读回；两个 seed 共用一个实例并发跑会互相踩内存 → 故每个 worker 各自实例化（design §D2）。
export async function instantiateWasm(wasmPath = WASM_PATH) {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 跑一次 wasm `simulate` 并把事件流解析成 `{events, lineup}`。
// 抽出来（#154）是为了让**同一份事件流**既能喂给生产路径（`runSeed`），也能喂给等价守卫
// （`spacing-sweep.test.mjs` 的「缓存索引 vs 逐窗重建」用例）——否则守卫得自己复制一遍
// 这段 wasm 交互，两边就可能悄悄漂移。
export function simulateEvents({ wasm, seed, dur = DEFAULT_DUR }) {
  const cfgBytes = encoder.encode(JSON.stringify({ match_duration_seconds: dur }));
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfgBytes.length).set(cfgBytes);
  wasm.simulate(BigInt(seed), SCRATCH, cfgBytes.length);
  const raw = JSON.parse(
    decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length()))
  );
  wasm.free_json();
  return parseEventStream(raw);
}

// 单 seed 整场滑窗扫描。**这是并发与串行共用的唯一实现**——改动它同时改动两条路径。
// 注意：wasm 实例（含线性内存与模块全局）本就**无法跨线程共享**，故每个执行单元各自实例化；
// 同一实例内**顺序**跑多个 seed 是安全的（原脚本即如此，且引擎跨调用无残留状态——见 design §D2）。
//
// `detect` 与 `buildIndex` 是**测试注入点**（默认分别为生产 detector 与生产索引构造）：
//
// - `detect`：没有它，「detector 被摘掉 / profile 被换掉 / findings>0 分支从不执行」这类变异会
//   **静默存活**（#152 审阅 P1-1 实测 M6/M9 全绿）。
// - `buildIndex`（#154）：本 change 的**唯一交付物**就是「索引只算一次」。而「缓存路径与逐窗重建
//   等价」这条判据对「优化被整个摘掉」**不可观测**——摘掉之后两条路径仍然等价，判据照样绿
//   （#154 审阅 P1-1 实测：删掉下面 `{ index }` 后 20/20 全绿）。故索引构造必须可注入，
//   守卫才能断言「每 seed **恰好**构造一次」且「注入的索引**真的**被构造消费」。
//
// 函数无法跨 worker 传递，故两个注入点都只在**进程内**（串行）路径生效——`runSweep` 对
// 并发 + 非默认注入会**报错**（不静默忽略）。
export function runSeed({
  wasm,
  seed,
  dur = DEFAULT_DUR,
  step = DEFAULT_STEP,
  detect = detectPlayerOverlap,
  buildIndex = buildGameIndex,
}) {
  const { events, lineup } = simulateEvents({ wasm, seed, dur });

  // **静态索引只算一次**（#154）：`buildGameIndex` 的结果（整场锚点时间线 + 按实体分组的
  // 时间索引 + 每事件结束时刻）只依赖 (events, lineup, mode) **与建索引时刻的 config 常量**
  // （见 viewer/game.js 的 `buildGameIndex` 注释与 design §D3），与窗时刻 `t` 无关。本扫描的
  // 事件流/站位逐窗不变，而这块占逐窗成本的 91.5%（§D1）——每窗重建它是纯重复劳动。
  // 逐窗仍**新建** `Game` 对象（只复用索引）：可变状态（`_players`/`ball`/`playTime`）由构造
  // 函数照常初始化，故不存在「复用实例」的语义分歧（`_interpolateAnchors` 返回 `null` 时
  // 回落 lineup 站位的行为逐位保持）。等价性由 §D7 的守卫用例钉住。
  const index = buildIndex(events, lineup, 'continuous');
  let findings = 0;
  let worst = Infinity;
  let windows = 0;
  for (let t = 5; t <= dur - 5; t += step) {
    const game = new Game(events, lineup, 'continuous', { index });
    game.seekTo(t);
    const bundle = captureObservation({
      game,
      statement: '',
      selectedEntities: [],
      window: { before: 5, after: 5 },
      seed,
      config: { match_duration_seconds: dur },
      sourceRevision: '<spacing-sweep>',
      opts: { idFactory: () => 'sweep', now: 1 },
    });
    const f = detect(bundle.audit_input.players, DEFAULT_AUDIT_PROFILE);
    windows += 1;
    for (const x of f) {
      findings += 1;
      if (x.features.min_distance < worst) worst = x.features.min_distance;
    }
  }
  return { seed, windows, findings, worst: Number.isFinite(worst) ? worst : null };
}

// 并发跑 seeds，但**结果按入参顺序**返回（完成顺序无关）。
// `runSeed(seed, index)` 由调用方注入：生产路径传 worker 调度器（`runConcurrent`），
// 测试传确定性假实现以覆盖调度面（顺序 / 恰好一次 / 并发上限）。
export async function runPool({ seeds, concurrency, runSeed: run }) {
  const results = new Array(seeds.length).fill(null);
  const size = Math.max(1, Math.min(concurrency, seeds.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = next++; // 同步取号（await 之前），故无竞态
        if (i >= seeds.length) return;
        results[i] = await run(seeds[i], i);
      }
    })
  );
  return results;
}

// 串行路径：进程内一个实例，逐 seed 顺序跑（**与原脚本逐字等价**）。
// 计算与打印分离：先算完全部 seed 再返回（原脚本是边算边打印；见 design §D3 的「已知差异」）。
export async function runSerial({
  seeds,
  dur = DEFAULT_DUR,
  step = DEFAULT_STEP,
  wasmPath = WASM_PATH,
  detect = detectPlayerOverlap,
  buildIndex = buildGameIndex,
}) {
  const wasm = await instantiateWasm(wasmPath);
  return seeds.map((seed) => runSeed({ wasm, seed, dur, step, detect, buildIndex }));
}

// 一个 worker 的客户端：请求/响应一次一条，由 `runConcurrent` 的空闲表保证不重入。
class SweepWorker {
  constructor({ wasmPath, dur, step }) {
    this.worker = new Worker(new URL('./spacing-sweep-worker.mjs', import.meta.url), {
      workerData: { wasmPath, dur, step },
    });
    this.closed = false;
    this.pending = null;
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // 初始化失败时 `ready` 会拒绝。若该 worker 在拿到 seed 前池子就整体失败了，
    // `ready` 没人 await → 变成 unhandledRejection（Node 默认退出 1 并打无关的警告，
    // 盖掉真错误）。挂一个空 handler 只是把「无人认领」消掉：`run()` 里的 `await` 照样抛。
    this.ready.catch(() => {});
    this.worker.on('message', (msg) => {
      if (msg && msg.type === 'ready') {
        this._resolveReady();
        return;
      }
      const p = this.pending;
      this.pending = null;
      if (!p) return;
      if (msg && msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg && msg.error ? msg.error : 'sweep worker returned an error'));
    });
    const fail = (err) => {
      this._rejectReady(err);
      const p = this.pending;
      this.pending = null;
      if (p) p.reject(err);
    };
    this.worker.on('error', (err) => {
      if (!this.closed) fail(err);
    });
    this.worker.on('exit', (code) => {
      // worker 意外退出（含 OOM 被杀）：**必须**让等待者失败，否则主进程静默挂起。
      if (!this.closed) fail(new Error(`sweep worker exited unexpectedly with code ${code}`));
    });
  }

  async run(seed) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage({ seed });
    });
  }

  async close() {
    this.closed = true;
    await this.worker.terminate();
  }
}

// 并发路径：`concurrency` 个 worker，各持**自己的** wasm 实例；seed 按空闲分发。
export async function runConcurrent({
  seeds,
  concurrency,
  dur = DEFAULT_DUR,
  step = DEFAULT_STEP,
  wasmPath = WASM_PATH,
}) {
  const size = Math.max(1, Math.min(concurrency, seeds.length));
  const workers = Array.from({ length: size }, () => new SweepWorker({ wasmPath, dur, step }));
  const idle = [...workers];
  const waiting = [];
  const acquire = () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((r) => waiting.push(r)));
  const release = (w) => {
    const r = waiting.shift();
    if (r) r(w);
    else idle.push(w);
  };
  try {
    return await runPool({
      seeds,
      concurrency: size,
      runSeed: async (seed) => {
        const w = await acquire();
        try {
          return await w.run(seed);
        } finally {
          release(w);
        }
      },
    });
  } finally {
    await Promise.all(workers.map((w) => w.close()));
  }
}

// 单 seed 一行输出（与原脚本逐字一致）。
export function formatSeedLine(r) {
  const tail = r.findings ? ` worst=${r.worst.toFixed(3)}m` : '';
  return `seed ${r.seed}: ${r.windows} windows, player_overlap findings=${r.findings}${tail}`;
}

export function totalFindings(results) {
  return results.reduce((acc, r) => acc + r.findings, 0);
}

// 退出码：任一 seed 出现 finding 即 1（与串行路径同语义）。
export function sweepExitCode(total) {
  return total > 0 ? 1 : 0;
}

// 一次 sweep 的**编排**（CLI 的主体，可 import 以便单测真正执行「打印顺序 / OK·FAIL / 退出码」）：
//   2 = 引擎产物不可读（缺失/损坏）  1 = 执行失败（worker 崩）或出现 finding  0 = 干净
// `log`/`logError` 注入（默认 console）；本函数**只返回**退出码，`process.exit` 由 CLI 做。
export async function runSweep({
  seeds,
  concurrency,
  dur = DEFAULT_DUR,
  step = DEFAULT_STEP,
  wasmPath = WASM_PATH,
  detect = detectPlayerOverlap,
  buildIndex = buildGameIndex,
  log = console.log,
  logError = console.error,
}) {
  // 用「读一次」代替 `existsSync`：文件存在但不可读/是目录时也走 2（原脚本的 try/catch 口径）。
  try {
    readFileSync(wasmPath);
  } catch {
    logError(
      `缺少 ${wasmPath}。先构建 WASM：\n` +
        '  (cd engine && cargo build --target wasm32-unknown-unknown --release)\n' +
        '  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm'
    );
    return 2;
  }
  if (concurrency > 1 && (detect !== detectPlayerOverlap || buildIndex !== buildGameIndex)) {
    throw new Error(
      'detect / buildIndex 注入只支持串行路径：函数无法跨 worker 传递（并发路径恒用生产实现）'
    );
  }
  let results;
  try {
    results =
      concurrency === 1
        ? await runSerial({ seeds, dur, step, wasmPath, detect, buildIndex })
        : await runConcurrent({ seeds, concurrency, dur, step, wasmPath });
  } catch (err) {
    // worker 崩溃 / 实例化失败：**必须**非零退出，绝不能静默当成「门通过」。
    logError(`spacing-sweep 执行失败：${String((err && err.stack) || err)}`);
    return 1;
  }
  for (const r of results) log(formatSeedLine(r));

  const total = totalFindings(results);
  if (sweepExitCode(total) !== 0) {
    logError(`\nFAIL: ${total} player_overlap finding(s) over the swept windows`);
    return 1;
  }
  log('\nOK: no player_overlap findings over the swept windows');
  return 0;
}
