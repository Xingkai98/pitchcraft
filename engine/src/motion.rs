//! C1 运动学：把「每拍直接改坐标」换成「有速度、有加速度、有转弯半径」的积分。
//!
//! ## 为什么
//!
//! 旧模型（`move_toward`）每拍最多走 `speed × TICK_SECONDS` 米，**方向可瞬时反转**：
//! 120 秒轨迹是原地锯齿，而不是弧线。真人不是这样动的——
//!
//! - 加速上限随速度衰减：`a(v) = A0 (1 − v/S0)`，A0 ≈ 7.2 m/s²、S0 ≈ 9.5 m/s
//!   （职业球员加速–速度剖面，见 `research/2026-10-17-2d-football-sota/report.md` §7.5.7）
//! - 转向受侧向加速度限制：`ω ≤ A_LAT / v`（A_LAT ≈ 6.5 m/s²）
//!
//! ## 单位
//!
//! 引擎位置是**归一化** `[0,1]`，而速度/加速度是**米制**。本模块内部一律用米，
//! 只在边界换算（`PITCH_LENGTH_M = 105`、`PITCH_WIDTH_M = 68`）——不同轴用不同因子，
//! 这一点很容易错：若直接写 `pos += vel·dt`（归一化），y 方向会永远封顶在 `v·68/105`。
//!
//! ## 确定性
//!
//! 纯函数、零 RNG、零全局状态。同样的输入必得同样的输出。
//!
//! ## 开关
//!
//! 由 `MatchConfig.realism.motion` 控制，**默认关闭**——旧路径与既有 golden/直播测试保持原样，
//! 新路径由本模块的单元测试与开启开关后的集成测试覆盖。

use crate::{PITCH_LENGTH_M, PITCH_WIDTH_M};

/// 静止时的最大加速度（m/s²）。职业球员实测 A0 = 6.39–7.81。
pub const A0: f64 = 7.2;
/// 加速上限衰减到的特征速度（m/s）。实测 S0 = 9.21–9.77。
pub const S0: f64 = 9.5;
/// 侧向加速度上限（m/s²），决定转弯半径 `R = v² / A_LAT`。
pub const A_LAT: f64 = 6.5;
/// 速度硬上限（m/s）。实测顶级球员极速 9.53 ± 0.39。
pub const MAX_SPEED: f64 = 9.5;
/// 接近目标时开始减速的距离（米）。取 3 m：与「停球距离」同量级，
/// 再大就变成「还没到就刹住」，再小会过冲后在目标附近来回抖。
pub const DECEL_DIST_M: f64 = 3.0;

/// 当前速度下允许的加速度（m/s²）。速度越高，剩余加速空间越小。
///
/// `v >= S0` 时返回 0（已到特征速度，不再加速）；负速度按绝对值处理（本引擎不含倒退）。
pub fn accel_limit(v: f64) -> f64 {
    let s = v.abs();
    if s >= S0 {
        return 0.0;
    }
    A0 * (1.0 - s / S0)
}

/// 朝目标前进的期望速度（m/s）：接近目标时线性降低，避免过冲。
///
/// `dist_m <= 0` 返回 0。
pub fn desired_speed(dist_m: f64) -> f64 {
    if dist_m <= 0.0 {
        return 0.0;
    }
    MAX_SPEED * (dist_m / DECEL_DIST_M).min(1.0)
}

/// 把向量 `(x, y)` 的长度截到 `max`。零向量原样返回。
fn clamp_len(x: f64, y: f64, max: f64) -> (f64, f64) {
    let len = (x * x + y * y).sqrt();
    if len <= max || len < 1e-12 {
        return (x, y);
    }
    (x / len * max, y / len * max)
}

/// 两向量夹角（弧度，0..=π）。任一为零向量时返回 0。
fn angle_between(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let la = (ax * ax + ay * ay).sqrt();
    let lb = (bx * bx + by * by).sqrt();
    if la < 1e-12 || lb < 1e-12 {
        return 0.0;
    }
    let cos = ((ax * bx + ay * by) / (la * lb)).clamp(-1.0, 1.0);
    cos.acos()
}

