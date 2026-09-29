//! P124 Slice 5：产物（JSON + Markdown）+ provenance。
//!
//! ## 与 P16 的关系
//!
//! **形态沿用 P16**（`tests/p16/report.rs`），但**指纹覆盖本 change 的源码**——
//! P16 的 `TEST_SOURCES` 只哈希 `tests/p16/*` + 它自己的入口，**不含** `tests/p124/*`。
//! 若直接复用，改了本 change 的任何文件都不会让 P16 的指纹变化 ⇒ 产物会陈旧而无人察觉
//! （P16 的 `source_commit` 缺陷 4 的同型）。
//!
//! ⇒ 本模块**自带**一套指纹清单：[`ENGINE_SOURCES`]（引擎源码，与 P16 同清单）+
//! [`TEST_SOURCES_P124`]（本 change 的源码 + 它只读复用的 P16 模块 + 两个入口）。
//!
//! ## P16 的教训（本模块逐条继承）
//!
//! | 教训 | 本模块的落点 |
//! |---|---|
//! | 坏 JSON 一路绿（缺陷 1/2） | [`json_looks_well_formed`] + 落盘 JSON 的结构校验测试 |
//! | `source_commit == HEAD` 是**自失效**的（缺陷 4 第一版） | 只断言「形如 40 位 hex 且是 HEAD 的祖先」，**不要求 == HEAD** |
//! | `merge_into_object` 用 `trim_end_matches` 剥多字符（缺陷 1） | 用 `strip_suffix('}')` + 断言 base 以 `}` 结尾 |

use fm_engine::observation::*;
use fm_engine::MODEL_VERSION;

// ============================== 指纹 ==============================

/// 引擎源码清单（与 P16 的 `ENGINE_SOURCES` 同源——顺序即哈希输入顺序）。
pub const ENGINE_SOURCES: &[(&str, &str)] = &[
    ("lib.rs", include_str!("../../src/lib.rs")),
    ("observation.rs", include_str!("../../src/observation.rs")),
    ("rng.rs", include_str!("../../src/rng.rs")),
];

/// 本 change 的测试源码清单（含只读复用的 P16 模块——它们参与判据，必须被哈希）。
pub const TEST_SOURCES_P124: &[(&str, &str)] = &[
    ("p124_intent_observations.rs", include_str!("../p124_intent_observations.rs")),
    ("p124/probe.rs", include_str!("probe.rs")),
    ("p124/purify.rs", include_str!("purify.rs")),
    ("p124/pool.rs", include_str!("pool.rs")),
    ("p124/intent.rs", include_str!("intent.rs")),
    ("p124/phasegate.rs", include_str!("phasegate.rs")),
    ("p124/report.rs", include_str!("report.rs")),
    // 只读复用的 P16 管线（改了它们，本 change 的数字就会变）。
    ("p16/caliber.rs", include_str!("../p16/caliber.rs")),
    ("p16/shape.rs", include_str!("../p16/shape.rs")),
    ("p16/features.rs", include_str!("../p16/features.rs")),
    ("p16/gate.rs", include_str!("../p16/gate.rs")),
    ("p16/reference.rs", include_str!("../p16/reference.rs")),
];

/// FNV-1a 64 位（与 P17A / P16 / realism 同算法）。
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

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

/// 引擎源码文本指纹（`include_str!` 取编译进二进制的源码，非 git commit）。
pub fn engine_source_fingerprint() -> String {
    fingerprint_of(ENGINE_SOURCES)
}

/// 本 change 的测试源码指纹——补 [`engine_source_fingerprint`] 的盲区
/// （它只哈希 `engine/src/*`，而裁决/特征/参考集的改动全在测试侧）。
pub fn test_source_fingerprint() -> String {
    fingerprint_of(TEST_SOURCES_P124)
}

/// 口径版本。**判据变化必须递增**——产物 provenance 记它，
/// 使「口径不同的两次运行」在产物层可区分（同 P16 的 `CALIBER_VERSION` 约定）。
pub const CALIBER_VERSION: &str = "p124-intent-v1";

/// 取样一场 1 秒的比赛，查 opt-in 路径是否真的产意图快照——
/// **不硬编码 `true`**（P16 的 `has_state_snapshots` 就是活探测，本模块同法）。
fn probe_has_intent_snapshots() -> bool {
    let cfg = fm_engine::MatchConfig {
        match_duration_seconds: 5.0,
        demo_mode: false,
        model_version: MODEL_VERSION,
    };
    let dm = fm_engine::simulate_with_behavior_observations(1, cfg);
    !dm.intent_snapshots.is_empty()
}

