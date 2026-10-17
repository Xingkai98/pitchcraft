//! C2 队形：站位表 + 按球位插值（替换逐点解析公式）。
//!
//! ## 为什么
//!
//! 旧 `formation_target` 是 16 个常量的线性混合，结果是**全队纵向被拉长**
//! （`hd` 38.7m vs 真实 25.9m）、**紧凑度不足**（20.7 vs 15.2）、**重心间距过大**
//! （18.9 vs 8.3）。根因不是某个常量，是「每条线各自追球」——防线、前卫线、前锋线
//! 各自按球位平移，三条线之间的距离不受约束，纵深就散了。
//!
//! ## 机制
//!
//! 用**关键帧**（球在若干纵向位置时，整队 11 人的站位）描述队形，运行时按球位插值：
//!
//! - 每个关键帧给三条线的 x（`def_x / mid_x / fwd_x`）+ 块内横向半宽 `half_w` + 跟球横移 `shift_k`
//! - 球员的 y 由**角色槽位**决定（4-4-2 的固定槽位），只随球做整体横移
//! - 线间距由关键帧直接控制 ⇒ 纵深是可设计量，不再由常量混出来
//!
//! 插值在关键帧之间线性；球在关键帧范围外取端点（不外推，避免边线附近发散）。
//!
//! ## 开关
//!
//! `MatchConfig.realism.formation`，默认关闭。

/// 一个关键帧：球在该纵向位置时，**两条线相对球的偏移**与块宽（归一化，球队自己的进攻方向）。
///
/// 用「相对球」而不是「绝对位置」：两支球队都以球为锚，队形才会围绕球压缩，
/// 而不是各自待在半场（后者会把 `mix` 打到 0、`gap` 打到 30m+）。
#[derive(Clone, Copy, Debug)]
pub struct Keyframe {
    pub ball_x: f64,
    /// 进攻方：后卫线/前卫线/前锋线相对球的 x 偏移（负 = 在球后面）
    pub atk_def: f64,
    pub atk_mid: f64,
    pub atk_fwd: f64,
    /// 防守方：后卫线/前卫线/前锋线相对球的 x 偏移
    pub def_def: f64,
    pub def_mid: f64,
    pub def_fwd: f64,
    /// 块内横向半宽
    pub half_w: f64,
    /// 跟球横移系数
    pub shift_k: f64,
}

/// 关键帧表：球越靠近对方球门，进攻方压得越靠上、防守方收得越紧。
pub const KEYFRAMES: [Keyframe; 5] = [
    // 球在己方禁区附近
    Keyframe { ball_x: 0.12, atk_def: -0.14, atk_mid: -0.05, atk_fwd: 0.06, def_def: -0.09, def_mid: 0.02, def_fwd: 0.10, half_w: 0.20, shift_k: 0.32 },
    // 己方半场
    Keyframe { ball_x: 0.32, atk_def: -0.16, atk_mid: -0.06, atk_fwd: 0.07, def_def: -0.10, def_mid: 0.02, def_fwd: 0.11, half_w: 0.21, shift_k: 0.36 },
    // 中圈
    Keyframe { ball_x: 0.50, atk_def: -0.17, atk_mid: -0.07, atk_fwd: 0.07, def_def: -0.11, def_mid: 0.02, def_fwd: 0.12, half_w: 0.22, shift_k: 0.40 },
    // 对方半场
    Keyframe { ball_x: 0.68, atk_def: -0.18, atk_mid: -0.08, atk_fwd: 0.08, def_def: -0.12, def_mid: 0.02, def_fwd: 0.13, half_w: 0.21, shift_k: 0.36 },
    // 对方禁区附近
    Keyframe { ball_x: 0.88, atk_def: -0.20, atk_mid: -0.09, atk_fwd: 0.09, def_def: -0.13, def_mid: 0.02, def_fwd: 0.14, half_w: 0.19, shift_k: 0.30 },
];

