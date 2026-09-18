#!/usr/bin/env node
// SkillCorner opendata → 帧序列 JSON（供 viewer 的"真实比赛"对照模式与比赛标尺）。
//
// 与 convert-tracking-to-frames.mjs（Metrica）**并列**：两者输入格式、坐标系、朝向来源、
// 身份来源、时间轴处理全不相同（见 openspec/changes/p37-skillcorner-corpus/design.md D1），
// 唯一共用的是**输出的帧序列 schema**——那是 P36 立的统一帧表示，由 match-metrics.js 消费。
//
// 输入（SkillCorner opendata，MIT）：
//   <id>_match.json                 球场尺寸 / 阵容与角色 / 每半场主队朝向
//   <id>_tracking_extrapolated.jsonl  逐帧 JSONL，10fps
//
// 输出 schema（v1，与 Metrica 转换器同构）：
//   {
//     meta: { source, format, game, hz, keyframeHz, frames, startTime, endTime,
//             coord, orientation, orientationDetected, pitchMeters, timeAxis,
//             idMap, coverage, notes },
//     frames: [ { t, players: [[x,y]|null × 22], ball: [x,y]|null, ballFill?: ... } ]
//   }
//   players 下标即事件协议球员 id（0-10 主队 / 11-21 客队；0/21 恒为门将）。
//
// **外推标记（schema 扩展）**：SkillCorner 每帧固定 22 个球员点，但约 42% 是**外推值**
//   （`is_detected=false`）——坐标看起来正常但并非真实观测。本转换器把该标记**原样透传**：
//   外推点的坐标数组带**第三个元素 `1`**（`[x, y, 1]`），真检测点只有 `[x, y]`。
//   - 第三元素**缺省即真观测**，与 Metrica 转换器（其点全是真观测或 null）天然一致；
//   - 向后兼容：既有的 `p[0], p[1]` 读取方（tracking-player / renderer）完全不受影响。
//
//   球的处理**不同**：外推球用 `ballFill: 'extrapolated'`（而非坐标第三位）标记——
//   因为指标层的「球只取原始观测帧」口径认的是 `ballFill`（`isRawBallFrame`）。
//
// 用法：
//   node tools/convert-skillcorner-to-frames.mjs --match <.../<id>_match.json> --out <输出.json> \
//        [--keyframe-hz 5] [--from 0] [--to 300] [--ball-fill nearest|hold|none]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// 外推标记（坐标数组第三位）。真观测不带第三位。
export const EXTRAPOLATED_FLAG = 1;

// SkillCorner 采样率固定 10 fps（帧间隔 0.1s）。
export const SKILLCORNER_HZ = 10;

// ── 解析 ────────────────────────────────────────────────────────────────

// 比赛时钟串（`HH:MM:SS.ss`）→ 秒。空/非法返回 null。
// 注意：这是**比赛时钟**，每半场从 0 起、下半场回到 45:00，直接当连续时间用会回跳（见 D3）。
export function parseClock(s) {
  if (typeof s !== 'string') return null;
  const p = s.split(':');
  if (p.length !== 3) return null;
  const [h, m, sec] = [Number(p[0]), Number(p[1]), Number(p[2])];
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  return h * 3600 + m * 60 + sec;
}

// 读一场 tracking JSONL → 只保留**有球员数据**的帧（空帧没有观测，是转播间隙）。
// 每帧带：frame（源帧号）、period、clock（比赛时钟秒）、players（22 条 player_data）、ball。
//
// `opts.clockOut`（可选 Map）：把**所有**帧（含被滤掉的空帧）的 frame→clock 收进去。
// 权威半场边界（`match_periods[].end_frame/start_frame`）指向的帧常常正是**空帧**
// （实测 1874553 的 frame 28990 有时钟 00:48:18.00 但无 player_data）——只从保留帧里
// 查边界时钟会查不到、静默退回观测极值。故边界时钟要在这里全量收集。
export function parseTrackingJsonl(text, opts = {}) {
  const { clockOut = null } = opts;
  const frames = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // 单行损坏不该废掉整场
    }
    const clock = parseClock(d.timestamp);
    if (clockOut && Number.isFinite(clock)) clockOut.set(d.frame, clock);
    const pd = d.player_data;
    if (!Array.isArray(pd) || pd.length === 0) continue;
    frames.push({
      frame: d.frame,
      period: d.period,
      clock,
      players: pd,
      ball: d.ball_data || null,
    });
  }
  return frames;
}

