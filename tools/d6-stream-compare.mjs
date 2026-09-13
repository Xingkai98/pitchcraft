// P27 D6 确定性边界验证：逐事件逐字段对比两个引擎 wasm 的事件流。
// 期望：事件数量逐 seed 完全一致、非出界事件逐字段一致、只有出界 pass 的
// result/out_side/out_pos 变（detail/x2/y2 仍与旧版一致）。
//
// 用途（阶段 2/3 再改出界编码时也复用）：拿改前/改后的 wasm 各跑一遍，证明「只改协议字段、
// 不改事件数量/时序」。永久回归由 engine/tests/realism.rs 的 gm_v1_regression_counts_unchanged
// 承担（对 v1 golden 基线），本脚本给出更细的**逐字段**证据。
//
// 构建两个 wasm：
//   (cd engine && cargo build --target wasm32-unknown-unknown --release) \
//     && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm /tmp/post.wasm
//   git stash && (cd engine && cargo build --target wasm32-unknown-unknown --release) \
//     && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm /tmp/pre.wasm && git stash pop
//
// 用法：node tools/d6-stream-compare.mjs <pre.wasm> <post.wasm> <seedStart> <seedEnd> [duration]
// 退出码：0 = 只有出界字段变（D6 OK）；1 = 出现事件数/非出界字段差异（D6 FAIL）。
import { readFileSync } from 'node:fs';

const [prePath, postPath, s0, s1, durArg] = process.argv.slice(2);
const duration = Number(durArg ?? 5400);

async function load(path) {
  const bytes = readFileSync(path);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');
  const SCRATCH = 1024;
  return (seed, d) => {
    const cfg = enc.encode(JSON.stringify({ match_duration_seconds: d }));
    new Uint8Array(wasm.memory.buffer, SCRATCH, cfg.length).set(cfg);
    wasm.simulate(BigInt(seed), SCRATCH, cfg.length);
    const ptr = wasm.get_json_ptr();
    const len = wasm.get_json_length();
    const out = JSON.parse(dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)));
    wasm.free_json();
    return out;
  };
}

const pre = await load(prePath);
const post = await load(postPath);

const OUT_DETAILS = new Set(['out_sideline', 'out_goal_line']);
let totalEvents = 0;
let outEvents = 0;
let otherFieldDiffs = 0;
let countMismatch = 0;
const fieldDiffKinds = new Map();

for (let seed = Number(s0); seed <= Number(s1); seed++) {
  const a = pre(seed, duration);
  const b = post(seed, duration);
  if (a.length !== b.length) {
    countMismatch++;
    console.log(`SEED ${seed}: 事件数不一致 pre=${a.length} post=${b.length}`);
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    totalEvents++;
    const ea = a[i], eb = b[i];
    const isOut = eb.type === 'pass' && (OUT_DETAILS.has(eb.detail) || eb.result === 'out');
    if (isOut) {
      outEvents++;
      // 允许差异：result / out_side / out_pos
      const keysA = Object.keys(ea).filter((k) => k !== 'result');
      const keysB = Object.keys(eb).filter((k) => k !== 'result');
      const added = keysB.filter((k) => !keysA.includes(k));
      const removed = keysA.filter((k) => !keysB.includes(k));
      const expectedAdded = added.every((k) => ['out_side', 'out_pos'].includes(k));
      if (!expectedAdded || removed.length) {
        otherFieldDiffs++;
        console.log(`SEED ${seed} ev${i}: 出界事件键集异常 added=${added} removed=${removed}`);
      }
      for (const k of keysA) {
        if (k === 'result') continue;
        if (JSON.stringify(ea[k]) !== JSON.stringify(eb[k])) {
          otherFieldDiffs++;
          console.log(`SEED ${seed} ev${i}: 出界事件非预期字段差异 ${k}: pre=${JSON.stringify(ea[k])} post=${JSON.stringify(eb[k])}`);
        }
      }
      continue;
    }
    // 非出界事件：必须逐字节等价（键集 + 值全同）
    const ka = JSON.stringify(Object.keys(ea).sort());
    const kb = JSON.stringify(Object.keys(eb).sort());
    if (ka !== kb) {
      otherFieldDiffs++;
      fieldDiffKinds.set('keyset', (fieldDiffKinds.get('keyset') ?? 0) + 1);
      console.log(`SEED ${seed} ev${i} (${ea.type}): 键集差异 pre=${ka} post=${kb}`);
      continue;
    }
    for (const k of Object.keys(ea)) {
      if (JSON.stringify(ea[k]) !== JSON.stringify(eb[k])) {
        otherFieldDiffs++;
        const key = `${ea.type}.${k}`;
        fieldDiffKinds.set(key, (fieldDiffKinds.get(key) ?? 0) + 1);
        if (otherFieldDiffs < 25) {
          console.log(`SEED ${seed} ev${i} (${ea.type}): 字段 ${k} 差异 pre=${JSON.stringify(ea[k])} post=${JSON.stringify(eb[k])}`);
        }
      }
    }
  }
}

console.log('---');
console.log(`事件总数（对比范围）：${totalEvents}`);
console.log(`出界事件数：${outEvents}`);
console.log(`事件数不一致的 seed 数：${countMismatch}`);
console.log(`非预期差异总数：${otherFieldDiffs}`);
if (fieldDiffKinds.size) console.log('差异字段分布：', [...fieldDiffKinds.entries()]);
const ok = countMismatch === 0 && otherFieldDiffs === 0;
console.log(ok ? 'D6 OK：只有出界 pass 的 result/out_side/out_pos 变。' : 'D6 FAIL');
process.exit(ok ? 0 : 1);
