//! P17A M1–M3 指标聚合（design §3.3–§3.5）。
//!
//! 全部输入是**逐场记录**（`model::MatchRecord`），全部输出自带样本量。
//! 分位/离散度先在单场内算，再跨场聚合（`model::Stat` 的契约）。

use crate::model::{share_of, MatchRecord, Stat};
use std::collections::BTreeMap;

/// 带分母的比例（分母为 0 时 `value` 记 0，并由调用方按 `denominator` 判样本是否够）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    pub hits: usize,
    pub denominator: usize,
    pub value: f64,
}

impl Rate {
    pub fn new(hits: usize, denominator: usize) -> Rate {
        Rate {
            hits,
            denominator,
            value: share_of(hits, denominator),
        }
    }
}

fn stat_by_key(
    per_match: &[MatchRecord],
    key_of: impl Fn(&MatchRecord) -> BTreeMap<String, Vec<f64>>,
) -> BTreeMap<String, Stat> {
    let mut acc: BTreeMap<String, Vec<Vec<f64>>> = BTreeMap::new();
    for m in per_match {
        for (k, vals) in key_of(m) {
            acc.entry(k).or_default().push(vals);
        }
    }
    acc.into_iter()
        .map(|(k, per_match_obs)| (k, Stat::from_observations(&per_match_obs)))
        .collect()
}

/// 按「比赛 × 键」分组：外层 key → **每场一个**观测向量。
///
/// **为什么必须这样分组**（别退回"每条观测一个向量"）：`Stat::from_observations` 的契约是
/// 「每个元素 = 一场比赛内的观测序列」，它先在**场内**算分位/离散度再跨场聚合；
/// 若把单条观测各当一个"场"，`matches` 就会等于 `observations`，等于把跨 seed 的原始观测**池化**，
/// 于是 P50/P90 退化成均值、`cross_match_mean_sd` 变成混合了场间差异的膨胀值——
/// 而设计 §3.1 明令禁止池化（它会虚高 sd 并奖励压平量级的改动）。
///
/// 判别法：产物里任何 by-kind / by-reason 表的 `matches` 必须等于参与的比赛数（≤ seed 数），
/// **不得**等于观测数。守卫见测试 `by_kind_stats_group_per_match_not_per_observation`。
fn stat_by_match_and_key<K, V>(
    per_match: &[MatchRecord],
    items: impl Fn(&MatchRecord) -> Vec<(K, V)>,
) -> BTreeMap<String, Stat>
where
    K: Into<String> + Ord + Clone,
    V: Into<f64>,
{
    let mut acc: BTreeMap<String, Vec<Vec<f64>>> = BTreeMap::new();
    for m in per_match {
        let mut this_match: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for (k, v) in items(m) {
            this_match.entry(k.into()).or_default().push(v.into());
        }
        for (k, vals) in this_match {
            acc.entry(k).or_default().push(vals);
        }
    }
    acc.into_iter()
        .map(|(k, per_match_obs)| (k, Stat::from_observations(&per_match_obs)))
        .collect()
}

// ============================== M1 possession 形状 ==============================

#[derive(Debug, Clone)]
pub struct PossessionShape {
    pub episodes_per_match: Stat,
    pub start_reason_counts: BTreeMap<String, usize>,
    pub end_reason_counts: BTreeMap<String, usize>,
    /// 按开始原因条件分解的结束原因分布（`start_reason` → `end_reason` → 计数）。
    pub end_reason_given_start: BTreeMap<String, BTreeMap<String, usize>>,
    /// 各开始原因下的 episode 持续时间（逐场后跨场）。
    pub duration_by_start_reason: BTreeMap<String, Stat>,
    pub duration_seconds: Stat,
    pub action_count: Stat,
    pub pass_count: Stat,
    /// episode 内相邻动作的时间差——"持球-出球节奏"的直接观测。
    pub action_gap_seconds: Stat,
    /// 同一队连续 epi 之间无（不计算"球权连续性"，sidecar 无此语义）。
    pub possession_seconds_per_match: Stat,
    /// 射门前**成功传球数**（`control→pass*→shot` 的 `pass*` 长度）。
    ///
    /// **口径**：分母是「动作链里含 shot 事件的 episode」（= `first_shot_index.is_some()`），
    /// 不是 `end_reason ∈ {goal, saved_caught, shot_rebound}`。两者不同（前者更大，因为被扑出后
    /// 由对手控制的射门等也计入）。design §3.3 的表述已与实现对齐，勿按另一种口径读。
    pub pre_shot_successful_passes: Stat,
    /// 射门在动作链中的序号（射门前有多少个动作，含失败传球）。
    pub pre_shot_chain_actions: Stat,
    /// 归属 episode 的 `beat` 数（不入动作链，仅作归属完整性交叉检查）。
    pub beat_bindings_per_episode: Stat,
}

