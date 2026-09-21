// wayfinder #102（续）：**真实射门转化率曲线**——用 StatsBomb 大样本定标。
//
// ── 为什么需要这个探针 ──────────────────────────────────────────────────
// #102（`notes/conversion-adaptive.md`）把"转化率随射门质量自适应"这件事查清了前提
// （转化率确实是常数），但**卡在一个样本量缺口**（§11）：真实侧只有 Metrica 2–3 场、
// ~50 脚射门，导致 §2.3B 那个判断——"真实禁区内 on-target 是否撞 L1 门带（上限 0.56）"
// ——的 CI 宽到跨过边界（[0.553, 0.868]），**既不能证明也不能排除**。
//
// 本探针用 **StatsBomb Open Data**（4000+ 场，带射门坐标 + 结果 + xG + freeze_frame）
// 把这个缺口补上，产出可直接进引擎定标的**转化率曲线**。
//
// ── ⚠ 许可（StatsBomb Public Data User Agreement）────────────────────────
// 非商用、**禁再分发原始数据**、须署名。故：
//   · 本探针**只读** `.scratch/tracking-data/statsbomb/`（gitignored，不入库）
//   · 产出 `out/real-shot-conversion.json` 是**聚合派生量**（分箱计数 + CI），
//     不是逐条数据 —— 可入库
//   · 任何公开引用须署名 StatsBomb
//
// ── 口径（决定结论能否与引擎对接）───────────────────────────────────────
// ⚠ **这是本探针最容易出错的地方**（#102 §2.3B 的教训：用欧氏口径去撞纵深口径的门
// = 口径错配，把一个"不可判定"说成了"直接冲突"）。故**两个口径都报，且显式标注**：
//
//   · **纵深（x-only）= 与引擎同口径**：引擎 `dist_to_goal_m` 只看 x
//     （`(1.0 - x) * PITCH_LENGTH_M`），三桶边界 `BOX_DIST_M=16.5` / `ARC_DIST_M=25.0`。
//     对接引擎**必须用这个**。
//   · **欧氏（到球门中心）**：物理上更接近"射门难度"，但**不是**引擎当前的口径。
//
// 坐标系：StatsBomb 用 **120×80**（球门中心 `(120, 40)`），引擎用 **105×68** 米。
// 纵深换算：`纵深米 = (120 − x) / 120 × 105`。
//
// **on-target 口径**：引擎的 L3 是 `sot = (goals + saved) / shots`
// （`realism.rs:947`，即 **blocked 不算 on-target**）。本探针照抄这个定义。
//
// 用法：node probe-shot-conversion-real.mjs
// 产出：out/real-shot-conversion.txt + out/real-shot-conversion.json

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot(HERE);
const OUT_DIR = join(HERE, 'out');
const EV_DIR = join(REPO, '.scratch', 'tracking-data', 'statsbomb', 'events');
const INDEX_PATH = join(REPO, '.scratch', 'tracking-data', 'statsbomb', 'match-index.json');

// 引擎常量（照抄 `engine/src/lib.rs`，改那边要同步这里）
const SB_L = 120;            // StatsBomb x 轴长度
const SB_W = 80;             // StatsBomb y 轴长度
const PITCH_LENGTH_M = 105;  // 引擎球场长
const PITCH_WIDTH_M = 68;    // 引擎球场宽
const BOX_DIST_M = 16.5;     // 引擎禁区内桶边界（纵深）
const ARC_DIST_M = 25.0;     // 引擎禁区弧桶边界（纵深）
const GOAL_HALF_W_M = 3.66;  // 球门半宽（7.32m 门）

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(EV_DIR)) {
  console.error(`缺少 ${EV_DIR}\n先跑：node tools/fetch-statsbomb-shots.mjs`);
  process.exit(1);
}

