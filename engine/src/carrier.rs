//! C5 持球者选项评估：用**确定性前向模型**给「传球 / 带球 / 射门」打分。
//!
//! ## 为什么
//!
//! 旧引擎的出球目标是「最近的队友」（`nearest_teammate`），动作选择靠 hazard 掷骰。
//! 这两者都不看**这一脚传出去会发生什么**——不看接球者是否被盯、不看推进了多少、
//! 不看传球线路上的拦截风险。
//!
//! Agent2D 的做法是深度 4 的链搜索（500 节点上限）。本模块先在**深度 1** 上把
//! 「前向模型 + 评分」这层建立起来：评估每个候选动作的**期望收益**，选最大的。
//!
//! 链搜索本身（多步展开、剪枝）留给后续 change——但「用模型选，不掷骰」这条主路径在这里落地。
//!
//! ## 评分
//!
//! ```text
//! score(pass → t) = 0.55 × 推进(米) + 0.45 × 安全(0..1) + 0.20 × 接球者空间(0..1)
//! score(dribble)  = 0.55 × 推进(米) + 0.45 × 安全(0..1)
//! ```
//!
//! - 推进：传球落点相对持球者、沿进攻方向的前进量
//! - 安全：`1 / (1 + 最近对手到线路的距离 / 6m)` —— 越远越安全
//! - 接球者空间：接球者到最近对手的距离 / 10m，封顶 1
//!
//! 全部是米制、纯函数、零 RNG。
//!
//! ## 开关
//!
//! `MatchConfig.realism.carrier`，默认关闭。

use crate::{PITCH_LENGTH_M, PITCH_WIDTH_M};

/// 推进权重。
pub const W_PROGRESS: f64 = 0.55;
/// 安全权重。
pub const W_SAFETY: f64 = 0.45;
/// 接球者空间权重。
pub const W_SPACE: f64 = 0.20;
/// 线路安全距离尺度（米）。
pub const SAFE_SCALE_M: f64 = 6.0;
/// 接球者空间尺度（米）。
pub const SPACE_SCALE_M: f64 = 10.0;
/// 传球距离惩罚（每米扣多少分）。实测 0.06 会把整体相似度从 0.143 推到 0.198
/// （模型退化为「只传脚下」），故默认 0；保留开关供后续调。
pub const W_DIST: f64 = 0.0;

fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = (a.0 - b.0) * PITCH_LENGTH_M;
    let dy = (a.1 - b.1) * PITCH_WIDTH_M;
    (dx * dx + dy * dy).sqrt()
}

