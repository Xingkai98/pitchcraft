// C1 movement↔tackle/foul 耦合分解探针（本轮使用后已从 engine/src/lib.rs 移除）。
// 复现：把以下三段按注释位置放回 lib.rs，`#[cfg(test)]` 一律写作 `#[cfg(all(test))]`
// （⚠ 写原文会触发本仓「源码扫描 split("#[cfg(test)]")」自指坑：扫描在生产段提前截断，
//   p31_*/p15_* 守卫集体误红）；然后 `cargo test --release --lib probe_coupling_decomp -- --ignored --nocapture`。
//
// 段 1：CouplingProbe 结构与 MatchState 字段（MatchState 结构体末尾 + MatchState::new 末尾）
//   struct MatchState { ... last_pass_pair, #[cfg(all(test))] coupling: CouplingProbe }
//   MatchState::new { ... last_pass_pair: None, #[cfg(all(test))] coupling: CouplingProbe::default() }
//
// 段 2：build_action_plan 内、resolution 之后
//
// 段 3：tests 模块内（run_match 之前）
//
// ===== 段 1 =====
/// C1 movement↔tackle/foul 耦合分解探针（**仅测试构建**）。
///
/// 只在 `evaluate_defensive_action` 的自然 deadline 评估点写；不进事件流、不耗 RNG、
/// 不参与任何决策。用途：回答「带球 hold% 改变时，抢断/犯规为什么掉」——
/// 评估点的最近防守者距离分布、禁区外犯规资格、纵深几何、carrier 行进量。
#[cfg(all(test))]
#[derive(Default, Clone)]
struct CouplingProbe {
    eval_natural: u64,
    /// 最近防守者到持球者距离，0.5 m 桶（下标 = floor(d·2)，封顶 31 = ≥15.5 m）
    dist_hist: [u64; 32],
    /// 犯规资格（禁区外）计数 / 禁区内计数
    foul_allowed: u64,
    foul_disallowed: u64,
    /// depth_lead（米）：防守者相对持球者的纵深领先，2 m 桶，下标 = clamp(floor((d+12)/2), 0..12)
    depth_hist: [u64; 13],
    /// 持球者 x（归一化，0.1 桶，10 档）
    carrier_x_hist: [u64; 10],
    /// 距上次评估的 carrier 位移（米），1 m 桶、封顶 11+
    carrier_move_hist: [u64; 12],
    last_carrier_pos: Option<(f64, f64)>,
    /// 评估时是否处于射门推进/起脚窗口状态
    in_shot_setup: u64,
    /// 被选动作是 Tackle / Foul 时的距离桶（同 dist_hist 口径）
    picked_tackle_dist: [u64; 32],
    picked_foul_dist: [u64; 32],
    /// 犯规资格口径对照：板条（x≤16.5，现行）vs 罚球区矩形（|y−0.5|·68≤20.16）
    foul_allowed_strip: u64,
    foul_allowed_rect: u64,
    /// 按 transition 相位分解：评估点数 / 被选 tackle / 被选 foul / <2m 的评估点数
    eval_transition: u64,
    picked_tackle_transition: u64,
    picked_foul_transition: u64,
    near2_transition: u64,
    near2_nontransition: u64,
    /// 最近防守者是否属于本 tick 的 close_down 指派者
    near_is_close_down: u64,
    near_is_formation: u64,
    /// 开放局逼抢门控：本评估点是否满足半场门控（gate off = 无逼抢指派）
    gate_on: u64,
    gate_off: u64,
    near2_gate_on: u64,
    near2_gate_off: u64,
    /// 被选动作发生时，持球者是否在射门推进/起脚状态
    picked_tackle_shot_setup: u64,
    picked_foul_shot_setup: u64,
}


