//! P17A 动作链 motif（design §3.6）：n-gram 频次 + 四个具名 motif。
//!
//! motif 一律在**动作 token 序列**上判定（`ActionKind::token()`），序列来自
//! `EpisodeRecord::actions`，因此 `beat` 天然不在其中（口径见 model.rs 模块头）。
//!
//! 每条 motif 都输出**回放定位**（seed / t / episode_id / 事件下标）——没有定位的 motif 计数
//! 只是又一次场均统计，不能作为异常证据。

use crate::model::{ActionKind, ContestRecord, EpisodeRecord, MatchRecord};
use std::collections::BTreeMap;

/// 回放定位：回到这一条链所需的最小信息。
#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceSample {
    pub seed: u64,
    pub t: f64,
    pub episode_id: Option<u64>,
    pub restart_id: Option<u64>,
    pub event_indexes: Vec<usize>,
    pub note: String,
}

/// 一个具名 motif 的聚合结果。
#[derive(Debug, Clone)]
pub struct MotifHit {
    pub name: &'static str,
    /// 跨界（跨 seed 求和）命中次数。
    pub hits: usize,
    /// 对应分母（同一口径；含义写在 `denominator_name`）。
    pub denominator: usize,
    pub denominator_name: &'static str,
    pub rate: f64,
    /// 命中后的后果分布（end_reason → 次数），用来回答"这个链子最后怎样了"。
    pub consequence_end_reasons: BTreeMap<String, usize>,
    pub samples: Vec<EvidenceSample>,
}

/// 一个 n-gram 的聚合结果。
#[derive(Debug, Clone)]
pub struct NgramStat {
    pub ngram: String,
    pub n: usize,
    pub count: usize,
    pub episodes_hitting: usize,
    pub top_end_reason: String,
    pub samples: Vec<EvidenceSample>,
}

#[derive(Debug, Clone)]
pub struct MotifReport {
    pub named: Vec<MotifHit>,
    /// n=2..4 各取最高频的 `top_per_n` 条。
    pub ngrams: Vec<NgramStat>,
    pub ngram_totals: BTreeMap<String, usize>,
}

const MAX_SAMPLES: usize = 5;
const TOP_PER_N: usize = 15;

fn sample_of(seed: u64, ep: &EpisodeRecord, note: &str) -> EvidenceSample {
    EvidenceSample {
        seed,
        t: ep.start_t,
        episode_id: Some(ep.id),
        restart_id: None,
        event_indexes: ep.actions.iter().map(|a| a.event_index).take(8).collect(),
        note: format!("{} | start={} end={}", note, ep.start_reason, ep.end_reason.unwrap_or("-")),
    }
}

/// 具名比对：`pickup → pass → lost`
///
/// 判定：`start_reason == pickup`，动作链里**恰有 1 次**成功传球、**至少 1 次**失败传球
/// （`passI`/`passL`），且**第一次**失败传球出现在那次成功传球之后
/// （即"拿球 → 传一次 → 丢"，之后再传丢也只算一次命中）。
///
/// **边界口径**（2026-09-24 审阅定死，别改回"恰有 1 次失败"）：实现取 `bad >= 1`，
/// 文档原先写"恰有一次失败传球"——两者不一致。实测 300 场里 `pickup` + 恰 1 次成功传球
/// 的 episode 共 779 个，其失败传球数**全部为 1**（`bad` 分布 `{1: 779}`），所以此刻两种读法
/// 结果相同；但 `bad == 2`（成功传球 → 失败 → 失败）是可达形状，按本 motif 的语义
/// （"接球后只传一次就丢"）应当命中，因此实现保留 `>= 1`。
/// 反例与边界见 `named_motif_matchers_hold_on_constructed_chains`（该测试里包含
/// `two_fail` 这个「1 次成功 + 连续两次失败」的边界用例）。
pub fn matches_pickup_pass_lost(ep: &EpisodeRecord) -> bool {
    if ep.start_reason != "pickup" {
        return false;
    }
    let ok = ep.pass_success_count();
    let bad = ep
        .actions
        .iter()
        .filter(|a| a.kind.is_pass_failure())
        .count();
    if ok != 1 || bad == 0 {
        return false;
    }
    let first_bad = ep
        .actions
        .iter()
        .position(|a| a.kind.is_pass_failure())
        .expect("bad > 0 已保证存在失败传球");
    let first_ok = ep
        .actions
        .iter()
        .position(|a| a.kind == ActionKind::PassSuccess)
        .expect("ok == 1 已保证存在成功传球");
    first_ok < first_bad
}

