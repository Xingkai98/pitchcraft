//! Football Manager clone — match engine (P0).
//!
//! 纯逻辑、平台无关的事件引擎：数据进、事件流出，不假设文件系统/命令行。
//! 可被 WASM 与 Tauri 内嵌两种方式消费。
//!
//! 设计（对齐 OpenSpec change p0-event-to-pitch）：
//! - 事件 = 一次决策的产物（对齐 FM 切片），不是物理帧。
//! - 坐标 = 球场归一化 (0-1)，x 左门线→右门线，y 下边线→上边线。
//! - 确定性：种子 RNG（同种子同配置 → 同事件流）。
//! - 纯随机事件流 + 简单约束（Q1/Q9）：传球朝队友、射门在对方半场、带球朝对方球门。

mod rng;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use rng::SeededRng;

/// 事件类型枚举（10 类：9 类动作 + lineup 初始站位；goal 由 shot.result=goal 表达）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventType {
    Lineup,
    Kickoff,
    Whistle,
    Pass,
    Dribble,
    Shot,
    Tackle,
    Interception,
    Substitution,
    OffBallRun,
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::Lineup => "lineup",
            EventType::Kickoff => "kickoff",
            EventType::Whistle => "whistle",
            EventType::Pass => "pass",
            EventType::Dribble => "dribble",
            EventType::Shot => "shot",
            EventType::Tackle => "tackle",
            EventType::Interception => "interception",
            EventType::Substitution => "substitution",
            EventType::OffBallRun => "off_ball_run",
        }
    }
}

/// 一条事件。字段对齐协议草案 v1。
/// 基础字段（t/type/subject/x/y）必填；类型相关字段可选。
#[derive(Debug, Clone)]
pub struct Event {
    pub t: f64,             // 比赛时间（秒）
    pub type_: EventType,   // 事件类型
    pub subject: i32,       // 主球员 id（0-10 home，11-21 away）
    pub x: f64,             // 发生位置（归一化 0-1）
    pub y: f64,             // 发生位置（归一化 0-1）
    pub from: Option<i32>,  // 来源球员 id（pass 的传球者）
    pub to: Option<i32>,    // 目标球员 id（pass 的接球者）
    pub x2: Option<f64>,    // 目标位置 x（pass 落点 / shot 方向 / dribble 终点）
    pub y2: Option<f64>,    // 目标位置 y
    pub result: Option<String>, // 结果（success/fail/goal/saved/off_target/blocked）
    pub speed: Option<f64>, // 球速/带球速度（m/s）
    pub touch_freq: Option<f64>, // 带球触球频率（次/秒）
    pub lead: Option<f64>,  // 传球提前量
    pub receiver_x: Option<f64>, // 接球者当前位置 x（pass 用，画面让接球者从这跑到落点，不瞬移）
    pub receiver_y: Option<f64>, // 接球者当前位置 y
    pub loose_x: Option<f64>,    // 抢断弹开点 x（tackle 用，球被捅开后滚向的位置）
    pub loose_y: Option<f64>,    // 抢断弹开点 y
    pub carrier_from_x: Option<f64>, // 被铲者带球起点 x（tackle 用，画面演"带球中被抢"）
    pub carrier_from_y: Option<f64>, // 被铲者带球起点 y
    pub keeper_x: Option<f64>,   // 门将当前位置 x（shot 用，画面让门将从实位扑救，不瞬移）
    pub keeper_y: Option<f64>,   // 门将当前位置 y
    pub score: Option<String>, // 比分（whistle/goal 时）
    pub detail: Option<String>, // 附加说明
    pub players: Option<Vec<(i32, f64, f64)>>, // lineup 事件的 22 球员站位 (id, x, y)
}

impl Event {
    /// 序列化为 JSON 行（简单手写，无 serde 依赖，保持零依赖从零写）。
    /// 只输出非 None 的字段。
    pub fn to_json(&self) -> String {
        let mut parts = Vec::new();
        parts.push(format!("\"t\":{:.3}", self.t));
        parts.push(format!("\"type\":\"{}\"", self.type_.as_str()));
        parts.push(format!("\"subject\":{}", self.subject));
        parts.push(format!("\"x\":{:.4}", self.x));
        parts.push(format!("\"y\":{:.4}", self.y));
        if let Some(f) = self.from { parts.push(format!("\"from\":{}", f)); }
        if let Some(t) = self.to { parts.push(format!("\"to\":{}", t)); }
        if let Some(x) = self.x2 { parts.push(format!("\"x2\":{:.4}", x)); }
        if let Some(y) = self.y2 { parts.push(format!("\"y2\":{:.4}", y)); }
        if let Some(r) = &self.result { parts.push(format!("\"result\":\"{}\"", r)); }
        if let Some(s) = self.speed { parts.push(format!("\"speed\":{:.1}", s)); }
        if let Some(t) = self.touch_freq { parts.push(format!("\"touch_freq\":{:.1}", t)); }
        if let Some(l) = self.lead { parts.push(format!("\"lead\":{:.2}", l)); }
        if let Some(rx) = self.receiver_x { parts.push(format!("\"receiver_x\":{:.4}", rx)); }
        if let Some(ry) = self.receiver_y { parts.push(format!("\"receiver_y\":{:.4}", ry)); }
        if let Some(x) = self.loose_x { parts.push(format!("\"loose_x\":{:.4}", x)); }
        if let Some(y) = self.loose_y { parts.push(format!("\"loose_y\":{:.4}", y)); }
        if let Some(x) = self.carrier_from_x { parts.push(format!("\"carrier_from_x\":{:.4}", x)); }
        if let Some(y) = self.carrier_from_y { parts.push(format!("\"carrier_from_y\":{:.4}", y)); }
        if let Some(x) = self.keeper_x { parts.push(format!("\"keeper_x\":{:.4}", x)); }
        if let Some(y) = self.keeper_y { parts.push(format!("\"keeper_y\":{:.4}", y)); }
        if let Some(s) = &self.score { parts.push(format!("\"score\":\"{}\"", s)); }
        if let Some(d) = &self.detail { parts.push(format!("\"detail\":\"{}\"", d)); }
        if let Some(players) = &self.players {
            let inner: Vec<String> = players.iter().map(|(id, x, y)| {
                let team = if *id <= 10 { "home" } else { "away" };
                format!("{{\"id\":{},\"team\":\"{}\",\"x\":{:.4},\"y\":{:.4}}}", id, team, x, y)
            }).collect();
            parts.push(format!("\"players\":[{}]", inner.join(",")));
        }
        format!("{{{}}}", parts.join(","))
    }
}

/// 最小 config 形状（S3 修复）：`{ match_duration_seconds }`。
/// P0 演示：`demo_mode: true` 时产出精简事件序列（各类型 1-2 个），便于逐动作观看。
#[derive(Debug, Clone, Copy)]
pub struct MatchConfig {
    pub match_duration_seconds: f64,
    pub demo_mode: bool,
}

impl MatchConfig {
    pub fn default_() -> Self {
        MatchConfig { match_duration_seconds: 2700.0, demo_mode: false }
    }
}

/// 球场真实尺寸（米）：归一化距离换算真实距离用。
pub const PITCH_LENGTH_M: f64 = 105.0;
pub const PITCH_WIDTH_M: f64 = 68.0;

