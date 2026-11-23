# Phase 0-A 独立审阅（gpt-6.1-sol）

审阅对象：`p1-phase0/2026-11-23`，HEAD `4ff971d`，基于设计 HEAD `8653455`。审阅为只读；未跑 200 场 L1、未下载数据、未重建 wasm。报告在设计工作树新增，未改 Phase 0-A 分支。

## High

无。

## Medium

### P0A-M1 — beat 间隔锚是 test-local 常量，未直接绑定未来 `BEAT_DT`

**位置：** `engine/tests/realism.rs:31-54,478-491,1377-1391`；`tasks.md:31-32`。

**证据/问题：** 旧的 `TICK_SECONDS` + `±0.001` 检查已替换为精确集合 `{BEAT_INTERVAL_S, 2×}`，`BEAT_INTERVAL_S=0.5`，容差 `1e-9`。`beat_gap_ok` 的单测显式拒绝 `0.1/0.2/0.4/0.75/1.5/NaN`，也覆盖近容差边界；这能挡住假绿和恒真/过宽集合。可是该值是独立 test-local 常量，不从引擎 `BEAT_DT`（当前 v11 尚不存在）或协议定义读取；tasks 注释明确依赖未来拆分时“同步”。若只更新引擎 cadence 而漏改测试常量，集合守卫本身仍会按旧值正确运行，但它测试的协议真值已经漂移。

**建议：** C1 引入 `BEAT_DT` 时将测试锚改为共享常量或由唯一协议常量派生；保留精确集合和非空转断言，并让测试拒绝 10Hz/5Hz cadence。Phase 0-A 作为 v11 冻结基线可接受该显式迁移债务。

### P0A-M2 — motion-census 未移植的模式不影响 Phase 0 主口径，但工具不是全模式可用

**位置：** `notes/motion-census-v11.md:7-19,21-41`；`tools/visual-review/motion-census.mjs`（`--stimulus`/`--windows` 分支）；`tools/visual-review/motion-census.test.mjs:296-322`。

**证据/问题：** 主宽扫与新 `--anchors` 模式不依赖 `render-ablation.mjs`/`stimulus.json`；Phase 0 frozen 24 窗复算采用 anchors，未移植依赖不会影响本次主口径。工具说明也如实记录旧 `--stimulus`/`--windows` 调用会因缺少模块/文件失败。过滤只应用于引擎侧帧，真实 tracking 无 `action` 字段；v11 `run/chase` 保持零剔除，C1 的 `action:"highlight"` 按 `[t0,t1)` 排除。测试覆盖 v11 逐位恒等、C1 定向剔除/保留其他球员/不改入参，并有两种定向变异证据。限制在后续若依赖这些模式可能被忽略。

**建议：** Phase 0 主流程继续只调用宽扫/anchors；需要 stimulus/windows 时单独移植依赖并增加 CLI smoke，避免把“已移植”误解为所有旧模式都可用。

### P0A-M3 — 性能 smoke 是可信的 v11 分母，但覆盖不等于完整 2.8/2.13

**位置：** `notes/phase0-perf-smoke.md:20-24,52-66,68-115`；`notes/perf-smoke-v11.json`；`tasks.md:34-41`。

**证据/问题：** 数字带本机型号、命令、wasm SHA 和计时口径；90min wasm simulate 0.909s、JSON 16.47MB、viewer load 2.028s、Node VmHWM 363.5MiB，量级可信且被明确标为单机、单次基线，不冒充 C1 结果。5min/90min 均测了 seek+读公开状态帧，但没有 Canvas `renderFrame` 光栅成本；2.8 仍未覆盖 debug、p124、spacing-sweep，2.13 的 C1“活体 5×+规划”也待 C1a。tasks 保持未勾并注明待后续，处理正确。所谓 debug 全量挂起没有本轮证据；此处是未测，而不是报告成失败。

**建议：** 可将当前数据作为 v11 分母合入；后续补 debug/p124/spacing-sweep 与 C1 规划成本。若 D7.5 的帧耗时用于 viewer 实际渲染承诺，另测 `renderFrame`/Canvas，而不要用 seek 读状态代替。

## Low

### P0A-L1 — baseline 的 `source_commit` 是测量树提交而非 main SHA，但行为身份有充分交叉证据

**位置：** `notes/l1-baseline-main.json:1-14,837-856,1337-1384`；`notes/motion-census-v11.md:43-84`。

