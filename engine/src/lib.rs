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

/// 事件类型枚举（9 类：8 类动作 + lineup 初始站位；goal 由 shot.result=goal 表达）
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
        receiver_x: None,
        receiver_y: None,
        score: None, detail: None,
        players: None,
    });

    // 简单事件序列：每隔 ~12-20 秒产出一个事件（Q10：45 分钟约 100-200 条）
    let mut t = 3.0;
    let mut home_score = 0;
    let mut away_score = 0;
    // 当前持球方（0=home，1=away）
    let mut possession: u32 = rng.next_u32() % 2;
    // 当前持球者 id（初始：开球者）。事件从持球者出发，保证球权连贯。
    let mut carrier: i32 = if possession == 0 { 9 } else { 20 };
    // 每个球员的当前坐标，按 id 索引（pos[id] = 位置）。lineup 的 away 顺序是 21-i（镜像），
    // 所以不能直接 collect——要按 id 填入，保证 pos[id as usize] 正确。
    let mut pos: Vec<(f64, f64)> = vec![(0.0, 0.0); 22];
    for p in &lineup {
        pos[p.id as usize] = (p.x, p.y);
    }

    while t < dur {
        let dt = 12.0 + (rng.next_u64() % 9) as f64; // 12-20s
        t += dt;
        if t >= dur { break; }

        // 随机事件类型：传球/带球/射门/抢断
        let roll = rng.next_u64() % 100;
        let team_home = possession == 0;

        if roll < 45 {
            // pass（朝队友）：从当前持球者出发，接球者选离持球者最近的队友
            let from = carrier;
            let from_pos = pos[from as usize];
            let (to, to_pos) = nearest_teammate(&lineup, from_pos, team_home, from);
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
                players: None,
            });
            // 球权移到接球者
            pos[to as usize] = (x2, y2);
            carrier = to;
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
                players: None,
            });
            pos[p as usize] = (x2, y2);
        } else if roll < 88 {
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
                events.push(Event {
                    t, type_: EventType::Shot,
                    subject: p, from: None, to: None,
                    x: pos_p.0, y: pos_p.1, x2: Some(x2), y2: Some(y2),
                    result: Some(result.to_string()), speed: Some(speed),
                    touch_freq: None, lead: None, score: None, detail: None,
                    receiver_x: None, receiver_y: None,
                    players: None,
                });
                if scored {
                    // 进球后重新开球（whistle + kickoff）
                    events.push(Event {
                        t, type_: EventType::Whistle,
                        subject: 0, from: None, to: None,
                        x: 0.5, y: 0.5, x2: None, y2: None,
                        result: None, speed: None, touch_freq: None, lead: None,
                        receiver_x: None, receiver_y: None,
                        score: Some(format!("{}-{}", home_score, away_score)),
                        detail: Some("kickoff_again".to_string()),
                        players: None,
                    });
                    // 丢球方前锋开球：home 前锋 id=9，away 前锋 id=20
                    let kickoff_id = if team_home { 20 } else { 9 };
                    events.push(Event {
                        t, type_: EventType::Kickoff,
                        subject: kickoff_id, from: None, to: None,
                        x: 0.5, y: 0.5, x2: None, y2: None,
                        result: None, speed: None, touch_freq: None, lead: None,
                        receiver_x: None, receiver_y: None,
                        score: None, detail: None, players: None,
                    });
                    possession = if team_home { 1 } else { 0 };
                    carrier = kickoff_id;
                    pos[kickoff_id as usize] = (0.5, 0.5);
                }
            }
        } else {
            // tackle / interception（防守方动作）：防守者抢当前持球者 carrier
            let def_home = !team_home;
            let (p, pos_p) = random_player(&mut rng, &lineup, def_home);
            // 被铲者 = 当前持球者 carrier（只有持球人才会被 tackle）
            let victim = carrier;
            let victim_pos = pos[victim as usize];
            events.push(Event {
                t, type_: EventType::Tackle,
                subject: p, from: None, to: Some(victim),
                x: pos_p.0, y: pos_p.1, x2: Some(victim_pos.0), y2: Some(victim_pos.1),
                result: Some("success".to_string()), speed: None, touch_freq: None,
                lead: None, score: None, detail: None,
                receiver_x: None, receiver_y: None,
                players: None,
            });
            // 抢断成功 → 球权换到防守方，持球者变防守者
            possession = if def_home { 0 } else { 1 };
            carrier = p;
            pos[p as usize] = victim_pos;
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
    let mut rng = SeededRng::new(seed);
    let lineup = default_lineup();
    let mut events = Vec::new();
    let mut t = 0.0;
    let dur = config.match_duration_seconds;

    // 用 helper 简化构造；支持 receiver_x/receiver_y（接球者当前位置）
    // 参数：(t, type, subject, x, y, from, to, x2, y2, result, speed, touch_freq, lead, rx, ry, score, detail, players)
    fn ev(t: f64, type_: EventType, subject: i32, x: f64, y: f64,
          from: Option<i32>, to: Option<i32>, x2: Option<f64>, y2: Option<f64>,
          result: Option<String>, speed: Option<f64>, touch_freq: Option<f64>,
          lead: Option<f64>, rx: Option<f64>, ry: Option<f64>,
          score: Option<String>, detail: Option<String>,
          players: Option<Vec<(i32, f64, f64)>>) -> Event {
        Event { t, type_, subject, x, y, from, to, x2, y2, result, speed, touch_freq, lead, receiver_x: rx, receiver_y: ry, score, detail, players }
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

    // 5. tackle：away 中场 15（站位 0.58,0.40）逼近持球者 6（home，0.44,0.42）抢断
    t += GAP;
    events.push(ev(t, EventType::Tackle, 15, 0.58, 0.40, None, Some(6), Some(0.44), Some(0.42),
        Some("success".into()), None, None, None,
        None, None, None, None, None));

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

/// 随机选一个球员（主队或客队），返回 (id, 位置)
fn random_player(rng: &mut SeededRng, lineup: &[LineupPlayer], home: bool) -> (i32, (f64, f64)) {
    let idx = (rng.next_u64() % 11) as usize;
    // 选一个主队(0-10)或客队(11-21)的 id；客队 id 不连续（21-i），直接取 range
    let id = if home { idx as i32 } else { 11 + idx as i32 };
    // lineup 里找该 id（lineup 按 21-i 镜像排列，不能用下标）
    let p = lineup.iter().find(|p| p.id == id).expect("player in lineup");
    (id, (p.x, p.y))
}

/// 找离位置 pos 最近的对方球员（tackle 用：防守者只抢附近的人，避免跨半场狂奔）。
/// `attacking_home` = 持球方是否 home；被铲者是持球方球员，所以找持球方的人。
fn nearest_opponent(lineup: &[LineupPlayer], pos: (f64, f64), attacking_home: bool) -> (i32, (f64, f64)) {
    let mut best = None;
    let mut best_dist = f64::MAX;
    for p in lineup {
        let is_attacker = if attacking_home { p.id <= 10 } else { p.id >= 11 };
        if !is_attacker { continue; }
        let d = (p.x - pos.0).powi(2) + (p.y - pos.1).powi(2);
        if d < best_dist {
            best_dist = d;
            best = Some((p.id, (p.x, p.y)));
        }
    }
    best.unwrap()
}

/// 找离位置 pos 最近的队友（pass 用：传球者把球传给附近的人，避免乱传给远端的"看起来像对手"的位置）
/// from_id = 传球者，排除自己（pos 可能是传球者移动后的当前位置，静态站位里最近的可能是自己）
fn nearest_teammate(lineup: &[LineupPlayer], pos: (f64, f64), home: bool, from_id: i32) -> (i32, (f64, f64)) {
    let mut best = None;
    let mut best_dist = f64::MAX;
    for p in lineup {
        let is_teammate = if home { p.id <= 10 } else { p.id >= 11 };
        if !is_teammate || p.id == from_id { continue; }
        let d = (p.x - pos.0).powi(2) + (p.y - pos.1).powi(2);
        if d < best_dist {
            best_dist = d;
            best = Some((p.id, (p.x, p.y)));
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
}
