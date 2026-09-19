// P38 wayfinder #90「真实横向行为规律（个体层面）」共用装载器与统计工具。
//
// ── 口径（读任何数字前必看）─────────────────────────────────────────────
//
// **沿用 P36/P37/P38 的既有口径，不新建**（底座口径全部从 `probes/corpus.mjs` 取）：
//   - 客队镜像：x 统一到「离本方门线距离」（away x → L − x）。**y 不镜像**（主客共用同一条 y）。
//   - y 轴用 PITCH_WIDTH_M(68)。球场宽实测 8 场恒 68（`04-width-channels.mjs` 已核）。
//   - 槽位 = 转换器按整场平均深度排的身份槽位（一场内固定），**不是瞬时位置身份**；
//     SkillCorner 另有真实位置标签（`probes/roles.mjs`），本套探针用它。
//   - 控球：SkillCorner 用**源数据自带的 `possession.group`**（真值，不是代理）；
//     Metrica 无此字段，退回 `corpus.poss()` 的最近球员代理——两者**不可混池**，分列。
//
// **本套探针新增的唯一口径决定：外推点默认「采信」（全点口径）**。理由与对照见
// `out/00-口径说明.txt`（q90-0-caliber.mjs 生成）：
//   SkillCorner 转换产物**每帧 22 槽位全满**（coverage.playerCellsFilledPct=100），
//   而 `is_detected=false` 的点是 SkillCorner 自己模型的外推输出、坐标在球场上。
//   跳过它们会让每帧有效人数**浮动**（实测均值 ~8.4、众数 6–9），且缺失与球位置强相关
//   （P38 findings-final §1：真检测率沿队形深度呈 U 形，两端低 17.5pp）——
//   即"跳过"会**按球位置系统性截断队形两端**，对「横向分布」「重心」这类量是选择性偏倚。
//   采信外推则得到**每帧恒定 10 人的面板**，重心/分布/回归的估计量无 n 效应。
//   两者都算、都印；差异 ≥ 0.3m 或 ≥ 3pp 的地方单独标注。
//
// 用 `q90-common.mjs` 的 `loadReal()` 一次拿到全部真实比赛；`framePlayers()` 取一帧一队
// 的逐人条目（x 米/已镜像、y 米、line 标签、extrapolated 标记）。

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = findRepoRoot(HERE);
export const PROBES_MAIN = HERE;
export const OUT_DIR = join(HERE, 'out');

const corpus = await import('../probes/corpus.mjs');
const rolesMod = await import('../probes/roles.mjs');
export const {
  METRICA_IDS, SKILLCORNER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, KEEPER_IDS, mean, std,
} = corpus;

export const CHANNEL_EDGES = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1]; // 5 条 13.6m 通道（与 real-formation-laws §6.2 同）
export const CHANNEL_NAMES = ['左翼', '左半', '中路', '右半', '右翼'];

export function channelOf(yMeters, W = PITCH_WIDTH_M) {
  const t = yMeters / W;
  if (t < 1 / 5) return 0;
  if (t < 2 / 5) return 1;
  if (t < 3 / 5) return 2;
  if (t < 4 / 5) return 3;
  return 4;
}

// ── SkillCorner 真实控球相位（侧信道）───────────────────────────────────
//
// 源 jsonl 每帧带 `possession.group`（"home team"/"away team"/null）与
// `possession.player_id`。转换器**不写进产物**（产物只有 t/players/ball/ballFill），
// 故这里另行抽取成一个紧凑侧文件，落在 `.scratch/p38-frames/<id>-phase.json`。
//
// **对齐方式**：重放转换器的时间轴（parseTrackingJsonl → stitchTimeline → 每 stride 取一），
// 然后**断言 t 数组与转换产物逐位相等**。不等即报错——不靠"看起来差不多"。
export function phaseArtifactPath(id) {
  return join(REPO, '.scratch', 'p38-frames', `skillcorner-${id}-phase.json`);
}

