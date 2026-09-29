//! P124 的**口径常量与观察入口**（种子区间、比赛时长、观察包装）。
//!
//! ## 为什么种子区间要单独成一个常量
//!
//! P16 的教训：`0.855`（30 seed）与 `0.862`（300 seed）**不是同一个数**，
//! 两组各自都对，差别是**口径**。把 300 seed 的数字抄进 30 seed 的断言会红。
//! ⇒ 本 change 把种子区间收敛成**唯一入口** [`GATE_SEEDS`]，
//! 任何打印数字的地方都须经 [`crate::probe::Pooled::caliber_line`] 带上它。

use fm_engine::observation::DiagnosticMatch;

/// 比赛时长（秒）——与 P16 的 `DUR` 一致（全场 90 分钟）。
pub const DUR: f64 = 5400.0;

/// **phaseability gate 的种子区间**（含两端）。P16 用的就是 30 seed。
///
/// ⚠️ 本区间是**口径**：`final_third` 的反证条期望值 `0.855` 只对它成立。
pub const GATE_SEEDS: (u64, u64) = (1, 30);

/// 与 P16 相同的比赛配置（`demo_mode: false` = 正式路径；观察层 opt-in）。
pub fn cfg() -> fm_engine::MatchConfig {
    fm_engine::MatchConfig {
        match_duration_seconds: DUR,
        demo_mode: false,
        model_version: fm_engine::MODEL_VERSION,
    }
}

/// 观察一场比赛并断言观察层自洽。
///
/// `is_coherent()` 失败时 panic——不自洽的观察层给出的任何数字都不可信。
pub fn observe(seed: u64) -> DiagnosticMatch {
    let dm = fm_engine::simulate_with_behavior_observations(seed, cfg());
    assert!(
        dm.is_coherent(),
        "seed {seed} 观察层不自洽：{:?}",
        dm.invariant_violations
    );
    dm
}

/// 池化 `GATE_SEEDS` 区间（Slice 1 的净化与反证条都走它）。
pub fn pool_gate_seeds() -> crate::probe::Pooled {
    crate::probe::pool_episodes(GATE_SEEDS, observe)
}
