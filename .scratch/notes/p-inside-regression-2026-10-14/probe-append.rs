

// ==== 临时只读探针（回归定性用；测完 `git checkout` 还原，不入库）====
// 任意 seed 块的 L3 读数：与 l3_shot_ratios 同口径同字段 + 按起脚桶分解（起源 vs 转化）。
#[test]
#[ignore]
fn zz_probe_l3_block() {
    let start: u64 = std::env::var("PROBE_START").ok().and_then(|s| s.parse().ok()).unwrap_or(401);
    let n: u64 = std::env::var("PROBE_N").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
    let stats: Vec<MatchStats> = (start..start + n).map(aggregate).collect();
    let nm = stats.len() as f64;
    let sm = |f: fn(&MatchStats) -> usize| stats.iter().map(f).sum::<usize>();
    let regular = sm(|s| s.n_shot_goal + s.n_shot_saved + s.n_shot_off);
    let header = sm(|s| s.n_header_goal + s.n_header_saved + s.n_header_off);
    let shots = regular + header;
    let goals = sm(|s| s.n_shot_goal + s.n_header_goal);
    let saved = sm(|s| s.n_shot_saved + s.n_header_saved);
    let box_goals = sm(|s| s.n_box_goal + s.n_header_goal);
    let (bs, as_, fs) = (sm(|s| s.n_box), sm(|s| s.n_arc), sm(|s| s.n_far));
    let (bg, ag, fg) = (sm(|s| s.n_box_goal), sm(|s| s.n_arc_goal), sm(|s| s.n_far_goal));
    let (hsv, hof) = (sm(|s| s.n_header_saved), sm(|s| s.n_header_off));
    println!(
        "[PROBE] start={} n={} shots={} regular={} header={} goals={} saved={} box_goals={} \
         box_shots={} arc_shots={} far_shots={} box_g={} arc_g={} far_g={} \
         禁区占比={:.4} sot={:.4} conv={:.4} box_conv={:.4} arc_conv={:.4} far_conv={:.4} \
         box_shot_share={:.4} header_g={} header_sv={} header_off={} shots_pm={:.4} goals_pm={:.4}",
        start, n, shots, regular, header, goals, saved, box_goals,
        bs, as_, fs, bg, ag, fg,
        box_goals as f64 / goals.max(1) as f64,
        (goals + saved) as f64 / shots as f64,
        goals as f64 / shots as f64,
        bg as f64 / bs.max(1) as f64,
        ag as f64 / as_.max(1) as f64,
        fg as f64 / fs.max(1) as f64,
        bs as f64 / regular.max(1) as f64,
        sm(|s| s.n_header_goal), hsv, hof,
        shots as f64 / nm,
        goals as f64 / nm
    );
}


// ==== 临时只读探针 2：桶口径对照（slab vs 罚球区矩形）====
// 引擎的「禁区内」= 到球门线的轴向距离 ≤ 16.5m（`aggregate` 的 dist_m，只看 x）。
// 真实锚的「禁区内」= 罚球区矩形：轴向 ≤ 16.5m **且** 横向 |y−0.5|·68 ≤ 20.16m。
// 前者是后者的超集。本探针同一批比赛上两种口径各算一遍。
#[test]
#[ignore]
fn zz_probe_geo_caliber() {
    let start: u64 = std::env::var("PROBE_START").ok().and_then(|s| s.parse().ok()).unwrap_or(401);
    let n: u64 = std::env::var("PROBE_N").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
    let half_w = 20.16 / PITCH_WIDTH_M; // 罚球区半宽，归一化
    let mut slab_shots = 0u64; let mut slab_goals = 0u64;
    let mut rect_shots = 0u64; let mut rect_goals = 0u64;
    let mut goals = 0u64; let mut shots = 0u64;
    let mut outside_wide_shots = 0u64; let mut outside_wide_goals = 0u64; // slab 内、矩形外
    let mut hdr_inside = 0u64; let mut hdr_outside = 0u64;
    for seed in start..start + n {
        let cfg = MatchConfig { match_duration_seconds: DUR, demo_mode: false, model_version: MODEL_VERSION };
        let json = simulate(seed, cfg);
        for e in split_events(&json) {
            if field_str(&e, "type").as_deref() != Some("shot") { continue; }
            let result = field_str(&e, "result").unwrap_or_default();
            let is_goal = result == "goal";
            let is_header = field_str(&e, "detail").as_deref() == Some("header");
            let subject = field_num(&e, "subject").unwrap_or(-1.0) as i32;
            let sx = field_num(&e, "x").unwrap_or(0.5);
            let sy = field_num(&e, "y").unwrap_or(0.5);
            let dist_m = if subject <= 10 { (1.0 - sx) * PITCH_LENGTH_M } else { sx * PITCH_LENGTH_M };
            shots += 1;
            if is_goal { goals += 1; }
            let in_slab = dist_m <= 16.5; // 同 aggregate 的硬编码
            let in_rect = in_slab && (sy - 0.5).abs() <= half_w;
            if in_slab { slab_shots += 1; if is_goal { slab_goals += 1; } }
            if in_rect { rect_shots += 1; if is_goal { rect_goals += 1; } }
            if in_slab && !in_rect { outside_wide_shots += 1; if is_goal { outside_wide_goals += 1; } }
            if is_header { if in_rect { hdr_inside += 1; } else { hdr_outside += 1; } }
        }
    }
    println!("[GEO] start={} n={} shots={} goals={} \
        slab_shots={} slab_goals={} rect_shots={} rect_goals={} \
        wide_only_shots={} wide_only_goals={} hdr_in_rect={} hdr_out_rect={}",
        start, n, shots, goals, slab_shots, slab_goals, rect_shots, rect_goals,
        outside_wide_shots, outside_wide_goals, hdr_inside, hdr_outside);
}