export function loadSkillcornerPhase(id) {
  const outPath = phaseArtifactPath(id);
  if (existsSync(outPath)) return JSON.parse(readFileSync(outPath, 'utf8'));
  return null;
}

export function buildSkillcornerPhase(id) {
  const M = requireSync(join(REPO, 'tools', 'convert-skillcorner-to-frames.mjs'));
  const rawDir = join(REPO, '.scratch', 'tracking-data', 'skillcorner');
  const tracking = readFileSync(join(rawDir, 'tracking', `${id}_tracking_extrapolated.jsonl`), 'utf8');
  const matchJson = JSON.parse(readFileSync(
    join(rawDir, 'opendata-master', 'data', 'matches', id, `${id}_match.json`), 'utf8'));
  const clockByFrame = new Map();
  const parsed = M.parseTrackingJsonl(tracking, { clockOut: clockByFrame });
  // `parseTrackingJsonl` **不透传 `possession`**（它只留 frame/period/clock/players/ball），
  // 故相位另从原始行按 frame 号建索引——转换器的时间轴与帧号都是我们复用的，
  // 不重写、不猜。
  const possByFrame = new Map();
  for (const line of tracking.split('\n')) {
    if (line.length === 0) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    possByFrame.set(d.frame, d.possession || null);
  }
  const { frames: all } = M.stitchTimeline(parsed, {
    matchPeriods: matchJson.match_periods, clockByFrame,
  });
  const HZ = 10;
  const stride = Math.max(1, Math.round(HZ / 5));
  const kf = all.filter((_, i) => i % stride === 0);
  const conv = JSON.parse(readFileSync(join(REPO, '.scratch', 'p38-frames', `skillcorner-${id}.json`), 'utf8'));
  if (kf.length !== conv.frames.length) {
    throw new Error(`${id} 相位侧信道对齐失败：kf ${kf.length} ≠ 产物 ${conv.frames.length}`);
  }
  for (let i = 0; i < kf.length; i += 1) {
    if (Math.abs(kf[i].t - conv.frames[i].t) > 1e-6) {
      throw new Error(`${id} 相位侧信道 t 失配 @${i}：${kf[i].t} vs ${conv.frames[i].t}`);
    }
  }
  const art = {
    id,
    note: 'possession.group 源真值；group: 0=home 1=away -1=null；ballDet: 球是否 is_detected',
    t: kf.map((f) => f.t),
    group: kf.map((f) => {
      const pc = possByFrame.get(f.frame);
      const g = pc && pc.group;
      return g === 'home team' ? 0 : g === 'away team' ? 1 : -1;
    }),
    pid: kf.map((f) => {
      const pc = possByFrame.get(f.frame);
      return pc && pc.player_id != null ? pc.player_id : -1;
    }),
    period: kf.map((f) => (f.period === 2 ? 2 : 1)),
    ballDet: kf.map((f) => (f.ball && f.ball.is_detected === true ? 1 : 0)),
  };
  writeFileSync(phaseArtifactPath(id), JSON.stringify(art));
  return art;
}

// 同步 require（buildSkillcornerPhase 是同步 API）：node 22 无 require，这里手动从缓存取。
// 该模块已在 loadReal 里被 import 过；用 createRequire 保证任何调用顺序都能拿到。
import { createRequire } from 'node:module';
const requireSync = createRequire(import.meta.url);

