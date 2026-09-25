//! P17A 产物序列化（design §4）：机器可读 JSON + 人可读 Markdown。
//!
//! 两条硬约束：
//!
//! 1. **确定性**：全部容器是 `BTreeMap` / `Vec`（有序），浮点按定点小数格式化，**不写入
//!    时间戳**。同输入两次运行的 JSON 逐字节相同（由 `identical_inputs_produce_byte_identical_output`
//!    守护）。需要时间信息时由调用方在产物之外记录。
//! 2. **口径随产物**：provenance 记录源码 commit、config、seed 区间、sidecar schema 指纹与
//!    口径常量（见 design §4）。

use crate::anomalies::Anomaly;
use crate::metrics::{
    ControlTransitions, PossessionShape, RestartQuality, SampleTotals,
};
use crate::model::{sidecar_schema_fingerprint, MatchRecord, Stat};
use crate::motifs::MotifReport;
use std::collections::BTreeMap;

/// 分析器版本。**内容变化时必须手改**（改规则文本/阈值/口径都算内容变化）。
///
/// 为什么必须手改而不是自动算：`sidecar_schema_fingerprint` 只覆盖 sidecar 的闭集，
/// **不覆盖分析器自己的判据**。2026-09-24 二审实测过一次真实事故——同一目录下的
/// `canary.json` 与 `baseline.json` 来自**不同构建**（其中一次引擎源码被临时改动过），
/// 而两者的 `source_commit` / `analyzer_version` / `schema_fingerprint` **完全相同**，
/// 产物层完全无法察觉。因此本版本号 + 下方 [`engine_source_fingerprint`] 一起承担"这次运行
/// 到底跑了什么"的识别责任。
/// 内容变化（判据/阈值/口径/指纹覆盖范围）时必须手改。
pub const ANALYZER_VERSION: &str = "p17a-4";
pub const SCHEMA_TAG: &str = "p17a-behavior-chain-baseline/1";

/// 引擎源码指纹覆盖的源文件（**顺序即哈希输入顺序，改动会让指纹变**）。
///
/// 覆盖判据：**凡是能改变 `simulate_with_behavior_observations` 输出的 `engine/src/` 源码**。
/// 2026-09-24 审阅指出原先只哈希 `lib.rs` + `observation.rs` 有盲区：`rng.rs` 同样是仿真源码
/// （`SeededRng` 决定每一次随机分支），只改它、不改另外两个文件时，产物层看不出不可比。
/// `wasm.rs` 是平台垫片、不进本测试的编译单元，故不在列。
/// 守卫 `engine_source_fingerprint_covers_all_simulation_sources` 会核对本清单与源码一一对应。
pub const ENGINE_SOURCES: &[(&str, &str)] = &[
    ("lib.rs", include_str!("../../src/lib.rs")),
    ("observation.rs", include_str!("../../src/observation.rs")),
    ("rng.rs", include_str!("../../src/rng.rs")),
];

/// **引擎源码指纹**：直接哈希被编译进本次测试二进制的引擎源码文本（见 [`ENGINE_SOURCES`]）。
///
/// 为什么需要它（而不是只记 `git rev-parse HEAD`）：`P17A_SOURCE_COMMIT` 读的是**提交**，
/// 不是**工作树**。一旦有人在未提交的状态下改了引擎（实测发生过），commit 不变而输出全变，
/// 产物层无法分辨。而 `include_str!` 取的是**编译进二进制的那份源码**，因此：
/// 工作树脏 → 指纹变（哪怕 commit 没变）；`cargo` 用缓存的旧二进制 → 指纹与当前源码不符，
/// 也会在比对时暴露。判据即：**同一次分析的产物必须同源同指纹**。
pub fn engine_source_fingerprint() -> String {
    let mut combined = String::new();
    for (name, text) in ENGINE_SOURCES {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(text);
        combined.push('\n');
    }
    format!("fnv1a64:{:016x}", crate::model::fnv1a(&combined))
}
/// 浮点输出精度：定点 4 位，保证确定性且够读。
const FLOAT_DECIMALS: usize = 4;

// ============================== 极简 JSON ==============================

