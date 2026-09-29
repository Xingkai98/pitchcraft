//! P16 Slice 4：**phaseability gate**（本 change 的验收）。
//!
//! ## 要回答的问题
//!
//! `build_up` / `progression` / `final_third` 三档**能否判定**？——二选一，都要证据：
//! - **够** → 给三档各自的可执行谓词；
//! - **不够** → 明确缺什么 + 15B 的处置。
//!
//! ## 硬约束（本仓契约）
//!
//! **不得用区域/坐标冒充战术阶段**；判别参考集**不得只用区域构造**（否则循环论证）。
//! 若最终只能用几何代理，须命名为**证据**，**不得复用 `Phase`**。
//!
//! ## 参考集怎么构造（用户 2026-09-29 定：候选 1「motif 为主」+ 候选 3「人工抽检」）
//!
//! 参考集**只由动作链 motif 构造**——即**不含任何位置信息**的谓词：
//! 动作类型（`pass`/`shot`/`tackle`/`foul`）、`result`、`detail`（是否定位球）、
//! `EpisodeStartReason`（由控制权转换决定，不是位置）。
//!
//! ⚠️ **用户点名要防的风险（本模块的头号纪律）**：**motif 定义本身可能悄悄用位置**。
//! 故 [`REFERENCE_MOTIFS`] 把每个谓词的**每一条子句**列出，并逐条标注
//! 「是否用位置/区域」。任何一条用了位置，整档参考集就失去判别力（退化成循环）。
//!
//! ## 检验怎么做
//!
//! 对每一档参考集（「应属」）与其补集（「不应属」），用 P16 的特征算**可分性**：
//! 秩基 AUC（无需依赖，对分布形状不敏感）。AUC 0.5 = 无区分力，1.0 = 完全分开。
//!
//! ⚠️ **循环性防护**：检验用的特征**不得**与构造参考集的 motif 共用同一个量。
//! 本模块的 motif 全部是**动作类型**，特征是**空间量**——两者**结构上不相交**。
//! 这一条由 `motifs_do_not_use_position`（子句自述核对）与
//! `reference_set_source_references_no_position_quantity`（**源码扫描**）守。
//! ⚠️ 早先这里引用过一个 `motifs_and_features_are_disjoint`——**它不存在**
//! （只有过事件位置的行为核对版，已因盲区被源码扫描取代）。删掉这个死引用。

use crate::caliber::*;
use crate::features::*;
use crate::reference::*;

/// 一场比赛的**三档参考集下标**（对内经 [`action_facts`] → [`reference_set`]，
/// 故参考集本身够不着位置；本适配器只做「过滤无动作 episode」与下标对齐）。
pub fn reference_sets(dm: &DiagnosticMatch) -> Vec<(&'static str, Vec<usize>)> {
    let facts = action_facts(dm);
    REFERENCE_MOTIFS
        .iter()
        .map(|m| {
            let mut idx = Vec::new();
            for (i, f) in facts.iter().enumerate() {
                let Some(f) = f else { continue };
                if reference_set(std::slice::from_ref(f), m.name).contains(&0) {
                    idx.push(i);
                }
            }
            (m.name, idx)
        })
        .collect()
}

