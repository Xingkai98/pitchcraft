// P38 阶段 2：**防守两层结构**的源码变体库 —— 每个变体 = 一段插进 `formation_target`
// 的代码，作用在「等间距纵深基座」之上（exp4b 那一族）。
//
// 为什么用变体库而不是一个参数化脚本：
//   exp4b 的纵深修复**已经**存在（等间距块 + 球锚定），阶段 2 的任务不是重做它，
//   而是在它上面**加防守分层**。分层是**结构**改动（谁去压迫、谁去保护），
//   不是单个标量——参数化会逼着把结构硬塞进一个数，掩盖"两种结构"的差别。
//
// 每个变体返回 { name, patch(src) } —— patch 拿到源码、返回改后的源码。
// ⚠️ 每个 patch **必须自己保证锚点存在**（锚点缺失要抛，不能静默不生效——
// "改了但没生效"是 P38 反复出的那类假绿）。

// exp4b 的等间距块（与 notes/patches/exp4b-equal-spacing.patch 同一段逻辑，抽出来复用）。
// 说明：**两队共用同一个球位公式**（各自镜像），这是"块随球平移"的共同信号源。
const EXP4B_BLOCK = `
    if id != 0 && id != 21 {
        let home = id <= 10;
        let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
        let mut sorted = ids.clone();
        sorted.sort_by(|&a, &b| st.lineup[a as usize].0.partial_cmp(&st.lineup[b as usize].0).unwrap());
        let r = sorted.iter().position(|&v| v == id).unwrap() as f64 / 9.0;
        let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
        let centre = (0.165 + 0.59 * ball_own).clamp(0.12, 0.82);
        let rear = (centre - 0.32 * 0.5).clamp(0.04, 0.86);
        let tx_local = rear + 0.32 * r;
        let tx = if home { tx_local } else { 1.0 - tx_local };
        let ty = st.lineup[id as usize].1;
        return (clamp01(tx).clamp(0.04, 0.9), clamp01(ty));
    }
`;

// 米 → 归一化（沿球场长轴）
const MX = (m) => (m / 105).toFixed(6);

