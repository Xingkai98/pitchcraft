//! C4 压迫场：用「到达时间」算控制，替换 `OPEN_PRESS_N = 1` 的单人逼抢。
//!
//! ## 为什么
//!
//! 旧引擎开放局只指派**离球最近的 1 个人**去逼抢（`OPEN_PRESS_N = 1`，且只在球进入本方半场时生效）。
//! 结果是防守方对球没有形状：压迫点固定、没人封传球线，`lat`（横向位移占比）只有 0.27，
//! 真实是 0.43。
//!
//! ## 机制
//!
//! 1. 在球周围 `RADIUS_M` 米内撒一个粗网格（`GRID = 5`，即 5×5 个候选点）
//! 2. 每个候选点算「我方最快到达时间」与「对方最快到达时间」
//! 3. **控制值** `C(p) = τ_opp(p) − τ_our(p)`：越大说明我方越先到
//! 4. 选 `C(p)` 最大且**离球不太远**的点作为压迫点（离球权重防止追到底线角落）
//! 5. 由离球最近、且未被盯人任务占用的防守者去这个点
//!
//! 到达时间用**米制**直线距离 / 5.5 m/s。没有速度状态时这是可接受的一阶近似；
//! C1 之后 `MatchState.vel` 有速度，但本模块刻意不读它——保持纯函数、可测。
//!
//! ## 开关
//!
//! `MatchConfig.realism.press`，默认关闭。

use crate::{PITCH_LENGTH_M, PITCH_WIDTH_M};

/// 候选网格边长（每边 5 个点）。
pub const GRID: usize = 5;
/// 候选区域半径（米）。
pub const RADIUS_M: f64 = 9.0;
/// 到达速度（m/s）。
pub const ARRIVAL_SPEED: f64 = 5.5;
/// 离球距离的惩罚系数（每米扣多少秒的控制优势）。
pub const DIST_PENALTY_S_PER_M: f64 = 0.02;

fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = (a.0 - b.0) * PITCH_LENGTH_M;
    let dy = (a.1 - b.1) * PITCH_WIDTH_M;
    (dx * dx + dy * dy).sqrt()
}

/// 到达时间（秒）。
pub fn arrival(from: (f64, f64), to: (f64, f64)) -> f64 {
    dist_m(from, to) / ARRIVAL_SPEED
}

/// 某点的控制值：`τ_opp − τ_our`（正 = 我方先到）。
///
/// 任一方为空时返回 0（无人可争）。
pub fn control_at(p: (f64, f64), ours: &[(f64, f64)], theirs: &[(f64, f64)]) -> f64 {
    if ours.is_empty() || theirs.is_empty() {
        return 0.0;
    }
    let t_our = ours.iter().map(|&q| arrival(q, p)).fold(f64::INFINITY, f64::min);
    let t_opp = theirs.iter().map(|&q| arrival(q, p)).fold(f64::INFINITY, f64::min);
    t_opp - t_our
}

/// 压迫点：球周围网格里「控制值 − 距离惩罚」最大的点。
///
/// 平局按 `(行, 列)` 升序——确定性。
pub fn press_point(ball: (f64, f64), ours: &[(f64, f64)], theirs: &[(f64, f64)]) -> (f64, f64) {
    let span = RADIUS_M / PITCH_LENGTH_M;
    let span_y = RADIUS_M / PITCH_WIDTH_M;
    let mut best = ball;
    let mut best_score = f64::NEG_INFINITY;
    for i in 0..GRID {
        for j in 0..GRID {
            let fx = i as f64 / (GRID - 1) as f64 - 0.5;
            let fy = j as f64 / (GRID - 1) as f64 - 0.5;
            let p = (
                (ball.0 + fx * 2.0 * span).clamp(0.03, 0.97),
                (ball.1 + fy * 2.0 * span_y).clamp(0.06, 0.94),
            );
            let score = control_at(p, ours, theirs) - dist_m(p, ball) * DIST_PENALTY_S_PER_M;
            if score > best_score + 1e-12 {
                best_score = score;
                best = p;
            }
        }
    }
    best
}

/// 防守方整条线的「球侧压缩」量（归一化 y 位移）。
///
/// 控制越弱的一侧越向球收——制造真实的横向移动，而不是全队平移。
/// `control` ∈ [−1, 1]：负 = 对方更容易先到（该侧危险）。
pub fn compress_dy(y: f64, ball_y: f64, control: f64) -> f64 {
    let k = 0.18 * (1.0 - control.clamp(-1.0, 1.0)) * 0.5; // 0..0.18
    (ball_y - y) * k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrival_is_metric_distance_over_speed() {
        let a = (0.0, 0.5);
        let b = (0.1, 0.5); // 10.5 m
        let t = arrival(a, b);
        assert!((t - 10.5 / ARRIVAL_SPEED).abs() < 1e-9, "t={t}");
    }

    #[test]
    fn control_is_positive_when_we_are_closer() {
        let p = (0.5, 0.5);
        let ours = [(0.52, 0.5)];
        let theirs = [(0.70, 0.5)];
        assert!(control_at(p, &ours, &theirs) > 0.0);
    }

    #[test]
    fn control_is_negative_when_they_are_closer() {
        let p = (0.5, 0.5);
        let ours = [(0.70, 0.5)];
        let theirs = [(0.52, 0.5)];
        assert!(control_at(p, &ours, &theirs) < 0.0);
    }

    #[test]
    fn control_is_zero_without_both_sides() {
        assert_eq!(control_at((0.5, 0.5), &[], &[(0.6, 0.5)]), 0.0);
        assert_eq!(control_at((0.5, 0.5), &[(0.4, 0.5)], &[]), 0.0);
    }

    #[test]
    fn press_point_prefers_where_we_arrive_first() {
        // 我方全部在球左侧，对方在右侧：压迫点应偏向左侧
        let ball = (0.5, 0.5);
        let ours = [(0.42, 0.5), (0.40, 0.4)];
        let theirs = [(0.60, 0.5), (0.62, 0.6)];
        let p = press_point(ball, &ours, &theirs);
        assert!(p.0 <= ball.0 + 1e-9, "压迫点应偏向我方一侧，实际 x={}", p.0);
    }

    #[test]
    fn press_point_is_deterministic() {
        let ball = (0.5, 0.5);
        let ours = [(0.45, 0.45), (0.44, 0.55)];
        let theirs = [(0.55, 0.45), (0.56, 0.55)];
        assert_eq!(press_point(ball, &ours, &theirs), press_point(ball, &ours, &theirs));
    }

    #[test]
    fn press_point_stays_inside_pitch() {
        for ball in [(0.02, 0.02), (0.98, 0.98), (0.5, 0.5)] {
            let p = press_point(ball, &[(0.5, 0.5)], &[(0.5, 0.5)]);
            assert!((0.03..=0.97).contains(&p.0));
            assert!((0.06..=0.94).contains(&p.1));
        }
    }

    #[test]
    fn compression_pulls_toward_ball_on_weak_side() {
        // 控制为负（危险侧）时，应向球 y 靠拢
        let dy = compress_dy(0.2, 0.6, -1.0);
        assert!(dy > 0.0, "应向球侧（+y）移动，实际 {dy}");
        // 控制为正（安全侧）时，几乎不动
        let dy2 = compress_dy(0.2, 0.6, 1.0);
        assert!(dy2.abs() < 1e-9);
    }
}