/// 具名比对：`restart → receive → immediate loss`
///
/// 判定（三条通路任一，均为"重开交付之后球权立刻丢掉"）：
/// ① 首个**非交付**动作就是失败传球（`passI`/`passL`）；
/// ② **交付-only**（交付之后没有任何开放动作）且 `end_reason == control_lost`——此通路**不设时长上限**：
///    "接球后根本没出球就丢"与它等了多久无关，60 s 也算；
/// ③ 有开放动作之后以 `control_lost` 结束、且结束时刻距交付 ≤ [`IMMEDIATE_LOSS_SECONDS`]。
///
/// 通路口径差异是刻意的：① 抓"接球即被断"，② 抓"接球后没出球就丢"，③ 抓"出了球但很快又丢"。
/// 窗口只用在 ③ 上——若把它套到 ②，会把"长时间没出球"整段漏掉。
/// 边界见 `named_motif_matchers_hold_on_constructed_chains`（60 s delivery-only 正例 + 20 s delayed 反例）。
pub const IMMEDIATE_LOSS_SECONDS: f64 = 3.0;

pub fn matches_restart_immediate_loss(ep: &EpisodeRecord) -> bool {
    if ep.start_reason != "restart_control" {
        return false;
    }
    let mut open_play = ep.open_play_actions();
    let first_open = open_play.next();
    if let Some(a) = first_open {
        if a.kind.is_pass_failure() {
            return true;
        }
    } else if ep.end_reason == Some("control_lost") {
        // 交付之后没有任何开放动作就丢了：交付本身没能形成控制。
        return true;
    }
    match (ep.end_reason, ep.end_t) {
        (Some("control_lost"), Some(end)) => {
            let delivery_t = ep
                .actions
                .iter()
                .find(|a| a.is_delivery)
                .map(|a| a.t)
                .unwrap_or(ep.start_t);
            end - delivery_t <= IMMEDIATE_LOSS_SECONDS
        }
        _ => false,
    }
}

/// 具名比对：`control → pass* → shot`（提出"射门前成功传球数"作为链长）
pub fn is_shot_ending(ep: &EpisodeRecord) -> bool {
    matches!(
        ep.end_reason,
        Some("goal") | Some("saved_caught") | Some("shot_rebound")
    )
}

/// 射门前成功传球数（`pass*` 的长度）。无射门为 `None`。
pub fn successful_passes_before_shot(ep: &EpisodeRecord) -> Option<usize> {
    let idx = ep.first_shot_index?;
    Some(
        ep.actions[..idx]
            .iter()
            .filter(|a| a.kind == ActionKind::PassSuccess)
            .count(),
    )
}

/// 具名比对：`tackle → loose → original team pickup`
pub fn matches_tackle_regain(c: &ContestRecord) -> bool {
    c.reason == "tackle_loose" && c.regained_by_loser == Some(true)
}

