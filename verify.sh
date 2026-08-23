#!/usr/bin/env bash
# P0 分层验证脚本：跑全部测试（引擎 + viewer），确认各层正确。
# 无视觉依赖：全自动断言。
set -e
# pipefail：各步 `| tail`/`| grep` 管道原本会吞掉测试失败的退出码（管道状态 = 最后命令），
# 导致"全部验证通过"在测试红了也照常打印。加 pipefail 让管道任一段失败即整体失败。
set -o pipefail
cd "$(dirname "$0")"
# 确保 cargo 在 PATH（rustup 安装到 ~/.cargo/bin）
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== 1/4 Rust 引擎测试（cargo test）==="
(cd engine && cargo test 2>&1 | tail -15)

echo ""
echo "=== 2/4 Viewer 单测（node --test）==="
(cd viewer && node --test *.test.js 2>&1 | grep -E "^(# (tests|pass|fail))")

echo ""
echo "=== 3/4 WASM 端到端（v2 并行节拍：engine.wasm → viewer 播放无 snap）==="
if [ ! -f viewer/engine.wasm ]; then
  echo "缺少 viewer/engine.wasm —— 先运行: cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm"
  exit 1
fi
(cd viewer && node e2e-v2.mjs)

echo ""
echo "=== 4/4 真实性统计套件 L1（realism 统计分布，release 显式跑；L2/golden 已在第 1 步 cargo test 跑）==="
(cd engine && cargo test --test realism --release -- --ignored 2>&1 | tail -8)
echo ""
echo "=== 全部验证通过 ==="