pub fn possession_shape(per_match: &[MatchRecord]) -> PossessionShape {
    let episodes_per_match: Vec<f64> = per_match
        .iter()
        .map(|m| m.episodes.len() as f64)
        .collect();

    let mut start_reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut end_reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut end_given_start: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for m in per_match {
        for (k, v) in &m.episode_start_reason_counts {
            *start_reason_counts.entry(k.to_string()).or_insert(0) += v;
            // 条件分布的每个 start_reason 都要有完整的 end_reason 行（0 也显式出现）。
            let row = end_given_start.entry(k.to_string()).or_default();
            for e in m.episode_end_reason_counts.keys() {
                row.entry(e.to_string()).or_insert(0);
            }
        }
        for (k, v) in &m.episode_end_reason_counts {
            *end_reason_counts.entry(k.to_string()).or_insert(0) += v;
        }
        // 条件计数：需要逐 episode 重新数（`MatchRecord` 只存了边际计数）。
        for ep in &m.episodes {
            let start = ep.start_reason.to_string();
            let end = ep.end_reason.unwrap_or("unclosed").to_string();
            *end_given_start
                .entry(start)
                .or_default()
                .entry(end)
                .or_insert(0) += 1;
        }
    }

    let duration_by_start_reason = stat_by_key(per_match, |m| {
        let mut out: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for ep in &m.episodes {
            if let Some(d) = ep.duration {
                out.entry(ep.start_reason.to_string()).or_default().push(d);
            }
        }
        out
    });

    let shape = |f: fn(&MatchRecord) -> Vec<f64>| -> Stat {
        Stat::from_observations(&per_match.iter().map(f).collect::<Vec<_>>())
    };

    PossessionShape {
        episodes_per_match: Stat::from_per_match_values(&episodes_per_match),
        start_reason_counts,
        end_reason_counts,
        end_reason_given_start: end_given_start,
        duration_by_start_reason,
        duration_seconds: shape(|m| m.episodes.iter().filter_map(|e| e.duration).collect()),
        action_count: shape(|m| {
            m.episodes
                .iter()
                .map(|e| e.action_count() as f64)
                .collect()
        }),
        pass_count: shape(|m| m.episodes.iter().map(|e| e.pass_count() as f64).collect()),
        action_gap_seconds: shape(|m| {
            m.episodes
                .iter()
                .flat_map(|e| e.action_gaps.iter().cloned())
                .collect()
        }),
        possession_seconds_per_match: Stat::from_per_match_values(
            &per_match
                .iter()
                .map(|m| m.episodes.iter().filter_map(|e| e.duration).sum::<f64>())
                .collect::<Vec<_>>(),
        ),
        pre_shot_successful_passes: shape(|m| {
            m.episodes
                .iter()
                .filter_map(crate::motifs::successful_passes_before_shot)
                .map(|n| n as f64)
                .collect()
        }),
        pre_shot_chain_actions: shape(|m| {
            m.episodes
                .iter()
                .filter_map(|e| e.first_shot_index)
                .map(|i| i as f64)
                .collect()
        }),
        beat_bindings_per_episode: shape(|m| {
            m.episodes
                .iter()
                .map(|e| e.beat_bindings as f64)
                .collect()
        }),
    }
}

// ============================== M2 控制权转换 ==============================

#[derive(Debug, Clone)]
pub struct ControlTransitions {
    pub contests_per_match: Stat,
    pub duration_seconds: Stat,
    /// 争抢时长的**取值分布**（保留 3 位小数）。用它暴露"时长只取少数离散步长"这类退化。
    pub duration_value_counts: BTreeMap<String, usize>,
    /// trace: `(原因, 时长)` 的联合计数——把"哪个原因对应哪个时长"钉在一起。
    pub duration_by_reason_pairs: BTreeMap<String, usize>,
    pub reason_counts: BTreeMap<String, usize>,
    pub end_reason_counts: BTreeMap<String, usize>,
    /// 各争抢原因的时长（逐场后跨场）。与 `duration_value_counts` 交叉：后者说"时长退化成
    /// 少数取值"，前者说"哪个原因对应哪个时长"——两者合起来才能定位机制。
    pub duration_by_reason: BTreeMap<String, Stat>,
    /// 丢球方夺回率（分母 = 有明确 pickup 队伍的争抢）。
    pub regain_by_loser: Rate,
    /// 按争抢原因分解的夺回率。
    pub regain_by_reason: BTreeMap<String, Rate>,
    /// 按争抢原因分解的"下一控制方"构成（`same` = 原控球队，`opponent` = 对手，`unknown`）。
    pub next_controller_by_reason: BTreeMap<String, BTreeMap<String, usize>>,
    /// 争抢后新 episode 的**前 1–3 个开放动作** token 序列 → 计数。
    pub first_actions_after_transition: BTreeMap<String, usize>,
    /// 争抢后没有找到新 episode 的次数（截断/未闭合，不猜）。
    pub transitions_without_next_episode: usize,
}

