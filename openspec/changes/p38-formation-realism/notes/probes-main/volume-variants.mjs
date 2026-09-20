// P38 体积补偿假说（第二步）：**只动体积**的源码变体。
//
// 上游发现（`probe-volume-compensation.mjs`，本 worktree 干净 main 实测）：
//   引擎的射正率 0.355 / 转化率 0.106 / 传球成功率 0.848 **都不高于真实**
//   （真实：0.489 / 0.173 / 0.913；文献带：~0.33 / ~0.10 / 0.80–0.90）。
//   即 **L3 报告 §二 的「高转化 + 高射正 + 零失败传球」补偿链在当前 main 上已不成立**
//   （那条结论测于 2026-08-23，早于 p9/p13）。而**体积压缩仍然成立**：
//   射门 7.75 vs 16.51（0.47×）、进球 0.81 vs 2.84（0.28×）、传球 418 vs 833（0.50×）。
//
// 于是第二步的问题变成**更干净的一条**：把体积单独抬向真实，**别的不动**，
// 看队形判据之间的兑换是否还在。不需要"回调转化率"——因为转化率本就在真实水平，
// 抬体积会**自然**把进球带到真实量级附近（这一点由实测决定，不由假设决定）。
//
// 两个变体：
//   `engageShift`  —— 唯一的体积杠杆：抬「射门推进」的 hazard 平移量。
//                     上一轮实测：单独抬它 射门 7.2 → 26.8，**犯规稳定在 20–26**
//                     （`notes/tradeoff-breaking.md` §3）——是一个**不兑换**的杠杆。
//   `shotBucket`   —— ⚠️ **只在实测显示进球越过真实时才用**。把 `shot_bucket` 的
//                     三桶 (goal, saved) 按比例缩放，用来把进球预算压回真实量级。
//                     本文件**不预设**一定会用它（预设就变成了对着假设调参）。

const anchorOnce = (src, old, repl, what) => {
  if (!src.includes(old)) throw new Error(`缺锚点（${what}）：${old.slice(0, 60)}…`);
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`锚点不唯一（${what}）：命中 ${n} 次`);
  return src.replace(old, repl);
};

const f64lit = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

export const VOLUME_PATCHES = {
  /** 体积杠杆：整体平移「射门推进」hazard。源码值 −4.3；越小越容易命中。 */
  engageShift: ({ shift = -3.5 } = {}) => ({
    name: `engageShift${shift}`,
    patch(src) {
      return anchorOnce(src,
        'const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = -4.3;',
        `const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = ${f64lit(Number(shift))};`, 'engageShift');
    },
  }),

  /**
   * 进球预算闸：按**乘数**缩放三桶的 (goal%, saved%)。
   * `s` 是乘数（1.0 = 不改）。`k` 是公共因子，作用在 goal 与 saved 上，
   * 保持「射正率」不变（射正率 = (goal+saved)/100，两边同步缩放即不变）。
   * ⚠️ 乘数**不写死**——由实测的「进球 / 目标进球」反推。
   */
  shotBucket: ({ k = 1.0 } = {}) => ({
    name: `shotBucketK${k}`,
    patch(src) {
      const scale = (v) => Math.round(v * Number(k));
      const [bg, bs] = [scale(15), scale(30)];
      const [ag, as] = [scale(7), scale(22)];
      const [fg, fs] = [scale(4), scale(11)];
      return anchorOnce(src, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (15, 30)
    } else if dist_m <= ARC_DIST_M {
        (7, 22)
    } else {
        (4, 11)
    }
}`, `fn shot_bucket(dist_m: f64) -> (u64, u64) {
    if dist_m <= BOX_DIST_M {
        (${bg}, ${bs})
    } else if dist_m <= ARC_DIST_M {
        (${ag}, ${as})
    } else {
        (${fg}, ${fs})
    }
}`, 'shotBucket');
    },
  }),
};

/** 组合多个 patch（按顺序应用；每个都做锚点唯一性检查）。 */
export function applyPatches(src, list) {
  let out = src;
  for (const p of list) out = p.patch(out);
  return out;
}
