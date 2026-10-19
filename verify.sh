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
(cd viewer && node --test *.test.js 2>&1 | grep -E "^((#|ℹ) (tests|pass|fail))")

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
  grep -A12 -E "^(not ok|✖)" "$TOOLS_LOG" | head -60
  rm -f "$TOOLS_LOG"
  exit 1
}
grep -E "^((#|ℹ) (tests|pass|fail))" "$TOOLS_LOG"
rm -f "$TOOLS_LOG"

# visual-review 工具的守护测试（球必须画出来 + 跨全窗运动指标）。glob `tools/*.test.mjs`
# 只扫顶层，子目录要显式跑——否则这套测试永远不执行（同 P20 的教训）。
if [ -d tools/visual-review ]; then
  echo "--- tools/visual-review 单测 ---"
  (cd tools/visual-review && node --test *.test.mjs 2>&1 | grep -E "^((#|ℹ) (tests|pass|fail|skipped))")
fi

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
# 开关打开的 flags-gate 与 C3/C4 探针单独在 7b/7c 跑；这里 --skip 掉，
# 避免它们在没有 env（或探针机制断言变红）时污染第 7 步这个主门槛。
(cd engine && cargo test --test realism --release -- --ignored \
  --skip l1_volume_bands_with_realism_flags --skip realism_probes_report 2>&1 | tail -8)

# ── C1–C4 开关打开的验收回路（#170–#174 落地后补，2026-10-19）──────────────────────
# 为什么单列：第 7 步的 L1 只在 realism 全关下跑；开关打开时射门/抢断/犯规三条带会破，
# 但旧回路看不见。本段是**报告期**（不阻塞），C2/C3 修到带内后把 REALISM_GATES_STRICT=1
# 打开即升门。口径：与主 L1 同一个 seed 窗口（401..），报告默认 60 场（约 60s），
# 严格门跑 200 场（约 157s）。可用 REALISM_FLAGS 指定开关组合。
REALISM_FLAGS="${REALISM_FLAGS:-motion+formation+marking+press}"
REALISM_GATES_STRICT="${REALISM_GATES_STRICT:-0}"
echo ""
echo "=== 7b/9 C1–C4 开关打开的 L1 体量报告（报告期：当前 3/4 条红；STRICT=1 升门）==="
(cd engine && REALISM_GATES=1 REALISM_GATES_STRICT="$REALISM_GATES_STRICT" REALISM="$REALISM_FLAGS" \
  cargo test --test realism --release -- --ignored l1_volume_bands_with_realism_flags --nocapture 2>&1 | tail -12)

echo ""
echo "=== 7c/9 C3/C4 旁路探针接线检查（换盯人 / 未匹配 / 压迫人数；断言的是探针不变量，不是引擎达标）==="
(cd engine && REALISM="$REALISM_FLAGS" \
  cargo test --test realism --release -- --ignored realism_probes_report --nocapture 2>&1 | tail -10)

echo ""
echo "=== 7d/9 C1–C4 开关打开的 P38 判据（报告期：只打印，不阻塞）==="
# check-criteria.mjs 经 tools/benchmark-engine.mjs 读取 REALISM 环境变量。
# 防混引擎：7b/7c 用刚从源码编译的 Rust 二进制，7d 用 viewer/engine.wasm。
# mtime 只是弱哨兵（它分不清行为改动与注释/探针改动），所以同时打印两边的 sha，
# 让读日志的人能判断 7d 的读数是否与源码同源；本项目 wasm 不随 verify.sh 自动构建。
echo "7d provenance: src=$(sha256sum engine/src/lib.rs | cut -c1-12) wasm=$(sha256sum viewer/engine.wasm | cut -c1-12)"
if [ engine/src/lib.rs -nt viewer/engine.wasm ]; then
  echo "⚠️  viewer/engine.wasm 比 engine/src/lib.rs 旧：7d 的读数可能不对应 7b/7c。先重建 wasm。"
