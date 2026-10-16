// 视觉审阅：**「像不像足球」面板 v1**——把双盲判别测试里裁判实际用到的量化判据，
// 落成真实侧与引擎侧**同一段代码**跑出来的逐条读数。
//
// ── 口径来源（本文件不发明判据，逐条照抄）────────────────────────────────────
//   `.scratch/notes/p-looks-like-football-2026-10-16/PANEL-v1-FROZEN.md`（定稿口径）
//   `.scratch/notes/p-looks-like-football-2026-10-16/PANEL-CALIBER.md`（逐条精确定义与出处）
//   `.scratch/notes/p-looks-like-football-2026-10-16/REAL-CORPUS.md`（真实语料现状）
// 阈值在 FROZEN 里标【暂定】，本工具跑出两侧分布后用 §"阈值重算规则" 重标。
//
// ── 11 条口径规则（FROZEN §4）逐条落实处 ──────────────────────────────────────
//   R1  横向跨度一律指 **y**（米 = y·球场宽）：`spanY()`；x 方向的量只作 N1 报数。
//   R2  队形类判据一律**剔门将**（id 0/21）：`outfield()`；门将专由 P4 测（`byId()`）。
//   R3  「逐比特冻结」（相邻栏 <0.05 m，`P3A_FREEZE_M`）与「静止占比」（窗内位移
//       <0.5 m，`P3B_STILL_M`）是**两个概念两个名字**：`p3aStepFrozen()` / `scanGame` 的
//       `motion.still`（后者的定义与 `motion-metrics.windowStats` 一致，但按**逐场尺寸**换算）。
//   R4  粒度：逐帧算 → 窗内聚合 → 跨窗均值；**跨场绝不拼接**：`scanGame()` 一次只吃
//       一场的帧，窗只在**场内**切（`coarseWindows` / `fineWindows` 都作用在单场的帧数组上），
//       跨场只对**窗级标量**取均值（`aggregate()`）。
//   R5  P5 主量是连续的 `d_min^cross`，判据式只留两条（<2 m 帧占比 / 8 m 内 ≥5 对）；
//       1.5/3/5 m 不实现。
//   R6  R1 直接用仓内 `gap`（`windowMetrics().primary.gap`），不重定义。
//   R7  P2 **先去重心、双向对称 NN**：`p2Residual()`（不许换单向变体，写法一换结论翻转）。
//   R8  单帧与 12 s 横排分列：**P3a/P2 只在多栏窗（fine）上算**。P1/P4/P5 本应两个尺度都适用，
//       本实现的落点是：P1/P5 的主尺度 = coarse 300 s（任务 §B 的规定），**未出单帧读数**；
//       P4 两个尺度都出了（coarse 的"距门线/窗内位移" + fine 的"较慢门将 12 s 位移"）。
//       ⚠️ 这是一处**已知的口径缺口**，见 `PANEL-CALIBRATION.md` §7(e)，不要当成已覆盖。
//   R9  逐场球场尺寸（104/105/106 不折算）：`pitchMeters` 随帧携带（`fromTrackingFrame`）。
//   R10 跨队配对数写死为「**无序异队对**中距离 <8 m 的个数」：`crossPairsWithin()`。
//   R11 一律**从坐标层算**（不抠渲染像素）：本工具只消费统一帧的 `players/ball`。
//
// ── 双口径（primary / allPoints）─────────────────────────────────────────────
//   `primary`   = 跳过源数据标 `is_detected=false` 的外推点（与 `match-metrics` 同口径）；
//   `allPoints` = 采信外推点（对照）。
//   两侧（真实/引擎）**同一口径**；两个口径**都报**。SkillCorner 的 primary 可用帧率只有
//   8–71%（`REAL-CORPUS.md` §5.2）⇒ 逐帧类判据（P1/P5）的真实侧样本缩水，本工具用
//   `framesValid/framesTotal` 与 `windowsUsable/windowsTotal` **把这件事直接暴露在读数里**。
//
// ── 帧有效性（"两侧同一段代码"的闸门）────────────────────────────────────────
//   沿用 `match-metrics` 口径 7：某队非门将球员 <7 人 ⇒ 该帧丢弃。逐帧量（P1/P5/P4/N1/P6）
//   只在**有效帧**上算；多栏量（P3a/P2）要求 6 栏**全部**是有效帧，否则整窗跳过。跳过的窗数
//   如实计入 `windowsUsable/windowsTotal`，不静默缩小样本。
//
// ── 阈值重算规则（**本任务的核心产出**，见 `PANEL-CALIBRATION.md`）────────────
//   对候选阈值 θ 在网格上算两侧的**窗级命中率** `f(θ)`，再算分离余量
//     `sep(θ) = q10(高侧) − q90(低侧)`（哪一侧整体更高由数据决定，不预设方向）。
//   报三段，**都不合成**：
//     · `tightest`        —— sep 最大那一点（最"锋利"的阈值）；
//     · `nearOptimal`     —— `sep ≥ max − SEP_TOL`(0.10) 的连续 θ 段，取中点为**推荐值**；
//                            连续量上 sep 的峰常是单点（宽 0），故推荐值取带宽的这段，不追尖峰；
//     · `extremeInterval` —— 连 `min/max` 都不相交的 θ 段（回答"最坏一窗还分得开吗"）。
//   **另报 FROZEN 值处**的余量 —— 本面板的用法是"看 FROZEN 那个值还在不在可分区里"，
//   而不是去追 sep 的最大点（引擎侧只有 5 个独立种子，追峰会过拟合到 5 个样本）。
//
// 用法：
//   node tools/visual-review/panel.mjs --dataset all --wasm <engine.wasm> [--lib engine/src/lib.rs]
//   node tools/visual-review/panel.mjs --selftest          # 最小自证（合成数据，不读盘）
//   node tools/visual-review/panel.mjs --help
//
// ⚠️ 本工具是**测量工具**：零引擎改动、不改带、不改基线。两侧读数必须与
//    `engineFingerprint`（lib.rs/wasm sha16）一起引用——不同 wasm 的读数不可比。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));

export const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

// ── 冻结阈值（FROZEN v1 的【暂定】值；**面板读数一律用这一组**，重算只作报告）────
export const FROZEN = {
  P1_T: 44,             // 队形方正度：两队剔门将 y 跨度双双 ≥ T（米）【暂定】
  P3A_FREEZE_M: 0.05,   // 逐比特冻结：相邻栏位移 < 0.05 m（0.01 m 同值，已验证无像素量化）
  P3B_STILL_M: 0.5,     // 静止占比：窗内位移 < 0.5 m（沿用 motion-metrics.still；= 真实位移的 1/27）
  P5_NEAR_M: 2,         // 贴身接触 (a)：异队最近距离 < 2 m
  P5_PAIR_D_M: 8,       // 贴身接触 (b)：跨队 8 m 内配对数 …
  P5_PAIR_K: 5,         //                    … ≥ 5 对
  N1_NEAR_BALL_M: 40,   // N1(i)：离球 40 m 内占比
};

// ── 小样本下限 + 基线指纹（2026-10-16 独立审阅后加；**只告警/标红，不静默剔除**）──────────
// 审阅实测：造一场 3000 帧里只有 3 帧有效的比赛，该窗照样以 n=1 进入统计，分离度表还会判「保留」。
export const MIN_SEP_N = 20;         // 分离度表：任一侧 n < 此值 ⇒ class='insufficient'
export const MIN_VALID_FRAMES = 30;  // 逐帧类判据：窗内有效帧 < 此值 ⇒ 计入告警行（不剔除）
// ⚠️ 陈旧 wasm 能静默改数：审阅实测**仓里那份旧 `viewer/engine.wasm`（c8e77188…）**算出来 P1 中位是 **0**，
// 而 main 现构建（b0bc4796…）是 **0.980** —— 同一个工具、只差"用哪份 wasm"就完全不同的读数。
export const BASELINE_WASM_SHA256 = (() => {
  try {
    const b = JSON.parse(readFileSync(join(ROOT, 'viewer/data/benchmark-baseline.json'), 'utf8'));
    return b?.engineFingerprint?.wasmSha256 || null;
  } catch { return null; }
})();

// 两个尺度（FROZEN §4 规则 8）
export const COARSE = { sizeSec: mm.WINDOW_SIZE_SEC, stepSec: mm.WINDOW_STEP_SEC }; // 300 s / 900 s（仓内既有口径）
export const FINE = { windowSec: 12, stepSec: 2.4, columns: 6 };                     // 12 s 横排 / 2.4 s 一栏

// 12 s / 2.4 s ⇒ 下标步长 = 2.4 × keyframeHz = 2.4 × 5 = 12（REAL-CORPUS §5.1）
export const FINE_COL_STEP = Math.round(FINE.stepSec / mm.SAMPLE_INTERVAL_SEC);      // = 12
export const FINE_SPAN = FINE_COL_STEP * (FINE.columns - 1);                         // = 60 帧 = 12 s

