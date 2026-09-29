//! P124 Slice 4：**重跑 phaseability gate**（本 change 的验收）。
//!
//! ## 与 P16 的关系
//!
//! P16 的结论：`final_third` **可判**（`forward_m/s` AUC 0.855 / 30 seed）、
//! `build_up` / `progression` **判不了**（0.461）。本模块用**同一套**参考集、
//! **同一个** AUC 实现、**同一个**池化空间，加上本 change 的意图特征重跑，
//! 并把两侧**并列成表**——否则「改善来自意图」与「改善来自重跑」分不开。
//!
//! ## 循环性防护（本模块的第二条纪律，与参考集纪律同等）
//!
//! ⚠️ 参考集**不得由位置构造**（P16 已守）。**意图特征另有一条循环风险**：
//! 某条意图量若**在机制上**由「这个 episode 有没有射门」决定，而参考集谓词恰好就是
//! `ends_shot`，那它「能分开 final_third」是**同义反复**，不是判别力。
//!
//! 本 change 实测到一例：`def_none`（防守方「无动作」比例）对 final_third 的 AUC 高达
//! **0.934**——但机制是：起脚窗口内 `committed` 的 tick，防守侧被守卫强制选 `None`
//! （`evaluate_defensive_action` 的不可回溯分支）。实测 seed 1/2/3 上
//! **射门 tick 上的防守意图 21/21、21/21、14/14 全是 `none`**。
//! ⇒ `def_none` 与 `ends_shot` **机制同源**，其 AUC 是**循环的**，
//! 须标注为 `[循环·仅对照]`，**不得**作为「意图能判 final_third」的证据。
//! 由 `def_none_signal_is_mechanically_tied_to_shots` 钉住这条机制。
//!
//! `build_up` vs `progression` 那一对**不受此循环影响**（两档 motif 都含 `!has_shot`），
//! 故它是本 change 检验意图信号的**干净战场**。

use crate::gate::auc;
use crate::intent::EpisodeIntent;
use crate::probe::{set_where, Pooled, RateAuc};
use crate::purify::{motif_pred, ARM_CURRENT, ARM_DROP_PASSCOUNT, ARM_DROP_RESTART};
use fm_engine::observation::DefensiveIntentKind;

/// 意图特征的**种类**——决定它在报告里怎么被引用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// P16 的空间量（对照列）。
    Spatial,
    /// 纯意图量：读引擎显式状态，与参考集谓词**不同源** ⇒ 可作判别力证据。
    Intent,
    /// **循环**：机制上与参考集谓词同源（见模块头）⇒ 只列表，不作证据。
    Circular,
}

/// 一条特征：名字 + 取值函数 + 它的种类。
pub struct FeatureSpec {
    pub name: &'static str,
    pub provenance: Provenance,
    /// 对「一个 episode 的意图特征」取值。`None` = 缺（不参与比较）。
    pub value: fn(&EpisodeIntent) -> Option<f64>,
}

/// 意图特征清单（**本 change 的全部意图量**）。
///
/// ⚠️ `def_none` 标 [`Provenance::Circular`]——它测的是「防守方无动作」，
/// 而起脚窗口内已提交射门的 tick 会被守卫强制选 `None`（见模块头）。
pub const INTENT_FEATURES: &[FeatureSpec] = &[
    FeatureSpec {
        name: "window_opened",
        provenance: Provenance::Intent,
        value: |e| Some(if e.window_opened { 1.0 } else { 0.0 }),
    },
    FeatureSpec {
        name: "window_share",
        provenance: Provenance::Intent,
        value: |e| e.window_share,
    },
    FeatureSpec {
        name: "setup_share",
        provenance: Provenance::Intent,
        value: |e| e.setup_share,
    },
    FeatureSpec {
        name: "first_window_frac",
        provenance: Provenance::Intent,
        value: |e| e.first_window_frac,
    },
    FeatureSpec {
        name: "max_window_ticks",
        provenance: Provenance::Intent,
        value: |e| e.max_window_ticks.map(|x| x as f64),
    },
    FeatureSpec {
        name: "pressure_share",
        provenance: Provenance::Intent,
        value: |e| e.pressure_share,
    },
    FeatureSpec {
        name: "pressure_mean",
        provenance: Provenance::Intent,
        value: |e| e.pressure_mean,
    },
    FeatureSpec {
        name: "def_per_s",
        provenance: Provenance::Intent,
        value: |e| e.def_per_s(),
    },
    FeatureSpec {
        name: "def_contain",
        provenance: Provenance::Intent,
        value: |e| e.def_share_of(DefensiveIntentKind::Contain),
    },
    FeatureSpec {
        name: "def_jockey",
        provenance: Provenance::Intent,
        value: |e| e.def_share_of(DefensiveIntentKind::Jockey),
    },
    FeatureSpec {
        name: "def_tackle",
        provenance: Provenance::Intent,
        value: |e| e.def_share_of(DefensiveIntentKind::Tackle),
    },
    FeatureSpec {
        name: "def_foul",
        provenance: Provenance::Intent,
        value: |e| e.def_share_of(DefensiveIntentKind::Foul),
    },
    FeatureSpec {
        name: "def_none[循环·仅对照]",
        provenance: Provenance::Circular,
        value: |e| e.def_share_of(DefensiveIntentKind::None),
    },
];