// ============================== 极简 JSON（与 P16 同形态，零依赖） ==============================

/// 浮点输出精度（定点 4 位，确定性可读）。
const FLOAT_DECIMALS: usize = 4;

#[derive(Debug, Clone)]
#[allow(dead_code)] // `Null` 是 JSON 的通用变体，保留以对齐 P16 的极简 JSON 形态
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

/// 把 `extra` 合进一个**以 `}` 结尾的对象字面量** [`base`]。
///
/// ⚠️ **必须 `strip_suffix('}')` 而不是 `trim_end_matches('}')`**：后者剥掉**所有**
/// 尾随 `}`（是个字符集），而 `provenance_json` 结尾是 `}}`（子对象 + 最外层）
/// ⇒ 剥两个补一个 ⇒ **少一个 `}` ⇒ JSON 不可解析**。这是 P16 交付核验抓到的 P0，
/// 本模块沿用其修复（含「base 必须以 `}` 结尾」的断言，坏输入当场 panic 而非静默拼坏）。
pub fn merge_into_object(base: &str, extra: &[(&str, String)]) -> String {
    let inner = base
        .strip_suffix('}')
        .unwrap_or_else(|| panic!("merge_into_object 的 base 必须以 `}}` 结尾：{base}"));
    assert!(
        inner.starts_with('{'),
        "merge_into_object 的 base 必须以 `{{` 开头：{base}"
    );
    let mut parts: Vec<String> = Vec::with_capacity(extra.len() + 1);
    if inner.len() > 1 {
        parts.push(inner[1..].to_string());
    }
    for (k, v) in extra {
        parts.push(format!("\"{}\":{}", k, v));
    }
    format!("{{{}}}", parts.join(","))
}

/// **最小 JSON 结构校验**（零依赖）：括号/引号平衡 + 顶层形状。
/// 足以抓住「缺一个 `}`」这类坏产物（P16 缺陷 1 的形态）。
///
/// ⚠️ **能力边界**：不是完整解析器（不校验转义、数字格式、重复键）。
/// 对「产物是自己拼的、只需防括号/引号失衡」够用；要更强须引入依赖，与本仓零依赖冲突。
pub fn json_looks_well_formed(s: &str) -> Result<(), String> {
    let b = s.trim().as_bytes();
    if b.is_empty() {
        return Err("空文档".to_string());
    }
    if b[0] != b'{' {
        return Err(format!("顶层不是对象（首字符 {:?}）", b[0] as char));
    }
    if *b.last().unwrap() != b'}' {
        return Err("顶层对象未以 `}` 收尾".to_string());
    }
    let mut depth: i64 = 0;
    let mut in_str = false;
    let mut escaped = false;
    let mut max_depth: i64 = 0;
    for (i, &c) in b.iter().enumerate() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => {
                depth += 1;
                max_depth = max_depth.max(depth);
            }
            b'}' | b']' => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("第 {i} 字节处闭合多于打开"));
                }
            }
            _ => {}
        }
    }
    if in_str {
        return Err("字符串未闭合".to_string());
    }
    if depth != 0 {
        return Err(format!(
            "括号不平衡：结束时 depth = {depth}（多了 {depth} 个未闭合的 `{{`/`[`）"
        ));
    }
    if max_depth < 2 {
        return Err("顶层对象里没有嵌套对象/数组——形状可疑".to_string());
    }
    Ok(())
}

// ============================== provenance ==============================