const mean = (a) => (a.length ? a.reduce((u, v) => u + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── 分布摘要（分位走仓内 `quantileSorted`，R type-7，与基线同源）──────────────
export function distSummary(values) {
  const v = (values || []).filter(isNum);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => mm.quantileSorted(s, p);
  return {
    n: s.length, mean: mean(s), min: s[0], max: s[s.length - 1],
    q05: q(0.05), q10: q(0.10), median: q(0.5), q90: q(0.90), q95: q(0.95),
  };
}

// ══ 纯函数层 ══════════════════════════════════════════════════════════════════

// 帧上的门将点（id 0 主 / 21 客）。口径 R2：队形类判据剔、P4 专测。
export const KEEPER_IDS = mm.KEEPER_IDS;

// 按 **id** 取球员。⚠️ 必须按 id 而不是数组下标：真实侧 `fromTrackingFrame` 的数组
// 下标 = id，但引擎侧 `sampleEngineFrames` 返回的是**按队分组、客队倒序**的普通数组
// （实测 `[0,1..10,21,20,…,11]`）——按下标取会拿到完全不相干的人（曾把客队门将
// 读成 x≈0.36 的中场，门将位移算出 386 m）。
export function byId(players, id) {
  for (const p of players || []) if (p && p.id === id) return p;
  return null;
}

// **剔门将**的两队非门将点（口径 R2）。返回 { home, away }（原始 player 对象）。
export function outfield(players) {
  const home = []; const away = [];
  for (const p of players || []) {
    if (!p || KEEPER_IDS.includes(p.id)) continue;
    (p.id <= 10 ? home : away).push(p);
  }
  return { home, away };
}

// 口径 R1：横向跨度 = **y** 方向（米 = 归一化 y × 球场宽）。空集合返回 null。
export function spanY(pts, W) {
  if (!pts.length) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const p of pts) { const y = p.y * W; if (y < lo) lo = y; if (y > hi) hi = y; }
  return hi - lo;
}

// 口径 R1（x 方向，仅 N1 报数用；**不进主面板**——R4 教训：x 跨度是门将常量的导出量）
export function spanX(pts, L) {
  if (!pts.length) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const p of pts) { const x = p.x * L; if (x < lo) lo = x; if (x > hi) hi = x; }
  return hi - lo;
}

// 一帧的**外推点过滤**（口径 primary / allPoints）。返回该口径下采信的点。
export function keptPoints(players, includeExtrapolated) {
  const out = [];
  for (const p of players || []) {
    if (!p) continue;
    if (!includeExtrapolated && p.extrapolated === true) continue;
    out.push(p);
  }
  return out;
}

// 该帧在给定口径下是否**有效**（沿用 match-metrics 口径 7：两队各 ≥7 名非门将）。
export function frameValid(players, includeExtrapolated) {
  const { home, away } = outfield(keptPoints(players, includeExtrapolated));
  return home.length >= mm.MIN_OUTFIELD_PLAYERS && away.length >= mm.MIN_OUTFIELD_PLAYERS;
}

// 口径 R10：「**无序异队对**中距离 < d 的个数」——不是"球周人数"、不是"最近邻是异队的占比"。
export function crossPairsWithin(pts, L, W, dMeters = FROZEN.P5_PAIR_D_M) {
  return crossStats(pts, L, W, dMeters).np;
}

// P5 的三个逐帧量一次算完（口径 R10）：`d_min^cross`（米）与「跨队 d 内配对数」。
// **全部采信点**（门将在不在都无所谓，FROZEN §1 P5「集合与剔除」）——但受口径过滤
// （primary 跳过外推点）。少于一队一点时 dmin 为 null。
// 用归一化坐标算再一次性乘球场尺寸是**错的**（x/y 尺度不同），故先换算成米再比（口径 R9）。
export function crossStats(pts, L, W, pairD = FROZEN.P5_PAIR_D_M) {
  let bh = false; let ba = false;
  for (const p of pts) { if (p.id <= 10) bh = true; else ba = true; }
  if (!bh || !ba) return { dmin: null, np: null };
  const d2 = pairD * pairD;
  let best = Infinity; let n = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const ax = a.x * L; const ay = a.y * W;
    const aHome = a.id <= 10;
    for (let j = i + 1; j < pts.length; j += 1) {
      const b = pts[j];
      if (aHome === (b.id <= 10)) continue;
      const dx = ax - b.x * L; const dy = ay - b.y * W;
      const dd = dx * dx + dy * dy;
      if (dd < best) best = dd;
      if (dd < d2) n += 1;
    }
  }
  return { dmin: Number.isFinite(best) ? Math.sqrt(best) : null, np: n };
}

// 逐帧「异队最近距离」`d_min^cross`（米）。保留独立入口供自证/复用。
export function minCrossDistance(pts, L, W) { return crossStats(pts, L, W).dmin; }

// 口径 R3(a)：相邻两栏之间「**逐比特冻结**」的球员数。
// 定义（FROZEN §1 P3a）：把球员按**最近邻匹配**（每个当前点找上一栏里最近的一点），
// 数"位移 < thr"的人数。杆位（门将）也参与——它若钉死就是最先被数出来的那一类。
// 返回 { frozen, moved }, 以及每人的位移（供调试）。
export function p3aStepFrozen(prevPts, curPts, L, W, thrMeters = FROZEN.P3A_FREEZE_M) {
  if (!prevPts.length || !curPts.length) return null;
  let frozen = 0;
  for (const p of curPts) {
    const px = p.x * L; const py = p.y * W;
    let best = Infinity;
    for (const q of prevPts) {
      const dx = px - q.x * L; const dy = py - q.y * W;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (Math.sqrt(best) < thrMeters) frozen += 1;
  }
  return { frozen, total: curPts.length };
}

// 去重心（口径 R7：P2 **必须先去整体平移**）。
export function center(pts, L, W) {
  const xs = pts.map((p) => p.x * L); const ys = pts.map((p) => p.y * W);
  const cx = mean(xs); const cy = mean(ys);
  return xs.map((x, i) => [x - cx, ys[i] - cy]);
}

// 口径 R7：**双向对称 NN 残差**（`judge-clean-2/rigid.py` 的 `resid()` 写法）。
// 单向变体几乎贴上（1.64–4.21 vs 4.33–6.75）——写法一换结论就翻转，故写死在这里。
export function p2Residual(A, B) {
  if (!A.length || !B.length) return null;
  const oneWay = (X, Y) => mean(X.map((a) => {
    let best = Infinity;
    for (const b of Y) { const dx = a[0] - b[0]; const dy = a[1] - b[1]; const d2 = dx * dx + dy * dy; if (d2 < best) best = d2; }
    return Math.sqrt(best);
  }));
  return (oneWay(A, B) + oneWay(B, A)) / 2;
}

// P6：窗内 (ball_y, mean_y) 的最小二乘斜率 + 相关系数。样本 <minN 或球 y 跨度 <minRange 时返回 null
// （斜率在退化的自变量区间上没有意义）。
export function olsSlope(pairs, { minN = 30, minRangeM = 4 } = {}) {
  const v = pairs.filter((p) => isNum(p[0]) && isNum(p[1]));
  if (v.length < minN) return null;
  const xs = v.map((p) => p[0]); const ys = v.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < minRangeM) return null;
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx; const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), n: xs.length, ballYRange: Math.max(...xs) - Math.min(...xs) };
}

// ══ 切窗（一律作用在**单场**的帧数组上——口径 R4 跨场绝不拼接）════════════════

// coarse：仓内既有口径，直接复用 `match-metrics.cutWindows`（300 s / 900 s / 只取完整窗）。
export function coarseWindows(frames) {
  return mm.cutWindows(frames);
}

// fine：12 s 横排（6 栏 × 2.4 s）。**按下标取**（REAL-CORPUS §5.1：2.4 s × 5 Hz = 12 帧整数）。
// 起点下标步长 = 12 帧（2.4 s）；一窗占 [i, i+60]。返回 [{ start, cols:[6 个下标], frames:[6 帧] }]。
export function fineWindows(frames) {
  const out = [];
  const stride = FINE_COL_STEP;
  for (let i = 0; i + FINE_SPAN < frames.length; i += stride) {
    const idx = [];
    for (let c = 0; c < FINE.columns; c += 1) idx.push(i + c * FINE_COL_STEP);
    out.push({ start: i, from: i, to: i + FINE_SPAN, idx, frames: idx.map((k) => frames[k]) });
  }
  return out;
}

// 死球判据（`p-discrimination-2026-10-15/DESIGN-CLEAN.md` §2.2，真实侧专用）：
// 「以窗内**第一个可观测球位**为基准，取窗内各帧到该基准的**最大**距离（米）」。
// 不用净位移（会把"球跑出去又回来"误判成死球）、不用路径长（追踪噪声会累加）。
// 引擎侧不适用（它没有死球状态）——但本工具两侧同码算，引擎侧这个数恒大，不影响读数。
export function ballReach(frames, from, to, L, W) {
  let base = null; let maxD = 0; let seen = false;
  for (let k = from; k <= to && k < frames.length; k += 1) {
    const f = frames[k];
    if (!f || !f.ball || !mm.isRawBallFrame(f)) continue;
    const bx = f.ball[0] * L; const by = f.ball[1] * W;
    if (!base) { base = [bx, by]; seen = true; continue; }
    const d = Math.hypot(bx - base[0], by - base[1]);
    if (d > maxD) maxD = d;
  }
  return seen ? maxD : null;
}

// FROZEN 之外的**诊断口径**（只用于 P3a 的二次读数）：死球窗过滤阈值，取自 DESIGN-CLEAN §2.2。
export const DEAD_BALL_REACH_M = 15;