// ---- 抢断参数（Phase B 常量；将来接战术票据04 / 属性票据05，替换为计算值）----
/// 就近阈值（米）：距持球者最近的防守者超过此距离则不产 tackle（避免跨半场逼抢）。
pub const TACKLE_DISTANCE_THRESHOLD_METERS: f64 = 10.0;
/// 抢断积极性：贴防时"真的去抢"的概率（低概率，只有少量机会去抢）。
/// 标定：~169 事件/场 × P(贴防≈0.7) × eagerness ≈ 目标 8-15 次/场 → 取 0.09。
pub const TACKLE_EAGERNESS: f64 = 0.09;
/// 抢断成功率（success/fail 各半，用户确认 50/50）。
pub const TACKLE_SUCCESS_RATE: f64 = 0.5;
/// 弹开距离（归一化，与 viewer config.interpretation.tackle.deflectDistance 对齐）。
pub const TACKLE_DEFLECT_DISTANCE: f64 = 0.05;

// ---- 事件驱动时间推进参数（grill Q11b 确认）----
/// 有球动作之间的"控球/决策间隔"（秒）：持球者控球观察、队友跑位的时间。
/// "卡住"由 fill 里的 carrier dribble 解决（持球者盘带不静止），hold 保持 8-15s 维持 tackle 频率目标。
pub const POSSESSION_HOLD_MIN: f64 = 8.0;
pub const POSSESSION_HOLD_MAX: f64 = 15.0;
/// 无球跑位：事件间最大节奏停顿（秒），实际 clamp 到 0.1-0.4s——跑位背靠背产出，画面持续有动作。
pub const OFF_BALL_RUN_INTERVAL: f64 = 1.2;
/// 无球跑位距离范围（归一化，每事件 1-2m 对应约 0.01-0.02）。
pub const OFF_BALL_RUN_DIST: f64 = 0.02;

/// 球员初始站位（固定默认站位，Q8b：无阵型系统，开球时 22 人站合理位置）。
struct LineupPlayer {
    id: i32,
    x: f64,
    y: f64,
}

/// 生成 22 个球员的固定默认站位（home 攻左→右，away 攻右→左；坐标中立）。
/// home: 门将(0)在左门线，后卫/中场/前锋从后到前。
/// away: 门将(21)在右门线，后卫/中场/前锋从右到左。
fn default_lineup() -> Vec<LineupPlayer> {
    let mut v = Vec::with_capacity(22);
    // 主队 home id 0-10，从左往右进攻（4-4-2 阵型，11 人）
    let home_rows = [
        // (y 位置, x 位置) 门将、后卫线、中场线、前锋线
        (0.5, 0.02), // 门将
        (0.3, 0.18), (0.5, 0.20), (0.7, 0.18), (0.5, 0.14), // 后卫 4
        (0.2, 0.40), (0.4, 0.42), (0.6, 0.42), (0.8, 0.40), // 中场 4
        (0.35, 0.62), (0.65, 0.62), // 前锋 2
    ];
    for (i, (y, x)) in home_rows.iter().enumerate() {
        v.push(LineupPlayer { id: i as i32, x: *x, y: *y });
    }
    // 客队 away id 11-21，从右往左进攻（镜像 4-4-2）
    // 门将 id = 21（对齐 viewer/mock 约定：home 门将 0，away 门将 21）
    let away_rows = [
        (0.5, 0.98), // 门将
        (0.3, 0.82), (0.5, 0.80), (0.7, 0.82), (0.5, 0.86), // 后卫 4
        (0.2, 0.60), (0.4, 0.58), (0.6, 0.58), (0.8, 0.60), // 中场 4
        (0.35, 0.38), (0.65, 0.38), // 前锋 2
    ];
    for (i, (y, x)) in away_rows.iter().enumerate() {
        v.push(LineupPlayer { id: 21 - i as i32, x: *x, y: *y });
    }
    v
}

/// 生成初始站位事件（lineup，B1 修复）。
/// 携带 22 个 {id, x, y} 初始站位，viewer 纯从事件流获知所有球员初始位置。
fn lineup_event(t: f64, lineup: &[LineupPlayer]) -> Event {
    Event {
        t,
        type_: EventType::Lineup,
        subject: 0,
        x: 0.5,
        y: 0.5,
        from: None,
        to: None,
        x2: None,
        y2: None,
        result: None,
        speed: None,
        touch_freq: None,
        lead: None,
        receiver_x: None,
        receiver_y: None,
        loose_x: None,
        loose_y: None,
        carrier_from_x: None,
        carrier_from_y: None,
        keeper_x: None, keeper_y: None,
        score: None,
        detail: None,
        players: Some(lineup.iter().map(|p| (p.id, p.x, p.y)).collect()),
    }
}

