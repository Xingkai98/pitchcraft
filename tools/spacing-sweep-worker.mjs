// `spacing-sweep` 的 worker 入口（#152）：**一个 worker = 一个独立 wasm 实例**。
//
// 引擎 exports 有状态（`simulate` 写线性内存 → `get_json_ptr` 读回），所以不能把同一个实例
// 跨 seed 并发共享。每个 worker 自己 `instantiateWasm` 一份，并在**本 worker 内顺序**处理
// 分到的 seed —— 与串行路径「一个实例顺序跑多个 seed」是同一用法（design §D2/§D3）。
//
// 契约：收到 `{seed}` → 回 `{ok:true, result}` 或 `{ok:false, error}`；初始化完成后先发
// `{type:'ready'}`（客户端据此才派活，避免消息早于监听器）。worker 不打印（输出顺序由主线程
// 统一按入参 seed 序负责）。

import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_DUR, DEFAULT_STEP, instantiateWasm, runSeed } from './spacing-sweep-core.mjs';

const { wasmPath, dur = DEFAULT_DUR, step = DEFAULT_STEP } = workerData ?? {};

const wasm = await instantiateWasm(wasmPath);
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (msg) => {
  try {
    const result = runSeed({ wasm, seed: msg.seed, dur, step });
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
});
