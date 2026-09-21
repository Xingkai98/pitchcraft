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
// StatsBomb 的 shot outcome 取值（实测 8 种，全部覆盖）：
//   Goal / Saved / Saved to Post / Saved Off Target / Blocked / Off T / Wayward / Post
//
// ⚠⚠ **`Saved Off Target` 不是 on-target**（StatsBomb Open Data Spec v1.1 / Glossary：
// "saved by the goalkeeper **but was not on target**"）。第一版用 `startsWith('Saved')`
// 把它一锅端进 `saved` —— **错**（本样本 33 脚：禁区 19 / 弧 4 / 远射 10）。
// 官方 on-target = {Goal, Saved, Saved to Post}（`Saved to Post` 也算中柱/on-target）。
//
// 引擎口径（`engine/src/lib.rs:3170-3176` **只有三个 outcome，没有 blocked**）：
//   goal    = Goal
//   saved   = Saved / Saved to Post        ← on-target 的那两种
//   off     = Off T / Wayward / Post / Saved Off Target   ← 打偏/打飞/中柱未进/扑偏
//   blocked = Blocked（StatsBomb 单列，**引擎没有这一态** → 计入 off，见 §4b）
const classify = (outcome) => {
  if (outcome === 'Goal') return 'goal';
  if (outcome === 'Blocked') return 'blocked';
  if (outcome === 'Saved' || outcome === 'Saved to Post') return 'saved';
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
      woodwork: outcome === 'Post' || outcome === 'Saved to Post',
      isHeader: ((s.body_part || {}).name === 'Head'),
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
    goalRate: n ? g / n : null,
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
say('> （`engine/src/lib.rs:4775` 的 `shot_bucket`；门带在 `realism.rs:659-671`）。\n');

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
// ⚠⚠⚠ **第三个口径维度：头球**（第二轮审阅发现，与 E1 同类）
// 引擎的分桶计数 `n_box_*` / `n_arc_*` / `n_far_*` **只在非头球分支递增**
// （`engine/tests/realism.rs:428-439` 的 `if is_header {…} else {…分桶…}`）。
// 即**引擎的桶带看不到头球**。故 §2.2 比桶带时**必须排头球**；
// 而 §4b 的 L3（`realism.rs:947`）用 `shots = regular + header`，**含头球**。
// 第一版一律"含头球"并宣称"与引擎 regular 口径一致"——**错**（regular 就是非头球）。
const bucketStats = {};
const noHeader = (rows) => rows.filter((r) => !r.isHeader);
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
  // ⚠ 引擎桶带 = **非头球**口径（`n_box_*` 只在 else 分支累加）
  const rows = noHeader(shots.filter(b.test));
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
say('> L1 门（`realism.rs:659-661`，禁区内 goal/saved/off 三条）声明 `goal ∈ [0.10,0.20]` + `saved ∈ [0.24,0.36]`');
say('> → **on-target 上界 = 0.20 + 0.36 = 0.56**。\n');
{
  const upper = 0.20 + 0.36;
  const boxAll = shots.filter((r) => r.depth_m <= BOX_DIST_M);
  const box = noHeader(boxAll);   // ⚠ 引擎桶带口径 = 非头球（见 §1 注释）
  // ⚠⚠ **两个 on-target 口径必须分开报**（审阅发现的头条错误）：
  //   · 引擎口径（`realism.rs:947` 的 `sot_r`）= `(goal + saved) / n`，blocked 在分母里
  //   · **#102 的口径**（`conversion-adaptive.md` §2.2 的 † 脚注）
  //     = `(goal + saved + woodwork) / (n − blocked)`，**封堵不进分母**
  // 第一版只报引擎口径、却把它当成在判定 #102 的悬案 —— **换了被测量的定义**。
  // 同一份数据在两个口径下给出**相反**的判定（引擎口径 0.42 远低于 0.56；
  // #102 口径 0.563 **跨过** 0.56）。故两个都报。
  const n = box.length;
  const g = box.filter((r) => r.cls === 'goal').length;
  const sv = box.filter((r) => r.cls === 'saved').length;
  const bl = box.filter((r) => r.cls === 'blocked').length;
  const wood = box.filter((r) => r.woodwork).length;
  const eSot = (g + sv) / n;                 // 引擎口径
  const eCI = wilson(g + sv, n);
  const cSot = (g + sv + wood) / (n - bl);   // #102 † 口径
  const cCI = wilson(g + sv + wood, n - bl);
  const verdict = (lo, hi) => (hi < upper ? '✅ **不冲突**（CI 上界 < 上界）'
    : (lo > upper ? '❌ **冲突**（CI 下界 > 上界）' : '⚠️ **仍不可判定**（CI 跨过边界）'));
  say('| on-target 口径 | 公式 | 值 | 95% CI | 判定 vs 0.56 |');
  say('|---|---|---|---|---|');
  say(`| **引擎口径**（\`realism.rs:947\`） | (goal+saved)/n | **${f3(eSot)}** | [${f3(eCI[0])}, ${f3(eCI[1])}] | ${verdict(eCI[0], eCI[1])} |`);
  say(`| **#102 口径**（\`conversion-adaptive.md\` §2.2 †） | (goal+saved+wood)/(n−blocked) | **${f3(cSot)}** | [${f3(cCI[0])}, ${f3(cCI[1])}] | ${verdict(cCI[0], cCI[1])} |`);
  // 含头球（不对接引擎桶带，但 #102 的原报告也没说排头球）
  const bn = boxAll.length;
  const bg = boxAll.filter((r) => r.cls === 'goal').length;
  const bsv = boxAll.filter((r) => r.cls === 'saved').length;
  const bbl = boxAll.filter((r) => r.cls === 'blocked').length;
  const bwd = boxAll.filter((r) => r.woodwork).length;
  const cAll = (bg + bsv + bwd) / (bn - bbl);
  const cAllCI = wilson(bg + bsv + bwd, bn - bbl);
  say(`| （对照）#102 口径 + **含头球** | 同上 | ${f3(cAll)} | [${f3(cAllCI[0])}, ${f3(cAllCI[1])}] | ${verdict(cAllCI[0], cAllCI[1])} |`);
  say('');
  say(`> ⚠⚠ **头球口径也会翻判定**（第二轮审阅发现，与 E1 同类）：`);
  say(`> 引擎的分桶计数**只在非头球分支累加**（\`realism.rs:428-439\`），故桶带看不到头球。`);
  say(`> 本表前两行已按引擎口径**排头球**（n=${bn} → ${n}）；含头球时 #102 口径是 ${f3(cAll)}。`);
  say(`> **排头球后，#102 口径从"跨带边"变成"冲突"**（CI 下界 ${f3(cCI[0])} > 0.56）。`);
  say('');
  say(`> ⚠⚠ **头条结论取决于口径，务必连口径一起引**：`);
  say(`> · 按**引擎口径**：${f3(eSot)}，CI 上界 ${f3(eCI[1])} < 0.56 → **不冲突**（引擎桶带标定得住）；`);
  say(`> · 按 **#102 自己的口径**（它是悬案的提出者）：${f3(cSot)}，CI 下界 ${f3(cCI[0])} > 0.56`);
  say(`>   → **冲突**：真实数据落在 L1 门带之外。`);
  say('');
  say(`> **#102 §2.3B 的结论更新**：当时用 Metrica 2–3 场得 CI [0.553, 0.868]（宽 0.315）；`);
  say(`> 现在 **${n.toLocaleString()} 次射门**把 **#102 口径**的 CI 压到宽 **${f3(cCI[1] - cCI[0])}**——`);
  say(`> **变窄了 11.2 倍，但中心值也移动了**（0.741 → ${f3(cSot)}），`);
  say(`> 所以"跨过 0.56"这个状态**没有改变**，只是从"样本不足"变成了"点估计就压在边界上"。`);
  say('');
  const s0 = (g + sv) / n;
  const s1 = (g + sv + wood) / n;
  const s2 = (g + sv + wood) / (n - bl);
  const s1b = (g + sv) / (n - bl);
  say(`> **两个口径的差从哪来**（合计 **+${((s2 - s0) * 100).toFixed(1)}pp**）：`);
  say(`> 按"先加中柱、再缩分母"：中柱进分子 **+${((s1 - s0) * 100).toFixed(1)}pp**、`);
  say(`> **封堵出分母 +${((s2 - s1) * 100).toFixed(1)}pp**（分母 ${n} → ${n - bl}）。`);
  say(`> ⚠ 分解**路径依赖**：换顺序得 +${((s1b - s0) * 100).toFixed(1)}pp / +${((s2 - s1b) * 100).toFixed(1)}pp，`);
  say(`> 两种顺序相差约 ${(Math.abs((s2 - s1) - (s1b - s0)) * 100).toFixed(1)}pp。**报告时应注明顺序。**`);
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
say('> `conv = 进球 / 射正`（on-target 转化率）——这是 #102 要建模的那个量。');
say('> ⚠ **本节的曲线含头球**（它是"给定距离，进球概率多大"的建模参考，');
say('> 不是与引擎桶带对账——那在 §1/§2.2，那里**排头球**）。**两节的口径不同，勿混引。**\n');
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
say('### 3b. 欧氏口径（对照；**不是**引擎口径。同样**含头球**）\n');
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
say('## 4. ⚠ 三个口径维度：新样本下的灵敏度比较\n');
say('> #102 §2.3B 的结论涉及**三个独立的分类选择**。把它们分开算（同一份禁区内射门）：\n');
{
  // ⚠ **全部口径必须一致：一律排头球**（与 §1/§2 同）。
  // 第一版把欧氏行写成含头球（0.436/0.574）而同表 A 行是排头球——**口径混排**，
  // 且使"B 最多动 1.6pp"低估（实为 3.0pp）。第二轮审阅发现，已改。
  const rate = (rows) => {
    const n = rows.length;
    const g = rows.filter((r) => r.cls === 'goal').length;
    const sv = rows.filter((r) => r.cls === 'saved').length;
    const wd = rows.filter((r) => r.woodwork).length;
    const bl = rows.filter((r) => r.cls === 'blocked').length;
    return { n, eng: (g + sv) / n, c102: (g + sv + wd) / (n - bl) };
  };
  const Rdepth = rate(noHeader(shots.filter((r) => r.depth_m <= BOX_DIST_M)));
  const Reuclid = rate(noHeader(shots.filter((r) => r.euclid_m <= BOX_DIST_M)));
  const RinBox = rate(shots.filter((r) => r.depth_m <= BOX_DIST_M));   // 含头球
  const dd = (a, b) => `${(Math.abs(a - b) * 100).toFixed(1)}pp`;
  say('| 维度 | 选项 | 引擎口径 | #102 口径 |');
  say('|---|---|---|---|');
  say(`| **A. on-target 公式**（**排头球**） | 引擎 \`(g+saved)/n\` vs #102 \`(g+saved+wood)/(n−blocked)\` | ${f3(Rdepth.eng)} ✅ | ${f3(Rdepth.c102)} ❌ |`);
  say(`| **C. 头球**（引擎桶带看不到头球） | 排头球 vs 含头球 | ${f3(Rdepth.eng)} vs ${f3(RinBox.eng)} | ${f3(Rdepth.c102)} vs ${f3(RinBox.c102)} |`);
  say(`| **B. 距离口径**（**都排头球**） | 纵深 ≤16.5（n=${Rdepth.n}） vs 欧氏 ≤16.5（n=${Reuclid.n}） | ${f3(Rdepth.eng)} vs ${f3(Reuclid.eng)} | ${f3(Rdepth.c102)} vs ${f3(Reuclid.c102)} |`);
  say('');
  say('**灵敏度**（各维度能移动多少——括号内是"换成另一选项后差值变化"）：');
  say(`- **A（on-target 公式）：${dd(Rdepth.eng, Rdepth.c102)}** ← 最大`);
  say(`- **C（头球）：${dd(Rdepth.eng, RinBox.eng)}**（引擎口径）/${dd(Rdepth.c102, RinBox.c102)}（#102 口径）`);
  say(`- **B（纵深 vs 欧氏）：${dd(Rdepth.eng, Reuclid.eng)}**（引擎口径）/${dd(Rdepth.c102, Reuclid.c102)}（#102 口径）← 最小`);
  say('');
  say('> ⚠⚠ **但这不等于"#102 翻车的错因是 A"**（第二轮审阅指出，我复算确认）：');
  say('> #102 用的是 **n=30** 的 Metrica 样本。做个最简反事实——');
  say('> **把 A 换成引擎口径、n 仍是 30**：');
  say('> p=0.40 → CI [0.246, 0.577]；p=0.50 → CI [0.332, 0.668] —— **两种都仍跨 0.56**。');
  say('> 要 CI 上界 <0.56 需 **n≈44** 以上（p≈0.42 时）。');
  say('> → **#102 的错因是样本量（n=30），不是任何口径选择。**');
  say('> 本表的 A/B/C 应读作**新样本下的灵敏度比较**，不是错因归因。');
  say('> （#102 诊断出"口径错配"这个*现象*是对的，但它把 B 当成了主因。）');
  say('');
}

// ── 4c. B 维度（距离口径）值得单独记：纵深把 18% 的低质量射门算进"禁区"
say('### 4c. 距离口径：纵深把 18% 的极低质量射门算进"禁区"\n');
{
  const boxAll = shots.filter((r) => r.depth_m <= BOX_DIST_M && !r.isHeader);
  const wide = boxAll.filter((r) => r.euclid_m > BOX_DIST_M);
  const st1 = statsOf(boxAll); const st2 = statsOf(wide);
  say(`「纵深在禁区内、但**欧氏** >16.5m」的射门 = **${wide.length.toLocaleString()} 次**`);
  say(`（占禁区内射门的 ${pct(wide.length / boxAll.length)}）—— 这批是**贴近底线的极小角度射门**：\n`);
  say('| 子集 | n | on-target | conv |');
  say('|---|---|---|---|');
  say(`| 禁区内全部（排头球） | ${st1.n.toLocaleString()} | ${pct(st1.sotRate)} | ${f3(st1.convOnTarget)} |`);
  say(`| 其中「欧氏 >16.5m」（小角度） | ${st2.n.toLocaleString()} | ${pct(st2.sotRate)} | ${f3(st2.convOnTarget)} |`);
  say('');
  say('> **对引擎的启示**：若要用"距离"当射门质量的**输入**，**欧氏比纵深更合适**');
  say('> （纵深把约 18% 的极低质量射门算进了"禁区"，稀释质量信号）；');
  say('> 但**对接引擎现有的桶带**（按纵深分）**必须用纵深口径**。两者不可混用。');
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
say('> 本节的真实值 = 同一份 StatsBomb 样本按**同一口径**重算。');
say('> ⚠ **本节含头球是对的**（`realism.rs:939` 的 `shots = regular + header`），');
say('> 与 §1/§2 的桶带口径（**排头球**，`n_box_*` 只在非头球分支累加）**相反**。');
say('> 同一份报告里两处口径不同，是因为引擎这两处统计本身就不同。\n');
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
// 欧氏曲线（与 §3 的纵深曲线同构，供报告自动生成）
const euclidCurve = [];
for (let i = 0; i < EU_EDGES.length - 1; i += 1) {
  const lo = EU_EDGES[i]; const hi = EU_EDGES[i + 1];
  const rows = shots.filter((r) => r.euclid_m >= lo && r.euclid_m < hi);
  const st = statsOf(rows);
  if (st.n) euclidCurve.push({ euclidLo: lo, euclidHi: hi === 200 ? null : hi, n: st.n, onTarget: st.onTarget, goal: st.goal, conv: st.convOnTarget, ci: [st.convLo, st.convHi] });
}
// 逐赛事（禁区内，样本 ≥200），供报告自动生成
const perComp = [];
{
  const byComp = new Map();
  for (const r of noHeader(shots.filter((r) => r.depth_m <= BOX_DIST_M))) {
    if (!byComp.has(r.comp)) byComp.set(r.comp, []);
    byComp.get(r.comp).push(r);
  }
  for (const [comp, rs] of byComp) {
    const st = statsOf(rs);
    if (st.n >= 200) perComp.push({ comp, n: st.n, conv: st.convOnTarget, ci: [st.convLo, st.convHi] });
  }
  perComp.sort((a, b) => b.n - a.n);
}
const pcMean = perComp.reduce((s, c) => s + c.conv, 0) / perComp.length;
const pcSd = Math.sqrt(perComp.reduce((s, c) => s + (c.conv - pcMean) ** 2, 0) / perComp.length);

const artifact = {
  note: 'StatsBomb Open Data 的**聚合派生量**（分箱计数 + CI），非逐条数据。许可：非商用/禁再分发原始数据/须署名 StatsBomb。',
  generatedBy: 'openspec/changes/p38-formation-realism/notes/probes-main/probe-shot-conversion-real.mjs',
  source: { dataset: 'StatsBomb Open Data', repo: 'hudl/open-data', matches: nMatch, shots: shots.length, comps: new Set(shots.map((r) => r.comp)).size },
  caliber: {
    coordinateSystem: 'StatsBomb 120x80 → 纵深米 = (120-x)/120*105',
    depth: 'x-only（与引擎 dist_to_goal_m 同口径）',
    euclid: '到球门中心（对照，非引擎口径）',
    onTarget: '引擎口径 = goal + Saved + Saved to Post；Blocked 计入分母但不计入分子（engine/tests/realism.rs:947 的 sot_r）。⚠ 与 #102 §2.2 的 † 口径（含中柱、且封堵不进分母）不同——见 §2 两口径对照',
    offTargetEngine: '引擎只有 goal/saved/off_target 三态（无 blocked），故 off = StatsBomb 的 off + Blocked',
    engineBuckets: { boxDist: BOX_DIST_M, arcDist: ARC_DIST_M },
  },
  buckets: bucketStats,
  l3CrossCheck: l3Check,
  curve: curve.map((c) => ({ depthLo: c.lo, depthHi: c.hi === 200 ? null : c.hi, n: c.n, onTarget: c.onTarget, goal: c.goal, conv: c.convOnTarget, ci: [c.convLo, c.convHi] })),
  euclidCurve,
  perComp, perCompMean: pcMean, perCompSd: pcSd,
  perCompMin: Math.min(...perComp.map((c) => c.conv)), perCompMax: Math.max(...perComp.map((c) => c.conv)),
};
writeFileSync(join(OUT_DIR, 'real-shot-conversion.json'), JSON.stringify(artifact, null, 1));
say(`→ out/real-shot-conversion.json（聚合派生量，可入库）`);

writeFileSync(join(OUT_DIR, 'real-shot-conversion.txt'), lines.join('\n'));
console.log(`→ ${join(OUT_DIR, 'real-shot-conversion.txt')}`);
