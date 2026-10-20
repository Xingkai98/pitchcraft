//! C3 盯人：给防守方分配「盯谁」，并用换人惩罚抑制抖动。
//!
//! ## 为什么
//!
//! 旧引擎只有一个 `OPEN_PRESS_N = 1` 的开放局逼抢，其余防守者奔向自己的队形基准点——
//! **不存在「我盯的是谁」这个概念**。结果是两队列成平行带（`mix` 0.45）、防守者不跟着人横移
//! （`lat` 0.29）。
//!
//! ## 机制
//!
//! 1. 代价 = **时间-拦截** `τ = 距离 / 逼近速度`（不是纯距离——纯距离会退化成「最近的 N 人」）
//! 2. **换人惩罚**：若某人上一拍盯的不是当前这个对手，代价 + `SWITCH_PENALTY_S`
//! 3. 贪心最小代价匹配（10×10 规模，O(n² log n)）；平局按 id 升序，保证确定性
//! 4. 未被匹配的防守者回落队形基准点
//!
//! ## 开关
//!
//! `MatchConfig.realism.marking`，默认关闭。

use crate::{PITCH_LENGTH_M, PITCH_WIDTH_M};

/// 换人惩罚（秒）。等价于「多花 0.8 秒也要继续盯原来那个人」。
///
/// 取 0.8s：一次 5m 的换防大约值 0.8s 的到达时间，足够压住「每拍换一个人」的抖动，
/// 又不会把明显更好的匹配锁死。
pub const SWITCH_PENALTY_S: f64 = 0.8;

/// 盯人停距（米）：站在被盯人与本方球门之间，保持这个距离。
///
/// 必须 **> 4m**（`OPEN_PLAY_PASS_PRESSURE_M`，否则持球者恒判被逼抢、射门推进档锁死），
/// 且 **≤ 8m**（保留犯规/抢断资格）。
pub const MARK_STOP_M: f64 = 5.0;

/// 逼近速度（m/s）：用于把距离换成时间代价。
pub const CLOSING_SPEED: f64 = 5.5;

fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = (a.0 - b.0) * PITCH_LENGTH_M;
    let dy = (a.1 - b.1) * PITCH_WIDTH_M;
    (dx * dx + dy * dy).sqrt()
}

/// 一对一的代价（秒）：`距离 / 逼近速度 + 换人惩罚`。
pub fn pair_cost(defender: (f64, f64), target: (f64, f64), same_as_prev: bool) -> f64 {
    let t = dist_m(defender, target) / CLOSING_SPEED;
    if same_as_prev {
        t
    } else {
        t + SWITCH_PENALTY_S
    }
}

/// 贪心最小代价匹配。
///
/// 输入等长的「防守者位置」与「进攻者位置」；`prev[i]` 是防守者 i 上一拍盯的进攻者下标。
/// 返回 `out[i] = Some(j)` 表示防守者 i 盯进攻者 j，`None` 表示未匹配（回落队形）。
///
/// 平局按 `(i, j)` 升序打破——**确定性**是硬要求（同 seed 同字节）。
pub fn assign(
    defenders: &[(f64, f64)],
    attackers: &[(f64, f64)],
    prev: &[Option<usize>],
) -> Vec<Option<usize>> {
    let n = defenders.len().min(attackers.len());
    let mut pairs: Vec<(f64, usize, usize)> = Vec::with_capacity(n * attackers.len());
    for i in 0..n {
        for j in 0..attackers.len() {
            let same = prev.get(i).copied().flatten() == Some(j);
            pairs.push((pair_cost(defenders[i], attackers[j], same), i, j));
        }
    }
    // 代价升序；完全相等时按 (i, j) 升序——保证与 HashMap 迭代序无关
    pairs.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    let mut out = vec![None; defenders.len()];
    let mut used_d = vec![false; defenders.len()];
    let mut used_a = vec![false; attackers.len()];
    let mut matched = 0;
    for (_, i, j) in pairs {
        if matched >= n {
            break;
        }
        if used_d[i] || used_a[j] {
            continue;
        }
        out[i] = Some(j);
        used_d[i] = true;
        used_a[j] = true;
        matched += 1;
    }
    out
}