/// 从逐场记录挖掘 motif。`per_match` 必须按 seed 升序传入，样本顺序才是确定的。
pub fn mine(per_match: &[MatchRecord]) -> MotifReport {
    let mut pickup_pass_lost = 0usize;
    let mut pickup_total = 0usize;
    let mut restart_imm = 0usize;
    let mut restart_total = 0usize;
    let mut shot_ending = 0usize;
    let mut episode_total = 0usize;
    let mut tackle_regain = 0usize;
    let mut tackle_total = 0usize;

    let mut ppl_cons: BTreeMap<String, usize> = BTreeMap::new();
    let mut ri_cons: BTreeMap<String, usize> = BTreeMap::new();
    let mut se_cons: BTreeMap<String, usize> = BTreeMap::new();
    let mut tr_cons: BTreeMap<String, usize> = BTreeMap::new();
    let mut ppl_samples = Vec::new();
    let mut ri_samples = Vec::new();
    let mut se_samples = Vec::new();
    let mut tr_samples = Vec::new();

    let mut ngram_counts: BTreeMap<(usize, String), usize> = BTreeMap::new();
    let mut ngram_episodes: BTreeMap<(usize, String), usize> = BTreeMap::new();
    let mut ngram_cons: BTreeMap<(usize, String), BTreeMap<String, usize>> = BTreeMap::new();
    let mut ngram_samples: BTreeMap<(usize, String), Vec<EvidenceSample>> = BTreeMap::new();

    for m in per_match {
        for ep in &m.episodes {
            episode_total += 1;
            let end = ep.end_reason.unwrap_or("-").to_string();

            if ep.start_reason == "pickup" {
                pickup_total += 1;
                if matches_pickup_pass_lost(ep) {
                    pickup_pass_lost += 1;
                    *ppl_cons.entry(end.clone()).or_insert(0) += 1;
                    if ppl_samples.len() < MAX_SAMPLES {
                        ppl_samples.push(sample_of(m.seed, ep, "pickup→pass→lost"));
                    }
                }
            }
            if ep.start_reason == "restart_control" {
                restart_total += 1;
                if matches_restart_immediate_loss(ep) {
                    restart_imm += 1;
                    *ri_cons.entry(end.clone()).or_insert(0) += 1;
                    if ri_samples.len() < MAX_SAMPLES {
                        ri_samples.push(sample_of(m.seed, ep, "restart→receive→immediate loss"));
                    }
                }
            }
            if is_shot_ending(ep) {
                shot_ending += 1;
                *se_cons.entry(end.clone()).or_insert(0) += 1;
                if se_samples.len() < MAX_SAMPLES {
                    se_samples.push(sample_of(m.seed, ep, "control→pass*→shot"));
                }
            }

            // n-gram（n = 2..=4），在 episode token 序列上滑窗。
            let toks = ep.tokens();
            for n in 2..=4usize {
                if toks.len() < n {
                    continue;
                }
                let mut seen_in_this_episode: Vec<String> = Vec::new();
                for w in toks.windows(n) {
                    let key = w.join("→");
                    *ngram_counts.entry((n, key.clone())).or_insert(0) += 1;
                    *ngram_cons
                        .entry((n, key.clone()))
                        .or_default()
                        .entry(end.clone())
                        .or_insert(0) += 1;
                    if !seen_in_this_episode.contains(&key) {
                        seen_in_this_episode.push(key.clone());
                        *ngram_episodes.entry((n, key.clone())).or_insert(0) += 1;
                        let s = ngram_samples.entry((n, key)).or_default();
                        if s.len() < 2 {
                            s.push(sample_of(m.seed, ep, "ngram"));
                        }
                    }
                }
            }
        }

        for c in &m.contests {
            if c.reason == "tackle_loose" {
                tackle_total += 1;
                if matches_tackle_regain(c) {
                    tackle_regain += 1;
                    let key = c
                        .end_reason
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    *tr_cons.entry(key).or_insert(0) += 1;
                    if tr_samples.len() < MAX_SAMPLES {
                        tr_samples.push(EvidenceSample {
                            seed: m.seed,
                            t: c.start_t,
                            episode_id: c.next_episode.map(|i| m.episodes[i].id),
                            restart_id: None,
                            event_indexes: c.source_event_index.into_iter().collect(),
                            note: format!(
                                "tackle→loose→原队拾回 | pickup={:?} duration={:?}",
                                c.pickup_team, c.duration
                            ),
                        });
                    }
                }
            }
        }
    }

    let named = vec![
        MotifHit {
            name: "pickup→pass→lost",
            hits: pickup_pass_lost,
            denominator: pickup_total,
            denominator_name: "pickup 起始的 episode 数",
            rate: crate::model::share_of(pickup_pass_lost, pickup_total),
            consequence_end_reasons: ppl_cons,
            samples: ppl_samples,
        },
        MotifHit {
            name: "restart→receive→immediate_loss",
            hits: restart_imm,
            denominator: restart_total,
            denominator_name: "restart_control 起始的 episode 数",
            rate: crate::model::share_of(restart_imm, restart_total),
            consequence_end_reasons: ri_cons,
            samples: ri_samples,
        },
        MotifHit {
            name: "control→pass*→shot",
            hits: shot_ending,
            denominator: episode_total,
            denominator_name: "全部 episode 数",
            rate: crate::model::share_of(shot_ending, episode_total),
            consequence_end_reasons: se_cons,
            samples: se_samples,
        },
        MotifHit {
            name: "tackle→loose→original_team_pickup",
            hits: tackle_regain,
            denominator: tackle_total,
            denominator_name: "tackle_loose 争抢数",
            rate: crate::model::share_of(tackle_regain, tackle_total),
            consequence_end_reasons: tr_cons,
            samples: tr_samples,
        },
    ];

    // n-gram 汇总：每个 n 取最高频 TOP_PER_N（并列时按 ngram 字典序，保证确定性）。
    let mut ngram_totals = BTreeMap::new();
    let mut ngrams = Vec::new();
    for n in 2..=4usize {
        let mut all: Vec<(&String, &usize)> = ngram_counts
            .iter()
            .filter(|((nn, _), _)| *nn == n)
            .map(|((_, k), v)| (k, v))
            .collect();
        let total: usize = all.iter().map(|(_, v)| **v).sum();
        ngram_totals.insert(format!("n{}", n), total);
        all.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        for (k, v) in all.into_iter().take(TOP_PER_N) {
            let cons = ngram_cons.get(&(n, k.clone())).cloned().unwrap_or_default();
            let top_end = cons
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
                .map(|(k, _)| k.clone())
                .unwrap_or_else(|| "-".to_string());
            ngrams.push(NgramStat {
                ngram: k.clone(),
                n,
                count: *v,
                episodes_hitting: *ngram_episodes.get(&(n, k.clone())).unwrap_or(&0),
                top_end_reason: top_end,
                samples: ngram_samples.get(&(n, k.clone())).cloned().unwrap_or_default(),
            });
        }
    }

    MotifReport {
        named,
        ngrams,
        ngram_totals,
    }
}
