//! P16 Slice 3：**带时间关系的空间特征**（本 change 的实际工作量）。
//!
//! ## 为什么静态快照不够（design §3.2）
//!
//! 三档 phase 判不了「区域 = 阶段」：`build_up ≠ 后场`、`progression ≠ 球向前移动`、
//! `final_third ≠ 前 1/3`。故须产出**带时间关系**的量。
//!
//! ## 四条特征（每条给定义 + 覆盖率 + 缺失处理）
//!
//! | 特征 | 定义 | 缺失处理 |
//! |---|---|---|
//! | 球门向净推进 | 窗口内末位置 − 首位置（方向归一） | 终点口径不可得 → `None` |
//! | 推进/回撤/横向转移 | 逐拍位移分解为纵向(进攻向)与横向，分别累计正负 | 无相邻帧 → 该步不计 |
//! | 线间距变化 | 窗口内 `depth` 的斜率（米/秒） | 任一端不可算 → `None` |
//! | 接应是否形成 | 持球者前进方向上是否有队友落在「可接应」锥内 | 无球位 → `None` |
//!
//! ## ⚠️ 三条纪律
//!
//! 1. **不得用区域/坐标冒充战术阶段**：本模块产出的是**特征**（几何量），
//!    **不是** `Phase`。裁决三档能否判定是 Slice 4 的事；本模块不命名任何 phase。
//! 2. **时间基准不混用**（design §2.3）：本模块**只用一种**时间来源——
//!    [`StateSnapshot::t`]，其 basis 恒 `TimeBasis::StateCommit`。窗口边界也用它。
//!    （episode 的 `start_t`/`end_t` 也是 `state_commit`，故与快照同 basis，可同窗比较；
//!    见 `caliber.rs` 的 `EpisodeCaliber::start_basis` 守卫。）
//! 3. **缺失不猜**：任何一步不可得就记 `None` / 计入缺失分类，不用 0.0 或前值顶替。

use crate::caliber::{attack_dir, progress};
use crate::shape::{team_shape, TeamShape};
use fm_engine::observation::*;
use std::collections::BTreeMap;

// ============================== 窗口 ==============================

/// 动作窗口长度（秒）。**这是本模块唯一需要定的窗口参数**。
///
/// 取 **5.0 s** 的理由：侦察实测 action gap 中位 ≈ 8 s、episode 内球位移动的
/// 可分辨尺度按拍计——窗口短于 3 s 会让大多数窗口只含 1–2 拍（噪声主导），
/// 长于 10 s 会把多个动作合并成一个（分辨率丢失）。5 s = 5 拍，是「够多数拍」
/// 与「仍对应一个战术动作」的折中。**这是可调参数，不是判据**——
/// 改动它必须重跑覆盖率，并记录在本模块的产物 provenance 里。
pub const WINDOW_SECONDS: f64 = 5.0;

/// 一个时间窗（闭开区间 `[start, end)`，与切窗口径一致）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub start: f64,
    pub end: f64,
}