/// 盯人站位：站在被盯人与本方球门之间，保持 `MARK_STOP_M`。
///
/// `own_goal_x`：本方球门 x（0.0 或 1.0）。
pub fn mark_point(target: (f64, f64), own_goal_x: f64) -> (f64, f64) {
    let dx = target.0 - own_goal_x;
    let dy = target.1 - 0.5;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return target;
    }
    let step = MARK_STOP_M / PITCH_LENGTH_M;
    let (ux, uy) = (dx / len, dy / len);
    ((target.0 - ux * step).clamp(0.03, 0.97), (target.1 - uy * step).clamp(0.06, 0.94))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> (f64, f64) {
        (x, y)
    }

    #[test]
    fn penalty_keeps_existing_mark_when_close_call() {
        // 两个防守者与两个进攻者：1 号防守者离 A 稍远但上一拍就盯 A
        let d = [p(0.30, 0.5), p(0.32, 0.5)];
        let a = [p(0.35, 0.5), p(0.36, 0.5)];
        let prev = [Some(0), Some(1)];
        let out = assign(&d, &a, &prev);
        assert_eq!(out[0], Some(0), "换人惩罚应让 0 号继续盯 A");
        assert_eq!(out[1], Some(1));
    }

    #[test]
    fn without_penalty_the_nearest_wins() {
        let d = [p(0.30, 0.5)];
        let a = [p(0.40, 0.5), p(0.31, 0.5)];
        let out = assign(&d, &a, &[None]);
        assert_eq!(out[0], Some(1), "最近的应当被选中");
    }

    #[test]
    fn each_attacker_is_marked_at_most_once() {
        let d = [p(0.30, 0.5), p(0.31, 0.5)];
        let a = [p(0.40, 0.5)];
        let out = assign(&d, &a, &[None, None]);
        let used: Vec<usize> = out.iter().flatten().cloned().collect();
        assert_eq!(used.len(), 1, "一个进攻者只能被一个人盯");
    }

    #[test]
    fn more_attackers_than_defenders_leaves_some_unmarked() {
        let d = [p(0.30, 0.5)];
        let a = [p(0.40, 0.5), p(0.41, 0.5), p(0.42, 0.5)];
        let out = assign(&d, &a, &[None]);
        assert_eq!(out.len(), 1);
        assert!(out[0].is_some());
    }

    #[test]
    fn deterministic_for_identical_inputs() {
        let d = [p(0.3, 0.4), p(0.3, 0.6), p(0.35, 0.5)];
        let a = [p(0.5, 0.4), p(0.5, 0.6), p(0.55, 0.5)];
        let prev = [None, None, None];
        let x = assign(&d, &a, &prev);
        let y = assign(&d, &a, &prev);
        assert_eq!(x, y);
    }

    #[test]
    fn mark_point_is_goal_side_of_target() {
        let t = p(0.6, 0.4);
        let m = mark_point(t, 0.0);
        assert!(m.0 < t.0, "主队防守者应站在被盯人身后（更靠自家球门）");
        let d = dist_m(m, t);
        assert!((d - MARK_STOP_M).abs() < 0.5, "停距应约等于 MARK_STOP_M，实际 {d}");
    }

    #[test]
    fn mark_stop_distance_keeps_shot_path_alive() {
        // 停距必须落在 (4m, 8m]：小于等于 4m 会让持球者恒判被逼抢
        assert!(MARK_STOP_M > 4.0 && MARK_STOP_M <= 8.0);
    }

    #[test]
    fn penalty_is_positive_and_finite() {
        assert!(SWITCH_PENALTY_S > 0.0 && SWITCH_PENALTY_S.is_finite());
    }
}