// ── 横向朝向归一（**本套探针的关键口径修正**）─────────────────────────────
//
// **问题**：转换器把 x 归一化成「该队恒攻向 x=1」（半场换边时翻转 x），但 **y 只做了
// `1-y` 的固定反射、没有随半场一起翻**。半场换边在几何上是**绕球场中心的 180° 旋转**
// `(x,y) → (1-x, 1-y)`；只翻 x 而留 y，等于把下半场做成了**镜像**而不是旋转——
// 于是 i 与 68−i 的「左右手性」在两半场之间翻反。
//
// **后果**（实测）：把两半场直接拼起来算"某球员整场的 y 方差"，得到的不是他的跑动，
// 而是"半场换边把你搬到了球场另一侧"——实测 Metrica 单人 y sd 14.24m 里有一大截是这个。
// 更糟的是**逐人对比会错**：上半场在左路的人与下半场在右路的人被当成两个不同的位置。
// 对既有的 P38 结论**无影响**（`width`、`iqr`、逐帧 `cy ~ ballY` 的斜率都对纯 y 反射不变），
// 但对**跨半场的个体统计**（方差、分布、前后半场对比）是致命的。
//
// **修正**：定义 team-relative 的规范横向坐标
//     yCanon = flipped(team, period) ? (W − y') : y'
// 其中 `flipped` 与该队当半场的 **x 翻转**完全相同（两队在同一时刻方向相反，故 flipped
// 也相反）。这样 `(x', yCanon)` 对每支球队都是**恒定的手性**：他的"左"永远是 yCanon 小的一侧。
//
// **flipped 的来源**：
//   - SkillCorner：`meta.orientationDetected.sourceHomeTeamSide`（逐半场）+ 侧信道的 `period`；
//   - Metrica：`meta.orientationDetected.flipX`（逐半场）+ **数据里检测出的半场边界**
//     （转换产物不含 period，见 `metricaHalfBoundary`）。
export function lateralFlip(m, team, period) {
  let homeFlips;
  if (m.phase) {
    // SkillCorner：home 的 x 翻转 ⟺ 该半场 home 是 right_to_left
    const sides = m.roles && m.roles.homeSides;
    const side = Array.isArray(sides) && period >= 1 && period <= sides.length ? sides[period - 1] : 'left_to_right';
    homeFlips = side === 'right_to_left';
  } else if (m.meta && m.meta.orientationDetected && Array.isArray(m.meta.orientationDetected.flipX)) {
    const fx = m.meta.orientationDetected.flipX;
    homeFlips = period <= 1 ? !!fx[0] : !!fx[1];
  } else {
    return false; // 引擎：无半场、无换边
  }
  return team === 'home' ? homeFlips : !homeFlips;
}

// Metrica 转换产物**不含 period**，故半场边界必须从数据里找。
//
// 判据（物理、非拟合）：半场换边 = 绕中心 180° 旋转。取错边界会把两段错位拼接，
// 于是**同一名球员**的 `yCanon` 被劈成两个分离的簇 → 他个人的方差被"换边位移"撑大。
// 故取**使「逐人方差」的均值最小**的 t0。
//
// ⚠ **不能用池化方差**（我第一版踩的坑）：把 20 人混在一起算方差时，逐人的左右
// 差异互相抵消，目标函数对 t0 几乎不敏感（实测曲线平到 471.6 vs 478，看不出谷底），
// 会因为"t0 越大越好"的数值噪声选到区间端点。逐人方差的**均值**对同一现象敏感得多
// （实测谷底 161.6 vs 无修正 219.3 = **降 26%**，且曲线是干净的碗形）。
//
// 自检（印在 01 探针里）：最优 t0 应落在半场附近（实测 game1 47.3min / game2 45.3min），
// 且修正把逐人方差均值降下来。
const BOUNDARY_CACHE = new Map();
export function metricaHalfBoundary(m) {
  if (m.phase || !m.meta || !m.meta.orientationDetected) return null;
  if (BOUNDARY_CACHE.has(m.id)) return BOUNDARY_CACHE.get(m.id);
  const fx = m.meta.orientationDetected.flipX;
  const W = PITCH_WIDTH_M;
  const T = m.frames.length ? m.frames[m.frames.length - 1].t : 0;
  // 逐人 y 序列（原始 y'，米），一次建好供各 t0 复用
  const series = [];
  {
    const per = new Map();
    for (const f of m.frames) {
      for (const p of f.players) {
        if (!p) continue;
        if (KEEPER_IDS.includes(p.id)) continue;
        if (!per.has(p.id)) per.set(p.id, []);
        per.get(p.id).push([f.t, p.y * W]);
      }
    }
    for (const [id, arr] of per) series.push({ team: id <= 10 ? 'home' : 'away', arr });
  }
  const objAt = (t0) => {
    let s = 0;
    for (const { team, arr } of series) {
      let sum = 0; let sum2 = 0;
      for (const [t, y] of arr) {
        const hf = t < t0 ? fx[0] : fx[1];
        const fl = team === 'home' ? hf : !hf;
        const v = fl ? W - y : y;
        sum += v; sum2 += v * v;
      }
      const n = arr.length;
      s += sum2 / n - (sum / n) ** 2;
    }
    return s / series.length;
  };
  let best = null;
  // 粗扫 → 细扫（边界只需要 ≈ 秒级精度，站位在两段内本来就连续）
  for (let t0 = 1200; t0 <= Math.min(T - 600, 4200); t0 += 20) {
    const obj = objAt(t0);
    if (!best || obj < best.obj) best = { t0, obj };
  }
  for (let t0 = best.t0 - 25; t0 <= best.t0 + 25; t0 += 5) {
    const obj = objAt(t0);
    if (obj < best.obj) best = { t0, obj };
  }
  const out = { t0: best.t0, perPlayerVar: best.obj, flipX: fx, perPlayerVarNoFlip: objAt(Infinity) };
  BOUNDARY_CACHE.set(m.id, out);
  return out;
}

