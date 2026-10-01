//! P18（#18）：行为真实性的**引擎侧量导出**。
//!
//! 本 change **只读公开 API**（`simulate_with_behavior_observations` + `observation` 模块），
//! **不改任何生成逻辑**：跑位/决策、RNG、正式事件流、golden 全不受影响。
//!
//! ## 交付
//!
//! - **引擎侧参照产物**（`target/p18-gates/{canary,baseline}.json`）：逐场值 + 跨场分布 +
//!   **provenance**（seed 区间 / 引擎源码指纹 / 口径版本 / 生成它的探针名）。
//! - 它由 JS 判据器（`notes/criteria/check-behavior-gates.mjs`）与真实侧参照一起读。
//!
//! ## 三条不可越界（design §1）
//!
//! 1. **零 `engine/src/` 改动**——只读公开 API；
//! 2. **不报 phase**——本文件与 `p18/gates.rs` **都不出现** `Phase` / `build_up` /
//!    `progression` / `final_third`（守卫 `wording_guard_rejects_phase_vocabulary`
//!    扫**这两个文件**）；
//! 3. **不产生 pass/fail**——本文件只**导出量**，判定在 JS 判据器（报告期，退出码恒 0）。
//!
//! 跑法：
//! ```text
//! # 默认快速门
//! cargo test --test p18_behavior_gates
//! # 落盘引擎侧产物（30 seed canary / 300 seed baseline）
//! P18_SOURCE_COMMIT=$(git rev-parse HEAD) \
//!   cargo test --release --test p18_behavior_gates -- --ignored --nocapture p18_canary
//! ```

#[allow(dead_code)]
#[path = "p17a/model.rs"]
mod model;
#[path = "p18/gates.rs"]
mod gates;

use fm_engine::MODEL_VERSION;

/// 统一比赛时长（90 分钟，`default_()` 同值）。
const DUR: f64 = 5400.0;
/// canary / baseline 的 seed 区间（**canary 是 baseline 的前缀子集**，同 P17A）。
const CANARY_SEEDS: (u64, u64) = (1, 30);
const BASELINE_SEEDS: (u64, u64) = (1, 300);

/// 口径版本：本文件或 `p18/gates.rs` 的口径变化时**必须递增**。
pub const CALIBER_VERSION: &str = "p18-engine-v1";

// ============================== provenance ==============================

/// 引擎源码指纹覆盖的源文件（顺序即哈希输入顺序）。
/// 判据：**凡是能改变 `simulate_with_behavior_observations` 输出的 `engine/src/` 源码**。
pub const ENGINE_SOURCES: &[(&str, &str)] = &[
    ("lib.rs", include_str!("../src/lib.rs")),
    ("observation.rs", include_str!("../src/observation.rs")),
    ("rng.rs", include_str!("../src/rng.rs")),
];

/// 本 change 自己的测试源码清单（哈希输入顺序即此顺序）。
pub const TEST_SOURCES: &[(&str, &str)] = &[
    ("p18_behavior_gates.rs", include_str!("p18_behavior_gates.rs")),
    ("p18/gates.rs", include_str!("p18/gates.rs")),
];

/// FNV-1a 64 位（与 P17A/P17B 的 `model::fnv1a` 同算法；这里独立实现以免依赖顺序问题）。
fn fnv1a(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
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

pub fn engine_source_fingerprint() -> String { fingerprint_of(ENGINE_SOURCES) }
pub fn test_source_fingerprint() -> String { fingerprint_of(TEST_SOURCES) }

// ============================== 产物 ==============================

fn out_dir() -> std::path::PathBuf {
    std::env::var("P18_OUT_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/p18-gates")
    })
}

