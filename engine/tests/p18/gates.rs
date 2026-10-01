//! P18 Slice 2：**引擎侧量导出**（判据需要的量，落成 JSON 供 JS 判据器读）。
//!
//! ## 为什么在这里（与 P17A / P17B 同款理由）
//!
//! 判据需要的量（`PossessionEpisode` / `ControlFact` / beat 的 `main`+`movers`）
//! 只存在于 **Rust sidecar**，wasm 不导出。所以引擎侧量必须由 Rust 导出成 JSON，
//! 而**判据逻辑只写一份**（JS），两侧都只读 JSON ⇒ 不存在"两边各写一份看起来一样的实现"。
//!
//! ## 复用而非重建
//!
//! `possesssion` 侧的 A 组量直接复用 `p17a/model.rs` + `p17a/metrics.rs`（`#[path]` 活读），
//! **不重写**。本文件只新增 P17A **没有**的量：
//!
//! - **B4**：持球拍中被防守方逼近覆盖的占比（用 `beat.main` 作持球者参照）
//! - **B 报告项**：防守方 `chase`/`close_down` 段（持球时）的起始距离/逼近量/时长/段数
//! - **C1'**：射门收尾链数/场（占比栏因分母不可比，只作护栏）
//!
//! ## ⚠️ 口径陷阱（第三轮 grill 的教训，写死在这里）
//!
//! **`beat.ball` 与 `beat.main` 完全互斥**（实测 `main+ball` 同有 = 0.0/场），
//! 且 `ball` **只在松散球拍**出现。**任何"防守方压迫持球者"的量必须用 `main` 作参照。**
//! 用 `ball` 会静默测成"松散球追球"（本 change 栽过一次，见 design §14）。
//!
//! ## ⚠️ 传球失败率有**三处口径**，本文件全部报出（显式声明）
//!
//! **① 失败事件的集合**：
//! `p17a::model::ActionKind::is_pass_failure()` 只含 `intercepted` + `lost`；
//! 而 P18 的 C7 映射把 `out` 与 `contested` **也算失败**（对齐真实侧的二分
//! `successful` / `unsuccessful`）。本文件**不调用 `is_pass_failure()`**，
//! 一律显式列出四个变体。
//!
//! **② 分母（更要紧）**：实测 30 seed，**事件流的 pass 有 11885 条，
//! 其中 610 条不归属任何 episode（且 610 条全是失败）**——那 610 条是**定位球交付**。
//! 真实侧的分母是 `player_possession`（**开放比赛**）⇒ **episode 口径才是对齐的**
//! （引擎 0.1286 vs 真实 0.1659），事件流口径 0.1733 把交付算了进去。
//! ⚠️ 这正是本仓「拿分解去比整体」的经典形态；**判据用 episode 口径**，
//! 事件流口径作对照栏并**显式标注差异来源**。

use crate::model::{derive_match, mean, quantile, sd, MatchRecord};
use fm_engine::{simulate_with_behavior_observations, MatchConfig, PITCH_LENGTH_M, PITCH_WIDTH_M};

/// 归一化坐标 → 米制距离（⚠️ 不乘球场尺寸的话所有距离都是 0.0x 量级，看起来像"没动"）。
pub fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    (((a.0 - b.0) * PITCH_LENGTH_M).powi(2) + ((a.1 - b.1) * PITCH_WIDTH_M).powi(2)).sqrt()
}

/// 逼近阈值（米/拍）。**不是拍脑袋**：实测 0.05–1.0 m 全区间只让覆盖占比从
/// 6.01% 动到 5.18%（design §9.9）。
pub const APPROACH_M_PER_TICK: f64 = 0.3;

/// 段内相邻拍的最大间隔（秒）。超过则认为是一次新的逼近段。
pub const SEG_GAP_SEC: f64 = 1.5;

/// 本地分位助手：`model::quantile` 要求已升序输入，这里负责排序（口径同 R type-7）。
fn pctl(v: &[f64], q: f64) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    quantile(&s, q)
}

