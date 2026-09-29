//! P16 Slice 5：产物（JSON + Markdown）+ provenance。
//!
//! ## provenance 回答什么
//!
//! 「这次跑的是哪份源码、哪套口径、哪个 seed 区间」——使**两次不可比的运行**
//! 在产物层可被识别。照 P17A 的形态（`tests/p17a/report.rs`）：
//! `source_commit` + `engine_source_fingerprint` + 口径常量快照。
//!
//! ⚠️ **口径版本必须显式记录**：G1 给 `DiagnosticMatch` 加了 `state_snapshots` 字段，
//! 而 **`sidecar_schema_fingerprint` 只哈希闭集枚举的 `ALL`**（见 P17A 的 `model.rs`），
//! **对结构体字段是盲区**——带位置的 P16 运行与不带位置的 P17A 运行在该指纹上**不可区分**。
//! 故 P16 另记 [`CALIBER_VERSION`] 与 `has_state_snapshots`，把可比性补回来。

use crate::caliber::CALIBER_VERSION;
use fm_engine::observation::*;
use fm_engine::MODEL_VERSION;

/// 引擎源码指纹覆盖的源文件（**顺序即哈希输入顺序**）。
///
/// 与 P17A 的清单同源（`tests/p17a/report.rs` 的 `ENGINE_SOURCES`）——
/// 本 change 改了 `lib.rs` 与 `observation.rs`，故 P17A 己落盘产物须重生成才与源码同源。
pub const ENGINE_SOURCES: &[(&str, &str)] = &[
    ("lib.rs", include_str!("../../src/lib.rs")),
    ("observation.rs", include_str!("../../src/observation.rs")),
    ("rng.rs", include_str!("../../src/rng.rs")),
];

/// FNV-1a 64 位（与 P17A / realism 同算法）。
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// **引擎源码文本指纹**（`include_str!` 取编译进二进制的源码，非 git commit）。
pub fn engine_source_fingerprint() -> String {
    let mut combined = String::new();
    for (name, text) in ENGINE_SOURCES {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(text);
        combined.push('\n');
    }
    format!("fnv1a64:{:016x}", fnv1a(&combined))
}

/// 浮点输出精度（定点 4 位，确定性可读）。
const FLOAT_DECIMALS: usize = 4;

/// 极简 JSON（与 P17A 同形态；零依赖）。
#[derive(Debug, Clone)]
#[allow(dead_code)] // `Null` 是 JSON 的通用变体，保留以对齐 P17A 的极简 JSON 形态
pub enum J {
    Null,
    Int(i64),
    F(f64),
    S(String),
}

pub fn obj(pairs: &[(&str, J)]) -> String {
    let inner: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("\"{}\":{}", k, json_of(v)))
        .collect();
    format!("{{{}}}", inner.join(","))
}

fn json_of(v: &J) -> String {
    match v {
        J::Null => "null".to_string(),
        J::Int(i) => i.to_string(),
        J::F(f) => {
            if f.is_finite() {
                format!("{:.*}", FLOAT_DECIMALS, f)
            } else {
                "null".to_string()
            }
        }
        J::S(s) => format!(
            "\"{}\"",
            s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
        ),
    }
}

