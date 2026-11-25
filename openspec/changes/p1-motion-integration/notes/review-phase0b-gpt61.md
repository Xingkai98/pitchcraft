# Phase 0-B 独立审阅（gpt-6.1-sol）

审阅提交：`5099983`；基点：`4428ccc`。只写本报告，无 commit/push。

审阅进行中；发现与验证结果在下方增量追加。

## High

### P0B-H1 — 角球测试放宽到 26，但规范仍 SHALL ≤15

**位置：** `engine/tests/realism.rs:1040-1084`；`openspec/specs/match-engine/spec.md:312-322`；`notes/phase0b-corner-band.md:98-104`。

**证据/问题：** 测试现已接受单场 max `≤26`，而主 spec 的「单场角球上界」scenario 仍规定 `≤15`，并给出旧 200/3000 seed 依据。Phase 0-B note 也确认这会形成“测试 26 / spec 15”分叉，并写“在此之前，以测试与 note 为准”，但实现者/下游读者没有权力把测试覆盖的阈值当规范覆盖：测试允许 16–26 的结果，而 SHALL 仍判这些结果失败。主 spec 同一 requirement 的另一 scenario 也保留角球带旧语义/旧读数；只改测试会让验收合同相互矛盾。

**建议：** 不能把该分叉作为已完成的 Phase 0-B 交付合入。虽然任务最初限定“测试/notes”，批准设计要求规范与验收门同步；应把范围错误显式提回，新增对主 spec 精确 requirement 的 MODIFIED delta，复制全部 scenario，并把单场上界 scenario 及角球派生带 scenario 更新到新均值带/防爆炸护栏语义。若本 PR 必须保持仅测试/notes，则先不要合入这项放宽，保留旧 ≤15 直到规范同步的独立 PR。此项为 **High**，因为直接决定实现是否违反 SHALL。

## Medium

### P0B-M1 — 2.1/2.2 已有实现与证据，但 tasks 仍标未完成

**位置：** `openspec/changes/p1-motion-integration/tasks.md:26-28`；`notes/phase0b-corner-band.md:75-96`；`notes/phase0b-guard-fixtures.md:131-145`。

**证据/问题：** 目标 HEAD 的 tasks 中 2.1 和 2.2 仍是 `[ ]`，尽管 2.1 的测试带/note 与 2.2 的 fixture/note 均已提交，且各自验证命令有记录。任务板因此不能准确表达 Phase 0-B 的交付状态。2.4/2.5/2.7/2.8/2.9/2.10/2.13 仍未勾选并符合当前未完成说明（2.8/2.13 只落了 v11 分母）。

**建议：** 解决 P0B-H1 的 spec 范围后，同步将 2.1/2.2 标为完成，或明确分拆出尚未完成的规范同步任务，避免勾选含义与交付事实不符。

### P0B-M2 — 两条 p53 多 seed 安全网仍保留“最坏值必须贴近阈值”条件

**位置：** `engine/src/lib.rs:9158-9205,9234-9275`；`notes/phase0b-guard-fixtures.md:152-153`。

**证据/问题：** 三个新构造测试分别确定性覆盖端点违规修复、拍内对穿、起点已违规时不移动，证据较直接。但两个原多 seed 扫描没有改，仍以 `worst < SAME_TEAM_MIN_DIST_M + 0.05/0.15` 要求运行样本中至少出现贴阈值 pair。运动改进使最坏间距离阈值更远时，它们仍可能假红；note 自身也承认这是活体检查。该断言不是“不得违反间距”契约，而是“必须观察到 solver 曾推到阈值附近”的偶然性代理。

**建议：** 多 seed 安全网保留端点/扫掠下界、detector 下界及样本数量等不变量，移除“必须贴近阈值”的上界；是否有触发另作报告。确定性构造负责证明 solver 确实会处理违规输入。

### P0B-M3 — p32 完整枚举主要验证概率记账器；实际判定接线仍由 8 seed 统计守卫承担

**位置：** `engine/src/lib.rs:11976-12047,12049-12126`；`notes/phase0b-guard-fixtures.md:94-113,115-125`。