// 把"比赛时钟"拼成单调时间轴（design D3）：
//   P2 的时间戳整体 +shift，使交界处不回跳。中场休息被**压缩**——与引擎侧 5400s
//   不含中场死时间的语义保持同构（引擎的 t=2700 与真实的 t=2700 落在同一比赛阶段）。
//
// **shift 的来源**（design D3 修订 + 审阅 P2-1d）：
//   优先用源数据自带的**权威半场边界** `match.json.match_periods[]`——取
//   `clock(P1.end_frame) − clock(P2.start_frame)`。
//   退回（无 match_periods / 边界帧查不到时钟时）才用观测极值 `max(P1.t) − min(P2.t)`。
//
// ⚠️ **为什么不用观测极值**：P1 尾 / P2 头若有缺帧，"末尾真正存在的帧"会比半场边界**早**，
//   观测极值法会把这缺失的一段时间**静默吸收进 shift**——接缝间隙恒为 0，缺口被藏起来。
//   实测 20 场平均差 ~7s（如 1874553：权威 198.0s vs 观测 190.9s，差 7.1s 的 P1 尾部缺口）。
//   用权威边界则缺口**如实显形**为接缝间隙（recordedSeamGapSec），符合本项目
//   「缺口如实记录、不隐藏」的一贯原则。
//
// 只有单半场时不平移。返回 { shift, shiftSource, seamGapSec, frames: [{...原始帧, t}] }。
export function stitchTimeline(frames, { matchPeriods = null, clockByFrame = null } = {}) {
  const byPeriod = new Map();
  for (const f of frames) {
    if (!byPeriod.has(f.period)) byPeriod.set(f.period, []);
    byPeriod.get(f.period).push(f);
  }
  const p1 = byPeriod.get(1) || [];
  const p2 = byPeriod.get(2) || [];
  const obsShift = (p1.length && p2.length)
    ? Math.max(...p1.map((f) => f.clock).filter(Number.isFinite))
      - Math.min(...p2.map((f) => f.clock).filter(Number.isFinite))
    : 0;

  let shift = obsShift;
  let shiftSource = 'observed-extremes';
  if (Array.isArray(matchPeriods) && matchPeriods.length >= 2) {
    const endFrame = matchPeriods[0] && matchPeriods[0].end_frame;
    const startFrame = matchPeriods[1] && matchPeriods[1].start_frame;
    // 边界时钟优先查调用方给的全量 map（含空帧）；没有就用保留帧兜底。
    const map = clockByFrame || new Map(frames.filter((f) => Number.isFinite(f.clock)).map((f) => [f.frame, f.clock]));
    const a = map.get(endFrame);
    const b = map.get(startFrame);
    if (Number.isFinite(a) && Number.isFinite(b)) { shift = a - b; shiftSource = 'match_periods'; }
  }

  const out = frames.map((f) => ({
    ...f,
    t: f.period === 2 ? f.clock + shift : f.clock,
  }));
  // 排序保证单调（源文件本就有序；显式排序是对"回跳"的兜底，不依赖源顺序）
  out.sort((a, b) => a.t - b.t || a.frame - b.frame);

  // 接缝间隙 = 拼接后 P1 末帧到 P2 首帧的间隔。用权威边界时它**恰等于**半场边界处
  // 缺失的观测时长（0 = 首尾帧齐全）；用观测极值法时恒为 0（缺口被吸收）。
  const p1Max = out.filter((f) => f.period === 1).reduce((m, f) => Math.max(m, f.t), -Infinity);
  const p2Min = out.filter((f) => f.period === 2).reduce((m, f) => Math.min(m, f.t), Infinity);
  const seamGapSec = (Number.isFinite(p1Max) && Number.isFinite(p2Min)) ? Math.max(0, p2Min - p1Max) : null;

  return { shift, shiftSource, seamGapSec, frames: out };
}