// ===== 段 2 =====
    // 耦合分解探针（仅测试构建）：重算与 `evaluate_defensive_action` 相同的纯几何特征。
    #[cfg(all(test))]
    if trigger == OpportunityTrigger::NaturalDeadline
        && st.carrier > 0
        && st.carrier < 21
        && !st.sent_off[st.carrier as usize]
    {
        let victim = st.carrier;
        let vp = st.pos[victim as usize];
        let (def_id, _, _) = nearest_defender(st, vp, st.possession != 0);
        let f = defensive_features(st, def_id, vp);
        let in_transition = st.transition.is_some();
        let in_shot_setup = st.shot_setup.is_some();
        // 最近防守者是否属于本 tick 的 close_down 指派者（transition 2 人或开放局逼抢 1 人）。
        // 近似复算：开放局逼抢用与 `compute_mover_candidates` 相同的半场门控。
        let def_team = if st.possession != 0 { 0 } else { 1 };
        let cd_ids: Vec<i32> = if let Some(tr) = &st.transition {
            let tgt = match tr.source {
                TransitionSource::Tackle => st.ball_pos,
                TransitionSource::SaveCaught => attacking_forward(st, tr.attacking),
            };
            pick_close_down_players(st, 1 - tr.attacking, tgt, 2)
        } else if OPEN_PRESS_N > 0 {
            let def_home = st.possession != 0;
            let ball_x = st.ball_pos.0;
            let in_own_half = if def_home { ball_x < 0.5 } else { ball_x > 0.5 };
            let gate_ok = match OPEN_PRESS_GATE {
                0 => true,
                1 => in_own_half,
                2 => {
                    if def_home {
                        ball_x < 0.34
                    } else {
                        ball_x > 0.66
                    }
                }
                _ => true,
            };
            if gate_ok {
                pick_close_down_players(st, def_team, vp, OPEN_PRESS_N)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        let near_is_cd = cd_ids.contains(&def_id);
        let gate_on = st.transition.is_some() || {
            let def_home = st.possession != 0;
            let ball_x = st.ball_pos.0;
            match OPEN_PRESS_GATE {
                0 => true,
                1 => {
                    if def_home { ball_x < 0.5 } else { ball_x > 0.5 }
                }
                2 => {
                    if def_home { ball_x < 0.34 } else { ball_x > 0.66 }
                }
                _ => true,
            }
        };
        let near2 = f.dist_m < 2.0;
        let in_box_rect = (dist_to_goal_m(st, victim) <= BOX_DIST_M)
            && ((vp.1 - 0.5).abs() * PITCH_WIDTH_M <= 20.16);
        let cp = &mut st.coupling;
        cp.eval_natural += 1;
        cp.dist_hist[((f.dist_m * 2.0).max(0.0) as usize).min(31)] += 1;
        if f.foul_allowed {
            cp.foul_allowed += 1;
        } else {
            cp.foul_disallowed += 1;
        }
        if !in_box_rect {
            cp.foul_allowed_rect += 1;
        }
        if f.foul_allowed {
            cp.foul_allowed_strip += 1;
        }
        cp.depth_hist[(((f.depth_lead_m + 12.0) / 2.0).clamp(0.0, 12.0)) as usize] += 1;
        cp.carrier_x_hist[((vp.0.clamp(0.0, 0.9999)) * 10.0) as usize] += 1;
        if in_shot_setup {
            cp.in_shot_setup += 1;
        }
        if let Some((px, py)) = cp.last_carrier_pos {
            let moved = ((vp.0 - px).powi(2) * PITCH_LENGTH_M.powi(2)
                + (vp.1 - py).powi(2) * PITCH_WIDTH_M.powi(2))
            .sqrt();
            cp.carrier_move_hist[moved.floor().min(11.0) as usize] += 1;
        }
        cp.last_carrier_pos = Some(vp);
        if in_transition {
            cp.eval_transition += 1;
        }
        if f.dist_m < 2.0 {
            if in_transition {
                cp.near2_transition += 1;
            } else {
                cp.near2_nontransition += 1;
            }
        }
        if gate_on {
            cp.gate_on += 1;
            if near2 {
                cp.near2_gate_on += 1;
            }
        } else {
            cp.gate_off += 1;
            if near2 {
                cp.near2_gate_off += 1;
            }
        }
        if near_is_cd {
            cp.near_is_close_down += 1;
        } else {
            cp.near_is_formation += 1;
        }
        match defensive {
            DefensiveAction::Tackle => {
                cp.picked_tackle_dist[((f.dist_m * 2.0).max(0.0) as usize).min(31)] += 1;
                if in_transition {
                    cp.picked_tackle_transition += 1;
                }
                if in_shot_setup {
                    cp.picked_tackle_shot_setup += 1;
                }
            }
            DefensiveAction::Foul => {
                cp.picked_foul_dist[((f.dist_m * 2.0).max(0.0) as usize).min(31)] += 1;
                if in_transition {
                    cp.picked_foul_transition += 1;
                }
                if in_shot_setup {
                    cp.picked_foul_shot_setup += 1;
                }
            }
            _ => {}
        }
    }


// ===== 段 3 =====
    /// 临时探针（C1 movement↔tackle/foul 耦合分解）：hold 常数下逐场打印评估点几何。
    /// `cargo test --release probe_coupling_decomp -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_coupling_decomp() {
        fn merge(a: &mut CouplingProbe, b: &CouplingProbe) {
            a.eval_natural += b.eval_natural;
            a.foul_allowed += b.foul_allowed;
            a.foul_disallowed += b.foul_disallowed;
            a.in_shot_setup += b.in_shot_setup;
            a.foul_allowed_strip += b.foul_allowed_strip;
            a.foul_allowed_rect += b.foul_allowed_rect;
            a.eval_transition += b.eval_transition;
            a.picked_tackle_transition += b.picked_tackle_transition;
            a.picked_foul_transition += b.picked_foul_transition;
            a.near2_transition += b.near2_transition;
            a.near2_nontransition += b.near2_nontransition;
            a.near_is_close_down += b.near_is_close_down;
            a.near_is_formation += b.near_is_formation;
            a.gate_on += b.gate_on;
            a.gate_off += b.gate_off;
            a.near2_gate_on += b.near2_gate_on;
            a.near2_gate_off += b.near2_gate_off;
            a.picked_tackle_shot_setup += b.picked_tackle_shot_setup;
            a.picked_foul_shot_setup += b.picked_foul_shot_setup;
            for i in 0..32 {
                a.dist_hist[i] += b.dist_hist[i];
                a.picked_tackle_dist[i] += b.picked_tackle_dist[i];
                a.picked_foul_dist[i] += b.picked_foul_dist[i];
            }
            for i in 0..13 {
                a.depth_hist[i] += b.depth_hist[i];
            }
            for i in 0..10 {
                a.carrier_x_hist[i] += b.carrier_x_hist[i];
            }
            for i in 0..12 {
                a.carrier_move_hist[i] += b.carrier_move_hist[i];
            }
        }
        fn bins(h: &[u64], w: usize, unit: f64, off: f64) -> String {
            let mut out = Vec::new();
            for i in (0..h.len()).step_by(w) {
                let c: u64 = h[i..(i + w).min(h.len())].iter().sum();
                let lo = off + i as f64 * unit;
                out.push(format!("{lo:.0}+:{c}"));
            }
            out.join(" ")
        }
        fn mean_bucket(h: &[u64], unit: f64, off: f64) -> f64 {
            let n: u64 = h.iter().sum();
            if n == 0 {
                return f64::NAN;
            }
            let s: f64 = h
                .iter()
                .enumerate()
                .map(|(i, &c)| (off + i as f64 * unit) * c as f64)
                .sum();
            s / n as f64
        }
        let mut agg = CouplingProbe::default();
        for seed in [42u64, 7, 23, 11, 5, 17, 31, 3] {
            let (st, events) = run_match(seed, 5400.0);
            let tackle = events.iter().filter(|e| e.type_ == EventType::Tackle).count();
            let foul = events.iter().filter(|e| e.type_ == EventType::Foul).count();
            let shot_reg = events
                .iter()
                .filter(|e| e.type_ == EventType::Shot && e.detail.is_none())
                .count();
            let cp = st.coupling.clone();
            println!(
                "seed {}: tackle={} foul={} shot_reg={} eval_nat={} moves={} xmean={:.2}",
                seed,
                tackle,
                foul,
                shot_reg,
                cp.eval_natural,
                cp.in_shot_setup,
                mean_bucket(&cp.carrier_x_hist, 0.1, 0.05),
            );
            merge(&mut agg, &cp);
        }
        println!("== AGG 8 seeds ==");
        println!("eval_natural={} in_shot_setup={}", agg.eval_natural, agg.in_shot_setup);
        println!(
            "foul_allowed strip={} rect={}",
            agg.foul_allowed_strip, agg.foul_allowed_rect
        );
        println!(
            "transition: evals={} picked_tackle={} picked_foul={} near2_trans={} near2_form={}",
            agg.eval_transition,
            agg.picked_tackle_transition,
            agg.picked_foul_transition,
            agg.near2_transition,
            agg.near2_nontransition
        );
        println!(
            "gate_on={} gate_off={} | near2 on={} off={}",
            agg.gate_on, agg.gate_off, agg.near2_gate_on, agg.near2_gate_off
        );
        println!(
            "nearest is close_down={} formation={} | picked tackle in shot_setup={} foul={}",
            agg.near_is_close_down,
            agg.near_is_formation,
            agg.picked_tackle_shot_setup,
            agg.picked_foul_shot_setup
        );
        println!(
            "dist_hist (2m bins): {}",
            bins(&agg.dist_hist, 4, 0.5, 0.0)
        );
        println!(
            "foul_allowed={} ({:.1}%) disallowed={}",
            agg.foul_allowed,
            100.0 * agg.foul_allowed as f64 / (agg.foul_allowed + agg.foul_disallowed).max(1) as f64,
            agg.foul_disallowed
        );
        println!("depth_lead hist (6m bins from -12): {}", bins(&agg.depth_hist, 3, 2.0, -12.0));
        println!("carrier_x hist (0.1 bins): {}", bins(&agg.carrier_x_hist, 1, 0.1, 0.0));
        println!("carrier_move hist (1m bins): {}", bins(&agg.carrier_move_hist, 1, 1.0, 0.0));
        println!("mean carrier movement between evals (m): {:.2}", mean_bucket(&agg.carrier_move_hist, 1.0, 0.5));
        println!("picked_tackle_dist (2m bins): {}", bins(&agg.picked_tackle_dist, 4, 0.5, 0.0));
        println!("picked_foul_dist (2m bins): {}", bins(&agg.picked_foul_dist, 4, 0.5, 0.0));
        println!(
            "picked tackle mean dist={:.2} foul mean dist={:.2}",
            mean_bucket(&agg.picked_tackle_dist, 0.5, 0.25),
            mean_bucket(&agg.picked_foul_dist, 0.5, 0.25)
        );
    }