// ── 装载：逐场抽射门（只读聚合，不留原始数据）────────────────────────────
//
// StatsBomb 的 shot outcome 取值（实测）：
//   Goal / Saved / Saved to Post / Saved Off Target / Blocked / Off T / Wayward / Post
// 引擎口径：
//   goal     = Goal
//   saved    = Saved*（门将扑到）—— ⚠ `Saved to Post`/`Saved Off Target` 也算 saved
//   off      = Off T / Wayward / Post（打偏/打飞/中柱未进）
//   blocked  = Blocked（**不算 on-target**，与引擎一致）
const classify = (outcome) => {
  if (outcome === 'Goal') return 'goal';
  if (outcome === 'Blocked') return 'blocked';
  if (outcome && outcome.startsWith('Saved')) return 'saved';
  return 'off';
};

const files = readdirSync(EV_DIR).filter((f) => f.endsWith('.json'));
const index = existsSync(INDEX_PATH) ? JSON.parse(readFileSync(INDEX_PATH, 'utf8')) : [];
const compOf = new Map(index.map((m) => [String(m.match_id), m.comp]));

const shots = [];   // 逐射门：{mid, comp, depth_m, euclid_m, x, y, cls, xg, onTarget}
let parseFail = 0;
for (const f of files) {
  const mid = f.replace(/\.json$/, '');
  let ev;
  try { ev = JSON.parse(readFileSync(join(EV_DIR, f), 'utf8')); } catch { parseFail += 1; continue; }
  if (!Array.isArray(ev)) { parseFail += 1; continue; }
  for (const e of ev) {
    if (!e || !e.type || e.type.name !== 'Shot') continue;
    const loc = e.location;
    if (!Array.isArray(loc) || loc.length < 2) continue;
    const [x, y] = loc;
    // 纵深（与引擎同口径）：到所攻门线的距离。StatsBomb 的进攻方向恒为 +x，门线在 x=120。
    const depth_m = ((SB_L - x) / SB_L) * PITCH_LENGTH_M;
    // 欧氏（到球门中心）
    const gy = SB_W / 2;
    const euclid_m = Math.hypot(((SB_L - x) / SB_L) * PITCH_LENGTH_M, ((y - gy) / SB_W) * PITCH_WIDTH_M);
    const s = e.shot || {};
    const outcome = (s.outcome || {}).name || null;
    const cls = classify(outcome);
    shots.push({
      mid, comp: compOf.get(mid) || '?',
      x, y, depth_m, euclid_m, cls,
      onTarget: cls === 'goal' || cls === 'saved',
      xg: typeof s.statsbomb_xg === 'number' ? s.statsbomb_xg : null,
      body: (s.body_part || {}).name || null,
      technique: (s.technique || {}).name || null,
      play: (s.type || {}).name || null,
      hasFF: Array.isArray(s.freeze_frame) && s.freeze_frame.length > 0,
    });
  }
}
const nMatch = new Set(shots.map((r) => r.mid)).size;
say('# #102 续：真实射门转化率曲线（StatsBomb 大样本）\n');
say(`样本：**${files.length} 场**事件文件（解析成功 ${files.length - parseFail}）→ **${nMatch} 场**有射门，`);
say(`**${shots.length.toLocaleString()} 次射门**，覆盖 ${new Set(shots.map((r) => r.comp)).size} 个赛事。`);
say(`⚠ 数据来源 StatsBomb Open Data，许可非商用/禁再分发原始数据；本文件只含**聚合派生量**。\n`);