/// 引擎主入口：模拟一场最小比赛，返回事件流 JSON 字符串。
pub fn simulate(seed: u64, config: MatchConfig) -> String {
    if config.demo_mode {
        return simulate_demo(seed, config);
    }
    let mut rng = SeededRng::new(seed);
    let mut events = Vec::new();
    let lineup = default_lineup();
    let dur = config.match_duration_seconds;

    // 初始站位事件（B1）
    events.push(lineup_event(0.0, &lineup));
    // 开球：中圈球员把球拨向中圈附近，speed 给正常传球速度（避免画面"蠕动"）
    events.push(Event {
        t: 0.0,
        type_: EventType::Kickoff,
        subject: 9, // home 前锋开球
        x: 0.5,
        y: 0.5,
        from: Some(9), to: Some(10),
        x2: Some(0.55), y2: Some(0.5),
        result: Some("success".to_string()),
        speed: Some(14.0), touch_freq: None, lead: Some(0.1),
        // 接球者 10 从站位 (0.62,0.65) 跑向落点 (0.55,0.5)，避免瞬移（审阅 minor-3）
        receiver_x: Some(0.62),
        receiver_y: Some(0.65),
        loose_x: None,
        loose_y: None,
        carrier_from_x: None,
        carrier_from_y: None,
        keeper_x: None, keeper_y: None,
        score: None, detail: None,
        players: None,
    });

    // 简单事件序列（Phase C：事件驱动时间，动作时长推进 + 无球跑位填满）
    let mut t = 0.5; // kickoff 拨球动画 ~0.5s 结束
    let mut home_score = 0;
    let mut away_score = 0;
    // 当前持球方（0=home，1=away）。初始 kickoff 事件固定为 home 9 拨给 10（见上），
    // 所以初始持球方 = home，carrier = 接球者 10（与 kickoff 事件状态自洽，避免 carrier_from 过期）。
    let mut possession: u32 = 0;
    let mut carrier: i32 = 10;
    // 每个球员的当前坐标，按 id 索引（pos[id] = 位置）。lineup 的 away 顺序是 21-i（镜像），
    // 所以不能直接 collect——要按 id 填入，保证 pos[id as usize] 正确。
    let mut pos: Vec<(f64, f64)> = vec![(0.0, 0.0); 22];
    for p in &lineup {
        pos[p.id as usize] = (p.x, p.y);
    }
    // 开球者 9 在中圈、接球者 10 到落点（与 kickoff 事件一致，避免开场瞬移）
    pos[9 as usize] = (0.5, 0.5);
    pos[10 as usize] = (0.55, 0.5);
    let mut carrier_from = (0.55, 0.5);
    // 上次抢断的 (防守者, 被铲者) 对：避免同对连续 re-tackle 乒乓（审阅 major）
    let mut last_tackle_pair: Option<(i32, i32)> = None;
    // 上一个"有球动作"事件（跳过 off_ball_run 填满）：用于 tackle 判断被铲者的带球段是否已由前一 dribble 演过
    let mut prev_action: Option<(EventType, i32, f64, f64)> = None; // (type, subject, end_x, end_y)

    // 开场准备期：开球后到第一个动作前，用无球跑位填满（避免开场定格）
    let open_span = 2.5f64.min(dur - t);
    fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, open_span, carrier, -1, true);

    while t < dur {
        // 随机事件类型：传球/带球/射门/抢断（每个事件驱动自己的时长）
        let roll = rng.next_u64() % 100;
        let team_home = possession == 0;

        // 抢断决策（Phase B，Q13/D4）：每个事件点检查防守者距离 + 抢断积极性。
        // 防守者贴防（≤阈值）且积极（should_tackle）才产 tackle，否则落回进攻事件。
        // 冷却：与上次抢断同一对 (防守者,被铲者) 时不立即再抢（避免乒乓）。
        let victim = carrier;
        let victim_pos = pos[victim as usize];
        let def_home = !team_home;
        let (def_id, def_pos, def_dist) = nearest_defender(&pos, victim_pos, def_home);
        let same_pair = last_tackle_pair == Some((def_id, victim));
        if !same_pair && def_dist <= TACKLE_DISTANCE_THRESHOLD_METERS && should_tackle(&mut rng) {
            // 抢断结果（50/50）
            let success = (rng.next_u64() % 100) < (TACKLE_SUCCESS_RATE * 100.0) as u64;
            let result = if success { "success" } else { "fail" };
            // 弹开点：确定性规则（与 viewer deflectPoint 同规则）
            let (loose_x, loose_y) = deflect_point(
                def_pos.0, def_pos.1, victim_pos.0, victim_pos.1,
                TACKLE_DEFLECT_DISTANCE, def_id, victim,
            );
            // 连续模式 dropCarryBeat 两端一致：若前一有球动作是同一被铲者的 dribble（落点==接触点），
            // viewer 丢弃 carry-beat（不重放带球段），引擎必须把 carrier_move 归零、carrier_from 设接触点。
            let prev_was_dribble_to_contact = match prev_action {
                Some((EventType::Dribble, subject, ex, ey)) if subject == victim
                    && (ex - victim_pos.0).abs() < 1e-6 && (ey - victim_pos.1).abs() < 1e-6 => true,
                _ => false,
            };
            let event_carrier_from = if prev_was_dribble_to_contact { victim_pos } else { carrier_from };
            events.push(Event {
                t, type_: EventType::Tackle,
                subject: def_id, from: None, to: Some(victim),
                x: def_pos.0, y: def_pos.1, x2: Some(victim_pos.0), y2: Some(victim_pos.1),
                result: Some(result.to_string()), speed: None, touch_freq: None,
                lead: None, score: None, detail: None,
                receiver_x: None, receiver_y: None,
                loose_x: Some(loose_x), loose_y: Some(loose_y),
                carrier_from_x: Some(event_carrier_from.0), carrier_from_y: Some(event_carrier_from.1),
                keeper_x: None, keeper_y: None,
                players: None,
            });
            // tackle 时长 = viewer 演绎完整时长（事件驱动，Q11b；两端一致避免连续播放时间错位）
            let carrier_move = if prev_was_dribble_to_contact { 0.0 } else { distance_meters(carrier_from, victim_pos) / 3.0 };
            let approach = distance_meters(def_pos, victim_pos) / 6.0;
            let t_contact = carrier_move.max(approach);
            let deflect = distance_meters(victim_pos, (loose_x, loose_y)) / 5.0;
            let chase = distance_meters(victim_pos, (loose_x, loose_y)) / 6.0;
            let dur_sec = t_contact + deflect + 0.15 + chase;
            if success {
                // 球权换到防守方，防守者到弹开点（下一事件从 loose 出发，不 snap）
                possession = if def_home { 0 } else { 1 };
                carrier = def_id;
                pos[def_id as usize] = (loose_x, loose_y);
                carrier_from = (loose_x, loose_y);
            } else {
                // fail：球权保留原持球者；被铲者追到弹开点拿回（pos 到 loose，与 viewer fail 演绎终态一致），
                // 防守者停在接触点（与 viewer fail 演绎一致）——保证下一事件从这些位置出发，不 snap。
                pos[victim as usize] = (loose_x, loose_y);
                carrier_from = (loose_x, loose_y);
                pos[def_id as usize] = victim_pos;
            }
            last_tackle_pair = Some((def_id, victim));
            prev_action = Some((EventType::Tackle, if success { def_id } else { victim }, loose_x, loose_y));
            t += dur_sec;
            // 持球者控球观察间隔，无球跑位填满
            let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
            let span = hold.min(dur - t);
            fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
            if t >= dur { break; }
            continue;
        }

        if roll < 45 {
            // pass（朝队友）：从当前持球者出发，接球者选离持球者最近的队友
            let from = carrier;
            let from_pos = pos[from as usize];
            let (to, to_pos) = nearest_teammate(&pos, from_pos, team_home, from);
            // 接球者当前位置（供画面让接球者从这跑到落点，不瞬移）
            let rx = pos[to as usize].0;
            let ry = pos[to as usize].1;
            // 传球约束：朝队友方向，落点在两人之间偏前（Q9）
            let lead = 0.1 + (rng.next_u64() % 30) as f64 / 100.0;
            let (x2, y2) = lead_point(from_pos, to_pos, lead);
            let speed = 12.0 + (rng.next_u64() % 130) as f64 / 10.0;
            events.push(Event {
                t, type_: EventType::Pass,
                subject: from, from: Some(from), to: Some(to),
                x: from_pos.0, y: from_pos.1, x2: Some(x2), y2: Some(y2),
                result: Some("success".to_string()), speed: Some(speed), lead: Some(lead),
                receiver_x: Some(rx), receiver_y: Some(ry),
                touch_freq: None, score: None, detail: None,
                loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                keeper_x: None, keeper_y: None,
                players: None,
            });
            // 传球时长 = 球飞行距离 ÷ 球速（事件驱动，Q11b）
            let dur_sec = distance_meters(from_pos, (x2, y2)) / speed;
            // 球权移到接球者
            pos[to as usize] = (x2, y2);
            carrier = to;
            carrier_from = (x2, y2); // 接球者带球起点 = 接球落点
            last_tackle_pair = None; // 实际产出了事件 → 清除冷却（同对可再抢）
            prev_action = Some((EventType::Pass, to, x2, y2));
            t += dur_sec;
            let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
            let span = hold.min(dur - t);
            fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
        } else if roll < 70 {
            // dribble（从持球者出发，朝对方球门推进）
            let p = carrier;
            let pos_p = pos[p as usize];
            let (x2, y2) = dribble_target(&mut rng, pos_p, team_home);
            let speed = 5.0 + (rng.next_u64() % 30) as f64 / 10.0;
            let tf = 1.0 + (rng.next_u64() % 6) as f64 / 10.0;
            events.push(Event {
                t, type_: EventType::Dribble,
                subject: p, from: None, to: None,
                x: pos_p.0, y: pos_p.1, x2: Some(x2), y2: Some(y2),
                result: Some("success".to_string()), speed: Some(speed), touch_freq: Some(tf),
                lead: None, score: None, detail: None,
                receiver_x: None, receiver_y: None,
                loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                keeper_x: None, keeper_y: None,
                players: None,
            });
            // 带球时长 = 带球距离 ÷ 带球速度（事件驱动，Q11b）
            let dur_sec = distance_meters(pos_p, (x2, y2)) / speed;
            pos[p as usize] = (x2, y2);
            carrier_from = pos_p; // 带球起点 = 本段带球起点
            last_tackle_pair = None; // 实际产出了事件 → 清除冷却
            prev_action = Some((EventType::Dribble, p, x2, y2));
            t += dur_sec;
            let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
            let span = hold.min(dur - t);
            fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
        } else {
            // shot（射门，在对方半场）
            let p = carrier;
            let pos_p = pos[p as usize];
            if (team_home && pos_p.0 > 0.5) || (!team_home && pos_p.0 < 0.5) {
                let (x2, y2) = shot_target(&mut rng, team_home);
                let speed = 22.0 + (rng.next_u64() % 80) as f64 / 10.0;
                let score_roll = rng.next_u64() % 100;
                let (result, scored) = if score_roll < 15 {
                    ("goal", true)
                } else if score_roll < 45 {
                    ("saved", false)
                } else {
                    ("off_target", false)
                };
                if scored {
                    if team_home { home_score += 1; } else { away_score += 1; }
                }
                // 门将当前位置（画面让门将从实位扑救，不瞬移）
                let gk_id = if team_home { 21 } else { 0 };
                let gk_pos = pos[gk_id as usize];
                events.push(Event {
                    t, type_: EventType::Shot,
                    subject: p, from: None, to: None,
                    x: pos_p.0, y: pos_p.1, x2: Some(x2), y2: Some(y2),
                    result: Some(result.to_string()), speed: Some(speed),
                    touch_freq: None, lead: None, score: None, detail: None,
                    receiver_x: None, receiver_y: None,
                    loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                    keeper_x: Some(gk_pos.0), keeper_y: Some(gk_pos.1),
                    players: None,
                });
                // 射门时长 = 球飞行距离 ÷ 球速（事件驱动，Q11b）
                let dur_sec = distance_meters(pos_p, (x2, y2)) / speed;
                last_tackle_pair = None; // 实际产出了射门事件 → 清除冷却
                prev_action = Some((EventType::Shot, p, x2, y2));
                if scored {
                    // 进球后重新开球：球先飞进球门（dur_sec），哨响 +2s，开球 +5s（grill Q5）。
                    // 事件顺序 = t 顺序：shot → 庆祝 fill → whistle → 准备 fill → 开球者走回中圈 → kickoff(拨球)。
                    // 丢球方前锋开球：home 进球→away 12；away 进球→home 9。
                    let kickoff_id = if team_home { 12 } else { 9 };
                    t += dur_sec; // 球进网
                    // 进球后门将扑到射门方向（y2），同步引擎 pos（避免下次射门 keeper_y 陈旧 → 门将瞬移，审阅 major）
                    pos[gk_id as usize] = (gk_pos.0, y2);
                    // 终场前进球：若剩余时间不足完整开球序列（~6s），跳过 kickoff（半场哨在 dur 处理），
                    // 避免 kickoff t > dur 导致 t 非单调（审阅 major，~1% seed 触发）。
                    if t + 6.0 >= dur {
                        break; // 结束比赛（半场哨在后面统一推）
                    }
                    // 庆祝期（~2s），无球跑位填满（排除开球者）
                    let span1 = 2.0f64.min(dur - t);
                    fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span1, carrier, kickoff_id, false);
                    events.push(Event {
                        t, type_: EventType::Whistle,
                        subject: 0, from: None, to: None,
                        x: 0.5, y: 0.5, x2: None, y2: None,
                        result: None, speed: None, touch_freq: None, lead: None,
                        receiver_x: None, receiver_y: None,
                        loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                        keeper_x: None, keeper_y: None,
                        score: Some(format!("{}-{}", home_score, away_score)),
                        detail: Some("kickoff_again".to_string()),
                        players: None,
                    });
                    // 准备期（~3s），无球跑位填满（排除开球者）
                    let span2 = 3.0f64.min(dur - t);
                    fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span2, carrier, kickoff_id, false);
                    // 开球者走回中圈（视觉过渡，避免 kickoff 硬编码中圈导致瞬移）
                    let kick_pos = pos[kickoff_id as usize];
                    if (kick_pos.0 - 0.5).abs() > 1e-6 || (kick_pos.1 - 0.5).abs() > 1e-6 {
                        let walk_speed = 3.0;
                        let dur_walk = distance_meters(kick_pos, (0.5, 0.5)) / walk_speed;
                        events.push(Event {
                            t, type_: EventType::OffBallRun,
                            subject: kickoff_id, from: None, to: None,
                            x: kick_pos.0, y: kick_pos.1, x2: Some(0.5), y2: Some(0.5),
                            result: Some("success".to_string()), speed: Some(walk_speed), touch_freq: None,
                            lead: None, score: None, detail: None,
                            receiver_x: None, receiver_y: None,
                            loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                            keeper_x: None, keeper_y: None,
                            players: None,
                        });
                        t += dur_walk;
                        pos[kickoff_id as usize] = (0.5, 0.5);
                        t += 0.1; // 走位终点 < kickoff 起点（避免同刻锚点排序问题）
                    }
                    // walk-back 可能让 t 超 dur（开球者远距离走回中圈）：超时则跳过 kickoff（半场哨在 dur 处理）
                    if t >= dur {
                        break;
                    }
                    // 开球一拨：球从中圈拨给开球者的同队附近球员（对齐 demo 开球，球不瞬移回中圈）。
                    // 落点按接球者当前位（lead_point 中圈→接球者），避免接球者被迫冲刺超远（审阅 major）。
                    let kickoff_receiver = if team_home { 11 } else { 10 }; // 同队附近球员
                    let receiver_pos = pos[kickoff_receiver as usize];
                    let (kickoff_x2, kickoff_y2) = lead_point((0.5, 0.5), receiver_pos, 0.1);
                    events.push(Event {
                        t, type_: EventType::Kickoff,
                        subject: kickoff_id, from: Some(kickoff_id), to: Some(kickoff_receiver),
                        x: 0.5, y: 0.5, x2: Some(kickoff_x2), y2: Some(kickoff_y2),
                        result: Some("success".to_string()), speed: Some(12.0),
                        touch_freq: None, lead: Some(0.1),
                        receiver_x: Some(receiver_pos.0),
                        receiver_y: Some(receiver_pos.1),
                        loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
                        keeper_x: None, keeper_y: None,
                        score: None, detail: None, players: None,
                    });
                    possession = if team_home { 1 } else { 0 };
                    carrier = kickoff_receiver;
                    pos[kickoff_receiver as usize] = (kickoff_x2, kickoff_y2);
                    carrier_from = (kickoff_x2, kickoff_y2);
                    prev_action = Some((EventType::Kickoff, kickoff_receiver, kickoff_x2, kickoff_y2));
                    // 控球观察间隔，无球跑位填满
                    let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
                    let span = hold.min(dur - t);
                    fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
                } else {
                    // 非进球（被扑/偏出）：球在门线 (x2, y2)，对方门将拿到球重新组织。
                    // 球权转给对方，持球者 = 对方门将，pos = 球落点（门线 x 侧, y2）——与 viewer 门将扑救终点一致。
                    possession = if team_home { 1 } else { 0 };
                    let gk = if team_home { 21 } else { 0 };
                    let gk_x = if team_home { 0.98 } else { 0.02 };
                    carrier = gk;
                    pos[gk as usize] = (gk_x, y2);
                    carrier_from = (gk_x, y2);
                    t += dur_sec;
                    let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
                    let span = hold.min(dur - t);
                    fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
                }
            } else {
                // 静默迭代：持球者不在进攻半场（shot guard 不满足），不产射门事件。
                // carrier_from 对称刷新（grill Q8），时间推进控球观察间隔。
                carrier_from = pos_p;
                let hold = POSSESSION_HOLD_MIN + (rng.next_u64() % ((POSSESSION_HOLD_MAX - POSSESSION_HOLD_MIN) as u64 + 1)) as f64;
                let span = hold.min(dur - t);
                fill_with_off_ball(&mut events, &mut rng, &mut pos, &mut t, span, carrier, -1, true);
            }
        }
    }

    // 半场哨
    events.push(Event {
        t: dur, type_: EventType::Whistle,
        subject: 0, from: None, to: None,
        x: 0.5, y: 0.5, x2: None, y2: None,
        result: None, speed: None, touch_freq: None, lead: None,
        receiver_x: None,
        receiver_y: None,
        loose_x: None,
        loose_y: None,
        carrier_from_x: None,
        carrier_from_y: None,
        keeper_x: None, keeper_y: None,
        score: Some(format!("{}-{}", home_score, away_score)),
        detail: Some("half_time".to_string()),
        players: None,
    });

    // 序列化
    let json: Vec<String> = events.iter().map(|e| e.to_json()).collect();
    format!("[{}]", json.join(","))
}

