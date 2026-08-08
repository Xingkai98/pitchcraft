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

/// 事件类型枚举（v2：新增 beat 节拍；v1 类型保留；goal 由 shot.result=goal 表达）
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
    Beat,
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
            EventType::Beat => "beat",
        }
    }
}

/// beat 节拍的单个跑位球员（movers 数组元素）。
#[derive(Debug, Clone)]
pub struct Mover {
    pub id: i32,
    pub from_x: f64,
    pub from_y: f64,
    pub to_x: f64,
    pub to_y: f64,
    pub speed: f64,
    pub action: String,
}

/// beat 节拍的 main（带球/控球，carrier 每持球 tick 都发）。
#[derive(Debug, Clone)]
pub struct MainAction {
    pub subject: i32,
    pub x: f64,
    pub y: f64,
    pub x2: f64,
    pub y2: f64,
    pub speed: f64,
    pub touch_freq: f64,
}

/// beat 节拍的松散球（beat.ball，滚动轨迹）。
#[derive(Debug, Clone)]
pub struct BallState {
    pub x: f64,
    pub y: f64,
    pub x2: f64,
    pub y2: f64,
    pub speed: f64,
    pub loose: bool,
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
    pub carrier: Option<i32>, // 被铲者 id（v2 tackle；v1 的 to 身份语义迁移到 carrier）
    pub x2: Option<f64>,    // 目标位置 x（pass 落点 / shot 方向 / dribble 终点）
    pub y2: Option<f64>,    // 目标位置 y
    pub result: Option<String>, // 结果（success/fail/goal/saved/off_target；v2 shot 三值 goal/saved/off_target）
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
    // v2 beat 专用字段：beat 事件只输出 movers/main/ball，无顶层 subject/x/y。
    pub movers: Option<Vec<Mover>>, // beat: 并行跑位数组（增量，只含移动球员）
    pub main: Option<MainAction>,   // beat: 持球者带球/控球（carrier，main-only）
    pub ball: Option<BallState>,    // beat: 松散球（loose:true，滚动轨迹）
}

impl Default for Event {
    fn default() -> Self {
        Event {
            t: 0.0, type_: EventType::Lineup, subject: 0, x: 0.0, y: 0.0,
            from: None, to: None, carrier: None, x2: None, y2: None, result: None,
            speed: None, touch_freq: None, lead: None,
            receiver_x: None, receiver_y: None, loose_x: None, loose_y: None,
            carrier_from_x: None, carrier_from_y: None, keeper_x: None, keeper_y: None,
            score: None, detail: None, players: None,
            movers: None, main: None, ball: None,
        }
    }
}

impl Event {
    /// 序列化为 JSON 行（简单手写，无 serde 依赖，保持零依赖从零写）。
    /// 只输出非 None 的字段。beat 特判：无顶层 subject/x/y，输出 movers/main/ball。
    pub fn to_json(&self) -> String {
        let mut parts = Vec::new();
        parts.push(format!("\"t\":{:.3}", self.t));
        parts.push(format!("\"type\":\"{}\"", self.type_.as_str()));
        if self.type_ == EventType::Beat {
            if let Some(movers) = &self.movers {
                let inner: Vec<String> = movers.iter().map(|m| {
                    format!("{{\"id\":{},\"from_x\":{:.4},\"from_y\":{:.4},\"to_x\":{:.4},\"to_y\":{:.4},\"speed\":{:.1},\"action\":\"{}\"}}",
                        m.id, m.from_x, m.from_y, m.to_x, m.to_y, m.speed, m.action)
                }).collect();
                parts.push(format!("\"movers\":[{}]", inner.join(",")));
            }
            if let Some(m) = &self.main {
                parts.push(format!("\"main\":{{\"type\":\"dribble\",\"subject\":{},\"x\":{:.4},\"y\":{:.4},\"x2\":{:.4},\"y2\":{:.4},\"speed\":{:.1},\"touch_freq\":{:.1}}}",
                    m.subject, m.x, m.y, m.x2, m.y2, m.speed, m.touch_freq));
            }
            if let Some(b) = &self.ball {
                parts.push(format!("\"ball\":{{\"x\":{:.4},\"y\":{:.4},\"x2\":{:.4},\"y2\":{:.4},\"speed\":{:.1},\"loose\":{}}}",
                    b.x, b.y, b.x2, b.y2, b.speed, b.loose));
            }
            return format!("{{{}}}", parts.join(","));
        }
        parts.push(format!("\"subject\":{}", self.subject));
        parts.push(format!("\"x\":{:.4}", self.x));
        parts.push(format!("\"y\":{:.4}", self.y));
        if let Some(f) = self.from { parts.push(format!("\"from\":{}", f)); }
        if let Some(t) = self.to { parts.push(format!("\"to\":{}", t)); }
        if let Some(c) = self.carrier { parts.push(format!("\"carrier\":{}", c)); }
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
/// v2 标定：高亮 ~200/场 × tackle 掷出 32% × 贴防率 ≈ 目标 8-15 次/场 → 阈值 12m。
pub const TACKLE_DISTANCE_THRESHOLD_METERS: f64 = 12.0;
/// 抢断积极性：贴防时"真的去抢"的概率（低概率，只有少量机会去抢）。
/// v2 标定：贴防（≤12m）时以 0.15 去抢，过滤后 ~8-15 次/场。
pub const TACKLE_EAGERNESS: f64 = 0.15;
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
        carrier: None,
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
        movers: None, main: None, ball: None,
    }
}

/// 引擎主入口：模拟一场最小比赛，返回事件流 JSON 字符串。
// ==== v2 并行节拍（P4 parallel-beats）====

/// 固定 tick 时长（秒）
pub const TICK_SECONDS: f64 = 1.0;
/// movers 位移阈值 = 静区（dead-zone），等值 ~0.5m（移动 ⇔ 发 movers）
pub const DEAD_ZONE_METERS: f64 = 0.5;
/// 松散球拾取半径（米）
pub const PICKUP_RADIUS_METERS: f64 = 0.5;
/// 松散球最长持续 tick 数；超时球 hold 等待（不瞬移）
pub const LOOSE_MAX_TICKS: u32 = 2;
/// carrier 带球速度上限（m/s）：main 每拍推进 ≤ speed×1s
pub const CARRIER_SPEED_MS: f64 = 5.0;
/// 无球跑位速度（m/s）
pub const RUN_SPEED_MS: f64 = 4.0;
/// 门将回位速度（m/s）
pub const GK_SPEED_MS: f64 = 3.0;
/// 持球 hold 门控下限/上限（tick）
pub const HOLD_MIN_TICKS: u32 = 8;
pub const HOLD_MAX_TICKS: u32 = 15;

// ---- P5 队形/攻防转换参数 ----
/// 球侧平移幅度（归一化）：球到边线时全队横向偏移量（≈6m）
pub const SIDE_SHIFT_FACTOR: f64 = 0.06;
/// 防线前压幅度（归一化）：球到前场时防线推进量（≈12m）
pub const DEFENSE_PUSH_FACTOR: f64 = 0.12;
/// 控球阶段压上偏移（归一化）：己方持球前压 / 对方持球回收（≈2m）
pub const PRESS_UP_OFFSET: f64 = 0.02;
/// transition 窗口长度（tick）
pub const TRANSITION_TICKS: u32 = 4;
/// repulsion 最小间距（归一化，球员半径×2 ≈0.02）
pub const REPULSION_MIN_DIST: f64 = 0.02;
/// close_down 停点距目标距离（归一化，≈2m 压迫距离）
pub const CLOSE_DOWN_STOP_DIST: f64 = 0.02;

/// 米 → 归一化步进（沿 x 的近似换算；y 方向由 dist_norm 欧氏距离近似）
fn norm_step(meters: f64) -> f64 {
    meters / PITCH_LENGTH_M
}

/// 归一化欧氏距离
fn dist_norm(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// 从 from 向 to 移动 step（归一化）距离
fn move_toward(from: (f64, f64), to: (f64, f64), step: f64) -> (f64, f64) {
    let dx = to.0 - from.0;
    let dy = to.1 - from.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return from;
    }
    (from.0 + dx / len * step, from.1 + dy / len * step)
}

/// 掷持球 hold 上限（8-15 tick）
fn roll_hold_max(rng: &mut SeededRng) -> u32 {
    HOLD_MIN_TICKS + (rng.next_u64() % (HOLD_MAX_TICKS - HOLD_MIN_TICKS + 1) as u64) as u32
}

/// 找指定队中离 target 最近的外场球员（松散球追逐者；tackle 弹开限定抢断方）
fn nearest_in_team(pos: &[(f64, f64)], target: (f64, f64), team: u32) -> i32 {
    let mut best = -1;
    let mut best_d = f64::MAX;
    for (id, &p) in pos.iter().enumerate() {
        let is_team = if team == 0 { id <= 10 } else { id >= 11 };
        if !is_team { continue; }
        if id == 0 || id == 21 { continue; } // 门将不追松散球
        let d = (p.0 - target.0).powi(2) + (p.1 - target.1).powi(2);
        if d < best_d { best_d = d; best = id as i32; }
    }
    best
}

/// 找离 target 最近的球员（save-rebound 双方可争）
fn nearest_any(pos: &[(f64, f64)], target: (f64, f64)) -> i32 {
    let mut best = -1;
    let mut best_d = f64::MAX;
    for (id, &p) in pos.iter().enumerate() {
        if id == 0 || id == 21 { continue; }
        let d = (p.0 - target.0).powi(2) + (p.1 - target.1).powi(2);
        if d < best_d { best_d = d; best = id as i32; }
    }
    best
}

