// P38 真实队形规律调研：共用数据装载器。
//
// **口径必须与 P36/P37 比赛标尺一致**——否则本报告的数字不能跟引擎数字对照，
// 而"看起来一样"的两份实现会在细节里分叉（P37 的核心教训）。故本文件**不重写**
// 任何口径，全部从 viewer/match-metrics.js 导入：
//   - 剔除门将（KEEPER_IDS）
//   - 外推点（is_detected=false）默认跳过（P37 D2）
//   - 逐场球场尺寸换算（P37 D4；104/105/106 不折算）
//   - 球相关量只用原始观测球帧（isRawBallFrame）
//   - 控球代理 = 离球最近者所属队（含门将参与判定；**代理**非真实持球权）
//   - 每队非门将 < 7 人 → 该帧丢弃（MIN_OUTFIELD_PLAYERS）
//
// 本文件新增的只是**派生视图**（排序后的 x 数组、相邻次序间距、y 分布），
// 它们建立在上面的口径之上，不改变任何既有定义。
//
// ── 数据来源与生成命令 ──────────────────────────────────────────────────
//
// [Metrica 2 场]（已转换，入库外，viewer/data/ 下）
//   node tools/fetch-tracking-data.mjs
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json --keyframe-hz 5
//   node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json --keyframe-hz 5
//
// [SkillCorner 6 场]（P38 子样本；骨架 + tracking 实体见 00-fetch-subset.mjs）
//   node openspec/changes/p38-formation-realism/notes/probes/00-fetch-subset.mjs
//   node tools/convert-skillcorner-to-frames.mjs --match .scratch/tracking-data/skillcorner/opendata-master/data/matches/<id>/<id>_match.json \
//        --out .scratch/p38-frames/skillcorner-<id>.json --keyframe-hz 5
//   （转换约 1–2 分钟/场；见 01-convert-subset.mjs）
//
// [引擎]（对照用，非本报告主体）
//   (cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
//
// ── 选场 ────────────────────────────────────────────────────────────────
// 6 场覆盖三种球场尺寸（104/105/106）× 8 家俱乐部，理由见 00-fetch-subset.mjs 注释。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = findRepoRoot(HERE);
const {
  KEEPER_IDS, MIN_OUTFIELD_PLAYERS, PITCH_LENGTH_M, PITCH_WIDTH_M,
  fromTrackingFrame, framePitchMeters, isRawBallFrame, possessionProxy,
  quantileSorted,
} = await import(pathToFileURL(join(REPO, 'viewer', 'match-metrics.js')).href);
const DATA_DIR = join(REPO, 'viewer', 'data');
const P38_FRAMES = join(REPO, '.scratch', 'p38-frames');

// SkillCorner 子样本（P38）。**权威清单是 00-fetch-subset.mjs 的 SUBSET**——改场次要
// 三处同改并重跑：00（下载）→ 01（转换）→ 本文件（装载），然后把报告里的样本量一并更新。
//
// `P38_SKILLCORNER_IDS`（逗号分隔）**仅供开发期冒烟**：下载/转换尚未跑完时，
// 用它把样本缩到已就位的那几场，验证探针能跑通。**报告里的数字一律用默认全量**——
// 冒烟跑出的数字不得进报告（样本被静默缩小 = 报告数字与声称的样本量不符）。
export const SKILLCORNER_IDS = process.env.P38_SKILLCORNER_IDS
  ? process.env.P38_SKILLCORNER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];

// Metrica 场次（沿用 P36/P37 的两场）
export const METRICA_IDS = ['1', '2'];

// ── 装载 ────────────────────────────────────────────────────────────────