impl Window {
    pub fn len(&self) -> f64 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// 按 [`WINDOW_SECONDS`] 切窗（**不重叠**，与 `match-metrics.js` 的 300s/900s 步长口径
/// 不同——那是标尺的抽样窗，这里是特征的动作窗）。
///
/// `span` = 该 episode 的时间窗（`[start_t, end_t)`）。`end_t` 不可得（开放 episode）时
/// 用 `None`，此时窗只切到最后一个快照时刻。
pub fn windows_over(span: (f64, Option<f64>), last_snapshot_t: f64) -> Vec<Window> {
    let end = span.1.unwrap_or(last_snapshot_t);
    if end <= span.0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut s = span.0;
    while s + WINDOW_SECONDS <= end + 1e-9 {
        out.push(Window {
            start: s,
            end: s + WINDOW_SECONDS,
        });
        s += WINDOW_SECONDS;
    }
    out
}

// ============================== 特征 1：球门向净推进 ==============================

/// 球门向净推进（方向归一）。**直接复用位置口径**（`EpisodeCaliber::net_progress`）——
/// 不另算一遍，避免两处口径分叉。
///
/// 这是四条里**唯一**直接吃位置口径的（起止位置已由 `caliber.rs` 定死）。
pub fn goalward_net_progress(c: &crate::caliber::EpisodeCaliber) -> Option<f64> {
    c.net_progress()
}

// ============================== 特征 2：推进 / 回撤 / 横向转移 ==============================

/// 窗口内的**球位**位移分解（方向归一）。
///
/// - `forward_m`：**进攻方向**上的正位移累计（米）；
/// - `backward_m`：进攻方向上的负位移累计（米，正值 = 回撤量）；
/// - `lateral_m`：**垂直于进攻方向**的位移累计（米，正值，无符号）。
///
/// 参考点 = **球位**（[`StateSnapshot::ball`]）——design §3.2 明写这三者是「球」的
/// 分量（「连续动作窗口内三者的分量；纵向与横向分开」）。
///
/// ⚠️ **球可能是「松散球」的投影位置**：`MatchState.ball_pos` 在死球/重开准备期
/// 是**约定点**（中圈 / 发球点），不是球的真实物理位置。这些拍的位移会表现为
/// 「球瞬移」。**下游按 end_reason / 重开窗过滤**（本模块如实记录，不悄悄剔除）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplacementDecomposition {
    pub forward_m: f64,
    pub backward_m: f64,
    pub lateral_m: f64,
    /// 参与分解的相邻帧对数（每对贡献一次位移）。
    pub steps: usize,
}

/// 逐拍分解**球位**的位移（方向归一）。
///
/// `frames`：按时间升序的 `(t, ball)`。必须**单调时间、无缺帧**
/// （调用方用 [`collect_ball_track`] 保证）。
pub fn decompose_displacement(
    frames: &[(f64, (f64, f64))],
    team: TeamId,
) -> Option<DisplacementDecomposition> {
    if frames.len() < 2 {
        return None;
    }
    let dir = attack_dir(team);
    let mut forward = 0.0;
    let mut backward = 0.0;
    let mut lateral = 0.0;
    let mut steps = 0usize;
    for w in frames.windows(2) {
        let (t0, a) = w[0];
        let (t1, b) = w[1];
        if t1 - t0 <= 0.0 {
            continue;
        }
        let dx_m = (b.0 - a.0) * crate::shape::PITCH_LENGTH_M;
        let dy_m = (b.1 - a.1) * crate::shape::PITCH_WIDTH_M;
        let along = dir * dx_m; // 进攻方向分量
        if along >= 0.0 {
            forward += along;
        } else {
            backward += -along;
        }
        lateral += dy_m.abs();
        steps += 1;
    }
    if steps == 0 {
        return None;
    }
    Some(DisplacementDecomposition {
        forward_m: forward,
        backward_m: backward,
        lateral_m: lateral,
        steps,
    })
}

/// 从快照序列收集**球位轨迹**（时间升序；缺失的拍直接跳过——不作插值）。
pub fn collect_ball_track(frames: &[(f64, StateSnapshot)]) -> Vec<(f64, (f64, f64))> {
    frames.iter().map(|(t, s)| (*t, s.ball)).collect()
}

// ============================== 特征 3：线间距变化 ==============================

/// 窗口内 `depth`（q10–q90 纵深）的变化率（米/秒）。
///
/// **线性回归斜率**（最小二乘），不是「末减首」——后者对端点单帧抖动极敏感
/// （纵深逐帧噪声不小）。斜率用窗口内**全部**可算帧，缺失帧直接排除（不插值）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineSpacingChange {
    /// `depth` 的斜率（米/秒）。正 = 队形被拉长，负 = 收紧。
    pub depth_slope_m_per_s: f64,
    /// `spread` 的斜率（米/秒）。
    pub spread_slope_m_per_s: f64,
    /// 参与回归的帧数（**≥2** 才有斜率）。
    pub frames: usize,
}