// ══ 单场扫描 ══════════════════════════════════════════════════════════════════
// 输入一场的帧序列 → 窗级记录。**一次只吃一场**，跨场拼接在结构上不可能发生。
//
// 返回 {
//   coarse: [{ tStart, nValid, nTotal, narrower[], dmin[], np8[], xSpanNarrow[], near40[], ballY[], meanY[], k0, k21 }],
//   fine:   [{ tStart, usable, frozenMax, frozenAny, residLast, residMax, residAllLast, nCols }],
//   framesTotal, framesValid,
//   motion: { disp[], still[] },          // P3b（12 s 窗，沿用 motion-metrics 的定义）
//   fineWindowsTotal, fineWindowsUsable,
// }
export function scanGame(frames, { includeExtrapolated, pitchMeters } = {}) {
  const pitchOf = (f) => pitchMeters || mm.framePitchMeters(f);

  // ── coarse（300 s）──────────────────────────────────────────────────────
  const cw = coarseWindows(frames);
  const bound = cw.map((w) => [w[0].t, w[w.length - 1].t]);
  const coarse = cw.map((w, i) => ({
    idx: i, tStart: w[0].t, tEnd: w[w.length - 1].t,
    nTotal: w.length, nValid: 0,
    narrower: [], dmin: [], np8: [], xSpanNarrow: [], near40: [],
    ballY: [], meanY: [],
    k0: { path: 0, lineDist: [], seen: 0, prevX: null, prevY: null },
    k21: { path: 0, lineDist: [], seen: 0, prevX: null, prevY: null },
  }));
  let framesValid = 0;
  let framesInWindows = 0;

  // 帧 → coarse 窗（按 t 定位，与 cutWindows 的 filter 条件一致）
  const winOf = (t) => {
    for (let i = 0; i < bound.length; i += 1) if (t >= bound[i][0] && t <= bound[i][1]) return i;
    return -1;
  };

  for (const f of frames) {
    const wi = winOf(f.t);
    if (wi < 0) continue;
    framesInWindows += 1;
    const rec = coarse[wi];
    if (!frameValid(f.players, includeExtrapolated)) continue;
    rec.nValid += 1; framesValid += 1;

    const [L, W] = pitchOf(f);
    const kept = keptPoints(f.players, includeExtrapolated);
    const { home, away } = outfield(kept);

    // P1：两队剔门将 y 跨度取**较窄者**（分离力全在较窄那一队，FROZEN §1）
    const sH = spanY(home, W); const sA = spanY(away, W);
    rec.narrower.push(Math.min(sH, sA));

    // P5：异队最近距离 + 跨队 8 m 内配对数（口径 R10；一次算完）
    const cs = crossStats(kept, L, W);
    if (cs.dmin != null) { rec.dmin.push(cs.dmin); rec.np8.push(cs.np); }

    // N1(ii)：两队 x 跨度取较窄者（报数用）
    rec.xSpanNarrow.push(Math.min(spanX(home, L), spanX(away, L)));

    // N1(i) / P6：球相关量一律只用**原始球帧**（match-metrics 的球取帧策略）
    const rawBall = mm.isRawBallFrame(f) && f.ball && isNum(f.ball[0]) && isNum(f.ball[1]);
    if (rawBall) {
      const bx = f.ball[0] * L; const by = f.ball[1] * W;
      let near = 0; let tot = 0;
      for (const p of [...home, ...away]) { tot += 1; if (Math.hypot(p.x * L - bx, p.y * W - by) <= FROZEN.N1_NEAR_BALL_M) near += 1; }
      if (tot) rec.near40.push(near / tot);
      const my = mean([...home, ...away].map((p) => p.y * W));
      rec.ballY.push(by); rec.meanY.push(my);
    }

    // P4：门将（id 0/21）——路径长、距本方门线距离（**按 id 取**，见 `byId` 注释）
    for (const [id, key] of [[0, 'k0'], [21, 'k21']]) {
      const k = byId(f.players, id);
      if (!k || (!includeExtrapolated && k.extrapolated === true)) continue;
      const kx = k.x * L; const ky = k.y * W;
      const acc = rec[key];
      if (acc.prevX !== null) acc.path += Math.hypot(kx - acc.prevX, ky - acc.prevY);
      acc.prevX = kx; acc.prevY = ky; acc.seen += 1;
      acc.lineDist.push(id === 0 ? kx : (L - kx));      // 本方门线：主队 x=0、客队 x=L
    }
  }

  // ── fine（12 s 横排）──────────────────────────────────────────────────────
  const fine = [];
  let fineTotal = 0; let fineUsable = 0;
  for (const w of fineWindows(frames)) {
    fineTotal += 1;
    if (!w.frames.every((f) => f && frameValid(f.players, includeExtrapolated))) continue;
    fineUsable += 1;
    const [L, W] = pitchOf(w.frames[0]);
    const colsKept = w.frames.map((f) => keptPoints(f.players, includeExtrapolated));
    // P3a：相邻栏之间"逐比特冻结"人数（只在多栏窗上算 —— 口径 R8）
    let frozenMax = 0; let frozenSum = 0; let any = 0;
    for (let c = 1; c < colsKept.length; c += 1) {
      const r = p3aStepFrozen(colsKept[c - 1], colsKept[c], L, W);
      if (!r) continue;
      frozenMax = Math.max(frozenMax, r.frozen);
      frozenSum += r.frozen;
      if (r.frozen > 0) any += 1;
    }
    // P2：去重心后的**双向对称 NN** 残差，锚到窗首栏（口径 R7）
    const exCols = colsKept.map((pts) => center(outfield(pts).home.concat(outfield(pts).away), L, W));
    const allCols = colsKept.map((pts) => center(pts, L, W));
    const residVsFirst = (cols) => cols.slice(1).map((c) => p2Residual(c, cols[0]));
    const rEx = residVsFirst(exCols).filter(isNum);
    const rAll = residVsFirst(allCols).filter(isNum);
    // P4 @12 s：门将在**6 栏内**的累计位移（判别证据就是"12 s 内位移 0.0 m"）
    const kpath = (id) => {
      let p = 0; let prev = null;
      for (const f of w.frames) {
        const k = byId(f.players, id);
        if (!k || (!includeExtrapolated && k.extrapolated === true)) { prev = null; continue; }
        const kx = k.x * L; const ky = k.y * W;
        if (prev) p += Math.hypot(kx - prev[0], ky - prev[1]);
        prev = [kx, ky];
      }
      return p;
    };
    fine.push({
      tStart: w.frames[0].t,
      frozenMax, frozenSum, frozenAnySteps: any, nSteps: colsKept.length - 1,
      residExLast: rEx.length ? rEx[rEx.length - 1] : null,
      residExMax: rEx.length ? Math.max(...rEx) : null,
      residAllLast: rAll.length ? rAll[rAll.length - 1] : null,
      ballReach: ballReach(frames, w.from, w.to, L, W),
      k0: kpath(0), k21: kpath(21),
      k0seen: !!byId(w.frames[0].players, 0), k21seen: !!byId(w.frames[0].players, 21),
    });
  }

  // ── P3b：静止占比 + 端点位移/窗（12 s 窗、非重叠，定义沿用 `motion-metrics.still`）──
  // ⚠️ 与 motion-metrics.windowStats 的差别：那边**写死 105×68**（未跟 P37 的逐场尺寸），
  //    且在"该窗首尾两帧"上算。这里按**逐场尺寸**（口径 R9）算同样的量；Metrica（105×68）
  //    上两者应逐位相同——`--selftest` 之外，CALIBRATION 里有一次实测对照。
  const motion = { disp: [], still: [] };
  const step = Math.max(1, Math.round(FINE.windowSec / mm.SAMPLE_INTERVAL_SEC));
  for (let i = 0; i + step < frames.length; i += step) {
    const a = frames[i]; const b = frames[i + step];
    const [L, W] = pitchOf(a);
    const pa = new Map();
    for (const p of keptPoints(a.players, includeExtrapolated)) pa.set(p.id, p);
    const mags = [];
    for (const p of keptPoints(b.players, includeExtrapolated)) {
      if (KEEPER_IDS.includes(p.id)) continue;          // 口径 R2：队形类剔门将
      const q = pa.get(p.id); if (!q) continue;
      mags.push(Math.hypot((p.x - q.x) * L, (p.y - q.y) * W));
    }
    if (!mags.length) continue;
    motion.disp.push(mean(mags));
    motion.still.push(100 * mags.filter((m) => m < FROZEN.P3B_STILL_M).length / mags.length);
  }

  return {
    coarse, fine, motion,
    framesTotal: frames.length, framesInWindows, framesValid,
    fineWindowsTotal: fineTotal, fineWindowsUsable: fineUsable,
  };
}

// ══ 阈值重算（见文件头「阈值重算规则」）═══════════════════════════════════════
// `pull(win, theta)` → 该窗在阈值 θ 下的命中率 ∈ [0,1] 或 null。
// `direction` = 'engineHigh'（引擎侧整体更高，如 P1）| 'realHigh'（真实侧更高，如 P5）。
//
// 报三样东西（**都不合成**）：
//   · `tightest`      —— 率余量最大那一点（sep 的定义见下），最"锋利"的阈值；
//   · `nearOptimal`   —— sep ≥ max − TOL 的连续 θ 段（TOL = `SEP_TOL`），取中点为**推荐阈值**；
//                        单点峰（宽 0）在连续量上是常态，故推荐值要用带宽的这段，不用尖峰；
//   · `extremeInterval` —— 连 min/max 都不相交的 θ 段，回答"最坏一窗还分得开吗"。
// 余量两个口径都报：率空间 `sep`（q10 高侧 − q90 低侧）与阈值空间（区间半宽）。
export const SEP_TOL = 0.10;