function loadConverted(path, id) {
  if (!existsSync(path)) throw new Error(`缺少转换产物：${path}\n  生成方式见 corpus.mjs 头部注释`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const pm = raw.meta.pitchMeters
    ? [raw.meta.pitchMeters.length, raw.meta.pitchMeters.width] : null;
  const frames = raw.frames.map((f) => fromTrackingFrame(f, { pitchMeters: pm }));
  return { id, meta: raw.meta, frames };
}

// 一场比赛（统一帧表示 + meta）。kind: 'metrica' | 'skillcorner'
export function loadMatch(kind, id) {
  const path = kind === 'metrica'
    ? join(DATA_DIR, `real-game-${id}.json`)
    : join(P38_FRAMES, `skillcorner-${id}.json`);
  return loadConverted(path, id);
}

// 全部真实比赛（Metrica 2 + SkillCorner 6）。**逐场返回**，调用方按场聚合
// （跨场混池会把"场次内的相关"当成独立样本，n 会被虚增——见报告「样本量」一节）。
export function loadAllReal() {
  const out = [];
  for (const id of METRICA_IDS) out.push({ dataset: 'metrica', ...loadMatch('metrica', id) });
  for (const id of SKILLCORNER_IDS) out.push({ dataset: 'skillcorner', ...loadMatch('skillcorner', id) });
  return out;
}

// ── 派生视图（建立在 match-metrics 口径之上）──────────────────────────────

const isExtrapolated = (p) => p && p.extrapolated === true;

// 某队该帧的**非门将**球员（主口径跳过外推点）。不足 MIN_OUTFIELD_PLAYERS 返回 null。
// 返回的是统一帧的球员对象数组（带 id/x/y），调用方自行取坐标。
export function outfield(frame, team, { includeExtrapolated = false } = {}) {
  const players = (frame && frame.players) || [];
  const isHome = team === 'home';
  const out = players.filter((p) => p && !KEEPER_IDS.includes(p.id)
    && (isHome ? p.id <= 10 : p.id >= 11)
    && (includeExtrapolated || !isExtrapolated(p)));
  return out.length >= MIN_OUTFIELD_PLAYERS ? out : null;
}

// 该队该帧的米制坐标（x 沿球场长轴、y 沿宽轴）。**不做朝向翻转**。
export function teamXY(frame, team, opts) {
  const ps = outfield(frame, team, opts);
  if (!ps) return null;
  const [L, W] = framePitchMeters(frame);
  return { x: ps.map((p) => p.x * L), y: ps.map((p) => p.y * W) };
}

// 该队该帧的 x（米），**统一到「离本方门线的距离」**（升序）——两侧可比的口径。
// 与 /tmp/wf-probe/probe2-order-stats.mjs 的 teamXs 逐位一致：
// 主队 x 即离本方门线距离；客队是 105−x 再反向排序（翻转后仍升序）。
export function ownXs(frame, team, opts) {
  const xy = teamXY(frame, team, opts);
  if (!xy) return null;
  const isHome = team === 'home';
  const [L] = framePitchMeters(frame);
  const xs = isHome ? xy.x : xy.x.map((v) => L - v);
  return xs.sort((a, b) => a - b);
}

// 球位（米）。无球返回 null。**不**判原始/补全帧——调用方决定是否过滤。
export function ballXY(frame) {
  if (!frame || !frame.ball) return null;
  const [L, W] = framePitchMeters(frame);
  return [frame.ball[0] * L, frame.ball[1] * W];
}

// 球在「主队门线 → 客队门线」轴上的米制位置（= 归一化 x × 该场长度）。
export function ballX(frame) {
  const b = ballXY(frame);
  return b ? b[0] : null;
}

// 球**相对某队本方门线**的米制位置。主队 = ball.x；客队 = L − ball.x。
// 「球有多深地进入我这半场」只有在这个坐标里才是同一件事——否则主客两队的
// 分桶含义相反（这是 teamXs 镜像口径在球上的对应物）。
export function ballDepthFor(frame, team) {
  const x = ballX(frame);
  if (x == null) return null;
  const [L] = framePitchMeters(frame);
  return team === 'home' ? x : L - x;
}

// 该队该帧的 y（米）。
export function teamYs(frame, team, opts) {
  const xy = teamXY(frame, team, opts);
  return xy ? xy.y : null;
}

// 控球代理（复用 match-metrics 的实现：离球最近者所属队，含门将参与判定）。
// **代理**，不是真实持球权——本报告所有涉及它的结论都须如此标注。
export function poss(frame, opts) {
  return possessionProxy(frame, opts);
}

export { isRawBallFrame, framePitchMeters, quantileSorted, PITCH_LENGTH_M, PITCH_WIDTH_M, KEEPER_IDS };

// ── 工具 ────────────────────────────────────────────────────────────────

// ── 次序统计量的 n 稳健推广（P38 口径决定，读前必看）────────────────────
//
// **问题**：probe2 的「次序统计量」= 每帧排序后取第 i 个球员的位置。它在**每帧人数恒定**
// 时才是一个固定的估计量。Metrica 与引擎恒 10 名非门将，成立；但 P37 起 SkillCorner
// **默认跳过外推点**，每帧有效人数浮动（实测本子样本：10 人仅约 2.8% 的帧，众数在 6–9），
// 于是 `xs[7]` 在 n=8 的帧上是"最前面那个"、在 n=10 的帧上是"第 8 深"，**不是同一个估计量**。
// 这正是 P37 把 trim1 换成 q10–q90 的同一个病（见 match-metrics.js 文件头）。
//
// **解法**：改用**分位位置**代替次序位置。type-7 分位在 p=(i−1)/(n−1) 处**恰好**取到
// 第 i 个次序统计量（h=(n−1)p=i−1 为整数）。取 p_i=(i−1)/9（i=1..10）：
//   - n=10 时 → 逐位**精确等于** probe2 的 10 个次序统计量（口径零分叉，数字可比）；
//   - n≠10 时 → 仍是同一批分位点上的插值，n 依赖弱（与 q10–q90 同一族估计量）。
// 于是 Metrica/引擎 的既有数字不变，SkillCorner 也能进同一张表。
//
// ⚠ 不要退回 `xs[i]`：那会让 SkillCorner 的"线间距"混入 n 效应（P37 实测该效应
// 占口径差的 45%–61%）。
export const ORDER_QUANTILE_P = Array.from({ length: 10 }, (_, i) => i / 9);

// 10 个「次序位置」（分位口径的次序统计量）。输入**已排序**的 x 数组（米）。
// 返回长度 10 的数组；n<2 时返回 null。
export function orderPositions(sortedXs) {
  if (!sortedXs || sortedXs.length < 2) return null;
  return ORDER_QUANTILE_P.map((p) => quantileSorted(sortedXs, p));
}

// 相邻次序间距（9 个）：orderPositions 的一阶差分。
export function orderGaps(sortedXs) {
  const pos = orderPositions(sortedXs);
  if (!pos) return null;
  return pos.slice(1).map((v, i) => v - pos[i]);
}

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

// R type-7 / NumPy 默认线性插值分位（与 match-metrics.quantileSorted 同一实现，转导出）。
export const q = (sortedAsc, p) => quantileSorted(sortedAsc, p);

// 分位跨度 q_hi − q_lo。与 match-metrics.quantileSpan 同口径（默认 10–90）。
export const span = (sortedAsc, lo = 0.1, hi = 0.9) => {
  if (sortedAsc.length < 2) return null;
  return quantileSorted(sortedAsc, hi) - quantileSorted(sortedAsc, lo);
};

export function fmt(v, d = 1) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
}