/// 精简演示：各事件类型独立展示，组间大间隔（不追求场景衔接，便于逐个确认单类事件演绎）。
/// 每组事件前用 lineup 复位球员站位 + 一个 kickoff 把球放中圈，保证每组独立。
/// 序列：kickoff → pass → dribble → shot(goal)+whistle+kickoff → tackle → shot(saved) → whistle
fn simulate_demo(seed: u64, config: MatchConfig) -> String {
    let _seed = seed;
    let lineup = default_lineup();
    let mut events = Vec::new();
    let mut t = 0.0;
    let dur = config.match_duration_seconds;

    // 用 helper 简化构造；支持 receiver_x/receiver_y（接球者当前位置）
    // 参数：(t, type, subject, x, y, from, to, x2, y2, result, speed, touch_freq, lead, rx, ry, score, detail, players)
    // 新字段（loose_x/y、carrier_from_x/y）默认 None；tackle 展示段手动补。
    fn ev(t: f64, type_: EventType, subject: i32, x: f64, y: f64,
          from: Option<i32>, to: Option<i32>, x2: Option<f64>, y2: Option<f64>,
          result: Option<String>, speed: Option<f64>, touch_freq: Option<f64>,
          lead: Option<f64>, rx: Option<f64>, ry: Option<f64>,
          score: Option<String>, detail: Option<String>,
          players: Option<Vec<(i32, f64, f64)>>) -> Event {
        Event { t, type_, subject, x, y, from, to, x2, y2, result, speed, touch_freq, lead, receiver_x: rx, receiver_y: ry, loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None, keeper_x: None, keeper_y: None, score, detail, players }
    }

    // 初始站位（唯一一次 lineup）
    events.push(lineup_event(0.0, &lineup));

    // ===== 每个事件类型单独展示，独立成段，组间间隔足够大 =====
    const GAP: f64 = 25.0;

    // 1. kickoff：中圈一拨（9→10），接球者 10 从站位跑向落点
    t += 1.0;
    events.push(ev(t, EventType::Kickoff, 9, 0.5, 0.5, Some(9), Some(10), Some(0.55), Some(0.5),
        Some("success".into()), Some(14.0), None, Some(0.1),
        Some(0.62), Some(0.65), None, None, None));

    // 2. pass：中场 5 传 6，起点=5 站位(0.40,0.20)，落点=6 附近(0.42,0.42)，接球者 6 从站位跑向落点
    t += GAP;
    events.push(ev(t, EventType::Pass, 5, 0.40, 0.20, Some(5), Some(6), Some(0.42), Some(0.42),
        Some("success".into()), Some(12.0), None, Some(0.15),
        Some(0.42), Some(0.40), None, None, None));

    // 3. dribble：6 从 (0.42,0.42) 带球推进到 (0.60,0.40)
    t += GAP;
    events.push(ev(t, EventType::Dribble, 6, 0.42, 0.42, None, None, Some(0.60), Some(0.40),
        Some("success".into()), Some(6.0), Some(1.2), None,
        None, None, None, None, None));

    // 4. shot（goal）：6 从 (0.60,0.40) 射向球门内（y2=0.53，偏右，在球门范围 0.455~0.545 内）进球。
    //    射门后等球飞到球门（~1.7s）再 whistle，whistle 后开球——避免 whistle 时球还在半空/瞬移回中圈。
    t += GAP;
    events.push(ev(t, EventType::Shot, 6, 0.60, 0.40, None, None, Some(0.98), Some(0.53),
        Some("goal".into()), Some(25.0), None, None,
        None, None, None, None, None));
    t += 2.0; // 等射门飞行完成（43m / 25m/s ≈ 1.7s），球进网
    events.push(ev(t, EventType::Whistle, 0, 0.5, 0.5, None, None, None, None,
        None, None, None, None,
        None, None, Some("1-0".into()), Some("goal".into()), None));
    // 球在门里多停一会（whistle 后 3s），再重新开球回中圈（away 前锋 12 开球拨给 15）
    t += 3.0;
    events.push(ev(t, EventType::Kickoff, 12, 0.5, 0.5, Some(12), Some(15), Some(0.52), Some(0.42),
        Some("success".into()), Some(14.0), None, Some(0.1),
        Some(0.58), Some(0.40), None, None, None));

    // 5. tackle：away 中场 15（站位 0.58,0.40）逼近持球者 6（home，0.44,0.42）抢断。
    //    6 正在带球（carrier_from=0.42,0.42），弹开点按 deflect_point 规则算。
    t += GAP;
    let (loose_x, loose_y) = deflect_point(0.58, 0.40, 0.44, 0.42, TACKLE_DEFLECT_DISTANCE, 15, 6);
    events.push(Event {
        t, type_: EventType::Tackle,
        subject: 15, from: None, to: Some(6),
        x: 0.58, y: 0.40, x2: Some(0.44), y2: Some(0.42),
        result: Some("success".to_string()), speed: None, touch_freq: None,
        lead: None, score: None, detail: None,
        receiver_x: None, receiver_y: None,
        loose_x: Some(loose_x), loose_y: Some(loose_y),
        carrier_from_x: Some(0.42), carrier_from_y: Some(0.42),
        keeper_x: None, keeper_y: None,
        players: None,
    });

    // 6. shot（saved）：6 从 (0.60,0.40) 射向球门内偏左（y2=0.47，门将扑向该侧救下），被扑
    t += GAP;
    events.push(ev(t, EventType::Shot, 6, 0.60, 0.40, None, None, Some(0.98), Some(0.47),
        Some("saved".into()), Some(25.0), None, None,
        None, None, None, None, None));

    // 7. 结束哨
    t = dur;
    events.push(ev(t, EventType::Whistle, 0, 0.5, 0.5, None, None, None, None,
        None, None, None, None,
        None, None, Some("1-0".into()), Some("half_time".into()), None));

    let json: Vec<String> = events.iter().map(|e| e.to_json()).collect();
    format!("[{}]", json.join(","))
}

