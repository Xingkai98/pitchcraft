// P38 #89：**打破单标量出球门**的源码变体库。
//
// 背景（`notes/defense-layers.md` + 本目录的 `analyze-shot-pass*.mjs`）：
//   `evaluate_open_play_carrier_action` 的第一档是**硬门**
//   `nearest_defender_m <= OPEN_PLAY_PASS_PRESSURE_M (8.0)` → 出球，
//   **永远走不到射门档**。实测 54% 的持球帧落在这个门内。
//   而真实数据（Metrica 两场，事件时刻几何）说：
//
//   | | 实测（真留一交叉验证 AUC） |
//   |---|---|
//   | 贴身（d1≤4m）事件的**第 1 近中位** | 真实 2.2m / 引擎 8.7m（引擎几乎从不贴身） |
//   | P(射门) 在 16.5–22m 桶内随 d1 变化 | 真实 25%/17%/25%（**平的**，与压力无关） |
//   | 全特征 | 0.844（欧氏口径）/ 0.806（引擎口径） |
//   | **去掉 d1（其余全留）** | **0.844 / 0.806 —— 几乎不掉** ← 最稳的证据 |
//   | 仅 d1（真单变量） | 0.516（两口径必然相同） |
//   | 仅球门距离 | 0.792（欧氏）/ 0.626（引擎仅纵进口径） |
//
//   → 真实球员**在贴身下照射**，区分射门与传球的是**球门距离**，不是压力。
//   ⚠️ 注意"仅距离"这一项**对距离口径敏感**（0.79 vs 0.63）；而"去掉 d1 不掉"
//      两种口径都成立——**后者才是本诊断的承重结论**。
//   引擎的问题不是"阈值 8.0 vs 3.0"，而是**用错了维度**：
//   它把「射门意图」表达成了「压力的补集」。
//
// 本文件把该诊断落成三个可实测的源码变体（叠在 exp4b 等队形变体之上）：
//
//   A. `positionGate`（★ 主假设）：出球门**只在小威胁区生效**。
//      − 射程内（`dist_to_goal_m ≤ R`）：门收到 `M` —— 贴身也照射（真实行为）
//      − 射程外：门保持 8.0 —— 中场贴身仍然出球（保护犯规结构）
//      再叠加**门级保护**：d1 ≤ 1.5m 时**不**放行射门（球都护不住，射不出去）。
//      这一条是单向的收紧，与"压力大就不射"是**不同**的假设：
//      「护不住球」≠「被逼抢」，它让"贴身射门"不再是白拿的。
//
//   B. `positionGateNoGuard`（对照）：同上但不带 1.5m 保护——分离两个效应。
//
//   C. `flatGate`（对照）：把门**全局**收到 `M`（= 已经测过的 exp10，用来隔离
//      "位置条件" vs "单纯阈值变小"）。
//
// ⚠️ 每个 patch 自己保证锚点存在（锚点缺失要抛，不能静默不生效）。

const anchorOnce = (src, old, repl, what) => {
  if (!src.includes(old)) throw new Error(`缺锚点（${what}）：${old.slice(0, 60)}…`);
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`锚点不唯一（${what}）：命中 ${n} 次`);
  return src.replace(old, repl);
};

const GATE_ANCHOR = `    let stalled_unpressed = st.ticks_since_meaningful_action >= LIVENESS_STAGE_2_TICKS;
    if gk_holding || nearest_defender_m <= OPEN_PLAY_PASS_PRESSURE_M || stalled_unpressed {`;

/** f64 字面量：`3` 会被 rustc 判为整数类型错误（P38 踩过一次，构建失败但被 try/finally 正确还原）。 */
const f64lit = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

/**
 * `effectiveCutoff` = 加上保护条之后，**实际**在射程内放行射门的那个距离（米）。
 *
 * ⚠️ 审阅发现（重要，这条是**探针自身**的坑）：带保护时 `pass_gate_m = M` 会被保护条**短路**——
 * 逻辑是 `(nd ≤ pass_gate_m && nd > G) || (nd ≤ G && nd ≤ 8.0)`，第二项在 `G ≤ 8` 时恒真。
 * 于是 `nd ≤ max(M, G)` 全部出球，**`M` 只有在 `M > G` 时才起作用**。
 * 换句话说 `M = 0.5, G = 1.5` 与 `M = 1.5, G = 1.5` **逐位等价**，有效门是 **1.5m**。
 * → 报数时必须报 `max(M, G)`，不能报 `M`。
 */
export const effectiveCutoff = (meters, guardMeters) => Math.max(Number(meters),
  guardMeters == null ? 0 : Number(guardMeters));