/// P16 的空间特征（**逐字复刻** `p16/gate.rs::separability` 的 `specs` 表，
/// 含 `[区域量·仅对照]` 标注）——用于并列对照。
pub const SPATIAL_FEATURES: &[(&str, fn(&crate::gate::EpisodeFeature) -> Option<f64>)] = &[
    ("net_progress[空间]", |e| e.net_progress),
    ("forward_m[空间]", |e| e.forward_m),
    ("backward_m[空间]", |e| e.backward_m),
    ("lateral_m[空间]", |e| e.lateral_m),
    ("depth_slope[空间]", |e| e.depth_slope),
    ("support_frames_share[空间]", |e| e.support_frames_share),
    ("forward_m/s[空间]", |e| Some(e.forward_m? / e.duration_s?)),
    ("start_progress[区域量·仅对照]", |e| Some(e.start_progress)),
];

/// 一行可分性结果（空间或意图特征对某一对参考集）。
#[derive(Debug, Clone)]
pub struct GateRow {
    pub feature: &'static str,
    pub provenance: Provenance,
    pub auc: Option<f64>,
    pub pos_n: usize,
    pub neg_n: usize,
    pub skipped: usize,
}

/// 「这一行算不算**证据**」的最小样本量（**每一侧**都要满足）。
///
/// ## 为什么必须有这条（本 change 实测的假发现）
///
/// 意图特征 `first_window_frac` 只在**开窗**的 episode 上可算。而 `build_up` / `progression`
/// 两档**本身定义就要求 `!has_shot`**，几乎从不开窗 ⇒ 该特征在这两档上只有
/// **pos=4 / neg=8** 个样本，算出 AUC = 0.281（`|Δ| = 0.219`）。
///
/// 若不加样本量门槛，那会被读成「意图特征分开了 build_up / progression」的**新发现**——
/// 而 12 个样本的 AUC 标准误差 ≈ `sqrt((n₁+n₂+1)/(12·n₁·n₂)) = 0.184`，
/// 0.219 连 1.2σ 都不到，**纯噪声**。
///
/// ⚠️ **这与 P16 的「小样本不可信」教训不同，别混**（P16 的 v2 恰恰错在这里）：
/// P16 的错是**用「小样本」解释一个 join bug 的症状**（30 seed 的 AUC 稳定在 0.6–0.86，
/// 根本没有「塌回 0.5」）。本条**不是**在解释异常，而是**在断言之前先问样本够不够**——
/// 结论是「这条特征在两档间**几乎没有样本**，故它**两种结论都得不出**」。
///
/// 取 `50`：n₁=n₂=50 时 AUC 的 2σ ≈ 0.116 < 0.15 的容差，「分不开」这个断言才立得住。
/// 样本不足的行**不被断言**，但**必须被打印**（见 `GateRow::is_adequately_sampled` 的用途）。
pub const MIN_SIDE_FOR_SEPARABILITY: usize = 50;

impl GateRow {
    /// 样本量是否足以支撑「分得开 / 分不开」的断言。
    pub fn is_adequately_sampled(&self) -> bool {
        self.pos_n >= MIN_SIDE_FOR_SEPARABILITY && self.neg_n >= MIN_SIDE_FOR_SEPARABILITY
    }

    /// 样本不足时的说明（报告里明写，**不是静默跳过**）。
    pub fn undersized_note(&self) -> Option<String> {
        if self.is_adequately_sampled() {
            return None;
        }
        Some(format!(
            "样本不足（pos={} neg={}，门槛每侧 ≥{MIN_SIDE_FOR_SEPARABILITY}）⇒ 本行**不作证据**",
            self.pos_n, self.neg_n
        ))
    }
}

