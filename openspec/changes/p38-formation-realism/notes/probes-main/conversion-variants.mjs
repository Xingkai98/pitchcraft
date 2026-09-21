// P38 #102：**转化率自适应**的源码变体库。
//
// 与 `volume-variants.mjs` 的分工：那个动的是**射门体积**（`OPEN_PLAY_SHOT_ENGAGE_SHIFT`），
// 这个动的是**转化率**（`shot_bucket`）。两者是独立的乘子，可组合。
//
// 所有变体都做**锚点唯一性检查**（`anchorOnce`）——命中 0 次或 >1 次直接抛错，
// 避免"看似应用成功实则改了别的行"（本 campaign 出过这类静默失败）。

const anchorOnce = (src, old, repl, what) => {
  if (!src.includes(old)) throw new Error(`缺锚点（${what}）：${old.slice(0, 80)}…`);
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`锚点不唯一（${what}）：命中 ${n} 次`);
  return src.replace(old, repl);
};

const f64lit = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

// ── 原始 `shot_bucket` 源码块（锚点） ───────────────────────────────────
const SHOT_BUCKET_ORIG = `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (15, 30)
    } else if dist_m <= ARC_DIST_M {
        (7, 22)
    } else {
        (4, 11)
    }
}`;

const SHOT_BUCKET_CALL_ORIG = '    let (goal_p, saved_p) = shot_bucket(dist_to_goal_m(st, shooter));';

/** 在调用点旁边取欧氏距离与角度（纯几何，零 RNG——不改变 RNG 流）。 */
const CALL_REPL = (extra) => `    let shooter_pos_for_q = st.pos[shooter as usize];
    let (goal_p, saved_p) = shot_bucket(${extra}, shot_angle_cos(st, shooter));`;