#[derive(Debug, Clone, Default)]
pub struct MatchGates {
    // ── A 组（复用 p17a 的 EpisodeRecord）──
    pub chain_dur_mean: f64,
    pub gap_ss_mean: f64,
    pub acts_all_mean: f64,
    pub acts_pos_mean: f64,
    pub chains_per_game: usize,
    // ── C 组 ──
    pub shot_last_share: f64,
    pub shot_last_chains: usize,
    /// C7 主口径：**episode 内**的 pass 失败率（与真实侧 `player_possession` 对齐）
    pub pass_fail_c7: f64,
    /// 对照栏①：`p17a` 的失败集合（只含 intercepted/lost），同 episode 分母
    pub pass_fail_p17a: f64,
    /// 对照栏②：**事件流**口径（含定位球交付）——与真实侧**不对齐**，仅作审计
    pub pass_fail_eventstream: f64,
    pub n_pass: usize,
    pub n_pass_unattributed: usize,
    // ── B 组 ──
    /// **B4**：持球拍中「有防守方朝持球者逼近 > 阈值」的占比（自归一化）。
    pub cover_share: f64,
    pub carrier_ticks: usize,
    pub approach_instances: usize,
    // ── B 报告项：持球时的防守方 chase/close_down 段 ──
    pub pursue_seg_count: usize,
    /// ⚠️ 本段数是**任意防守方动作**逼近（不限 `chase`/`close_down`）——
    /// 数值远大于"只算 chase/close_down"（后者实测 ≈4/场，见 design §14）。
    pub pursue_start_dist: Vec<f64>,
    pub pursue_close: Vec<f64>,
    pub pursue_dur: Vec<f64>,
    /// 松散球拍上的 chase/close_down 段（**不同种群**，仅作对照，见 design §14）。
    pub loose_seg_count: usize,
}

#[derive(Clone)]
struct Seg {
    start_t: f64,
    last_t: f64,
    start_d: f64,
    end_d: f64,
}