/// 归一化距离 → 真实米（考虑球场长宽比）
fn distance_meters(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = (a.0 - b.0) * PITCH_LENGTH_M;
    let dy = (a.1 - b.1) * PITCH_WIDTH_M;
    (dx * dx + dy * dy).sqrt()
}

/// 找离位置 pos 最近的防守方球员（tackle 用：防守者只抢附近的人，避免跨半场狂奔）。
/// 用实时 pos[]（非静态站位）。`def_home` = 防守方是否 home。
/// 排除门将（home GK id=0，away GK id=21）——门将不参与抢断。
/// 返回 (id, 位置, 距离米)。
fn nearest_defender(pos: &[(f64, f64)], target: (f64, f64), def_home: bool) -> (i32, (f64, f64), f64) {
    let mut best = None;
    let mut best_dist = f64::MAX;
    for (id, &p) in pos.iter().enumerate() {
        let is_def = if def_home { id <= 10 } else { id >= 11 };
        if !is_def { continue; }
        // 门将不参与抢断（避免门将跑出禁区铲人）
        if id == 0 || id == 21 { continue; }
        let d = distance_meters(p, target);
        if d < best_dist {
            best_dist = d;
            best = Some((id as i32, p));
        }
    }
    let (id, p) = best.unwrap();
    (id, p, best_dist)
}