// 帧的 period（Metrica 用检测出的边界；SkillCorner 用侧信道真值；引擎恒 1）。
export function periodOf(m, frameIdx) {
  if (m.phase) return m.phase.period[frameIdx];
  const b = metricaHalfBoundary(m);
  if (!b) return 1;
  return m.frames[frameIdx].t < b.t0 ? 1 : 2;
}

// ── 真实比赛装载 ────────────────────────────────────────────────────────

export function loadReal() {
  const roles = rolesMod.loadAllSkillcornerRoles(SKILLCORNER_IDS);
  const out = [];
  for (const id of METRICA_IDS) out.push(decorate(corpus.loadMatch('metrica', id), null));
  for (const id of SKILLCORNER_IDS) out.push(decorate(corpus.loadMatch('skillcorner', id), roles.get(id)));
  return out;
}

const isSkillcorner = (meta) => String((meta && meta.source) || '').toLowerCase().includes('skillcorner');

function decorate(m, roleCtx) {
  const sc = isSkillcorner(m.meta);
  const phase = sc ? (loadSkillcornerPhase(m.id) || buildSkillcornerPhase(m.id)) : null;
  if (sc && !roleCtx) throw new Error(`${m.id} 缺角色表（loadAllSkillcornerRoles 没覆盖）`);
  return {
    id: m.id,
    dataset: sc ? 'skillcorner' : 'metrica',
    frames: m.frames,
    meta: m.meta,
    roles: roleCtx,
    phase,
  };
}

// 一帧一队的逐人条目（米制）。**y 已做半场朝向归一**（见 lateralFlip）：
//   x  = 离本方门线的距离（客队镜像）
//   y  = team-relative 横向（`yCanon`）——该队"左"恒为 y 小的一侧，跨半场可比
// opts.rawY = true 时另带 `yPrime`（未做朝向归一的原始 y，米）供对账用。
// opts.includeExtrapolated（缺省 true = 全点口径）。
export function framePlayers(m, frame, team, { includeExtrapolated = true, idx = null } = {}) {
  if (!frame || !frame.players) return [];
  const [L, W] = frame.pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const isHome = team === 'home';
  const i = idx != null ? idx : (m && m.frames ? m.frames.indexOf(frame) : 0);
  const flip = m && m.frames ? lateralFlip(m, team, periodOf(m, i)) : false;
  const outv = [];
  for (const p of frame.players) {
    if (!p) continue;
    if (!(isHome ? p.id <= 10 : p.id >= 11)) continue;
    if (KEEPER_IDS.includes(p.id)) continue; // 与 match-metrics.teamShape 同口径：剔门将
    if (!includeExtrapolated && p.extrapolated === true) continue;
    let x = p.x * L;
    if (!isHome) x = L - x;
    const yPrime = p.y * W;
    outv.push({
      id: p.id,
      x,
      y: flip ? W - yPrime : yPrime,
      yPrime,
      extrapolated: p.extrapolated === true,
      line: m.roles ? ((m.roles.roleById.get(p.id) || {}).line ?? null) : null,
      group: m.roles ? ((m.roles.roleById.get(p.id) || {}).group ?? null) : null,
    });
  }
  return outv;
}