/// v2 比赛状态（固定 tick 推进 + 全员 pos）
struct MatchState {
    lineup: [(f64, f64); 22],
    pos: [(f64, f64); 22],
    ball_pos: (f64, f64), // 当前球位置（每 tick 按状态维护，供队形目标）
    possession: u32, // 0=home, 1=away
    carrier: i32,
    carrier_from: (f64, f64),
    hold_ticks: u32,
    hold_max: u32,
    last_emitted: [(f64, f64); 22],
    highlight: Option<Highlight>,
    loose: Option<LooseBall>,
    dead_ball: Option<DeadBall>,
    home_score: u32,
    away_score: u32,
    last_tackle_pair: Option<(i32, i32)>,
    // P5：静态防线身份（每队离己方门线最近的 4 名外场，default_lineup 基准）
    home_defenders: [i32; 4],
    away_defenders: [i32; 4],
    // P5：transition 叠加窗口（球权易主后的反击窗口；非第三状态，基础 phase 由 possession 推导）
    transition: Option<Transition>,
}

/// transition 叠加窗口（P5）
struct Transition {
    ticks_left: u32,
    attacking: u32, // 得球方（0=home, 1=away）
    source: TransitionSource,
}

/// transition 触发来源（决定 close_down 目标）
#[derive(Clone, Copy, PartialEq)]
enum TransitionSource {
    Tackle,     // close_down 目标 = 球位（松散球/持球者）
    SaveCaught, // close_down 目标 = 新进攻方就近前插球员（门前/禁区前沿）
}

impl MatchState {
    fn new(lineup: &[LineupPlayer]) -> Self {
        let mut pos = [(0.0, 0.0); 22];
        let mut lp = [(0.0, 0.0); 22];
        for p in lineup {
            pos[p.id as usize] = (p.x, p.y);
            lp[p.id as usize] = (p.x, p.y);
        }
        // 静态防线身份：home 取 x 最小 4 名外场（id 1-10），away 取 x 最大 4 名外场（id 11-20）
        let mut home_outs = vec![(lp[1].0, 1i32), (lp[2].0, 2), (lp[3].0, 3), (lp[4].0, 4), (lp[5].0, 5), (lp[6].0, 6), (lp[7].0, 7), (lp[8].0, 8), (lp[9].0, 9), (lp[10].0, 10)];
        home_outs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut away_outs = vec![(lp[11].0, 11i32), (lp[12].0, 12), (lp[13].0, 13), (lp[14].0, 14), (lp[15].0, 15), (lp[16].0, 16), (lp[17].0, 17), (lp[18].0, 18), (lp[19].0, 19), (lp[20].0, 20)];
        away_outs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let home_defenders = [home_outs[0].1, home_outs[1].1, home_outs[2].1, home_outs[3].1];
        let away_defenders = [away_outs[0].1, away_outs[1].1, away_outs[2].1, away_outs[3].1];
        MatchState {
            lineup: lp,
            pos,
            ball_pos: (0.55, 0.5),
            possession: 0,
            carrier: 10,
            carrier_from: (0.55, 0.5),
            hold_ticks: 0,
            hold_max: 0,
            last_emitted: pos,
            highlight: None,
            loose: None,
            dead_ball: None,
            home_score: 0,
            away_score: 0,
            last_tackle_pair: None,
            home_defenders,
            away_defenders,
            transition: None,
        }
    }
}

/// 飞行中高亮注册表（任意时刻至多一条）
struct Highlight {
    t_end: f64,
    participants: Vec<(i32, (f64, f64))>, // (id, 高亮结束位置)
    outcome: HighlightOutcome,
}

enum HighlightOutcome {
    PassCaught { receiver: i32, catch_pos: (f64, f64) },
    ShotGoal { kickoff_id: i32, ball_end: (f64, f64) },
    ShotSavedCaught { gk: i32, save_pos: (f64, f64) },
    ShotSavedRebound { gk: i32, rebound_from: (f64, f64), dir: (f64, f64) },
    ShotOffTarget { kickoff_id: i32, ball_end: (f64, f64) },
    GoalKick { land: (f64, f64) },
    TackleSuccess { def: i32, loose: (f64, f64), contact: (f64, f64) },
    TackleFail { victim: i32, contact: (f64, f64) },
}

/// 松散球（D11）
struct LooseBall {
    pos: (f64, f64),
    dir: (f64, f64),   // 滚动方向（归一化）
    speed: f64,        // 当前滚动速度（m/s，每 tick 阻尼递减）
    chaser: i32,
    ticks: u32,
}

/// 死球阶段（进球庆祝 / off_target，随后 kickoff 重开）
struct DeadBall {
    goal: bool,
    remaining: u32,
    preparing: bool,
    kickoff_id: i32,
    kicked: bool,
    receiver: i32,
    kickoff_end: f64, // kickoff 球飞行结束时刻（kicked 后有效；main 在其后首个 tick 边界恢复）
}

/// 引擎主入口：模拟一场比赛，返回事件流 JSON。
/// v2 非 demo：固定 tick + beat 节拍；demo_mode：v1 精简序列。
pub fn simulate(seed: u64, config: MatchConfig) -> String {
    if config.demo_mode {
        return simulate_demo(seed, config);
    }
    let mut rng = SeededRng::new(seed);
    let mut events = Vec::new();
    let lineup = default_lineup();
    let dur = config.match_duration_seconds;

    // 初始站位
    events.push(lineup_event(0.0, &lineup));
    // 开球：home 9 拨给 10
    events.push(Event {
        t: 0.0, type_: EventType::Kickoff, subject: 9,
        from: Some(9), to: Some(10),
        x: 0.5, y: 0.5, x2: Some(0.55), y2: Some(0.5),
        result: Some("success".to_string()), speed: Some(14.0), lead: Some(0.1),
        receiver_x: Some(0.62), receiver_y: Some(0.65),
        ..Event::default()
    });

    let mut st = MatchState::new(&lineup);
    st.pos[9] = (0.5, 0.5);
    st.pos[10] = (0.55, 0.5);
    st.carrier_from = (0.55, 0.5);
    st.hold_max = roll_hold_max(&mut rng);

    let mut t = TICK_SECONDS;
    while t < dur {
        tick(&mut st, &mut rng, &mut events, t);
        t += TICK_SECONDS;
    }
    // 终场前若高亮未 finalize（射门/传球飞行跨过 dur）：在 dur 时刻强制交接，比分按结局确认
    if st.highlight.is_some() {
        finalize_highlight(&mut st, &mut rng, &mut events, dur);
    }

    events.push(whistle_event(dur, st.home_score, st.away_score, "half_time"));
    let json: Vec<String> = events.iter().map(|e| e.to_json()).collect();
    format!("[{}]", json.join(","))
}

/// 构造 beat 事件（tick 节拍）
fn beat_event(t: f64, main: Option<MainAction>, ball: Option<BallState>, movers: Vec<Mover>) -> Event {
    Event {
        t, type_: EventType::Beat, subject: 0, x: 0.0, y: 0.0,
        movers: Some(movers), main, ball,
        ..Event::default()
    }
}

/// 构造 whistle 事件
fn whistle_event(t: f64, home: u32, away: u32, detail: &str) -> Event {
    Event {
        t, type_: EventType::Whistle, subject: 0, x: 0.5, y: 0.5,
        score: Some(format!("{}-{}", home, away)), detail: Some(detail.to_string()),
        ..Event::default()
    }
}

/// 单个 tick：推进状态 + 产事件（beat 或高亮）
fn tick(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    // 1. 死球阶段（transition 不在此阶段，进球/死球已清除）
    if st.dead_ball.is_some() {
        st.ball_pos = (0.5, 0.5); // 死球/准备/kickoff：球在中圈附近（队形目标用）
        advance_dead_ball(st, rng, events, t);
        return;
    }
    // transition 窗口统一递减（高亮/松散球/开放比赛都走，窗口从武装 tick 起算不延长）：
    // ticks_left == 1 时本 tick 清除（不再 transition）；>1 递减保持本 tick 生效。
    if let Some(tr) = &mut st.transition {
        if tr.ticks_left <= 1 {
            st.transition = None;
        } else {
            tr.ticks_left -= 1;
        }
    }
    // 2. 高亮进行中
    let hl_end = st.highlight.as_ref().map(|h| h.t_end);
    if let Some(t_end) = hl_end {
        if t >= t_end {
            finalize_highlight(st, rng, events, t);
        } else {
            // 高亮飞行中：beat 只含 movers（参与者排除，无 main/ball）
            st.ball_pos = highlight_ball_end(st.highlight.as_ref().unwrap());
            let excluded: Vec<i32> = st.highlight.as_ref().unwrap().participants.iter().map(|(id, _)| *id).collect();
            let movers = compute_movers(st, rng, t, &excluded);
            for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
            events.push(beat_event(t, None, None, movers));
        }
        return;
    }
    // 3. 松散球
    if st.loose.is_some() {
        st.ball_pos = st.loose.as_ref().unwrap().pos;
        advance_loose(st, rng, events, t);
        return;
    }
    // 4. 开放比赛：持球 hold 门控（transition 期间暂停，只产 main + movers）
    if st.transition.is_some() {
        emit_beat_with_main(st, rng, events, t);
    } else {
        st.hold_ticks += 1;
        if st.hold_ticks >= st.hold_max {
            roll_highlight(st, rng, events, t);
        } else {
            emit_beat_with_main(st, rng, events, t);
        }
    }
}

/// 高亮期间球位置（队形目标用）：按结局的球终点推导
fn highlight_ball_end(h: &Highlight) -> (f64, f64) {
    match &h.outcome {
        HighlightOutcome::PassCaught { catch_pos, .. } => *catch_pos,
        HighlightOutcome::ShotGoal { ball_end, .. } => *ball_end,
        HighlightOutcome::ShotSavedCaught { save_pos, .. } => *save_pos,
        HighlightOutcome::ShotSavedRebound { rebound_from, .. } => *rebound_from,
        HighlightOutcome::ShotOffTarget { ball_end, .. } => *ball_end,
        HighlightOutcome::GoalKick { land, .. } => *land,
        HighlightOutcome::TackleSuccess { loose, .. } => *loose,
        HighlightOutcome::TackleFail { contact, .. } => *contact,
    }
}

/// 开放比赛 tick：产 main（carrier 带球）+ movers
fn emit_beat_with_main(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let main = carrier_move(st, rng);
    st.ball_pos = st.pos[st.carrier as usize];
    let movers = compute_movers(st, rng, t, &[st.carrier]);
    for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
    events.push(beat_event(t, Some(main), None, movers));
}