**证据/问题：** 构造测试枚举 0..99 并调用生产 `note_interception_roll(d, meters, p, roll)`，校验 `ceil(p)`、分桶、long/very-long 字段和自洽 helper；这不是事件实际拦截分支本身。实际分支在 `emit_pass_inner` 中使用 `fail_roll < interception_p`，另由 8 seed 运行测试要求总样本/实际命中、分桶和/、足样本桶自洽，因此没有把枚举恒等式单独当作实现概率验收。可是 `checked_any` 只强制至少一个桶执行足样本自洽；其它非零但样本不足的桶会合法落到 `insufficient_sample`，其实际率不会在此批次单独统计判定。note 所称 M1–M4 变异只覆盖端点分离、liveness 拉回、ceil→floor 和 chase→run，没有记录对概率未接线、实际概率乘 10 或单桶漏记的独立变异结果。

**建议：** 保留枚举恒等 + 多 seed 接线分工；把关键失效变异（实际分支断开/概率倍率/漏桶）各跑一次并记录是否由现有守卫杀死。若某距离桶自然样本不足，应以测试构造直接调用对应 production decision/记账路径，而不是只证明 helper 恒等。

## Low

### P0B-L1 — p32 的多 seed 测试被有意缩至 8 seed，记录了条件样本不足而非全桶统计证明

**位置：** `engine/src/lib.rs:12049-12126`；`notes/phase0b-guard-fixtures.md:104-109,144-151`。

**证据/问题：** 8 seed 守卫的主要目标是接线、非零事件和样本充分时自洽；它不再复制旧 400 seed 的所有桶级统计功效。构造枚举降低了量化规则的随机波动，但无法替代各桶真实分布。文档已说明成本取舍，且当前 p32 不变量本身有独立 spec，因此属有界的验证范围减少，不是隐藏放宽。

**建议：** 若后续实际改动拦截率/距离分桶，再按预注册种子扩大统计验证，并保持此处作为快速接线守卫。

## 逐项审阅与验证

- **2.1 角球均值带：** 新 `[6.68,13.86]` 以真实均值 10.27 为中心、工程相对宽度 `×[0.65,1.35]`，note 清楚说明不是真实分位，也说明当前 8.285 低于真实锚而非居中调带；通道关闭时余 1.33/场，低于下沿，确能守该塌缩路径。T9 标“真实拟合（重锚后）”容易被误解为界本身是实测分位，建议改成“真实锚定；工程宽度，待真实分位”，但其正文已明确解释。T10 `≤26` 标为数量级护栏，不是拟合带；`2.5×` 均值与 Poisson 下界只是工程依据，note 如实承认真实上尾不可得、3000 场重定未跑，现阶段可作为 provisional guard，后续必须用真实上尾复核。主要阻断仍是 P0B-H1 的主 spec 分叉。
- **2.2 p53：** 三个确定性场景命中端点、拍内扫掠和起点不可解语义；起点场景只保证本拍不做无谓投影，没有豁免下一次 solver/全局 detector。原多 seed 检查保留了契约下界但也留了 M2 的脆弱“贴阈值”假红条件。
- **2.2 p31：** 三个阶段通过生产 `open_action_opportunity` 构造验证，逐档 deadline 严格压缩且不低于最小值；二档无压自然 deadline 必须出球并清零计时。多 seed 不再要求每档必发生，只限制 `max_ticks ≤ stage3 + 8s`，可抓无限增长/明显超过三档；不是精确的三档可达性证据（构造测试承担该契约）。
- **2.2 p6：** 显式状态构造固定攻防 chaser 身份，连续三拍要求至少两个 chase、id14 在 movers、battle 不漂移且未被拾取，不再存在缺 loose beat 的 `if let` 静默通过。
- **2.2 p32：** 完整 0..99 roll 域覆盖 9 个距离/长度组合；概率宽度由 `open_play_interception_p_dir` 计算，记账器结果与期望宽度核验；另有 8 seed 真实比赛接线测试、总数与分桶求和、样本门与长传嵌套。故不以枚举恒等替代全部自洽，但 P0B-M3 的专属故障变异证据尚缺。单看 Phase 0-B note，M1–M4 四项均有先红后还原结果。
- **cfg(test) 边界：** 比较基点和目标 `engine/src/lib.rs`，真实 `#[cfg(test)] mod tests` 前 436,047 字节逐字节相同（SHA256 `dbb8192a…`）；所有 diff hunks 均落在测试模块内。文档中的 `#[cfg(test)]` 字面量位于已开始的测试模块之后，基于第一次 `#[cfg(test)]` 字符串分割的源码扫描不会误切到注释。`viewer/` diff 为空；main 引擎实现目录 `engine/src/` diff 为空。
- **行为零变化：** `git diff --stat main..p1-phase0b/2026-11-25 -- engine/src/ viewer/` 为空。仅测试、notes 与任务文件改动；无生产实现更改。
- **测试证据：** `phase0b-corner-band.md` 记录目标 realism 用例 `1 passed`、167.83s；`phase0b-guard-fixtures.md` 记录 p53 14、p31 20、p6 17、p32 3 项测试均通过。审阅未在该分支 worktree 重跑（当前会话位于设计 worktree）；也未运行全量套件。全量未跑对 Phase 0-B 测试/notes 切片可接受，但独立复核只能确认日志记载，不能声称本轮复跑通过。
- **任务勾选：** 2.3/2.6/2.11/2.12 已勾且产物存在；2.8/2.13 的分母产物存在但总项仍未勾，并注明 C1/其它测试待后续；2.4/2.5/2.7/2.9/2.10 未勾。2.1/2.2 实际已有产物却仍未勾，见 P0B-M1。
- **目标分支状态：** 固定提交 `5099983`；目标分支审阅前无未跟踪文件。当前共享目录中只有审阅报告为新文件；未改 Phase 0-B 文件。