// 时间轴缺口统计：相邻帧的**异常大**间隔（无观测时段，来自回放/特写；半场拼接处那一个也计入）。
//
// 阈值必须**高于正常采样间隔**：源 10fps 抽样到 5Hz 后正常间隔是 0.2s，用固定 0.15s
// 会把**每一对相邻帧**都判成缺口（实测踩过：20339 处"缺口"/20341 帧，数字荒谬到一眼假）。
// 这里按"正常间隔的 1.5 倍"判，容忍浮点/相位噪声，又能抓住真正的缺口。
export function timelineGaps(frames, nominalIntervalSec = 0.2) {
  const threshold = nominalIntervalSec * 1.5;
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt > threshold) gaps.push({ afterFrame: frames[i - 1].frame, sec: dt });
  }
  const secs = gaps.map((g) => g.sec);
  return {
    count: gaps.length,
    maxSec: secs.length ? Math.max(...secs) : 0,
    totalSec: secs.reduce((a, b) => a + b, 0),
  };
}

// ── 身份与槽位 ──────────────────────────────────────────────────────────

// 门将判定：**必须**用 player_role.name（实测 position_group 对门将是 "Other"，
// 只查 position_group 会漏掉全部门将——design「上下文」第 4 条）。
export function isGoalkeeper(player) {
  const role = player && player.player_role;
  return !!role && role.name === 'Goalkeeper';
}

// 归一化：米 + 球场中心原点 → [0,1] + 左门线原点。
//   x01 = x / L + 0.5（中心原点 → 左端 0）；主队该半场 `right_to_left` 时翻成 1-x01
//   y01 = 1 − (y / W + 0.5)（与 Metrica 转换器同一条 y 翻转：y=0 是下边线）
// L/W 取**该场自己的**球场尺寸（104/105/106，不得硬编码——design D4）。
export function makeNormalizer(pitchLength, pitchWidth, homeSides) {
  const sideFor = (period) => (Array.isArray(homeSides) && period >= 1 && period <= homeSides.length
    ? homeSides[period - 1] : 'left_to_right');
  return (x, y, period) => {
    let x01 = x / pitchLength + 0.5;
    if (sideFor(period) === 'right_to_left') x01 = 1 - x01;
    return [x01, 1 - (y / pitchWidth + 0.5)];
  };
}

// 该队在某半场的"是否翻转 x"（归一化后恒为「主队攻向 x=1」，故客队朝反方向）。
function teamFlipsHomeSide(homeSides, period, isHome) {
  const side = Array.isArray(homeSides) && period >= 1 && period <= homeSides.length
    ? homeSides[period - 1] : 'left_to_right';
  const homeFlips = side === 'right_to_left';
  return isHome ? homeFlips : !homeFlips;
}