/// carrier 带球（main）：多数 tick 零位移控球/短带，步进 ≤ speed×1s；transition 期间高速前插
fn carrier_move(st: &mut MatchState, rng: &mut SeededRng) -> MainAction {
    let p = st.pos[st.carrier as usize];
    let home = st.possession == 0;
    let is_gk = st.carrier == 0 || st.carrier == 21; // 门将持球恒零位移控球（不推进离门）
    // transition 期间新进攻方持球者前插（高速推进，经 main 表达）
    let in_transition = st.transition.as_ref().map_or(false, |tr| tr.attacking == st.possession);
    let roll = rng.next_u64() % 100;
    let (x2, y2) = if is_gk || (!in_transition && roll < 70) {
        let ox = ((rng.next_u64() % 21) as f64 / 1000.0) - 0.01;
        let oy = ((rng.next_u64() % 21) as f64 / 1000.0) - 0.01;
        (clamp01(p.0 + ox), clamp01(p.1 + oy))
    } else if in_transition {
        // 反击：持球者前插（每拍推进 ~5m）
        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.05;
        let y = clamp01(p.1 + ((rng.next_u64() % 21) as f64 / 1000.0 - 0.01));
        (clamp01(x), y)
    } else {
        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.03;
        let y = clamp01(p.1 + ((rng.next_u64() % 21) as f64 / 1000.0 - 0.01));
        (clamp01(x), y)
    };
    let max_step = norm_step(CARRIER_SPEED_MS * TICK_SECONDS);
    let d = dist_norm(p, (x2, y2));
    let (x2f, y2f) = if d > max_step { move_toward(p, (x2, y2), max_step) } else { (x2, y2) };
    st.pos[st.carrier as usize] = (x2f, y2f);
    st.carrier_from = (x2f, y2f);
    st.last_emitted[st.carrier as usize] = (x2f, y2f);
    MainAction { subject: st.carrier, x: p.0, y: p.1, x2: x2f, y2: y2f, speed: CARRIER_SPEED_MS, touch_freq: 1.5 }
}

/// 是否防线球员（静态身份，default_lineup 基准）
fn is_defender(st: &MatchState, id: i32) -> bool {
    if id <= 10 { st.home_defenders.contains(&id) } else { st.away_defenders.contains(&id) }
}

/// 队形目标（P5 S1）：目标 = 角色基准 + 队形偏移(球位置, 控球阶段, 球侧)。
/// 门将恒回门线；防线随球前压/回撤（不越过球、不塌缩到 base 之后）；全队随球侧平移；控球阶段压上；transition 队形偏移放大。
fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {
    let base = st.lineup[id as usize];
    let ball = st.ball_pos;
    let home = id <= 10;
    let attack_dir = if home { 1.0 } else { -1.0 };
    // 球侧平移（连续映射，非二分——避免中线附近 shuffle）
    let shift = (ball.0 - 0.5) * SIDE_SHIFT_FACTOR;
    // 控球阶段压上（己方 attack 前压 / 对方持球回收）；transition 期间新进攻方队形偏移放大
    let my_team = if home { 0 } else { 1 };
    let my_attack = (home && st.possession == 0) || (!home && st.possession == 1);
    let mut press = if my_attack { PRESS_UP_OFFSET } else { -PRESS_UP_OFFSET };
    if let Some(tr) = &st.transition {
        if tr.attacking == my_team { press *= 2.0; } // 反击窗口前压放大
    }
    let mut tx = base.0 + shift + attack_dir * press;
    if is_defender(st, id) {
        // 防线随球前压/回撤：防线沿进攻方向推，且不越过球（不塌缩到 base 之后）
        let own_goal_x = if home { 0.0 } else { 1.0 };
        let push = (ball.0 - own_goal_x).abs() * DEFENSE_PUSH_FACTOR;
        let tx_full = base.0 + shift + attack_dir * press + attack_dir * push;
        // 不越过球（home line.x ≤ ball.x / away line.x ≥ ball.x），且不下穿角色基准（球在防线身后时停 base）
        tx = if home {
            tx_full.min(ball.0).max(base.0)
        } else {
            tx_full.max(ball.0).min(base.0)
        };
    }
    let ty = base.1 + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;
    (clamp01(tx), clamp01(ty))
}

/// close_down 停点：向 target 逼近，但停在 target 附近 CLOSE_DOWN_STOP_DIST（不贴身/不进入拾取半径）
fn close_down_stop(from: (f64, f64), target: (f64, f64)) -> (f64, f64) {
    let d = dist_norm(from, target);
    if d <= CLOSE_DOWN_STOP_DIST { return from; }
    let ux = (target.0 - from.0) / d;
    let uy = (target.1 - from.1) / d;
    (from.0 + ux * (d - CLOSE_DOWN_STOP_DIST), from.1 + uy * (d - CLOSE_DOWN_STOP_DIST))
}

/// transition 期间新防守方距 target 最近的 n 名外场（close_down 执行者）
fn pick_close_down_players(st: &MatchState, defend_team: u32, target: (f64, f64), n: usize) -> Vec<i32> {
    let mut cand: Vec<(f64, i32)> = Vec::new();
    for id in 0..22i32 {
        let is_team = if defend_team == 0 { id <= 10 } else { id >= 11 };
        if !is_team { continue; }
        if id == 0 || id == 21 { continue; } // 门将不 close_down
        if id == st.carrier { continue; }
        let d = (st.pos[id as usize].0 - target.0).powi(2) + (st.pos[id as usize].1 - target.1).powi(2);
        cand.push((d, id));
    }
    cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    cand.iter().take(n).map(|(_, id)| *id).collect()
}

/// 门球开大脚落点：中场偏对方半场，中线和对方禁区前之间随机波动
fn goal_kick_land(st: &MatchState, rng: &mut SeededRng) -> (f64, f64) {
    let dir = if st.possession == 0 { 1.0 } else { -1.0 };
    let x = 0.5 + dir * (0.08 + (rng.next_u64() % 30) as f64 / 100.0); // 0.5±(0.08-0.37)：中线到对方禁区前
    let y = 0.2 + (rng.next_u64() % 60) as f64 / 100.0; // 0.2-0.8 随机
    (clamp01(x), clamp01(y))
}

/// 新进攻方（attacking 方）前插最深的外场球员位置（门前/禁区前沿）。
/// 评分：x 深度为主（离对方球门越近越好）+ y 偏离中线为次（中路禁区优先，避免贴边路）。
fn attacking_forward(st: &MatchState, attacking: u32) -> (f64, f64) {
    let goal_x = if attacking == 0 { 1.0 } else { 0.0 };
    let mut best = (0.5, 0.5);
    let mut best_score = f64::MAX;
    for id in 0..22i32 {
        let is_team = if attacking == 0 { id <= 10 } else { id >= 11 };
        if !is_team { continue; }
        if id == 0 || id == 21 { continue; }
        let p = st.pos[id as usize];
        let depth = (p.0 - goal_x).abs();
        let central = (p.1 - 0.5).abs();
        let score = depth + central * 0.3; // 深度为主，中路为次
        if score < best_score { best_score = score; best = p; }
    }
    best
}

/// 无球跑位（movers 增量）：目标 = 队形目标（formation_target），transition 期间 close_down 覆盖；dead-zone 内不动不发；repulsion 修正同队目标间距
fn compute_movers(st: &mut MatchState, rng: &mut SeededRng, t: f64, excluded: &[i32]) -> Vec<Mover> {
    let _ = rng;
    let _ = t;
    let dead_zone = norm_step(DEAD_ZONE_METERS);
    // transition 期间：新防守方 2 名就近外场 close_down（覆盖队形目标）。
    // 目标按来源区分：tackle → 球位（松散球/持球者）；save-caught → 新进攻方就近前插球员（门前/禁区前沿）
    let (close_down_ids, close_down_target): (Vec<i32>, (f64, f64)) = if let Some(tr) = &st.transition {
        let target = match tr.source {
            TransitionSource::Tackle => st.ball_pos,
            TransitionSource::SaveCaught => attacking_forward(st, tr.attacking),
        };
        (pick_close_down_players(st, 1 - tr.attacking, target, 2), target)
    } else {
        (Vec::new(), st.ball_pos)
    };
    // 第一遍：算每个外场球员的目标点（门将单独处理）
    let mut targets: Vec<Option<(f64, f64)>> = vec![None; 22];
    let mut actions = vec!["run".to_string(); 22];
    for id in 0..22i32 {
        if excluded.contains(&id) || id == st.carrier { continue; }
        if id == 0 || id == 21 { continue; } // 门将最后单独处理
        if close_down_ids.contains(&id) {
            targets[id as usize] = Some(close_down_stop(st.pos[id as usize], close_down_target));
            actions[id as usize] = "close_down".to_string();
        } else {
            targets[id as usize] = Some(formation_target(st, id));
        }
    }
    // 第二遍：repulsion（同队目标间距修正，迭代 ≤3；carrier 不参与）
    for _ in 0..3 {
        for a in 0..22i32 {
            if targets[a as usize].is_none() { continue; }
            for b in a + 1..22i32 {
                if targets[b as usize].is_none() { continue; }
                if (a <= 10) != (b <= 10) { continue; } // 同队内部
                let ta = targets[a as usize].unwrap();
                let tb = targets[b as usize].unwrap();
                let d = dist_norm(ta, tb);
                if d < REPULSION_MIN_DIST {
                    // 完全重合（d==0）用任意方向推开（沿 x）；否则沿连线
                    let (ux, uy) = if d < 1e-9 { (1.0, 0.0) } else { ((tb.0 - ta.0) / d, (tb.1 - ta.1) / d) };
                    let push = (REPULSION_MIN_DIST - d) / 2.0;
                    targets[a as usize] = Some((clamp01(ta.0 - ux * push), clamp01(ta.1 - uy * push)));
                    targets[b as usize] = Some((clamp01(tb.0 + ux * push), clamp01(tb.1 + uy * push)));
                }
            }
        }
    }
    // 第三遍：移动 + 产出 movers
    let mut movers = Vec::new();
    for id in 0..22i32 {
        if excluded.contains(&id) || id == st.carrier { continue; }
        let from = st.pos[id as usize];
        let (target, action, speed) = if id == 0 || id == 21 {
            let tx = if id == 0 { 0.02 } else { 0.98 };
            ((tx, 0.5), "keeper_return".to_string(), GK_SPEED_MS)
        } else if let Some(ta) = targets[id as usize] {
            (ta, actions[id as usize].clone(), RUN_SPEED_MS)
        } else {
            continue;
        };
        let d = dist_norm(from, target);
        if d < dead_zone { continue; }
        let step = d.min(norm_step(speed * TICK_SECONDS));
        let (tox, toy) = move_toward(from, target, step);
        st.pos[id as usize] = (tox, toy);
        movers.push(Mover {
            id, from_x: from.0, from_y: from.1, to_x: tox, to_y: toy,
            speed, action,
        });
    }
    movers
}