## 结论

**Phase 0-B 暂不可合入。** 有 1 个 High：角球 max 测试放宽到 26，但主 spec 仍 SHALL ≤15。需将正式 MODIFIED spec delta 纳入同一批准范围，或把测试门暂留在规范允许的 15；同时修正 tasks 的 2.1/2.2 状态。其余确定性夹具与 v11 行为零变化证据整体可接受；p53 多 seed 脆弱近阈值断言和 p32 故障变异覆盖作为后续收紧项。
\ No newline at end of file
## Round 2

审阅目标：`dea3615`；生产行为对照基点：`4428ccc`。本轮只追加此报告；验证在 `/tmp/p0b-review-dea3615` 的固定提交快照中执行，不修改目标分支文件。

### High

无。**P0B-H1 已关闭。** 正式 change delta 已覆盖角球均值带和单场 max，不再以 note 越权覆盖未修改的 SHALL。

### Medium

无新增。P0B-M1/M2/M3 均关闭，证据见逐项验收。

### Low

#### R2-L1 — 新角球 scenario 的宽度来源指向“同 requirement”不准确

**位置：** `openspec/changes/p1-motion-integration/specs/match-engine/spec.md:534-542`。

**问题/证据：** 角球派生带属于「涌现频率带的经验体量守卫」，但括号称宽度沿用“同 requirement 射门/抢断真实拟合带”。射门/抢断两条 scenario 实际位于前一 requirement「射门与抢断的体量带」。数值和来源在其它正文中可定位，不影响当前阈值或执行。

**建议：** 将“同 requirement”改为精确 requirement 名称，避免归档后读者寻找不存在的同节 scenario。非阻塞。

### 逐项验收

1. **P0B-H1：关闭。** `specs/match-engine/spec.md:481-543` 在 MODIFIED 区新增「射门与抢断的体量带（L1 体积，真实量级）」及「涌现频率带的经验体量守卫」。机械解析精确 requirement 头名与 scenario 名称：前者主 spec 4/4 保留（普通射门、抢断、单场角球上界、体积抬升不崩溃）；后者 2/2 保留（出界通道、角球派生带）。普通射门/抢断/崩溃及出界通道 scenario 未改变原契约；max 为 ≤26，均值为 [6.68,13.86]，与测试/notes 一致。角球 scenario 明确其为按真实锚重标的例外、工程宽度不是真实分位；max 明确 provisional 数量级护栏。主 spec 当前文件继续保留旧值是 change delta 尚未 archive 的正常结构；本轮补齐的是之前缺失的规范变更，不要求直接重写主 spec。

2. **P0B-M1：关闭。** `tasks.md:26-29` 的 2.1/2.2 与新增 2.1b 均已勾选。2.1b 明确记录 spec 同步的内容和 strict 验证，作为同一角球重锚的补充工作项合理。2.4/2.5/2.7/2.8/2.9/2.10/2.13 仍未勾选；没有把 v11 分母或本轮夹具完成误写成整个 Phase 0 完成。