/// 逐场派生（纯函数，只读 `DiagnosticMatch` 与正式事件流）。
pub fn gates_of(seed: u64, duration: f64) -> MatchGates {
    let cfg = MatchConfig { match_duration_seconds: duration, ..MatchConfig::default_() };
    let dm = simulate_with_behavior_observations(seed, cfg);
    let rec: MatchRecord = derive_match(seed, &dm);

    // ── A 组：复用 p17a 的 episode 记录 ──
    let mut dur_arr = Vec::new();
    let mut gap_ss_arr = Vec::new();
    let mut acts_all = Vec::new();
    let mut acts_pos = Vec::new();
    for ep in rec.episodes.iter() {
        acts_all.push(ep.action_count() as f64);
        if let Some(d) = ep.duration {
            if d > 0.0 {
                dur_arr.push(d);
                acts_pos.push(ep.action_count() as f64);
            }
        }
        gap_ss_arr.extend(ep.action_gaps.iter().copied());
    }
    // ⚠️ end→start 与 start→start 在本引擎上**恒等**——引擎的决策事件是**瞬时点**，
    // 没有"动作时长"这一项（两侧口径的一处已知差异，见 design §2.1）。
    // 故不单列 `gap_es_mean`（列了会是同一个数，制造"两个独立证据"的错觉）。

    // ── C 组 ──
    let mut shot_last = 0usize;
    let mut n_pass = 0usize;
    let mut fail_c7 = 0usize;
    let mut fail_p17a = 0usize;
    // 事件流口径（对照栏②）
    let mut ev_pass = 0usize;
    let mut ev_fail = 0usize;
    for e in dm.events.iter() {
        if e.type_.as_str() != "pass" { continue; }
        ev_pass += 1;
        if matches!(e.result.as_deref(), Some("intercepted") | Some("lost") | Some("out") | Some("contested")) {
            ev_fail += 1;
        }
    }
    for ep in rec.episodes.iter() {
        if ep.actions.last().map(|a| a.kind.is_shot()).unwrap_or(false) {
            shot_last += 1;
        }
        for a in ep.actions.iter() {
            use crate::model::ActionKind::*;
            if !a.kind.is_pass() { continue; }
            n_pass += 1;
            // P18 口径（对齐真实侧二分）
            if matches!(a.kind, PassIntercepted | PassLost | PassOut | PassContested) { fail_c7 += 1; }
            // p17a 口径（对照栏）
            if matches!(a.kind, PassIntercepted | PassLost) { fail_p17a += 1; }
        }
    }

    // ── B 组：逐 beat 扫描（⚠️ 持球者一律取 `main`，绝不用 `ball`）──
    let mut carrier_ticks = 0usize;
    let mut covered_ticks = 0usize;
    let mut approach_instances = 0usize;
    let mut pursue_opens: std::collections::BTreeMap<i32, Seg> = Default::default();
    let mut pursue_active: std::collections::BTreeSet<i32> = Default::default();
    let mut pursue_done: Vec<Seg> = Vec::new();
    let mut loose_seg_count = 0usize;
    let mut prev_t = f64::NEG_INFINITY;

    for e in dm.events.iter() {
        let Some(ms) = &e.movers else { continue };
        let Some(main) = &e.main else {
            // 无持球者（松散球拍或飞行拍）：把未完的段收口，但不计入 B 组。
            if let Some(b) = &e.ball {
                if b.loose {
                    loose_seg_count += ms.iter().filter(|m| m.action == "chase" || m.action == "close_down").count();
                }
            }
            for (_, s) in pursue_opens.iter() { pursue_done.push(s.clone()); }
            pursue_opens.clear();
            pursue_active.clear();
            prev_t = f64::NEG_INFINITY;
            continue;
        };
        carrier_ticks += 1;
        let cp = (main.x, main.y);
        let ct = if main.subject <= 10 { 0 } else { 1 };

        // 段跨界：拍间隔过大 ⇒ 全部收口
        if e.t - prev_t > SEG_GAP_SEC {
            for (_, s) in pursue_opens.iter() { pursue_done.push(s.clone()); }
            pursue_opens.clear();
            pursue_active.clear();
        }

        let mut cur: std::collections::BTreeSet<i32> = Default::default();
        let mut hit = false;
        for m in ms.iter() {
            let mt = if m.id <= 10 { 0 } else { 1 };
            if mt == ct { continue; }                       // 只看防守方
            let d0 = dist_m((m.from_x, m.from_y), cp);
            let d1 = dist_m((m.to_x, m.to_y), cp);
            if d0 - d1 <= APPROACH_M_PER_TICK { continue; } // 未逼近
            hit = true;
            approach_instances += 1;
            cur.insert(m.id);
            match pursue_opens.get_mut(&m.id) {
                Some(s) if e.t - s.last_t <= SEG_GAP_SEC => { s.last_t = e.t; s.end_d = d1; }
                Some(_) => {
                    pursue_done.push(pursue_opens.remove(&m.id).unwrap());
                    pursue_opens.insert(m.id, Seg { start_t: e.t, last_t: e.t, start_d: d0, end_d: d1 });
                }
                None => { pursue_opens.insert(m.id, Seg { start_t: e.t, last_t: e.t, start_d: d0, end_d: d1 }); }
            }
        }
        if hit { covered_ticks += 1; }
        // 本拍未再出现的 id：段结束
        for id in pursue_active.iter() {
            if !cur.contains(id) { if let Some(s) = pursue_opens.remove(id) { pursue_done.push(s); } }
        }
        pursue_active = cur;
        prev_t = e.t;
    }
    for (_, s) in pursue_opens { pursue_done.push(s); }

    MatchGates {
        chain_dur_mean: mean(&dur_arr),
        gap_ss_mean: mean(&gap_ss_arr),
        acts_all_mean: mean(&acts_all),
        acts_pos_mean: mean(&acts_pos),
        chains_per_game: rec.episodes.len(),
        shot_last_share: if rec.episodes.is_empty() { f64::NAN } else { shot_last as f64 / rec.episodes.len() as f64 },
        shot_last_chains: shot_last,
        pass_fail_c7: if n_pass == 0 { f64::NAN } else { fail_c7 as f64 / n_pass as f64 },
        pass_fail_p17a: if n_pass == 0 { f64::NAN } else { fail_p17a as f64 / n_pass as f64 },
        pass_fail_eventstream: if ev_pass == 0 { f64::NAN } else { ev_fail as f64 / ev_pass as f64 },
        n_pass,
        n_pass_unattributed: ev_pass.saturating_sub(n_pass),
        cover_share: if carrier_ticks == 0 { f64::NAN } else { covered_ticks as f64 / carrier_ticks as f64 },
        carrier_ticks,
        approach_instances,
        pursue_seg_count: pursue_done.len(),
        pursue_start_dist: pursue_done.iter().map(|s| s.start_d).collect(),
        pursue_close: pursue_done.iter().map(|s| s.start_d - s.end_d).collect(),
        pursue_dur: pursue_done.iter().map(|s| s.last_t - s.start_t + 1.0).collect(),
        loose_seg_count,
    }
}