/// 高亮门控：hold 归零必掷一条高亮；tackle 检查失败改掷 pass/shot；shot 需在进攻半场
fn roll_highlight(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let roll = rng.next_u64() % 100;
    // pass 55% / shot 8% / tackle 37%：高亮 ~235/场 → pass ~130、shot ~19（goal ~3）、tackle 过滤后 ~8-15
    let mut kind = if roll < 55 { EventType::Pass } else if roll < 63 { EventType::Shot } else { EventType::Tackle };
    if kind == EventType::Tackle {
        let victim = st.carrier;
        let victim_pos = st.pos[victim as usize];
        let def_home = st.possession != 0;
        let (def_id, _, dist) = nearest_defender(&st.pos, victim_pos, def_home);
        let same_pair = st.last_tackle_pair == Some((def_id, victim));
        if same_pair || dist > TACKLE_DISTANCE_THRESHOLD_METERS || !should_tackle(rng) {
            // 检查失败：改掷 pass/shot（spec：无 dribble 落点；85% pass / 15% shot 控制射门频率）
            kind = if rng.next_u64() % 20 < 17 { EventType::Pass } else { EventType::Shot };
        }
    }
    // 统一 shot 半场 guard（主分支与 tackle fallback 分支都过——避免门将/后场射门）
    if kind == EventType::Shot {
        let shooter_pos = st.pos[st.carrier as usize];
        let home = st.possession == 0;
        let in_opp_half = if home { shooter_pos.0 > 0.5 } else { shooter_pos.0 < 0.5 };
        if !in_opp_half {
            kind = EventType::Pass;
        }
    }
    match kind {
        EventType::Pass => emit_pass_highlight(st, rng, events, t),
        EventType::Shot => emit_shot_highlight(st, rng, events, t),
        _ => emit_tackle_highlight(st, rng, events, t),
    }
}

/// pass 高亮：起点整数 tick，覆盖 [t, t_end)，参与者 = 传球者(静止) + 接球者(落点)
fn emit_pass_highlight(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let from = st.carrier;
    let from_pos = st.pos[from as usize];
    let home = st.possession == 0;
    let (to, to_pos) = nearest_teammate(&st.pos, from_pos, home, from);
    let rx = st.pos[to as usize].0;
    let ry = st.pos[to as usize].1;
    let lead = 0.1 + (rng.next_u64() % 30) as f64 / 100.0;
    let (x2, y2) = lead_point(from_pos, to_pos, lead);
    let speed = 12.0 + (rng.next_u64() % 130) as f64 / 10.0;
    let flight = distance_meters(from_pos, (x2, y2)) / speed;
    let t_end = t + flight;
    let event = Event {
        t, type_: EventType::Pass, subject: from, from: Some(from), to: Some(to),
        x: from_pos.0, y: from_pos.1, x2: Some(x2), y2: Some(y2),
        result: Some("success".to_string()), speed: Some(speed), lead: Some(lead),
        receiver_x: Some(rx), receiver_y: Some(ry),
        ..Event::default()
    };
    events.push(event);
    let participants = vec![(from, from_pos), (to, (x2, y2))];
    st.highlight = Some(Highlight {
        t_end,
        participants,
        outcome: HighlightOutcome::PassCaught { receiver: to, catch_pos: (x2, y2) },
    });
    // 本 tick beat：movers（排除参与者，无 main/ball）
    let movers = compute_movers(st, rng, t, &[from, to]);
    for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
    events.push(beat_event(t, None, None, movers));
}

/// shot 高亮：result=goal/saved/off_target；saved 分扑住/扑出
fn emit_shot_highlight(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let shooter = st.carrier;
    let shooter_pos = st.pos[shooter as usize];
    let home = st.possession == 0;
    let (x2, y2) = shot_target(rng, home);
    let speed = 22.0 + (rng.next_u64() % 80) as f64 / 10.0;
    let score_roll = rng.next_u64() % 100;
    let (result, caught) = if score_roll < 15 {
        ("goal", false)
    } else if score_roll < 45 {
        let caught = rng.next_u64() % 100 < 70;
        ("saved", caught)
    } else {
        ("off_target", false)
    };
    let gk_id = if home { 21 } else { 0 };
    let gk_pos = st.pos[gk_id as usize];
    let flight = distance_meters(shooter_pos, (x2, y2)) / speed;
    let t_end = t + flight;
    let event = Event {
        t, type_: EventType::Shot, subject: shooter,
        x: shooter_pos.0, y: shooter_pos.1, x2: Some(x2), y2: Some(y2),
        result: Some(result.to_string()), speed: Some(speed),
        keeper_x: Some(gk_pos.0), keeper_y: Some(gk_pos.1),
        ..Event::default()
    };
    events.push(event);
    let participants = vec![(shooter, shooter_pos), (gk_id, (x2, y2))];
    let outcome = if result == "goal" {
        let kickoff_id = if home { 12 } else { 9 };
        // 比分在高亮结束（finalize）确认，不在射门时刻递增
        HighlightOutcome::ShotGoal { kickoff_id, ball_end: (x2, y2) }
    } else if result == "off_target" {
        let kickoff_id = if home { 12 } else { 9 };
        HighlightOutcome::ShotOffTarget { kickoff_id, ball_end: (x2, y2) }
    } else if caught {
        HighlightOutcome::ShotSavedCaught { gk: gk_id, save_pos: (x2, y2) }
    } else {
        // 扑出反弹：弹开方向按 deflectPoint 规则（射手→门将逼近方向的垂线弹开，同 tackle）
        let (loose_x, loose_y) = deflect_point(
            shooter_pos.0, shooter_pos.1, x2, y2,
            TACKLE_DEFLECT_DISTANCE, shooter, gk_id,
        );
        let dx = loose_x - x2;
        let dy = loose_y - y2;
        let len = dx.hypot(dy);
        let dir = if len < 1e-9 { (-1.0, 0.0) } else { (dx / len, dy / len) };
        HighlightOutcome::ShotSavedRebound { gk: gk_id, rebound_from: (x2, y2), dir }
    };
    st.highlight = Some(Highlight { t_end, participants, outcome });
    let movers = compute_movers(st, rng, t, &[shooter, gk_id]);
    for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
    events.push(beat_event(t, None, None, movers));
}

/// tackle 高亮：时长 1 tick；carrier_from = 接触点（carry-beat 归零）
fn emit_tackle_highlight(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let victim = st.carrier;
    let victim_pos = st.pos[victim as usize];
    let def_home = st.possession != 0;
    let (def_id, def_pos, _) = nearest_defender(&st.pos, victim_pos, def_home);
    let success = (rng.next_u64() % 100) < (TACKLE_SUCCESS_RATE * 100.0) as u64;
    let result = if success { "success" } else { "fail" };
    let (loose_x, loose_y) = deflect_point(
        def_pos.0, def_pos.1, victim_pos.0, victim_pos.1,
        TACKLE_DEFLECT_DISTANCE, def_id, victim,
    );
    let t_end = t + TICK_SECONDS;
    let event = Event {
        t, type_: EventType::Tackle, subject: def_id,
        carrier: Some(victim),
        x: def_pos.0, y: def_pos.1, x2: Some(victim_pos.0), y2: Some(victim_pos.1),
        result: Some(result.to_string()),
        loose_x: Some(loose_x), loose_y: Some(loose_y),
        carrier_from_x: Some(victim_pos.0), carrier_from_y: Some(victim_pos.1),
        ..Event::default()
    };
    events.push(event);
    let participants = vec![(victim, victim_pos), (def_id, victim_pos)];
    let outcome = if success {
        HighlightOutcome::TackleSuccess { def: def_id, loose: (loose_x, loose_y), contact: victim_pos }
    } else {
        HighlightOutcome::TackleFail { victim, contact: victim_pos }
    };
    st.last_tackle_pair = Some((def_id, victim));
    // tackle 成功：在 tackle 高亮起点 tick 即武装 transition（接触即得球权，全队前压/回撤立即生效）
    if success {
        st.possession = if def_id <= 10 { 0 } else { 1 };
        st.transition = Some(Transition { ticks_left: TRANSITION_TICKS, attacking: if def_id <= 10 { 0 } else { 1 }, source: TransitionSource::Tackle });
    }
    st.highlight = Some(Highlight { t_end, participants, outcome });
    let movers = compute_movers(st, rng, t, &[victim, def_id]);
    for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
    events.push(beat_event(t, None, None, movers));
}