/// 按球 x 线性插值关键帧（范围外取端点）。
pub fn interpolate(ball_x: f64) -> Keyframe {
    let x = ball_x.clamp(KEYFRAMES[0].ball_x, KEYFRAMES[KEYFRAMES.len() - 1].ball_x);
    for w in KEYFRAMES.windows(2) {
        let (a, b) = (w[0], w[1]);
        if x <= b.ball_x {
            let span = (b.ball_x - a.ball_x).max(1e-9);
            let t = ((x - a.ball_x) / span).clamp(0.0, 1.0);
            let l = |p: f64, q: f64| p + (q - p) * t;
            return Keyframe {
                ball_x: x,
                atk_def: l(a.atk_def, b.atk_def),
                atk_mid: l(a.atk_mid, b.atk_mid),
                atk_fwd: l(a.atk_fwd, b.atk_fwd),
                def_def: l(a.def_def, b.def_def),
                def_mid: l(a.def_mid, b.def_mid),
                def_fwd: l(a.def_fwd, b.def_fwd),
                half_w: l(a.half_w, b.half_w),
                shift_k: l(a.shift_k, b.shift_k),
            };
        }
    }
    KEYFRAMES[KEYFRAMES.len() - 1]
}

/// 4-4-2 槽位表：`(线, 槽位序号, 槽内归一化偏移 −1..1)`。`None` = 门将。
pub fn slot_of(id: i32) -> Option<(usize, usize, f64)> {
    // 主队：0 门将 / 1-4 后卫 / 5-8 前卫 / 9-10 前锋
    // 客队：21 门将 / 11-14 后卫 / 15-18 前卫 / 19-20 前锋
    const BACK4: [f64; 4] = [-0.85, -0.30, 0.30, 0.85];
    const MID4: [f64; 4] = [-0.95, -0.32, 0.32, 0.95];
    const FWD2: [f64; 2] = [-0.35, 0.35];
    match id {
        0 | 21 => None,
        1..=4 => Some((0, (id - 1) as usize, BACK4[(id - 1) as usize])),
        5..=8 => Some((1, (id - 5) as usize, MID4[(id - 5) as usize])),
        9..=10 => Some((2, (id - 9) as usize, FWD2[(id - 9) as usize])),
        11..=14 => Some((0, (id - 11) as usize, BACK4[(id - 11) as usize])),
        15..=18 => Some((1, (id - 15) as usize, MID4[(id - 15) as usize])),
        19..=20 => Some((2, (id - 19) as usize, FWD2[(id - 19) as usize])),
        _ => None,
    }
}