/// 对一串 `(t, TeamShape)` 做最小二乘斜率。
fn slope(points: &[(f64, f64)]) -> Option<f64> {
    let n = points.len();
    if n < 2 {
        return None;
    }
    let nf = n as f64;
    let mt = points.iter().map(|p| p.0).sum::<f64>() / nf;
    let my = points.iter().map(|p| p.1).sum::<f64>() / nf;
    let mut num = 0.0;
    let mut den = 0.0;
    for (t, y) in points {
        num += (t - mt) * (y - my);
        den += (t - mt) * (t - mt);
    }
    if den.abs() < 1e-12 {
        // 时间全相同 ⇒ 斜率无定义（不猜 0.0）。
        return None;
    }
    Some(num / den)
}

/// 窗口内线间距变化（纵深 + spread 两条斜率）。
pub fn line_spacing_change(frames: &[(f64, TeamShape)]) -> Option<LineSpacingChange> {
    if frames.len() < 2 {
        return None;
    }
    let depth_pts: Vec<(f64, f64)> = frames.iter().map(|(t, s)| (*t, s.depth)).collect();
    let spread_pts: Vec<(f64, f64)> = frames.iter().map(|(t, s)| (*t, s.spread)).collect();
    Some(LineSpacingChange {
        depth_slope_m_per_s: slope(&depth_pts)?,
        spread_slope_m_per_s: slope(&spread_pts)?,
        frames: frames.len(),
    })
}

// ============================== 特征 4：接应是否形成 ==============================

/// 接应（support）判据的参数。**阈值是定义的一部分**，改动须重跑覆盖率。
///
/// - `MAX_DIST_M`：接应者到球门向参考点的最大距离（米）；
/// - `MIN_FORWARD_M`：接应者必须比参考点更靠前至少这么多米（否则是「回接」不是「前插接应」）。
pub const SUPPORT_MAX_DIST_M: f64 = 25.0;
pub const SUPPORT_MIN_FORWARD_M: f64 = 2.0;

/// 一帧的接应判定结果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SupportFormation {
    /// 落在接应锥内的队友数。
    pub supporters: usize,
    /// 其中最近者的距离（米）；无接应者时为 `None`。
    pub nearest_support_m: Option<f64>,
    /// 球的推进度（方向归一）——**仅供报告分桶，不是阶段**。
    pub ball_progress: f64,
}

/// 判断某队在这一帧是否形成接应。
///
/// **定义**（design §3.2 逐字：「推进后**球前方**是否出现可接应队友」）：
/// 以**球位**为参考点，凡满足
/// 「距球 ≤ [`SUPPORT_MAX_DIST_M`]」且「在进攻方向上比球靠前 ≥ [`SUPPORT_MIN_FORWARD_M`]」
/// 的**非门将队友**，计为一个接应者。距离按米制（球场 105×68 各向异性）。
///
/// 方向归一：以**该队**的进攻方向为准（主队 +x、客队 −x），故两侧可比。
pub fn support_formation(snap: &StateSnapshot, team: TeamId) -> Option<SupportFormation> {
    // 先确认这帧的该队队形可算（沿用同一份踢门将口径；`None` 时不猜）。
    team_shape(snap, team)?;
    let dir = attack_dir(team);
    let bx = snap.ball.0 * crate::shape::PITCH_LENGTH_M;
    let by = snap.ball.1 * crate::shape::PITCH_WIDTH_M;
    let ball_progress = progress(snap.ball.0, team);
    let mut supporters = 0usize;
    let mut nearest: Option<f64> = None;
    for (id, (x, y)) in snap.pos.iter().enumerate() {
        if crate::shape::KEEPER_IDS.contains(&id) {
            continue;
        }
        let in_team = if team == TeamId::Home { id <= 10 } else { id >= 11 };
        if !in_team {
            continue;
        }
        let x_m = x * crate::shape::PITCH_LENGTH_M;
        let y_m = y * crate::shape::PITCH_WIDTH_M;
        let dist = ((x_m - bx).powi(2) + (y_m - by).powi(2)).sqrt();
        if dist > SUPPORT_MAX_DIST_M {
            continue;
        }
        // 只取**球前方**（进攻方向）的队友——后方的队友是「保护/回接」，不是接应前插。
        let along = dir * (x_m - bx);
        if along < SUPPORT_MIN_FORWARD_M {
            continue;
        }
        supporters += 1;
        nearest = Some(match nearest {
            Some(n) => n.min(dist),
            None => dist,
        });
    }
    Some(SupportFormation {
        supporters,
        nearest_support_m: nearest,
        ball_progress,
    })
}

