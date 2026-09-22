// P104：**体积重标定**的源码变体库（锚点唯一性检查，命中 0/多次即抛错）。
//
// 与 P38 `probes-main/conversion-variants.mjs` 的分工：那个动**转化率**（shot_bucket），
// 本文件动**体积**（射门频率 + 抢断频率）。两者独立，可组合。
//
// ⚠️ 本文件刻意**不 import P38 的变体库**——P38 的 `notes/` 是探索产出存档，
// 不是本 change 的依赖；跨 change 耦合会让 P38 归档移动时本探针静默失效。

const anchorOnce = (src, old, repl, what) => {
  if (!src.includes(old)) throw new Error(`缺锚点（${what}）：${old.slice(0, 90)}…`);
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`锚点不唯一（${what}）：命中 ${n} 次`);
  return src.replace(old, repl);
};

const f64lit = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

const num = (src, old, repl, what) => anchorOnce(src, old, repl, what);

export const PATCHES = {
  /** 体积杠杆：普通射门频率。干净 main = −4.3。 */
  engageShift: ({ shift = -3.4 } = {}) => ({
    name: `engageShift(${shift})`,
    patch: (src) => num(src,
      'const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = -4.3;',
      `const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = ${f64lit(Number(shift))};`, 'engageShift'),
  }),

  // ── 抢断体积杠杆候选（每个都是**单常量**，从最简族开始） ──────────────────
  //
  // 抢断的选取在 `select_defensive_action`：每个防守机会点对 tackle/foul/contain/jockey
  // 打分取最高。机会点总数与防守打分无关（打分零 RNG）→ **动作占比是一块固定大小的饼**，
  // 抬抢断只能从 contain/jockey（不产事件）与 foul 里切。

  /** 抢断「脚下」尺度：closeness 归零距离。2.5m → 更大 = 更多距离上抢断能竞争。 */
  tackleContactScale: ({ m = 2.5 } = {}) => ({
    name: `tackleContactScale(${m})`,
    patch: (src) => num(src, 'const DEF_CONTACT_SCALE_M: f64 = 2.50;',
      `const DEF_CONTACT_SCALE_M: f64 = ${f64lit(Number(m))};`, 'tackleContactScale'),
  }),

  /** 抢断打分基线（加法，与 TACKLE_EAGERNESS 同项）。−1.10 → 更负/更正。 */
  baseDefTackle: ({ v = -1.1 } = {}) => ({
    name: `baseDefTackle(${v})`,
    patch: (src) => num(src, 'const BASE_DEF_TACKLE: f64 = -1.10;',
      `const BASE_DEF_TACKLE: f64 = ${f64lit(Number(v))};`, 'baseDefTackle'),
  }),

  /** 抢断积极性（与 base 相加，语义 = 无几何倾向）。0.5 → 更大。 */
  tackleEagerness: ({ v = 0.5 } = {}) => ({
    name: `tackleEagerness(${v})`,
    patch: (src) => num(src, 'pub const TACKLE_EAGERNESS: f64 = 0.5;',
      `pub const TACKLE_EAGERNESS: f64 = ${f64lit(Number(v))};`, 'tackleEagerness'),
  }),

  /** 抢断 closeness 增益（必须 > FOUL_CLOSENESS_GAIN=0.55）。1.80 → 更大。 */
  tackleClosenessGain: ({ v = 1.8 } = {}) => ({
    name: `tackleClosenessGain(${v})`,
    patch: (src) => num(src, 'const TACKLE_CLOSENESS_GAIN: f64 = 1.80;',
      `const TACKLE_CLOSENESS_GAIN: f64 = ${f64lit(Number(v))};`, 'tackleClosenessGain'),
  }),

  /** 抢断就近资格阈值。12m → 更大 = 更远处也能产防守动作（同时放开 contain/jockey）。 */
  tackleThreshold: ({ m = 12 } = {}) => ({
    name: `tackleThreshold(${m})`,
    patch: (src) => num(src, 'pub const TACKLE_DISTANCE_THRESHOLD_METERS: f64 = 12.0;',
      `pub const TACKLE_DISTANCE_THRESHOLD_METERS: f64 = ${f64lit(Number(m))};`, 'tackleThreshold'),
  }),

  /** defender 级抢断冷却（tick）。4 → 更小 = 同一防守者更快能再抢。 */
  tackleCooldown: ({ v = 4 } = {}) => ({
    name: `tackleCooldown(${v})`,
    patch: (src) => num(src, 'const TACKLE_COOLDOWN_TICKS: u32 = 4;',
      `const TACKLE_COOLDOWN_TICKS: u32 = ${String(v)};`, 'tackleCooldown'),
  }),

  /** pair 级接触冷却（tick）。6 → 更小。 */
  pairCooldown: ({ v = 6 } = {}) => ({
    name: `pairCooldown(${v})`,
    patch: (src) => num(src, 'const CONTACT_PAIR_COOLDOWN_TICKS: u32 = 6;',
      `const CONTACT_PAIR_COOLDOWN_TICKS: u32 = ${String(v)};`, 'pairCooldown'),
  }),

  /** 抢断冷却惩罚权重。0.60 → 更小 = 冷却期内仍更易抢。 */
  tackleCdPenalty: ({ v = 0.6 } = {}) => ({
    name: `tackleCdPenalty(${v})`,
    patch: (src) => num(src, 'const TACKLE_CD_PENALTY: f64 = 0.60;',
      `const TACKLE_CD_PENALTY: f64 = ${f64lit(Number(v))};`, 'tackleCdPenalty'),
  }),

  /** 抢断坏角度惩罚。0.50 → 更小 = 身后也能抢（会挤压犯规）。 */
  tackleBadAngle: ({ v = 0.5 } = {}) => ({
    name: `tackleBadAngle(${v})`,
    patch: (src) => num(src, 'const TACKLE_BAD_ANGLE_PENALTY: f64 = 0.50;',
      `const TACKLE_BAD_ANGLE_PENALTY: f64 = ${f64lit(Number(v))};`, 'tackleBadAngle'),
  }),

  /** 抢断「迎面逼近」增益。0.50。 */
  tackleApproachGain: ({ v = 0.5 } = {}) => ({
    name: `tackleApproachGain(${v})`,
    patch: (src) => num(src, 'const TACKLE_APPROACH_GAIN: f64 = 0.50;',
      `const TACKLE_APPROACH_GAIN: f64 = ${f64lit(Number(v))};`, 'tackleApproachGain'),
  }),

  // ── 通道杠杆：机会点**速率**（与"每次机会的倾向"正交） ─────────────────
  //
  // 上面所有杠杆动的都是「同一个机会点上选谁」——那是一块固定大小的饼。
  // 若抬高机会点**密度**，饼本身变大 → 抢断与犯规可以**同时**增长（真实比赛两者都高）。
  // 这是与"切份额"完全不同的机制，必须单独试，否则会误判"抢断必然吃掉犯规"。
  baseDeadline: ({ v = 7 } = {}) => ({
    name: `baseDeadline(${v})`,
    patch: (src) => num(src, 'const BASE_ACTION_DEADLINE_TICKS: u32 = 7;',
      `const BASE_ACTION_DEADLINE_TICKS: u32 = ${String(v)};`, 'baseDeadline'),
  }),
  maxDeadline: ({ v = 12 } = {}) => ({
    name: `maxDeadline(${v})`,
    patch: (src) => num(src, 'const MAX_ACTION_DEADLINE_TICKS: u32 = 12;',
      `const MAX_ACTION_DEADLINE_TICKS: u32 = ${String(v)};`, 'maxDeadline'),
  }),

  // ── 犯规侧（抢断抬升会切走犯规份额，必要时回调） ──────────────────────
  baseDefFoul: ({ v = -0.1 } = {}) => ({
    name: `baseDefFoul(${v})`,
    patch: (src) => num(src, 'const BASE_DEF_FOUL: f64 = -0.10;',
      `const BASE_DEF_FOUL: f64 = ${f64lit(Number(v))};`, 'baseDefFoul'),
  }),

  // ── #102 遗留：转化率重标（与体积正交；本 change 用于**对照**） ──────────
  shotBucket: ({ box = 15, arc = 7, far = 4, boxSaved = 30, arcSaved = 22, farSaved = 11 } = {}) => ({
    name: `shotBucket(${box}/${arc}/${far})`,
    patch: (src) => num(src, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (15, 30)
    } else if dist_m <= ARC_DIST_M {
        (7, 22)
    } else {
        (4, 11)
    }
}`, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (${box}, ${boxSaved})
    } else if dist_m <= ARC_DIST_M {
        (${arc}, ${arcSaved})
    } else {
        (${far}, ${farSaved})
    }
}`, 'shotBucket'),
  }),
};

/** 组合多个 patch（按顺序；每个都做锚点唯一性检查）。 */
export function applyPatches(src, list) {
  let out = src;
  for (const p of list) out = p.patch(out);
  return out;
}

/** 从 'name:{"k":v}' 规格串建 patch（CLI 用）。 */
export function patchFromSpec(spec) {
  const i = spec.indexOf(':');
  const name = i < 0 ? spec : spec.slice(0, i);
  const params = i < 0 ? {} : JSON.parse(spec.slice(i + 1));
  if (!PATCHES[name]) throw new Error(`未知变体 ${name}（可用：${Object.keys(PATCHES).join(', ')}）`);
  return PATCHES[name](params);
}