/// 把 `new` 相对 `old` 的转角限制在 `max_turn` 内（弧度）；不超限则原样返回。
///
/// 用于实现 `ω ≤ A_LAT / v`：即将速度向量旋转到「绕行」而不是「折返」。
fn limit_turn(old: (f64, f64), new: (f64, f64), max_turn: f64) -> (f64, f64) {
    let lo = (old.0 * old.0 + old.1 * old.1).sqrt();
    if lo < 1e-12 {
        return new; // 静止时不限制初始朝向
    }
    let ln = (new.0 * new.0 + new.1 * new.1).sqrt();
    if ln < 1e-12 {
        return new;
    }
    let ang = angle_between(old.0, old.1, new.0, new.1);
    if ang <= max_turn || ang < 1e-9 {
        return new;
    }
    // 在 old 的朝向基础上，朝 new 的方向旋转恰好 max_turn，保持 new 的长度。
    let cross = old.0 * new.1 - old.1 * new.0;
    let sign = if cross >= 0.0 { 1.0 } else { -1.0 };
    let base = old.1.atan2(old.0);
    let a = base + sign * max_turn;
    (ln * a.cos(), ln * a.sin())
}

/// 单步积分：给定归一化位置、米制速度、归一化目标，推进 `dt` 秒。
///
/// 返回 `(新归一化位置, 新米制速度)`。
///
/// `speed_cap`：本球员的巡航速度上限（m/s，旧模型的 `speed` 字段），保证不会比旧模型更快。
pub fn step(
    pos: (f64, f64),
    vel: (f64, f64),
    target: (f64, f64),
    speed_cap: f64,
    dt: f64,
) -> ((f64, f64), (f64, f64)) {
    // 归一化 → 米
    let dx_m = (target.0 - pos.0) * PITCH_LENGTH_M;
    let dy_m = (target.1 - pos.1) * PITCH_WIDTH_M;
    let dist_m = (dx_m * dx_m + dy_m * dy_m).sqrt();

    let want = desired_speed(dist_m).min(speed_cap);
    let (ux, uy) = if dist_m > 1e-9 {
        (dx_m / dist_m, dy_m / dist_m)
    } else {
        (0.0, 0.0)
    };
    let want_v = (ux * want, uy * want);

    // 加速度限制（按当前速度）
    let v_now = (vel.0 * vel.0 + vel.1 * vel.1).sqrt();
    let dvx = want_v.0 - vel.0;
    let dvy = want_v.1 - vel.1;
    let (ndvx, ndvy) = clamp_len(dvx, dvy, accel_limit(v_now) * dt);
    let mut next = (vel.0 + ndvx, vel.1 + ndvy);

    // 转向限制：速度越快，允许的角速度越小
    let v_after = (next.0 * next.0 + next.1 * next.1).sqrt();
    let omega_max = if v_after < 1.0 { A_LAT } else { A_LAT / v_after };
    next = limit_turn(vel, next, omega_max * dt);

    // 速度硬上限
    next = clamp_len(next.0, next.1, MAX_SPEED.min(speed_cap.max(0.1)));

    // 米 → 归一化位移（注意两轴因子不同）
    let np = (
        pos.0 + next.0 * dt / PITCH_LENGTH_M,
        pos.1 + next.1 * dt / PITCH_WIDTH_M,
    );
    (np, next)
}