/// 单场一行的机器可读记录（判据器读它）。
pub fn to_json_row(g: &MatchGates) -> String {
    let f = |x: f64| if x.is_finite() { format!("{:.6}", x) } else { "null".into() };
    format!(
        "{{\"chainDurPos\":{},\"gapSS\":{},\"actsAll\":{},\"actsPos\":{},\
\"chainsPerGame\":{},\"shotLastShare\":{},\"shotLastChains\":{},\
\"passFailC7\":{},\"passFailP17a\":{},\"passFailEventstream\":{},\"nPass\":{},\"nPassUnattributed\":{},\
\"coverShare\":{},\"carrierTicks\":{},\"approachInstances\":{},\
\"pursueSegCount\":{},\"pursueStartMean\":{},\"pursueCloseMean\":{},\"pursueDurMean\":{},\
\"looseSegCount\":{}}}",
        f(g.chain_dur_mean), f(g.gap_ss_mean), f(g.acts_all_mean), f(g.acts_pos_mean),
        g.chains_per_game, f(g.shot_last_share), g.shot_last_chains,
        f(g.pass_fail_c7), f(g.pass_fail_p17a), f(g.pass_fail_eventstream), g.n_pass, g.n_pass_unattributed,
        f(g.cover_share), g.carrier_ticks, g.approach_instances,
        g.pursue_seg_count, f(mean(&g.pursue_start_dist)), f(mean(&g.pursue_close)), f(mean(&g.pursue_dur)),
        g.loose_seg_count,
    )
}

/// 跨场汇总（逐场算再跨场平均，口径 C6）。
pub fn summarize(rows: &[MatchGates]) -> String {
    let per = |f: &dyn Fn(&MatchGates) -> f64| { rows.iter().map(f).collect::<Vec<_>>() };
    let stat = |name: &str, v: &[f64]| {
        let fin: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
        format!("\"{}\":{{\"center\":{:.6},\"sd\":{:.6},\"p10\":{:.6},\"p50\":{:.6},\"p90\":{:.6},\"n\":{}}}",
            name, mean(&fin), sd(&fin), pctl(&fin, 0.1), pctl(&fin, 0.5), pctl(&fin, 0.9), fin.len())
    };
    let parts = vec![
        stat("A_chainDurPos", &per(&|g| g.chain_dur_mean)),
        stat("A_gapSS", &per(&|g| g.gap_ss_mean)),
        stat("A_actsAll", &per(&|g| g.acts_all_mean)),
        stat("A_actsPos", &per(&|g| g.acts_pos_mean)),
        stat("A_chainsPerGame", &per(&|g| g.chains_per_game as f64)),
        stat("B_coverShare", &per(&|g| g.cover_share)),
        stat("B_pursueStartMean", &per(&|g| mean(&g.pursue_start_dist))),
        stat("B_pursueCloseMean", &per(&|g| mean(&g.pursue_close))),
        stat("B_pursueDurMean", &per(&|g| mean(&g.pursue_dur))),
        stat("B_pursueSegCount", &per(&|g| g.pursue_seg_count as f64)),
        stat("C_shotLastShare", &per(&|g| g.shot_last_share)),
        stat("C_shotLastChains", &per(&|g| g.shot_last_chains as f64)),
        stat("C_passFailC7", &per(&|g| g.pass_fail_c7)),
        stat("C_passFailP17a", &per(&|g| g.pass_fail_p17a)),
        stat("C_passFailEventstream", &per(&|g| g.pass_fail_eventstream)),
        stat("C_passUnattributed", &per(&|g| g.n_pass_unattributed as f64)),
    ];
    format!("{{{}}}", parts.join(","))
}