/// 从一场比赛抽取每 episode 的**动作链事实**（参考集的唯一输入）。
///
/// **它读事件、但只提取非位置事实**（动作类型 / `result` / `detail` 是否定位球 /
/// `start_reason`）。构造出的 [`ActionFacts`] **不含任何位置字段**，
/// 故 [`reference_set`] 结构上够不着位置（见 `ActionFacts` 的说明）。
pub fn action_facts(dm: &DiagnosticMatch) -> Vec<Option<ActionFacts>> {
    dm.possession_episodes
        .iter()
        .map(|ep| {
            let acts: Vec<&fm_engine::Event> = ep
                .event_indexes
                .iter()
                .filter_map(|j| dm.events.get(*j))
                .filter(|e| {
                    matches!(
                        e.type_,
                        fm_engine::EventType::Pass
                            | fm_engine::EventType::Shot
                            | fm_engine::EventType::Tackle
                            | fm_engine::EventType::Foul
                    )
                })
                .collect();
            if acts.is_empty() {
                return None;
            }
            let is_delivery = |e: &fm_engine::Event| {
                matches!(
                    e.detail.as_deref(),
                    Some("free_kick") | Some("throw_in") | Some("corner") | Some("goal_kick")
                )
            };
            Some(ActionFacts {
                open_success_passes: acts
                    .iter()
                    .filter(|e| {
                        e.type_ == fm_engine::EventType::Pass
                            && !is_delivery(e)
                            && e.result.as_deref() == Some("success")
                    })
                    .count(),
                has_shot: acts.iter().any(|e| e.type_ == fm_engine::EventType::Shot),
                ends_shot: acts
                    .last()
                    .map(|e| e.type_ == fm_engine::EventType::Shot)
                    .unwrap_or(false),
                from_restart: matches!(
                    ep.start_reason,
                    EpisodeStartReason::Kickoff | EpisodeStartReason::RestartControl
                ),
            })
        })
        .collect()
}
use fm_engine::observation::*;
use std::collections::BTreeMap;

// ============================== 可分性 ==============================

/// 秩基 AUC（Mann–Whitney U）。`pos` = 应属该档的样本，`neg` = 不应属。
///
/// 0.5 = 无区分力（随机），1.0 = 完全分开，>0.5 = 该特征在「应属」组里更大。
/// 任一组为空 → `None`（**不猜 0.5**）。
pub fn auc(pos: &[f64], neg: &[f64]) -> Option<f64> {
    if pos.is_empty() || neg.is_empty() {
        return None;
    }
    let mut wins = 0.0f64;
    for p in pos {
        for n in neg {
            if p > n {
                wins += 1.0;
            } else if (p - n).abs() < 1e-12 {
                wins += 0.5; // 并列算半胜
            }
        }
    }
    Some(wins / (pos.len() as f64 * neg.len() as f64))
}

/// 一个特征的逐 episode 值（缺的**不填 0**——直接不参与）。
#[derive(Debug, Clone, Default)]
pub struct EpisodeFeature {
    pub net_progress: Option<f64>,
    pub forward_m: Option<f64>,
    pub backward_m: Option<f64>,
    pub lateral_m: Option<f64>,
    pub depth_slope: Option<f64>,
    pub support_frames_share: Option<f64>,
    /// 位置口径的**起点推进度**（方向归一）——这是「区域」量，**只用于对照**，
    /// **不得**作为 phase 谓词（见契约）。
    pub start_progress: f64,
    /// episode 时长（秒）——**混淆变量**：累计位移随它增长，
    /// 故分离必须检查「是否只是长 vs 短」。`end_t` 不可得时为 `None`。
    pub duration_s: Option<f64>,
}

/// 从一场比赛抽出每个 episode 的特征（**逐 episode**，供分组比较）。
pub fn episode_features(dm: &DiagnosticMatch) -> Vec<(usize, EpisodeFeature)> {
    let mut out = Vec::new();
    for (i, ep) in dm.possession_episodes.iter().enumerate() {
        let Some(c) = caliber_of(dm, ep) else { continue };
        let end = ep.end_t.map(|t| t.value);
        let frames: Vec<(f64, StateSnapshot)> = dm
            .state_snapshots
            .iter()
            .filter(|s| {
                s.t.value + 1e-9 >= ep.start_t.value
                    && end.map(|e| s.t.value <= e + 1e-9).unwrap_or(false)
            })
            .map(|s| (s.t.value, s.clone()))
            .collect();
        let ball = collect_ball_track(&frames);
        let shapes = collect_shapes(&frames, ep.team);
        let disp = decompose_displacement(&ball, ep.team);
        let ls = line_spacing_change(&shapes);
        let sup_frames = frames
            .iter()
            .filter(|(_, s)| {
                support_formation(s, ep.team)
                    .map(|f| f.supporters > 0)
                    .unwrap_or(false)
            })
            .count();
        out.push((
            i,
            EpisodeFeature {
                net_progress: c.net_progress(),
                forward_m: disp.map(|d| d.forward_m),
                backward_m: disp.map(|d| d.backward_m),
                lateral_m: disp.map(|d| d.lateral_m),
                depth_slope: ls.map(|l| l.depth_slope_m_per_s),
                support_frames_share: if frames.is_empty() {
                    None
                } else {
                    Some(sup_frames as f64 / frames.len() as f64)
                },
                start_progress: c.start_progress,
                duration_s: end.map(|e| e - ep.start_t.value),
            },
        ));
    }
    out
}