**证据/问题：** `source_commit=8653455` 容易被误读为基线引擎提交；旁注解释该提交的 `engine/src` 与 main `de239d1` 逐字节相同，且记录 lib.rs SHA、wasm SHA。motion-census 进一步记录 wasm 与 Change 0 SHA 相同、12 个 seed 的事件流 SHA 逐位相同，核心指标复算为 0.82917/0.23924/0.21597，与 Change 0 的 0.829/0.239/0.216 对齐。因此 provenance 可审计；但更精确的命名会减少误读。

**建议：** 后续 schema 可分开记录 `measurement_tree_commit` 与 `engine_source_commit`，保留文件指纹和事件 SHA。当前旁注和交叉指纹足以建立身份，不构成阻塞。

### P0A-L2 — 性能点估计可复现但目前只有单次采样

**位置：** `notes/phase0-perf-smoke.md:89-90,104-115`；`notes/perf-smoke-v11.json`。

**证据/问题：** 报告说明重复运行观察到 5–10% 波动，但没有保存重复样本；因此可用于宽松预算分母，不能把接近阈值的差异当精确性能回归。当前 0.909s 对 10s 有较大余量，不改变判定。

**建议：** 若后续结果接近硬门，预注册重复次数并保存逐次测量、硬件/运行环境；本轮 v11 分母足以推进。

## 逐项核对

- **2.6：** 假绿来源已消除；`BEAT_INTERVAL_S` 固定 v11 0.5s，精确 1×/2×，没有把 `SIM_DT` 或新 `BEAT_DT` 偷当 0.5。非空转测试能区分恒真与扩大集合；未来 C1 cadence 常量迁移仍需显式同步（P0A-M1）。
- **2.11：** 工具主口径与 anchors 模式完整；`--stimulus`/`--windows` 的依赖未移植不影响 Phase 0 主口径。高亮过滤只作用引擎帧，真实侧不误伤。Change 0 frozen 24 窗身份有 wasm SHA 与 12 seed event SHA 逐位匹配，指标也对齐；测试覆盖 v11 恒等与 C1 剔除。
- **2.3：** source commit、engine/lib 与 wasm fingerprint、200 场 L1 seeds 401–600、600 场主客 seeds 401–1000、runtime/commands、原始 dump 与红清单均落盘。source_commit 是测量树提交，但代码身份说明足够。测试函数 4 红与 dump 带级 12 红分层明确；S6/S12/L3-3 标为真实拟合带并明确必须进入后续逐指标非恶化门，不被“dump-only”抹掉。dump-only 表示未被执行到的带级读数，不等于旧红或非重要。
- **2.12：** 11 真实拟合、29 护栏、4 过时逐条有真实锚/出处或注明实现契约/无真实锚；P2 口径不一致、T9/T10 旧带、H2 旧中心均有理由及保留守卫建议。方向按标量锚/声明值/范围描述；当前分类审计不把“带内”说成接近真实。个别护栏的“向真实锚”仍是方向性分类，需在后续逐带预注册公式时执行，但不是 Phase 0-A 产物缺失。
- **行为零变化：** `git diff --stat main..p1-phase0/2026-11-23 -- engine/src/ viewer/` 为空。Phase 0-A 增加测试/工具/notes，无引擎实现或 viewer 改动。目标分支审阅时 `git status --short --untracked-files=all` 为空，无未跟踪/临时文件。
- **测试证据：** performance note 记录修复后 `cargo test --release --tests --no-fail-fast` 8m11.35s、exit 0，并记录 release tests 汇总；本轮未重跑整套。motion-census 文档记录 22/22 通过及两项定向变异；realism 非空转用例已读，但本轮未在目标 worktree 重跑。没有从本地原始进程日志独立复核这些既有运行结果。
- **任务状态：** 2.3/2.6/2.11/2.12 已勾且对应产物存在；2.8/2.13 只完成 v11 分母，明确留待后续，未误勾；2.1/2.2/2.4/2.5/2.7/2.9/2.10 均未勾，和范围一致。

## 结论

**Phase 0-A 可合入，作为 v11 测量基线/工具移植这一独立切片；Phase 0 总体尚未完成。** 合入后仍需完成 2.1/2.2/2.4/2.5/2.7/2.8 剩余项/2.9/2.10/2.13，以及 C1a 的性能硬门。无 High；主要非阻塞事项是 C1 实施时把 L2 beat 锚接到共享 `BEAT_DT`，并补齐未测性能项。