// ── Wilson CI ───────────────────────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n; const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [c - h, c + h];
}
const f3 = (v, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const pct = (v, d = 1) => (v == null ? '-' : `${(100 * v).toFixed(d)}%`);

// ── 通用：对一组射门算五率 + CI ──────────────────────────────────────────
function statsOf(rows) {
  const n = rows.length;
  const cnt = (c) => rows.filter((r) => r.cls === c).length;
  const g = cnt('goal'); const sv = cnt('saved'); const bl = cnt('blocked'); const off = cnt('off');
  const on = g + sv;
  const [sotLo, sotHi] = wilson(on, n);
  const [gLo, gHi] = wilson(g, n);
  const [convLo, convHi] = wilson(g, on);
  return {
    n, goal: g, saved: sv, blocked: bl, off, onTarget: on,
    goalRate: n ? g / n : null, [Symbol.iterator]: undefined,
    sotRate: n ? on / n : null, sotLo, sotHi,
    goalLo: gLo, goalHi: gHi,
    // 转化率（进球 / 射正）—— #102 §2.3B 关心的那个量
    convOnTarget: on ? g / on : null, convLo, convHi, convW: convHi - convLo,
    xgMean: rows.some((r) => r.xg != null)
      ? rows.reduce((s, r) => s + (r.xg || 0), 0) / rows.filter((r) => r.xg != null).length : null,
  };
}

// ── 1. 与引擎同口径：三桶（纵深）────────────────────────────────────────
say('## 1. 与引擎同口径（纵深）—— 三桶\n');
say('> 引擎 `shot_bucket`：禁区内 ≤16.5m / 禁区弧 ≤25.0m / 远射 >25.0m，全按**纵深**（只看 x）。');
say('> 每桶声明 `goal/saved/off` 三条：禁区内 15/30/55、弧 7/22/71、远射 4/11/85');
say('> （`engine/src/lib.rs:5317-5324` 的 `shot_bucket`；门带在 `realism.rs:658-670`）。\n');

const buckets = [
  { name: '禁区内 ≤16.5m', test: (r) => r.depth_m <= BOX_DIST_M, engine: [0.15, 0.30] },
  { name: '禁区弧 16.5–25m', test: (r) => r.depth_m > BOX_DIST_M && r.depth_m <= ARC_DIST_M, engine: [0.07, 0.22] },
  { name: '远射 >25m', test: (r) => r.depth_m > ARC_DIST_M, engine: [0.04, 0.11] },
];
// ⚠ **判定必须落在"引擎声明的那个量"上**，不是笼统地比 on-target。
// 引擎每桶声明的是 **(goal%, saved%)**，而 L1 门（`realism.rs:659-668`）给这两个比例
// **各自**一个带。故正确判据是：**真实比例是否落在该量的门带内**（用 Wilson CI 判）。
// 第一版拿桶的 on-target 去比 `goal+saved` 的点估计——那是**错的口径**
// （把"和落在带内"当成"两个分量各自落在各自带内"，反之亦然）。已改。
const bandPass = (lo, hi, cil, cih) => (cil >= lo && cih <= hi) ? '✅ 带内'
  : (cih < lo || cil > hi) ? '❌ 带外' : '⚠️ 跨带边';
const bucketStats = {};
// ⚠⚠ **引擎只有三个 outcome：goal / saved / off_target，没有 blocked**
// （`engine/src/lib.rs:3170-3176` 的 ("goal"|"saved"|"off_target")；全库 0 处 blocked）。
// 故引擎的 `off_target` **吸收**了 StatsBomb 分开计的 `Blocked`。
// 第一版把 blocked 与 off 分开比、还写"引擎没有为这两项声明带"——**两处都错**：
//   · 引擎**有** off 带（`realism.rs:661` 禁区内 off ∈ [0.48,0.60]）
//   · 正确的 off 口径 = **off + blocked**
// 现在按引擎口径合并，并**三条带全判**（goal / saved / off）。
const ENGINE_BANDS = {
  '禁区内 ≤16.5m': { goal: [0.10, 0.20], saved: [0.24, 0.36], off: [0.48, 0.60] },
  '禁区弧 16.5–25m': { goal: [0.03, 0.12], saved: [0.14, 0.30], off: [0.61, 0.75] },
  '远射 >25m': { goal: [0.0, 0.08], saved: [0.04, 0.18], off: [0.78, 0.92] },
};
say('| 桶 | n | 量 | 真实 [CI] | 门带 | 判定 |');
say('|---|---|---|---|---|---|');
for (const b of buckets) {
  const rows = shots.filter(b.test);
  const st = statsOf(rows);
  // 引擎口径：off_target = off + blocked
  st.offEngine = st.off + st.blocked;
  st.offEngineRate = st.offEngine / st.n;
  st.offEngineCI = wilson(st.offEngine, st.n);
  bucketStats[b.name] = st;
  const bd = ENGINE_BANDS[b.name];
  for (const [lab, k, band] of [['goal', st.goal, bd.goal], ['saved', st.saved, bd.saved], ['off（含 blocked）', st.offEngine, bd.off]]) {
    const [lo, hi] = wilson(k, st.n);
    say(`| ${lab === 'goal' ? b.name : ''} | ${lab === 'goal' ? st.n.toLocaleString() : ''} | ${lab} | `
      + `${pct(k / st.n)} [${pct(lo)}, ${pct(hi)}] | [${pct(band[0])}, ${pct(band[1])}] | ${bandPass(band[0], band[1], lo, hi)} |`);
  }
}
say('');
say('> **读法**：`✅ 带内` = 真实比例与门带相容；`❌ 带外` = 真实数据落在门带之外');
say('> （门带需重标或引擎需改）；`⚠️ 跨带边` = CI 跨过边界，**样本量不足以判定**。');
say('> ⚠ **`off` 一列是 `off + blocked`**（引擎口径，它没有 blocked）。\n');

// ── 2. ★ 直接回答 #102 §2.3B 的悬案 ─────────────────────────────────────
say('## 2. ★ 判定 #102 §2.3B 的悬案\n');
say('> **问题**（`conversion-adaptive.md` §2.3B）：真实禁区内 on-target 率是否撞 L1 门带的上限？');
say('> L1 门（`realism.rs:659-661`）声明禁区内 `goal ∈ [0.10,0.20]` + `saved ∈ [0.24,0.36]`');
say('> → **on-target 上界 = 0.20 + 0.36 = 0.56**。\n');
{
  const st = bucketStats['禁区内 ≤16.5m'];
  const upper = 0.20 + 0.36;
  const clash = st.sotLo > upper;
  say(`| 量 | 值 |`);
  say(`|---|---|`);
  say(`| 真实禁区内 on-target（**纵深口径**，n=${st.n.toLocaleString()}） | **${f3(st.sotRate)}**，95% CI **[${f3(st.sotLo)}, ${f3(st.sotHi)}]** |`);
  say(`| L1 门允许上界（goal 0.20 + saved 0.36） | **${f3(upper)}** |`);
  say(`| 判定 | ${clash ? '❌ **冲突**：CI 下界 > 上界' : (st.sotHi < upper ? '✅ **不冲突**：CI 上界 < 门的上界' : '⚠️ **仍不可判定**：CI 跨过边界')} |`);
  say('');
  say(`> **#102 §2.3B 的结论更新**：当时用 Metrica 2–3 场得 CI [0.553, 0.868]，`);
  say(`> 跨过 0.56 → 不可判定。现在 **${st.n.toLocaleString()} 次射门**把 CI 压到宽 **${f3(st.convW)}**，`);
  say(`> 与门的上界 ${f3(upper)} 的关系如上一行。`);
  say('');
}
// 顺带：引擎三桶的实际 on-target vs 真实
say('### 2b. 引擎 `(goal, saved, off)` 点估计 vs 真实（描述性，**不是门**）\n');
say('| 桶 | 真实 goal / saved / off* | 引擎声明 | 差（真实 − 引擎下沿） |');
say('|---|---|---|---|');
for (const b of buckets) {
  const st = bucketStats[b.name];
  const bd = ENGINE_BANDS[b.name];
  const gR = st.goal / st.n; const svR = st.saved / st.n; const oR = st.offEngineRate;
  const d = (a, c) => `${a - c >= 0 ? '+' : ''}${pct(a - c)}`;
  say(`| ${b.name} | ${pct(gR)} / ${pct(svR)} / ${pct(oR)} | `
    + `${pct(bd.goal[0])} / ${pct(bd.saved[0])} / ${pct(bd.off[0])} | ${d(gR, bd.goal[0])} / ${d(svR, bd.saved[0])} / ${d(oR, bd.off[0])} |`);
}
say('');
say('> \\* `off` 含 blocked（引擎口径）。引擎声明列取**带的下沿**。');
say('> ⚠ 本表是**描述性对照**（点估计相减），判定请看上面按 Wilson CI 的表。\n');

// ── 3. 完整曲线：按纵深分箱 ─────────────────────────────────────────────
say('## 3. 转化率随距离的完整曲线（纵深，引擎口径）\n');
say('> `conv = 进球 / 射正`（on-target 转化率）——这是 #102 要建模的那个量。\n');
const DEPTH_EDGES = [0, 6, 11, 16.5, 22, 30, 45, 200];
say('| 纵深区间 (m) | n | 射正 | 进球 | **conv = 进球/射正** | 95% CI | 宽 | xG 均值 |');
say('|---|---|---|---|---|---|---|---|');
const curve = [];
for (let i = 0; i < DEPTH_EDGES.length - 1; i += 1) {
  const lo = DEPTH_EDGES[i]; const hi = DEPTH_EDGES[i + 1];
  const rows = shots.filter((r) => r.depth_m >= lo && r.depth_m < hi);
  const st = statsOf(rows);
  if (!st.n) continue;
  curve.push({ lo, hi, ...st });
  say(`| ${lo}–${hi === 200 ? '∞' : hi} | ${st.n.toLocaleString()} | ${st.onTarget} | ${st.goal} | **${f3(st.convOnTarget)}** | `
    + `[${f3(st.convLo)}, ${f3(st.convHi)}] | ${f3(st.convW)} | ${st.xgMean == null ? '-' : f3(st.xgMean)} |`);
}
say('');

// 欧氏对照
say('### 3b. 欧氏口径（对照；**不是**引擎口径）\n');
const EU_EDGES = [0, 6, 11, 14, 16.5, 22, 30, 200];
say('| 欧氏区间 (m) | n | 射正 | 进球 | conv | 95% CI |');
say('|---|---|---|---|---|---|');
for (let i = 0; i < EU_EDGES.length - 1; i += 1) {
  const lo = EU_EDGES[i]; const hi = EU_EDGES[i + 1];
  const rows = shots.filter((r) => r.euclid_m >= lo && r.euclid_m < hi);
  const st = statsOf(rows);
  if (!st.n) continue;
  say(`| ${lo}–${hi === 200 ? '∞' : hi} | ${st.n.toLocaleString()} | ${st.onTarget} | ${st.goal} | **${f3(st.convOnTarget)}** | [${f3(st.convLo)}, ${f3(st.convHi)}] |`);
}
say('');

// ── 4. 两口径为什么不同 ─────────────────────────────────────────────────
say('## 4. ⚠ 两个口径为什么给出不同结论（#102 §2.3B 的根因）\n');
{
  const inBox = shots.filter((r) => r.depth_m <= BOX_DIST_M);
  const boxButWide = inBox.filter((r) => r.euclid_m > BOX_DIST_M);
  const st1 = statsOf(inBox); const st2 = statsOf(boxButWide);
  say(`「纵深在禁区内、但欧氏 >16.5m」的射门 = **${boxButWide.length.toLocaleString()} 次**`);
  say(`（占禁区内射门的 ${pct(boxButWide.length / inBox.length)}）—— 这批是**贴近底线的极小角度射门**：\n`);
  say('| 子集 | n | on-target | conv |');
  say('|---|---|---|---|');
  say(`| 禁区内全部 | ${st1.n.toLocaleString()} | ${pct(st1.sotRate)} | ${f3(st1.convOnTarget)} |`);
  say(`| 其中「欧氏 >16.5m」（小角度） | ${st2.n.toLocaleString()} | ${pct(st2.sotRate)} | ${f3(st2.convOnTarget)} |`);
  say('');
  say('> **这正是 #102 §2.3B 口径错配的来源**：纵深口径的"禁区内"包含一大批**极低质量**的小角度射门，');
  say('> 把 on-target 率**稀释**。→ 引擎若要用"距离"当质量输入，**欧氏比纵深更合适**；');
  say('> 但**对接引擎的现有桶带**（它是纵深分的）必须用纵深口径。**两者不可混用**（#102 的教训）。');
  say('');
}

// ── 4b. ★ 复核引擎 L3 的三条参考带 ─────────────────────────────────────
//
// `realism.rs:944-954` 的 `l3_shot_ratios` 用三条带卡引擎：射正率 [0.28,0.39]、转化
// [0.08,0.14]、禁区内进球占比 [0.72,0.92]，注释写"真实参考带（report.md §五）：
// 射正率 ~33%、转化 ~10%、禁区内进球 ~85%"。
// **那三个"真实值"的来源是那份研究报告，不是大样本实测**——本节用 StatsBomb 复核它们。
say('## 4b. ★ 复核引擎 L3 的三条参考带（`realism.rs:944-954`）\n');
say('> 引擎注释引的是"report.md §五"的三个数（射正 ~33% / 转化 ~10% / 禁区内进球 ~85%）。');
say('> 本节的真实值 = 同一份 StatsBomb 样本按**同一口径**重算（与引擎同口径：纵深分桶 + blocked 不算 on-target）。\n');
const l3Check = (() => {
  const n = shots.length;
  const goals = shots.filter((r) => r.cls === 'goal').length;
  const saved = shots.filter((r) => r.cls === 'saved').length;
  const boxGoals = shots.filter((r) => r.cls === 'goal' && r.depth_m <= BOX_DIST_M).length;
  const sot = (goals + saved) / n;
  const conv = goals / n;
  const inside = boxGoals / Math.max(1, goals);
  const [sotL, sotH] = wilson(goals + saved, n);
  const [convL, convH] = wilson(goals, n);
  const [inL, inH] = wilson(boxGoals, goals);
  say('| 量 | 引擎带（`realism.rs`） | 引擎注释的"真实值" | **本样本实测** | 95% CI | 判定 |');
  say('|---|---|---|---|---|---|');
  const judge = (lo, hi, cil, cih) => (cil >= lo && cih <= hi) ? '✅ 带内'
    : (cih < lo || cil > hi) ? '❌ 带外' : '⚠️ 跨带边';
  say(`| 射正率 sot | [0.28, 0.39] | ~0.33 | **${f3(sot)}** | [${f3(sotL)}, ${f3(sotH)}] | ${judge(0.28, 0.39, sotL, sotH)} |`);
  say(`| 转化率 conv | [0.08, 0.14] | ~0.10 | **${f3(conv)}** | [${f3(convL)}, ${f3(convH)}] | ${judge(0.08, 0.14, convL, convH)} |`);
  say(`| 禁区内进球占比 | [0.72, 0.92] | ~0.85 | **${f3(inside)}** | [${f3(inL)}, ${f3(inH)}] | ${judge(0.72, 0.92, inL, inH)} |`);
  say('');
  say('> **读法**：`✅ 带内` = 引擎的三条带与真实相容（**引擎注释引的那三个数站得住**）；');
  say('> `❌ 带外` = 引擎的带与真实不符，需重标。');
  say(`> 样本 ${n.toLocaleString()} 次射门 / ${goals} 球——CI 已经窄到能判定。\n`);
  return { n, goals, sot, sotCI: [sotL, sotH], conv, convCI: [convL, convH], inside, insideCI: [inL, inH] };
})();

// ── 5. freeze_frame 能不能支撑"防守者距离"维度 ─────────────────────────
say('## 5. 附：freeze_frame 覆盖（能否加"防守者距离"维度）\n');
{
  const withFF = shots.filter((r) => r.hasFF).length;
  say(`有 freeze_frame 的射门：**${withFF.toLocaleString()} / ${shots.length.toLocaleString()}**（${pct(withFF / shots.length)}）`);
  say('> freeze_frame = 射门瞬间的全部可见球员位置 → **可以**算"最近防守者距离"这类质量维度。');
  say('> ⚠ 但它是**快照不是 tracking**（只在射门瞬间有），且不同赛事覆盖率不同。\n');
}

// ── 6. 逐赛事稳健性 ─────────────────────────────────────────────────────
say('## 6. 逐赛事稳健性（禁区内 conv，样本 ≥200 的赛事）\n');
{
  const byComp = new Map();
  for (const r of shots.filter((s) => s.depth_m <= BOX_DIST_M)) {
    if (!byComp.has(r.comp)) byComp.set(r.comp, []);
    byComp.get(r.comp).push(r);
  }
  const rows = [...byComp.entries()].map(([c, rs]) => [c, statsOf(rs)]).filter(([, s]) => s.n >= 200);
  rows.sort((a, b) => b[1].n - a[1].n);
  say('| 赛事 | n | conv | 95% CI |');
  say('|---|---|---|---|');
  for (const [c, s] of rows) say(`| ${c} | ${s.n.toLocaleString()} | ${f3(s.convOnTarget)} | [${f3(s.convLo)}, ${f3(s.convHi)}] |`);
  const convs = rows.map(([, s]) => s.convOnTarget);
  if (convs.length > 1) {
    const mu = convs.reduce((a, b) => a + b, 0) / convs.length;
    const sd = Math.sqrt(convs.reduce((a, b) => a + (b - mu) ** 2, 0) / convs.length);
    say(`\n> 跨 ${rows.length} 个赛事：均值 ${f3(mu)}、sd ${f3(sd)}、范围 [${f3(Math.min(...convs))}, ${f3(Math.max(...convs))}]。`);
    say('> 若离散度大，说明"单一转化率常数"跨联赛不成立，应分联赛标定。');
  }
  say('');
}

// ── 落盘（聚合派生量，可入库）──────────────────────────────────────────
const artifact = {
  note: 'StatsBomb Open Data 的**聚合派生量**（分箱计数 + CI），非逐条数据。许可：非商用/禁再分发原始数据/须署名 StatsBomb。',
  generatedBy: 'openspec/changes/p38-formation-realism/notes/probes-main/probe-shot-conversion-real.mjs',
  source: { dataset: 'StatsBomb Open Data', repo: 'hudl/open-data', matches: nMatch, shots: shots.length, comps: new Set(shots.map((r) => r.comp)).size },
  caliber: {
    coordinateSystem: 'StatsBomb 120x80 → 纵深米 = (120-x)/120*105',
    depth: 'x-only（与引擎 dist_to_goal_m 同口径）',
    euclid: '到球门中心（对照，非引擎口径）',
    onTarget: 'goal + saved*（blocked 不算）—— 与 engine/tests/realism.rs:947 一致',
    engineBuckets: { boxDist: BOX_DIST_M, arcDist: ARC_DIST_M },
  },
  buckets: bucketStats,
  l3CrossCheck: l3Check,
  curve: curve.map((c) => ({ depthLo: c.lo, depthHi: c.hi === 200 ? null : c.hi, n: c.n, onTarget: c.onTarget, goal: c.goal, conv: c.convOnTarget, ci: [c.convLo, c.convHi] })),
};
writeFileSync(join(OUT_DIR, 'real-shot-conversion.json'), JSON.stringify(artifact, null, 1));
say(`→ out/real-shot-conversion.json（聚合派生量，可入库）`);

writeFileSync(join(OUT_DIR, 'real-shot-conversion.txt'), lines.join('\n'));
console.log(`→ ${join(OUT_DIR, 'real-shot-conversion.txt')}`);