/// 对某一对参考集，算**空间 + 意图全部特征**的可分性。
///
/// `sets_where` = 给定池化空间与档名，取出该档的全局下标集。
pub fn gate_rows(
    p: &Pooled,
    intents: &[EpisodeIntent],
    set_a: &[usize],
    set_b: &[usize],
    label: &str,
) -> Vec<GateRow> {
    let mut rows = Vec::new();
    for (name, f) in SPATIAL_FEATURES {
        let r = rate_auc_spatial(p, set_a, set_b, &format!("{label}:{name}"), *f);
        rows.push(GateRow {
            feature: name,
            provenance: Provenance::Spatial,
            auc: r.auc,
            pos_n: r.pos_n,
            neg_n: r.neg_n,
            skipped: r.skipped_in_set,
        });
    }
    for spec in INTENT_FEATURES {
        let r = rate_auc_intent(p, intents, set_a, set_b, &format!("{label}:{}", spec.name), spec.value);
        rows.push(GateRow {
            feature: spec.name,
            provenance: spec.provenance,
            auc: r.auc,
            pos_n: r.pos_n,
            neg_n: r.neg_n,
            skipped: r.skipped_in_set,
        });
    }
    rows
}

/// 空间特征的分组 AUC（用 P16 的 `EpisodeFeature`）。
///
/// ⚠️ 与 `probe::rate_auc` 同实现，但那条只吃 `EpisodeFeature` 的固定函数指针；
/// 这里要按 `SPATIAL_FEATURES` 表遍历，故另写一份**逐值判红**的等价实现。
/// 两者的**判别力**由 `spatial_rows_match_the_p16_separability` 守（同输入同输出）。
fn rate_auc_spatial(
    p: &Pooled,
    set_a: &[usize],
    set_b: &[usize],
    label: &str,
    f: fn(&crate::gate::EpisodeFeature) -> Option<f64>,
) -> RateAuc {
    let in_a: std::collections::BTreeSet<usize> = set_a.iter().copied().collect();
    let in_b: std::collections::BTreeSet<usize> = set_b.iter().copied().collect();
    let mut pos = Vec::new();
    let mut neg = Vec::new();
    let mut skipped = 0usize;
    for (i, ef) in &p.feats {
        let a = in_a.contains(i);
        let b = in_b.contains(i);
        if !a && !b {
            continue;
        }
        match f(ef).map(|v| crate::probe::require_finite(&format!("{label}@ep{i}"), v)) {
            Some(v) => {
                if a {
                    pos.push(v);
                }
                if b {
                    neg.push(v);
                }
            }
            None => skipped += 1,
        }
    }
    RateAuc {
        auc: auc(&pos, &neg),
        pos_n: pos.len(),
        neg_n: neg.len(),
        skipped_missing: skipped,
        skipped_in_set: skipped,
    }
}

/// 意图特征的 AUC（用 `intents[i]`，与 `p.feats[i]` **同一下标空间**）。
///
/// ⚠️ **下标空间**：`intents` 与 `p.feats` 必须同长同序（由 `pool_intents` 保证并断言）。
/// 这是 P16 join bug 的直接防线——两条平行数组一旦错位，**两侧各自看都自洽**。
fn rate_auc_intent(
    p: &Pooled,
    intents: &[EpisodeIntent],
    set_a: &[usize],
    set_b: &[usize],
    label: &str,
    f: fn(&EpisodeIntent) -> Option<f64>,
) -> RateAuc {
    assert_eq!(
        intents.len(),
        p.feats.len(),
        "意图特征数组与池化特征数组长度不等——下标空间已错位（P16 join bug 同型）"
    );
    let in_a: std::collections::BTreeSet<usize> = set_a.iter().copied().collect();
    let in_b: std::collections::BTreeSet<usize> = set_b.iter().copied().collect();
    let mut pos = Vec::new();
    let mut neg = Vec::new();
    let mut skipped = 0usize;
    for (i, ef) in &p.feats {
        let a = in_a.contains(i);
        let b = in_b.contains(i);
        if !a && !b {
            continue;
        }
        let _ = ef;
        match f(&intents[*i]).map(|v| crate::probe::require_finite(&format!("{label}@ep{i}"), v)) {
            Some(v) => {
                if a {
                    pos.push(v);
                }
                if b {
                    neg.push(v);
                }
            }
            None => skipped += 1,
        }
    }
    RateAuc {
        auc: auc(&pos, &neg),
        pos_n: pos.len(),
        neg_n: neg.len(),
        skipped_missing: skipped,
        skipped_in_set: skipped,
    }
}