/// 拍内分 `substeps` 次积分（每个子步 `dt_total / substeps`），返回终位置与终速度。
///
/// 为什么要子步：`dt = 1s` 时单步积分会**过冲**——6.5 m/s 一步就走 6.5 m，而减速距离只有
/// 3 m，球员会在目标两侧来回跳。子步让「减速曲线」在拍内真正生效（这也是设计里
/// 「仿真 10 Hz / 决策 1 Hz」的落地方式）。
///
/// `substeps == 0` 按 1 处理。
pub fn step_n(
    pos: (f64, f64),
    vel: (f64, f64),
    target: (f64, f64),
    speed_cap: f64,
    dt_total: f64,
    substeps: u32,
) -> ((f64, f64), (f64, f64)) {
    let n = substeps.max(1);
    let dt = dt_total / n as f64;
    let mut p = pos;
    let mut v = vel;
    for _ in 0..n {
        let (np, nv) = step(p, v, target, speed_cap, dt);
        p = np;
        v = nv;
    }
    (p, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn accel_decreases_with_speed_and_zero_at_s0() {
        assert!(close(accel_limit(0.0), A0, 1e-12));
        assert!(accel_limit(2.0) < accel_limit(0.0));
        assert!(accel_limit(5.0) > 0.0);
        assert!(close(accel_limit(S0), 0.0, 1e-12));
        assert!(close(accel_limit(S0 + 1.0), 0.0, 1e-12));
    }

    #[test]
    fn desired_speed_slows_near_target_and_caps() {
        assert!(close(desired_speed(0.0), 0.0, 1e-12));
        assert!(close(desired_speed(DECEL_DIST_M / 2.0), MAX_SPEED / 2.0, 1e-9));
        assert!(close(desired_speed(100.0), MAX_SPEED, 1e-12));
    }

    #[test]
    fn stationary_player_cannot_jump_instantly_to_top_speed() {
        // 静止 → 目标在正前方 50 m：一拍（1s）后的速度必须 < MAX_SPEED
        let (_, v) = step((0.5, 0.5), (0.0, 0.0), (0.9, 0.5), 9.5, 1.0);
        let s = (v.0 * v.0 + v.1 * v.1).sqrt();
        assert!(s > 0.0, "应当开始移动");
        assert!(s < MAX_SPEED, "一拍内不能到顶速，实际 {s}");
        // 且不超过 A0×1s 太多（转向限制不放大加速度）
        assert!(s <= A0 + 1e-9, "首拍速度不应超过 A0·dt，实际 {s}");
    }

    #[test]
    fn movement_never_exceeds_speed_cap() {
        let cap = 4.0;
        let (_, v) = step((0.5, 0.5), (cap, 0.0), (0.9, 0.5), cap, 1.0);
        let s = (v.0 * v.0 + v.1 * v.1).sqrt();
        assert!(s <= cap + 1e-9, "不应超过 speed_cap，实际 {s}");
    }

    #[test]
    fn reversal_is_a_turn_not_a_teleport() {
        // 以 8 m/s 向 +x 跑，目标在正后方：速度不应瞬间反向
        let (_, v) = step((0.5, 0.5), (8.0, 0.0), (0.1, 0.5), 9.5, 0.1);
        assert!(v.0 > 0.0, "0.1s 内不应把 vx 变成负的，实际 {}", v.0);
        // 转角受 A_LAT/v 限制：0.1s 至多 6.5/8*0.1 rad
        let ang = angle_between(8.0, 0.0, v.0, v.1);
        let max_turn = A_LAT / 8.0 * 0.1;
        assert!(ang <= max_turn + 1e-6, "转角 {ang} 超过上限 {max_turn}");
    }

    #[test]
    fn axis_scaling_is_not_isotropic_in_normalized_space() {
        // 同样 10 m 的 x/y 位移，在归一化坐标里步长不同（105 vs 68）
        // 用 8 m/s（低于 MAX_SPEED，不会被硬上限截断）
        let (px, _) = step((0.0, 0.5), (8.0, 0.0), (1.0, 0.5), 8.0, 1.0);
        let (py, _) = step((0.5, 0.0), (0.0, 8.0), (0.5, 1.0), 8.0, 1.0);
        let dx = px.0;
        let dy = py.1;
        assert!((dx - dy).abs() > 1e-6, "两轴必须用不同换算因子（dx={dx}, dy={dy}）");
        assert!(close(dx * PITCH_LENGTH_M, 8.0, 1e-6), "x 轴 8 m/s × 1s 应走 8 m");
        assert!(close(dy * PITCH_WIDTH_M, 8.0, 1e-6), "y 轴 8 m/s × 1s 应走 8 m");
    }

    #[test]
    fn substeps_prevent_overshoot() {
        // 6.5 m/s 冲向 5 m 外的目标：单步会冲过头，10 子步应当停在目标附近
        let start = (0.5, 0.5);
        let target = (0.5 + 5.0 / PITCH_LENGTH_M, 0.5);
        let (p1, _) = step(start, (6.5, 0.0), target, 6.5, 1.0);
        let (p10, _) = step_n(start, (6.5, 0.0), target, 6.5, 1.0, 10);
        let d1 = (p1.0 - target.0).abs() * PITCH_LENGTH_M;
        let d10 = (p10.0 - target.0).abs() * PITCH_LENGTH_M;
        assert!(d10 < d1, "子步应当更接近目标（单步 {d1:.2} m，10 子步 {d10:.2} m）");
    }

    #[test]
    fn deterministic() {
        let a = step((0.3, 0.4), (3.0, 1.0), (0.8, 0.6), 7.0, 0.2);
        let b = step((0.3, 0.4), (3.0, 1.0), (0.8, 0.6), 7.0, 0.2);
        assert_eq!(a, b);
    }

    #[test]
    fn at_target_speed_decays_to_zero() {
        let mut vel = (0.0, 5.0);
        let pos = (0.5, 0.5);
        for _ in 0..20 {
            let (_, v) = step(pos, vel, pos, 9.5, 0.1);
            vel = v;
        }
        let s = (vel.0 * vel.0 + vel.1 * vel.1).sqrt();
        assert!(s < 0.5, "到点后应减速到接近 0，实际 {s}");
    }
}