#[derive(Debug, Clone)]
pub struct Provenance {
    pub mode: String,
    pub source_commit: String,
    pub engine_version: String,
    pub model_version: u32,
    pub caliber_version: String,
    pub engine_source_fingerprint: String,
    /// P17A 的闭集指纹——**对结构体字段是盲区**，列出只为交叉引用（同 P16）。
    pub sidecar_schema_fingerprint: String,
    /// 本产物是否带逐 tick 意图快照（**活探测**，不硬编码）。
    pub has_intent_snapshots: bool,
    pub seed_first: u64,
    pub seed_last: u64,
    pub config_duration_seconds: f64,
    /// 口径常量快照（让 reviewer 不读源码就能核对判据来源）。
    pub caliber: Vec<(&'static str, f64)>,
    /// 本 change 的测试源码指纹（含只读复用的 P16 模块）。
    pub test_source_fingerprint: String,
    /// **产出时工作树是否脏**（`git status --porcelain` 非空）。
    ///
    /// ⚠️ **独立审阅抓到的问题（P1-2）**：产物的 `source_commit` 记的是**产出时的 HEAD**，
    /// 而产物可能是在**未提交的工作树**上产出的——此时「产物内容 ↔ commit 标签」说不通
    /// （实测：`canary.json` 记 `3baff0f`，但内嵌指纹对应当前工作树的源码）。
    ///
    /// P16 的教训是「不要求 `source_commit == HEAD`」（那会自失效）；但那条**不足以**
    /// 表达「产出时是否含未提交改动」。故本栏如实记下——**内容绑定靠
    /// `test_source_fingerprint`（硬门），本栏只补标签语义**，不参与 pass/fail。
    pub worktree_dirty: bool,
    /// 产出时 `git status --porcelain` 的原始输出（截断到 2000 字符；脏时才有意义）。
    pub worktree_status: String,
}

/// `has_intent_snapshots` 的 provenance 取值来源（活探测，见 [`probe_has_intent_snapshots`]）。
pub fn build_provenance(mode: &str, seed_first: u64, seed_last: u64, duration: f64) -> Provenance {
    Provenance {
        mode: mode.to_string(),
        // ⚠️ 环境变量无哨兵会漂（P16 缺陷 4）：产物同时记 `test_source_fingerprint`
        // （哈希本 change 的测试源码），使「产物内容」与「产出它的源码」绑定。
        // 落盘守卫另断言它是 40 位 hex 且**是 HEAD 的祖先**（不要求 == HEAD，见守卫 doc）。
        source_commit: std::env::var("P124_SOURCE_COMMIT")
            .unwrap_or_else(|_| "unknown".to_string()),
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        model_version: MODEL_VERSION,
        caliber_version: CALIBER_VERSION.to_string(),
        engine_source_fingerprint: engine_source_fingerprint(),
        sidecar_schema_fingerprint: p16_sidecar_schema_fingerprint(),
        has_intent_snapshots: probe_has_intent_snapshots(),
        seed_first,
        seed_last,
        config_duration_seconds: duration,
        caliber: caliber_snapshot(),
        test_source_fingerprint: test_source_fingerprint(),
        worktree_dirty: worktree_is_dirty(),
        worktree_status: worktree_status_porcelain(),
    }
}

/// 工作树是否有未提交改动（`git status --porcelain` 非空）。
///
/// **调不起 git**（无 git 的 CI/容器）时返回 `false`——那与「干净」不可区分，
/// 但本栏只是标签注释，不参与判据（见 [`Provenance::worktree_dirty`]）。
pub fn worktree_is_dirty() -> bool {
    !worktree_status_porcelain().is_empty()
}

/// `git status --porcelain` 的输出（截断到 2000 字符）。调不起 git 时返回空串。
pub fn worktree_status_porcelain() -> String {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            s.chars().take(2000).collect()
        }
        _ => String::new(),
    }
}

/// 口径常量快照——**驱动判据的活常量**。改它们会改变数字，故必须记进产物。
pub fn caliber_snapshot() -> Vec<(&'static str, f64)> {
    vec![
        ("window_seconds", crate::features::WINDOW_SECONDS),
        ("support_max_dist_m", crate::features::SUPPORT_MAX_DIST_M),
        ("support_min_forward_m", crate::features::SUPPORT_MIN_FORWARD_M),
        ("min_side_for_separability", crate::phasegate::MIN_SIDE_FOR_SEPARABILITY as f64),
        ("counter_proof_expected", crate::purify::COUNTER_PROOF_EXPECTED),
        ("counter_proof_tol", crate::purify::COUNTER_PROOF_TOL),
        ("empty_control_auc_tol", 1e-3),
        ("gate_seed_first", crate::pool::GATE_SEEDS.0 as f64),
        ("gate_seed_last", crate::pool::GATE_SEEDS.1 as f64),
        ("match_duration_seconds", crate::pool::DUR),
    ]
}