/// 一个档的 AUC 行（报告用）。
pub struct ZoneReport {
    pub label: &'static str,
    pub rows: Vec<GateRow>,
}

/// 报告的一行（供产物序列化）。
pub struct VerdictTable {
    pub final_vs_rest: Vec<GateRow>,
    pub build_vs_prog: Vec<GateRow>,
}

impl VerdictTable {
    /// 本 change 对 `build_up` vs `progression` 的**最强意图特征**（`def_none[循环]` 除外）。
    pub fn best_intent_for_build_vs_prog(&self) -> Option<&GateRow> {
        self.build_vs_prog
            .iter()
            .filter(|r| r.provenance == Provenance::Intent)
            .filter(|r| r.auc.is_some())
            .max_by(|a, b| {
                let da = (a.auc.unwrap() - 0.5).abs();
                let db = (b.auc.unwrap() - 0.5).abs();
                da.partial_cmp(&db).unwrap()
            })
    }

    /// P16 的 `forward_m/s` 在 `build_up` vs `progression` 上的 AUC（基线，必须复现 0.461）。
    pub fn p16_baseline_build_vs_prog(&self) -> Option<f64> {
        self.build_vs_prog
            .iter()
            .find(|r| r.feature == "forward_m/s[空间]")
            .and_then(|r| r.auc)
    }
}

/// 净化臂在**意图特征**上的 AUC（build_up vs progression）——「接入新信号后必须再净化一次」。
///
/// 返回 `(臂, 每特征 GateRow)`——**带每行的 pos_n / neg_n / skipped**，因为
/// 「这条特征在这两档间有没有足够样本」**不是按臂判断的**（臂的集合规模够大，
/// 但某条特征可能只在极少数 episode 上可算：实测 `first_window_frac` 在两档间
/// 只有 pos=4 / neg=8）。故样本量门槛必须**逐行**判（[`GateRow::is_adequately_sampled`]）。
pub fn purification_over_intent(
    p: &Pooled,
    intents: &[EpisodeIntent],
) -> Vec<(&'static str, Vec<GateRow>)> {
    [ARM_CURRENT, ARM_DROP_RESTART, ARM_DROP_PASSCOUNT]
        .iter()
        .map(|arm| {
            let a = set_where(p, arm.build_up);
            let b = set_where(p, arm.progression);
            let rows = INTENT_FEATURES
                .iter()
                .map(|spec| {
                    let r = rate_auc_intent(p, intents, &a, &b, &format!("{}:{}", arm.name, spec.name), spec.value);
                    GateRow {
                        feature: spec.name,
                        provenance: spec.provenance,
                        auc: r.auc,
                        pos_n: r.pos_n,
                        neg_n: r.neg_n,
                        skipped: r.skipped_in_set,
                    }
                })
                .collect();
            (arm.name, rows)
        })
        .collect()
}

/// 三档参考集（全局下标），用 `motif_pred`（与 P16 的 `reference_set` 逐字同源）。
pub fn zone_sets(p: &Pooled) -> [(&'static str, Vec<usize>); 3] {
    [
        ("final_third_candidate", set_where(p, motif_pred("final_third_candidate"))),
        ("build_up_candidate", set_where(p, motif_pred("build_up_candidate"))),
        ("progression_candidate", set_where(p, motif_pred("progression_candidate"))),
    ]
}

/// 收敛成 [`VerdictTable`]（三档里本 change 关心的两对比较）。
pub fn verdict_table(p: &Pooled, intents: &[EpisodeIntent]) -> VerdictTable {
    let sets = zone_sets(p);
    let get = |name: &str| -> Vec<usize> {
        sets.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let final_set = get("final_third_candidate");
    let rest: Vec<usize> = crate::probe::complement(p, &final_set);
    let bu = get("build_up_candidate");
    let pr = get("progression_candidate");
    VerdictTable {
        final_vs_rest: gate_rows(p, intents, &final_set, &rest, "final_vs_rest"),
        build_vs_prog: gate_rows(p, intents, &bu, &pr, "build_vs_prog"),
    }
}
