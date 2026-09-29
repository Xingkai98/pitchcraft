//! P16 Slice 2：静态队形特征（**Rust 侧**，口径与 `viewer/match-metrics.js` 的 `teamShape` 对齐）。
//!
//! ## 为什么在 Rust 侧重写一份
//!
//! 用户已定（`OPEN-QUESTIONS.md` Q1）：位置导出走 **C（引擎导出）**。15B 的
//! `PhaseAnnotator` 在 **Rust** 侧，故特征也须在 Rust 侧可用——JS 的 `teamShape`
//! 结构上够不着它（`engine/src/` 里没有任何团队宽度/重心/spread 实现）。
//!
//! ## 口径（逐条对齐 `match-metrics.js` 头部注释，**改这里必须同步改那边**）
//!
//! | 量 | 口径 |
//! |---|---|
//! | 剔除门将 | id 0 / 21 不参与任何队形指标（不剔则纵深变成「门将到前锋」） |
//! | 瞬时队形 | **逐帧**算指标，再对帧取均值——**不是**把整场位置合并后取分位 |
//! | `depth` | **q10–q90 线性插值分位跨度**（R type-7 / NumPy 默认） |
//! | `width` | y 方向 max−min（报告项） |
//! | `cx`/`cy` | 非门将球员重心 |
//! | `spread` | 到重心的平均距离（紧凑度） |
//! | 米制换算 | 105×68（引擎侧恒此尺寸；真实侧逐场传入，见 `match-metrics.js`） |
//! | `n` | 该帧有效外场人数 |
//!
//! ## ⚠️ 两处**在引擎侧是空操作**（不得写成「引擎侧会掉帧」的理由）
//!
//! `match-metrics.js` 有两个真实侧（SkillCorner）专用的约束：
//!
//! - `includeExtrapolated`（默认 false，跳过外推点）；
//! - `MIN_OUTFIELD_PLAYERS = 7`（非门将不足 7 人则丢帧）。
//!
//! **引擎侧两者都是空操作**：引擎帧**不带外推标记**（没有「推断点」这回事），且
//! **每队恒 10 名外场**（22 人固定阵容，罚下者仍在 `pos` 里、只是不再产 mover）。
//! 故本模块：
//! - 不实现外推跳过（无此概念，实现了就是死代码）；
//! - `MIN_OUTFIELD_PLAYERS` **保留为可辩护的下限检查**（见 [`team_shape`]），
//!   但**它在引擎侧永不触发**——写成「会掉帧」会让读者以为引擎有数据缺口。

use fm_engine::observation::*;

/// 球场尺寸（米）。引擎侧恒定；与 `match-metrics.js` 的 `PITCH_LENGTH_M/WIDTH_M` 同值。
pub const PITCH_LENGTH_M: f64 = 105.0;
pub const PITCH_WIDTH_M: f64 = 68.0;

/// 非门将球员少于该数时该帧**丢弃**。
///
/// ⚠️ **引擎侧恒不触发**：每队恒 10 名外场。保留它是为与 `match-metrics.js` 的口径
/// **逐字对齐**（同一份判据、两个实现），不是因为有引擎帧会掉。
pub const MIN_OUTFIELD_PLAYERS: usize = 7;

pub const KEEPER_IDS: [usize; 2] = [0, 21];

/// 线性插值分位（R type-7 / NumPy 默认）。规则写死在 `match-metrics.js` 头部，此处逐字复刻：
/// `h = (n−1)·p`、`i = floor(h)`；`i+1 ≥ n` 时取 `s[n−1]`；`n == 1` 时取该点。
///
/// **必须传已排序数组**（调用方排一次、多个分位复用）。
pub fn quantile_sorted(sorted: &[f64], p: f64) -> Option<f64> {
    let n = sorted.len();
    if n == 0 {
        return None;
    }
    if n == 1 {
        return Some(sorted[0]);
    }
    let h = (n - 1) as f64 * p;
    let i = h.floor() as usize;
    if i + 1 >= n {
        return Some(sorted[n - 1]);
    }
    Some(sorted[i] + (h - i as f64) * (sorted[i + 1] - sorted[i]))
}

/// 纵深估计量：q10–q90 跨度（米）。输入须**已排序**。
pub fn quantile_span(sorted: &[f64]) -> Option<f64> {
    if sorted.len() < 2 {
        return None;
    }
    Some(quantile_sorted(sorted, 0.9)? - quantile_sorted(sorted, 0.1)?)
}

/// 单帧、单队的队形指标（瞬时）。与 `match-metrics.js` 的 `teamShape` 同口径。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TeamShape {
    /// q10–q90 纵深（米）。
    pub depth: f64,
    /// y 方向跨度（米）。
    pub width: f64,
    /// 非门将球员重心 x（米）。
    pub cx: f64,
    /// 非门将球员重心 y（米）。
    pub cy: f64,
    /// 到重心的平均距离（米）——紧凑度。
    pub spread: f64,
    /// 有效外场人数（引擎侧恒 10）。
    pub n: usize,
}