/// 一条特征的可分性结果。
#[derive(Debug, Clone)]
pub struct Separability {
    pub feature: &'static str,
    pub auc: Option<f64>,
    pub pos_n: usize,
    pub neg_n: usize,
}

/// 对一档参考集，算全部特征的可分性。
///
/// `start_progress`（区域量）**列入但标注**——它的 AUC 是**对照**：
/// 若只有它分得开而其他空间特征分不开，说明「可分」来自位置而非战术意图
/// （即落回契约禁的「区域 = 阶段」）。
pub fn separability(
    refs: &[usize],
    feats: &[(usize, EpisodeFeature)],
) -> Vec<Separability> {
    let in_set: std::collections::BTreeSet<usize> = refs.iter().copied().collect();
    let specs: [(&'static str, fn(&EpisodeFeature) -> Option<f64>); 7] = [
        ("net_progress", |e| e.net_progress),
        ("forward_m", |e| e.forward_m),
        ("backward_m", |e| e.backward_m),
        ("lateral_m", |e| e.lateral_m),
        ("depth_slope", |e| e.depth_slope),
        ("support_frames_share", |e| e.support_frames_share),
        ("start_progress[区域量·仅对照]", |e| Some(e.start_progress)),
    ];
    specs
        .into_iter()
        .map(|(feature, f)| {
            let mut pos = Vec::new();
            let mut neg = Vec::new();
            for (i, ef) in feats {
                let Some(v) = f(ef) else { continue };
                if in_set.contains(i) {
                    pos.push(v);
                } else {
                    neg.push(v);
                }
            }
            Separability {
                feature,
                auc: auc(&pos, &neg),
                pos_n: pos.len(),
                neg_n: neg.len(),
            }
        })
        .collect()
}

/// 参考集规模与重叠的汇总（供报告）。
#[derive(Debug, Clone, Default)]
pub struct ReferenceSummary {
    pub total_episodes: usize,
    pub by_name: BTreeMap<&'static str, usize>,
    pub pairwise_overlap: BTreeMap<(&'static str, &'static str), usize>,
}

impl ReferenceSummary {
    pub fn build(dm: &DiagnosticMatch) -> Self {
        let mut s = ReferenceSummary {
            total_episodes: dm.possession_episodes.len(),
            ..Default::default()
        };
        let sets: Vec<(&'static str, Vec<usize>)> = REFERENCE_MOTIFS
            .iter()
            .map(|m| {
                let all = reference_sets(dm);
                let v = all
                    .iter()
                    .find(|(n, _)| *n == m.name)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                (m.name, v)
            })
            .collect();
        for (n, r) in &sets {
            s.by_name.insert(n, r.len());
        }
        for i in 0..sets.len() {
            for j in i + 1..sets.len() {
                let ov = overlaps(&sets[i].1, &sets[j].1);
                if ov > 0 {
                    s.pairwise_overlap.insert((sets[i].0, sets[j].0), ov);
                }
            }
        }
        s
    }
}