// 该帧**对手**球员，用**本队**的朝向归一——这样两队在同一张 (x, yCanon) 图上可比。
export function frameOpponents(m, frame, team, opts = {}) {
  const other = team === 'home' ? 'away' : 'home';
  const ps = framePlayers(m, frame, other, opts);
  // framePlayers 已按**对手自己**的朝向归一（其 flipped 与本队相反），这里翻回来。
  const i = opts.idx != null ? opts.idx : (m.frames ? m.frames.indexOf(frame) : 0);
  const W = (frame.pitchMeters && frame.pitchMeters[1]) || PITCH_WIDTH_M;
  const flipMine = lateralFlip(m, team, periodOf(m, i));
  const flipTheirs = lateralFlip(m, other, periodOf(m, i));
  if (flipMine === flipTheirs) return ps;
  return ps.map((p) => ({ ...p, y: W - p.y, opponentFrameFlipped: true }));
}

// 球在该队朝向下的横向坐标（米）——"球在我的左还是右"。
export function ballYCanon(m, frame, team, idx) {
  if (!frame || !frame.ball) return null;
  const [L, W] = frame.pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const i = idx != null ? idx : (m.frames ? m.frames.indexOf(frame) : 0);
  const flip = lateralFlip(m, team, periodOf(m, i));
  const yp = frame.ball[1] * W;
  return flip ? W - yp : yp;
}

// 球在该队朝向下的纵向坐标（米）——离**本方**门线的距离。与 corpus.ballDepthFor 同义，
// 但按我们的 period 判定（Metrica 的 period 是检测出来的）。
export function ballXCanon(m, frame, team, idx) {
  if (!frame || !frame.ball) return null;
  const [L] = frame.pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const x = frame.ball[0] * L;
  return team === 'home' ? x : L - x;
}

// 一帧的相位：{own: 0|1|null 本方控球, opp, raw} —— own=1 表示本方控球。
// SkillCorner 用源真值（且球须是真观测）；Metrica 用最近球员代理。
export function phaseOf(m, frame, team, frameIdx) {
  if (m.phase) {
    const idx = frameIdx != null ? frameIdx : m.frames.indexOf(frame);
    const g = m.phase.group[idx];
    if (g < 0) return null; // 源里没有相位
    return team === 'home' ? (g === 0 ? 1 : 0) : (g === 1 ? 1 : 0);
  }
  const c = corpus.poss(frame);
  if (!c) return null;
  return c === team ? 1 : 0;
}

// 该帧是否可进主口径：有球、球是真观测（SkillCorner）、球员点可用。
export function usableBall(m, frame, frameIdx) {
  if (!frame.ball) return false;
  if (m.phase && m.phase.ballDet[frameIdx] !== 1) return false;
  return true;
}

// 遍历一场比赛的帧，并把**帧下标**交给回调（framePlayers 需要它做半场朝向判定）。
// 直接 m.frames.forEach 会让每个探针都得自己维护下标，容易漏——统一走这里。
export function eachFrame(m, fn) {
  for (let i = 0; i < m.frames.length; i += 1) fn(m.frames[i], i);
}

// ── 引擎装载（对照用）───────────────────────────────────────────────────

