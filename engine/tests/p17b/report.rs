//! P17B Slice 3：产物（JSON + Markdown）+ provenance + L2 聚合。
//!
//! ## 两条硬约束（同 P17A / P16 的产物纪律）
//!
//! 1. **确定性**：全部容器是 `BTreeMap` / `Vec`（有序），浮点按定点小数格式化，
//!    **不写入时间戳**。同输入两次运行产出的 JSON 逐字节相同。
//! 2. **口径随产物**：provenance 记录源码 commit、引擎源码指纹、**测试源码指纹**、
//!    sidecar schema 指纹、口径版本与**口径常量快照**（含接应阈值——它是从 `p16`
//!    活读来的，故「p16 改了阈值」这件事在产物层可见）。
//!
//! ## 为什么自带一份极简 JSON 写手
//!
//! 本仓既有做法：每个 change 的 `report.rs` 自带 `J`
//! （`tests/p16/report.rs`、`tests/p124/report.rs` 各一份）。理由不是「不想复用」，
//! 而是**产物格式是各 change 自己的契约**——共用一份会让任一 change 的格式改动
//! 静默改变另两个的产物。**复用**的是 `p17a/model.rs` 的 `sidecar_schema_fingerprint`
//! 与 `fnv1a`（那是**口径定义**，必须唯一），见 [`crate::model`]。
//!
//! ## ⚠️ 本文件被措辞守卫**排除**在扫描范围之外（design §4.1）
//!
//! 理由：本文件经 [`crate::model`] 的 `sidecar_schema_fingerprint` **正确地**触及
//! `Phase` 闭集——sidecar 的 schema 指纹**必须**包含它，否则指纹就没在守护闭集完整性。
//! 扫描范围是 `tests/p17b/{evidence,episode,reasons}.rs` 三个**报告逻辑**文件。

use crate::evidence::{
    CALIBER_VERSION, Locus, SCHEMA_TAG, ANALYZER_VERSION, EVIDENCE_TABLE, STRUCTURAL_UNAVAILABLE,
};
use crate::episode::{EpisodeCard, MatchCards, PursuitView};
use crate::model::{fnv1a, sidecar_schema_fingerprint};
use crate::episode::COVERAGE_CLAIMS;
use crate::reasons::{ANOMALY_COVERAGE, CONTEST_COVERAGE, WORDING_RULES};
use fm_engine::MODEL_VERSION;
use std::collections::BTreeMap;

// ============================== provenance ==============================

/// 引擎源码指纹覆盖的源文件（**顺序即哈希输入顺序**）。
/// 判据：**凡是能改变 `simulate_with_behavior_observations` 输出的 `engine/src/` 源码**。
pub const ENGINE_SOURCES: &[(&str, &str)] = &[
    ("lib.rs", include_str!("../../src/lib.rs")),
    ("observation.rs", include_str!("../../src/observation.rs")),
    ("rng.rs", include_str!("../../src/rng.rs")),
];

/// 本 change 自己的测试源码清单（哈希输入顺序即此顺序）。
pub const TEST_SOURCES: &[(&str, &str)] = &[
    ("p17b_diagnosis_report.rs", include_str!("../p17b_diagnosis_report.rs")),
    ("p17b/evidence.rs", include_str!("evidence.rs")),
    ("p17b/episode.rs", include_str!("episode.rs")),
    ("p17b/reasons.rs", include_str!("reasons.rs")),
    ("p17b/report.rs", include_str!("report.rs")),
];

fn fingerprint_of(sources: &[(&str, &str)]) -> String {
    let mut combined = String::new();
    for (name, text) in sources {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(text);
        combined.push('\n');
    }
    format!("fnv1a64:{:016x}", fnv1a(&combined))
}

/// **引擎源码文本指纹**：哈希被编译进本次测试二进制的引擎源码文本。
///
/// 为什么不是只记 `git rev-parse HEAD`：`P17B_SOURCE_COMMIT` 读的是**提交**，不是**工作树**。
/// 一旦有人在未提交状态下改了引擎（本仓实测发生过），commit 不变而输出全变，产物层无法分辨。
pub fn engine_source_fingerprint() -> String {
    fingerprint_of(ENGINE_SOURCES)
}

/// **测试源码指纹**：补 `engine_source_fingerprint` 的盲区（后者只哈希 `engine/src/*`，
/// 而本 change 的全部判据都在 `tests/p17b/*`）。
pub fn test_source_fingerprint() -> String {
    fingerprint_of(TEST_SOURCES)
}