export function separatingThreshold(realWins, engWins, grid, pull, direction) {
  const rows = grid.map((theta) => {
    const r = realWins.map((w) => pull(w, theta)).filter(isNum);
    const e = engWins.map((w) => pull(w, theta)).filter(isNum);
    const rs = distSummary(r); const es = distSummary(e);
    if (!rs || !es) return { theta, sep: null, sepExtreme: null, real: null, engine: null };
    const hi = direction === 'engineHigh' ? es : rs;
    const lo = direction === 'engineHigh' ? rs : es;
    // 稳健口径 q10/q90：152 个真实窗时 min/max 是**单个**极值窗，做主要判据噪声太大
    const sep = hi.q10 - lo.q90;
    const sepExtreme = hi.min - lo.max;
    return { theta, sep, sepExtreme, real: rs, engine: es };
  });
  const good = rows.filter((r) => r.sep != null);
  if (!good.length) return { ok: false, reason: 'no data', rows };
  const best = Math.max(...good.map((r) => r.sep));
  const tightest = good.reduce((a, b) => (b.sep > a.sep ? b : a));
  const near = good.filter((r) => r.sep >= best - SEP_TOL);
  const nLo = near[0].theta; const nHi = near[near.length - 1].theta;
  const mid = (nLo + nHi) / 2;
  const at = good.reduce((a, b) => (Math.abs(b.theta - mid) < Math.abs(a.theta - mid) ? b : a));
  const ext = good.filter((r) => r.sepExtreme != null && r.sepExtreme > 0);
  return {
    ok: best > 0,
    bestSep: best,
    tightest: { theta: tightest.theta, sep: tightest.sep, sepExtreme: tightest.sepExtreme },
    nearOptimal: { lo: nLo, hi: nHi, width: nHi - nLo, midpoint: mid },
    thetaStar: mid,
    at: { theta: at.theta, sep: at.sep, sepExtreme: at.sepExtreme, real: at.real, engine: at.engine },
    extremeInterval: ext.length ? { lo: ext[0].theta, hi: ext[ext.length - 1].theta, width: ext[ext.length - 1].theta - ext[0].theta } : null,
  };
}

// 在某一个**指定**阈值上取两侧读数（用于回答"FROZEN 那个值还在不在可分区间里"）。
export function sepAt(realWins, engWins, theta, pull, direction) {
  const r = realWins.map((w) => pull(w, theta)).filter(isNum);
  const e = engWins.map((w) => pull(w, theta)).filter(isNum);
  const rs = distSummary(r); const es = distSummary(e);
  if (!rs || !es) return null;
  const hi = direction === 'engineHigh' ? es : rs;
  const lo = direction === 'engineHigh' ? rs : es;
  return {
    theta, sep: hi.q10 - lo.q90, sepExtreme: hi.min - lo.max, real: rs, engine: es,
  };
}

// ══ 分离度判据（保留 / 降级 / 删 的机器可读版）════════════════════════════════
// 对每条判据取一个**逐窗标量**，看两侧分布：
//   `both`      = q10/q90 都不相交（稳健分离）→ 保留
//   `extreme`   = 只有 min/max 不相交（极端分离，单窗即可能翻转）→ 边缘，降级
//   `overlap`   = min/max 也相交 → 重叠，降级/删
// 方向不预设：两侧都试，取更好的那个（避免我把方向搞反）。
export const DISCRIMINATORS = [
  { key: 'P1', label: 'P1 队形方正度', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => fracOf(w.narrower, (v) => v >= FROZEN.P1_T)) },
  { key: 'P3a', label: 'P3a 逐比特冻结', scale: 'fine', vals: (m) => m.fine.filter((w) => w.nSteps > 0).map((w) => w.frozenSum / w.nSteps) },
  { key: 'P3b', label: 'P3b 静止占比', scale: 'fine', vals: (m) => m.motion.still },
  { key: 'P4a', label: 'P4 门将距门线(主)', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.k0.lineDist.length).map((w) => mean(w.k0.lineDist)) },
  { key: 'P4b', label: 'P4 门将窗内位移(主)', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.k0.seen > 1).map((w) => w.k0.path) },
  { key: 'P5a', label: `P5 <${FROZEN.P5_NEAR_M} m 帧占比`, scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => fracOf(w.dmin, (v) => v < FROZEN.P5_NEAR_M)) },
  { key: 'P5b', label: `P5 ≥${FROZEN.P5_PAIR_K} 对帧占比`, scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => fracOf(w.np8, (v) => v >= FROZEN.P5_PAIR_K)) },
  { key: 'R1', label: 'R1 重心间距 gap', scale: 'coarse', vals: (m) => m.gap },
  { key: 'P2', label: 'P2 队形残差(剔门将)', scale: 'fine', vals: (m) => m.fine.map((w) => w.residExLast) },
  { key: 'P6', label: 'P6 随球横移斜率', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => { const s = olsSlope(w.ballY.map((b, i) => [b, w.meanY[i]])); return s ? s.slope : null; }) },
  { key: 'N1a', label: 'N1 离球 40 m 内占比', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => mean(w.near40)) },
  { key: 'N1b', label: 'N1 较窄队 x 跨度', scale: 'coarse', vals: (m) => m.coarse.filter((w) => w.nValid > 0).map((w) => mean(w.xSpanNarrow)) },
];

export function separationOf(realVals, engVals) {
  const r = distSummary(realVals); const e = distSummary(engVals);
  if (!r || !e) return null;
  const cand = [
    { dir: 'engineHigh', sep: e.q10 - r.q90, sepExt: e.min - r.max, engine: e, real: r },
    { dir: 'realHigh', sep: r.q10 - e.q90, sepExt: r.min - e.max, engine: e, real: r },
  ].sort((a, b) => b.sep - a.sep);
  const best = cand[0];
  const cls = best.sep > 0 ? 'both' : (best.sepExt > 0 ? 'extreme' : 'overlap');
  // ⚠️ 小样本不判「保留」（审阅 P2）：n 太小时"分离"没有统计意义 —— 标 `insufficient`，
  //    与 `classRaw` 并列报出，让人看得见"如果不管样本量会判什么"。
  const nMin = Math.min(r.n, e.n);
  return {
    dir: best.dir, class: nMin < MIN_SEP_N ? 'insufficient' : cls, classRaw: cls,
    realN: r.n, engineN: e.n, nMin,
    sepQ: best.sep, sepExtreme: best.sepExt,
    realQ10: r.q10, realMedian: r.median, realQ90: r.q90,
    engineQ10: e.q10, engineMedian: e.median, engineQ90: e.q90,
    realMin: r.min, realMax: r.max, engineMin: e.min, engineMax: e.max,
    realQ05: r.q05, realQ95: r.q95, engineQ05: e.q05, engineQ95: e.q95,
  };
}

// `caliber` = 'primary' | 'allPoints'：两侧必须同口径（引擎侧无外推点，两侧同为全帧）。
// ⚠️ primary 在 SkillCorner 上只用得到 8.9% 的 fine 窗、42% 的 coarse 帧 ⇒ **同一判据在两口径下
// 都算一遍**，若只有 primary 分离，那条的分离度就是**抽样产物**，不是结构差异。
export function separationTable(datasets, realKeys, caliber = 'primary') {
  const out = {};
  const engM = datasets[caliber === 'primary' ? 'engine::primary' : 'engine::allPoints'];
  for (const d of DISCRIMINATORS) {
    out[d.key] = { label: d.label, scale: d.scale, perReal: {} };
    if (!engM) continue;
    const engVals = d.vals(engM);
    for (const rk of realKeys) {
      const rm = datasets[rk];
      if (!rm) continue;
      out[d.key].perReal[rk] = separationOf(d.vals(rm), engVals);
    }
  }
  return out;
}

// ══ 汇总（跨窗；跨场只并**窗级标量**——口径 R4）═══════════════════════════════
export function aggregate(games) {
  const byDataset = new Map();
  for (const g of games) {
    if (!byDataset.has(g.dataset)) byDataset.set(g.dataset, []);
    byDataset.get(g.dataset).push(g);
  }
  const out = { perDataset: {}, files: games.map((g) => ({ dataset: g.dataset, game: g.game, ...g.counts })) };
  const datasets = [...byDataset.keys()];
  // 合并值：把各数据集的**窗**并成一个池（窗级标量再平均，不是把帧拼起来）
  for (const key of [...datasets, '__merged__']) {
    const gs = key === '__merged__' ? games : byDataset.get(key);
    out.perDataset[key] = { nGames: gs.length, games: gs.map((g) => g.game), windows: mergeWindows(gs) };
  }
  return out;
}

function mergeWindows(gs) {
  const coarse = gs.flatMap((g) => g.coarse);
  const fine = gs.flatMap((g) => g.fine);
  const motion = { disp: gs.flatMap((g) => g.motion.disp), still: gs.flatMap((g) => g.motion.still) };
  return {
    coarse, fine, motion,
    counts: {
      nGames: gs.length,
      framesTotal: gs.reduce((a, g) => a + g.framesTotal, 0),
      framesInWindows: gs.reduce((a, g) => a + g.framesInWindows, 0),
      framesValid: gs.reduce((a, g) => a + g.framesValid, 0),
      coarseWindows: coarse.length,
      coarseWindowsValid: coarse.filter((w) => w.nValid > 0).length,
      fineWindowsTotal: gs.reduce((a, g) => a + g.fineWindowsTotal, 0),
      fineWindowsUsable: gs.reduce((a, g) => a + g.fineWindowsUsable, 0),
    },
  };
}

// 一列窗级值 → 分布摘要。**空窗（nValid=0）跳过**，不静默填 0。
const pullDist = (wins, fn) => distSummary(wins.map(fn).filter(isNum));

// 每窗命中率：逐帧判 → 窗内取**比率**（不是先把窗内量平均再判阈值，FROZEN §1 P1 粒度）。
export function fracOf(values, pred) {
  const v = (values || []).filter(isNum);
  if (!v.length) return null;
  let n = 0;
  for (const x of v) if (pred(x)) n += 1;
  return n / v.length;
}