/// 高亮结束 → 球权交接（D12）：pos[] 对账到高亮结束位置，按结局设置后继
fn finalize_highlight(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let h = st.highlight.take().unwrap();
    // 对账参与者 pos + last_emitted 到高亮结束位置（回归 movers 不回弹）
    for (id, end_pos) in &h.participants {
        st.pos[*id as usize] = *end_pos;
        st.last_emitted[*id as usize] = *end_pos;
    }
    match h.outcome {
        HighlightOutcome::PassCaught { receiver, catch_pos } => {
            st.ball_pos = catch_pos;
            st.carrier = receiver;
            st.carrier_from = catch_pos;
            st.hold_ticks = 0;
            st.hold_max = roll_hold_max(rng);
            emit_beat_with_main(st, rng, events, t);
        }
        HighlightOutcome::ShotGoal { kickoff_id, ball_end } => {
            // 比分在高亮结束（finalize）时确认——不在射门时刻递增（避免比赛在飞行中结束仍计分）
            st.ball_pos = ball_end;
            if kickoff_id <= 10 { st.away_score += 1; } else { st.home_score += 1; }
            let receiver = if st.possession == 0 { 11 } else { 10 };
            st.carrier = -1;
            st.dead_ball = Some(DeadBall { goal: true, remaining: 2, preparing: false, kickoff_id, kicked: false, receiver, kickoff_end: 0.0 });
            let movers = compute_movers(st, rng, t, &[kickoff_id]);
            for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
            events.push(beat_event(t, None, None, movers));
        }
        HighlightOutcome::ShotSavedCaught { gk, save_pos } => {
            st.ball_pos = save_pos;
            st.carrier = gk;
            st.possession = if gk <= 10 { 0 } else { 1 };
            st.carrier_from = save_pos;
            // save-caught 触发 transition（球权易主）：save 高亮终点 tick 后的首个整数 tick 边界武装
            st.transition = Some(Transition { ticks_left: TRANSITION_TICKS, attacking: st.possession, source: TransitionSource::SaveCaught });
            st.hold_ticks = 0;
            st.hold_max = roll_hold_max(rng);
            emit_beat_with_main(st, rng, events, t);
        }
        HighlightOutcome::ShotSavedRebound { gk, rebound_from, dir } => {
            let _ = gk;
            st.ball_pos = rebound_from;
            // save-rebound 不触发 transition（普通松散球，双方可争，拾取后按拾取方刷新）
            st.carrier = -1;
            start_loose_ball(st, rebound_from, dir, None);
            advance_loose(st, rng, events, t);
        }
        HighlightOutcome::ShotOffTarget { kickoff_id: _, ball_end } => {
            // 门球（goal kick）：possession 切对方，球到对方门将脚下（瞬移）
            st.ball_pos = ball_end;
            let gk_id = if st.possession == 0 { 21 } else { 0 };
            st.possession = if gk_id <= 10 { 0 } else { 1 };
            let gk_pos = if gk_id == 0 { (0.02, 0.5) } else { (0.98, 0.5) };
            st.pos[gk_id as usize] = gk_pos;
            st.last_emitted[gk_id as usize] = gk_pos;
            st.carrier = -1;
            // 门将开大脚：pass 高亮（门线 → 中场偏对方半场落点，无 to——落点是争抢点）
            let land = goal_kick_land(st, rng);
            let speed = 16.0 + (rng.next_u64() % 50) as f64 / 10.0; // 16-21 m/s 长球
            let t_end = t + distance_meters(gk_pos, land) / speed;
            events.push(Event {
                t, type_: EventType::Pass, subject: gk_id, from: Some(gk_id), to: None,
                x: gk_pos.0, y: gk_pos.1, x2: Some(land.0), y2: Some(land.1),
                result: Some("success".to_string()), speed: Some(speed),
                ..Event::default()
            });
            st.highlight = Some(Highlight {
                t_end,
                participants: vec![(gk_id, gk_pos)],
                outcome: HighlightOutcome::GoalKick { land },
            });
            let movers = compute_movers(st, rng, t, &[gk_id]);
            for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
            events.push(beat_event(t, None, None, movers));
        }
        HighlightOutcome::GoalKick { land } => {
            // 门将开大脚球到达落点：进入松散球（双方可争），拾取恢复 main
            st.ball_pos = land;
            st.carrier = -1;
            start_loose_ball(st, land, (0.0, 0.0), None);
            advance_loose(st, rng, events, t);
        }
        HighlightOutcome::TackleSuccess { def, loose, contact } => {
            st.ball_pos = loose;
            // transition 已在 emit_tackle_highlight（tackle 起点 tick）武装 + possession 已切
            // 滚动方向：沿接触点 → 弹开点方向
            let dx = loose.0 - contact.0;
            let dy = loose.1 - contact.1;
            let len = dx.hypot(dy);
            let dir = if len < 1e-9 { (1.0, 0.0) } else { (dx / len, dy / len) };
            st.carrier = -1;
            start_loose_ball(st, loose, dir, Some(if def <= 10 { 0 } else { 1 }));
            advance_loose(st, rng, events, t);
        }
        HighlightOutcome::TackleFail { victim, contact } => {
            st.ball_pos = contact;
            st.carrier = victim;
            st.carrier_from = contact;
            st.hold_ticks = 0;
            st.hold_max = roll_hold_max(rng);
            emit_beat_with_main(st, rng, events, t);
        }
    }
}

/// 开始松散球（D11）：选追逐者，记录滚动方向
fn start_loose_ball(st: &mut MatchState, from: (f64, f64), dir: (f64, f64), winning_team: Option<u32>) {
    let chaser = if let Some(team) = winning_team {
        nearest_in_team(&st.pos, from, team)
    } else {
        nearest_any(&st.pos, from)
    };
    st.loose = Some(LooseBall { pos: from, dir, speed: 3.0, chaser, ticks: 0 });
}

/// 松散球 tick：球滚动（阻尼递减）→ 追逐者接近 → 拾取回 main / 继续 beat.ball
fn advance_loose(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    // 拷贝必要字段，避免借用冲突
    let (loose_pos, chaser) = {
        let l = st.loose.as_ref().unwrap();
        (l.pos, l.chaser)
    };
    let chaser_pos = st.pos[chaser as usize];
    let d = dist_norm(chaser_pos, loose_pos);
    if d < norm_step(PICKUP_RADIUS_METERS) {
        // 拾取：该球员成为 carrier → 下 tick 边界 main 恢复；possession 对账到拾取方
        st.carrier = chaser;
        st.possession = if chaser <= 10 { 0 } else { 1 };
        st.pos[chaser as usize] = loose_pos;
        st.carrier_from = loose_pos;
        st.last_emitted[chaser as usize] = loose_pos;
        st.hold_ticks = 0;
        st.hold_max = roll_hold_max(rng);
        st.loose = None;
        emit_beat_with_main(st, rng, events, t);
        return;
    }
    // 追逐者向球移动
    let step = d.min(norm_step(RUN_SPEED_MS * TICK_SECONDS));
    let (cx, cy) = move_toward(chaser_pos, loose_pos, step);
    st.pos[chaser as usize] = (cx, cy);
    st.last_emitted[chaser as usize] = (cx, cy);
    // 球滚动（未超时）或 hold（超时等待，不瞬移）
    let (ball_start, ball_end) = {
        let l = st.loose.as_mut().unwrap();
        l.ticks += 1;
        let s = l.pos;
        if l.ticks <= LOOSE_MAX_TICKS {
            // 沿弹开方向滚动，速度阻尼递减
            let dir_vec = (s.0 + l.dir.0, s.1 + l.dir.1);
            let e = move_toward(s, dir_vec, norm_step(l.speed * TICK_SECONDS));
            l.pos = e;
            l.speed *= 0.5;
            (s, e)
        } else {
            (s, s) // 超时：球在当前位置 hold 等待（不瞬移）
        }
    };
    // 产 beat.ball（滚动轨迹）+ 追逐者 movers
    let mut movers = compute_movers(st, rng, t, &[chaser]);
    movers.push(Mover {
        id: chaser, from_x: chaser_pos.0, from_y: chaser_pos.1, to_x: cx, to_y: cy,
        speed: RUN_SPEED_MS, action: "chase".to_string(),
    });
    for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
    let speed_now = st.loose.as_ref().unwrap().speed;
    let ball = BallState {
        x: ball_start.0, y: ball_start.1, x2: ball_end.0, y2: ball_end.1,
        speed: speed_now.max(0.1), loose: true,
    };
    events.push(beat_event(t, None, Some(ball), movers));
}