/// 从一帧位置快照算某队的队形指标。非门将不足 [`MIN_OUTFIELD_PLAYERS`] 时返回 `None`
/// （**引擎侧永不发生**，保留为口径对齐 + 防御）。
///
/// 方向：`progress` 归一（见 [`crate::caliber::progress`]）**不在此处做**——
/// 本函数与 `match-metrics.js` 一样输出**原始 x/y 的米制量**，方向归一是消费方的事。
pub fn team_shape(snap: &StateSnapshot, team: TeamId) -> Option<TeamShape> {
    let is_home = team == TeamId::Home;
    let mut xs: Vec<f64> = Vec::with_capacity(10);
    let mut ys: Vec<f64> = Vec::with_capacity(10);
    for (id, (x, y)) in snap.pos.iter().enumerate() {
        if KEEPER_IDS.contains(&id) {
            continue;
        }
        let in_team = if is_home { id <= 10 } else { id >= 11 };
        if !in_team {
            continue;
        }
        xs.push(x * PITCH_LENGTH_M);
        ys.push(y * PITCH_WIDTH_M);
    }
    if xs.len() < MIN_OUTFIELD_PLAYERS {
        return None;
    }
    let n = xs.len();
    let mut sorted = xs.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let depth = quantile_span(&sorted)?;
    let cx = xs.iter().sum::<f64>() / n as f64;
    let cy = ys.iter().sum::<f64>() / n as f64;
    // ⚠️ spread 用**未排序**的 (x,y) 配对：历史教训——曾把排序后的 x 与未排序的 y
    // 按下标配对，差 0.1–0.2 m，属口径错误。
    let spread = xs
        .iter()
        .zip(ys.iter())
        .map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
        .sum::<f64>()
        / n as f64;
    let width = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
        - ys.iter().cloned().fold(f64::INFINITY, f64::min);
    Some(TeamShape {
        depth,
        width,
        cx,
        cy,
        spread,
        n,
    })
}

/// 逐帧队形指标的**覆盖率**（P16 要求「报告可算帧占比与 `unknown` 占比」）。
#[derive(Debug, Clone, Default)]
pub struct ShapeCoverage {
    pub frames: usize,
    /// `team_shape` 返回 `Some` 的帧数（= 可算帧）。
    pub computable: usize,
    /// 缺失原因分类（引擎侧只应出现 `<none>`——见 `MIN_OUTFIELD_PLAYERS` 的说明）。
    pub missing_reasons: std::collections::BTreeMap<&'static str, usize>,
    /// **该帧是否属于某个 episode**（用位置口径的 `[start_t, end_t]` 窗判定）。
    /// 供「episode 内 vs 全局」两种口径分别报告。
    pub in_episode: std::collections::BTreeMap<&'static str, usize>,
    pub depth_sum: f64,
    pub width_sum: f64,
}

impl ShapeCoverage {
    /// 观测一帧。`in_ep` 由调用方按 **episode 的时间窗**（`PossessionEpisode::start_t/end_t`）
    /// 判定后传入——本模块**不另造窗**（口径仍以观测层对象为准）。
    pub fn observe_frame(&mut self, snap: &StateSnapshot, team: TeamId, in_ep: bool) {
        self.frames += 1;
        *self
            .in_episode
            .entry(if in_ep { "in_episode" } else { "outside" })
            .or_insert(0) += 1;
        match team_shape(snap, team) {
            Some(s) => {
                self.computable += 1;
                self.depth_sum += s.depth;
                self.width_sum += s.width;
            }
            None => {
                *self.missing_reasons.entry("outfield_below_min").or_insert(0) += 1;
            }
        }
    }

    /// 可算帧占比（0 分母时 `None`——不用 0.0 伪造观测）。
    pub fn computable_share(&self) -> Option<f64> {
        if self.frames == 0 {
            return None;
        }
        Some(self.computable as f64 / self.frames as f64)
    }
}

/// 一场比赛的队形汇总（**逐场先算**，供跨场聚合——不池化原始帧）。
#[derive(Debug, Clone, Default)]
pub struct MatchShape {
    pub home: ShapeCoverage,
    pub away: ShapeCoverage,
}

impl MatchShape {
    /// 对一场比赛的全部位置快照算队形覆盖。
    ///
    /// `in_ep` = 该帧是否落在**任一** episode 的时间窗内（用观测层的
    /// [`PossessionEpisode::start_t`] / `end_t`，不另造窗）。不变量「每个时刻最多一个
    /// 开放 episode」保证窗不重叠，故「任一」即「唯一」。
    ///
    /// ⚠️ 与 `team_shape` 的 `depth`/`width` 一样，这**不算方向归一**——
    /// `cx`/`cy`/`depth` 都是原始坐标的米制量，方向归一由消费方（phaseability gate）做。
    pub fn observe_match(dm: &DiagnosticMatch) -> Self {
        let mut out = MatchShape::default();
        for snap in &dm.state_snapshots {
            let t = snap.t.value;
            let in_ep = dm.possession_episodes.iter().any(|ep| {
                t + 1e-9 >= ep.start_t.value
                    && ep.end_t.map(|e| t <= e.value + 1e-9).unwrap_or(false)
            });
            out.home.observe_frame(snap, TeamId::Home, in_ep);
            out.away.observe_frame(snap, TeamId::Away, in_ep);
        }
        out
    }
}