#[derive(Debug, Clone)]
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn s(v: impl Into<String>) -> J {
        J::Str(v.into())
    }

    pub fn n(v: f64) -> J {
        if v.is_finite() {
            J::Num(v)
        } else {
            J::Null
        }
    }

    pub fn i(v: usize) -> J {
        J::Int(v as i64)
    }

    pub fn arr<T: Clone, F: Fn(&T) -> J>(items: &[T], f: F) -> J {
        J::Arr(items.iter().map(f).collect())
    }

    pub fn obj(entries: Vec<(&str, J)>) -> J {
        J::Obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, indent: usize) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Int(i) => out.push_str(&i.to_string()),
            J::Num(v) => {
                // `-0.0` 归一为 `0.0`：否则同一数值可能产出 `-0.0000` / `0.0000` 两种文本。
                let v = if *v == 0.0 { 0.0 } else { *v };
                out.push_str(&format!("{:.*}", FLOAT_DECIMALS, v));
            }
            J::Str(s) => {
                out.push('"');
                for c in s.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\t' => out.push_str("\\t"),
                        '\r' => out.push_str("\\r"),
                        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            J::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, it) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    push_indent(out, indent + 1);
                    it.write(out, indent + 1);
                }
                out.push('\n');
                push_indent(out, indent);
                out.push(']');
            }
            J::Obj(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    push_indent(out, indent + 1);
                    J::Str(k.clone()).write(out, indent + 1);
                    out.push_str(": ");
                    v.write(out, indent + 1);
                }
                out.push('\n');
                push_indent(out, indent);
                out.push('}');
            }
        }
    }
}

fn push_indent(out: &mut String, n: usize) {
    for _ in 0..n {
        out.push_str("  ");
    }
}

// ============================== provenance 与报告 ==============================