/// 决策：防守者是否真的去抢（抢断积极性）。将来接战术（票据04）/属性（票据05）。
fn should_tackle(rng: &mut SeededRng) -> bool {
    (rng.next_u64() % 100) < (TACKLE_EAGERNESS * 100.0) as u64
}

/// 无球跑位目标：从当前位置随机方向碎步移动 OFF_BALL_RUN_DIST（1-2m），越界钳制。
fn off_ball_target(rng: &mut SeededRng, p: (f64, f64)) -> (f64, f64) {
    let dir = ((rng.next_u64() % 100) as f64 / 50.0) - 1.0;
    let perp = ((rng.next_u64() % 100) as f64 / 50.0) - 1.0;
    let x = p.0 + dir * OFF_BALL_RUN_DIST;
    let y = p.1 + perp * OFF_BALL_RUN_DIST;
    (clamp01(x), clamp01(y))
}

/// 产出一条无球跑位事件：选一个非持球者随机碎步移动，并更新引擎 pos。
/// `exclude` = 额外排除的球员 id（-1 不排除；进球后重新开球前排除开球者）。
/// 返回事件时长（距离÷跑速）。
fn emit_off_ball_run(events: &mut Vec<Event>, rng: &mut SeededRng, pos: &mut [(f64, f64)], t: f64, carrier: i32, exclude: i32) -> f64 {
    let mut idx = (rng.next_u64() % 22) as usize;
    while idx as i32 == carrier || idx == 0 || idx == 21 || idx as i32 == exclude {
        idx = (rng.next_u64() % 22) as usize;
    }
    let p = pos[idx];
    let (x2, y2) = off_ball_target(rng, p);
    let speed = 2.0 + (rng.next_u64() % 20) as f64 / 10.0; // 2-4 m/s 跑速（无球碎步）
    let dur = distance_meters(p, (x2, y2)) / speed;
    events.push(Event {
        t, type_: EventType::OffBallRun,
        subject: idx as i32, from: None, to: None,
        x: p.0, y: p.1, x2: Some(x2), y2: Some(y2),
        result: Some("success".to_string()), speed: Some(speed), touch_freq: None,
        lead: None, score: None, detail: None,
        receiver_x: None, receiver_y: None,
        loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
        keeper_x: None, keeper_y: None, players: None,
    });
    pos[idx] = (x2, y2); // 同步引擎位置（off_ball_run 让球员实际移动了）
    dur
}

/// 持球者短带球（人球同步）：控球间隔内给持球者小幅盘带，避免其长时间静止
/// （用户报告"dribble 卡住不动"）。返回事件时长。
fn emit_carrier_dribble(events: &mut Vec<Event>, rng: &mut SeededRng, pos: &mut [(f64, f64)], t: f64, carrier: i32) -> f64 {
    let p = pos[carrier as usize];
    let (x2, y2) = off_ball_target(rng, p);
    let speed = 3.0 + (rng.next_u64() % 20) as f64 / 10.0; // 3-5 m/s 带球
    let dur = distance_meters(p, (x2, y2)) / speed;
    events.push(Event {
        t, type_: EventType::Dribble,
        subject: carrier, from: None, to: None,
        x: p.0, y: p.1, x2: Some(x2), y2: Some(y2),
        result: Some("success".to_string()), speed: Some(speed), touch_freq: Some(1.0),
        lead: None, score: None, detail: None,
        receiver_x: None, receiver_y: None,
        loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None,
        keeper_x: None, keeper_y: None, players: None,
    });
    pos[carrier as usize] = (x2, y2); // 同步引擎位置（持球者盘带移动了）
    dur
}

/// 用无球跑位事件填满 [t, t+span] 时间段，推进 t。事件按各自时长背靠背产出，
/// 中间留极小节奏停顿（0.1-0.4s），画面持续有动作。
/// `carrier_active` = true 时每 3 个队友跑位给持球者 1 个短带球（人球同步，持球者不静止）。
/// 进球后庆祝/准备期传 false（球在门内，持球者带球会瞬移球）。
fn fill_with_off_ball(events: &mut Vec<Event>, rng: &mut SeededRng, pos: &mut [(f64, f64)], t: &mut f64, span: f64, carrier: i32, exclude: i32, carrier_active: bool) {
    let mut elapsed = 0.0;
    let mut n = 0u64;
    while elapsed < span {
        let dur = if carrier_active && n % 3 == 2 && carrier != exclude && carrier != 0 && carrier != 21 {
            // 持球者短带球（人球同步）；进球开球前 exclude 持球者时不产；门将不盘带离门（避免射门后门将瞬移）
            emit_carrier_dribble(events, rng, pos, *t, carrier)
        } else {
            emit_off_ball_run(events, rng, pos, *t, carrier, exclude)
        };
        *t += dur;
        elapsed += dur;
        let pause = (OFF_BALL_RUN_INTERVAL - dur).min(0.4).max(0.1);
        *t += pause;
        elapsed += pause;
        n += 1;
    }
}