// 槽位分配（0-10；主队 → id = slot，客队 → id = 11 + slot）。
//
// 与 Metrica 的 assignIds 同思路（门将占 0、其余按 depth 从后到前排），但**门将由
// player_role 显式钉住**而不是靠"谁最深"——design 明确要求用 role，且把门将钉死
// 才能保证指标层「剔除 id 0/21」剔的真是门将（若靠深度，出击型门将可能被排到中场槽位，
// 指标就会把真门将算进队形、把后卫当门将剔掉）。
//
// 替补：主力（首发 11 人）不在场的帧，由在场替补顶上其槽位。替补顶谁的槽位不影响
// 任何指标（指标按位置算、不按身份），只需保证**每帧 10 名非门将 + 1 名门将**。
export function assignSkillcornerIds(rosterTeam, frames, isHome, homeSides) {
  const byId = new Map(rosterTeam.map((p) => [p.id, p]));
  const toId = (slot) => (isHome ? slot : 11 + slot);

  const present = frames.map((f) => new Set(f.players.map((p) => p.player_id)));

  // 首发 11 人 = 第一帧在场者（数据保证每帧每队 11 人；不足时按 roster 顺序补齐，
  // 并如实记入 coverage——不静默造人）。
  const first = present[0] || new Set();
  const starters = rosterTeam.filter((p) => first.has(p.id)).map((p) => p.id);
  for (const p of rosterTeam) {
    if (starters.length >= 11) break;
    if (!starters.includes(p.id)) starters.push(p.id);
  }
  const main = new Set(starters.slice(0, 11));
  const subs = rosterTeam.filter((p) => !main.has(p.id)).map((p) => p.id);

  // depth = 到本方门线的平均距离（在「该队攻向 x=1」的坐标系里恒为本方门线在 0）。
  const depth = new Map();
  for (const p of rosterTeam) {
    const norm = makeNormalizer(1, 1, homeSides); // 只用到 x，尺寸无关紧要
    let sum = 0;
    let n = 0;
    for (let i = 0; i < frames.length; i += 1) {
      if (!present[i].has(p.id)) continue;
      const raw = frames[i].players.find((q) => q.player_id === p.id);
      if (!raw || raw.x == null) continue;
      const [x01] = norm(raw.x, raw.y, frames[i].period);
      // 主队攻向 x=1 → 本方门线在 x=0，depth = x01；客队攻向 x=0 → depth = 1 - x01
      sum += isHome ? x01 : 1 - x01;
      n += 1;
    }
    depth.set(p.id, n ? sum / n : (isHome ? 0 : 1));
  }

  // 门将：主力门将占门将槽；无主力门将时用替补门将（红牌/伤退场景）。
  const gks = rosterTeam.filter(isGoalkeeper).map((p) => p.id);
  const mainGk = gks.find((id) => main.has(id)) ?? gks[0] ?? null;
  const gkSlot = isHome ? 0 : 10;

  const slotOf = new Map();
  if (mainGk != null) slotOf.set(mainGk, gkSlot);
  const outfield = starters.filter((id) => main.has(id) && id !== mainGk);
  // 按 depth 升序：最深者排最靠本方门线的槽位
  outfield.sort((a, b) => depth.get(a) - depth.get(b));
  outfield.forEach((id, i) => slotOf.set(id, isHome ? 1 + i : 9 - i));

  // 逐帧槽位映射：主力在场 → 其槽位；缺席槽位 → 在场替补顶上；门将槽始终给在场门将。
  //
  // ⚠️ **按帧对象现算，不预计算成与 `frames` 平行的数组**（这是修过的 bug）：
  // 早先版本返回 `frameIds: frames.map(...)`，调用方用 `frameIds[k]` 按下标配——
  // 但转换器在 `--from/--to` 裁剪时，keyframes 的下标锚在**裁剪后窗口**上，而
  // assignSkillcornerIds 是在**全量帧**上跑的，两套下标会错位（相位不同时 keyframes
  // 甚至不是 fullKeyframes 的子集）。后果实测：换人后某帧少一名球员（21 而非 22）。
  // 现算则对任何帧都给正确的映射，与下标无关。
  // 需要全量上下文的只有 main/subs/slotOf/depth（首发、替补、槽位顺序）——那些仍由
  // 传入的 `frames`（全量）决定，与被转换的窗口无关。
  const slotMapFor = (f) => {
    const onPitch = new Set(f.players.map((p) => p.player_id));
    const m = new Map();
    const gkOn = gks.find((id) => onPitch.has(id));
    if (gkOn != null) m.set(gkOn, gkSlot);
    for (const id of main) {
      if (id === mainGk || !onPitch.has(id)) continue;
      m.set(id, slotOf.get(id));
    }
    const filled = new Set(m.values());
    const subsOn = subs.filter((id) => onPitch.has(id) && !m.has(id));
    let si = 0;
    for (const id of main) {
      if (id === mainGk || onPitch.has(id)) continue;
      const slot = slotOf.get(id);
      if (filled.has(slot)) continue;
      if (si < subsOn.length) { m.set(subsOn[si], slot); si += 1; filled.add(slot); }
    }
    return m;
  };

  return { slotMapFor, slotOf, toId, mainGk, main: [...main], subs, depth, gks };
}

// ── 主转换 ──────────────────────────────────────────────────────────────