/// 死球 tick（进球庆祝 / off_target 后 kickoff 重开）
fn advance_dead_ball(st: &mut MatchState, rng: &mut SeededRng, events: &mut Vec<Event>, t: f64) {
    let (goal, remaining, preparing, kickoff_id, kicked, receiver, kickoff_end) = {
        let d = st.dead_ball.as_ref().unwrap();
        (d.goal, d.remaining, d.preparing, d.kickoff_id, d.kicked, d.receiver, d.kickoff_end)
    };
    if kicked {
        // kickoff 球飞行中：产 beat（movers，无 main/ball——球由 kickoff 事件驱动）。
        // 飞行结束后（t >= kickoff_end）该 tick 产 main（接球者持球）。
        if t < kickoff_end {
            // 排除开球者（kickoff 事件已由传球者锚点驱动，避免双重驱动）
            let movers = compute_movers(st, rng, t, &[kickoff_id]);
            for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
            events.push(beat_event(t, None, None, movers));
        } else {
            st.dead_ball = None;
            st.hold_ticks = 0;
            st.hold_max = roll_hold_max(rng);
            emit_beat_with_main(st, rng, events, t);
        }
        return;
    }
    if remaining > 0 && !preparing {
        // 庆祝阶段（goal 后 2 tick）
        st.dead_ball.as_mut().unwrap().remaining -= 1;
        let movers = compute_movers(st, rng, t, &[kickoff_id]);
        for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
        events.push(beat_event(t, None, None, movers));
        return;
    }
    if goal && !preparing {
        // 庆祝结束 → whistle → 进入准备阶段
        events.push(whistle_event(t, st.home_score, st.away_score, "kickoff_again"));
        st.dead_ball.as_mut().unwrap().preparing = true;
        let movers = compute_movers(st, rng, t, &[kickoff_id]);
        for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
        events.push(beat_event(t, None, None, movers));
        return;
    }
    if preparing {
        // 准备阶段：开球者走向中圈（快走 8m/s），到中圈（<1m）才 kickoff——保证 kickoff 事件（球在中圈）与引擎位置一致
        let kp = st.pos[kickoff_id as usize];
        let d_mid = dist_norm(kp, (0.5, 0.5));
        if d_mid > norm_step(1.0) {
            let step = d_mid.min(norm_step(8.0 * TICK_SECONDS));
            let (nx, ny) = move_toward(kp, (0.5, 0.5), step);
            st.pos[kickoff_id as usize] = (nx, ny);
            let mut movers = compute_movers(st, rng, t, &[kickoff_id]);
            movers.push(Mover {
                id: kickoff_id, from_x: kp.0, from_y: kp.1, to_x: nx, to_y: ny,
                speed: 8.0, action: "run".to_string(),
            });
            for m in &movers { st.last_emitted[m.id as usize] = (m.to_x, m.to_y); }
            events.push(beat_event(t, None, None, movers));
            return;
        }
        // 到中圈 → fall through 到 kickoff
    }
    // kickoff（丢球方开球者在中圈拨给同队）
    let receiver_pos = st.pos[receiver as usize];
    let (kx2, ky2) = lead_point((0.5, 0.5), receiver_pos, 0.1);
    events.push(Event {
        t, type_: EventType::Kickoff, subject: kickoff_id, from: Some(kickoff_id), to: Some(receiver),
        x: 0.5, y: 0.5, x2: Some(kx2), y2: Some(ky2),
        result: Some("success".to_string()), speed: Some(12.0), lead: Some(0.1),
        receiver_x: Some(receiver_pos.0), receiver_y: Some(receiver_pos.1),
        ..Event::default()
    });
    // kickoff 球飞行结束时刻：main 在其后首个 tick 边界恢复（避免 beat-main 在球未到落点就开始）
    let kickoff_end = t + distance_meters((0.5, 0.5), (kx2, ky2)) / 12.0;
    st.carrier = receiver;
    st.pos[receiver as usize] = (kx2, ky2);
    st.carrier_from = (kx2, ky2);
    st.last_emitted[receiver as usize] = (kx2, ky2);
    st.possession = if receiver <= 10 { 0 } else { 1 };
    st.hold_ticks = 0;
    st.hold_max = roll_hold_max(rng);
    st.dead_ball = Some(DeadBall { goal, remaining: 0, preparing, kickoff_id, kicked: true, receiver, kickoff_end });
}

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
        Event { t, type_, subject, x, y, from, to, carrier: None, x2, y2, result, speed, touch_freq, lead, receiver_x: rx, receiver_y: ry, loose_x: None, loose_y: None, carrier_from_x: None, carrier_from_y: None, keeper_x: None, keeper_y: None, score, detail, players, movers: None, main: None, ball: None }
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
        subject: 15, from: None, to: Some(6), carrier: None,
        x: 0.58, y: 0.40, x2: Some(0.44), y2: Some(0.42),
        result: Some("success".to_string()), speed: None, touch_freq: None,
        lead: None, score: None, detail: None,
        receiver_x: None, receiver_y: None,
        loose_x: Some(loose_x), loose_y: Some(loose_y),
        carrier_from_x: Some(0.42), carrier_from_y: Some(0.42),
        keeper_x: None, keeper_y: None,
        players: None,
        movers: None, main: None, ball: None,
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
/// 产出一条无球跑位事件：选一个非持球者随机碎步移动，并更新引擎 pos。
/// `exclude` = 额外排除的球员 id（-1 不排除；进球后重新开球前排除开球者）。
/// 返回事件时长（距离÷跑速）。
/// 持球者短带球（人球同步）：控球间隔内给持球者小幅盘带，避免其长时间静止
/// （用户报告"dribble 卡住不动"）。返回事件时长。
/// 用无球跑位事件填满 [t, t+span] 时间段，推进 t。事件按各自时长背靠背产出，
/// 中间留极小节奏停顿（0.1-0.4s），画面持续有动作。
/// `carrier_active` = true 时每 3 个队友跑位给持球者 1 个短带球（人球同步，持球者不静止）。
/// 进球后庆祝/准备期传 false（球在门内，持球者带球会瞬移球）。
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
        // 把 "[{...},{...}]" 按顶层 `}` 深度感知拆分（正确处理 beat 的嵌套 movers/main/ball）
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
                let trimmed = cur.trim().trim_start_matches(',').trim().to_string();
                if !trimmed.is_empty() {
                    out.push(trimmed);
                }
                cur.clear();
            }
        }
        out.retain(|e| !e.trim().is_empty());
        out
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
        let types: Vec<String> = json_events(&s).iter().map(|e| type_of(e)).collect();
        // v2：kickoff + beat 节拍流 + pass/shot 高亮 + whistle + lineup；无顶层 dribble
        assert!(types.iter().any(|t| t == "kickoff"));
        assert!(types.iter().any(|t| t == "pass"));
        assert!(types.iter().any(|t| t == "shot"));
        assert!(types.iter().any(|t| t == "whistle"));
        assert!(types.iter().any(|t| t == "lineup"));
        assert!(types.iter().any(|t| t == "beat"));
        assert!(!has_top_level_dribble(&s), "v2 非 demo 流不应有顶层 dribble");
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

    // ---- v2 并行节拍测试 ----

    fn type_of(e: &str) -> String {
        // 取顶层 type（第一个 "type":" 出现后到下一个引号）
        let needle = "\"type\":\"";
        match e.find(needle) {
            Some(i) => {
                let rest = &e[i + needle.len()..];
                rest.split('"').next().unwrap_or("?").to_string()
            }
            None => "?".to_string(),
        }
    }

    fn has_top_level_dribble(s: &str) -> bool {
        json_events(s).iter().any(|e| {
            let t = type_of(e);
            t == "dribble"
        })
    }

    fn top_level_types(s: &str) -> std::collections::HashMap<String, usize> {
        let mut m = std::collections::HashMap::new();
        for e in json_events(s) {
            if e.contains("\"type\":") {
                *m.entry(type_of(&e)).or_insert(0) += 1;
            }
        }
        m
    }

    /// 提取 beat main 的 subject（被铲者/持球者 id）
    fn extract_main_subject(e: &str) -> Option<i32> {
        let needle = "\"main\":{\"type\":\"dribble\",\"subject\":";
        let i = e.find(needle)?;
        let rest = &e[i + needle.len()..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
        num.parse().ok()
    }

    /// 提取 beat movers 数组中的球员 id 列表
    fn extract_movers_ids(e: &str) -> Vec<i32> {
        let needle = "\"movers\":[";
        let i = match e.find(needle) {
            Some(i) => i,
            None => return vec![],
        };
        let rest = &e[i + needle.len()..];
        let end = rest.find(']').unwrap_or(rest.len());
        let arr = &rest[..end];
        let mut ids = Vec::new();
        for tok in arr.split("{\"id\":").skip(1) {
            let num: String = tok.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
            if let Ok(n) = num.parse() {
                ids.push(n);
            }
        }
        ids
    }

    /// 提取 beat main 对象内字段（f64）
    fn main_field(e: &str, name: &str) -> Option<f64> {
        let needle = "\"main\":{";
        let i = e.find(needle)?;
        let rest = &e[i + needle.len()..];
        let end = rest.find('}')?;
        let obj = &rest[..end];
        let f = format!("\"{}\":", name);
        let j = obj.find(&f)?;
        let val = &obj[j + f.len()..];
        let num: String = val.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
        num.parse().ok()
    }

    #[test]
    fn v2_beat_stream_structure() {
        // v2 非 demo 流：beat 存在且最多；无顶层 dribble；含高亮与 whistle
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let counts = top_level_types(&s);
        assert!(*counts.get("beat").unwrap_or(&0) > 2000, "应产 ~2700 beat（实际 {}", counts.get("beat").unwrap_or(&0));
        assert!(!has_top_level_dribble(&s), "v2 不应有顶层 dribble 事件");
        assert!(*counts.get("pass").unwrap_or(&0) > 0);
        assert!(*counts.get("shot").unwrap_or(&0) > 0);
        assert!(*counts.get("kickoff").unwrap_or(&0) >= 1);
        assert!(*counts.get("whistle").unwrap_or(&0) >= 1);
        assert!(json_events(&s).iter().any(|e| type_of(e) == "lineup"));
    }

    #[test]
    fn v2_beat_has_no_top_level_subject() {
        // beat 无顶层 subject/x/y：type:"beat" 后紧跟 movers/main/ball
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let all = json_events(&s);
        let beat = all.iter().find(|e| type_of(e) == "beat").expect("应有 beat");
        let ok = beat.contains("\"type\":\"beat\",\"movers\"")
            || beat.contains("\"type\":\"beat\",\"main\"")
            || beat.contains("\"type\":\"beat\",\"ball\"");
        assert!(ok, "beat 应无顶层 subject/x/y（紧跟 movers/main/ball）: {}", beat);
    }

    #[test]
    fn v2_carrier_not_in_movers() {
        // main-only：有 main 的 beat，carrier（main.subject）不在 movers 里
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let mut checked = 0;
        for e in json_events(&s) {
            if type_of(&e) != "beat" || !e.contains("\"main\"") { continue; }
            let subj = extract_main_subject(&e).expect("main 应有 subject");
            let ids = extract_movers_ids(&e);
            assert!(!ids.contains(&subj), "carrier {} 不应在 movers: {}", subj, e);
            checked += 1;
            if checked >= 20 { break; }
        }
        assert!(checked > 0, "应有带 main 的 beat");
    }

    #[test]
    fn v2_ball_ownership_exclusive() {
        // 球所有权唯一：同一 beat 不同时含 main 和 ball
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let mut checked = 0;
        for e in json_events(&s) {
            if type_of(&e) != "beat" { continue; }
            let has_main = e.contains("\"main\"");
            let has_ball = e.contains("\"ball\"");
            assert!(!(has_main && has_ball), "beat 不应同时含 main 和 ball: {}", e);
            checked += 1;
        }
        assert!(checked > 2000);
    }

    #[test]
    fn v2_tick_monotonic() {
        // beat t 严格单调递增
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let mut prev = f64::NEG_INFINITY;
        let mut n = 0;
        for e in json_events(&s) {
            if type_of(&e) != "beat" { continue; }
            let t = json_num(&e, "t").expect("beat 应有 t");
            assert!(t > prev, "beat t 应严格递增: {} <= {}", t, prev);
            prev = t;
            n += 1;
        }
        assert!(n > 2000);
    }

    #[test]
    fn v2_highlight_participants_excluded() {
        // 高亮期间 beat 排除参与者（pass 的传球者/接球者不在飞行期 beat movers）
        let cfg = MatchConfig::default_();
        let s = simulate(42, cfg);
        let evts: Vec<String> = json_events(&s);
        let mut checked = 0;
        for (i, e) in evts.iter().enumerate() {
            if type_of(e) != "pass" { continue; }
            let from = json_num(e, "from").unwrap() as i32;
            // 门球开大脚 pass 无 to（落点是争抢点）——跳过（非传跑配合高亮）
            let to = match json_num(e, "to") { Some(t) => t as i32, None => continue };
            let pt = json_num(e, "t").unwrap();
            // 只检查飞行 >1.5s 的长传（确保 pt+1 仍在高亮覆盖区间内）
            let speed = json_num(e, "speed").unwrap();
            let flight = distance_meters(
                (json_num(e, "x").unwrap(), json_num(e, "y").unwrap()),
                (json_num(e, "x2").unwrap(), json_num(e, "y2").unwrap()),
            ) / speed;
            if flight <= 1.5 { continue; }
            // 找 pt+1 的 beat（应在飞行期）
            let next_beat = evts.iter().skip(i + 1).find(|n| type_of(n) == "beat" && json_num(n, "t").unwrap_or(-1.0) >= pt + 1.0);
            if let Some(b) = next_beat {
                let bt = json_num(b, "t").unwrap();
                if (bt - (pt + 1.0)).abs() > 0.01 { continue; }
                let ids = extract_movers_ids(b);
                assert!(!ids.contains(&from), "pass 传球者 {} 不应在飞行期 beat movers", from);
                assert!(!ids.contains(&to), "pass 接球者 {} 不应在飞行期 beat movers", to);
                checked += 1;
                if checked >= 5 { break; }
            }
        }
        assert!(checked > 0, "应有 pass 高亮飞行期 beat 被检查");
    }

    #[test]
    fn v2_loose_ball_produced() {
        // 松散球：多 seed 扫描，至少一个 beat 携带 ball loose:true
        let cfg = MatchConfig::default_();
        for seed in 1..20u64 {
            let s = simulate(seed, cfg);
            if json_events(&s).iter().any(|e| e.contains("\"loose\":true")) {
                return;
            }
        }
        panic!("没有任何 seed 产出松散球（beat.ball loose:true）");
    }

    #[test]
    fn v2_highlight_gate_frequency() {
        // 高亮门控：高亮总数（pass+shot+tackle）约 200/场
        let cfg = MatchConfig::default_();
        let mut total = 0usize;
        let n = 10usize;
        for seed in 1..=n as u64 {
            let c = top_level_types(&simulate(seed, cfg));
            total += c.get("pass").unwrap_or(&0) + c.get("shot").unwrap_or(&0) + c.get("tackle").unwrap_or(&0);
        }
        let avg = total as f64 / n as f64;
        assert!(avg >= 100.0, "高亮数过低（平均 {:.1}/场），应 ~200", avg);
        assert!(avg <= 350.0, "高亮数过高（平均 {:.1}/场），应 ~200", avg);
    }

    #[test]
    fn v2_tackle_frequency_in_target_range() {
        // v2 重标定：目标 8-15 次/场（阈值 12m、积极性 0.15）；多 seed 平均落在 5-20（宽松边界防 flaky）
        let cfg = MatchConfig::default_();
        let mut total = 0usize;
        let n = 20usize;
        for seed in 1..=n as u64 {
            let c = top_level_types(&simulate(seed, cfg));
            total += c.get("tackle").unwrap_or(&0);
        }
        let avg = total as f64 / n as f64;
        assert!(avg >= 5.0, "tackle 频率过低（平均 {:.1}/场），应落在目标 8-15 附近", avg);
        assert!(avg <= 20.0, "tackle 频率过高（平均 {:.1}/场），应落在目标 8-15 附近", avg);
    }

    #[test]
    fn v2_tackle_fail_resumes_main_from_contact() {
        // v2 fail：被铲者保持，main 在首个 tick 边界恢复（last-emitted-pos=接触点）
        let cfg = MatchConfig::default_();
        let mut checked = 0;
        for seed in 1..40u64 {
            let s = simulate(seed, cfg);
            let evts: Vec<String> = json_events(&s);
            for (i, e) in evts.iter().enumerate() {
                if type_of(e) != "tackle" || !e.contains("\"result\":\"fail\"") { continue; }
                let victim = json_num(e, "carrier").expect("v2 fail tackle 应有 carrier") as i32;
                let contact_x = json_num(e, "x2").expect("fail tackle 应有 x2");
                let contact_y = json_num(e, "y2").expect("fail tackle 应有 y2");
                let tt = json_num(e, "t").unwrap();
                // 下一 tick 的 beat，其 main 应是被铲者从接触点带球
                let next_beat = evts.iter().skip(i + 1)
                    .find(|n| type_of(n) == "beat" && json_num(n, "t").unwrap_or(-1.0) >= tt + 1.0);
                if let Some(b) = next_beat {
                    if !b.contains("\"main\"") { continue; }
                    let m_subj = extract_main_subject(b).expect("main 应有 subject");
                    if m_subj != victim { continue; }
                    let mx = main_field(b, "x").expect("main 应有 x");
                    let my = main_field(b, "y").expect("main 应有 y");
                    let d = distance_meters((mx, my), (contact_x, contact_y));
                    assert!(d < 3.0, "fail 后 main 应从接触点出发（victim {}，距接触点 {:.1}m）", victim, d);
                    checked += 1;
                    if checked >= 10 { return; }
                }
            }
        }
        assert!(checked > 0, "应有 v2 fail tackle 的 main 恢复被检查");
    }

    // ---- P5 队形/攻防转换测试 ----

    /// 从 beat 事件提取 movers 数组中的指定球员目标
    fn mover_target(e: &str, pid: i32) -> Option<(f64, f64, String)> {
        let needle = "\"movers\":[";
        let i = e.find(needle)?;
        let rest = &e[i + needle.len()..];
        let end = rest.find(']')?;
        let arr = &rest[..end];
        // 按 "{" 拆分每个 mover
        for tok in arr.split("{\"id\":") {
            let tok2 = tok.trim_start_matches(',').trim_start_matches('{');
            if !tok2.starts_with(&format!("{}", pid)) && !tok2.starts_with(&format!("\"{}\"", pid)) {
                continue;
            }
            // id 匹配：解析 from_x/to_x/action
            let fx = extract_num_field(tok2, "to_x");
            let fy = extract_num_field(tok2, "to_y");
            let act = extract_str_field(tok2, "action");
            if let (Some(fx), Some(fy), Some(act)) = (fx, fy, act) {
                return Some((fx, fy, act));
            }
        }
        None
    }

    fn extract_num_field(s: &str, name: &str) -> Option<f64> {
        let f = format!("\"{}\":", name);
        let j = s.find(&f)?;
        let val = &s[j + f.len()..];
        let num: String = val.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
        num.parse().ok()
    }

    fn extract_str_field(s: &str, name: &str) -> Option<String> {
        let f = format!("\"{}\":\"", name);
        let j = s.find(&f)?;
        let rest = &s[j + f.len()..];
        Some(rest.split('"').next().unwrap_or("").to_string())
    }

    /// 提取 beat 全部 movers：[(id, from_x, from_y, to_x, to_y, speed)]
    fn movers_of(e: &str) -> Vec<(i32, f64, f64, f64, f64, f64)> {
        let needle = "\"movers\":[";
        let i = match e.find(needle) { Some(i) => i, None => return vec![] };
        let rest = &e[i + needle.len()..];
        let end = rest.find(']').unwrap_or(rest.len());
        let arr = &rest[..end];
        let mut out = Vec::new();
        for tok in arr.split("{\"id\":").skip(1) {
            let id_str: String = tok.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
            let id: i32 = match id_str.parse() { Ok(v) => v, Err(_) => continue };
            let fx = extract_num_field(tok, "from_x").unwrap_or(0.0);
            let fy = extract_num_field(tok, "from_y").unwrap_or(0.0);
            let tx = extract_num_field(tok, "to_x").unwrap_or(0.0);
            let ty = extract_num_field(tok, "to_y").unwrap_or(0.0);
            let sp = extract_num_field(tok, "speed").unwrap_or(4.0);
            out.push((id, fx, fy, tx, ty, sp));
        }
        out
    }

    #[test]
    fn p5_formation_and_transition() {
        let cfg = MatchConfig::default_();
        let mut close_down_total = 0usize;
        let mut front_avg = 0.0;
        let mut front_n = 0usize;
        let mut back_avg = 0.0;
        let mut back_n = 0usize;
        for seed in 1..6u64 {
            let s = simulate(seed, cfg);
            let evts: Vec<String> = json_events(&s);
            for e in &evts {
                if type_of(e) != "beat" { continue; }
                // action 统计
                let needle = "\"movers\":[";
                if let Some(i) = e.find(needle) {
                    let rest = &e[i + needle.len()..];
                    let end = rest.find(']').unwrap_or(rest.len());
                    let arr = &rest[..end];
                    close_down_total += arr.matches("close_down").count();
                }
                // 防线采样：home 持球（main 存在且 subject ≤10），球 x 分桶
                let has_main = e.contains("\"main\"");
                if !has_main { continue; }
                let main_subj = extract_main_subject(e);
                if main_subj.is_none() || main_subj.unwrap() > 10 { continue; } // home 持球
                let mx = main_field(e, "x").unwrap_or(0.5);
                if let Some((fx, _, _)) = mover_target(e, 4) { // home 后卫 id4
                    if mx > 0.7 { front_avg += fx; front_n += 1; }
                    else if mx < 0.3 { back_avg += fx; back_n += 1; }
                }
            }
        }
        if front_n > 0 { front_avg /= front_n as f64; }
        if back_n > 0 { back_avg /= back_n as f64; }
        println!("P5 防线(id4): 球前场(>0.7) avg_x={:.3} n={} / 球后场(<0.3) avg_x={:.3} n={}", front_avg, front_n, back_avg, back_n);
        println!("P5 close_down 总数: {}", close_down_total);
        assert!(close_down_total > 0, "应有 close_down 动作（transition 触发）");
        // 防线前压：球在前场时防线 x 应显著大于球在后场时
        if front_n > 0 && back_n > 0 {
            assert!(front_avg > back_avg + 0.02, "防线应随球前压（前场 {:.3} vs 后场 {:.3}）", front_avg, back_avg);
        }
    }

    /// 按主队/客队持球分桶采样某球员（id）的 mover to_x 平均
    fn sample_player_x(seed: u64, pid: i32, home_ball: Option<bool>) -> (f64, usize) {
        let cfg = MatchConfig::default_();
        let s = simulate(seed, cfg);
        let mut sum = 0.0;
        let mut n = 0usize;
        for e in json_events(&s) {
            if type_of(&e) != "beat" || !e.contains("\"main\"") { continue; }
            let subj = extract_main_subject(&e);
            if subj.is_none() { continue; }
            let is_home_ball = subj.unwrap() <= 10;
            if let Some(hb) = home_ball { if is_home_ball != hb { continue; } }
            for (id, _, _, tx, _, _) in movers_of(&e) {
                if id == pid {
                    sum += tx;
                    n += 1;
                }
            }
        }
        (if n > 0 { sum / n as f64 } else { 0.0 }, n)
    }

    #[test]
    fn p5_ball_side_shift() {
        // 球侧平移：home 持球、球在左半 vs 右半时，home 中场（id 5，非 carrier 时）目标 x 偏左 vs 偏右
        let cfg = MatchConfig::default_();
        let mut left_sum = 0.0; let mut left_n = 0usize;
        let mut right_sum = 0.0; let mut right_n = 0usize;
        for seed in 1..8u64 {
            let s = simulate(seed, cfg);
            for e in json_events(&s) {
                if type_of(&e) != "beat" || !e.contains("\"main\"") { continue; }
                let subj = extract_main_subject(&e);
                if subj.is_none() || subj.unwrap() > 10 { continue; } // home 持球
                let mx = main_field(&e, "x").unwrap_or(0.5);
                for (id, _, _, tx, _, _) in movers_of(&e) {
                    if id != 5 { continue; }
                    if mx < 0.35 { left_sum += tx; left_n += 1; }
                    else if mx > 0.65 { right_sum += tx; right_n += 1; }
                }
            }
        }
        let left = if left_n > 0 { left_sum / left_n as f64 } else { 0.0 };
        let right = if right_n > 0 { right_sum / right_n as f64 } else { 0.0 };
        assert!(left_n > 0 && right_n > 0, "应采到左右两侧样本（left_n={} right_n={}）", left_n, right_n);
        assert!(right > left + 0.02, "球在右半时全队应偏右（left={:.3} right={:.3}）", left, right);
    }

    #[test]
    fn p5_press_up_and_gk_exempt() {
        // 控球阶段压上：home 持球 vs away 持球时 home 中场目标 x 前压；门将不受平移/压上影响
        let (home_x, home_n) = sample_player_x(42, 5, Some(true));
        let (away_x, away_n) = sample_player_x(42, 5, Some(false));
        assert!(home_n > 0 && away_n > 0, "应采到两方样本（home_n={} away_n={}）", home_n, away_n);
        assert!(home_x > away_x + 0.01, "己方持球时前压（home {:.3} vs away {:.3}）", home_x, away_x);
        // 门将豁免：home 门将 id 0 目标 x 恒为门线（≈0.02），不随球/阶段
        let (gk_x, gk_n) = sample_player_x(42, 0, None);
        assert!(gk_n > 0);
        assert!((gk_x - 0.02).abs() < 0.01, "门将应回门线（gk_x={:.3}）", gk_x);
    }

    #[test]
    fn p5_approach_cap() {
        // approach cap：单拍 from→to 距离 ≤ RUN_SPEED×1s（归一化）+ 容差（防球员超速横穿）
        let cfg = MatchConfig::default_();
        let mut checked_cap = 0usize;
        for seed in 1..5u64 {
            let s = simulate(seed, cfg);
            for e in json_events(&s) {
                if type_of(&e) != "beat" { continue; }
                for (id, fx, fy, tx, ty, sp) in movers_of(&e) {
                    // 单拍位移 ≤ 该 mover 自身 speed×1s（开球者快走 8m/s 等特殊速度用自身 speed）
                    let max_step = norm_step(sp * TICK_SECONDS);
                    let d = dist_norm((fx, fy), (tx, ty));
                    assert!(d <= max_step * 1.05 + 1e-6, "单拍位移超速: id={} d={:.4} max={:.4} sp={:.1}", id, d, max_step, sp);
                    checked_cap += 1;
                }
            }
        }
        assert!(checked_cap > 100, "应检查足够多 mover（{}）", checked_cap);
    }

    #[test]
    fn p5_repulsion_separates_overlap() {
        // repulsion：两个同队球员放在同一位置、球在远处 → compute_movers 应把目标推开（不贴脸）。
        // 内部单测（构造 MatchState）——直接验证 repulsion 目标层逻辑。
        let lineup = default_lineup();
        let mut st = MatchState::new(&lineup);
        st.ball_pos = (0.8, 0.5);
        st.possession = 0; // home 持球
        st.carrier = 9;
        st.pos[1] = (0.4, 0.5);
        st.pos[2] = (0.4, 0.5); // 两个 home 外场球员完全重叠
        let mut rng = SeededRng::new(1);
        let movers = compute_movers(&mut st, &mut rng, 1.0, &[9]);
        let mut t1 = None;
        let mut t2 = None;
        for m in &movers {
            if m.id == 1 { t1 = Some((m.to_x, m.to_y)); }
            if m.id == 2 { t2 = Some((m.to_x, m.to_y)); }
        }
        if let (Some(a), Some(b)) = (t1, t2) {
            let d = dist_norm(a, b);
            // 重叠球员应被 repulsion 推开（单拍 to 间距显著 > 原始 0）
            assert!(d > 0.005, "重叠球员应被 repulsion 分开（d={:.4}）", d);
        }
    }

    // ---- P6 门球 + 进球回中圈测试 ----

    /// 门球开大脚 pass：无 to、subject = 门将、球从门线飞向中场
    fn find_goal_kick_pass(s: &str) -> Option<String> {
        json_events(s).iter().find(|e| {
            type_of(e) == "pass"
                && json_num(e, "to").is_none()
                && json_num(e, "subject").map(|s| s == 0.0 || s == 21.0).unwrap_or(false)
        }).cloned()
    }

    #[test]
    fn p6_goal_kick_produced_on_off_target() {
        // off_target → 门球：找到门将开大脚 pass（无 to、subject=门将、从门线飞向中场）
        let cfg = MatchConfig::default_();
        for seed in 1..15u64 {
            let s = simulate(seed, cfg);
            if let Some(gk_pass) = find_goal_kick_pass(&s) {
                // 门将开大脚：起点门线（x≈0.02 或 0.98），落点在中场偏对方半场
                let x = json_num(&gk_pass, "x").unwrap();
                let x2 = json_num(&gk_pass, "x2").unwrap();
                let gk = json_num(&gk_pass, "subject").unwrap() as i32;
                let gk_line = if gk == 0 { 0.02 } else { 0.98 };
                assert!((x - gk_line).abs() < 0.01, "门将开大脚起点应在门线: x={}", x);
                // 落点在中场偏对方半场：中线和对方禁区前之间（离门线 0.12-0.42 之外）
                let dist_from_goal = (x2 - gk_line).abs();
                assert!(dist_from_goal > 0.35 && dist_from_goal < 0.9, "落点应在中场偏对方半场: x2={} gk_line={}", x2, gk_line);
                return;
            }
        }
        panic!("没有任何 seed 产出门球（门将开大脚 pass 无 to）");
    }

    #[test]
    fn p6_goal_kick_then_loose_ball() {
        // 门球后：开大脚球到达落点 → 松散球（beat.ball loose:true）→ 拾取恢复
        let cfg = MatchConfig::default_();
        let mut checked = 0;
        for seed in 1..20u64 {
            let s = simulate(seed, cfg);
            if let Some(gk_pass) = find_goal_kick_pass(&s) {
                // 找门球 pass 之后是否出现 loose ball
                let evts = json_events(&s);
                let idx = evts.iter().position(|e| *e == gk_pass).unwrap();
                let after: Vec<&String> = evts.iter().skip(idx + 1).collect();
                // 高亮飞行期 beat 无 ball；finalize 后松散球 beat 带 ball loose:true
                let has_loose = after.iter().any(|e| e.contains("\"loose\":true"));
                assert!(has_loose, "门球后应出现松散球（beat.ball loose:true）");
                checked += 1;
                if checked >= 3 { return; }
            }
        }
        assert!(checked > 0, "应有门球被检查");
    }

    #[test]
    fn p6_goal_direct_center_spot() {
        // 进球后：球直接回中圈（dead_ball 阶段 ball_pos=中圈，事件流 kickoff 起点球在中圈）
        let cfg = MatchConfig::default_();
        let mut checked = 0;
        for seed in 1..25u64 {
            let s = simulate(seed, cfg);
            let evts = json_events(&s);
            for (i, e) in evts.iter().enumerate() {
                if type_of(e) != "shot" || !e.contains("\"result\":\"goal\"") { continue; }
                // 进球后应有 kickoff（回中圈重开），其 x=0.5,y=0.5
                let next_kickoff = evts.iter().skip(i + 1).find(|n| type_of(n) == "kickoff");
                if let Some(k) = next_kickoff {
                    let x = json_num(k, "x").unwrap_or(-1.0);
                    let y = json_num(k, "y").unwrap_or(-1.0);
                    assert!((x - 0.5).abs() < 0.01 && (y - 0.5).abs() < 0.01, "进球后 kickoff 应从中圈: ({},{})", x, y);
                    checked += 1;
                    if checked >= 3 { return; }
                }
            }
        }
        assert!(checked > 0, "应有进球被检查");
    }
}