3. **P0B-M2：关闭。** `engine/src/lib.rs:9202-9212,9278-9287` 将两处 `worst < 阈值+0.05/0.15` 改为 println 报告。端点扫描仍保留同队距离 ≥ `SAME_TEAM_MIN_DIST_M−EPS`、严格高于 detector 2.0m、检查 pair 数 >10,000；拍内扫描仍计算整个线性段最近距离、要求 ≥ `DETECTOR_MIN_M−EPS` 并保留 >10,000 样本门。这里拍内原有 0.02m 容差没有新放宽。确定性端点/扫掠/起点不可解三个构造测试保留。因此移除的是“必须撞见近阈值事件”的假红条件，不是间距安全契约。

4. **P0B-M3：关闭。** `engine/src/lib.rs:12057-12118` 新增 `p32_interception_branch_matches_bookkeeping`，64 seed 各直接调用生产 `emit_pass_highlight_inner`（关闭出界通道，指定 receiver），要求恰好一个 roll 记账样本、必须产生 pass、逐次比较 `pass.result == intercepted` 与 `tally.intercept_roll_actual == 1`。末尾同时要求 hits>0 与 misses>0，不能以无样本/只有单侧结果空转。它补的是实际事件分支与 tally 的绑定，非另写一份预测公式。原 9 格完整 roll 域构造和 8 seed 比赛接线/桶级条件自洽守卫仍保留（后续 `p32_interception_self_consistency`）。`notes/phase0b-guard-fixtures.md:127-140` 记录 M5 实际分支恒假由新测试杀死；M6 概率×10 由固定预期宽度构造杀死；M7 bucket 2 漏记由构造及 8 seed 守卫杀死。这些变异在报告中标为开发方记录，本轮没有重新变异；但新生产分支测试已在固定提交临时快照独立复跑通过（见下）。

### 机械检查与独立验证

- **MODIFIED 总数实际为 12，不是 11：** match-engine 6、event-stream-protocol 3、pitch-viewer 3。逐 requirement 对比目标提交的主 spec 和 change delta，全部原 scenario 均包含，missing=0。数量依次为引擎 8/8、9/10、5/5、6/6、4/4、2/2；协议 1/1、4/4、1/1；viewer 6/6、4/4、2/2。引擎同队间距多出的「分离预测视野」是既有批准的新增 scenario，不是丢失/替换主 scenario。
- **生产字节一致：** `4428ccc` 与 `dea3615` 的 `engine/src/lib.rs` 第一个实际测试模块标记前，436,047 字节完全一致；SHA256=`dbb8192a…`。实际 `#[cfg(test)]` 始于 7932 行；全部 lib.rs diff hunks 位于其后。第一次字符串命中就是该属性，没有新增注释提前截断源码扫描。注意：`engine/src/lib.rs` 整文件有测试 diff，不能把生产前缀零 diff 简写为整个 `engine/src/` 零 diff。
- **viewer：** `git diff --stat 4428ccc..dea3615 -- viewer/` 为空。除本轮报告外未修改仓库文件，无 commit/push。
- **strict 独立复跑：** 从 `dea3615` 导出 change/spec 到临时目录，执行 `openspec validate p1-motion-integration --strict`，输出 `Change 'p1-motion-integration' is valid`。
- **新测试独立复跑：** 在固定提交临时快照执行 `cargo test --offline --manifest-path engine/Cargo.toml --lib p32_interception_branch_matches_bookkeeping -- --nocapture`：1 passed / 0 failed / 209 filtered，测试执行 0.23s，exit 0（首次编译约21.97s，既有 warnings 不影响结果）。未下载依赖、未重建 wasm。
- **其它运行结果来源：** `notes/phase0b-guard-fixtures.md:147-152` 记录 p53 14、p31 20、p6 17、p32 4 全绿，realism 指定用例 165.12s；这些组测试/realism 本轮未重跑，未跑 200 场 L1，也未跑全量套件。
- **git status：** 当前设计工作树有两个先前审阅产物未跟踪：`review-phase0a-gpt61.md`、本 `review-phase0b-gpt61.md`；本轮只追加后者。不能把当前工作树说成 clean；本轮用固定提交快照验证，没有对目标分支未提交文件状态作额外保证。

### 结论

**P0B-H1/M1/M2/M3 全部关闭；High=0，Phase 0-B 可合入。** 角球重锚与规范 delta 已一致，p53 保留安全门并移除抽样假红，p32 新增真实事件分支↔记账的非空转守卫。工程宽度/真实上尾证据债和其它未勾选 Phase 0 工作仍需按计划推进，不应把本切片通过当作整个 Phase 0 验收完成。