export function convertSkillcorner(matchJson, trackingText, opts = {}) {
  const keyframeHz = opts.keyframeHz ?? 5;
  const hz = opts.hz ?? SKILLCORNER_HZ;
  const ballFillMode = opts.ballFill ?? 'nearest';
  if (keyframeHz > hz) throw new Error(`--keyframe-hz (${keyframeHz}) 不能大于源频率 (${hz})`);
  const stride = Math.max(1, Math.round(hz / keyframeHz));

  const L = matchJson.pitch_length;
  const W = matchJson.pitch_width;
  if (!Number.isFinite(L) || !Number.isFinite(W)) {
    throw new Error('match.json 缺少 pitch_length / pitch_width——球场尺寸必须逐场读取（不得硬编码）');
  }
  const homeTeamId = matchJson.home_team && matchJson.home_team.id;
  const awayTeamId = matchJson.away_team && matchJson.away_team.id;
  if (homeTeamId == null || awayTeamId == null) throw new Error('match.json 缺少 home_team/away_team id');
  const homeSides = matchJson.home_team_side;

  const roster = matchJson.players || [];
  const homeRoster = roster.filter((p) => p.team_id === homeTeamId);
  const awayRoster = roster.filter((p) => p.team_id === awayTeamId);
  if (homeRoster.length === 0 || awayRoster.length === 0) {
    throw new Error('阵容为空——match.json.players 里没有该队的球员');
  }
  const rosterIds = new Set(roster.map((p) => p.id));

  // 解析 + 时间轴拼接
  // 全量 frame→clock（含空帧）——权威半场边界帧常常正是空帧，只在保留帧里查会查不到。
  const clockByFrame = new Map();
  const parsed = parseTrackingJsonl(trackingText, { clockOut: clockByFrame });
  if (parsed.length === 0) throw new Error('tracking 里没有任何含球员数据的帧');
  const { shift, shiftSource, seamGapSec, frames: allFrames } = stitchTimeline(parsed, {
    matchPeriods: matchJson.match_periods,
    clockByFrame,
  });

  // 时间窗裁剪（秒，拼接后的 t），在降采样之前做
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const selected = allFrames.filter((f) => f.t >= from && f.t <= to);
  if (selected.length === 0) throw new Error(`时间窗 [${from}, ${to}] 内没有帧`);

  // **朝向与槽位用全量帧判定**，与 Metrica 转换器同理：裁剪窗口可能只覆盖很短一段，
  // 短窗口里判方向会静默判反。裁剪只影响输出范围。
  const fullKeyframes = allFrames.filter((_, i) => i % stride === 0);
  const homeIds = assignSkillcornerIds(homeRoster, fullKeyframes, true, homeSides);
  const awayIds = assignSkillcornerIds(awayRoster, fullKeyframes, false, homeSides);

  const keyframes = selected.filter((_, i) => i % stride === 0);
  const normalize = makeNormalizer(L, W, homeSides);

  // 归一化后主队门将应贴近 x=0、客队门将贴近 x=1——朝向判反会让整场镜像，
  // 而镜像在小窗口上极难肉眼发现，故**显式自检并在失败时报错**（宁可失败不可静默给错）。
  const orientationCheck = checkKeeperSides(keyframes, homeIds, awayIds, normalize);

  let ballMissing = 0;
  let ballExtrapolated = 0;
  let lastBall = null;
  let extrapolatedPoints = 0;
  let playerPoints = 0;
  let nullFlagPoints = 0;
  let unknownPlayerPoints = 0;
  let offPitchPoints = 0;
  const outOfRange = { x: 0, y: 0 };

  const frames = keyframes.map((f) => {
    const players = new Array(22).fill(null);
    const place = (teamRoster, ids) => {
      const slotMap = ids.slotMapFor(f); // 按帧现算，与下标无关（见 slotMapFor 注释）
      for (const p of f.players) {
        const slot = slotMap.get(p.player_id);
        if (slot == null) continue;
        const norm = normalize(p.x, p.y, f.period);
        // 外推标记：**只有 is_detected===true 才当真观测**；false/null/缺省一律按外推处理
        // （未知即不信任——对齐 spec「不静默采信」）。
        const extrapolated = p.is_detected !== true;
        players[ids.toId(slot)] = extrapolated ? [norm[0], norm[1], EXTRAPOLATED_FLAG] : norm;
        playerPoints += 1;
        if (extrapolated) extrapolatedPoints += 1;
        if (p.is_detected === undefined || p.is_detected === null) nullFlagPoints += 1;
        if (norm[0] < 0 || norm[0] > 1) outOfRange.x += 1;
        if (norm[1] < 0 || norm[1] > 1) outOfRange.y += 1;
        if (norm[0] < 0 || norm[0] > 1 || norm[1] < 0 || norm[1] > 1) offPitchPoints += 1;
      }
    };
    place(homeRoster, homeIds);
    place(awayRoster, awayIds);
    for (const p of f.players) if (!rosterIds.has(p.player_id)) unknownPlayerPoints += 1;

    // 球：有坐标则按 is_detected 标外推；无坐标走 ballFill 补全（沿用 Metrica 语义）。
    //
    // 外推的球用 `ballFill: 'extrapolated'` 标记，而**不是**坐标第三位——因为指标层的
    // 「球只取原始观测帧」口径（P36 D2）认的是 `ballFill`（`isRawBallFrame`）。若外推球
    // 不写进 ballFill，它会被当成原始观测进主口径，等于拿外推启发式对比真实观测——
    // 正是 D2 要消除的那类口径分叉，只不过发生在球上。复用 ballFill 后指标层零改动。
    let ball = null;
    let ballFill = null;
    const b = f.ball;
    if (b && b.x != null && b.y != null) {
      const norm = normalize(b.x, b.y, f.period);
      ball = norm;
      if (b.is_detected !== true) { ballFill = 'extrapolated'; ballExtrapolated += 1; }
      lastBall = norm;
    } else {
      ballMissing += 1;
      if (ballFillMode === 'nearest' && lastBall) {
        let bestId = -1;
        let bestD = Infinity;
        for (let i = 0; i < 22; i += 1) {
          const p = players[i];
          if (!p) continue;
          const d = (p[0] - lastBall[0]) ** 2 + (p[1] - lastBall[1]) ** 2;
          if (d < bestD) { bestD = d; bestId = i; }
        }
        if (bestId >= 0) { ball = [players[bestId][0], players[bestId][1]]; ballFill = bestId; lastBall = ball; }
      } else if (ballFillMode === 'hold' && lastBall) {
        ball = lastBall;
        ballFill = 'hold';
      }
    }
    const out = { t: f.t, players, ball };
    if (ballFill !== null) out.ballFill = ballFill;
    return out;
  });

  const playerCells = frames.length * 22;
  const filled = frames.reduce((a, f) => a + f.players.filter(Boolean).length, 0);
  let shortHanded = 0;
  for (const f of frames) if (f.players.filter(Boolean).length < 22) shortHanded += 1;
  let dupFrames = 0;
  for (const f of frames) {
    const seen = new Set();
    let dup = false;
    for (const p of f.players) {
      if (!p) continue;
      const key = `${p[0]},${p[1]}`;
      if (seen.has(key)) dup = true;
      else seen.add(key);
    }
    if (dup) dupFrames += 1;
  }
  const gaps = timelineGaps(frames, 1 / keyframeHz);

  return {
    meta: {
      source: 'SkillCorner/opendata',
      format: 'skillcorner-jsonl',
      game: String(matchJson.id),
      // 场次状态原样透传（实测 20 场里 1953632 是 not_started、其余 closed）。
      // 基线**不按它过滤**（tracking 数据完整），但须逐场记录 + 声明理由——
      // 不静默纳入（对齐 P36「未覆盖维度须显式声明」，P37 审阅 P3-4）。
      status: matchJson.status ?? null,
      hz,
      keyframeHz,
      frames: frames.length,
      startTime: frames[0].t,
      endTime: frames[frames.length - 1].t,
      coord: { origin: 'bottom-left', axis: '0-1', note: '与引擎一致：x=0 是 home 门线，y=0 是下边线' },
      orientation: 'normalized: home always attacks x=0 -> x=1',
      orientationDetected: {
        sourceHomeTeamSide: homeSides,
        keeperSideCheck: orientationCheck,
      },
      // 逐场球场尺寸（104/105/106 三种，不得硬编码）。指标层按**同一逐场尺寸**换算回米制
      // （design D4 修订后；早先"统一按 105×68"会引入按场地尺寸系统性分组的偏置）。
      pitchMeters: { length: L, width: W },
      timeAxis: {
        stitch: 'P2 += shift——压缩中场休息，与引擎 5400s（无中场死时间）同构',
        shiftSource, // 'match_periods'（权威半场边界）| 'observed-extremes'（退回）
        shiftSec: Number(shift.toFixed(2)),
        // 接缝间隙：拼接后 P1 末帧到 P2 首帧的间隔。用权威边界时它恰等于半场边界处
        // 缺失的观测时长（0 = 首尾帧齐全；>0 = 该处缺帧，如实显形不藏）。
        seamGapSec: seamGapSec == null ? null : Number(seamGapSec.toFixed(2)),
        gaps: { count: gaps.count, maxSec: Number(gaps.maxSec.toFixed(2)), totalSec: Number(gaps.totalSec.toFixed(2)) },
      },
      idMap: {
        home: Object.fromEntries([...homeIds.slotOf].map(([nid, slot]) => [nid, homeIds.toId(slot)])),
        away: Object.fromEntries([...awayIds.slotOf].map(([nid, slot]) => [nid, awayIds.toId(slot)])),
        note: 'tracking 的 player_id 对应 match.json.players[].id（**不是** trackable_object——实测交集 0）',
      },
      coverage: {
        playerCellsFilledPct: Number((100 * filled / playerCells).toFixed(2)),
        shortHandedPct: Number((100 * shortHanded / frames.length).toFixed(2)),
        ballMissingPct: Number((100 * ballMissing / frames.length).toFixed(2)),
        ballFillMode,
        ballExtrapolatedPct: Number((100 * ballExtrapolated / frames.length).toFixed(2)),
        duplicateCoordPct: Number((100 * dupFrames / frames.length).toFixed(2)),
        // 外推点占比：这是本数据集的**核心质量指标**（design D2 的口径分歧源头）
        extrapolatedPointPct: Number((100 * extrapolatedPoints / Math.max(1, playerPoints)).toFixed(2)),
        offPitchPointPct: Number((100 * offPitchPoints / Math.max(1, playerPoints)).toFixed(2)),
        // 未知球员点（player_id 不在 roster 里）：设计期实测为 0，留作安全网
        unknownPlayerPointPct: Number((100 * unknownPlayerPoints / Math.max(1, playerPoints + unknownPlayerPoints)).toFixed(2)),
        note: '外推点（is_detected=false）坐标看起来正常但非真实观测——本转换器原样透传（坐标第三位=1），'
          + '指标层默认口径跳过；offPitch 是源坐标系里超出球场的点（球员贴边/球出界），如实保留不移位',
      },
      notes: [
        '半场时钟回跳已在 timeAxis 里拼接成单调轴（design D3）；拼接处与转播间隙造成的缺口如实记录，不插值',
        '球场尺寸逐场记录于 pitchMeters；指标层按同一逐场尺寸换算回米制（design D4 修订后）',
      ],
    },
    frames,
  };
}