/// 弹开点：被铲者位置 + 逼近方向垂线 × 距离。确定性选边，优先场内，越界钳制，零距离退化。
/// 与 viewer deflectPoint 同规则（保证两端一致）。
fn deflect_point(sx: f64, sy: f64, vx: f64, vy: f64, dist: f64, tackler: i32, victim: i32) -> (f64, f64) {
    let dx = vx - sx;
    let dy = vy - sy;
    let len = dx.hypot(dy);
    // 零距离（防守者已在被铲者脚下）时退化：视作从左侧逼近 → 弹开沿垂直方向，保证有方向
    let (ux, uy) = if len == 0.0 { (1.0, 0.0) } else { (dx / len, dy / len) };
    let cand1 = (vx - uy * dist, vy + ux * dist);
    let cand2 = (vx + uy * dist, vy - ux * dist);
    let in1 = cand1.0 >= 0.0 && cand1.0 <= 1.0 && cand1.1 >= 0.0 && cand1.1 <= 1.0;
    let in2 = cand2.0 >= 0.0 && cand2.0 <= 1.0 && cand2.1 >= 0.0 && cand2.1 <= 1.0;
    let loose = if in1 && !in2 {
        cand1
    } else if in2 && !in1 {
        cand2
    } else if in1 && in2 {
        // 都在场内：按球员 id 确定性选边（与 viewer deflectPoint 的 (tackler*7+victim*3)%2 一致）
        if (tackler * 7 + victim * 3) % 2 == 1 { cand2 } else { cand1 }
    } else {
        cand1
    };
    (loose.0.clamp(0.0, 1.0), loose.1.clamp(0.0, 1.0))
}

/// 找离位置 pos 最近的队友（pass 用：传球者把球传给附近的人，避免乱传给远端的"看起来像对手"的位置）
/// from_id = 传球者，排除自己。用**当前** pos[]（实时位置）选人，
/// 而非静态站位——Phase C 的 off_ball_run 让球员漂移，若用静态站位选人，
/// 接球者会在极短球飞行时间内被迫冲刺超远距离（审阅 major：receiver sprint）。
fn nearest_teammate(pos: &[(f64, f64)], from_pos: (f64, f64), home: bool, from_id: i32) -> (i32, (f64, f64)) {
    let mut best = None;
    let mut best_dist = f64::MAX;
    for (id, &p) in pos.iter().enumerate() {
        let is_teammate = if home { id <= 10 } else { id >= 11 };
        if !is_teammate || id as i32 == from_id { continue; }
        let d = (p.0 - from_pos.0).powi(2) + (p.1 - from_pos.1).powi(2);
        if d < best_dist {
            best_dist = d;
            best = Some((id as i32, p));
        }
    }
    best.unwrap()
}

/// 传球落点：在传球者与接球者之间，偏向接球者前方（lead）
fn lead_point(from: (f64, f64), to: (f64, f64), lead: f64) -> (f64, f64) {
    let x = from.0 + (to.0 - from.0) * (0.6 + lead);
    let y = from.1 + (to.1 - from.1) * (0.6 + lead);
    (clamp01(x), clamp01(y))
}

/// 带球目标：朝对方球门方向推进
fn dribble_target(rng: &mut SeededRng, pos: (f64, f64), home: bool) -> (f64, f64) {
    let dir = if home { 1.0 } else { -1.0 };
    let x = pos.0 + dir * (0.05 + (rng.next_u64() % 10) as f64 / 100.0);
    let y = pos.1 + ((rng.next_u64() % 20) as f64 - 10.0) / 100.0;
    (clamp01(x), clamp01(y))
}

/// 射门目标：对方球门（x=1 或 x=0，y 靠近中线）
fn shot_target(rng: &mut SeededRng, home: bool) -> (f64, f64) {
    let x = if home { 0.98 } else { 0.02 };
    let y = 0.3 + (rng.next_u64() % 40) as f64 / 100.0; // 0.3-0.7
    (x, clamp01(y))
}

fn clamp01(v: f64) -> f64 {
    if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }
}