#[derive(Debug, Clone)]
pub struct Provenance {
    pub mode: String,
    pub source_commit: String,
    pub engine_version: String,
    pub model_version: u32,
    pub analyzer_version: String,
    pub caliber_version: String,
    pub schema_tag: String,
    pub engine_source_fingerprint: String,
    pub test_source_fingerprint: String,
    /// P17A 的指纹（闭集枚举哈希）。**列出只为交叉引用**——它对结构体字段是盲区，
    /// 且它**正确地**包含 `Phase` 闭集（那是 sidecar 的公开闭集，不是本 change 的能力声明）。
    pub sidecar_schema_fingerprint: String,
    pub sidecar_closed_set_sizes: Vec<(&'static str, usize)>,
    pub seed_first: u64,
    pub seed_last: u64,
    pub config_duration_seconds: f64,
    /// 口径常量快照（让 reviewer 不必读源码就能核对判据来源）。
    pub caliber: Vec<(&'static str, f64)>,
}

pub fn build_provenance(mode: &str, first: u64, last: u64, duration: f64) -> Provenance {
    let (fingerprint, sizes) = sidecar_schema_fingerprint();
    Provenance {
        mode: mode.to_string(),
        source_commit: std::env::var("P17B_SOURCE_COMMIT").unwrap_or_else(|_| "unknown".to_string()),
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        model_version: MODEL_VERSION,
        analyzer_version: ANALYZER_VERSION.to_string(),
        caliber_version: CALIBER_VERSION.to_string(),
        schema_tag: SCHEMA_TAG.to_string(),
        engine_source_fingerprint: engine_source_fingerprint(),
        test_source_fingerprint: test_source_fingerprint(),
        sidecar_schema_fingerprint: fingerprint,
        sidecar_closed_set_sizes: sizes,
        seed_first: first,
        seed_last: last,
        config_duration_seconds: duration,
        caliber: vec![
            ("tick_seconds", fm_engine::TICK_SECONDS),
            ("tail_ticks", crate::evidence::TAIL_TICKS as f64),
            (
                "support_max_dist_m",
                crate::features::SUPPORT_MAX_DIST_M,
            ),
            (
                "support_min_forward_m",
                crate::features::SUPPORT_MIN_FORWARD_M,
            ),
            ("pitch_length_m", fm_engine::PITCH_LENGTH_M),
            ("pitch_width_m", fm_engine::PITCH_WIDTH_M),
            (
                "exc_long_dwell_seconds",
                crate::episode::EXC_LONG_DWELL_SECONDS,
            ),
            (
                "exc_empty_possession_seconds",
                crate::episode::EXC_EMPTY_POSSESSION_SECONDS,
            ),
        ],
    }
}

// ============================== 极简 JSON ==============================

#[derive(Debug, Clone)]
pub enum J {
    Null,
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

    pub fn b(v: bool) -> J {
        if v {
            J::Int(1)
        } else {
            J::Int(0)
        }
    }

    pub fn obj(entries: Vec<(&str, J)>) -> J {
        J::Obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn opt_num(v: Option<f64>) -> J {
        match v {
            Some(x) => J::n(x),
            None => J::Null,
        }
    }

    pub fn opt_str(v: Option<&str>) -> J {
        match v {
            Some(x) => J::s(x),
            None => J::Null,
        }
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, indent: usize) {
        match self {
            J::Null => out.push_str("null"),
            J::Int(i) => out.push_str(&i.to_string()),
            J::Num(v) => {
                // `-0.0` 归一为 `0.0`：否则同一数值可能产出 `-0.0000` / `0.0000` 两种文本。
                let v = if *v == 0.0 { 0.0 } else { *v };
                out.push_str(&format!("{:.4}", v));
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

// ============================== L2 聚合（**刻意最小**） ==============================

/// 某结束原因的分组计数与均值。
#[derive(Debug, Clone, Default)]
pub struct EndReasonGroup {
    pub cards: usize,
    pub duration_sum: f64,
    pub duration_n: usize,
    pub chain_sum: f64,
    pub chain_n: usize,
}

/// 某争抢成因的分组：**含「可见 / 不可见」的分子分母**。
///
/// ⚠️ 这是本 change 的**立身数据**：若只报「该成因下有多少张卡」而不报
/// 「其中多少张看不到追逐」，读者会把「无 loose beat」读成「没发生」。
#[derive(Debug, Clone, Default)]
pub struct ContestGroup {
    pub cards: usize,
    pub pursuit_visible: usize,
    pub pursuit_invisible: usize,
}

/// 按异常类别的计数（供 #19 挑靶点）。
#[derive(Debug, Clone, Default)]
pub struct ExceptionGroup {
    pub cards: usize,
    /// 该类里**观察不可信**的卡数。
    pub incoherent: usize,
    /// 该类里**进了 L1** 的卡数（baseline 为类内分位尾部；canary 等于 `cards`）。
    pub kept: usize,
}

/// L2 聚合视图。
///
/// ## ⚠️ 刻意最小（用户拍板）
///
/// 用户明确要求缩减 L2：本 change 的价值集中在**逐 episode 诊断卡 + 前后对比能力**。
/// 故 L2 只保留**最小可用的分组计数**——三个维度、每个维度只给计数与均值，
/// **不做**分布 / 分位 / 交叉表 / 排序榜。多一个维度就多一份被误读成结论的风险，
/// 而本 change **不产生 pass/fail**（那是 #18 的事）。
#[derive(Debug, Clone, Default)]
pub struct Aggregates {
    pub cards: usize,
    pub incoherent_cards: usize,
    pub cards_with_end_t: usize,
    pub by_end_reason: BTreeMap<String, EndReasonGroup>,
    pub by_contest_start: BTreeMap<String, ContestGroup>,
    pub by_exception: BTreeMap<String, ExceptionGroup>,
    /// 与 `observe` 同序的「(命中的异常类, 是否可信)」——供第二趟按收录结果补 `kept`。
    /// **不进产物**（内部簿记）。
    pub exc_index: Vec<(Vec<&'static str>, bool)>,
}

impl Aggregates {
    /// 累积一张卡。
    ///
    /// **观察不可信门**（design §3.0）：`coherent == false` 的卡的诊断**不进**
    /// `by_end_reason` / `by_contest_start` 的分子分母（观察不可信时诊断无意义），
    /// 但仍计入 `by_exception` 的 `incoherent` 栏——**标注但保留**（不排除、不硬拒）。
    pub fn observe(&mut self, card: &EpisodeCard, exc: &[&'static str]) {
        self.cards += 1;
        let coherent = card.coherent;
        if !coherent {
            self.incoherent_cards += 1;
        }
        if let Some(end) = card.end_t {
            self.cards_with_end_t += 1;
            if coherent {
                let g = self
                    .by_end_reason
                    .entry(
                        card.end_reason
                            .map(|r| r.as_str())
                            .unwrap_or("<open>")
                            .to_string(),
                    )
                    .or_default();
                g.cards += 1;
                g.duration_sum += end - card.start_t;
                g.duration_n += 1;
                g.chain_sum += card.chain.len() as f64;
                g.chain_n += 1;
            }
        }
        if coherent {
            if let Some(r) = card.contest_start {
                let g = self
                    .by_contest_start
                    .entry(r.as_str().to_string())
                    .or_default();
                g.cards += 1;
                match &card.pursuit {
                    PursuitView::Visible { .. } => g.pursuit_visible += 1,
                    PursuitView::Invisible { .. } => g.pursuit_invisible += 1,
                    PursuitView::NotApplicable => {}
                }
            }
        }
        for k in exc {
            let g = self.by_exception.entry(k.to_string()).or_default();
            g.cards += 1;
            if !coherent {
                g.incoherent += 1;
            }
        }
        self.exc_index.push((exc.to_vec(), coherent));
    }
}

// ============================== 报告 ==============================

pub struct Report {
    pub provenance: Provenance,
    /// L1：逐 episode 诊断卡（canary = 全覆盖；baseline = 按异常筛选）。
    pub cards: Vec<EpisodeCard>,
    /// 本模式下**未收录**的卡数（canary 恒 0；baseline 是筛选掉的部分）。
    /// 显式记录，避免「筛选过的产物」被读成「全部」。
    pub cards_omitted: usize,
    pub aggregates: Aggregates,
    /// 逐场的松散球段 / 追球者计数（跨场合并）。
    pub mover_counts: BTreeMap<&'static str, usize>,
}

// ============================== 构造 ==============================

/// 从逐场卡片构造报告。
///
/// `keep` 决定哪些卡进 L1（canary 传「全收」，baseline 传「按异常筛选」）。
pub fn build_report(
    mode: &str,
    first: u64,
    last: u64,
    duration: f64,
    per_match: &[(u64, MatchCards)],
) -> Report {
    let mut prov = build_provenance(mode, first, last, duration);
    // `cards_omitted` 是筛选的结果，先算再定 provenance 之外的字段顺序无关。
    let mut cards: Vec<EpisodeCard> = Vec::new();
    let mut omitted = 0usize;
    let mut aggregates = Aggregates::default();
    let mut mover_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    // ── 第一趟：分类 + 聚合 + 收集每一类的驱动量（筛选是**类内分位**，须先看全量）──
    let mut exc_of: Vec<(usize, Vec<&'static str>)> = Vec::new();
    let mut drivers: BTreeMap<&'static str, Vec<f64>> = BTreeMap::new();
    let mut flat: Vec<&EpisodeCard> = Vec::new();
    for (_seed, mc) in per_match {
        crate::episode::merge_counts(&mut mover_counts, mc);
        for card in &mc.cards {
            let exc = crate::episode::classify(card);
            aggregates.observe(card, &exc);
            let i = flat.len();
            for cls in &exc {
                if let Some(d) = crate::episode::exception_driver(cls, card) {
                    drivers.entry(cls).or_default().push(d);
                }
            }
            exc_of.push((i, exc));
            flat.push(card);
        }
    }
    // 每类的保留门槛：样本 < `EXC_TAIL_MIN_CLASS` 的类**整类保留**（免把稀有形态藏起来）；
    // 其余取 p90（类内尾部）。
    let mut thresholds: BTreeMap<&'static str, f64> = BTreeMap::new();
    for (cls, mut vals) in drivers {
        if vals.len() < crate::episode::EXC_TAIL_MIN_CLASS {
            continue; // 小类：不放门槛 ⇒ 整类保留（`should_keep` 只看是否命中）
        }
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if let Some(t) = crate::shape::quantile_sorted(&vals, crate::episode::EXC_TAIL_QUANTILE) {
            thresholds.insert(cls, t);
        }
    }
    // ── 第二趟：按「命中 + 过门槛」决定收录 ──
    for (i, exc) in &exc_of {
        let card = flat[*i];
        let passes = exc.iter().any(|cls| match thresholds.get(cls) {
            None => true, // 该类的驱动量不在分位表里（无驱动量或样本小）⇒ 命中即保留
            Some(t) => crate::episode::exception_driver(cls, card)
                .map(|d| d >= *t)
                .unwrap_or(true),
        });
        // ⚠️ 类内分位**只作用于 baseline**：canary 是**全覆盖**（人眼核对口径用），
        // 对它抽样会让「逐条都有卡」这条承诺失效。
        let keep = if mode == "canary" { true } else { passes };
        if crate::episode::should_keep(mode, exc) && keep {
            cards.push(card.clone());
            for cls in exc {
                aggregates
                    .by_exception
                    .entry(cls.to_string())
                    .or_default()
                    .kept += 1;
            }
        } else {
            omitted += 1;
        }
    }
    prov.caliber.push((
        "exc_tail_quantile",
        crate::episode::EXC_TAIL_QUANTILE,
    ));
    for (cls, t) in &thresholds {
        prov.caliber.push((cls, *t));
    }
    prov.caliber.push(("l1_cards", cards.len() as f64));
    prov.caliber.push(("l1_omitted", omitted as f64));
    Report {
        provenance: prov,
        cards,
        cards_omitted: omitted,
        aggregates,
        mover_counts,
    }
}

// ============================== JSON ==============================

fn j_locus(l: Locus) -> J {
    J::s(l.as_str())
}

fn j_chain(c: &EpisodeCard) -> J {
    J::Arr(
        c.chain
            .iter()
            .map(|n| {
                J::obj(vec![
                    ("event_index", J::i(n.event_index)),
                    ("t", J::n(n.t)),
                    ("token", J::s(n.token)),
                    ("subject", J::Int(n.subject as i64)),
                    ("locus", j_locus(n.locus)),
                ])
            })
            .collect(),
    )
}

fn j_tail(c: &EpisodeCard) -> J {
    J::Arr(
        c.tail
            .iter()
            .map(|t| {
                J::obj(vec![
                    ("t", J::n(t.t)),
                    ("supporters", t.supporters.map(J::i).unwrap_or(J::Null)),
                    ("nearest_support_m", J::opt_num(t.nearest_support_m)),
                    (
                        "pressure_state_ticks",
                        t.pressure_state_ticks
                            .map(|v| J::i(v as usize))
                            .unwrap_or(J::Null),
                    ),
                    ("shot_window_open", t.shot_window_open.map(J::b).unwrap_or(J::Null)),
                    ("window_ticks", t.window_ticks.map(|v| J::i(v as usize)).unwrap_or(J::Null)),
                    ("committed", t.committed.map(J::b).unwrap_or(J::Null)),
                    ("ball", J::opt_num(t.ball.map(|b| b.0))),
                    ("ball_y", J::opt_num(t.ball.map(|b| b.1))),
                    ("locus_support", j_locus(Locus::SnapshotPos)),
                    ("locus_pressure", j_locus(Locus::IntentPressureTicks)),
                    ("locus_window", j_locus(Locus::IntentShotWindow)),
                ])
            })
            .collect(),
    )
}

fn j_pursuit(c: &EpisodeCard) -> J {
    match &c.pursuit {
        PursuitView::Visible { runs, classes } => J::obj(vec![
            ("state", J::s("visible")),
            (
                "locus",
                J::s(format!("{} / {}", Locus::MoverAction.as_str(), Locus::BallLoose.as_str())),
            ),
            ("runs", J::i(runs.len())),
            (
                "chase_class",
                J::Arr(classes.iter().map(|s| J::s(*s)).collect()),
            ),
            (
                "runs_detail",
                J::Arr(
                    runs.iter()
                        .map(|r| {
                            J::obj(vec![
                                ("t_start", J::n(r.start_t)),
                                ("t_end", J::n(r.end_t)),
                                ("beats", J::i(r.beats)),
                                ("chasers", J::Arr(r.chasers.iter().map(|i| J::Int(*i as i64)).collect())),
                                (
                                    "close_downers",
                                    J::Arr(r.close_downers.iter().map(|i| J::Int(*i as i64)).collect()),
                                ),
                                (
                                    "other_actions",
                                    J::Arr(r.other_actions.iter().map(|s| J::s(s.clone())).collect()),
                                ),
                                (
                                    "mover_role_counts",
                                    J::Obj(
                                        r.role_counts
                                            .iter()
                                            .map(|(k, v)| (k.to_string(), J::i(*v)))
                                            .collect(),
                                    ),
                                ),
                                ("chase_class", J::s(r.chase_class())),
                                ("event_indexes", J::Arr(r.event_indexes.iter().map(|i| J::i(*i)).collect())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
        PursuitView::Invisible { reason, contest_reason } => J::obj(vec![
            ("state", J::s("invisible")),
            ("locus", J::s(Locus::MoverAction.as_str())),
            ("contest_reason", J::s(*contest_reason)),
            ("reason", J::s(*reason)),
        ]),
        PursuitView::NotApplicable => J::obj(vec![
            ("state", J::s("not_applicable")),
            ("locus", J::Null),
            (
                "reason",
                J::s("本 episode 不以争抢收束 ⇒ 「丢球后」一节不适用（既非可见，也非不可见）"),
            ),
        ]),
    }
}

fn j_card(c: &EpisodeCard) -> J {
    J::obj(vec![
        ("seed", J::Int(c.seed as i64)),
        ("episode_id", J::Int(c.episode_id as i64)),
        ("team", J::s(c.team.as_str())),
        ("start_t", J::n(c.start_t)),
        ("end_t", J::opt_num(c.end_t)),
        ("duration_s", J::opt_num(c.end_t.map(|e| e - c.start_t))),
        ("start_reason", J::s(c.start_reason.as_str())),
        (
            "start_reason_locus",
            j_locus(Locus::EpisodeStartReason),
        ),
        (
            "end_reason",
            J::opt_str(c.end_reason.map(|r| r.as_str())),
        ),
        ("end_reason_locus", j_locus(Locus::EpisodeEndReason)),
        ("coherent", J::b(c.coherent)),
        ("gap_count", J::i(c.gap_count)),
        ("coherence_locus", j_locus(Locus::MatchCoherence)),
        ("chain", j_chain(c)),
        ("tail", j_tail(c)),
        ("pursuit", j_pursuit(c)),
        (
            "contest_start",
            J::opt_str(c.contest_start.map(|r| r.as_str())),
        ),
        (
            "contest_start_locus",
            j_locus(Locus::FactDetail),
        ),
        ("closing_fact_index", c.closing_fact_index.map(J::i).unwrap_or(J::Null)),
        ("bad_event_indexes", J::i(c.bad_event_indexes)),
        // 可回放定位（spec「定位可回到事件流」）。
        (
            "replay",
            J::obj(vec![
                ("seed", J::Int(c.seed as i64)),
                ("t", J::opt_num(c.end_t)),
                ("episode_id", J::Int(c.episode_id as i64)),
                (
                    "event_indexes",
                    J::Arr(c.chain.iter().map(|n| J::i(n.event_index)).collect()),
                ),
            ]),
        ),
    ])
}

pub fn to_json(r: &Report) -> String {
    let p = &r.provenance;
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str("  \"provenance\": ");
    let jp = J::obj(vec![
        ("mode", J::s(p.mode.clone())),
        ("source_commit", J::s(p.source_commit.clone())),
        ("engine_version", J::s(p.engine_version.clone())),
        ("model_version", J::i(p.model_version as usize)),
        ("analyzer_version", J::s(p.analyzer_version.clone())),
        ("caliber_version", J::s(p.caliber_version.clone())),
        ("schema_tag", J::s(p.schema_tag.clone())),
        ("engine_source_fingerprint", J::s(p.engine_source_fingerprint.clone())),
        ("test_source_fingerprint", J::s(p.test_source_fingerprint.clone())),
        ("sidecar_schema_fingerprint", J::s(p.sidecar_schema_fingerprint.clone())),
        (
            "sidecar_closed_set_sizes",
            J::Obj(
                p.sidecar_closed_set_sizes
                    .iter()
                    .map(|(k, v)| (k.to_string(), J::i(*v)))
                    .collect(),
            ),
        ),
        ("seed_first", J::Int(p.seed_first as i64)),
        ("seed_last", J::Int(p.seed_last as i64)),
        ("config_duration_seconds", J::n(p.config_duration_seconds)),
        (
            "caliber",
            J::Obj(
                p.caliber
                    .iter()
                    .map(|(k, v)| (k.to_string(), J::n(*v)))
                    .collect(),
            ),
        ),
    ]);
    out.push_str(&jp.render());
    out.push_str(",\n");

    // 证据边界表（**产物自带能力边界**——读者不必读源码就知道报告能说什么）。
    out.push_str("  \"evidence_table\": ");
    let jt = J::Arr(
        EVIDENCE_TABLE
            .iter()
            .map(|row| {
                J::obj(vec![
                    ("quantity", J::s(row.quantity)),
                    ("locus", J::s(row.locus.as_str())),
                    ("kind", J::s(row.kind.as_str())),
                    ("how_verified", J::s(row.how_verified)),
                ])
            })
            .collect(),
    );
    out.push_str(&jt.render());
    out.push_str(",\n");

    out.push_str("  \"structural_unavailable\": ");
    let ju = J::Arr(
        STRUCTURAL_UNAVAILABLE
            .iter()
            .map(|u| {
                J::obj(vec![
                    ("quantity", J::s(u.quantity)),
                    ("reason", J::s(u.reason)),
                    ("what_would_verify", J::s(u.what_would_verify)),
                ])
            })
            .collect(),
    );
    out.push_str(&ju.render());
    out.push_str(",\n");

    out.push_str("  \"contest_coverage\": ");
    let jc = J::Arr(
        CONTEST_COVERAGE
            .iter()
            .map(|c| {
                J::obj(vec![
                    ("reason", J::s(c.reason.as_str())),
                    ("visibility", J::s(c.visibility.as_str())),
                    ("mechanism", J::s(c.mechanism)),
                ])
            })
            .collect(),
    );
    out.push_str(&jc.render());
    out.push_str(",\n");

    out.push_str("  \"anomaly_coverage\": ");
    let ja = J::Arr(
        ANOMALY_COVERAGE
            .iter()
            .map(|a| {
                J::obj(vec![
                    ("rule", J::s(a.rule)),
                    ("topic", J::s(a.topic)),
                    ("per_episode_samples", J::b(a.per_episode_samples)),
                    ("note", J::s(a.note)),
                ])
            })
            .collect(),
    );
    out.push_str(&ja.render());
    out.push_str(",\n");

    out.push_str("  \"wording_rules\": ");
    let jw = J::Arr(
        WORDING_RULES
            .iter()
            .map(|w| {
                J::obj(vec![
                    ("name", J::s(w.name)),
                    ("allowed", J::s(w.allowed)),
                    ("forbidden", J::s(w.forbidden)),
                    ("why", J::s(w.why)),
                ])
            })
            .collect(),
    );
    out.push_str(&jw.render());
    out.push_str(",\n");

    out.push_str("  \"exception_classes\": ");
    let je = J::Arr(
        crate::episode::EXCEPTION_CLASSES
            .iter()
            .map(|(k, d)| J::obj(vec![("id", J::s(*k)), ("definition", J::s(*d))]))
            .collect(),
    );
    out.push_str(&je.render());
    out.push_str(",\n");

    out.push_str("  \"coverage_claims\": ");
    let jcc = J::Arr(
        COVERAGE_CLAIMS
            .iter()
            .map(|c| {
                J::obj(vec![
                    ("question", J::s(c.question)),
                    ("answerable", J::s(c.answerable)),
                    ("locus", J::s(c.locus.as_str())),
                ])
            })
            .collect(),
    );
    out.push_str(&jcc.render());
    out.push_str(",\n");

    // L2
    out.push_str("  \"l2\": ");
    let a = &r.aggregates;
    let jl2 = J::obj(vec![
        ("cards", J::i(a.cards)),
        ("cards_incoherent", J::i(a.incoherent_cards)),
        ("cards_with_end_t", J::i(a.cards_with_end_t)),
        (
            "by_end_reason",
            J::Obj(
                a.by_end_reason
                    .iter()
                    .map(|(k, g)| {
                        (
                            k.clone(),
                            J::obj(vec![
                                ("cards", J::i(g.cards)),
                                (
                                    "mean_duration_s",
                                    J::opt_num(if g.duration_n > 0 {
                                        Some(g.duration_sum / g.duration_n as f64)
                                    } else {
                                        None
                                    }),
                                ),
                                (
                                    "mean_chain_len",
                                    J::opt_num(if g.chain_n > 0 {
                                        Some(g.chain_sum / g.chain_n as f64)
                                    } else {
                                        None
                                    }),
                                ),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
        (
            "by_contest_start",
            J::Obj(
                a.by_contest_start
                    .iter()
                    .map(|(k, g)| {
                        (
                            k.clone(),
                            J::obj(vec![
                                ("cards", J::i(g.cards)),
                                ("pursuit_visible", J::i(g.pursuit_visible)),
                                ("pursuit_invisible", J::i(g.pursuit_invisible)),
                                (
                                    "declared_visibility",
                                    J::opt_str(
                                        CONTEST_COVERAGE
                                            .iter()
                                            .find(|c| c.reason.as_str() == k)
                                            .map(|c| c.visibility.as_str()),
                                    ),
                                ),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
        (
            "by_exception",
            J::Obj(
                a.by_exception
                    .iter()
                    .map(|(k, g)| {
                        (
                            k.clone(),
                            J::obj(vec![
                                ("cards_full_corpus", J::i(g.cards)),
                                ("incoherent", J::i(g.incoherent)),
                                ("kept_in_l1", J::i(g.kept)),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
    ]);
    out.push_str(&jl2.render());
    out.push_str(",\n");

    out.push_str("  \"mover_counts\": ");
    let jm = J::Obj(
        r.mover_counts
            .iter()
            .map(|(k, v)| (k.to_string(), J::i(*v)))
            .collect(),
    );
    out.push_str(&jm.render());
    out.push_str(",\n");

    out.push_str(&format!("  \"cards_omitted\": {},\n", r.cards_omitted));
    out.push_str("  \"l1\": ");
    let jcards = J::Arr(r.cards.iter().map(j_card).collect());
    out.push_str(&jcards.render());
    out.push_str("\n}\n");
    out
}

// ============================== Markdown ==============================

pub fn to_markdown(r: &Report) -> String {
    let p = &r.provenance;
    let mut o = String::new();
    o.push_str("# P17B 可解释诊断报告\n\n");
    o.push_str("> 本文件是**诊断**，不是**判据**——它不给出通过/失败判定，也不给正面或负面的标签。\n");
    o.push_str("> 行为门归 `#18`。每条结论都标注性质（观测/派生）与落点字段。\n\n");

    o.push_str("## provenance（可比性三件套 + 口径快照）\n\n");
    o.push_str("| 栏 | 值 |\n|---|---|\n");
    o.push_str(&format!("| `mode` | `{}` |\n", p.mode));
    o.push_str(&format!("| `source_commit` | `{}` |\n", p.source_commit));
    o.push_str(&format!("| `analyzer_version` | `{}` |\n", p.analyzer_version));
    o.push_str(&format!("| `caliber_version` | `{}` |\n", p.caliber_version));
    o.push_str(&format!("| `schema_tag` | `{}` |\n", p.schema_tag));
    o.push_str(&format!(
        "| `engine_source_fingerprint` | `{}` |\n",
        p.engine_source_fingerprint
    ));
    o.push_str(&format!(
        "| `test_source_fingerprint` | `{}` |\n",
        p.test_source_fingerprint
    ));
    o.push_str(&format!(
        "| `sidecar_schema_fingerprint` | `{}` |\n",
        p.sidecar_schema_fingerprint
    ));
    o.push_str(&format!(
        "| seed 区间 | `{}..={}` |\n",
        p.seed_first, p.seed_last
    ));
    o.push_str(&format!(
        "| 比赛时长（s） | `{}` |\n",
        p.config_duration_seconds
    ));
    o.push_str("\n口径常量快照：\n\n| 常量 | 值 |\n|---|---|\n");
    for (k, v) in &p.caliber {
        o.push_str(&format!("| `{k}` | `{v}` |\n"));
    }

    o.push_str("\n## 能力边界（先说不能说什么）\n\n");
    o.push_str("### 结构性不可得（不是「还没做」）\n\n");
    o.push_str("| 量 | 为什么不可得 | 验证它需要什么 |\n|---|---|---|\n");
    for u in STRUCTURAL_UNAVAILABLE {
        o.push_str(&format!(
            "| {} | {} | {} |\n",
            u.quantity, u.reason, u.what_would_verify
        ));
    }

    o.push_str("\n### 「丢球后谁做了什么」——**按成因逐项声明**\n\n");
    o.push_str("> ⚠️ 本节**不给笼统的「可答」**。每个 `ContestStartReason` 单独声明，\n");
    o.push_str("> 因为「不看这条声明就不知道报告看不见什么」正是本 change 要防的失败。\n\n");
    o.push_str("| 争抢成因 | 追逐过程 | 机制 |\n|---|---|---|\n");
    for c in CONTEST_COVERAGE {
        o.push_str(&format!(
            "| `{}` | **{}** | {} |\n",
            c.reason.as_str(),
            c.visibility.as_str(),
            c.mechanism
        ));
    }

    o.push_str("\n### 措辞规则（每条给「可说」与「不可说」）\n\n");
    for w in WORDING_RULES {
        o.push_str(&format!("- **{}**\n  - ✅ {}\n  - ❌ {}\n  - 理由：{}\n", w.name, w.allowed, w.forbidden, w.why));
    }

    o.push_str("\n### P17A 异常规则的逐 episode 覆盖（**在证据边界内**）\n\n");
    o.push_str("> ⚠️ 不是「每条异常都能找到样本」——设计已判定该断言做不到。\n");
    o.push_str("> 逐条给出本层的对应物，或说明它**落在哪条边界之外**。\n\n");
    o.push_str("| 规则 | 讲什么 | 逐 episode 样本 | 本层的对应物 / 落在哪条边界外 |\n|---|---|---|---|\n");
    for a in ANOMALY_COVERAGE {
        o.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            a.rule,
            a.topic,
            if a.per_episode_samples { "有" } else { "**无**" },
            a.note
        ));
    }

    o.push_str("\n### 异常筛选类（**筛子**，不是判定）\n\n");
    o.push_str("| 类 | 定义 |\n|---|---|\n");
    for (k, d) in crate::episode::EXCEPTION_CLASSES {
        o.push_str(&format!("| `{k}` | {d} |\n"));
    }

    o.push_str("\n### 证据边界表（量 → 落点 → 性质）\n\n");
    o.push_str("| 量 | 落点 | 性质 | 核对方式 |\n|---|---|---|---|\n");
    for row in EVIDENCE_TABLE {
        o.push_str(&format!(
            "| {} | `{}` | {} | {} |\n",
            row.quantity,
            row.locus.as_str(),
            row.kind.as_str(),
            row.how_verified
        ));
    }

    o.push_str("\n## L2 聚合（**刻意最小**：只给分组计数）\n\n");
    o.push_str(&format!(
        "- 诊断卡总数：{}（其中**观察不可信** {} 张——标注但保留，**不进**下面按结束原因/争抢成因的聚合）\n",
        r.aggregates.cards, r.aggregates.incoherent_cards
    ));
    o.push_str(&format!("- 有 `end_t` 的卡：{}\n", r.aggregates.cards_with_end_t));
    o.push_str(&format!(
        "- 本模式 L1 收录 {} 张；**未收录** {} 张（canary 恒 0；baseline 为按异常筛选掉的部分）\n",
        r.cards.len(),
        r.cards_omitted
    ));

    o.push_str("\n### 按结束原因\n\n| 结束原因 | 卡数 | 平均时长(s) | 平均链长 |\n|---|---:|---:|---:|\n");
    for (k, g) in &r.aggregates.by_end_reason {
        o.push_str(&format!(
            "| `{k}` | {} | {} | {} |\n",
            g.cards,
            fmt_opt(if g.duration_n > 0 { Some(g.duration_sum / g.duration_n as f64) } else { None }),
            fmt_opt(if g.chain_n > 0 { Some(g.chain_sum / g.chain_n as f64) } else { None })
        ));
    }

    o.push_str("\n### 按争抢成因（**含可见/不可见的分子分母**）\n\n");
    o.push_str("| 争抢成因 | 卡数 | 追逐可见 | 追逐不可见 | 声明 |\n|---|---:|---:|---:|---|\n");
    for (k, g) in &r.aggregates.by_contest_start {
        let declared = CONTEST_COVERAGE
            .iter()
            .find(|c| c.reason.as_str() == k)
            .map(|c| c.visibility.as_str())
            .unwrap_or("**未声明**");
        o.push_str(&format!(
            "| `{k}` | {} | {} | {} | {} |\n",
            g.cards, g.pursuit_visible, g.pursuit_invisible, declared
        ));
    }

    o.push_str("\n### 按异常类别（供挑靶点）\n\n| 异常类别 | 命中卡数 | 其中观察不可信 | **进了 L1** |\n|---|---:|---:|---:|\n");
    for (k, g) in &r.aggregates.by_exception {
        o.push_str(&format!(
            "| `{k}` | {} | {} | {} |\n",
            g.cards, g.incoherent, g.kept
        ));
    }
    o.push_str("\n⚠️ **异常类别只是「值得逐条看的筛子」**，不是缺陷判定，也不是门槛——\n");
    o.push_str("阈值取自 P17A 的同名内部诊断阈值（见 provenance 的 `exc_*`），不是与真实足球的偏差量。\n");
    o.push_str("⚠️ **「命中卡数」是**全量**口径（含未收录），「进了 L1」才是本产物实际展开的**——\n");
    o.push_str("两栏并列是因为只给前者会让读者去 L1 里找并不在那里出现的卡。\n");

    o.push_str("\n### 松散球段与追球者计数（跨场合并）\n\n");
    for (k, v) in &r.mover_counts {
        o.push_str(&format!("- `{k}`：{v}\n"));
    }
    o.push_str("\n⚠️ `chasers`（`chase`，靶点恒为球）与 `close_downers`（`close_down`，靶点按来源分流）\n");
    o.push_str("**分列**——不得相加成「追球者总数」（`close_down` 在 `SaveCaught` 时追的是**人**）。\n");

    o.push_str("\n## L1 逐 episode 诊断卡\n\n");
    for c in &r.cards {
        o.push_str(&render_card_md(c));
        o.push('\n');
    }
    o
}

fn fmt_opt(v: Option<f64>) -> String {
    match v {
        Some(x) => format!("{x:.1}"),
        None => "—".to_string(),
    }
}

/// 渲染一张诊断卡（Markdown）。
pub fn render_card_md(c: &EpisodeCard) -> String {
    let mut o = String::new();
    o.push_str(&format!(
        "### seed={} episode={} team={} t=[{:.1}, {}]\n\n",
        c.seed,
        c.episode_id,
        c.team.as_str(),
        c.start_t,
        c.end_t.map(|e| format!("{e:.1}")).unwrap_or("—".to_string())
    ));
    o.push_str(&format!(
        "- `start_reason` = `{}`（{}）\n",
        c.start_reason.as_str(),
        Locus::EpisodeStartReason.as_str()
    ));
    o.push_str(&format!(
        "- `end_reason` = `{}`（{}）\n",
        c.end_reason.map(|r| r.as_str()).unwrap_or("—"),
        Locus::EpisodeEndReason.as_str()
    ));
    o.push_str(&format!(
        "- 观察可信度 = {}（gap={}，{}）\n",
        if c.coherent { "coherent" } else { "**观察不可信**" },
        c.gap_count,
        Locus::MatchCoherence.as_str()
    ));
    if c.end_t.is_none() {
        o.push_str("- ⚠️ **开放 episode**：`end_t` 不可得（流在 possession 中途截断）⇒ 无结束前窗口，记 `unknown`\n");
    }
    if c.bad_event_indexes > 0 {
        o.push_str(&format!(
            "- ⚠️ **事件下标越界 {} 次**（输入形状异常，如实记录，不静默）\n",
            c.bad_event_indexes
        ));
    }

    o.push_str("\n**动作链**（决策事件；`beat` 属节拍不计入）：\n\n```\n");
    if c.chain.is_empty() {
        o.push_str("  （无决策动作——该段只有节拍）\n");
    }
    for n in &c.chain {
        o.push_str(&format!(
            "  #{:<6} t={:<8.1} {}  subject={}\n",
            n.event_index, n.t, n.token, n.subject
        ));
    }
    o.push_str("```\n");

    o.push_str("\n**结束前窗口**（末若干拍；球位 → 接应 / 压力 / 起脚窗口）：\n\n");
    if c.tail.is_empty() {
        o.push_str("（无——`end_t` 不可得或无快照）\n");
    } else {
        o.push_str("| t | 接应者数 | 最近接应(m) | 压迫倒计时 | 起脚窗口 | 已耗拍 | committed |\n");
        o.push_str("|---:|---:|---:|---:|---|---:|---|\n");
        for t in &c.tail {
            o.push_str(&format!(
                "| {:.1} | {} | {} | {} | {} | {} | {} |\n",
                t.t,
                t.supporters.map(|v| v.to_string()).unwrap_or("—".into()),
                fmt_opt(t.nearest_support_m),
                t.pressure_state_ticks.map(|v| v.to_string()).unwrap_or("—".into()),
                match t.shot_window_open {
                    Some(true) => "开",
                    Some(false) => "关",
                    None => "—",
                },
                t.window_ticks.map(|v| v.to_string()).unwrap_or("—".into()),
                match t.committed {
                    Some(true) => "是",
                    Some(false) => "否",
                    None => "—",
                },
            ));
        }
        o.push_str("\n落点：接应 `StateSnapshot.pos`（经 `support_formation`）/ 压力 `IntentState.pressure_state_ticks` / 窗口 `IntentState.{in_window,window_ticks}`\n");
    }

    o.push_str("\n**【丢球后】**\n\n");
    match &c.pursuit {
        PursuitView::Visible { runs, .. } => {
            o.push_str(&format!(
                "争抢成因 = `{}`（{}）\n\n",
                c.contest_start.map(|r| r.as_str()).unwrap_or("—"),
                Locus::FactDetail.as_str()
            ));
            for r in runs {
                o.push_str(&format!(
                    "- 松散球段 t=[{:.1}, {:.1}]，{} 拍，归属 = `{}`\n  - 追球者（`chase`，靶点恒为球）：{:?}\n  - `close_down`（靶点按来源分流，**不是**追球者）：{:?}\n",
                    r.start_t,
                    r.end_t,
                    r.beats,
                    r.chase_class(),
                    r.chasers,
                    r.close_downers
                ));
                if !r.other_actions.is_empty() {
                    o.push_str(&format!(
                        "  - ⚠️ 段内其它 `Mover.action` 串（开集，未列举者落此）：{:?}\n",
                        r.other_actions
                    ));
                }
            }
        }
        PursuitView::Invisible { reason, contest_reason } => {
            o.push_str(&format!(
                "争抢成因 = `{}`（{}）\n\n**{}**\n",
                contest_reason,
                Locus::FactDetail.as_str(),
                reason
            ));
        }
        PursuitView::NotApplicable => {
            o.push_str("本 episode **不以争抢收束** ⇒ 本节不适用（既非可见，也非不可见）。\n");
        }
    }

    o.push_str("\n**四类归因**（每条带落点）：\n\n");
    o.push_str(&format!(
        "- 转换（**事件级**，不报相位）观测：`start_reason` = `{}` / `end_reason` = `{}`\
         {}  [{}]\n",
        c.start_reason.as_str(),
        c.end_reason.map(|r| r.as_str()).unwrap_or("—"),
        c.contest_start
            .map(|r| format!(" / contest = `{}`", r.as_str()))
            .unwrap_or_default(),
        Locus::EpisodeStartReason.as_str()
    ));
    let sup = c.tail.last().and_then(|t| t.supporters);
    match sup {
        Some(n) => o.push_str(&format!(
            "- 接应 派生：末拍接应者数 = {}（口径：`support_formation`）  [{}]\n",
            n,
            Locus::SnapshotPos.as_str()
        )),
        None => o.push_str(
            "- 接应 **unknown**：无快照可供计算（`end_t` 不可得或窗口内无快照）⇒ 不猜  [StateSnapshot.pos]\n",
        ),
    }
    let press = c.tail.last().and_then(|t| t.pressure_state_ticks);
    match press {
        Some(v) => o.push_str(&format!(
            "- 压力 观测：末拍 `pressure_state_ticks` = {}（**剩余保持拍数，不是强度**）  [{}]\n",
            v,
            Locus::IntentPressureTicks.as_str()
        )),
        None => o.push_str(
            "- 压力 **unknown**：该拍无意图快照 ⇒ 不猜  [IntentState.pressure_state_ticks]\n",
        ),
    }
    match c.chain.last() {
        Some(n) => o.push_str(&format!(
            "- 动作 观测：最终决策动作 = `{}`  [{}#{}]\n",
            n.token,
            Locus::EventType.as_str(),
            n.event_index
        )),
        None => o.push_str(&format!(
            "- 动作 **unknown**：本段无决策动作  [{}]\n",
            Locus::EventType.as_str()
        )),
    }

    o.push_str(&format!(
        "\n可回放: `seed={}, t={}, episode={}, event_indexes={:?}`\n",
        c.seed,
        c.end_t.map(|e| format!("{e:.1}")).unwrap_or("—".to_string()),
        c.episode_id,
        c.chain.iter().map(|n| n.event_index).collect::<Vec<_>>()
    ));
    o
}

// ============================== 产物落盘 ==============================

/// 产物落盘目录（`P17B_OUT_DIR` 覆盖，默认 `target/p17b-diagnosis`）。
pub fn out_dir() -> std::path::PathBuf {
    std::env::var("P17B_OUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("target/p17b-diagnosis"))
}
