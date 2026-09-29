//! P16 **判别参考集**（phaseability gate 的「应属该档」定义）。
//!
//! ## ⚠️ 本文件的头号纪律：**不得读任何位置量**
//!
//! 契约：判别参考集**不得只用区域构造**（否则循环论证）。本模块把三档 phase 的参考集
//! **只由动作链 motif** 构造——动作类型 / `result` / `detail`（是否定位球）/
//! `EpisodeStartReason`（由控制权转换决定），**零位置**。
//!
//! ## 为什么单独一个文件（这是**结构性**保证，不是纪律声明）
//!
//! 守卫 `reference_set_source_references_no_position_quantity` 扫的正是**本文件全文**。
//! 早先 `reference_set` 与其它分析函数同处 `gate.rs`，守卫只能扫它的**函数体**——
//! 实测（2026-09-29 独立审阅 P1-1）把位置读取放进**体外 helper** 再在体内调用，
//! **全套 32 条仍绿**，而参考集已经真的用上了位置。
//! 拆成独立文件后，**任何** helper 都必须落在本文件内，因此**全文扫描覆盖调用闭包**。
//!
//! ⚠️ **代价（如实记录）**：这仍不是形式化证明（没有真正的调用图分析）。
//! 它挡的是「混进一句位置读取」，挡不住「刻意用晦涩别名读位置」。
//! 对「防止自己不小心写循环论证」这个目的够用；对「防恶意构造」不够——
//! 那需要类型级隔离（把位置量封进一个 `Position` newtype，参考集侧不导入它）。

use fm_engine::observation::*;
use std::collections::BTreeMap;

// ============================== 参考集（纯动作链 motif） ==============================

/// 参考集的一档：一个具名 motif + 它的谓词**逐条**（含「是否用位置」标注）。
pub struct ReferenceMotif {
    /// 档名（**不得**叫 `Phase`——见契约）。
    pub name: &'static str,
    /// 谓词的逐条子句：`(子句说明, 是否使用位置/区域)`。
    pub clauses: &'static [(&'static str, bool)],
}

/// 三档的参考 motif。**每一条子句都标注是否用位置**——这是本模块的审计核心。
///
/// ⚠️ 若某条子句的 `bool` 为 `true`，该档参考集**失去判别力**：
/// 用它去检验位置特征 = 用位置验证位置（循环论证）。
pub const REFERENCE_MOTIFS: &[ReferenceMotif] = &[
    ReferenceMotif {
        name: "final_third_candidate",
        clauses: &[
            ("episode 的**最后一个决策动作**是 `shot`", false),
            ("（不看该 shot 的 x/y，也不看 x2/y2）", false),
        ],
    },
    ReferenceMotif {
        name: "build_up_candidate",
        clauses: &[
            ("`start_reason` ∈ {kickoff, restart_control}（由控制权转换决定）", false),
            ("开放比赛成功传球数 ≥ 3", false),
            ("不含 `shot`（未进入射门）", false),
        ],
    },
    ReferenceMotif {
        name: "progression_candidate",
        clauses: &[
            ("开放比赛成功传球数 ≥ 1", false),
            ("不含 `shot`", false),
            ("`start_reason` ∉ {kickoff, restart_control}（不是从重开开始）", false),
        ],
    },
];

/// 构造某档参考集的 episode 下标集（**纯动作链**，零位置）。
pub fn reference_set(dm: &DiagnosticMatch, name: &str) -> Vec<usize> {
    let mut out = Vec::new();
    for (i, ep) in dm.possession_episodes.iter().enumerate() {
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
            continue;
        }
        let is_delivery = |e: &fm_engine::Event| {
            matches!(
                e.detail.as_deref(),
                Some("free_kick") | Some("throw_in") | Some("corner") | Some("goal_kick")
            )
        };
        let open_passes = acts
            .iter()
            .filter(|e| {
                e.type_ == fm_engine::EventType::Pass
                    && !is_delivery(e)
                    && e.result.as_deref() == Some("success")
            })
            .count();
        let has_shot = acts.iter().any(|e| e.type_ == fm_engine::EventType::Shot);
        let ends_shot = acts
            .last()
            .map(|e| e.type_ == fm_engine::EventType::Shot)
            .unwrap_or(false);
        let from_restart = matches!(
            ep.start_reason,
            EpisodeStartReason::Kickoff | EpisodeStartReason::RestartControl
        );
        let hit = match name {
            "final_third_candidate" => ends_shot,
            "build_up_candidate" => from_restart && open_passes >= 3 && !has_shot,
            "progression_candidate" => open_passes >= 1 && !has_shot && !from_restart,
            _ => false,
        };
        if hit {
            out.push(i);
        }
    }
    out
}

/// 一档参考集的规模（覆盖率）。
pub fn reference_share(refs: &[usize], total: usize) -> Option<f64> {
    if total == 0 {
        return None;
    }
    Some(refs.len() as f64 / total as f64)
}

/// 参考集之间是否**互斥**（同一 episode 只能属一档）。
pub fn overlaps(a: &[usize], b: &[usize]) -> usize {
    let sb: std::collections::BTreeSet<usize> = b.iter().copied().collect();
    a.iter().filter(|i| sb.contains(i)).count()
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
            .map(|m| (m.name, reference_set(dm, m.name)))
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