/// 计算某球员的站位目标（最终归一化坐标，主客队都已处理）。
///
/// `my_attack`：该球员所在队当前是否控球。
pub fn target(id: i32, ball: (f64, f64), is_home: bool, my_attack: bool, phase_s: f64) -> (f64, f64) {
    // 转到「该队自己的进攻方向」坐标：自家球门在 0，对方球门在 1
    let bx = if is_home { ball.0 } else { 1.0 - ball.0 };
    let by = if is_home { ball.1 } else { 1.0 - ball.1 };
    let kf = interpolate(bx);
    let (line, _slot, lateral) = match slot_of(id) {
        Some(s) => s,
        None => {
            let y = (0.5 + (by - 0.5) * 0.25).clamp(0.35, 0.65);
            let x = (bx * 0.12).clamp(0.03, 0.14); // 门将：小禁区附近，随球略微出击
            return if is_home { (x, y) } else { (1.0 - x, 1.0 - y) };
        }
    };
    let off = if my_attack {
        [kf.atk_def, kf.atk_mid, kf.atk_fwd][line]
    } else {
        [kf.def_def, kf.def_mid, kf.def_fwd][line]
    };
    let x = (bx + off).clamp(0.03, 0.97);
    let width_scale = match line {
        0 => 1.0,
        1 => 0.95,
        _ => 0.55,
    };
    // 进攻时拉开、防守时收窄——制造真实的横向位移（`lat`）
    let phase_w = if my_attack { 1.15 } else { 0.82 };
    // 个体横向微调：球员在块内持续调整站位（盯人/补位/接应），不是站死。
    // 周期 ~120s、幅度 ±6.3m，确定性（相位由 id 决定），零 RNG。
    let wiggle = 0.11 * (6.28318 * phase_s / 120.0 + id as f64 * 1.7).sin();
    let y = (0.5 + lateral * kf.half_w * width_scale * phase_w
        + (by - 0.5) * kf.shift_k
        + wiggle)
        .clamp(0.06, 0.94);
    if is_home { (x, y) } else { (1.0 - x, 1.0 - y) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframes_are_monotonic_in_ball_x() {
        for w in KEYFRAMES.windows(2) {
            assert!(w[1].ball_x > w[0].ball_x);
        }
    }

    #[test]
    fn line_order_is_preserved() {
        // 进攻方：后卫在球后、前卫次之、前锋在球前
        for kf in KEYFRAMES {
            assert!(kf.atk_def < kf.atk_mid, "进攻方后卫线必须在前卫线之后");
            assert!(kf.atk_mid < kf.atk_fwd, "进攻方前卫线必须在锋线之后");
            assert!(kf.atk_def < 0.0 && kf.atk_fwd > 0.0, "进攻方锋线应在球前");
        }
        // 防守方：同样保持线序，但整体更压缩
        for kf in KEYFRAMES {
            assert!(kf.def_def < kf.def_mid && kf.def_mid < kf.def_fwd);
            let atk_span = kf.atk_fwd - kf.atk_def;
            let def_span = kf.def_fwd - kf.def_def;
            assert!(def_span < atk_span, "防守方队形应比进攻方更压缩");
        }
    }

    #[test]
    fn interpolation_hits_keyframes_exactly() {
        for kf in KEYFRAMES {
            let got = interpolate(kf.ball_x);
            assert!((got.atk_def - kf.atk_def).abs() < 1e-9);
            assert!((got.atk_fwd - kf.atk_fwd).abs() < 1e-9);
        }
    }

    #[test]
    fn interpolation_is_between_neighbours() {
        let mid = (KEYFRAMES[0].ball_x + KEYFRAMES[1].ball_x) / 2.0;
        let got = interpolate(mid);
        assert!(got.atk_fwd > KEYFRAMES[0].atk_fwd && got.atk_fwd < KEYFRAMES[1].atk_fwd);
    }

    #[test]
    fn clamps_outside_range() {
        let lo = interpolate(0.0);
        let hi = interpolate(1.0);
        assert!((lo.atk_def - KEYFRAMES[0].atk_def).abs() < 1e-9, "低于范围取首帧，不外推");
        assert!((hi.atk_def - KEYFRAMES[KEYFRAMES.len() - 1].atk_def).abs() < 1e-9, "超出范围取末帧");
    }

    #[test]
    fn all_eleven_outfield_players_have_slots() {
        for id in 1..=10 {
            assert!(slot_of(id).is_some(), "主队 {id} 应有槽位");
        }
        for id in 12..=20 {
            assert!(slot_of(id).is_some(), "客队 {id} 应有槽位");
        }
        assert!(slot_of(0).is_none(), "主队门将无槽位");
        assert!(slot_of(21).is_none(), "客队门将无槽位");
    }

    #[test]
    fn slots_are_unique_within_a_line() {
        let mut seen = std::collections::HashSet::new();
        for id in 1..=10 {
            if let Some((line, slot, _)) = slot_of(id) {
                assert!(seen.insert((line, slot)), "id {id} 与同线球员撞槽");
            }
        }
    }

    #[test]
    fn team_vertical_extent_is_realistic() {
        // 球在中圈时，11 人的纵向跨度应在 20–30m（真实 26m 上下）
        let ball = (0.5, 0.5);
        let xs: Vec<f64> = (1..=10).map(|id| target(id, ball, true, true, 0.0).0).collect();
        let lo = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let hi = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let hd_m = (hi - lo) * 105.0;
        assert!((20.0..=30.0).contains(&hd_m), "纵深 {hd_m:.1}m 不在 20–30m");
    }

    #[test]
    fn lateral_shift_follows_ball() {
        let left = target(2, (0.5, 0.1), true, true, 0.0).1;
        let right = target(2, (0.5, 0.9), true, true, 0.0).1;
        assert!(right > left, "球在右侧时右边后卫应更靠右");
    }

    #[test]
    fn targets_stay_inside_pitch() {
        for id in 1..=10 {
            for bx in [0.0, 0.3, 0.5, 0.7, 1.0] {
                for by in [0.0, 0.5, 1.0] {
                    let (x, y) = target(id, (bx, by), true, true, 0.0);
                    assert!((0.03..=0.97).contains(&x), "x={x}");
                    assert!((0.06..=0.94).contains(&y), "y={y}");
                }
            }
        }
    }
}