fn run_and_write(mode: &str, first: u64, last: u64) {
    let rows: Vec<gates::MatchGates> = (first..=last).map(|s| gates::gates_of(s, DUR)).collect();

    let json_rows: Vec<String> = rows.iter().map(gates::to_json_row).collect();
    let summary = gates::summarize(&rows);

    let source_commit = std::env::var("P18_SOURCE_COMMIT").unwrap_or_else(|_| "unknown".into());
    let provenance = format!(
        "{{\"mode\":\"{}\",\"source_commit\":\"{}\",\"engine_crate\":\"{}\",\
\"model_version\":{},\"caliber_version\":\"{}\",\
\"engine_source_fingerprint\":\"{}\",\"test_source_fingerprint\":\"{}\",\
\"seed_first\":{},\"seed_last\":{},\"match_duration_seconds\":{},\
\"generated_by\":\"engine/tests/p18_behavior_gates.rs\",\
\"caliber_constants\":{{\"tick_seconds\":1.0,\"approach_m_per_tick\":{},\"seg_gap_sec\":{},\
\"pitch_length_m\":105.0,\"pitch_width_m\":68.0}}}}",
        mode, source_commit, env!("CARGO_PKG_VERSION"),
        MODEL_VERSION, CALIBER_VERSION,
        engine_source_fingerprint(), test_source_fingerprint(),
        first, last, DUR,
        gates::APPROACH_M_PER_TICK, gates::SEG_GAP_SEC,
    );

    let json = format!(
        "{{\"schema\":\"p18-engine-behavior-gates/1\",\"provenance\":{},\
\"perGame\":[{}],\"reference\":{}}}",
        provenance,
        json_rows.join(","),
        summary,
    );

    let dir = out_dir();
    std::fs::create_dir_all(&dir).expect("建产物目录");
    let path = dir.join(format!("{}.json", mode));
    std::fs::write(&path, json).expect("写产物");

    println!("[p18:{}] {} 场 / 落盘 {}\n[p18:{}] provenance: caliber={} engine_fp={} seeds={}..={}",
        mode, rows.len(), path.display(), mode, CALIBER_VERSION,
        engine_source_fingerprint(), first, last);
}

// ============================== 测试 ==============================

/// 口径自检：`beat.ball` 与 `beat.main` **互斥**（第三轮 grill 的教训）。
/// 若这条变了，B 组的参照物假设就要重新审。
#[test]
fn ball_and_main_are_mutually_exclusive() {
    let cfg = fm_engine::MatchConfig { match_duration_seconds: DUR, ..fm_engine::MatchConfig::default_() };
    let dm = fm_engine::simulate_with_behavior_observations(1, cfg);
    let mut both = 0usize; let mut ball_ticks = 0usize; let mut main_ticks = 0usize;
    for e in dm.events.iter() {
        if e.movers.is_none() { continue; }
        if e.ball.is_some() { ball_ticks += 1; }
        if e.main.is_some() { main_ticks += 1; }
        if e.ball.is_some() && e.main.is_some() { both += 1; }
    }
    assert!(ball_ticks > 0, "样本里没有 ball 拍——守卫会空转");
    assert!(main_ticks > 0, "样本里没有 main 拍——守卫会空转");
    assert_eq!(both, 0, "ball 与 main 同时出现的拍 = {}，B 组的参照物假设被破坏", both);
}

/// **B 组的量必须用 `main` 作参照**——用 `ball` 会静默测成松散球追球。
/// 本守卫直接断言：持球拍（有 main）的数量远多于松散球拍（有 ball）。
#[test]
fn carrier_ticks_dominate_loose_ticks() {
    let cfg = fm_engine::MatchConfig { match_duration_seconds: DUR, ..fm_engine::MatchConfig::default_() };
    let dm = fm_engine::simulate_with_behavior_observations(1, cfg);
    let main_ticks = dm.events.iter().filter(|e| e.movers.is_some() && e.main.is_some()).count();
    let ball_ticks = dm.events.iter().filter(|e| e.movers.is_some() && e.ball.is_some()).count();
    assert!(main_ticks > ball_ticks * 5,
        "持球拍 {} 未显著多于松散球拍 {}——检查 population 是否选错", main_ticks, ball_ticks);
}