/// 产物 provenance。
#[derive(Debug, Clone)]
pub struct Provenance {
    pub mode: String,
    pub source_commit: String,
    pub engine_version: String,
    pub model_version: u32,
    /// **本 change 的口径版本**——比 `sidecar_schema_fingerprint` 更细：
    /// 它随本 change 的口径常量变化而递增。
    pub caliber_version: String,
    pub engine_source_fingerprint: String,
    /// P17A 的指纹（闭集枚举哈希）——**对结构体字段是盲区**，此处列出只为交叉引用。
    pub sidecar_schema_fingerprint: String,
    /// **G1 是否生效**：本产物是否带逐 tick 位置快照。这一栏是「两次运行可比性」的关键——
    /// `sidecar_schema_fingerprint` 区分不了有无 `state_snapshots`，本栏可以。
    pub has_state_snapshots: bool,
    pub seed_first: u64,
    pub seed_last: u64,
    pub config_duration_seconds: f64,
    /// 口径常量快照（让 reviewer 不必读源码就能核对判据来源）。
    pub caliber: Vec<(&'static str, f64)>,
    /// **P16 测试源码指纹**——补 `engine_source_fingerprint` 的盲区：后者只哈希
    /// `engine/src/*`，而裁决/参考集/特征的改动全在 `tests/p16/*`。
    /// 两者一起使「产物内容 ↔ 产出它的源码」双向可核对。
    pub test_source_fingerprint: String,
}

/// P16 测试源码清单（哈希输入顺序即此顺序）。
pub const TEST_SOURCES: &[(&str, &str)] = &[
    ("p16_spatial_features.rs", include_str!("../p16_spatial_features.rs")),
    ("p16/caliber.rs", include_str!("caliber.rs")),
    ("p16/shape.rs", include_str!("shape.rs")),
    ("p16/features.rs", include_str!("features.rs")),
    ("p16/gate.rs", include_str!("gate.rs")),
    ("p16/reference.rs", include_str!("reference.rs")),
    ("p16/report.rs", include_str!("report.rs")),
];

pub fn test_source_fingerprint() -> String {
    let mut combined = String::new();
    for (name, text) in TEST_SOURCES {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(text);
        combined.push('\n');
    }
    format!("fnv1a64:{:016x}", fnv1a(&combined))
}

/// `has_state_snapshots` 的取值来源：**真的查一次 opt-in 路径是否产快照**，
/// 而不是硬编码 `true`——否则这一栏区分不了任何东西（审阅 P2-8）。
/// 取样一场 1 秒的比赛即可（有快照则为真），代价可忽略。
fn probe_has_state_snapshots() -> bool {
    let cfg = fm_engine::MatchConfig {
        match_duration_seconds: 5.0,
        demo_mode: false,
        model_version: MODEL_VERSION,
    };
    let dm = fm_engine::simulate_with_behavior_observations(1, cfg);
    !dm.state_snapshots.is_empty()
}

pub fn build_provenance(mode: &str, seed_first: u64, seed_last: u64, duration: f64) -> Provenance {
    let (fingerprint, _sizes) = sidecar_schema_fingerprint_p16();
    Provenance {
        mode: mode.to_string(),
        // ⚠️ **`source_commit` 无哨兵会漂**（独立审阅 P2-1）：产物在改测试文件后重生成时，
        // 若忘了更新 `P16_SOURCE_COMMIT`，它会记成旧 commit，而 `engine_source_fingerprint`
        // 只哈希 `engine/src/*`——**对测试文件的改动是盲区**，前后同值。
        // 故产物同时记 `test_source_fingerprint`（哈希 P16 的测试源码），
        // 使「产物内容」与「产出它的测试源码」绑定。
        source_commit: std::env::var("P16_SOURCE_COMMIT").unwrap_or_else(|_| "unknown".to_string()),
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        model_version: MODEL_VERSION,
        caliber_version: CALIBER_VERSION.to_string(),
        engine_source_fingerprint: engine_source_fingerprint(),
        sidecar_schema_fingerprint: fingerprint,
        has_state_snapshots: probe_has_state_snapshots(),
        test_source_fingerprint: test_source_fingerprint(),
        seed_first,
        seed_last,
        config_duration_seconds: duration,
        caliber: vec![
            ("tick_seconds", fm_engine::TICK_SECONDS),
            ("window_seconds", crate::features::WINDOW_SECONDS),
            ("support_max_dist_m", crate::features::SUPPORT_MAX_DIST_M),
            (
                "support_min_forward_m",
                crate::features::SUPPORT_MIN_FORWARD_M,
            ),
            ("min_outfield_players", crate::shape::MIN_OUTFIELD_PLAYERS as f64),
            ("pitch_length_m", crate::shape::PITCH_LENGTH_M),
            ("pitch_width_m", crate::shape::PITCH_WIDTH_M),
            ("goal_kick_restart_share", crate::caliber::GOAL_KICK_RESTART_SHARE),
        ],
    }
}

/// P16 自己的 sidecar schema 指纹——**复用 P17A 的实现**（闭集枚举 `ALL` 的顺序敏感哈希）。
///
/// ⚠️ 本函数只做一件事：把 P17A 的指纹**原样取用**（不重算、不改动），
/// 使 P16 产物能声明「我跑在哪个 schema 上」。**不**试图把结构体字段塞进去——
/// 那会改动 P17A 已落盘的指纹语义（#113 对 `sidecar_schema_fingerprint` 陈旧问题的同类处置）。
fn sidecar_schema_fingerprint_p16() -> (String, Vec<(&'static str, usize)>) {
    // 闭集枚举的 `ALL` 清单本身（顺序敏感，与 P17A 的 `add!` 次序一致）。
    let mut parts: Vec<String> = Vec::new();
    let mut sizes: Vec<(&'static str, usize)> = Vec::new();
    macro_rules! add {
        ($name:expr, $all:expr) => {{
            let items = $all;
            sizes.push(($name, items.len()));
            let mut line = String::from($name);
            for x in items {
                line.push('|');
                line.push_str(x.as_str());
            }
            parts.push(line);
        }};
    }
    add!("TeamId", TeamId::ALL);
    add!("TeamRef", TeamRef::ALL);
    add!("TimeBasis", TimeBasis::ALL);
    add!("ControlFactKind", ControlFactKind::ALL);
    add!("ControlFactBasis", ControlFactBasis::ALL);
    add!("ObservationGapReason", ObservationGapReason::ALL);
    add!("IllegalInput", IllegalInput::ALL);
    add!("RestartKind", RestartKind::ALL);
    add!("DeadBallReason", DeadBallReason::ALL);
    add!("FlightAction", FlightAction::ALL);
    add!("RestartEndReason", RestartEndReason::ALL);
    add!("EpisodeStartReason", EpisodeStartReason::ALL);
    add!("EpisodeEndReason", EpisodeEndReason::ALL);
    add!("ContestStartReason", ContestStartReason::ALL);
    add!("ContestEndReason", ContestEndReason::ALL);
    add!("Phase", Phase::ALL);
    add!("PhaseProvenance", PhaseProvenance::ALL);
    parts.sort();
    let joined = parts.join("\n");
    (format!("fnv1a64:{:016x}", fnv1a(&joined)), sizes)
}

/// provenance → Markdown 表。
pub fn provenance_markdown(p: &Provenance) -> String {
    let mut out = String::new();
    out.push_str("| 项 | 值 |\n|---|---|\n");
    // ⚠️ Markdown 的**键名与 JSON 逐字一致**——provenance 的价值就在「同一个 token
    // 在两份产物里都可 grep 到」；用人类可读的别名会让「产物层可区分」这条断言
    // 在两个格式间不对称（本测试首版就因 Markdown 写 `caliber version`（空格）、
    // JSON 写 `caliber_version` 而红）。
    out.push_str(&format!("| `mode` | `{}` |\n", p.mode));
    out.push_str(&format!("| `source_commit` | `{}` |\n", p.source_commit));
    out.push_str(&format!("| `engine_version` | `{}` |\n", p.engine_version));
    out.push_str(&format!("| `model_version` | `{}` |\n", p.model_version));
    out.push_str(&format!("| `caliber_version` | `{}` |\n", p.caliber_version));
    out.push_str(&format!(
        "| `test_source_fingerprint` | `{}` |\n",
        p.test_source_fingerprint
    ));
    out.push_str(&format!(
        "| `engine_source_fingerprint` | `{}` |\n",
        p.engine_source_fingerprint
    ));
    out.push_str(&format!(
        "| `sidecar_schema_fingerprint` | `{}` |\n",
        p.sidecar_schema_fingerprint
    ));
    out.push_str(&format!(
        "| `has_state_snapshots` | `{}` |\n",
        p.has_state_snapshots
    ));
    out.push_str(&format!("| `seed_first`..`seed_last` | {}..={} |\n", p.seed_first, p.seed_last));
    out.push_str(&format!(
        "| `config_duration_seconds` | {} |\n",
        p.config_duration_seconds
    ));
    out.push_str("| `caliber` | ");
    out.push_str(
        &p.caliber
            .iter()
            .map(|(k, v)| format!("`{k}={v}`"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str(" |\n");
    out
}

/// provenance → JSON。
pub fn provenance_json(p: &Provenance) -> String {
    let pairs: Vec<(&str, J)> = vec![
        ("mode", J::S(p.mode.clone())),
        ("source_commit", J::S(p.source_commit.clone())),
        ("engine_version", J::S(p.engine_version.clone())),
        ("model_version", J::Int(p.model_version as i64)),
        ("caliber_version", J::S(p.caliber_version.clone())),
        (
            "test_source_fingerprint",
            J::S(p.test_source_fingerprint.clone()),
        ),
        (
            "engine_source_fingerprint",
            J::S(p.engine_source_fingerprint.clone()),
        ),
        (
            "sidecar_schema_fingerprint",
            J::S(p.sidecar_schema_fingerprint.clone()),
        ),
        // bool 没有专门的 JSON 变体（极简 JSON 只求确定性）——用 "true"/"false" 字符串，
        // 与 P17A 的极简 JSON 同风格。
        ("has_state_snapshots", J::S(p.has_state_snapshots.to_string())),
        ("seed_first", J::Int(p.seed_first as i64)),
        ("seed_last", J::Int(p.seed_last as i64)),
        ("config_duration_seconds", J::F(p.config_duration_seconds)),
    ];
    let cal: Vec<String> = p
        .caliber
        .iter()
        .map(|(k, v)| format!("\"{}\":{}", k, json_of(&J::F(*v))))
        .collect();
    format!(
        "{},\"caliber\":{{{}}}}}",
        obj(&pairs).trim_end_matches('}'),
        cal.join(",")
    )
}

/// **特征定义文档**（design §3 要求「每条特征给定义」）+ 覆盖率 + 裁决。
///
/// 这是**人可读**产物；机器可读版是 `p16-*.json`。
pub fn to_markdown(
    p: &Provenance,
    caliber: &crate::caliber::CaliberCoverage,
    shape_home: &crate::shape::ShapeCoverage,
    feat: &crate::features::FeatureCoverage,
    gate_rows: &[(String, String, f64, usize, usize)],
    // 各档 episode 时长中位数（build_up / progression / final_third）——**活计算**传入，
    // 不硬编码：这些数是「为何必须时长归一」的理由，引擎重开分布一变就会陈旧。
    duration_medians: (f64, f64, f64),
) -> String {
    let mut out = String::new();
    out.push_str("# P16 团队与局部空间特征 — 产物\n\n");
    out.push_str("> 本文件由 `cargo test --release --test p16_spatial_features -- --ignored --nocapture p16_*` 生成。\n\n");
    out.push_str("## Provenance\n\n");
    out.push_str(&provenance_markdown(p));
    out.push_str("\n## 1. 位置口径覆盖率（Slice 1）\n\n");
    out.push_str(&format!(
        "- episode 总数：**{}**；起点位置可得 **{}**（{:.4}）\n",
        caliber.episodes,
        caliber.start_available,
        caliber.start_available as f64 / caliber.episodes.max(1) as f64
    ));
    out.push_str(&format!(
        "- 终点位置可得（**同源收束侧**）：**{}**（{:.4}）；其中与 `end_t` 同刻的 **{}**\n",
        caliber.end_available,
        caliber.end_available as f64 / caliber.episodes.max(1) as f64,
        caliber.end_at_close
    ));
    out.push_str(&format!(
        "- 两口径（事实 vs 决策动作）推进带分歧：**{}/{} = {:.4}**\n",
        caliber.band_disagreement,
        caliber.band_comparable,
        caliber.band_disagreement as f64 / caliber.band_comparable.max(1) as f64
    ));
    out.push_str(&format!("- 起点推进带：`{:?}`\n", caliber.start_bands));
    out.push_str(&format!("- 终点推进带：`{:?}`\n", caliber.end_bands));
    out.push_str(&format!(
        "- 收束侧事实类型（**四类**）：`{:?}`\n",
        caliber.end_fact_kinds
    ));
    out.push_str(&format!(
        "- 终点缺失（按 end_reason）：`{:?}`\n",
        caliber.end_missing_by_reason
    ));
    out.push_str(&format!("- 起点事实 TimeBasis：`{:?}`\n", caliber.start_bases));

    out.push_str("\n## 2. 静态队形覆盖率（Slice 2）\n\n");
    out.push_str(&format!(
        "- 快照帧数：**{}**；可算帧：**{}**（{:.4}）\n",
        shape_home.frames,
        shape_home.computable,
        shape_home.computable_share().unwrap_or(0.0)
    ));
    out.push_str(&format!(
        "- 缺失原因：`{:?}`（**引擎侧应为空**——`includeExtrapolated` / `MIN_OUTFIELD_PLAYERS` 在此是空操作）\n",
        shape_home.missing_reasons
    ));
    out.push_str(&format!(
        "- 帧归属：`{:?}`\n",
        shape_home.in_episode
    ));

    out.push_str("\n## 3. 时间关系特征（Slice 3）\n\n");
    out.push_str("| 特征 | 可算窗口占比 |\n|---|---|\n");
    out.push_str(&format!(
        "| 球门向净推进 | {:.4} |\n",
        feat.share(feat.win_net_progress).unwrap_or(0.0)
    ));
    out.push_str(&format!(
        "| 推进/回撤/横向转移 | {:.4} |\n",
        feat.share(feat.win_displacement).unwrap_or(0.0)
    ));
    out.push_str(&format!(
        "| 线间距变化 | {:.4} |\n",
        feat.share(feat.win_line_spacing).unwrap_or(0.0)
    ));
    out.push_str(&format!(
        "| 接应是否形成 | {:.4} |\n",
        feat.share(feat.win_support).unwrap_or(0.0)
    ));
    out.push_str(&format!(
        "\n窗口总数：**{}**；缺失原因分类：`{:?}`\n",
        feat.windows, feat.missing
    ));
    out.push_str("\n### 已知缺口（记录在案，不冒充）\n\n");
    for (k, v) in crate::features::FEATURE_LIMITATIONS {
        out.push_str(&format!("- **{k}**：{v}\n"));
    }

    out.push_str("\n## 4. phaseability 裁决（Slice 4）\n\n");
    out.push_str("**裁决：部分够。** 只能判 `final_third`；`build_up` 与 `progression` 判不了。\n\n");
    out.push_str("判据用**时长归一**的 `forward_m/s`（累计位移随时长增长，未归一会引入混淆；\n");
    out.push_str(&format!(
        "各档 episode 时长中位数：`build_up` {:.0} s / `progression` {:.0} s / `final_third` {:.0} s——\n",
        duration_medians.0, duration_medians.1, duration_medians.2
    ));
    out.push_str(&format!(
        "`build_up` 约为另两档的 {:.1} 倍，故必须先归一）：\n\n",
        if duration_medians.1 > 0.0 {
            duration_medians.0 / duration_medians.1
        } else {
            0.0
        }
    ));
    out.push_str("| 对照 | 特征 | AUC | 正样本 | 负样本 |\n|---|---|---|---|---|\n");
    for (set, ft, a, pos, neg) in gate_rows {
        out.push_str(&format!("| {set} | {ft} | {a:.3} | {pos} | {neg} |\n"));
    }
    out.push_str("\n- `final_third` vs 其余 AUC 高且方向一致（final_third 的球门向推进**速率**更高，\n");
    out.push_str("  与足球直觉一致）⇒ **可分开**；\n");
    out.push_str("- `build_up` vs `progression` AUC ≈0.5 ⇒ **分不开**（未归一时的「可分」是时长/\n");
    out.push_str("  传球次数混淆，且 motif 定义本身就含传球次数——分开了也说不清）。\n\n");
    out.push_str("⇒ **`final_third`** 有可执行判据的**候选**，但它是**几何证据不是战术意图**——\n");
    out.push_str("若 15B 用它，须命名为**证据**（如 `GoalwardProgressEvidence`），**不得复用 `Phase`**。\n");
    out.push_str("⇒ **`build_up` / `progression`**：**保留 `unknown`**；要分开需要能表达意图的观测。\n");
    out.push_str("\n⚠️ **本裁决经两版作废**：v1「不够」败于 join bug（全局下标 vs 逐场本地下标）；\n");
    out.push_str("v2「不够 + 小样本误导」把该 bug 的症状写成了统计学教训。详见测试文件的裁决 doc。\n");
    out
}

/// 产物落盘目录（`P16_OUT_DIR` 覆盖，默认 `target/p16-baseline`）。
pub fn out_dir() -> std::path::PathBuf {
    std::env::var("P16_OUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("target/p16-baseline"))
}