// ── 球位置分桶（共用，避免各探针各写一套）──────────────────────────────
//
// **必须夹取**：球的归一化 x 会略微越界——实测 SkillCorner 有 173 帧 ball[0] ∈ (−0.023, 0)
// （球出底线/门后，源坐标如实保留，未移位）。朴素的"逐桶 `lo <= b < hi`，都不中就返回最后一桶"
// 会把**负值全部塞进最后一桶**（实测把该桶球位均值从 97.6m 拉到 85.5m；在样本更小的切片上
// 更夸张，曾把 [90–105) 桶印成 61.9m）。越界值按**最近的边界桶**归属，比丢弃更保守
// （球确实在那一端）；NaN/非有限值则**明确丢弃**（返回 −1），绝不静默落桶。
export function bucketIndex(x01, edges) {
  if (!Number.isFinite(x01)) return -1;
  if (x01 < edges[0]) return 0;
  for (let i = 0; i < edges.length - 1; i += 1) if (x01 < edges[i + 1]) return i;
  return edges.length - 2;
}

// 桶的米制标签（用**该场自己的**长度，不硬编码 105——104/106 的场子标签会错位）。
export function bucketLabel(edges, i, pitchLength) {
  return `[${(edges[i] * pitchLength).toFixed(0)}–${(edges[i + 1] * pitchLength).toFixed(0)})`;
}

// 固定宽度的表行（避免各探针各写一套对齐逻辑）。
export function row(cells, widths = null) {
  return cells.map((c, i) => (widths ? String(c).padStart(widths[i]) : String(c))).join('  ');
}