// 自检：归一化后主队门将应在 x≈0 一侧、客队门将应在 x≈1 一侧。
// 朝向判反会把整场镜像——静默给错比显式失败危险得多（对齐 Metrica 转换器的原则）。
export function checkKeeperSides(keyframes, homeIds, awayIds, normalize) {
  const meanX = (ids, slot) => {
    let sum = 0;
    let n = 0;
    for (const f of keyframes) {
      const slotMap = ids.slotMapFor(f); // 按帧现算（与下标无关）
      const gkId = [...slotMap.entries()].find(([, s]) => s === slot)?.[0];
      if (gkId == null) continue;
      const raw = f.players.find((p) => p.player_id === gkId);
      if (!raw || raw.x == null) continue;
      sum += normalize(raw.x, raw.y, f.period)[0];
      n += 1;
    }
    return n ? sum / n : null;
  };
  const home = meanX(homeIds, 0);
  const away = meanX(awayIds, 10);
  const ok = home != null && away != null && home < 0.5 && away > 0.5;
  return {
    homeKeeperMeanX: home == null ? null : Number(home.toFixed(4)),
    awayKeeperMeanX: away == null ? null : Number(away.toFixed(4)),
    ok,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { keyframeHz: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--match') out.match = argv[++i];
    else if (a === '--in') out.match = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--keyframe-hz') out.keyframeHz = Number(argv[++i]);
    else if (a === '--hz') out.hz = Number(argv[++i]);
    else if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--ball-fill') out.ballFill = argv[++i];
  }
  if (out.ballFill !== undefined && !['nearest', 'hold', 'none'].includes(out.ballFill)) {
    throw new Error(`--ball-fill 只接受 nearest / hold / none，收到 ${out.ballFill}`);
  }
  return out;
}

// match.json 路径 → tracking 实体 JSONL 的路径（命名规则 `<id>_tracking_extrapolated.jsonl`）。
//
// **注意目录不同**：match.json 在骨架里（`<root>/opendata-master/data/matches/<id>/`），
// 而同目录下的 tracking 文件是 **LFS 指针（133 字节）**，不是数据！实体被
// fetch-tracking-data.mjs 下到 `<root>/tracking/<id>_tracking_extrapolated.jsonl`。
// 早先版本只在同目录找，读到指针 → 解析出 0 帧，报错却像"数据格式不对"（坑）。
// 这里按优先级找**实体**：先找下载目录，再退回同目录；并把"读到 LFS 指针"显式判成错误。
export function resolveTrackingPath(matchPath, { trackingDir = null } = {}) {
  const dir = dirname(matchPath);
  const id = basename(matchPath).replace(/_match\.json$/, '');
  const name = `${id}_tracking_extrapolated.jsonl`;
  // 候选目录：显式指定的；match 目录本身；以及从 match 目录**逐级上溯**找名为 `tracking`
  // 的同级目录（下载布局 `<root>/tracking/` 与骨架 `<root>/opendata-master/data/matches/...`
  // 的相对深度会随布局变化，写死 `../..` 会错——这里不赌层数）。
  const candidates = [trackingDir && join(trackingDir, name), join(dir, name)];
  let up = dir;
  for (let i = 0; i < 5; i += 1) {
    up = resolve(up, '..');
    candidates.push(join(up, 'tracking', name));
  }
  for (const c of candidates) {
    if (c && existsSync(c) && !isLfsPointerFile(c)) return c;
  }
  for (const c of candidates) if (c && existsSync(c)) return c; // 只剩指针：返回它，让调用方报错
  return candidates[1];
}

// 文件是否是 Git LFS 指针（133 字节的 `version https://git-lfs...`）。
export function isLfsPointerFile(path) {
  try {
    return readFileSync(path).slice(0, 64).toString('utf8').startsWith('version https://git-lfs');
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.match || !args.out) {
    console.error('用法: node tools/convert-skillcorner-to-frames.mjs --match <.../<id>_match.json> --out <输出.json> [--keyframe-hz 5] [--from 0] [--to 300] [--ball-fill nearest]');
    process.exit(1);
  }
  const matchPath = resolve(args.match);
  const trackingPath = resolveTrackingPath(matchPath);
  if (!existsSync(matchPath)) throw new Error(`找不到 match.json：${matchPath}`);
  if (!existsSync(trackingPath)) {
    throw new Error(`找不到 tracking 实体：${trackingPath}\n（tracking 是 Git LFS 实体，须先运行 node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata）`);
  }
  if (isLfsPointerFile(trackingPath)) {
    throw new Error(`${trackingPath} 是 Git LFS 指针（${readFileSync(trackingPath).length} 字节），不是数据。`
      + '\n下载实体：node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata');
  }
  const result = convertSkillcorner(
    JSON.parse(readFileSync(matchPath, 'utf8')),
    readFileSync(trackingPath, 'utf8'),
    { keyframeHz: args.keyframeHz, hz: args.hz, from: args.from, to: args.to, ballFill: args.ballFill },
  );
  if (!result.meta.orientationDetected.keeperSideCheck.ok) {
    throw new Error(`朝向自检失败：${JSON.stringify(result.meta.orientationDetected.keeperSideCheck)}`
      + '——归一化后主队门将应在 x≈0、客队门将应在 x≈1；判反会让整场镜像，拒绝静默输出');
  }
  writeFileSync(args.out, JSON.stringify(result));
  const bytes = readFileSync(args.out).length;
  const c = result.meta.coverage;
  console.error(`✔ ${args.out}`);
  console.error(`  ${result.meta.frames} 帧 @ ${result.meta.keyframeHz}Hz | 时长 ${result.meta.startTime.toFixed(1)}-${result.meta.endTime.toFixed(1)}s | ${(bytes / 1e6).toFixed(2)} MB`);
  console.error(`  球场 ${result.meta.pitchMeters.length}×${result.meta.pitchMeters.width}m | 半场平移 +${result.meta.timeAxis.shiftSec}s`
    + ` | 缺口 ${c.ballMissingPct > 0 ? '' : ''}${result.meta.timeAxis.gaps.count} 处 / ${result.meta.timeAxis.gaps.totalSec}s`);
  console.error(`  外推点 ${c.extrapolatedPointPct}% | 球外推 ${c.ballExtrapolatedPct}% | 填充率 ${c.playerCellsFilledPct}% | 出界点 ${c.offPitchPointPct}%`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