fi
REALISM="$REALISM_FLAGS" node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs

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
echo "=== 8 条队形判据（P38 map #86：报告期——只打印，不阻塞）==="
# ⚠️ **本步不产生 pass/fail、不阻塞**（#91 的形态决策）：引擎现状（纵深 40.5 vs 靶子 25.9）
# **本来就达标不了**——是"确实还没修"，不是判据错。立成硬门会立即变红并一直红到
# #89（队形机制）做完为止，与 P37 把 half-split 降级为报告项同理（design D7）。
# 升格为门的前提：#89 交付通过判据的机制方案后，改 check-criteria.mjs 的 exit 码即可
# ——它的价值在**守住已修好的状态**，不在逼现在变绿。
# 判据组定义与变异自证见 openspec/changes/p38-formation-realism/notes/criteria/README.md。
node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs
echo ""
# 射门判据的**守护测试**（阶段 1）：用反证条证明它会红——不是"证明判据对"，
# 而是"证明判据被改成空转/改回双边带时会失败"。判据退化时本步会红。
node --test openspec/changes/p38-formation-realism/notes/criteria/shot-criterion.test.mjs
echo ""
echo ""
echo "=== P18 引擎侧产物（#18：门槛步**依赖它**，故必须先落盘）==="
# ⚠️ 为什么必须在这里生成（第二轮审阅抓到的**结构性缺口**）：
#   `target/p18-gates/*.json` 是 **gitignored 的 build artifact**，CI 上不存在；
#   而门槛步（`gates.test.mjs`）里有 5 条测试**需要它**才能跑真实断言
#   （引擎 key 命中 / C1 对照栏 / 缺 provenance / 陈旧哨兵）。
#   **不生成 ⇒ 那 5 条在 CI 上永远走跳过分支**——第一轮抓的两个 P1 修复本体恰好都在里面。
#   本步用 30 seed（≈2s，release 已在第 7 步编译过）把它补上。
P18_SOURCE_COMMIT=$(git rev-parse HEAD) \
  cargo test --release --manifest-path engine/Cargo.toml --test p18_behavior_gates \
  -- --ignored --nocapture p18_canary 2>&1 | tail -3

echo ""
echo "=== P18 行为判据（#18 map：报告期——只打印，不阻塞）==="
# ⚠️ **本步不产生 pass/fail、不阻塞**（design §3.4，用户 2026-09-30 裁定）：
# 引擎现状（链时长 4.88×、间隔 3.95×、压迫覆盖 9.7×）**本来就达标不了**——是"确实还没修"，
# 不是判据错。立成硬门会立即变红并一直红到 #19（行为生成改造）做完为止，
# 与 P37 把 half-split 降级为报告项、P38 把 8 条队形判据降为报告期同理。
# 升格为门的前提：#19 交付通过判据的机制方案后，改 check-behavior-gates.mjs 的 exit 码即可
# ——它的价值在**守住已修好的状态**，不在逼现在变绿。
# 判据组定义与"哪些候选被排除/哪些不可得"见 change 的 notes/criteria/gates-spec.json。
# ⚠️ **不加 `|| true`**（同本文件 P38 那步的纪律）：工具自身在所有**已知**缺失路径返回 0，
# `|| true` 只会额外吞掉**未预期崩溃**——那会让「全部验证通过」在判据器炸掉时照样打印。
node openspec/changes/p18-behavior-verification-layer/notes/criteria/check-behavior-gates.mjs

echo ""
echo "=== P18 反证条（#18：**门槛**——判据退化时会红）==="
# ⚠️ 本步**是门**（与上一步相反）：它守的是"判据没被改坏"，不是"引擎达标"。
# 判据被改成空转 / 串线 / 丢掉 sameThing 时本步会红（已做 4 种定向变异验证）。
node --test openspec/changes/p18-behavior-verification-layer/notes/criteria/gates.test.mjs

echo "=== 全部验证通过 ==="