pub fn control_transitions(per_match: &[MatchRecord]) -> ControlTransitions {
    let mut reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut end_reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut duration_value_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut duration_by_reason_pairs: BTreeMap<String, usize> = BTreeMap::new();
    let mut regain_hits = 0usize;
    let mut regain_den = 0usize;
    let mut regain_by_reason: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut next_by_reason: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut first_actions: BTreeMap<String, usize> = BTreeMap::new();
    let mut no_next = 0usize;

    for m in per_match {
        for c in &m.contests {
            *reason_counts.entry(c.reason.to_string()).or_insert(0) += 1;
            *end_reason_counts
                .entry(c.end_reason.unwrap_or("-").to_string())
                .or_insert(0) += 1;
            if let Some(d) = c.duration {
                *duration_value_counts
                    .entry(format!("{:.3}", d))
                    .or_insert(0) += 1;
                *duration_by_reason_pairs
                    .entry(format!("{}/{:.3}", c.reason, d))
                    .or_insert(0) += 1;
            }
            let entry = regain_by_reason.entry(c.reason.to_string()).or_insert((0, 0));
            let next = next_by_reason.entry(c.reason.to_string()).or_default();
            match (c.losing_team, c.pickup_team) {
                (Some(l), Some(p)) => {
                    regain_den += 1;
                    entry.1 += 1;
                    if l == p {
                        regain_hits += 1;
                        entry.0 += 1;
                        *next.entry("same".to_string()).or_insert(0) += 1;
                    } else {
                        *next.entry("opponent".to_string()).or_insert(0) += 1;
                    }
                }
                _ => {
                    *next.entry("unknown".to_string()).or_insert(0) += 1;
                }
            }
            match c.next_episode {
                Some(i) => {
                    let tokens: Vec<&str> = m.episodes[i]
                        .open_play_actions()
                        .take(3)
                        .map(|a| a.kind.token())
                        .collect();
                    let key = if tokens.is_empty() {
                        "(无开放动作)".to_string()
                    } else {
                        tokens.join("→")
                    };
                    *first_actions.entry(key).or_insert(0) += 1;
                }
                None => no_next += 1,
            }
        }
    }

    let regain_by_reason: BTreeMap<String, Rate> = regain_by_reason
        .into_iter()
        .map(|(k, (h, d))| (k, Rate::new(h, d)))
        .collect();

    ControlTransitions {
        contests_per_match: Stat::from_per_match_values(
            &per_match
                .iter()
                .map(|m| m.contests.len() as f64)
                .collect::<Vec<_>>(),
        ),
        duration_seconds: Stat::from_observations(
            &per_match
                .iter()
                .map(|m| m.contests.iter().filter_map(|c| c.duration).collect())
                .collect::<Vec<_>>(),
        ),
        duration_value_counts,
        duration_by_reason_pairs,
        duration_by_reason: stat_by_match_and_key(per_match, |m| {
            m.contests
                .iter()
                .filter_map(|c| c.duration.map(|d| (c.reason, d)))
                .collect()
        }),
        reason_counts,
        end_reason_counts,
        regain_by_loser: Rate::new(regain_hits, regain_den),
        regain_by_reason,
        next_controller_by_reason: next_by_reason,
        first_actions_after_transition: first_actions,
        transitions_without_next_episode: no_next,
    }
}

// ============================== M3 重开质量 ==============================

#[derive(Debug, Clone)]
pub struct RestartQuality {
    pub restarts_per_match: Stat,
    pub kind_counts: BTreeMap<String, usize>,
    pub end_reason_counts: BTreeMap<String, usize>,
    pub prep_seconds_by_kind: BTreeMap<String, Stat>,
    pub flight_seconds_by_kind: BTreeMap<String, Stat>,
    pub first_control_delay_by_kind: BTreeMap<String, Stat>,
    pub first_possession_duration_by_kind: BTreeMap<String, Stat>,
    pub first_possession_actions_by_kind: BTreeMap<String, Stat>,
    pub first_possession_end_reasons: BTreeMap<String, usize>,
    /// 重开后首个 possession 以"立即丢失"收场（`motifs::matches_restart_immediate_loss`）。
    pub immediate_loss: Rate,
    /// 重开后**找不到**首个 episode（流截断/未恢复）的次数——不猜，显式计数。
    pub restarts_without_first_possession: usize,
    /// 首个 episode 的 `start_reason` 构成（验证"重开→restart_control"这条耦合）。
    pub first_possession_start_reasons: BTreeMap<String, usize>,
}