// 面板全部读数（两侧各自调用；**同一段代码**）。
export function readPanel(merged, caliber) {
  const { coarse, fine, motion, counts } = merged;
  const cw = coarse.filter((w) => w.nValid > 0);
  const fw = fine;
  const R = {};

  // P1 队形方正度（逐帧判联合条件 → 窗内取比率 → 跨窗均值；口径 R8 说单帧与 12 s 都适用，
  // 但本面板的**主尺度**是 coarse——分离力所在的连续量"较窄队 y 跨度"一并报出）
  R.P1 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: `两队剔门将 y 跨度双双 ≥ ${FROZEN.P1_T} m 的帧占比`,
    dist: pullDist(cw, (w) => fracOf(w.narrower, (v) => v >= FROZEN.P1_T)),
    perFrameNarrower: distSummary(cw.flatMap((w) => w.narrower)),   // 分离力全在较窄那一队
    nonzeroWindows: cw.filter((w) => fracOf(w.narrower, (v) => v >= FROZEN.P1_T) > 0).length,
  };
  // 诊断口径（**不是 FROZEN**）：判别证据来自**已过滤死球窗**的刺激集，而面板不滤死球
  // ⇒ 并列报出"只取活球窗（球在 12 s 内离基准 ≥15 m）"的读数，让"多少分离度是过滤带来的"可读。
  const fwLive = fw.filter((w) => !isNum(w.ballReach) || w.ballReach >= DEAD_BALL_REACH_M);
  R.P3a = {
    scale: `fine${FINE.windowSec}s`,
    quantity: `相邻栏(2.4 s)最近邻匹配后位移 < ${FROZEN.P3A_FREEZE_M} m 的球员数`,
    anyFrozenWinFrac: fw.length ? fw.filter((w) => w.frozenMax > 0).length / fw.length : null,
    frozenMaxStep: fw.length ? Math.max(...fw.map((w) => w.frozenMax)) : null,
    frozenPerStep: distSummary(fw.map((w) => (w.nSteps ? w.frozenSum / w.nSteps : null))),
    // 诊断：只取活球窗（引擎侧几乎全部通过，真实侧会掉一批）
    liveWinFrac: fw.length ? fwLive.length / fw.length : null,
    anyFrozenWinFracLive: fwLive.length ? fwLive.filter((w) => w.frozenMax > 0).length / fwLive.length : null,
    frozenMaxStepLive: fwLive.length ? Math.max(...fwLive.map((w) => w.frozenMax)) : null,
    frozenPerStepLive: distSummary(fwLive.map((w) => (w.nSteps ? w.frozenSum / w.nSteps : null))),
  };
  R.P3b = {
    scale: `fine${FINE.windowSec}s`,
    quantity: `窗内位移 < ${FROZEN.P3B_STILL_M} m 的步数占比（still）`,
    still: distSummary(motion.still),
    disp: distSummary(motion.disp),
  };
  // P4 门将：coarse 窗内累计位移（**结构量口径**，任务 §B）+ 距本方门线距离 + 两门将都 0 的窗占比
  R.P4 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: '门将(id 0/21)窗内累计位移 / 距本方门线距离',
    dispHome: pullDist(cw, (w) => (w.k0.seen > 1 ? w.k0.path : null)),
    dispAway: pullDist(cw, (w) => (w.k21.seen > 1 ? w.k21.path : null)),
    dispMin: pullDist(cw, (w) => (w.k0.seen > 1 && w.k21.seen > 1 ? Math.min(w.k0.path, w.k21.path) : null)),
    lineDistHome: pullDist(cw, (w) => (w.k0.lineDist.length ? mean(w.k0.lineDist) : null)),
    lineDistAway: pullDist(cw, (w) => (w.k21.lineDist.length ? mean(w.k21.lineDist) : null)),
    bothZeroFrac: cw.length ? cw.filter((w) => w.k0.seen > 1 && w.k21.seen > 1
      && w.k0.path === 0 && w.k21.path === 0).length / cw.length : null,
    // 12 s 尺度（FROZEN §4 规则 8：P4 单帧与 12 s 横排都适用；判别证据是"12 s 内位移 0.0 m"）
    // 只取**两名门将都在场**的窗：缺一个时它的 path 是 0，取 min 会伪造出"较慢门将没动"。
    fineDisp: distSummary(fw.filter((w) => w.k0seen && w.k21seen).map((w) => Math.min(w.k0, w.k21))),
    fineBothZeroFrac: fw.length ? fw.filter((w) => w.k0seen && w.k21seen && w.k0 === 0 && w.k21 === 0).length / fw.length : null,
  };
  R.P5 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: `异队最近距离 < ${FROZEN.P5_NEAR_M} m 的帧占比 / 跨队 ${FROZEN.P5_PAIR_D_M} m 内 ≥${FROZEN.P5_PAIR_K} 对的帧占比`,
    nearFrac: pullDist(cw, (w) => fracOf(w.dmin, (v) => v < FROZEN.P5_NEAR_M)),
    pairFrac: pullDist(cw, (w) => fracOf(w.np8, (v) => v >= FROZEN.P5_PAIR_K)),
    dminPerFrame: distSummary(cw.flatMap((w) => w.dmin)),
    np8PerFrame: distSummary(cw.flatMap((w) => w.np8)),
  };
  R.R1 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: '两队重心间距 gap（**直接用仓内 match-metrics**，剔门将 / 逐场尺寸）',
    // 由调用方用 windowMetrics 填（见 runReal/runEngine 的 r1 分支）——这里只占位。
    dist: null,
  };
  // 只报数的三条
  R.P2 = {
    scale: `fine${FINE.windowSec}s`,
    quantity: `去重心后双向对称 NN 残差（末栏 vs 首栏，米）`,
    exKeeper: distSummary(fw.map((w) => w.residExLast)),   // 口径 R2：剔门将（主）
    exKeeperMax: distSummary(fw.map((w) => w.residExMax)),
    all22: distSummary(fw.map((w) => w.residAllLast)),     // 对照：rigid.py 用的是全 22 人
  };
  R.P6 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: '全队(剔门将) y 均值 ~ 球 y 的窗内回归斜率',
    slope: distSummary(cw.map((w) => {
      const s = olsSlope(w.ballY.map((b, i) => [b, w.meanY[i]]));
      return s ? s.slope : null;
    })),
    r: distSummary(cw.map((w) => {
      const s = olsSlope(w.ballY.map((b, i) => [b, w.meanY[i]]));
      return s ? s.r : null;
    })),
    ballYRange: distSummary(cw.map((w) => (w.ballY.length > 1 ? Math.max(...w.ballY) - Math.min(...w.ballY) : null))),
    ballYMin: distSummary(cw.flatMap((w) => w.ballY)),
  };
  R.N1 = {
    scale: `coarse${COARSE.sizeSec}s`,
    quantity: `(i) 离球 ${FROZEN.N1_NEAR_BALL_M} m 内占比 (ii) 较窄队 x 跨度`,
    near40: distSummary(cw.map((w) => mean(w.near40))),
    xSpanNarrow: distSummary(cw.map((w) => mean(w.xSpanNarrow))),
  };
  R._counts = counts;
  R._caliber = caliber;
  return R;
}

// ══ 两侧运行器 ════════════════════════════════════════════════════════════════

export function listRealFiles(root = ROOT) {
  const dir = join(root, 'viewer/data');
  const names = readdirSync(dir);
  const metrica = names.filter((n) => /^real-game-\d+\.json$/.test(n)).sort();
  const skill = names.filter((n) => /^skillcorner-.*\.json$/.test(n)).sort();
  return [
    ...metrica.map((n) => ({ path: join(dir, n), dataset: 'metrica', game: basename(n, '.json') })),
    ...skill.map((n) => ({ path: join(dir, n), dataset: 'skillcorner', game: basename(n, '.json') })),
  ];
}

// 真实侧：逐场读 → 逐场扫 → 跨场并**窗级标量**。返回 { primary:[games], allPoints:[games] }。
export function runReal({ onGame } = {}) {
  const out = { primary: [], allPoints: [] };
  for (const f of listRealFiles()) {
    const raw = JSON.parse(readFileSync(f.path, 'utf8'));
    const pm = raw.meta && raw.meta.pitchMeters
      ? [raw.meta.pitchMeters.length, raw.meta.pitchMeters.width] : null;
    const frames = raw.frames.map((fr) => mm.fromTrackingFrame(fr, { pitchMeters: pm || undefined }));
    for (const [key, inc] of [['primary', false], ['allPoints', true]]) {
      const r = scanGame(frames, { includeExtrapolated: inc, pitchMeters: pm || [mm.PITCH_LENGTH_M, mm.PITCH_WIDTH_M] });
      // R1：直接用仓内 gap（口径 R6）—— 与 baseline 同源：cutWindows(300s) → windowMetrics → 跨窗均值
      const gaps = coarseWindows(frames).map((w) => {
        const wm = mm.windowMetrics(w);
        const m = inc ? wm.allPoints : wm.primary;
        return m ? m.gap : null;
      }).filter(isNum);
      out[key].push({ ...f, ...r, gap: gaps });
      if (onGame) onGame(f.game, key);
    }
  }
  return out;
}

// 引擎侧：**调用方必须传现构建的 wasm**（committed 的 `viewer/engine.wasm` 是 demo 构建，
// 见 `committed-engine-wasm-is-demo-build`）。5 种子 × 5400 s，与基线同种子集。
export async function runEngine(wasmPath, { seeds = mm.BENCHMARK_SEEDS, onSeed } = {}) {
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { createGame } = await import(join(ROOT, 'viewer/game.js'));
  const { wasm } = await loadEngineWasm(wasmPath);
  const out = { primary: [], allPoints: [] };
  for (const seed of seeds) {
    const frames = mm.sampleEngineFrames(
      createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)),
    );
    for (const [key, inc] of [['primary', false], ['allPoints', true]]) {
      const r = scanGame(frames, { includeExtrapolated: inc, pitchMeters: [mm.PITCH_LENGTH_M, mm.PITCH_WIDTH_M] });
      const gaps = coarseWindows(frames).map((w) => {
        const wm = mm.windowMetrics(w);
        const m = inc ? wm.allPoints : wm.primary;
        return m ? m.gap : null;
      }).filter(isNum);
      out[key].push({ dataset: 'engine', game: `seed-${seed}`, ...r, gap: gaps });
    }
    if (onSeed) onSeed(seed);
  }
  return out;
}

