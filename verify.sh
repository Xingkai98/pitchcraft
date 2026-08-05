#!/usr/bin/env bash
# P0 分层验证脚本：跑全部测试（引擎 + viewer），确认各层正确。
# 无视觉依赖：全自动断言。
set -e
cd "$(dirname "$0")"
# 确保 cargo 在 PATH（rustup 安装到 ~/.cargo/bin）
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== 1/3 Rust 引擎测试（cargo test）==="
(cd engine && cargo test 2>&1 | tail -15)

echo ""
echo "=== 2/3 Viewer 单测（node --test）==="
(cd viewer && node --test *.test.js 2>&1 | grep -E "^(# (tests|pass|fail))")

echo ""
echo "=== 3/3 WASM 端到端（Node 加载 engine.wasm 产事件流）==="
node -e "
const fs = require('fs');
const path = require('path');
const wasmPath = path.join('viewer', 'engine.wasm');
if (!fs.existsSync(wasmPath)) {
  console.error('缺少 viewer/engine.wasm —— 先运行: cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/');
  process.exit(1);
}
const bytes = fs.readFileSync(wasmPath);
WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const SCRATCH = 1024;
  function run(seed, duration) {
    const cfgBytes = encoder.encode(JSON.stringify({ match_duration_seconds: duration }));
    new Uint8Array(wasm.memory.buffer, SCRATCH, cfgBytes.length).set(cfgBytes);
    wasm.simulate(BigInt(seed), SCRATCH, cfgBytes.length);
    const outPtr = wasm.get_json_ptr();
    const outLen = wasm.get_json_length();
    const events = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen)));
    wasm.free_json();
    return events;
  }
  const events = run(42, 2700);
  const lineup = events.find(e => e.type === 'lineup');
  if (events.length < 50) throw new Error('事件太少');
  if (!lineup || lineup.players.length !== 22) throw new Error('阵容不是 22 人');
  const types = new Set(events.map(e => e.type));
  for (const t of ['lineup','kickoff','pass','dribble','shot','whistle']) {
    if (!types.has(t)) throw new Error('缺事件类型: ' + t);
  }
  // 关键：config 必须生效（60s 与 2700s 事件数不同），否则 config 通道回归
  const e60 = run(42, 60);
  if (e60.length === events.length) throw new Error('config 未生效：60s 与 2700s 事件数相同');
  const last60 = e60[e60.length-1].t, last2700 = events[events.length-1].t;
  if (last60 > 61 || last2700 < 2699) throw new Error('config 时长未生效: t 未到预期');
  console.log('WASM 端到端 OK：' + events.length + ' 事件，22 人阵容，类型齐全，config 生效(60s→' + e60.length + '事件, 2700s→' + events.length + '事件)');
}).catch(e => { console.error('失败:', e.message); process.exit(1); });
"
echo ""
echo "=== 全部验证通过 ==="