// ── 变体定义 ─────────────────────────────────────────────────────────────
export const VARIANTS = {
  // 基座：只有 exp4b，没有分层（对照）
  exp4b: () => EXP4B_BLOCK,

  // ★ 核心假设：**防守方内部按纵深排名分角色**。
  //   最靠前的 `pressN` 人执行压迫（贴球），其余保持"保护层"——
  //   保护层停在球的**后方 `holdM` 米**、且横向跟球。
  //
  //   与 exp4b 的区别在**谁动**：exp4b 是整块随球平移（两队共用一个球位信号），
  //   本变体让防守方内部**分化**——压迫者贴球、保护者留后。
  //   预期：d1 仍小（有人贴），d2 回到 5-6m（保护层没被吸到球上）。
  defendLayers: ({ pressN = 2, pressM = 2.5, holdM = 6.0, spreadM = 9.0 } = {}) => `
    if id != 0 && id != 21 {
        let home = id <= 10;
        let own_goal_x = if home { 0.0 } else { 1.0 };
        let def_team = 1 - st.possession;
        let i_am_def = if def_team == 0 { home } else { !home };
        if i_am_def {
            // 防守方：按**纵深排名**（离本方门线的距离，取静态模板——不读实时位置，
            // 否则排名会随球跳动，产生整队 shuffle）。
            let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
            let mut sorted: Vec<i32> = ids.iter().copied().filter(|&v| !st.sent_off[v as usize]).collect();
            sorted.sort_by(|&a, &b| {
                (st.lineup[a as usize].0 - own_goal_x).abs()
                    .partial_cmp(&(st.lineup[b as usize].0 - own_goal_x).abs()).unwrap()
            });
            let rank = sorted.iter().position(|&v| v == id).unwrap_or(99);
            // 球在**我方半场坐标系**里的纵深（0=本方门线，1=对方门线）
            let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
            // 保护层基准：球后方 holdM 米；再按排名依次后撤，形成纵深
            let hold_local = (ball_own - ${MX(holdM)}).clamp(0.04, 0.9);
            if rank < ${pressN} {
                // 压迫层：站球与自己球门之间 pressM 米处（贴球）
                let press_local = (ball_own - ${MX(pressM)}).clamp(0.04, 0.9);
                let ty = (0.5 + (st.ball_pos.1 - 0.5) * 0.85).clamp(0.12, 0.88);
                let tx = if home { press_local } else { 1.0 - press_local };
                return (clamp01(tx), clamp01(ty));
            }
            // 保护层：在球后方 holdM 米，按排名向后铺开 spreadM
            let back_rank = (rank - ${pressN}) as f64;
            let local = (hold_local - back_rank / 8.0 * ${MX(spreadM)}).clamp(0.04, 0.9);
            // 横向：跟球但**幅度收敛**（球侧过载）
            let ty = (0.5 + (st.ball_pos.1 - 0.5) * 0.55
                + (st.lineup[id as usize].1 - 0.5) * 0.5).clamp(0.12, 0.88);
            let tx = if home { local } else { 1.0 - local };
            return (clamp01(tx), clamp01(ty));
        }
        // 进攻方：走 exp4b 的等间距块（纵深基座不变）
        let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
        let mut sorted = ids.clone();
        sorted.sort_by(|&a, &b| st.lineup[a as usize].0.partial_cmp(&st.lineup[b as usize].0).unwrap());
        let r = sorted.iter().position(|&v| v == id).unwrap() as f64 / 9.0;
        let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
        let centre = (0.165 + 0.59 * ball_own).clamp(0.12, 0.82);
        let rear = (centre - 0.32 * 0.5).clamp(0.04, 0.86);
        let tx = if home { rear + 0.32 * r } else { 1.0 - (rear + 0.32 * r) };
        return (clamp01(tx).clamp(0.04, 0.9), clamp01(st.lineup[id as usize].1));
    }
`,
};

// 把变体插进 formation_target（锚点：函数体第一行 `let base = st.lineup[id as usize];`）
export function applyVariant(src, block) {
  const ANCHOR = 'fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {\n';
  if (!src.includes(ANCHOR)) throw new Error('缺 formation_target 锚点');
  return src.replace(ANCHOR, `${ANCHOR}${block}`);
}

// ── 射门链的**独立**变体（同样从 formation_target 注入，但改的是 hazard 判据）──
// 为什么在这里也放一份：射门崩的机制不在队形，而在**持球者受压时的出球门**。
// 一起放进同一变体库，才能让"只改队形"与"只改射门门"在同一把尺子下对比。
//
// 用法：把这些 patch 叠在 exp4b 之上（`applyVariant(src, VARIANTS.exp4b() + SCORE_PATCHES.x)`）。

// ⚠️ 出球门（`OPEN_PLAY_PASS_PRESSURE_M`）只在 `evaluate_open_play_carrier_action`
// 的 gate ① 生效，且它是**硬门**：最近的防守者一旦 ≤8m，持球者**永远选传球**，
// 根本走不到 gate ② 的射门推进档。真实球员在 2.0–2.9m 压力下起脚——
// 说明这个门在真实尺度上**太宽了**。
export const SCORE_PATCHES = {
  // 只把出球门的距离阈值收紧（其余全不动）——这是最小、最干净的干预
  passGateMeters: (m) => ({
    name: `passGate${m}m`,
    patch(src) {
      const OLD = 'const OPEN_PLAY_PASS_PRESSURE_M: f64 = 8.0;';
      if (!src.includes(OLD)) throw new Error(`缺 ${OLD}`);
      // f64 字面量：`3` 会被 rustc 判为整数类型错误（P38 踩过一次，构建失败但被
      // try/finally 正确还原——还原路径本身由此得到验证）
      const lit = Number.isInteger(m) ? `${m}.0` : String(m);
      return src.replace(OLD, `const OPEN_PLAY_PASS_PRESSURE_M: f64 = ${lit};`);
    },
  }),
};