/// P17A 的闭集指纹——**本模块只作交叉引用**（它覆盖闭集枚举的 `ALL`，对结构体字段是盲区）。
///
/// ⚠️ 与 P16 的 `sidecar_schema_fingerprint_p16` **同一配方**（顺序敏感的串接哈希）。
/// 硬编码期望值会让「P17A 侧合法改枚举」时本测试误红（那是 P17A 的事，不是本 change 的），
/// 故只算值、供人工比对。
pub fn p16_sidecar_schema_fingerprint() -> String {
    let mut parts: Vec<String> = Vec::new();
    macro_rules! add {
        ($name:expr, $all:expr) => {{
            let items = $all;
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
    format!("fnv1a64:{:016x}", fnv1a(&parts.join("\n")))
}

/// provenance → Markdown 表（**键名与 JSON 逐字一致**——P16 的教训：
/// 用人类可读的别名会让「同一 token 在两份产物里都可 grep」这条不对称）。
pub fn provenance_markdown(p: &Provenance) -> String {
    let mut out = String::new();
    out.push_str("| 项 | 值 |\n|---|---|\n");
    out.push_str(&format!("| `mode` | `{}` |\n", p.mode));
    out.push_str(&format!("| `source_commit` | `{}` |\n", p.source_commit));
    out.push_str(&format!("| `engine_version` | `{}` |\n", p.engine_version));
    out.push_str(&format!("| `model_version` | `{}` |\n", p.model_version));
    out.push_str(&format!("| `caliber_version` | `{}` |\n", p.caliber_version));
    out.push_str(&format!(
        "| `engine_source_fingerprint` | `{}` |\n",
        p.engine_source_fingerprint
    ));
    out.push_str(&format!(
        "| `test_source_fingerprint` | `{}` |\n",
        p.test_source_fingerprint
    ));
    out.push_str(&format!(
        "| `sidecar_schema_fingerprint` | `{}` |\n",
        p.sidecar_schema_fingerprint
    ));
    out.push_str(&format!(
        "| `has_intent_snapshots` | `{}` |\n",
        p.has_intent_snapshots
    ));
    out.push_str(&format!(
        "| `worktree_dirty` | `{}` |\n",
        p.worktree_dirty
    ));
    out.push_str(&format!("| `seed_first` | `{}` |\n", p.seed_first));
    out.push_str(&format!("| `seed_last` | `{}` |\n", p.seed_last));
    out.push_str(&format!(
        "| `config_duration_seconds` | `{}` |\n",
        p.config_duration_seconds
    ));
    out.push_str("\n| 口径常量 | 值 |\n|---|---|\n");
    for (k, v) in &p.caliber {
        out.push_str(&format!("| `{k}` | `{v}` |\n"));
    }
    out
}

/// provenance → JSON（**以 `}` 结尾**，供 [`merge_into_object`] 合并）。
pub fn provenance_json(p: &Provenance) -> String {
    let caliber = obj(
        &p.caliber
            .iter()
            .map(|(k, v)| (*k, J::F(*v)))
            .collect::<Vec<_>>(),
    );
    format!(
        "{{\"mode\":{},\"source_commit\":{},\"engine_version\":{},\"model_version\":{},\
         \"caliber_version\":{},\"engine_source_fingerprint\":{},\"test_source_fingerprint\":{},\
         \"sidecar_schema_fingerprint\":{},\"has_intent_snapshots\":{},\"worktree_dirty\":{},\
         \"seed_first\":{},\"seed_last\":{},\"config_duration_seconds\":{},\"caliber\":{}}}",
        json_of(&J::S(p.mode.clone())),
        json_of(&J::S(p.source_commit.clone())),
        json_of(&J::S(p.engine_version.clone())),
        json_of(&J::Int(p.model_version as i64)),
        json_of(&J::S(p.caliber_version.clone())),
        json_of(&J::S(p.engine_source_fingerprint.clone())),
        json_of(&J::S(p.test_source_fingerprint.clone())),
        json_of(&J::S(p.sidecar_schema_fingerprint.clone())),
        json_of(&J::S(p.has_intent_snapshots.to_string())),
        json_of(&J::S(p.worktree_dirty.to_string())),
        json_of(&J::Int(p.seed_first as i64)),
        json_of(&J::Int(p.seed_last as i64)),
        json_of(&J::F(p.config_duration_seconds)),
        caliber,
    )
}

/// 产物落盘目录（`P124_OUT_DIR` 覆盖，默认 `target/p124-intent`）。
pub fn out_dir() -> std::path::PathBuf {
    std::env::var("P124_OUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("target/p124-intent"))
}