export const CONVERSION_PATCHES = {
  /** 体积杠杆（复用 `volume-variants.mjs` 的同名变体语义；这里只做别名以免跨文件耦合）。 */
  engageShift: ({ shift = -3.4 } = {}) => ({
    name: `engageShift${shift}`,
    patch(src) {
      return anchorOnce(src,
        'const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = -4.3;',
        `const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = ${f64lit(Number(shift))};`, 'engageShift');
    },
  }),

  /**
   * **对照变体**：把三桶常数**整体乘一个标量** `k`（形状不动）。
   * 用途：把"提升进球预算"这件事与"质量自适应"分离——若 `k` 单独就能达标，
   * 那自适应那一半就没有挣到任何东西（P38 的"单条判据会被买"同一教训）。
   */
  shotBucketScale: ({ k = 1.2 } = {}) => ({
    name: `shotBucketScale${k}`,
    patch(src) {
      const s = (v) => Math.round(v * Number(k));
      return anchorOnce(src, SHOT_BUCKET_ORIG, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (${s(15)}, ${s(30)})
    } else if dist_m <= ARC_DIST_M {
        (${s(7)}, ${s(22)})
    } else {
        (${s(4)}, ${s(11)})
    }
}`, 'shotBucketScale');
    },
  }),

  /**
   * **对照变体 2**：只乘 `goal%`，`saved%` 不动（`on` 三桶同理）。
   * 用途：把「质量形状」与「单纯调高进球预算」再分一层——
   * `shotBucketScale` 同时乘 goal+saved（射正率不变），本变体只乘 goal。
   * 若本变体也达标，说明形状没有挣到东西，只是"进球预算多给了点"。
   */
  shotBucketGoalOnly: ({ k = 1.0 } = {}) => ({
    name: `shotBucketGoalOnly${k}`,
    patch(src) {
      const s = (v) => Math.round(v * Number(k));
      return anchorOnce(src, SHOT_BUCKET_ORIG, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (${s(15)}, 30)
    } else if dist_m <= ARC_DIST_M {
        (${s(7)}, 22)
    } else {
        (${s(4)}, 11)
    }
}`, 'shotBucketGoalOnly');
    },
  }),

  /**
   * ★★ **更简单的竞争解**：三桶常数**各自重标**（三个整数）。
   *
   * 这是审阅者提出的对照，也是本票**最重要的一条负面证据**：
   * 它与交付变体在进球上持平（2.575 vs 2.560）、射正率**更好**（0.3828 vs 0.3365，
   * 更贴干净 main 的 0.3623），却**更简单**（3 个整数 vs 2 个浮点 + 一条折线 + 欧氏管线）。
   *
   * **它证明「形状自适应是必要的」不成立**——见 `../conversion-adaptive.md` §4.2。
   * 保留它，是为了让读者能自己复现这个反例（P38 惯例：反例必须可复现）。
   */
  shotBucketRebucket: ({ box = 17, arc = 9, far = 6, savedUnchanged = true } = {}) => ({
    name: `shotBucketRebucket`,
    patch(src) {
      return anchorOnce(src, SHOT_BUCKET_ORIG, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (${Number(box)}, 30)
    } else if dist_m <= ARC_DIST_M {
        (${Number(arc)}, 22)
    } else {
        (${Number(far)}, 11)
    }
}`, 'shotBucketRebucket');
    },
  }),

  /**
   * ★★ #102 **交付变体**：**两自由参数**的最小质量自适应。
   *
   * 与下面的 `shotBucketQuality` 的区别（这条区别就是本变体存在的理由）：
   *   - 质量变量**复用引擎自己的 `distance_quality` 折线**（结点 6/16.5/25/35 全是引擎既有常数），
   *     只把输入从 `dist_to_goal_m`（x-only）换成**欧氏**距离。**不引入任何新的形状常数。**
   *   - **不带角度**——真实数据里 `angleCos` 的 AUC 是 **0.505（纯噪声）**，不是可辩护的维度
   *     （`tradeoff-breaking.md` §1.2）。`shotBucketQuality` 里的 `angleFloor` 是拍脑袋加的。
   *   - 于是只剩 **两个**自由参数：`gMax` / `sMax` = 「贴门正对时的 goal% / saved%」，
   *     两个都是**可命名的物理量**，不是拟合出来的拐点。
   *
   * ⚠️ 为什么自由参数少很重要：`notes/criteria/README.md` 的 exp4b 正是
   * 「指标全绿但是纯 hack」的反例。参数少的模型即使达标，其参数值仍可被独立辩护。
   */
  shotBucketQualityMin: ({ gMax = 19, sMax = 31, qOne = null, qZero = null } = {}) => ({
    name: `shotBucketQualityMin`,
    patch(src) {
      // 折线体在**模板外**先算好再插值——写在模板里 `${...}` 不会被求值
      // （第一版就栽在这：三元表达式被原样写进了 Rust 源码）。
      const bandBody = (qOne !== null && qZero !== null)
        ? `    // 陡降形态（对照）：q=1 直到 ${qOne}m，线性降到 ${qZero}m 归零——用来检验
    // 「引擎既有折线降得不够快」是不是 arc 桶比例越界的真因。
    if d <= ${f64lit(Number(qOne))} {
        1.0
    } else if d <= ${f64lit(Number(qZero))} {
        lerp(1.0, 0.0, (d - ${f64lit(Number(qOne))}) / (${f64lit(Number(qZero))} - ${f64lit(Number(qOne))}))
    } else {
        0.0
    }`
        : `    if d <= 6.0 {
        1.0
    } else if d <= BOX_DIST_M {
        lerp(1.0, 0.9, (d - 6.0) / (BOX_DIST_M - 6.0))
    } else if d <= ARC_DIST_M {
        lerp(0.9, 0.45, (d - BOX_DIST_M) / (ARC_DIST_M - BOX_DIST_M))
    } else if d <= 35.0 {
        lerp(0.45, 0.05, (d - ARC_DIST_M) / (35.0 - ARC_DIST_M))
    } else {
        lerp(0.05, 0.0, (d - 35.0) / (PITCH_LENGTH_M - 35.0))
    }`;
      // P9 桶边界（BOX_DIST_M/ARC_DIST_M）保持不变——shot_bucket_index、
      // P29 hazard 的 distance_quality 与单测都依赖它们；本变体只替换**桶内的取值方式**。
      const fnBody = [
        'fn shot_bucket(dist_m: f64, dist_euclid_m: f64) -> (u64, u64) {',
        '    let _ = dist_m;',
        '    // 质量 = 引擎既有的 distance_quality 折线，输入换成**欧氏**距离（含 y 角向）。',
        '    let q = shot_quality_banded(dist_euclid_m);',
        `    let goal = (${f64lit(Number(gMax))} * q).round() as i64;`,
        `    let saved = (${f64lit(Number(sMax))} * q).round() as i64;`,
        '    (goal.clamp(0, 100) as u64, saved.clamp(0, 100) as u64)',
        '}',
        '',
        '/// P38 #102：射门质量分。折线结点与 distance_quality 逐字相同',
        '/// （6→1.0 / 16.5→0.9 / 25→0.45 / 35→0.05 / 105→0），只把输入从「只按纵深」',
        '/// （dist_to_goal_m）换成**欧氏**距离——真实侧实测同一特征判别力 AUC 0.192 → 0.329',
        '/// （notes/tradeoff-breaking.md §1.2）。不引入角度维度：真实数据里它 AUC 0.505 = 噪声。',
        'fn shot_quality_banded(dist_euclid_m: f64) -> f64 {',
        '    let d = dist_euclid_m;',
        bandBody,
        '}',
      ].join('\n');
      let out = anchorOnce(src, SHOT_BUCKET_ORIG, fnBody, 'shotBucketQualityMin');
      out = anchorOnce(out, SHOT_BUCKET_CALL_ORIG,
        `    let euclid_m = euclid_to_goal_m(st, shooter);
    let (goal_p, saved_p) = shot_bucket(dist_to_goal_m(st, shooter), euclid_m);`,
        'shotBucketQualityMin.call');
      out = anchorOnce(out, 'fn shot_angle_cos(st: &MatchState, id: i32) -> f64 {',
        `/// 球员到所攻球门**中心**的欧氏距离（米）。与 \`shot_angle_cos\` 同一组 dx/dy——
/// 两者必须同口径。注意与 \`dist_to_goal_m\`（只按纵深）的区别：那是 hazard 的
/// \`distance_quality\` 口径，本量是**射门质量**口径（P38 #102）。
fn euclid_to_goal_m(st: &MatchState, id: i32) -> f64 {
    let home = st.possession == 0;
    let p = st.pos[id as usize];
    let dx = if home { (1.0 - p.0) * PITCH_LENGTH_M } else { p.0 * PITCH_LENGTH_M };
    let dy = if home { (0.5 - p.1) * PITCH_WIDTH_M } else { (p.1 - 0.5) * PITCH_WIDTH_M };
    dx.hypot(dy)
}

fn shot_angle_cos(st: &MatchState, id: i32) -> f64 {`, 'shotBucketQualityMin.euclid');
      return out;
    },
  }),

  /**
   * ★ #102 主变体：**质量自适应转化率**。
   *
   * 质量维度只用两个（理由见 `notes/conversion-adaptive.md` §设计）：
   *   1. 到球门中心的**欧氏**距离（含 y 角向）
   *   2. `shot_angle_cos`（与进攻方向的夹角余弦）
   * **不接**最近防守者距离——`#89` 去一法证明它不承载独有信息（AUC 0.844→0.844）。
   *
   * 曲线：`goal%(q) = G_MIN + (G_MAX-G_MIN)*q`，`saved%(q) = S_MIN + (S_MAX-S_MIN)*q`，
   * `q = clamp01((Q_NEAR - euclid_m) / (Q_NEAR - Q_FAR)) * angle_factor(angle_cos)`。
   * `q=0`（远且偏）→ (G_MIN, S_MIN)；`q=1`（贴门正对）→ (G_MAX, S_MAX)。
   */
  shotBucketQuality: ({
    qNear = 6.0, qFar = 30.0, angleFloor = 0.55,
    gMax = 40, gMin = 1, sMax = 34, sMin = 6,
  } = {}) => ({
    name: `shotBucketQuality`,
    patch(src) {
      let out = anchorOnce(src, SHOT_BUCKET_ORIG, `fn shot_bucket(dist_m: f64, dist_euclid_m: f64, angle_cos: f64) -> (u64, u64) {
    // P9 桶边界（\`BOX_DIST_M\`/\`ARC_DIST_M\`）保持不变——\`shot_bucket_index\`、
    // P29 hazard 的 \`distance_quality\` 与单测 \`p29_distance_quality_reuses_shot_bucket_bands\`
    // 都依赖它们；本变体只替换**桶内的转化率取值方式**。
    let _ = dist_m;
    let q = shot_quality(dist_euclid_m, angle_cos);
    let goal = (${f64lit(Number(gMin))} + (${f64lit(Number(gMax))} - ${f64lit(Number(gMin))}) * q).round() as i64;
    let saved = (${f64lit(Number(sMin))} + (${f64lit(Number(sMax))} - ${f64lit(Number(sMin))}) * q).round() as i64;
    (goal.clamp(0, 100) as u64, saved.clamp(0, 100) as u64)
}

/// P38 #102：射门质量分 ∈ [0,1]（1 = 贴门正对）。纯函数、零 RNG、无状态。
///
/// 只有两个维度：**欧氏**距离（含 y 角向——引擎旧口径 \`dist_to_goal_m\` 只按纵深，
/// 真实侧判别力 AUC 0.329 vs 欧氏 0.192，弱一大截）与射门角度余弦。
/// 角度按**乘法**折进质量：正对球门不折，边路越偏折得越狠（下限 \`ANGLE_FLOOR\`）。
fn shot_quality(dist_euclid_m: f64, angle_cos: f64) -> f64 {
    // ⚠️ 方向必须是「近门 → 1」。等价写法 (Q_NEAR - d)/(Q_NEAR - Q_FAR) 是**反的**
    // （分母为负 → 越远越大）；设计阶段的分析脚本第一版就栽在这上面。
    let d = clamp01((${f64lit(Number(qFar))} - dist_euclid_m) / (${f64lit(Number(qFar))} - ${f64lit(Number(qNear))}));
    let a = clamp01(angle_cos.max(0.0));
    d * (${f64lit(Number(angleFloor))} + (1.0 - ${f64lit(Number(angleFloor))}) * a)
}`, 'shotBucketQuality');
      out = anchorOnce(out, SHOT_BUCKET_CALL_ORIG,
        `    let euclid_m = euclid_to_goal_m(st, shooter);
    let (goal_p, saved_p) = shot_bucket(dist_to_goal_m(st, shooter), euclid_m, shot_angle_cos(st, shooter));`,
        'shotBucketQuality.call');
      // 欧氏到球门中心的距离：与 `shot_angle_cos` 同源（同一 dx/dy），保证两者口径一致。
      out = anchorOnce(out, 'fn shot_angle_cos(st: &MatchState, id: i32) -> f64 {',
        `/// 球员到所攻球门**中心**的欧氏距离（米）。与 \`shot_angle_cos\` 同一组 dx/dy——
/// 两者必须同口径，否则"距离近但角度按另一套算"会自相矛盾。
/// 注意与 \`dist_to_goal_m\`（只按纵深）的区别：那是 hazard 的 \`distance_quality\` 口径，
/// 本量是**射门质量**口径（P38 #102）。
fn euclid_to_goal_m(st: &MatchState, id: i32) -> f64 {
    let home = st.possession == 0;
    let p = st.pos[id as usize];
    let dx = if home { (1.0 - p.0) * PITCH_LENGTH_M } else { p.0 * PITCH_LENGTH_M };
    let dy = if home { (0.5 - p.1) * PITCH_WIDTH_M } else { (p.1 - 0.5) * PITCH_WIDTH_M };
    dx.hypot(dy)
}

fn shot_angle_cos(st: &MatchState, id: i32) -> f64 {`, 'shotBucketQuality.euclid');
      return out;
    },
  }),
};

/** 组合多个 patch（按顺序应用；每个都做锚点唯一性检查）。 */
export function applyPatches(src, list) {
  let out = src;
  for (const p of list) out = p.patch(out);
  return out;
}