/// 点 `p` 到线段 `a→b` 的最短距离（米）。
pub fn point_seg_dist_m(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let ax = (b.0 - a.0) * PITCH_LENGTH_M;
    let ay = (b.1 - a.1) * PITCH_WIDTH_M;
    let px = (p.0 - a.0) * PITCH_LENGTH_M;
    let py = (p.1 - a.1) * PITCH_WIDTH_M;
    let len2 = ax * ax + ay * ay;
    let t = if len2 < 1e-12 { 0.0 } else { ((px * ax + py * ay) / len2).clamp(0.0, 1.0) };
    let cx = ax * t;
    let cy = ay * t;
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// 传球安全度（0..1）：线路上最近对手越远越安全。
pub fn pass_safety(from: (f64, f64), to: (f64, f64), opponents: &[(f64, f64)]) -> f64 {
    let d = opponents
        .iter()
        .map(|&o| point_seg_dist_m(o, from, to))
        .fold(f64::INFINITY, f64::min);
    if !d.is_finite() {
        return 1.0;
    }
    d / (d + SAFE_SCALE_M) // 0 = 线路上（危险），→1 = 远（安全）
}

/// 接球者空间（0..1）：到最近对手的距离 / 10m。
pub fn receiver_space(to: (f64, f64), opponents: &[(f64, f64)]) -> f64 {
    let d = opponents
        .iter()
        .map(|&o| dist_m(o, to))
        .fold(f64::INFINITY, f64::min);
    if !d.is_finite() {
        return 1.0;
    }
    (d / SPACE_SCALE_M).clamp(0.0, 1.0)
}

/// 推进量（米，沿进攻方向）。`dir = +1`（主队向右）或 `-1`。
pub fn progress_m(from: (f64, f64), to: (f64, f64), dir: f64) -> f64 {
    (to.0 - from.0) * PITCH_LENGTH_M * dir
}

/// 一次传球的评分。推进为负也不截断——向后传球仍然可能因为安全而更优。
pub fn score_pass(
    from: (f64, f64),
    to: (f64, f64),
    dir: f64,
    opponents: &[(f64, f64)],
) -> f64 {
    W_PROGRESS * progress_m(from, to, dir)
        + W_SAFETY * pass_safety(from, to, opponents)
        + W_SPACE * receiver_space(to, opponents)
        - W_DIST * dist_m(from, to)
}

/// 带球的评分：推进按 `DRIBBLE_STEP_M` 估，安全看最近对手。
pub fn score_dribble(from: (f64, f64), dir: f64, opponents: &[(f64, f64)], step_m: f64) -> f64 {
    let to = (from.0 + dir * step_m / PITCH_LENGTH_M, from.1);
    let nearest = opponents
        .iter()
        .map(|&o| dist_m(o, from))
        .fold(f64::INFINITY, f64::min);
    let safety = if nearest.is_finite() { nearest / (nearest + SAFE_SCALE_M) } else { 1.0 };
    W_PROGRESS * step_m + W_SAFETY * safety
}

/// 在候选里选评分最高的传球目标。返回 `(下标, 分数)`；候选为空返回 `None`。
///
/// 平局按下标升序——确定性。
pub fn best_pass(
    from: (f64, f64),
    mates: &[(f64, f64)],
    opponents: &[(f64, f64)],
    dir: f64,
) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (i, &m) in mates.iter().enumerate() {
        let s = score_pass(from, m, dir, opponents);
        if best.map(|(_, bs)| s > bs + 1e-12).unwrap_or(true) {
            best = Some((i, s));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> (f64, f64) {
        (x, y)
    }

    #[test]
    fn point_seg_distance_matches_geometry() {
        // 垂足在线段内
        assert!((point_seg_dist_m(p(0.5, 0.6), p(0.5, 0.5), p(0.6, 0.5)) - 6.8).abs() < 0.1);
        // 垂足在线段外 → 取端点
        let d = point_seg_dist_m(p(0.7, 0.5), p(0.5, 0.5), p(0.6, 0.5));
        assert!((d - 10.5).abs() < 0.1, "d={d}");
    }

    #[test]
    fn safety_is_lower_when_opponent_sits_on_the_line() {
        let from = p(0.5, 0.5);
        let to = p(0.7, 0.5);
        let clear = [p(0.6, 0.9)];
        let blocked = [p(0.6, 0.5)];
        assert!(pass_safety(from, to, &clear) > pass_safety(from, to, &blocked));
    }

    #[test]
    fn receiver_space_grows_with_distance() {
        let near = receiver_space(p(0.5, 0.5), &[p(0.52, 0.5)]);
        let far = receiver_space(p(0.5, 0.5), &[p(0.9, 0.5)]);
        assert!(near < far);
        assert!(far <= 1.0);
    }

    #[test]
    fn progressive_pass_beats_backward_pass_when_equally_safe() {
        let from = p(0.5, 0.5);
        let opps = [p(0.5, 0.95)];
        let fwd = score_pass(from, p(0.65, 0.5), 1.0, &opps);
        let back = score_pass(from, p(0.35, 0.5), 1.0, &opps);
        assert!(fwd > back, "向前传球应更高分（{fwd} vs {back}）");
    }

    #[test]
    fn open_pass_beats_blocked_pass_when_equally_progressive() {
        let from = p(0.5, 0.5);
        let to = p(0.62, 0.5);
        let open = score_pass(from, to, 1.0, &[p(0.6, 0.95)]);
        let blocked = score_pass(from, to, 1.0, &[p(0.6, 0.52)]);
        assert!(open > blocked, "线路被堵应当更低分（{open} vs {blocked}）");
    }

    #[test]
    fn best_pass_is_deterministic_on_ties() {
        let from = p(0.5, 0.5);
        let mates = [p(0.6, 0.5), p(0.6, 0.5)];
        let opps = [p(0.5, 0.9)];
        assert_eq!(best_pass(from, &mates, &opps, 1.0), best_pass(from, &mates, &opps, 1.0));
        assert_eq!(best_pass(from, &mates, &opps, 1.0).unwrap().0, 0, "平局取小下标");
    }

    #[test]
    fn empty_candidates_return_none() {
        assert!(best_pass(p(0.5, 0.5), &[], &[p(0.6, 0.5)], 1.0).is_none());
    }

    #[test]
    fn dribble_score_grows_with_space() {
        let from = p(0.5, 0.5);
        let tight = score_dribble(from, 1.0, &[p(0.51, 0.5)], 4.0);
        let loose = score_dribble(from, 1.0, &[p(0.9, 0.9)], 4.0);
        assert!(loose > tight);
    }
}