export async function loadEngineFrames({ seeds = [42, 1, 7], durationSec = 5400 } = {}) {
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(join(REPO, 'tools', 'benchmark-engine.mjs'));
  const { KEEPER_IDS: K, sampleEngineFrames } = await import(join(REPO, 'viewer', 'match-metrics.js'));
  const load = await loadEngineWasm(WASM_PATH);
  const { createGame } = await import(join(REPO, 'viewer', 'game.js'));
  const out = [];
  for (const seed of seeds) {
    const game = createGame(simulateStream(load.wasm, seed, durationSec));
    const frames = sampleEngineFrames(game).map((f) => ({
      t: f.t,
      ball: f.ball,
      players: f.players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    }));
    out.push({ id: `engine-s${seed}`, dataset: 'engine', frames, meta: {}, roles: null, phase: null });
  }
  return out;
}

// 引擎帧走 framePlayers 的同一路径（无 pitchMeters → 105×68；无 roles/相位）。
// 引擎的相位用 corpus.poss 代理（引擎自己没有"真实持球权"字段）。
export { corpus };

// ── 统计工具 ────────────────────────────────────────────────────────────

// 最小二乘（含截距）。X 是 n×k 的数组（不含截距列）。返回 {b, r2, n, se, t}。
export function ols(y, X) {
  const n = y.length;
  if (!n || !X.length || X[0].length !== n) throw new Error('ols: 维度不匹配');
  const k = X.length + 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  const rows = [new Array(n).fill(1), ...X];
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      let s = 0;
      for (let m = 0; m < n; m += 1) s += rows[i][m] * rows[j][m];
      A[i][j] = s;
    }
    let s = 0;
    for (let m = 0; m < n; m += 1) s += rows[i][m] * y[m];
    b[i] = s;
  }
  const sol = solve(A, b);
  if (!sol) return null;
  const yh = new Array(n).fill(0);
  for (let m = 0; m < n; m += 1) { let s = 0; for (let i = 0; i < k; i += 1) s += sol[i] * rows[i][m]; yh[m] = s; }
  const my = mean(y);
  let ssr = 0; let sst = 0;
  for (let m = 0; m < n; m += 1) { ssr += (y[m] - yh[m]) ** 2; sst += (y[m] - my) ** 2; }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  const se = new Array(k).fill(null);
  const t = new Array(k).fill(null);
  const df = n - k;
  if (df > 0) {
    const s2 = ssr / df;
    const inv = inverse(A);
    if (inv) {
      for (let i = 0; i < k; i += 1) {
        se[i] = Math.sqrt(Math.max(0, s2 * inv[i][i]));
        t[i] = se[i] > 0 ? sol[i] / se[i] : null;
      }
    }
  }
  return { b: sol, r2, n, se, t, ssr };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let j = c; j <= n; j += 1) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

function inverse(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j += 1) M[c][j] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j += 1) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => r.slice(n));
}

// 单变量回归（速度用）：返回 {slope, intercept, r2, n}
export function uni(y, x) {
  const r = ols(y, [x]);
  return r ? { slope: r.b[1], intercept: r.b[0], r2: r.r2, n: r.n, se: r.se[1], t: r.t[1] } : null;
}

export function corr(x, y) {
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < x.length; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export const variance = (a) => { const m = mean(a); return mean(a.map((v) => (v - m) ** 2)); };

export function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const i = Math.floor(h);
  if (i + 1 >= n) return sorted[n - 1];
  return sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
}

export function skewKurt(a) {
  const m = mean(a); const s = Math.sqrt(variance(a));
  if (!(s > 0)) return { skew: 0, kurt: 0 };
  const sk = mean(a.map((v) => ((v - m) / s) ** 3));
  const ku = mean(a.map((v) => ((v - m) / s) ** 4));
  return { skew: sk, kurt: ku };
}

// ── 输出 ────────────────────────────────────────────────────────────────

export function fmt(v, d = 2) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
}

export function pad(s, w) { return String(s).padStart(w); }

export function table(headers, rows, widths = null) {
  const w = widths || headers.map((h, i) => Math.max(String(h).length,
    ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padStart(w[i])).join('  ');
  return [line(headers), w.map((x) => '─'.repeat(x)).join('  '), ...rows.map(line)].join('\n');
}

// 简单确定性 RNG（无依赖）。用于任何下采样/排序打散——保证可复现。
export function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