// 把一批 game 记录（含 gap）转成 `mergeWindows` 形状。
export function toMerged(games) {
  const m = mergeWindows(games);
  m.gap = games.flatMap((g) => g.gap || []);
  return m;
}

// ══ 指纹 ══════════════════════════════════════════════════════════════════════
export function sha16(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16); } catch { return null; }
}
// 完整 sha256：用于**与基线记录的 wasm 指纹比对**（见 `BASELINE_WASM_SHA256`）。
export function sha256(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

// ══ 最小自证（合成数据；`--selftest`）═════════════════════════════════════════
// 只证三件**口径**，不证"引擎像真实"：① 跨场不拼接 ② 剔门将 ③ 逐帧→比率。
// 另有两条结构性守卫：fine 窗按**下标**取（2.4 s = 12 帧）、primary 跳过外推点。
export function selftest() {
  const L = 105; const W = 68;
  const fails = [];
  const ok = (name, cond, extra = '') => { if (!cond) fails.push(`${name} ${extra}`); };

  // 合成帧：home id 0(门将)+1..10，away id 21(门将)+11..20。
  const mk = (t, homeY, awayY, keeperY, extra = {}) => {
    const players = new Array(22).fill(null);
    players[0] = { id: 0, x: 0.02, y: keeperY };
    players[21] = { id: 21, x: 0.98, y: keeperY };
    for (let i = 0; i < 10; i += 1) players[1 + i] = { id: 1 + i, x: 0.2 + i * 0.05, y: homeY };
    for (let i = 0; i < 10; i += 1) players[11 + i] = { id: 11 + i, x: 0.4 + i * 0.05, y: awayY };
    return { t, players, ball: [0.5, 0.5], ballFill: null, ...extra };
  };

  // ① 剔门将（口径 R2 / R1）：门将 y 贴边，非门将 y 挤在中路 ⇒ span 只能由非门将决定。
  {
    const f = mk(0, 0.30 + 0, 0.35, 0.02);
    // 让 home 非门将 y 铺在 [0.30,0.70] → span = 0.4*68 = 27.2；含门将则 = 0.7*68 = 47.6
    for (let i = 0; i < 10; i += 1) f.players[1 + i].y = 0.30 + (0.40 * i) / 9;
    for (let i = 0; i < 10; i += 1) f.players[11 + i].y = 0.35;
    const { home } = outfield(f.players);
    const s = spanY(home, W);
    ok('剔门将', Math.abs(s - 0.4 * W) < 1e-9, `span=${s} 期望 ${0.4 * W}`);
    ok('含门将会更大（反证条）', spanY(f.players.filter(Boolean), W) > s + 10,
      `含门将 span=${spanY(f.players.filter(Boolean), W)}`);
  }

  // ② 逐帧 → 比率（不是窗内均值再判阈值）：2 帧 1 中 ⇒ 0.5，无论中/不中的跨度差多少。
  {
    const T = 44;
    const hit = mk(0, 0, 0, 0.02);   // 铺满 [0,1] → span = 68 ≥ 44
    for (let i = 0; i < 10; i += 1) hit.players[1 + i].y = i / 9;
    for (let i = 0; i < 10; i += 1) hit.players[11 + i].y = i / 9;
    // 不中的那帧刻意做成"跨度 30 m" ⇒ **窗均值 49 ≥ 44**，但逐帧只有 1/2 命中。
    const miss = mk(0.2, 0, 0, 0.02);
    for (let i = 0; i < 10; i += 1) miss.players[1 + i].y = 0.40 + i * 0.049;
    for (let i = 0; i < 10; i += 1) miss.players[11 + i].y = 0.35 + i * 0.049;
    const narr = [hit, miss].map((f) => {
      const { home, away } = outfield(f.players);
      return Math.min(spanY(home, W), spanY(away, W));
    });
    const frac = fracOf(narr, (v) => v >= T);
    ok('逐帧→比率', Math.abs(frac - 0.5) < 1e-12, `frac=${frac}`);
    ok('比率 ≠ 均值再判', mean(narr) >= T,
      `窗均值 ${mean(narr).toFixed(2)} ≥ ${T} 会把该窗判为 1（逐帧口径下是 0.5）`);
  }

  // ③ 跨场绝不拼接（口径 R4）：两场合成，窗必须**各自场内**切，跨场只并窗级标量。
  {
    const g1 = []; const g2 = [];
    for (let i = 0; i < 610; i += 1) g1.push(mk(i * 0.2, 0.3 + 0.001 * i, 0.4, 0.02));
    for (let i = 0; i < 610; i += 1) g2.push(mk(i * 0.2, 0.3, 0.3 + 0.001 * i, 0.02));
    const w1 = coarseWindows(g1); const w2 = coarseWindows(g2);
    const tEnd1 = g1[g1.length - 1].t; const t0of2 = g2[0].t;
    for (const w of w2) {
      // 第二场的时间戳从 0 重新开始 ⇒ 若实现把两场拼起来切窗，会出现"跨缝窗"。
      ok('跨场不拼接', w[0].t >= t0of2 - 1e-9 && w[w.length - 1].t <= tEnd1 + 1e-9);
    }
    const s1 = scanGame(g1, { includeExtrapolated: false, pitchMeters: [L, W] });
    const s2 = scanGame(g2, { includeExtrapolated: false, pitchMeters: [L, W] });
    const a = aggregate([{ ...s1, dataset: 'x', game: 'g1' }, { ...s2, dataset: 'x', game: 'g2' }]);
    const wins = a.perDataset.x.windows.coarse;
    ok('跨场只并窗级标量', wins.length === s1.coarse.length + s2.coarse.length,
      `${wins.length} vs ${s1.coarse.length}+${s2.coarse.length}`);
  }

  // ④ fine 窗按下标取：2.4 s = 12 帧、6 栏 ⇒ 下标 0/12/24/36/48/60。
  {
    const frames = []; for (let i = 0; i < 200; i += 1) frames.push(mk(i * 0.2, 0.3, 0.4, 0.02));
    const fw = fineWindows(frames);
    ok('fine 栏距=12 帧', FINE_COL_STEP === 12, `得到 ${FINE_COL_STEP}`);
    ok('fine 首窗下标', JSON.stringify(fw[0].idx) === JSON.stringify([0, 12, 24, 36, 48, 60]),
      JSON.stringify(fw[0].idx));
    ok('fine 窗步=12 帧', fw[1].idx[0] - fw[0].idx[0] === 12);
    ok('fine 末窗不越界', fw[fw.length - 1].idx[5] < frames.length);
  }

  // ⑤ primary 跳过外推点；allPoints 采信 —— 同一帧两侧必须给出不同读数。
  {
    const f = mk(0, 0.5, 0.5, 0.5);
    for (let i = 0; i < 10; i += 1) f.players[1 + i].y = 0.30 + (0.40 * i) / 9;
    f.players[1].extrapolated = true;                     // 拿掉 home 最下方那个点
    const sPrim = spanY(outfield(keptPoints(f.players, false)).home, W);
    const sAll = spanY(outfield(keptPoints(f.players, true)).home, W);
    ok('primary 跳外推点', sAll > sPrim + 1, `${sPrim} vs ${sAll}`);
    ok('primary 判定有效帧', frameValid(f.players, false));
  }

  // ⑥ P3a：相邻栏之间被"逐比特钉死"的人必须被最近邻匹配抓到。这里钉死 3 个：
  //    两个门将（id 0/21）+ 一名非门将（id 1）—— 正是「不是纯门将现象」的写法。
  {
    const a = mk(0, 0.3, 0.4, 0.02); const b = mk(2.4, 0.3, 0.4, 0.02);
    for (let i = 0; i < 10; i += 1) {
      a.players[1 + i].y = 0.30 + i * 0.02; b.players[1 + i].y = 0.30 + i * 0.02 + 0.05;
      a.players[11 + i].y = 0.60 + i * 0.02; b.players[11 + i].y = 0.60 + i * 0.02 + 0.05;
    }
    b.players[1].y = a.players[1].y;                      // 唯一一个逐比特没动的非门将
    const r = p3aStepFrozen(keptPoints(a.players, false), keptPoints(b.players, false), L, W);
    ok('P3a 冻结计数', r.frozen === 3, `frozen=${r.frozen} total=${r.total}（期望 3 = 2 门将 + 1 非门将）`);
    ok('P3a 阈值是逐比特', r.frozen < r.total, '全体都动却数出全员冻结 ⇒ 阈值失效');
  }

  // ⑦ P2：双向对称（对称残差的定义本身必须对称）。
  {
    const A = [[0, 0], [10, 0], [0, 10]];
    const B = [[0, 0], [10, 0], [0, 10]];
    ok('P2 同集合残差=0', p2Residual(A, B) === 0);
    ok('P2 对称', Math.abs(p2Residual(A, [[0, 0], [10, 0], [0, 20]]) - p2Residual([[0, 0], [10, 0], [0, 20]], A)) < 1e-12);
  }

  return { pass: fails.length === 0, fails };
}

// ══ 报告 ══════════════════════════════════════════════════════════════════════
const f2 = (v, d = 3) => (isNum(v) ? v.toFixed(d) : ' n/a ');
const fPct = (v) => (isNum(v) ? (v * 100).toFixed(1).padStart(5) : '  n/a');

function distLine(label, s, d = 3) {
  if (!s) return `    ${label.padEnd(22)} n/a`;
  return `    ${label.padEnd(22)} n=${String(s.n).padStart(5)}  mean ${f2(s.mean, d)}  med ${f2(s.median, d)}`
    + `  q10 ${f2(s.q10, d)}  q90 ${f2(s.q90, d)}  [${f2(s.min, d)} … ${f2(s.max, d)}]`;
}

export function formatReport({ thresholds, datasets, recalib, fp, baselineWasmSha256 = BASELINE_WASM_SHA256 }) {
  const L = [];
  L.push('═══ 「像不像足球」面板 v1 · 两侧分布 ═══');
  L.push(`引擎指纹：lib.rs ${fp.libSha16 || 'n/a'}  wasm ${fp.wasmSha16 || 'n/a'}  seeds=${fp.seeds}`);
  // ⚠️ 与 committed 基线的 wasm 比对（审阅 P1）：不阻断，但**必须显式告警**——
  //    实测仓里那份旧 wasm 能让 P1 中位从 0.980 变成 0，而面板只会照常打印数字。
  if (baselineWasmSha256 && fp.wasmSha256 && baselineWasmSha256 !== fp.wasmSha256) {
    L.push(`⚠️ **本读数的 wasm 与 committed 基线不一致**：`);
    L.push(`   本读数 ${fp.wasmSha256.slice(0, 16)}…  基线记录 ${baselineWasmSha256.slice(0, 16)}…`);
    L.push(`   ⇒ **不要与基线/其它指纹的读数比较**（同一个工具、只差"用哪份 wasm"就能给出完全不同的数）。`);
  }
  L.push(`口径：coarse=${COARSE.sizeSec}s/${COARSE.stepSec}s（仓内既有）  fine=${FINE.windowSec}s/${FINE.stepSec}s×${FINE.columns}栏`);
  L.push(`阈值（本轮读数用值）：P1 T=${thresholds.P1_T} m  P3a ${thresholds.P3A_FREEZE_M} m  P3b ${thresholds.P3B_STILL_M} m`);
  L.push(`                    P5 <${thresholds.P5_NEAR_M} m / ${thresholds.P5_PAIR_D_M} m·${thresholds.P5_PAIR_K}对`);
  L.push('');
  L.push('样本可用性（**读逐帧类判据前先看这里**——primary 在 SkillCorner 上缩水）：');
  for (const ds of Object.keys(datasets)) {
    const c = datasets[ds].counts;
    // ⚠️ 分母是"**落在 300 s 窗内**的帧"，不是采样总帧数——cutWindows 的 900 s 步长
    //    本身只覆盖 5400/5800 s 里的 1800 s（既有口径，不是缺陷），拿总帧数当分母会误读成"丢了一半"。
    L.push(`  ${ds.padEnd(22)} 场 ${String(c.nGames).padStart(2)}`
      + `  coarse 窗内有效帧 ${String(c.framesValid).padStart(7)}/${String(c.framesInWindows).padStart(7)}`
      + ` (${fPct(c.framesInWindows ? c.framesValid / c.framesInWindows : null)}%)`
      + `  coarse 窗 ${c.coarseWindowsValid}/${c.coarseWindows}`
      + `  fine 窗可用 ${c.fineWindowsUsable}/${c.fineWindowsTotal} (${fPct(c.fineWindowsTotal ? c.fineWindowsUsable / c.fineWindowsTotal : null)}%)`);
    // ⚠️ 有效帧过少的窗（**未剔除，仅告警**）：逐帧类判据在这些窗上噪声极大（审阅 P2）。
    const cwAll = datasets[ds].coarse || [];
    const below = cwAll.filter((w) => (w.nValid || 0) < MIN_VALID_FRAMES).length;
    if (below) L.push(`      ⚠️ 其中 coarse 窗内有效帧 < ${MIN_VALID_FRAMES} 的有 **${below}/${cwAll.length}** 个（逐帧类读数在此噪声极大；未剔除）`);
  }
  return L.join('\n');
}

// ══ CLI ═══════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const a = { dataset: 'all', wasm: null, lib: null, seeds: null, out: null, json: false, recalibrate: true };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--dataset') a.dataset = argv[++i];
    else if (k === '--wasm') a.wasm = argv[++i];
    else if (k === '--lib') a.lib = argv[++i];
    else if (k === '--seeds') a.seeds = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = true;
    else if (k === '--selftest') a.selftest = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

if (IS_ENTRY) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`「像不像足球」面板 v1 —— 真实 22 场 × 引擎（现构建 wasm）两侧同码读数。

用法:
  node tools/visual-review/panel.mjs --dataset all \\
       --wasm <engine.wasm> [--lib <engine/src/lib.rs>] [--out panel.json]
  node tools/visual-review/panel.mjs --selftest        # 最小自证（合成数据，不读盘）

选项:
  --dataset real|engine|all   默认 all（real = Metrica 2 场 + SkillCorner 20 场）
  --wasm <path>               引擎 wasm；engine/all 必填（**必须现构建**，committed 的是 demo 构建）
  --lib <path>                engine/src/lib.rs；只用于记指纹（与 wasm sha16 一起进读数）
  --seeds <N>                 取 BENCHMARK_SEEDS[42,1,7,99,123] 的前 N 个，默认全跑
  --out <path>                落盘 JSON（含逐窗原始量、阈值重算、两张分离度表）
  --selftest                  跑 8 组口径断言后退出

口径（FROZEN v1，逐条落点在文件头注释）:
  coarse = ${COARSE.sizeSec}s/${COARSE.stepSec}s（仓内既有，与基线同源）
  fine   = ${FINE.windowSec}s/${FINE.stepSec}s × ${FINE.columns} 栏（下标步长 ${FINE_COL_STEP} 帧）
  双口径 primary（跳外推点）/ allPoints（采信），两侧同口径、两个都报

阈值（FROZEN v1 定稿值；重算见 --out 的 recalibration 段）:
  P1 T=${FROZEN.P1_T} m   P3a ${FROZEN.P3A_FREEZE_M} m   P3b ${FROZEN.P3B_STILL_M} m
  P5 <${FROZEN.P5_NEAR_M} m / ${FROZEN.P5_PAIR_D_M} m·${FROZEN.P5_PAIR_K} 对
参考: .scratch/notes/p-looks-like-football-2026-10-16/PANEL-CALIBRATION.md`);
    process.exit(0);
  }
  if (args.selftest) {
    const r = selftest();
    if (r.pass) { console.log('✓ panel 自证通过（8 组口径断言）'); }
    else { console.error('✗ panel 自证失败：\n' + r.fails.map((x) => '  - ' + x).join('\n')); process.exit(1); }
    process.exit(0);
  }
  const t0 = Date.now();
  const seeds = args.seeds ? mm.BENCHMARK_SEEDS.slice(0, args.seeds) : mm.BENCHMARK_SEEDS;
  const fp = {
    wasmSha16: args.wasm ? sha16(args.wasm) : null,
    libSha16: args.lib ? sha16(args.lib) : null,
    wasmSha256: args.wasm ? sha256(args.wasm) : null,   // 与基线比对用（见 BASELINE_WASM_SHA256）
    seeds,
  };
  const datasets = {};
  const raw = {};

  if (args.dataset === 'real' || args.dataset === 'all') {
    console.error('[panel] 扫真实侧 22 场…');
    const real = runReal({ onGame: (g, k) => { if (k === 'primary') console.error(`  · ${g}`); } });
    for (const [cal, games] of [['primary', real.primary], ['allPoints', real.allPoints]]) {
      for (const [ds, key] of [['metrica', 'metrica'], ['skillcorner', 'skillcorner'], ['realMerged', '__all__']]) {
        const gs = key === '__all__' ? games : games.filter((g) => g.dataset === ds);
        if (!gs.length) continue;
        datasets[`real:${ds}:${cal}`] = { ...toMerged(gs), counts: mergeWindows(gs).counts };
        raw[`real:${ds}:${cal}`] = gs;
      }
    }
  }
  if (args.dataset === 'engine' || args.dataset === 'all') {
    if (!args.wasm) { console.error('缺少 --wasm <engine.wasm>（引擎侧必须用现构建的 wasm）'); process.exit(2); }
    console.error('[panel] 跑引擎侧…');
    const eng = await runEngine(args.wasm, { seeds, onSeed: (s) => console.error(`  · seed ${s}`) });
    for (const [cal, games] of [['primary', eng.primary], ['allPoints', eng.allPoints]]) {
      datasets[`engine::${cal}`] = { ...toMerged(games), counts: mergeWindows(games).counts };
      raw[`engine::${cal}`] = games;
    }
  }

  // 面板读数
  const readings = {};
  for (const [name, m] of Object.entries(datasets)) {
    const r = readPanel(m, name.endsWith('allPoints') ? 'allPoints' : 'primary');
    r.R1.dist = distSummary(m.gap);
    readings[name] = r;
  }

  // 阈值重算（只在两侧都在时做）
  const recalib = {};
  const engKey = 'engine::primary';
  const gridT = []; for (let T = 20; T <= 60.0001; T += 0.25) gridT.push(Math.round(T * 100) / 100);
  const gridD = []; for (let d = 0.25; d <= 10.0001; d += 0.05) gridD.push(Math.round(d * 100) / 100);
  const gridK = []; for (let k = 1; k <= 15; k += 1) gridK.push(k);
  const PULL = {
    P1_T: [(w, T) => fracOf(w.narrower, (v) => v >= T), 'engineHigh', FROZEN.P1_T],
    P5_d: [(w, d) => fracOf(w.dmin, (v) => v < d), 'realHigh', FROZEN.P5_NEAR_M],
    P5_k: [(w, k) => fracOf(w.np8, (v) => v >= k), 'realHigh', FROZEN.P5_PAIR_K],
  };
  for (const [tag, realKey] of [['metrica', 'real:metrica:primary'], ['skillcorner', 'real:skillcorner:primary'], ['realMerged', 'real:realMerged:primary']]) {
    if (!datasets[realKey] || !datasets[engKey]) continue;
    const rw = datasets[realKey].coarse.filter((w) => w.nValid > 0);
    const ew = datasets[engKey].coarse.filter((w) => w.nValid > 0);
    const grid = { P1_T: gridT, P5_d: gridD, P5_k: gridK };
    recalib[tag] = {};
    for (const [k, [pull, dir, frozenVal]] of Object.entries(PULL)) {
      const r = separatingThreshold(rw, ew, grid[k], pull, dir);
      // FROZEN 那个值还在不在可分区间里？（本任务要回答的头号问题）
      const fa = sepAt(rw, ew, frozenVal, pull, dir);
      r.atFrozen = fa ? { value: frozenVal, ...fa } : null;
      recalib[tag][k] = r;
    }
  }

  // 分离度表（逐条判 保留 / 降级 / 删）——**两个口径各一张**，只有 primary 分离的条目标红
  const sepTable = {
    primary: separationTable(datasets, ['real:metrica:primary', 'real:skillcorner:primary', 'real:realMerged:primary'], 'primary'),
    allPoints: separationTable(datasets, ['real:metrica:allPoints', 'real:skillcorner:allPoints', 'real:realMerged:allPoints'], 'allPoints'),
  };

  // 可读表
  const outLines = [];
  outLines.push(formatReport({ thresholds: FROZEN, datasets, recalib, fp }));
  outLines.push('');
  const order = ['real:metrica:primary', 'real:metrica:allPoints', 'real:skillcorner:primary', 'real:skillcorner:allPoints',
    'real:realMerged:primary', 'real:realMerged:allPoints', 'engine::primary', 'engine::allPoints'];
  for (const name of order) {
    const R = readings[name]; if (!R) continue;
    outLines.push(`── ${name} ──`);
    outLines.push(`  P1   ${R.P1.quantity}`);
    outLines.push(distLine('命中帧占比', R.P1.dist));
    outLines.push(distLine('较窄队 y 跨度(逐帧, m)', R.P1.perFrameNarrower, 2));
    outLines.push(`  P3a  ${R.P3a.quantity}`);
    outLines.push(`    至少一人冻结的窗占比 ${fPct(R.P3a.anyFrozenWinFrac)}%   单步最大冻结人数 ${R.P3a.frozenMaxStep}`);
    outLines.push(`    〔诊断〕只取活球窗(球 12 s 内离基准 ≥${DEAD_BALL_REACH_M} m)：窗占比 ${fPct(R.P3a.anyFrozenWinFracLive)}%`
      + `  最大 ${R.P3a.frozenMaxStepLive}  （活球窗占全部窗 ${fPct(R.P3a.liveWinFrac)}%）`);
    outLines.push(distLine('每步平均冻结人数', R.P3a.frozenPerStep, 3));
    outLines.push(`  P3b  ${R.P3b.quantity}`);
    outLines.push(distLine('静止占比(%)', R.P3b.still, 3));
    outLines.push(distLine('端点位移/窗(m)', R.P3b.disp, 3));
    outLines.push(`  P4   ${R.P4.quantity}`);
    outLines.push(distLine('门将(主)窗内位移(m)', R.P4.dispHome, 3));
    outLines.push(distLine('门将(客)窗内位移(m)', R.P4.dispAway, 3));
    outLines.push(distLine('门将距门线(主, m)', R.P4.lineDistHome, 3));
    outLines.push(distLine('门将距门线(客, m)', R.P4.lineDistAway, 3));
    outLines.push(`    两门将位移都为 0 的窗占比 ${fPct(R.P4.bothZeroFrac)}%（300 s）  ${fPct(R.P4.fineBothZeroFrac)}%（12 s）`);
    outLines.push(distLine('较慢门将 12 s 内位移(m)', R.P4.fineDisp, 3));
    outLines.push(`  P5   ${R.P5.quantity}`);
    outLines.push(distLine('<2 m 帧占比', R.P5.nearFrac, 4));
    outLines.push(distLine('≥5 对帧占比', R.P5.pairFrac, 4));
    outLines.push(distLine('d_min^cross 逐帧(m)', R.P5.dminPerFrame, 3));
    outLines.push(distLine('8 m 内配对数 逐帧', R.P5.np8PerFrame, 3));
    outLines.push('  R1   两队重心间距 gap（仓内口径）');
    outLines.push(distLine('gap(m)', R.R1.dist, 3));
    outLines.push('  P2（只报数）去重心双向对称 NN 残差');
    outLines.push(distLine('剔门将 末栏(m)', R.P2.exKeeper, 3));
    outLines.push(distLine('剔门将 最大(m)', R.P2.exKeeperMax, 3));
    outLines.push(distLine('全 22 人 末栏(m)', R.P2.all22, 3));
    outLines.push('  P6（只报数）随球横移斜率');
    outLines.push(distLine('斜率', R.P6.slope, 4));
    outLines.push(distLine('r', R.P6.r, 3));
    outLines.push(distLine('球 y 覆盖(m)', R.P6.ballYRange, 2));
    outLines.push('  N1（只报数）单侧不对称');
    outLines.push(distLine('离球 40 m 内占比', R.N1.near40, 3));
    outLines.push(distLine('较窄队 x 跨度(m)', R.N1.xSpanNarrow, 3));
    outLines.push('');
  }
  // P3b 要求"必须与位移/真实比同报"（FROZEN §1 P3b）：比值在这里算，两侧同口径。
  const engDisp = readings['engine::primary'] && readings['engine::primary'].P3b.disp;
  if (engDisp) {
    outLines.push('═══ P3b 位移/真实比（0.5 m 阈值 = 真实位移的 1/27，单读静止率会被骗）═══');
    for (const name of ['real:metrica:primary', 'real:skillcorner:primary', 'real:realMerged:primary']) {
      const d = readings[name] && readings[name].P3b.disp;
      if (!d) continue;
      outLines.push(`  ${name.padEnd(24)} 引擎 ${f2(engDisp.median, 3)} / 真实 ${f2(d.median, 3)} m  ⇒  比 ${(engDisp.median / d.median).toFixed(3)}`);
    }
    outLines.push('');
  }
  // 阈值重算表
  outLines.push('═══ 阈值重算（推荐值 = 近优区间中点；余量 = q10(高侧) − q90(低侧)）═══');
  for (const [tag, r] of Object.entries(recalib)) {
    for (const [k, v] of Object.entries(r)) {
      if (!v.ok) { outLines.push(`  ${tag} ${k}: **不可分**（最佳率余量 ≤ 0，两侧重叠）`); continue; }
      outLines.push(`  ${tag} ${k}`);
      outLines.push(`      推荐 θ* = ${v.thetaStar.toFixed(3)}   近优区间 [${v.nearOptimal.lo}, ${v.nearOptimal.hi}] (宽 ${v.nearOptimal.width.toFixed(3)})`
        + `   最锋利 ${v.tightest.theta} (率余量 ${v.tightest.sep.toFixed(4)})`);
      outLines.push(`      极端口径(min/max)不相交区间 ${v.extremeInterval ? `[${v.extremeInterval.lo}, ${v.extremeInterval.hi}] (宽 ${v.extremeInterval.width.toFixed(3)})` : '**无**（min/max 也重叠）'}`);
      const a = v.atFrozen;
      if (!a) { outLines.push('      （FROZEN 值处无可比读数：该阈值下没有窗同时具备两侧值）'); continue; }
      outLines.push(`      FROZEN 值 ${a.value}：率余量 ${f2(a.sep, 4)}  极端余量 ${f2(a.sepExtreme, 4)}`
        + `   真实命中率 q10/q90 ${f2(a.real.q10, 4)}/${f2(a.real.q90, 4)}   引擎 q10/q90 ${f2(a.engine.q10, 4)}/${f2(a.engine.q90, 4)}`);
    }
  }
  // 分离度表（核心产出：逐条判 保留 / 降级 / 删）
  const VERDICT = { both: '保留', extreme: '降级(只报数)', overlap: '删/降级' };
  for (const [cal, table] of Object.entries(sepTable)) {
    outLines.push('');
    outLines.push(`═══ 分离度 · ${cal} 口径（q10/q90 不相交=保留；仅 min/max 不相交=降级；重叠=删）═══`);
    outLines.push('  判据                          方向        等级          率余量   真实 q10/中位/q90        引擎 q10/中位/q90');
    for (const [key, row] of Object.entries(table)) {
      for (const [rk, s] of Object.entries(row.perReal)) {
        if (!s) continue;
        const tag = rk.replace('real:', '').replace(`:${cal}`, '');
        outLines.push(`  ${(row.label + ' [' + tag + ']').padEnd(30)} ${s.dir.padEnd(11)} ${VERDICT[s.class].padEnd(12)} `
          + `${f2(s.sepQ, 3).padStart(7)}   ${f2(s.realQ10, 2).padStart(7)}/${f2(s.realMedian, 2).padStart(7)}/${f2(s.realQ90, 2).padStart(7)}`
          + `   ${f2(s.engineQ10, 2).padStart(7)}/${f2(s.engineMedian, 2).padStart(7)}/${f2(s.engineQ90, 2).padStart(7)}`);
      }
    }
  }
  console.log(outLines.join('\n'));

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({
      generatedBy: 'tools/visual-review/panel.mjs',
      engineFingerprint: fp,
      thresholds: FROZEN,
      coarse: COARSE, fine: FINE,
      counts: Object.fromEntries(Object.entries(datasets).map(([k, v]) => [k, v.counts])),
      readings, recalibration: recalib, separation: sepTable,
    }, null, 2));
    console.error(`[panel] 落盘 ${args.out}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
}
