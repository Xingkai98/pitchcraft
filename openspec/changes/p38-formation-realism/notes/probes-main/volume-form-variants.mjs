// P38 体积补偿（第二步）：**重测已证伪方案**用的队形变体。
//
// 目的：把体积抬到真实量级（`engageShift -3.4`）之后，看这些**当时被证伪的方案**
// 是否**还崩**。若还崩 → 它们的失败与体积无关（体积不是它们的病因）；
// 若不再崩 → 说明它们是**体积的受害者**，"修体积能解锁队形"成立。
//
// 两个典型（按 `notes/findings-final.md` 与 `candidates/03-decouple/README.md` 选）：
//   exp4b   —— 等间距块：纵深达标但射门 −93%（**与射门耦合**的教科书反例）
//   decouple—— 两队块锚相位解耦：射门 ×2.1 但重心间距恶化 7.8→16.8
//
// ⚠️ `decouple` 逐字复制 `candidates/03-decouple/cand03-decouple.patch` 的源码改动
//    （常量 + `formation_target` 里的一行），保证"重测的是同一个方案"。

const anchorOnce = (src, old, repl, what) => {
  if (!src.includes(old)) throw new Error(`缺锚点（${what}）：${old.slice(0, 70)}…`);
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`锚点不唯一（${what}）：命中 ${n} 次`);
  return src.replace(old, repl);
};

export const FORM_PATCHES = {
  /** 候选 03：非持球方的块锚滞后 `lag`（归一化）。源码里是 `DECOUPLE_LAG` 常量。 */
  decouple: ({ lag = 0.10 } = {}) => ({
    name: `decouple${lag}`,
    patch(src) {
      let out = anchorOnce(src,
        'pub const SIDE_SHIFT_FACTOR: f64 = 0.06;',
        `pub const SIDE_SHIFT_FACTOR: f64 = 0.06;

/// **两队队形解耦滞后**（P38 候选03）：非持球方的块锚相对球位**滞后**这么多（归一化）。
pub const DECOUPLE_LAG: f64 = ${Number(lag)};`, 'decouple-const');
      out = anchorOnce(out,
        '    let mut tx = base.0 + shift + attack_dir * press;',
        `    let my_team_is_attacking = (home && st.possession == 0) || (!home && st.possession == 1);
    let decouple = if my_team_is_attacking { 0.0 } else { -DECOUPLE_LAG };
    let mut tx = base.0 + shift + decouple + attack_dir * press;`, 'decouple-tx');
      return out;
    },
  }),

  /**
   * ★ 候选 03 的**实际组合**（`candidates/03-decouple/combined-with-equal-spacing.patch`）：
   * exp4b 等间距块 **+** 块锚相位解耦写进**同一个** `formation_target` 分支。
   * 这是"唯一一个在队形压到真实量级的前提下没让引擎崩掉"的方案
   * （`README.md`：纵深 27.1、射门 3.8 vs exp4b 单独的 1.8）——
   * 本轮在**体积修好**的新基线上重测它，是"修体积能否解锁队形"的**决定性实验**。
   */
  exp4bDecouple: ({ span = 0.32, base = 0.165, gain = 0.59, lag = 0.10 } = {}) => ({
    name: `exp4bDecouple_lag${lag}`,
    patch(src) {
      return anchorOnce(src,
        'fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {\n',
        `fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {
    // === P38 exp4b + 候选03 组合：等间距块 + 两队相位解耦 ===
    if id != 0 && id != 21 {
        let home = id <= 10;
        let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
        let mut sorted = ids.clone();
        sorted.sort_by(|&a, &b| st.lineup[a as usize].0.partial_cmp(&st.lineup[b as usize].0).unwrap());
        let r = sorted.iter().position(|&v| v == id).unwrap() as f64 / 9.0;
        let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
        let my_team_is_attacking = (home && st.possession == 0) || (!home && st.possession == 1);
        let lag = if my_team_is_attacking { 0.0 } else { ${Number(lag)} };
        let centre = (${base} + ${gain} * ball_own - lag).clamp(0.12, 0.82);
        let rear = (centre - ${span} * 0.5).clamp(0.04, 0.86);
        let tx_local = rear + ${span} * r;
        let tx = if home { tx_local } else { 1.0 - tx_local };
        let ty = st.lineup[id as usize].1;
        return (clamp01(tx).clamp(0.04, 0.9), clamp01(ty));
    }
`, 'exp4b-decouple-insert');
    },
  }),

  /** exp4b：等间距次序目标 + 球锚定（逐字取自 `notes/patches/exp4b-equal-spacing.patch`）。 */
  equalSpacing: ({ span = 0.32, base = 0.165, gain = 0.59 } = {}) => ({
    name: `equalSpacing_${span}_${base}_${gain}`,
    patch(src) {
      return anchorOnce(src,
        'fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {\n',
        `fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {
    // === P38 exp4b：等间距次序目标 + 球锚定 ===
    if id != 0 && id != 21 {
        let home = id <= 10;
        let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
        let mut sorted = ids.clone();
        sorted.sort_by(|&a, &b| st.lineup[a as usize].0.partial_cmp(&st.lineup[b as usize].0).unwrap());
        let r = sorted.iter().position(|&v| v == id).unwrap() as f64 / 9.0;
        let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
        let centre = (${base} + ${gain} * ball_own).clamp(0.12, 0.82);
        let rear = (centre - ${span} * 0.5).clamp(0.04, 0.86);
        let tx = if home { rear + ${span} * r } else { 1.0 - (rear + ${span} * r) };
        return (clamp01(tx).clamp(0.04, 0.9), clamp01(st.lineup[id as usize].1));
    }
`, 'exp4b-insert');
    },
  }),

};

export function applyFormPatches(src, list) {
  let out = src;
  for (const p of list) out = p.patch(out);
  return out;
}
