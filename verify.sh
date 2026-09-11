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

echo "=== 1/5 Rust 引擎测试（cargo test）==="
(cd engine && cargo test 2>&1 | tail -15)

echo ""
echo "=== 2/5 Viewer 单测（node --test，含 app.test.js DOM 测试）==="
# app.test.js 用 jsdom（项目唯一第三方依赖，devDependency，见 package.json）。未安装时
# `node --test *.test.js` 会以模块解析失败整体挂掉，报错难懂 —— 先给出可操作的提示。
if [ ! -d node_modules/jsdom ]; then
  echo "缺少 node_modules/jsdom —— 先在仓库根运行: npm install"
  exit 1
fi
(cd viewer && node --test *.test.js 2>&1 | grep -E "^(# (tests|pass|fail))")

echo ""
echo "=== 3/5 Tools 单测（node --test tools/*.test.mjs：runner/service/queue-cli/detectors 等）==="
# 此前 tools/ 单测从未被任何脚本或 CI 执行（review 指出）——P20 的 runner/service/queue-cli
# 新增覆盖都在这里，必须进门槛。这些测试用 QUEUE_CLI 绝对路径、不依赖 cwd，故从 tools/ 跑安全。
(cd tools && node --test *.test.mjs 2>&1 | grep -E "^(# (tests|pass|fail))")

echo ""
echo "=== 4/5 WASM 端到端（v2 并行节拍：engine.wasm → viewer 播放无 snap）==="
if [ ! -f viewer/engine.wasm ]; then
  echo "缺少 viewer/engine.wasm —— 先运行: cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm"
  exit 1
fi
(cd viewer && node e2e-v2.mjs)

echo ""
echo "=== 5/5 真实性统计套件 L1（realism 统计分布，release 显式跑；L2/golden 已在第 1 步 cargo test 跑）==="
(cd engine && cargo test --test realism --release -- --ignored 2>&1 | tail -8)
echo ""
echo "=== 全部验证通过 ==="