/** 在 gate 前插入 `let pass_gate_m = …;`，再把 gate 改成用它。 */
const buildGate = ({ radius, meters, guardMeters, what }) => {
  const r = Number(radius);
  const m = Number(meters);
  const guard = guardMeters == null ? null : Number(guardMeters);
  return (src) => {
    // 有效门（米）：带保护条时 `max(M, guard)`，因为保护条会短路第一项（见 `effectiveCutoff`）。
    // 写进源码注释 → 数字可审计，不靠读者自己推。
    const armed = guard == null ? `${f64lit(m)}（无保护条）` : `${f64lit(effectiveCutoff(m, guard))}`;
    let out = anchorOnce(src, GATE_ANCHOR, `    let stalled_unpressed = st.ticks_since_meaningful_action >= LIVENESS_STAGE_2_TICKS;
    // #89：出球门从「单标量、全场一个值」改成「**射程内按位置放行、射程外不变**」——
    // 真实球员在 2–3m 下起脚（见 exp89-variants.mjs 头部表），射门与否由球门距离决定。
    // ⚠️ 有效门 = max(pass_gate_m, guard) = ${armed}m（保护条会短路第一项，见 effectiveCutoff）。
    let pass_gate_m = if dist_to_goal_m(st, carrier) <= ${f64lit(r)} { ${f64lit(m)} } else { OPEN_PLAY_PASS_PRESSURE_M };
    if gk_holding || nearest_defender_m <= pass_gate_m || stalled_unpressed {`, 'gate');
    if (guard != null) {
      // 门级保护：**持球者脚下被贴住**时不放行射门档（护不住球 → 只能出球）。
      // 与「压力大就不射」的区别：这是**单向收紧**，只在极近距离触发，且不随射程变化。
      out = anchorOnce(out, `    if gk_holding || nearest_defender_m <= pass_gate_m || stalled_unpressed {`,
        `    let too_close_to_shield = nearest_defender_m <= ${f64lit(guard)};
    if gk_holding || (nearest_defender_m <= pass_gate_m && !too_close_to_shield)
        || (too_close_to_shield && nearest_defender_m <= OPEN_PLAY_PASS_PRESSURE_M)
        || stalled_unpressed {`, 'guard');
    }
    return out;
  };
};

export const EXP89_PATCHES = {
  /**
   * ★ 主假设：位置条件 + 门级保护。
   * 射程 R 内 → 门收到 M（贴身照射）；R 外 → 保持 8.0；d1 ≤ g → 照旧出球。
   */
  positionGate: ({ radius = 25, meters = 0.5, guardMeters = 1.5, what = 'positionGate' } = {}) => ({
    name: `positionGate_R${radius}_M${meters}_G${guardMeters}`,
    patch: buildGate({ radius, meters, guardMeters, what }),
  }),

  /** 对照：位置条件但**无**门级保护（隔离"护不住球"这一条的贡献）。 */
  positionGateNoGuard: ({ radius = 25, meters = 0.5 } = {}) => ({
    name: `positionGateNoGuard_R${radius}_M${meters}`,
    patch: buildGate({ radius, meters, guardMeters: null, what: 'positionGateNoGuard' }),
  }),

  /** 对照：把门**全局**收到 M（无位置条件）——即 exp10 的形态，用于隔离"位置条件"的作用。 */
  flatGate: ({ meters = 3.0 } = {}) => ({
    name: `flatGate${meters}m`,
    patch(src) {
      const lit = Number.isInteger(meters) ? `${meters}.0` : String(meters);
      return anchorOnce(src,
        'const OPEN_PLAY_PASS_PRESSURE_M: f64 = 8.0;',
        `const OPEN_PLAY_PASS_PRESSURE_M: f64 = ${lit};`, 'flatGate');
    },
  }),

  /** 对照：射程放宽到 `radius`、门 = `meters` **且**保护半径 = `guardMeters`（扫参用）。 */
  positionGateAt: ({ radius, meters, guardMeters = 1.5 } = {}) => ({
    name: `positionGate_R${radius}_M${meters}_G${guardMeters}`,
    patch: buildGate({ radius, meters, guardMeters, what: 'positionGateAt' }),
  }),

  /**
   * ★ **第二个自由度**：抬升「射门推进」的 hazard 平移量。
   *
   * 为什么这是"第二个自由度"而不是又一个阈值：出球门管的是**要不要离开持球档**，
   * 而 `OPEN_PLAY_SHOT_ENGAGE_SHIFT` 管的是**离开时走哪条路**（推进/起脚 vs 继续带球）。
   * 两者在源码里是**两个独立的乘子**：门是 if 分支，shift 只进 `open_play_shot_engage_hits`
   * 的 exp 指数。
   *
   * 机制假设（本轮实测支持）：**出球门是"解压阀"**——持球者一被贴身就出球，
   * 冲突当场结束；把门收紧后冲突继续，防守者反复近身 → 犯规从 20 涨到 50。
   * 若射门本身也是"解压"（起脚后球离开持球者），那么**把射门频率抬上去**应该
   * 同时拿到"射门多"与"犯规不炸"——两个自由度若真有内部工作点，就在这里。
   *
   * ⚠️ shift 是**加在 score 上的**（`score = compute_shot_score(f) + shift`），
   * 越小越容易命中（score 越小 → exp 越小 → 危险率越低）。命名沿用源码的
   * `OPEN_PLAY_SHOT_ENGAGE_SHIFT`（缺省 -4.3 = 源码值）。
   */
  /**
   * **可加性对照**：位置门（开射程内的门）**叠加**射门倾向抬升。
   * 两个变体各自单独测过（门 7.2→10.8、倾向 7.2→17.6）。若二者独立，
   * 合起来应 ≈ 10.8 + 17.6 − 7.2 = 21.2；显著低于此 = 两个乘子共享同一个瓶颈。
   */
  comboGateShift: ({ radius = 25, meters = 0.5, guardMeters = 1.5, shift = -3.5 } = {}) => ({
    name: `comboGateShift_R${radius}_M${meters}_s${shift}`,
    patch(src) {
      let out = EXP89_PATCHES.positionGate({ radius, meters, guardMeters }).patch(src);
      out = EXP89_PATCHES.engageShift({ shift }).patch(out);
      return out;
    },
  }),

  engageShift: ({ shift = -3.0 } = {}) => ({
    name: `engageShift${shift}`,
    patch(src) {
      const lit = Number.isInteger(shift) ? `${shift}.0` : String(shift);
      return anchorOnce(src,
        'const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = -4.3;',
        `const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = ${lit};`, 'engageShift');
    },
  }),
};