pub fn restart_quality(per_match: &[MatchRecord]) -> RestartQuality {
    let mut kind_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut end_reason_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut first_end: BTreeMap<String, usize> = BTreeMap::new();
    let mut first_start: BTreeMap<String, usize> = BTreeMap::new();
    let mut imm_hits = 0usize;
    let mut imm_den = 0usize;
    let mut no_first = 0usize;

    for m in per_match {
        for r in &m.restarts {
            let k = r.kind.to_string();
            *kind_counts.entry(k.clone()).or_insert(0) += 1;
            *end_reason_counts
                .entry(r.end_reason.unwrap_or("-").to_string())
                .or_insert(0) += 1;
            match r.first_episode {
                Some(i) => {
                    let ep = &m.episodes[i];
                    imm_den += 1;
                    *first_end
                        .entry(ep.end_reason.unwrap_or("-").to_string())
                        .or_insert(0) += 1;
                    *first_start
                        .entry(ep.start_reason.to_string())
                        .or_insert(0) += 1;
                    if crate::motifs::matches_restart_immediate_loss(ep) {
                        imm_hits += 1;
                    }
                }
                None => no_first += 1,
            }
        }
    }

    // by-kind 统计一律走 `stat_by_match_and_key`（每场一个观测向量），**不得**逐条观测 push——
    // 那会让 `matches == observations`，把设计 §3.1 禁止的池化偷偷引回来
    // （P50/P90 退化成均值、场间 sd 膨胀）。守卫见 `by_kind_stats_group_per_match_not_per_observation`。
    let by_kind = |items: fn(&MatchRecord) -> Vec<(String, f64)>| -> BTreeMap<String, Stat> {
        stat_by_match_and_key(per_match, items)
    };

    RestartQuality {
        restarts_per_match: Stat::from_per_match_values(
            &per_match
                .iter()
                .map(|m| m.restarts.len() as f64)
                .collect::<Vec<_>>(),
        ),
        kind_counts,
        end_reason_counts,
        prep_seconds_by_kind: by_kind(|m| {
            m.restarts
                .iter()
                .filter_map(|r| r.prep_duration.map(|v| (r.kind.to_string(), v)))
                .collect()
        }),
        flight_seconds_by_kind: by_kind(|m| {
            m.restarts
                .iter()
                .filter_map(|r| r.flight_duration.map(|v| (r.kind.to_string(), v)))
                .collect()
        }),
        first_control_delay_by_kind: by_kind(|m| {
            m.restarts
                .iter()
                .filter_map(|r| r.first_control_delay.map(|v| (r.kind.to_string(), v)))
                .collect()
        }),
        first_possession_duration_by_kind: by_kind(|m| {
            m.restarts
                .iter()
                .filter_map(|r| {
                    r.first_episode
                        .and_then(|i| m.episodes[i].duration)
                        .map(|d| (r.kind.to_string(), d))
                })
                .collect()
        }),
        first_possession_actions_by_kind: by_kind(|m| {
            m.restarts
                .iter()
                .filter_map(|r| {
                    r.first_episode
                        .map(|i| (r.kind.to_string(), m.episodes[i].action_count() as f64))
                })
                .collect()
        }),
        first_possession_end_reasons: first_end,
        immediate_loss: Rate::new(imm_hits, imm_den),
        restarts_without_first_possession: no_first,
        first_possession_start_reasons: first_start,
    }
}

// ============================== 样本量（防空转） ==============================

#[derive(Debug, Clone, Copy, Default)]
pub struct SampleTotals {
    pub matches: usize,
    pub events: usize,
    pub facts: usize,
    pub episodes: usize,
    pub restarts: usize,
    pub contests: usize,
    pub actions: usize,
    pub beats: usize,
    pub gaps: usize,
    pub invariant_violations: usize,
    pub unclosed_episodes: usize,
    pub scores_present: usize,
}

pub fn sample_totals(per_match: &[MatchRecord]) -> SampleTotals {
    let mut t = SampleTotals {
        matches: per_match.len(),
        ..Default::default()
    };
    for m in per_match {
        t.events += m.events_len;
        t.facts += m.facts_len;
        t.episodes += m.episodes.len();
        t.restarts += m.restarts.len();
        t.contests += m.contests.len();
        t.actions += m.action_counts.values().sum::<usize>();
        t.beats += *m.event_type_counts.get("beat").unwrap_or(&0);
        t.gaps += m.gap_count;
        t.invariant_violations += m.invariant_violations;
        t.unclosed_episodes += m.episodes.iter().filter(|e| e.end_t.is_none()).count();
        if m.final_score.is_some() {
            t.scores_present += 1;
        }
    }
    t
}