// ============================== 逐窗口汇总 + 覆盖率 ==============================

/// 一个窗口的全部特征（缺的记 `None`，不猜）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowFeatures {
    pub window: Window,
    pub net_progress: Option<f64>,
    pub displacement: Option<DisplacementDecomposition>,
    pub line_spacing: Option<LineSpacingChange>,
    /// 该窗口内形成接应的帧数 / 有快照的帧数。
    pub support_frames: usize,
    pub snap_frames: usize,
}

/// 特征覆盖率（P16 要求「每条给覆盖率 + 缺失原因分类」）。
#[derive(Debug, Clone, Default)]
pub struct FeatureCoverage {
    pub windows: usize,
    pub win_net_progress: usize,
    pub win_displacement: usize,
    pub win_line_spacing: usize,
    pub win_support: usize,
    /// 缺失原因分类（**闭集式枚举**：每个特征缺时只可能落进这几类）。
    pub missing: BTreeMap<&'static str, usize>,
}

impl FeatureCoverage {
    pub fn observe_window(&mut self, f: &WindowFeatures) {
        self.windows += 1;
        if f.net_progress.is_some() {
            self.win_net_progress += 1;
        } else {
            *self.missing.entry("net_progress:终点口径不可得").or_insert(0) += 1;
        }
        if f.displacement.is_some() {
            self.win_displacement += 1;
        } else {
            *self.missing.entry("displacement:窗口内有效帧<2").or_insert(0) += 1;
        }
        if f.line_spacing.is_some() {
            self.win_line_spacing += 1;
        } else {
            *self.missing.entry("line_spacing:窗口内可算帧<2").or_insert(0) += 1;
        }
        if f.support_frames > 0 {
            self.win_support += 1;
        } else {
            *self.missing.entry("support:无快照帧").or_insert(0) += 1;
        }
    }

    pub fn share(&self, k: usize) -> Option<f64> {
        if self.windows == 0 {
            return None;
        }
        Some(k as f64 / self.windows as f64)
    }
}

/// 已知缺口（**记录在案，不冒充**）。每条都给「影响哪条特征」与「要补什么」。
pub const FEATURE_LIMITATIONS: &[(&str, &str)] = &[
    (
        "ball_pos_is_a_convention_during_dead_ball",
        "`MatchState.ball_pos` 在死球/重开准备期是**约定点**（中圈 / 发球点），不是球的\
         物理位置 ⇒ 跨越这些拍的位移会含「球瞬移」。下游按 end_reason / 重开窗过滤。",
    ),
    (
        "support_is_a_geometric_proxy",
        "接应判据只用了几何（距离 + 进攻方向前方），**不含**「该队友是否真的可接\
         （无人拦截、传球线路通畅）」——后者需要防守者位置与线路判定，本 change 不做。\
         故它是**证据**（`SupportFormation`），不是「战术意图」的判定。",
    ),
    (
        "window_length_is_a_parameter",
        "`WINDOW_SECONDS = 5.0` 是可调参数，不是判据；改动须重跑覆盖率并记 provenance。",
    ),
];

/// 从一串按时间升序的 `(t, snap)` 收集某队**连续可算**的 `TeamShape`（缺帧断开）。
pub fn collect_shapes(frames: &[(f64, StateSnapshot)], team: TeamId) -> Vec<(f64, TeamShape)> {
    let mut out = Vec::new();
    for (t, snap) in frames {
        if let Some(s) = team_shape(snap, team) {
            out.push((*t, s));
        }
    }
    out
}
