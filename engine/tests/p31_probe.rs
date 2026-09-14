//! P31 临时探针（提交前删除）：量化现状出界/重开的**来源构成**，判断删槽位后
//! 角球/界外球是否会被结构性饿死。只用公开 API（simulate），不改引擎。
//!
//! 口径（与 realism.rs 一致的事件字段）：
//! - 槽位角球出界 = result=out ∧ detail=out_goal_line ∧ h=None ∧ lead=None（`emit_pass_out_play_slot` 唯一形态）
//! - 角球发球     = detail="corner"
//! - 界外球掷球   = detail="throw_in"
//! - 解围出底线   = result=out ∧ detail=out_goal_line ∧ h=Some(0.0)（`emit_clearance`）
//! - 开放传球出界 = result=out ∧ lead=Some（`emit_pass_highlight_inner` 的 out_roll）
//! - 门球开大脚   = subject∈{0,21} ∧ to=None（`start_goal_kick`）

use fm_engine::{simulate, MatchConfig, MODEL_VERSION};

fn split_events(s: &str) -> Vec<String> {
    let inner = s.trim_start_matches('[').trim_end_matches(']');
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in inner.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        cur.push(c);
        if c == '}' && depth == 0 {
            let t = cur.trim().trim_start_matches(',').trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
            cur.clear();
        }
    }
    out
}

fn ty(e: &str) -> String {
    let n = "\"type\":\"";
    match e.find(n) {
        Some(i) => e[i + n.len()..].split('"').next().unwrap_or("?").to_string(),
        None => "?".to_string(),
    }
}

fn fld<'a>(e: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("\"{}\":", name);
    let i = e.find(&needle)?;
    let rest = e[i + needle.len()..].trim_start();
    if let Some(inner) = rest.strip_prefix('"') {
        Some(&inner[..inner.find('"')?])
    } else {
        let end = rest.find(|c: char| c == ',' || c == '}').unwrap_or(rest.len());
        Some(rest[..end].trim())
    }
}

/// 标定②：开放比赛普通传球的**目标落点**（`receiver_x/y`）距边界的距离分布——
/// 决定「落点误差致出界」在几何上是否可达。
#[test]
#[ignore]
fn probe_landing_proximity() {
    let n = 200u64;
    let mut d_goal: Vec<f64> = Vec::new();
    let mut d_side: Vec<f64> = Vec::new();
    for seed in 1..=n {
        let cfg = MatchConfig { match_duration_seconds: 5400.0, demo_mode: false, model_version: MODEL_VERSION };
        let json = simulate(seed, cfg);
        for e in &split_events(&json) {
            if ty(e) != "pass" {
                continue;
            }
            if fld(e, "result") != Some("success") || fld(e, "detail").is_some() || fld(e, "h").is_none() {
                continue;
            }
            // **意图落点** = 事件的 x2/y2（= lead_point 输出，误差尚未叠加）
            let Some(x2) = fld(e, "x2").and_then(|v| v.parse::<f64>().ok()) else { continue };
            let Some(y2) = fld(e, "y2").and_then(|v| v.parse::<f64>().ok()) else { continue };
            d_goal.push(x2.min(1.0 - x2) * 105.0);
            d_side.push(y2.min(1.0 - y2) * 68.0);
        }
    }
    let stat = |v: &mut Vec<f64>, name: &str| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = v.len() as f64;
        let q = |p: f64| v[((n - 1.0) * p) as usize];
        let frac = |m: f64| v.iter().filter(|&&x| x < m).count() as f64 / n;
        println!(
            "[落点] {} n={} p05={:.1} p25={:.1} p50={:.1} p75={:.1}m  <1m:{:.3} <2m:{:.3} <3m:{:.3} <5m:{:.3}",
            name, n, q(0.05), q(0.25), q(0.50), q(0.75), frac(1.0), frac(2.0), frac(3.0), frac(5.0)
        );
    };
    stat(&mut d_goal, "距底线(x)");
    stat(&mut d_side, "距边线(y)");
}

#[test]
#[ignore]
fn probe_sources() {
    let n = 200u64;
    let dur = 5400.0;
    let (mut slot_corner_out, mut clearance_goal_out, mut openpass_out_goal, mut openpass_out_side) =
        (0usize, 0usize, 0usize, 0usize);
    let (mut corner_kick, mut throw_in_kick, mut free_kick) = (0usize, 0usize, 0usize);
    let (mut slot_throw_out, mut clearance_side_out) = (0usize, 0usize);
    let (mut pass_total, mut pass_lead, mut pass_out_total) = (0usize, 0usize, 0usize);
    let (mut shot, mut goal, mut tackle, mut foul, mut gk_pass) = (0usize, 0usize, 0usize, 0usize, 0usize);
    for seed in 1..=n {
        let cfg = MatchConfig { match_duration_seconds: dur, demo_mode: false, model_version: MODEL_VERSION };
        let json = simulate(seed, cfg);
        for e in &split_events(&json) {
            match ty(e).as_str() {
                "shot" => {
                    shot += 1;
                    if fld(e, "result") == Some("goal") {
                        goal += 1;
                    }
                }
                "tackle" => tackle += 1,
                "foul" => foul += 1,
                "pass" => {
                    pass_total += 1;
                    let result = fld(e, "result").unwrap_or("");
                    let detail = fld(e, "detail").unwrap_or("");
                    let has_lead = fld(e, "lead").is_some();
                    let h = fld(e, "h");
                    if has_lead {
                        pass_lead += 1;
                    }
                    if result == "out" {
                        pass_out_total += 1;
                        let is_slot = h.is_none() && !has_lead;
                        match (detail, is_slot, has_lead) {
                            ("out_goal_line", true, _) => slot_corner_out += 1,
                            ("out_goal_line", false, false) => clearance_goal_out += 1,
                            ("out_goal_line", false, true) => openpass_out_goal += 1,
                            ("out_sideline", true, _) => slot_throw_out += 1,
                            ("out_sideline", false, false) => clearance_side_out += 1,
                            ("out_sideline", false, true) => openpass_out_side += 1,
                            _ => {}
                        }
                    }
                    match detail {
                        "corner" => corner_kick += 1,
                        "throw_in" => throw_in_kick += 1,
                        "free_kick" => free_kick += 1,
                        _ => {}
                    }
                    if fld(e, "to").is_none() && matches!(fld(e, "subject"), Some("0") | Some("21")) {
                        gk_pass += 1;
                    }
                }
                _ => {}
            }
        }
    }
    let f = |v: usize| v as f64 / n as f64;
    println!("[P31 探针] {n} 场 × 90min，每场均值：");
    println!("  pass 事件 {}（有 lead={}）", f(pass_total), f(pass_lead));
    println!("  出界 pass 总数 {}", f(pass_out_total));
    println!("  槽位角球出界 {}  → 角球发球 {}", f(slot_corner_out), f(corner_kick));
    println!("  解围出底线   {}  → 角球发球", f(clearance_goal_out));
    println!("  开放传球出底线 {}（→ 门球）", f(openpass_out_goal));
    println!("  槽位界外球出界 {}  → 界外球掷球 {}", f(slot_throw_out), f(throw_in_kick));
    println!("  解围出边线   {}", f(clearance_side_out));
    println!("  开放传球出边线 {}（→ 界外球）", f(openpass_out_side));
    println!("  free_kick {}", f(free_kick));
    println!("  shot {} goal {} tackle {} foul {} gk_pass {}", f(shot), f(goal), f(tackle), f(foul), f(gk_pass));
}
