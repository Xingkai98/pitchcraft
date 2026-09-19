#!/usr/bin/env bash
# P0 分层验证脚本：跑全部测试（引擎 + viewer），确认各层正确。
# 自动断言是门槛（本脚本会红）。视觉验证（渲染 PNG 读图）用于探索与验收，
# 不进本脚本——见 CLAUDE.md §2「分层验证（自动化断言 + 视觉验证）」。
set -e
# pipefail：各步 `| tail`/`| grep` 管道原本会吞掉测试失败的退出码（管道状态 = 最后命令），
# 导致"全部验证通过"在测试红了也照常打印。加 pipefail 让管道任一段失败即整体失败。
set -o pipefail
cd "$(dirname "$0")"
# 确保 cargo 在 PATH（rustup 安装到 ~/.cargo/bin）
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== 1/9 Rust 引擎测试（cargo test）==="
(cd engine && cargo test 2>&1 | tail -15)

echo ""
echo "=== 2/9 Viewer 单测（node --test，含 app.test.js DOM 测试 + match-metrics 口径守护）==="
# app.test.js 用 jsdom（项目唯一第三方依赖，devDependency，见 package.json）。未安装时
# `node --test *.test.js` 会以模块解析失败整体挂掉，报错难懂 —— 先给出可操作的提示。
if [ ! -d node_modules/jsdom ]; then
  echo "缺少 node_modules/jsdom —— 先在仓库根运行: npm install"
  exit 1
fi
(cd viewer && node --test *.test.js 2>&1 | grep -E "^(# (tests|pass|fail))")

echo ""
echo "=== 3/9 Tools 单测（node --test tools/*.test.mjs：runner/service/queue-cli/detectors 等）==="
# 此前 tools/ 单测从未被任何脚本或 CI 执行（review 指出）——P20 的 runner/service/queue-cli
# 新增覆盖都在这里，必须进门槛。这些测试用 QUEUE_CLI 绝对路径、不依赖 cwd，故从 tools/ 跑安全。
# 失败时**打印失败详情**（P38 #87 的教训）：原先只 grep 计数行，CI 上红了你只知道
# "fail 1"，不知道是哪个用例、为什么——排查得靠猜。现在把输出落文件，红了就回放
# 失败段落（`not ok` 及其后 12 行），绿了只打印计数。
TOOLS_LOG=$(mktemp)
(cd tools && node --test *.test.mjs) > "$TOOLS_LOG" 2>&1 || {
  echo "── tools 测试失败详情 ──"
  grep -A12 "^not ok" "$TOOLS_LOG" | head -60
  rm -f "$TOOLS_LOG"
  exit 1
}
grep -E "^(# (tests|pass|fail))" "$TOOLS_LOG"
rm -f "$TOOLS_LOG"

echo ""
echo "=== 4/9 WASM 端到端（v2 并行节拍：engine.wasm → viewer 播放无 snap）==="
if [ ! -f viewer/engine.wasm ]; then
  echo "缺少 viewer/engine.wasm —— 先运行: cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm"
  exit 1
fi
(cd viewer && node e2e-v2.mjs)

echo ""
echo "=== 5/9 同队间距整场滑窗（P34 #53 真实门：跑真实采集管线 → player_overlap detector）==="
# 这是唯一能抓「viewer 侧罚下幽灵 / 采样时刻重叠」类缺陷的门（Rust 门只守发射端点与拍内
# 中点，看不见静止幽灵）。默认 seed 集含红牌 seed 59（幽灵路径覆盖）。
if [ ! -f viewer/engine.wasm ]; then
  echo "跳过：缺少 viewer/engine.wasm（第 4 步已提示如何构建）"
else
  node tools/spacing-sweep.mjs
fi

echo ""
echo "=== 6/9 比赛标尺（P36 报告期：引擎 vs 真实观测基线，只输出数字与对比、不判定）==="
# 基线（viewer/data/benchmark-baseline.json）已入库；engine.wasm 或基线缺失时本工具自行
# 跳过并以 0 退出（spec「基线缺失时跳过而非失败」）。真实原始数据不需要——基线含其摘要。
# 断言只存在于指标单测（第 2 步的 match-metrics.test.js）——标尺保证"量出来的数是对的"，
# 不保证"引擎像真实"（design D5b/D6）。
node tools/benchmark-compare.mjs

echo ""
echo "=== 7/9 真实性统计套件 L1（realism 统计分布，release 显式跑；L2/golden 已在第 1 步 cargo test 跑）==="
(cd engine && cargo test --test realism --release -- --ignored 2>&1 | tail -8)

echo ""
echo "=== 8/9 交叉验证（P37：真实侧内部自洽性，**报告项、不是门**——不阻塞）==="
# ⚠️ **本步不产生 pass/fail、不阻塞**（design D7 + 用户拍板）：min/max 包含门的通过率与
# 样本量无关（N=20 约 0.25），正常数据下也会频繁"红"——它不是门，是掷硬币。
# 故只打印数字（落空数/最易落空的指标/分半种子）。
#
# ⚠️ **不加 `|| true`**（审阅 P3-1）：工具自身已在所有**已知**缺失路径（基线不存在 /
# JSON 损坏 / 无逐窗指标）返回 0，`|| true` 只会额外吞掉**未预期崩溃**——那会让
# "全部验证通过"在工具炸掉时照样打印。不加则意外崩溃会如实红（set -e）。
node tools/benchmark-crossvalidation.mjs
echo ""
echo "=== 9/9 队形判据（P38 map #86：报告期——只打印，不阻塞）==="
# ⚠️ **本步不产生 pass/fail、不阻塞**（#91 的形态决策）：引擎现状（纵深 40.5 vs 靶子 25.9）
# **本来就达标不了**——是"确实还没修"，不是判据错。立成硬门会立即变红并一直红到
# #89（队形机制）做完为止，与 P37 把 half-split 降级为报告项同理（design D7）。
# 升格为门的前提：#89 交付通过判据的机制方案后，改 check-criteria.mjs 的 exit 码即可
# ——它的价值在**守住已修好的状态**，不在逼现在变绿。
# 判据组定义与变异自证见 openspec/changes/p38-formation-realism/notes/criteria/README.md。
node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs
echo ""
echo "=== 全部验证通过 ==="