/// 防空转：真实 seed 上导出的量必须是有限数且非退化。
#[test]
fn gates_are_finite_and_not_vacuous() {
    let g = gates::gates_of(1, DUR);
    assert!(g.chains_per_game > 50, "episode 数 {} 太少", g.chains_per_game);
    assert!(g.carrier_ticks > 1000, "持球拍 {} 太少", g.carrier_ticks);
    assert!(g.n_pass > 100, "传球数 {} 太少", g.n_pass);
    for (name, v) in [
        ("chain_dur_mean", g.chain_dur_mean), ("gap_ss_mean", g.gap_ss_mean),
        ("cover_share", g.cover_share), ("shot_last_share", g.shot_last_share),
        ("pass_fail_c7", g.pass_fail_c7),
    ] {
        assert!(v.is_finite() && v >= 0.0, "{} = {}（应为有限非负数）", name, v);
    }
    assert!(g.cover_share <= 1.0 && g.shot_last_share <= 1.0 && g.pass_fail_c7 <= 1.0,
        "占比类量超过 1");
}

/// **C7 口径与 p17a 不同**——本守卫把差异钉住（防有人"顺手"改成同一个）。
#[test]
fn pass_fail_c7_differs_from_p17a_and_both_are_reported() {
    let g = gates::gates_of(1, DUR);
    assert!(g.pass_fail_c7 >= g.pass_fail_p17a,
        "C7 口径（含 out/contested）应 >= p17a 口径（只含 intercepted/lost）");
    assert!(g.pass_fail_c7 > g.pass_fail_p17a,
        "两者在本引擎上应**确实不同**（否则这条守卫空转）");
}

/// 落盘门：canary（30 seed）。
#[test]
#[ignore = "30 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p18_canary"]
fn p18_canary() {
    run_and_write("canary", CANARY_SEEDS.0, CANARY_SEEDS.1);
}

/// 落盘门：baseline（300 seed）。
#[test]
#[ignore = "300 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p18_baseline"]
fn p18_baseline() {
    run_and_write("baseline", BASELINE_SEEDS.0, BASELINE_SEEDS.1);
}

/// 扫文本守卫：**不得报 phase**（design §1 的不可越界 #2）。
///
/// ⚠️ 防自指：**先剥注释**再扫（规则说明本身就含禁串）。
/// ⚠️ 防空转：断言扫描面非空。
#[test]
fn wording_guard_rejects_phase_vocabulary() {
    // 扫**两个文件**（此前只扫 gates.rs，而本文件自称"不出现"——第一轮审阅抓到的不一致）
    let src = format!("{}\n{}", include_str!("p18/gates.rs"), include_str!("p18_behavior_gates.rs"));
    // 剥注释（行注释 + 块注释）
    let mut stripped = String::new();
    let mut in_block = false;
    for line in src.lines() {
        let mut l = line;
        if in_block {
            if let Some(i) = l.find("*/") { l = &l[i + 2..]; in_block = false; } else { continue; }
        }
        if let Some(i) = l.find("//") { l = &l[..i]; }
        if let Some(i) = l.find("/*") { in_block = true; l = &l[..i]; }
        stripped.push_str(l);
        stripped.push('\n');
    }
    assert!(stripped.len() > 500, "剥注释后扫描面过小（{} B）——守卫会空转", stripped.len());
    assert!(!stripped.contains("//"), "剥注释不彻底");
    for banned in ["build_up", "progression", "final_third", "attacking_transition"] {
        assert!(!stripped.contains(banned),
            "判据层出现 phase 词 `{}`（#16/#124 双负，phase 不可得；design §1 不可越界 #2）", banned);
    }
}

/// 守卫有判别力：**真的有违规的旧版本必须被判红**（本仓「防空转」纪律）。
#[test]
fn wording_guard_has_discriminating_power() {
    let bad = "let x = 1; // 注释\nlet y = \"final_third\";\n";
    let ok = "let x = 1; // final_third 只是注释\n";
    let strip = |src: &str| {
        let mut out = String::new(); let mut in_block = false;
        for line in src.lines() {
            let mut l = line;
            if in_block {
                if let Some(i) = l.find("*/") { l = &l[i + 2..]; in_block = false; } else { continue; }
            }
            if let Some(i) = l.find("//") { l = &l[..i]; }
            if let Some(i) = l.find("/*") { in_block = true; l = &l[..i]; }
            out.push_str(l); out.push('\n');
        }
        out
    };
    assert!(strip(bad).contains("final_third"), "违规样本应被抓到（判别力）");
    assert!(!strip(ok).contains("final_third"), "注释里的词应被剥掉（防自指）");
}