/// 暴露默认站位 JSON（B1：viewer 需要 22 球员初始位置）。
/// 格式：[{id,team,x,y}, ...]
pub fn default_lineup_json() -> String {
    let lineup = default_lineup();
    let parts: Vec<String> = lineup.iter().map(|p| {
        let team = if p.id <= 10 { "home" } else { "away" };
        format!("{{\"id\":{},\"team\":\"{}\",\"x\":{:.4},\"y\":{:.4}}}", p.id, team, p.x, p.y)
    }).collect();
    format!("[{}]", parts.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_events(s: &str) -> Vec<String> {
        // 把 "[{...},{...}]" 拆成单个 "{...}"
        s.trim_start_matches('[').trim_end_matches(']')
            .split("},{")
            .map(|p| format!("{{{}}}", p.trim_matches('{')))
            .collect()
    }

    #[test]
    fn simulate_same_seed_deterministic() {
        let cfg = MatchConfig::default_();
        let a = simulate(42, cfg);
        let b = simulate(42, cfg);
        assert_eq!(a, b);
    }

    #[test]
    fn simulate_different_seed_differs() {
        let cfg = MatchConfig::default_();
        let a = simulate(42, cfg);
        let b = simulate(43, cfg);
        assert_ne!(a, b);
    }

    #[test]
    fn simulate_produces_minimal_match() {
        let cfg = MatchConfig { match_duration_seconds: 2700.0, demo_mode: false };
        let s = simulate(7, cfg);
        let events = json_events(&s);
        // 至少含 kickoff、pass、dribble、shot、whistle
        let types = events.join(",");
        assert!(types.contains("\"type\":\"kickoff\""));
        assert!(types.contains("\"type\":\"pass\""));
        assert!(types.contains("\"type\":\"dribble\""));
        assert!(types.contains("\"type\":\"shot\""));
        assert!(types.contains("\"type\":\"whistle\""));
        assert!(types.contains("\"type\":\"lineup\""));
    }

    #[test]
    fn simulate_config_duration_respected() {
        let cfg_short = MatchConfig { match_duration_seconds: 60.0, demo_mode: false };
        let cfg_long = MatchConfig { match_duration_seconds: 2700.0, demo_mode: false };
        let s_short = simulate(7, cfg_short);
        let s_long = simulate(7, cfg_long);
        // 短比赛事件少
        assert!(s_short.len() < s_long.len());
    }

    #[test]
    fn coordinates_in_range() {
        let cfg = MatchConfig::default_();
        let s = simulate(7, cfg);
        // 所有 "x":N 和 "y":N 应在 0-1
        for cap in ["x", "y", "x2", "y2"].iter() {
            let needle = format!("\"{}\":", cap);
            let mut idx = 0;
            while let Some(pos) = s[idx..].find(&needle) {
                let start = idx + pos + needle.len();
                let end = s[start..].find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(s[start..].len());
                let val: f64 = s[start..start + end].parse().unwrap();
                assert!(val >= 0.0 && val <= 1.0, "coord {}={} out of range", cap, val);
                idx = start + end;
            }
        }
    }

    #[test]
    fn lineup_has_22_players() {
        let json = default_lineup_json();
        let count = json.matches("\"id\"").count();
        assert_eq!(count, 22);
    }

    // ---- Phase B：tackle 语义补全 ----

    fn has_tackle_with_new_fields(s: &str) -> bool {
        let events = json_events(s);
        events.iter().any(|e| {
            e.contains("\"type\":\"tackle\"")
                && e.contains("\"loose_x\":")
                && e.contains("\"loose_y\":")
                && e.contains("\"carrier_from_x\":")
                && e.contains("\"carrier_from_y\":")
        })
    }

    #[test]
    fn tackle_events_carry_loose_and_carrier_from() {
        // 多 seed 扫：tackle 是每事件点按距离阈值 + TACKLE_EAGERNESS 决策，不保证每个 seed 都有 tackle，
        // 故多 seed 扫描确保至少有一个带新字段。
        for seed in 1..30u64 {
            let cfg = MatchConfig { match_duration_seconds: 2700.0, demo_mode: false };
            let s = simulate(seed, cfg);
            if has_tackle_with_new_fields(&s) {
                return;
            }
        }
        panic!("没有任何 seed 产出带 loose/carrier_from 的 tackle 事件");
    }

    #[test]
    fn tackle_new_fields_coordinates_in_range() {
        for seed in 1..20u64 {
            let cfg = MatchConfig::default_();
            let s = simulate(seed, cfg);
            for cap in ["loose_x", "loose_y", "carrier_from_x", "carrier_from_y"].iter() {
                let needle = format!("\"{}\":", cap);
                let mut idx = 0;
                while let Some(pos) = s[idx..].find(&needle) {
                    let start = idx + pos + needle.len();
                    let end = s[start..].find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(s[start..].len());
                    let val: f64 = s[start..start + end].parse().unwrap();
                    assert!(val >= 0.0 && val <= 1.0, "coord {}={} out of range", cap, val);
                    idx = start + end;
                }
            }
        }
    }

    #[test]
    fn tackle_success_and_fail_both_reachable() {
        // 50/50：多 seed 扫，断言 success 与 fail 都能出现（用户确认 50/50）
        let mut saw_success = false;
        let mut saw_fail = false;
        for seed in 1..60u64 {
            let cfg = MatchConfig::default_();
            let s = simulate(seed, cfg);
            for e in json_events(&s) {
                if e.contains("\"type\":\"tackle\"") {
                    if e.contains("\"result\":\"success\"") { saw_success = true; }
                    if e.contains("\"result\":\"fail\"") { saw_fail = true; }
                }
            }
            if saw_success && saw_fail { break; }
        }
        assert!(saw_success, "应有 success 抢断");
        assert!(saw_fail, "应有 fail 抢断");
    }

    #[test]
    fn tackle_deterministic_with_new_fields() {
        // 同 seed → 新字段也一致
        let cfg = MatchConfig::default_();
        let a = simulate(42, cfg);
        let b = simulate(42, cfg);
        assert_eq!(a, b);
        // 至少一个 tackle 带 loose（不再用 || 逃生门）
        assert!(has_tackle_with_new_fields(&a), "seed 42 应产出带 loose/carrier_from 的 tackle");
    }

    #[test]
    fn demo_tackle_has_carrier_from_and_loose() {
        let cfg = MatchConfig { match_duration_seconds: 200.0, demo_mode: true };
        let s = simulate(42, cfg);
        let events = json_events(&s);
        let tackle = events.iter().find(|e| e.contains("\"type\":\"tackle\"")).expect("demo 应有 tackle");
        assert!(tackle.contains("\"carrier_from_x\":"));
        assert!(tackle.contains("\"loose_x\":"));
    }

    #[test]
    fn tackle_frequency_in_target_range() {
        // 用户确认目标：每场约 8-15 次 tackle（Q14）。多 seed 平均应落在 5-20（宽松边界，避免 flaky）。
        let mut total = 0u64;
        let n = 20u64;
        for seed in 1..=n {
            let cfg = MatchConfig::default_();
            let s = simulate(seed, cfg);
            total += json_events(&s).iter().filter(|e| e.contains("\"type\":\"tackle\"")).count() as u64;
        }
        let avg = total as f64 / n as f64;
        assert!(avg >= 5.0, "tackle 频率过低（平均 {:.1}/场），应落在目标 8-15 附近", avg);
        assert!(avg <= 20.0, "tackle 频率过高（平均 {:.1}/场），应落在目标 8-15 附近", avg);
    }

    /// 从单条事件 JSON 片段取指定字段（number/string）
    fn json_field(e: &str, name: &str) -> Option<String> {
        let needle = format!("\"{}\":", name);
        let idx = e.find(&needle)?;
        let rest = &e[idx + needle.len()..];
        let end = rest.find(|c: char| c == ',' || c == '}').unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }

    fn json_num(e: &str, name: &str) -> Option<f64> {
        json_field(e, name)?.parse().ok()
    }

    /// 是否指定 type（去掉 JSON 字符串引号比较）
    fn is_type(e: &str, t: &str) -> bool {
        match json_field(e, "type") {
            Some(v) => v.trim_matches('"') == t,
            None => false,
        }
    }

    #[test]
    fn tackle_fail_syncs_positions_for_continuity() {
        // 审阅 major：fail 后引擎 pos 必须与 viewer fail 演绎终态一致（被铲者到 loose、防守者停接触点），
        // 否则下一事件 snap。逐 seed 找 fail tackle，断言其后续动作事件的 subject 位置从一致位置出发。
        let mut checked = 0;
        for seed in 1..40u64 {
            let cfg = MatchConfig::default_();
            let s = simulate(seed, cfg);
            let evts = json_events(&s);
            // 过滤真正的"事件"：lineup 的 players 数组被 `},{` 拆成碎片，跳过无 "type" 的
            let evts: Vec<&str> = evts.iter().filter(|e| e.contains("\"type\":")).map(|e| e.as_str()).collect();
            for (i, e) in evts.iter().enumerate() {
                let is_fail = match json_field(e, "result") {
                    Some(v) => v.trim_matches('"') == "fail",
                    None => false,
                };
                if !is_type(e, "tackle") || !is_fail {
                    continue;
                }
                let victim = json_num(e, "to").expect("fail tackle 应有 to") as i32;
                let def = json_num(e, "subject").expect("fail tackle 应有 subject") as i32;
                let loose_x = json_num(e, "loose_x").expect("fail tackle 应有 loose_x");
                let loose_y = json_num(e, "loose_y").expect("fail tackle 应有 loose_y");
                let contact_x = json_num(e, "x2").expect("fail tackle 应有 x2");
                let contact_y = json_num(e, "y2").expect("fail tackle 应有 y2");
                // 找下一个非 lineup/whistle/kickoff 事件（动作事件）
                let mut next = None;
                for n in evts.iter().skip(i + 1) {
                    if is_type(n, "lineup") || is_type(n, "whistle") || is_type(n, "kickoff") { continue; }
                    next = Some(n);
                    break;
                }
                let n = next.expect("fail tackle 后应有动作事件");
                let n_subject = json_num(n, "subject").expect("下一事件应有 subject") as i32;
                let n_x = json_num(n, "x").expect("下一事件应有 x");
                let n_y = json_num(n, "y").expect("下一事件应有 y");
                if n_subject == victim {
                    // fail 后原持球者拿回球 → 下一事件从被铲者（victim）出发，位置 = loose
                    let d = distance_meters((n_x, n_y), (loose_x, loose_y));
                    assert!(d < 3.0, "fail 后下一事件应从 loose 出发（victim {}，距 loose {:.1}m）", victim, d);
                } else if n_subject == def {
                    // 防守者留在接触点 → 若下一事件是防守者，位置 = contact
                    let d = distance_meters((n_x, n_y), (contact_x, contact_y));
                    assert!(d < 3.0, "fail 后防守者下一事件应从 contact 出发（def {}，距 contact {:.1}m）", def, d);
                }
                checked += 1;
                if checked >= 20 { return; } // 足够样本
            }
        }
        assert!(checked > 0, "应有 fail tackle 被检查");
    }
}