#[derive(Debug, Clone)]
pub struct Provenance {
    pub mode: String,
    pub source_commit: String,
    pub engine_version: String,
    pub model_version: u32,
    pub analyzer_version: String,
    /// 引擎源码文本指纹（见 [`engine_source_fingerprint`]）——与 `source_commit` 一起回答
    /// "这次运行跑的是哪份源码"，使"工作树脏但 commit 未变"这一类不可比性在产物层可见。
    pub engine_source_fingerprint: String,
    pub sidecar_schema_fingerprint: String,
    pub sidecar_closed_set_sizes: Vec<(&'static str, usize)>,
    pub seed_first: u64,
    pub seed_last: u64,
    pub config_duration_seconds: f64,
    /// 口径常量快照：让 reviewer 不必读源码就能核对判据来源。
    pub caliber: Vec<(&'static str, f64)>,
}

pub struct Report {
    pub provenance: Provenance,
    pub samples: SampleTotals,
    pub possession_shape: PossessionShape,
    pub transitions: ControlTransitions,
    pub restarts: RestartQuality,
    pub motifs: MotifReport,
    pub anomalies: Vec<Anomaly>,
    /// 每场的粗粒度计数（跨场原始计数，供报告的解释性表格使用）。
    pub pooled_start_reasons: BTreeMap<String, usize>,
    pub pooled_end_reasons: BTreeMap<String, usize>,
    pub pooled_event_types: BTreeMap<String, usize>,
    pub pooled_fact_kinds: BTreeMap<String, usize>,
}

pub fn build_provenance(
    mode: &str,
    seed_first: u64,
    seed_last: u64,
    duration: f64,
    model_version: u32,
) -> Provenance {
    let (fingerprint, sizes) = sidecar_schema_fingerprint();
    Provenance {
        mode: mode.to_string(),
        source_commit: std::env::var("P17A_SOURCE_COMMIT").unwrap_or_else(|_| "unknown".to_string()),
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        model_version,
        analyzer_version: ANALYZER_VERSION.to_string(),
        engine_source_fingerprint: engine_source_fingerprint(),
        sidecar_schema_fingerprint: fingerprint,
        sidecar_closed_set_sizes: sizes,
        seed_first,
        seed_last,
        config_duration_seconds: duration,
        // 只列**真正驱动被报告指标**的常量。2026-09-24 审阅发现原先把
        // `HOLD_MIN_TICKS`/`HOLD_MAX_TICKS`/`POSSESSION_HOLD_MIN/MAX` 当作 A1 的机制常量落盘，
        // 但它们在 P31 删槽位后**已无读取点**（`engine/src/lib.rs` 只剩声明）——把死常量写进
        // "口径快照"会让 reviewer 用错误的常量核对判据。此处改为列 P28/P31 的行动机会 deadline 族，
        // 它们才是持球-出球节奏的真实驱动（见 `anomalies.rs` A1 注释）。
        caliber: vec![
            ("tick_seconds", fm_engine::TICK_SECONDS),
            ("loose_max_ticks", fm_engine::LOOSE_MAX_TICKS as f64),
            ("transition_ticks", fm_engine::TRANSITION_TICKS as f64),
            ("intercept_d_tight_m", fm_engine::INTERCEPT_D_TIGHT_M),
            ("intercept_d_mid_m", fm_engine::INTERCEPT_D_MID_M),
            ("pitch_length_m", fm_engine::PITCH_LENGTH_M),
            ("pitch_width_m", fm_engine::PITCH_WIDTH_M),
        ],
    }
}

/// 逐场 pool 的计数（报告里作解释性表格用；**不**用于分位统计）。
pub fn pooled_counts<F: Fn(&MatchRecord) -> BTreeMap<String, usize>>(
    per_match: &[MatchRecord],
    f: F,
) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for m in per_match {
        for (k, v) in f(m) {
            *out.entry(k).or_insert(0) += v;
        }
    }
    out
}

// ============================== JSON ==============================

fn j_stat(s: &Stat) -> J {
    J::obj(vec![
        ("matches", J::i(s.matches)),
        ("observations", J::i(s.observations)),
        ("mean_of_means", J::n(s.mean_of_means)),
        ("p50_of_p50", J::n(s.p50_of_p50)),
        ("p90_of_p90", J::n(s.p90_of_p90)),
        ("max_of_max", J::n(s.max_of_max)),
        ("cross_match_mean_sd", J::n(s.cross_match_mean_sd)),
    ])
}

fn j_stat_map(m: &BTreeMap<String, Stat>) -> J {
    J::Obj(
        m.iter()
            .map(|(k, v)| (k.clone(), j_stat(v)))
            .collect(),
    )
}

fn j_counts(m: &BTreeMap<String, usize>) -> J {
    J::Obj(
        m.iter()
            .map(|(k, v)| (k.clone(), J::i(*v)))
            .collect(),
    )
}

fn j_evidence(e: &crate::motifs::EvidenceSample) -> J {
    J::obj(vec![
        ("seed", J::Int(e.seed as i64)),
        ("t_seconds", J::n(e.t)),
        (
            "episode_id",
            match e.episode_id {
                Some(v) => J::Int(v as i64),
                None => J::Null,
            },
        ),
        (
            "restart_id",
            match e.restart_id {
                Some(v) => J::Int(v as i64),
                None => J::Null,
            },
        ),
        ("event_indexes", J::arr(&e.event_indexes, |i| J::Int(*i as i64))),
        ("note", J::s(e.note.clone())),
    ])
}

fn j_anomaly(a: &Anomaly) -> J {
    J::obj(vec![
        ("id", J::s(a.id)),
        ("title", J::s(a.title.clone())),
        ("status", J::s(a.status.as_str())),
        ("severity", J::s(a.severity)),
        ("confidence", J::s(a.confidence)),
        ("value", J::n(a.value)),
        ("unit", J::s(a.unit)),
        ("baseline_expectation", J::s(a.baseline_expectation)),
        ("sample_size", J::i(a.sample_size)),
        ("min_sample_size", J::i(a.min_sample_size)),
        ("criterion", J::s(a.criterion.clone())),
        ("why_not_football", J::s(a.why_not_football)),
        ("mechanism_hypothesis", J::s(a.mechanism_hypothesis)),
        ("mechanism_area", J::s(a.mechanism_area)),
        ("missing_evidence", J::s(a.missing_evidence)),
        ("evidence", J::arr(&a.evidence, j_evidence)),
    ])
}

pub fn to_json(r: &Report) -> String {
    let p = &r.provenance;
    let prov = J::obj(vec![
        ("mode", J::s(p.mode.clone())),
        ("source_commit", J::s(p.source_commit.clone())),
        ("engine_version", J::s(p.engine_version.clone())),
        ("model_version", J::Int(p.model_version as i64)),
        ("analyzer_version", J::s(p.analyzer_version.clone())),
        (
            "engine_source_fingerprint",
            J::s(p.engine_source_fingerprint.clone()),
        ),
        (
            "sidecar_schema_fingerprint",
            J::s(p.sidecar_schema_fingerprint.clone()),
        ),
        (
            "sidecar_closed_set_sizes",
            J::Obj(
                p.sidecar_closed_set_sizes
                    .iter()
                    .map(|(k, v)| (k.to_string(), J::i(*v)))
                    .collect(),
            ),
        ),
        (
            "seed_range",
            J::obj(vec![
                ("first", J::Int(p.seed_first as i64)),
                ("last", J::Int(p.seed_last as i64)),
                ("count", J::Int((p.seed_last - p.seed_first + 1) as i64)),
            ]),
        ),
        (
            "config",
            J::obj(vec![
                ("match_duration_seconds", J::n(p.config_duration_seconds)),
                ("demo_mode", J::Bool(false)),
            ]),
        ),
        (
            "caliber_constants",
            J::Obj(
                p.caliber
                    .iter()
                    .map(|(k, v)| (k.to_string(), J::n(*v)))
                    .collect(),
            ),
        ),
    ]);

    let s = &r.samples;
    let samples = J::obj(vec![
        ("matches", J::i(s.matches)),
        ("events", J::i(s.events)),
        ("beats", J::i(s.beats)),
        ("control_facts", J::i(s.facts)),
        ("possession_episodes", J::i(s.episodes)),
        ("restart_sequences", J::i(s.restarts)),
        ("contests", J::i(s.contests)),
        ("decision_actions", J::i(s.actions)),
        ("observation_gaps", J::i(s.gaps)),
        ("invariant_violations", J::i(s.invariant_violations)),
        ("unclosed_episodes", J::i(s.unclosed_episodes)),
        ("matches_with_final_score", J::i(s.scores_present)),
    ]);

    let ps = &r.possession_shape;
    let possession = J::obj(vec![
        ("episodes_per_match", j_stat(&ps.episodes_per_match)),
        ("start_reason_counts", j_counts(&ps.start_reason_counts)),
        ("end_reason_counts", j_counts(&ps.end_reason_counts)),
        (
            "end_reason_given_start",
            J::Obj(
                ps.end_reason_given_start
                    .iter()
                    .map(|(k, v)| (k.clone(), j_counts(v)))
                    .collect(),
            ),
        ),
        ("duration_by_start_reason", j_stat_map(&ps.duration_by_start_reason)),
        ("duration_seconds", j_stat(&ps.duration_seconds)),
        ("action_count", j_stat(&ps.action_count)),
        ("pass_count", j_stat(&ps.pass_count)),
        ("action_gap_seconds", j_stat(&ps.action_gap_seconds)),
        ("possession_seconds_per_match", j_stat(&ps.possession_seconds_per_match)),
        (
            "pre_shot_successful_passes",
            j_stat(&ps.pre_shot_successful_passes),
        ),
        (
            "pre_shot_chain_actions",
            j_stat(&ps.pre_shot_chain_actions),
        ),
        (
            "beat_bindings_per_episode",
            j_stat(&ps.beat_bindings_per_episode),
        ),
    ]);

    let t = &r.transitions;
    let transitions = J::obj(vec![
        ("contests_per_match", j_stat(&t.contests_per_match)),
        ("duration_seconds", j_stat(&t.duration_seconds)),
        ("duration_value_counts", j_counts(&t.duration_value_counts)),
        (
            "duration_by_reason",
            j_stat_map(&t.duration_by_reason),
        ),
        ("duration_by_reason_pairs", j_counts(&t.duration_by_reason_pairs)),
        ("reason_counts", j_counts(&t.reason_counts)),
        ("end_reason_counts", j_counts(&t.end_reason_counts)),
        (
            "regain_by_loser",
            J::obj(vec![
                ("hits", J::i(t.regain_by_loser.hits)),
                ("denominator", J::i(t.regain_by_loser.denominator)),
                ("value", J::n(t.regain_by_loser.value)),
            ]),
        ),
        (
            "regain_by_reason",
            J::Obj(
                t.regain_by_reason
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            J::obj(vec![
                                ("hits", J::i(v.hits)),
                                ("denominator", J::i(v.denominator)),
                                ("value", J::n(v.value)),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
        (
            "next_controller_by_reason",
            J::Obj(
                t.next_controller_by_reason
                    .iter()
                    .map(|(k, v)| (k.clone(), j_counts(v)))
                    .collect(),
            ),
        ),
        (
            "first_actions_after_transition",
            j_counts(&t.first_actions_after_transition),
        ),
        (
            "transitions_without_next_episode",
            J::i(t.transitions_without_next_episode),
        ),
    ]);

    let q = &r.restarts;
    let restarts = J::obj(vec![
        ("restarts_per_match", j_stat(&q.restarts_per_match)),
        ("kind_counts", j_counts(&q.kind_counts)),
        ("end_reason_counts", j_counts(&q.end_reason_counts)),
        ("prep_seconds_by_kind", j_stat_map(&q.prep_seconds_by_kind)),
        ("flight_seconds_by_kind", j_stat_map(&q.flight_seconds_by_kind)),
        (
            "first_control_delay_by_kind",
            j_stat_map(&q.first_control_delay_by_kind),
        ),
        (
            "first_possession_duration_by_kind",
            j_stat_map(&q.first_possession_duration_by_kind),
        ),
        (
            "first_possession_actions_by_kind",
            j_stat_map(&q.first_possession_actions_by_kind),
        ),
        (
            "first_possession_end_reasons",
            j_counts(&q.first_possession_end_reasons),
        ),
        (
            "first_possession_start_reasons",
            j_counts(&q.first_possession_start_reasons),
        ),
        (
            "immediate_loss",
            J::obj(vec![
                ("hits", J::i(q.immediate_loss.hits)),
                ("denominator", J::i(q.immediate_loss.denominator)),
                ("value", J::n(q.immediate_loss.value)),
            ]),
        ),
        (
            "restarts_without_first_possession",
            J::i(q.restarts_without_first_possession),
        ),
    ]);

    let m = &r.motifs;
    let motifs = J::obj(vec![
        (
            "named",
            J::Arr(
                m.named
                    .iter()
                    .map(|h| {
                        J::obj(vec![
                            ("name", J::s(h.name)),
                            ("hits", J::i(h.hits)),
                            ("denominator", J::i(h.denominator)),
                            ("denominator_name", J::s(h.denominator_name)),
                            ("rate", J::n(h.rate)),
                            (
                                "consequence_end_reasons",
                                j_counts(&h.consequence_end_reasons),
                            ),
                            ("samples", J::arr(&h.samples, j_evidence)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "ngrams",
            J::Arr(
                m.ngrams
                    .iter()
                    .map(|g| {
                        J::obj(vec![
                            ("ngram", J::s(g.ngram.clone())),
                            ("n", J::i(g.n)),
                            ("count", J::i(g.count)),
                            ("episodes_hitting", J::i(g.episodes_hitting)),
                            ("top_end_reason", J::s(g.top_end_reason.clone())),
                            ("samples", J::arr(&g.samples, j_evidence)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("ngram_totals", j_counts(&m.ngram_totals)),
    ]);

    let root = J::obj(vec![
        ("schema", J::s(SCHEMA_TAG)),
        ("provenance", prov),
        ("samples", samples),
        ("pooled_event_types", j_counts(&r.pooled_event_types)),
        ("pooled_fact_kinds", j_counts(&r.pooled_fact_kinds)),
        (
            "metrics",
            J::obj(vec![
                ("possession_shape", possession),
                ("control_transitions", transitions),
                ("restart_quality", restarts),
                ("motifs", motifs),
            ]),
        ),
        ("anomalies", J::arr(&r.anomalies, j_anomaly)),
    ]);
    let mut out = root.render();
    out.push('\n');
    out
}

// ============================== Markdown ==============================

fn md_stat_row(label: &str, s: &Stat) -> String {
    format!(
        "| {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} |\n",
        label, s.observations, s.mean_of_means, s.p50_of_p50, s.p90_of_p90, s.max_of_max, s.cross_match_mean_sd
    )
}

const STAT_HEADER: &str = "| 指标 | 观测数 | 均值(场均为单位) | P50 | P90 | 最大 | 场间 sd |\n|---|---:|---:|---:|---:|---:|---:|\n";

pub fn to_markdown(r: &Report) -> String {
    let p = &r.provenance;
    let mut o = String::new();
    o.push_str(&format!("# P17A 行为链基线报告（{}）\n\n", p.mode));
    o.push_str("> 本文件由分析器生成，可重复运行；口径与判据见 OpenSpec change \
                `p17a-behavior-chain-baseline-analysis` 的 design.md §3。\n\
                分位/离散度指标一律**先在单场内计算再跨场聚合**（场间 sd 与场内方差不是同一口径）。\n\n");

    o.push_str("## 0. provenance（口径）\n\n");
    o.push_str("| 项 | 值 |\n|---|---|\n");
    o.push_str(&format!("| mode | {} |\n", p.mode));
    o.push_str(&format!("| source commit | `{}` |\n", p.source_commit));
    o.push_str(&format!("| engine crate | {} |\n", p.engine_version));
    o.push_str(&format!("| MODEL_VERSION | {} |\n", p.model_version));
    o.push_str(&format!("| analyzer | {} |\n", p.analyzer_version));
    o.push_str(&format!(
        "| 引擎源码指纹 | `{}` |\n",
        p.engine_source_fingerprint
    ));
    o.push_str(&format!(
        "| sidecar schema 指纹 | `{}` |\n",
        p.sidecar_schema_fingerprint
    ));
    o.push_str(&format!(
        "| seed 区间 | {}..={}（{} 场） |\n",
        p.seed_first,
        p.seed_last,
        p.seed_last - p.seed_first + 1
    ));
    o.push_str(&format!(
        "| match_duration_seconds | {} |\n",
        p.config_duration_seconds
    ));
    o.push_str(&format!(
        "| 口径常量 | {} |\n\n",
        p.caliber
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    let s = &r.samples;
    o.push_str("## 1. 样本量\n\n");
    o.push_str("| 项 | 值 |\n|---|---:|\n");
    for (k, v) in [
        ("matches", s.matches),
        ("events", s.events),
        ("beats", s.beats),
        ("decision actions", s.actions),
        ("control_facts", s.facts),
        ("possession_episodes", s.episodes),
        ("restart_sequences", s.restarts),
        ("contests", s.contests),
        ("observation_gaps", s.gaps),
        ("invariant_violations", s.invariant_violations),
        ("unclosed_episodes", s.unclosed_episodes),
    ] {
        o.push_str(&format!("| {} | {} |\n", k, v));
    }
    o.push('\n');
    o.push_str(&format!(
        "事件类型计数（pooled）：{}\n\n",
        fmt_counts(&r.pooled_event_types)
    ));
    o.push_str(&format!(
        "控制事实计数（pooled）：{}\n\n",
        fmt_counts(&r.pooled_fact_kinds)
    ));

    let ps = &r.possession_shape;
    o.push_str("## 2. M1 possession 形状\n\n");
    o.push_str(&format!("- episode/场：{:.2}\n", ps.episodes_per_match.mean_of_means));
    o.push_str(&format!(
        "- 单场 possession 总时长：{:.1} s（占比赛时长 {} s 的 {:.1}%）\n",
        ps.possession_seconds_per_match.mean_of_means,
        p.config_duration_seconds,
        100.0 * ps.possession_seconds_per_match.mean_of_means / p.config_duration_seconds
    ));
    o.push_str(&format!(
        "- 开始原因分布：{}\n",
        fmt_counts(&ps.start_reason_counts)
    ));
    o.push_str(&format!(
        "- 结束原因分布：{}\n\n",
        fmt_counts(&ps.end_reason_counts)
    ));
    o.push_str("### 2.1 按开始原因条件分解的结束分布\n\n");
    o.push_str("| start_reason | end_reason | 次数 | 占该 start 的比例 |\n|---|---|---:|---:|\n");
    for (start, row) in &ps.end_reason_given_start {
        let tot: usize = row.values().sum();
        for (end, n) in row {
            o.push_str(&format!(
                "| {} | {} | {} | {:.1}% |\n",
                start,
                end,
                n,
                if tot > 0 { 100.0 * *n as f64 / tot as f64 } else { 0.0 }
            ));
        }
    }
    o.push('\n');
    o.push_str("### 2.2 时长 / 动作数 / 节奏\n\n");
    o.push_str(STAT_HEADER);
    o.push_str(&md_stat_row("episode 时长 (s)", &ps.duration_seconds));
    o.push_str(&md_stat_row("episode 动作数", &ps.action_count));
    o.push_str(&md_stat_row("episode 传球数", &ps.pass_count));
    o.push_str(&md_stat_row("相邻动作间隔 (s)", &ps.action_gap_seconds));
    o.push_str(&md_stat_row("射门前成功传球数", &ps.pre_shot_successful_passes));
    o.push_str(&md_stat_row("射门在链中序号", &ps.pre_shot_chain_actions));
    o.push_str(&md_stat_row("归属 beat 数/episode", &ps.beat_bindings_per_episode));
    o.push('\n');
    o.push_str("各开始原因的 episode 时长：\n\n");
    o.push_str(STAT_HEADER);
    for (k, v) in &ps.duration_by_start_reason {
        o.push_str(&md_stat_row(k, v));
    }
    o.push('\n');

    let t = &r.transitions;
    o.push_str("## 3. M2 控制权转换\n\n");
    o.push_str(&format!("- 争抢/场：{:.2}\n", t.contests_per_match.mean_of_means));
    o.push_str(&format!(
        "- 争抢原因：{}\n",
        fmt_counts(&t.reason_counts)
    ));
    o.push_str(&format!(
        "- 争抢结束原因：{}\n",
        fmt_counts(&t.end_reason_counts)
    ));
    o.push_str(&format!(
        "- 争抢时长取值分布（值 → 次数）：{}\n",
        fmt_counts(&t.duration_value_counts)
    ));
    o.push_str(&format!(
        "- 丢球方夺回率：{:.1}%（{} / {}）\n",
        100.0 * t.regain_by_loser.value,
        t.regain_by_loser.hits,
        t.regain_by_loser.denominator
    ));
    o.push_str(&format!(
        "- 无后继 episode 的转换：{}\n\n",
        t.transitions_without_next_episode
    ));
    o.push_str(STAT_HEADER);
    o.push_str(&md_stat_row("争抢时长 (s)", &t.duration_seconds));
    o.push('\n');
    o.push_str("各争抢原因的时长：\n\n");
    o.push_str(STAT_HEADER);
    for (k, v) in &t.duration_by_reason {
        o.push_str(&md_stat_row(k, v));
    }
    o.push('\n');
    o.push_str("(原因, 时长) 联合计数（把「哪个原因对应哪个时长」钉在一起）：\n\n");
    o.push_str(&format!("{}\n\n", fmt_counts(&t.duration_by_reason_pairs)));
    o.push_str("| 争抢原因 | 夺回数 / 分母 | 夺回率 |\n|---|---:|---:|\n");
    for (k, v) in &t.regain_by_reason {
        o.push_str(&format!(
            "| {} | {} / {} | {:.1}% |\n",
            k,
            v.hits,
            v.denominator,
            100.0 * v.value
        ));
    }
    o.push('\n');
    o.push_str("| 争抢原因 | 下一控制方（same=原控球队 / opponent=对手 / unknown） |\n|---|---|\n");
    for (k, v) in &t.next_controller_by_reason {
        o.push_str(&format!("| {} | {} |\n", k, fmt_counts(v)));
    }
    o.push('\n');
    o.push_str("转换后前 1–3 个开放动作序列频次：\n\n");
    o.push_str("| 序列 | 次数 |\n|---|---:|\n");
    for (k, v) in &t.first_actions_after_transition {
        o.push_str(&format!("| {} | {} |\n", k, v));
    }
    o.push('\n');

    let q = &r.restarts;
    o.push_str("## 4. M3 重开质量\n\n");
    o.push_str(&format!("- 重开/场：{:.2}\n", q.restarts_per_match.mean_of_means));
    o.push_str(&format!("- 重开方式：{}\n", fmt_counts(&q.kind_counts)));
    o.push_str(&format!("- 重开结束原因：{}\n", fmt_counts(&q.end_reason_counts)));
    o.push_str(&format!(
        "- 首个 possession 结束原因：{}\n",
        fmt_counts(&q.first_possession_end_reasons)
    ));
    o.push_str(&format!(
        "- 首个 possession 开始原因：{}\n",
        fmt_counts(&q.first_possession_start_reasons)
    ));
    o.push_str(&format!(
        "- 重开后立即丢失：{:.1}%（{} / {}）\n",
        100.0 * q.immediate_loss.value,
        q.immediate_loss.hits,
        q.immediate_loss.denominator
    ));
    o.push_str(&format!(
        "- 未找到首个 possession 的重开数：{}\n\n",
        q.restarts_without_first_possession
    ));
    for (title, m) in [
        ("准备期：死球→发出 (s)", &q.prep_seconds_by_kind),
        ("交付飞行：发出→恢复开放 (s)", &q.flight_seconds_by_kind),
        ("重开→首次明确控制 (s)", &q.first_control_delay_by_kind),
        ("首个 possession 时长 (s)", &q.first_possession_duration_by_kind),
        ("首个 possession 动作数", &q.first_possession_actions_by_kind),
    ] {
        o.push_str(&format!("### {}\n\n", title));
        o.push_str(STAT_HEADER);
        for (k, v) in m {
            o.push_str(&md_stat_row(k, v));
        }
        o.push('\n');
    }
    o.push_str(
        "> **口径提示（已知冗余，不要读成两个独立证据）**：「交付飞行」与「重开→首次明确控制」\
         在本引擎上**恒等**——重开的首个 episode 恰好在 `open_play_resumed` 时刻开启，\
         故两列数值相同。守卫见 `first_control_delay_equals_delivery_flight_on_real_path`。\n\n",
    );

    let mo = &r.motifs;
    o.push_str("## 5. M4 动作链 motif\n\n");
    o.push_str("| motif | 命中 / 分母 | 比例 | 分母口径 |\n|---|---:|---:|---|\n");
    for h in &mo.named {
        o.push_str(&format!(
            "| `{}` | {} / {} | {:.1}% | {} |\n",
            h.name,
            h.hits,
            h.denominator,
            100.0 * h.rate,
            h.denominator_name
        ));
    }
    o.push('\n');
    for h in &mo.named {
        o.push_str(&format!(
            "### 5.x `{}` 的后果分布\n\n",
            h.name
        ));
        o.push_str(&format!("{}\n\n", fmt_counts(&h.consequence_end_reasons)));
        if !h.samples.is_empty() {
            o.push_str("回放定位样本：\n\n");
            for s in &h.samples {
                o.push_str(&format!("- {}\n", fmt_evidence(s)));
            }
            o.push('\n');
        }
    }
    o.push_str(&format!(
        "n-gram 总计数：{}\n\n",
        fmt_counts(&mo.ngram_totals)
    ));
    o.push_str("最高频 n-gram（n=2..4 各前 15）：\n\n");
    o.push_str("| n | n-gram | 次数 | 命中 episode 数 | 最常见后果 | 样本 |\n|---:|---|---:|---:|---|---|\n");
    for g in &mo.ngrams {
        let sample = g
            .samples
            .first()
            .map(|s| format!("seed {} @ {:.0}s ep {}", s.seed, s.t, s.episode_id.unwrap_or(0)))
            .unwrap_or_else(|| "-".to_string());
        o.push_str(&format!(
            "| {} | `{}` | {} | {} | {} | {} |\n",
            g.n, g.ngram, g.count, g.episodes_hitting, g.top_end_reason, sample
        ));
    }
    o.push('\n');

    o.push_str("## 6. 异常候选\n\n");
    o.push_str("> 本节条目是**待验证的假设**（见 §7 第一条）：诊断阈值之上的现象 + 可回放证据，\n\
                > 不等于已确认与真实足球不符。确认需要 #15B / #16 与真实比赛数据。\n\n");
    let fired: Vec<&Anomaly> = r
        .anomalies
        .iter()
        .filter(|a| a.status == crate::anomalies::Status::Anomaly)
        .collect();
    o.push_str(&format!("越过内部诊断阈值的有 {} 条：\n\n", fired.len()));
    for a in &fired {
        o.push_str(&format!(
            "### {} {}（{}）\n\n",
            a.id, a.title, a.severity
        ));
        o.push_str("| 项 | 值 |\n|---|---|\n");
        o.push_str(&format!("| 观测值 | {:.4} {} |\n", a.value, a.unit));
        o.push_str(&format!("| 基线期望 | {} |\n", a.baseline_expectation));
        o.push_str(&format!(
            "| 样本量 | {}（下限 {}） |\n",
            a.sample_size, a.min_sample_size
        ));
        o.push_str(&format!("| 判据 | {} |\n", a.criterion));
        o.push_str(&format!("| 置信度 | {} |\n", a.confidence));
        o.push_str(&format!("| 为什么不像足球 | {} |\n", a.why_not_football));
        o.push_str(&format!("| 机制假设 | {} |\n", a.mechanism_hypothesis));
        o.push_str(&format!("| 代码区域 | `{}` |\n", a.mechanism_area));
        o.push_str(&format!("| 缺失证据 | {} |\n\n", a.missing_evidence));
        o.push_str("回放定位：\n\n");
        for s in &a.evidence {
            o.push_str(&format!("- {}\n", fmt_evidence(s)));
        }
        o.push('\n');
    }

    let not_fired: Vec<&Anomaly> = r
        .anomalies
        .iter()
        .filter(|a| a.status != crate::anomalies::Status::Anomaly)
        .collect();
    if !not_fired.is_empty() {
        o.push_str("### 已检查但未触发\n\n");
        o.push_str("| id | 标题 | 状态 | 观测值 | 样本量 |\n|---|---|---|---:|---:|\n");
        for a in not_fired {
            o.push_str(&format!(
                "| {} | {} | {} | {:.4} {} | {} |\n",
                a.id,
                a.title,
                a.status.as_str(),
                a.value,
                a.unit,
                a.sample_size
            ));
        }
        o.push('\n');
    }

    o.push_str("## 7. 局限\n\n");
    // 阈值示例由常量插值（`{:.1}` / `{:.2}` 取自 anomalies 的常量），不写死数字——
    // 否则改了阈值这里就漂（与 A7 正文写死角球准备期同类问题，2026-09-24 审阅）。
    o.push_str(&format!(
        "- **本轮没有使用任何真实比赛数据集**：各规则的 `baseline_expectation` 前缀为\n  \
         `{}`，是**领域假设**（来自足球常识与设计文档的定性印象），不是从真实数据测得的\n  \
         参照值。规则阈值（如相邻动作间隔 > {:.1}s、多脚传递占比 < {:.2}）是**内部诊断阈值**，\n  \
         用于在同一个固定的 seed 集上做前后对比，**不得**读作「与真实足球的偏差量」。\n  \
         把期望值标定成可引用的参照值需要真实比赛数据，**不在本 change 范围内**。\n",
        crate::anomalies::UNCALIBRATED_TAG,
        crate::anomalies::DWELL_ANOMALY_SECONDS,
        crate::anomalies::MULTI_PASS_SHARE_MIN
    ));
    o.push_str("- 因此「异常」一词在本报告中是**待验证的假设**：它表示某个统计量在诊断阈值之外、\n  \
                且证据可回放，**不表示**已经证明该行为与真实足球不符。定性与定量的确认要等\n  \
                #15B（phase）/ #16（空间）与真实比赛数据到位。\n");
    o.push_str("- 诊断层只用到 #15A sidecar 已有字段；**没有** phase（#15B）与 22 人空间特征（#16），\n  \
                因此所有「为什么」都只能给机制假设，不能给因果结论。\n");
    o.push_str("- 事件流不含 `dribble` / `interception` / `off_ball_run` 顶层事件：拦截编码在\n  \
                `pass.result` 里，带球只存在于 `beat.main`。动作链因此只覆盖**决策事件**，\n  \
                带球推进的位移不产生动作步。\n");
    o.push_str("- **事件下标可能跨 episode 重复**：sidecar 的 `event_indexes` 绑定在 episode 交接\n  \
                处可能把同一条事件同时归给旧、新两个 episode（实测 seed 1 事件 2240、seed 4 事件 1732）。\n  \
                因此「episode 动作数」之和**不严格等于**决策事件总数（A5 的分母口径见 §3.3）。\n  \
                这是 #15A 绑定层的行为，本 change 不改；报告不把它当作可加总的分区。\n");
    o.push_str("- 时间取自 `ObservedTime.value`（`state_commit` / `event_emit` 混用之处已在\n  \
                指标定义中说明）；本引擎无中场休息。\n");
    o.push_str("- 本 change 不改生成逻辑；异常候选清单是 #19 的输入，不是参数调整的依据。\n");
    o
}

fn fmt_counts<K: std::fmt::Display>(m: &BTreeMap<K, usize>) -> String {
    if m.is_empty() {
        return "-".to_string();
    }
    m.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(", ")
}

fn fmt_evidence(s: &crate::motifs::EvidenceSample) -> String {
    format!(
        "seed {} @ {:.0}s{} 事件 {:?} — {}",
        s.seed,
        s.t,
        match (s.episode_id, s.restart_id) {
            (Some(e), Some(r)) => format!(" / episode {} / restart {}", e, r),
            (Some(e), None) => format!(" / episode {}", e),
            (None, Some(r)) => format!(" / restart {}", r),
            (None, None) => String::new(),
        },
        s.event_indexes,
        s.note
    )
}
