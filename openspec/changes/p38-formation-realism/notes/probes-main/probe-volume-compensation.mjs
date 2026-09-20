// P38 体积补偿假说：**第一步**——证明/证伪「引擎用高转化 + 高射正 + 零失败传球补偿低事件量」。
//
// 假说来源：`research/2026-08-23-match-realism-testability/l3-gap-analysis.md` §二「核心结论」。
// ⚠️ 那份报告的差距表测于 **2026-08-23**（p9 刚合入、p13 未合入）。此后引擎改过
//    （p9 射门质量分桶 + p13 失败传球机制），所以本条假说**必须对本 worktree 的干净 main
//    重新实测**，不能引用报告里的旧数字。本探针做的就是这件事。
//
// 口径（两侧必须同口径，否则数字不可比——P36/P37 反复踩过的坑）：
//   - **逐场算再平均**：不是「总数 ÷ 总时长」（场长不齐时两者不等价）。
//   - **按 90 分钟归一**：Metrica 两场的帧跨度是 5800s / 5646s，引擎恒 5400s。
//     速率量不归一化 = 拿 96.7 分钟的比赛去比 90 分钟的（`criteria/README.md` 射门口径第 3 条）。
//   - **普通射门** = 非头球（引擎 `detail!=="header"`；Metrica `Subtype` 含 `HEAD` 子串）。
//   - 真实侧传球成功用**事件表的派生规则**（Metrica 没有 result 字段，见 §口径推导）；
//     引擎侧用**事件流的 result 字段**。两条口径**都报出来**并对齐差值——
//     强行只报一条会让读者以为两侧同源。
//
// 用法：
//   node probe-volume-compensation.mjs                 # 引擎 200 场（L1 口径 401..600）
//   node probe-volume-compensation.mjs --seeds 10      # 引擎 10 场（判据组口径）
//   node probe-volume-compensation.mjs --no-engine     # 只算真实侧
//
// ⚠️ 不硬编码任何 worktree 绝对路径——一律从脚本位置上溯到仓库根。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';
import { ENGINE_DURATION_SEC } from '../../../../../viewer/match-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const OUT = join(HERE, 'out');
const PER_MATCH_SEC = 90 * 60;

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const nSeeds = Number(argOf('--seeds', '200'));
const seedStart = Number(argOf('--seed-start', '401'));   // L1 冻结窗口起点（realism.rs:35）
const noEngine = argv.includes('--no-engine');

// ── Metrica 事件表：最小 CSV 解析（字段带引号、逗号分隔、无内嵌换行）──────────
function parseEventsCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const idx = (name) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`事件表缺 ${name} 列：${head.join('|')}`);
    return i;
  };
  const iT = idx('Type'); const iS = idx('Subtype'); const iTeam = idx('Team'); const iFrom = idx('From'); const iTo = idx('To');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    out.push({
      type: c[iT].replace(/"/g, ''), subtype: c[iS].replace(/"/g, ''),
      team: c[iTeam].replace(/"/g, ''), from: c[iFrom].replace(/"/g, ''), to: c[iTo].replace(/"/g, ''),
    });
  }
  return out;
}

// Metrica **没有** `result` 字段——传球成败必须从**下一条事件**推导。
// 规则（实测校准，见 §口径推导）：一条 PASS 成功 ⟺ 下一条事件仍由**同一队**产生。
// ⚠️ 越界球（`BALL OUT`）的 `Team` 字段是**把球踢出界的那一队**（不是获得球权的一方）——
// 早先版本把 `BALL OUT` 当成"同队"计入成功，虚高了约 2pp（game1 0.941 → 0.924）。
// 故必须显式排除 `BALL OUT`。
// 边界：半场最后一条 PASS 没有下一条事件（或下一条是 `END HALF`）→ 结果**未定义**，
// 从分母剔除并**如实报出剔除条数**（不静默并入成功或失败）。
function classifyRealPasses(rows) {
  let succ = 0; let fail = 0; let undefinedN = 0;
  const failCause = { interceptionOrLoss: 0, ballOut: 0 };
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type !== 'PASS') continue;
    const nxt = rows[i + 1];
    if (!nxt || nxt.type === 'END HALF') { undefinedN += 1; continue; }
    if (nxt.type === 'BALL OUT') { fail += 1; failCause.ballOut += 1; continue; }
    if (nxt.team === rows[i].team) succ += 1;
    else { fail += 1; failCause.interceptionOrLoss += 1; }
  }
  return { succ, fail, undefinedN, failCause };
}

function realSide() {
  const dir = join(ROOT, '.scratch/tracking-data/sample-data/data');
  const games = [];
  for (const g of [1, 2]) {
    const p = join(dir, `Sample_Game_${g}`, `Sample_Game_${g}_RawEventsData.csv`);
    if (!existsSync(p)) throw new Error(`缺 ${p}（.scratch/tracking-data 是 gitignored，需从主仓库拷）`);
    const rows = parseEventsCsv(readFileSync(p).toString('utf8'));
    // 时长取**帧跨度**（与 eval-criteria 的真实侧同口径），不是事件表最后一条的时间
    const fp = join(ROOT, `viewer/data/real-game-${g}.json`);
    const frames = JSON.parse(readFileSync(fp, 'utf8')).frames;
    const span = frames[frames.length - 1].t - frames[0].t;

    const shots = rows.filter((r) => r.type === 'SHOT');
    const reg = shots.filter((r) => !r.subtype.toUpperCase().includes('HEAD'));
    const headers = shots.length - reg.length;
    const isGoal = (r) => r.subtype.includes('GOAL');
    const isSaved = (r) => r.subtype.includes('SAVED');
    const isBlocked = (r) => r.subtype.includes('BLOCKED');
    const goals = reg.filter(isGoal).length;
    const saved = reg.filter(isSaved).length;
    const blocked = reg.filter(isBlocked).length;
    const headerGoals = shots.filter((r) => r.subtype.includes('GOAL')).length - goals;
    const headerSaved = shots.filter((r) => r.subtype.includes('SAVED')).length - saved;
    const passes = classifyRealPasses(rows);
    const setPiece = rows.filter((r) => r.type === 'SET PIECE');
    const cnt = (t, s) => rows.filter((r) => r.type === t && (s == null || r.subtype === s)).length;
    const cards = rows.filter((r) => r.type === 'CARD');
    // 抢断：Metrica 的 CHALLENGE 是防守对抗（有 won/lost），tackle 是其中一个子类
    const ch = rows.filter((r) => r.type === 'CHALLENGE');
    const tackle = ch.filter((r) => r.subtype.startsWith('TACKLE'));
    const tackleWon = tackle.filter((r) => r.subtype.endsWith('-WON') || r.subtype === 'TACKLE-WON');

    games.push({
      game: g, spanSec: +span.toFixed(1),
      shotsRegular: reg.length, shotsHeader: headers,
      goalsRegular: goals, savedRegular: saved, blockedRegular: blocked,
      headerGoals, headerSaved,
      passEvents: rows.filter((r) => r.type === 'PASS').length,
      passSuccess: passes.succ, passFail: passes.fail, passUndefined: passes.undefinedN,
      passFailCause: passes.failCause,
      corners: cnt('SET PIECE', 'CORNER KICK'),
      throwIns: cnt('SET PIECE', 'THROW IN'),
      goalKicks: cnt('PASS', 'GOAL KICK') + cnt('SET PIECE', 'GOAL KICK'),
      freeKicks: cnt('SET PIECE', 'FREE KICK'),
      fouls: cnt('FAULT RECEIVED'),
      yellow: cards.filter((c) => c.subtype === 'YELLOW').length,
      red: cards.filter((c) => c.subtype === 'RED').length,
      challenges: ch.length, tackles: tackle.length, tacklesWon: tackleWon.length,
      // 未在帧里出现的替补导致的下游口径差异，不在本探针范围
    });
  }
  return games;
}

// 每 90 分钟归一（逐场算再平均：本函数返回**逐场速率**，上层再对场取均值）
//
// ⚠️ **两套射门口径都报**（本 campaign 反复出过口径分叉）：
//   - `regular`：只算非头球射门（= 判据组 `shotsReg` / `real-shots.json` 的口径）
//   - `total`  ：含头球射门与头球进球（= L3 报告 §一 与 `realism.rs::l3_shot_ratios` 的口径）
// 两者的比率**不一样**——L3 报告的「射正率 50% / 转化 14.9%」是 total 口径。
function realRates(g) {
  const k = PER_MATCH_SEC / g.spanSec;
  const shotsTotal = g.shotsRegular + g.shotsHeader;
  const goalsTotal = g.goalsRegular + g.headerGoals;
  const savedTotal = g.savedRegular + g.headerSaved;
  return {
    shotsReg: g.shotsRegular * k,
    goals: g.goalsRegular * k,
    shotsTotal: shotsTotal * k,
    goalsTotal: goalsTotal * k,
    onTargetRate: g.shotsRegular ? (g.goalsRegular + g.savedRegular) / g.shotsRegular : NaN,
    conversion: g.shotsRegular ? g.goalsRegular / g.shotsRegular : NaN,
    onTargetRateTotal: shotsTotal ? (goalsTotal + savedTotal) / shotsTotal : NaN,
    conversionTotal: shotsTotal ? goalsTotal / shotsTotal : NaN,
    passTotal: g.passEvents * k,
    passFail: g.passFail * k,
    passSuccessRate: g.passSuccess + g.passFail > 0 ? g.passSuccess / (g.passSuccess + g.passFail) : NaN,
    corners: g.corners * k, throwIns: g.throwIns * k, goalKicks: g.goalKicks * k,
    fouls: g.fouls * k, yellow: g.yellow * k,
    tackles: g.tackles * k, tackleSuccessRate: g.tackles ? g.tacklesWon / g.tackles : NaN,
  };
}

// ── 引擎侧 ────────────────────────────────────────────────────────────────
async function engineSide() {
  const L = await loadEngineWasm(WASM_PATH);
  if (!L.ok) throw new Error(L.message);
  const per = [];
  for (let i = 0; i < nSeeds; i += 1) {
    const seed = seedStart + i;
    const ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC));
    const shots = ev.filter((e) => e.type === 'shot');
    const reg = shots.filter((e) => e.detail !== 'header');
    const hdr = shots.filter((e) => e.detail === 'header');
    const passes = ev.filter((e) => e.type === 'pass');
    // 引擎的口径（与 realism.rs 的 `n_pass_success/intercepted/lost` **逐字一致**）：
    // 失败传球只统计**有向传球**（有 `to` 字段）；无 `to` 的重开（门将开大脚等）不计成败。
    const directed = passes.filter((e) => e.to !== undefined);
    per.push({
      shotsReg: reg.length, goalsReg: reg.filter((e) => e.result === 'goal').length,
      savedReg: reg.filter((e) => e.result === 'saved').length,
      offReg: reg.filter((e) => e.result === 'off_target').length,
      headerTotal: hdr.length, headerGoals: hdr.filter((e) => e.result === 'goal').length,
      headerSaved: hdr.filter((e) => e.result === 'saved').length,
      goalsAll: shots.filter((e) => e.result === 'goal').length,
      boxShots: reg.filter((e) => distToGoalM(e) <= 16.5).length,
      passTotal: passes.length,
      passDirected: directed.length,
      passSuccess: directed.filter((e) => e.result === 'success').length,
      passIntercepted: directed.filter((e) => e.result === 'intercepted').length,
      passLost: directed.filter((e) => e.result === 'lost').length,
      passOut: passes.filter((e) => e.result === 'out').length,
      corners: passes.filter((e) => e.detail === 'corner').length,
      throwIns: passes.filter((e) => e.detail === 'throw_in' || e.detail === 'out_sideline').length,
      goalKicks: passes.filter((e) => e.detail === 'goal_kick').length,
      fouls: ev.filter((e) => e.type === 'foul').length,
      yellow: ev.filter((e) => e.type === 'foul' && e.card === 'yellow').length,
      tackles: ev.filter((e) => e.type === 'tackle').length,
      tacklesWon: ev.filter((e) => e.type === 'tackle' && e.result === 'success').length,
    });
  }
  return per;
}

// 起脚距离（与 realism.rs 同口径：home 攻右 x=1，away 攻左 x=0）
function distToGoalM(e) {
  return (e.subject <= 10 ? 1 - e.x : e.x) * 105;
}

function engineRates(p) {
  return {
    shotsReg: p.shotsReg,
    goals: p.goalsReg,
    shotsTotal: p.shotsReg + p.headerTotal,
    goalsTotal: p.goalsAll,
    onTargetRate: p.shotsReg ? (p.goalsReg + p.savedReg) / p.shotsReg : NaN,
    conversion: p.shotsReg ? p.goalsReg / p.shotsReg : NaN,
    onTargetRateTotal: p.shotsReg + p.headerTotal
      ? (p.goalsAll + p.savedReg + p.headerSaved) / (p.shotsReg + p.headerTotal) : NaN,
    conversionTotal: p.shotsReg + p.headerTotal ? p.goalsAll / (p.shotsReg + p.headerTotal) : NaN,
    boxShare: p.shotsReg ? p.boxShots / p.shotsReg : NaN,
    passTotal: p.passTotal,
    passFail: p.passIntercepted + p.passLost + p.passOut,
    // 引擎的 L1 口径：分母 = **全部** pass 事件（含重开/出界），与 realism.rs 的
    // `l1_pass_completion_rate` 一致。
    passSuccessRate: p.passTotal ? p.passSuccess / p.passTotal : NaN,
    // 有向传球口径：分母只含「有 to 的普通传球」（引擎自己的 `~90.5%` 对照）
    passSuccessRateDirected: p.passDirected ? p.passSuccess / p.passDirected : NaN,
    corners: p.corners, throwIns: p.throwIns, goalKicks: p.goalKicks,
    fouls: p.fouls, yellow: p.yellow,
    tackles: p.tackles, tackleSuccessRate: p.tackles ? p.tacklesWon / p.tackles : NaN,
  };
}

const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const f2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : NaN);
const f3 = (v) => (Number.isFinite(v) ? +v.toFixed(3) : NaN);

const real = realSide();
const realPer = real.map(realRates);
const doc = { caliber: {}, real: [], engine: null, comparison: [] };

console.log('=== 真实（Metrica 2 场）逐场 ===');
for (let i = 0; i < real.length; i += 1) {
  const g = real[i]; const r = realPer[i];
  console.log(`game${g.game}（${g.spanSec}s）：普通射门 ${g.shotsRegular}（头球 ${g.shotsHeader}）进球 ${g.goalsRegular} 射正 ${g.goalsRegular + g.savedRegular} 封堵 ${g.blockedRegular}`
    + ` | pass ${g.passEvents}（成功 ${g.passSuccess} 失败 ${g.passFail} 未定义 ${g.passUndefined}）`);
  console.log(`         → 归一 90min：射门 ${f2(r.shotsReg)}（含头球 ${f2(r.shotsTotal)}）进球 ${f2(r.goals)}`
    + ` [普通口径] 射正率 ${f3(r.onTargetRate)} 转化 ${f3(r.conversion)}`
    + ` [含头球口径] 射正率 ${f3(r.onTargetRateTotal)} 转化 ${f3(r.conversionTotal)}`
    + ` 传球 ${f2(r.passTotal)} 失败传球 ${f2(r.passFail)} 成功率 ${f3(r.passSuccessRate)} 犯规 ${f2(r.fouls)} 抢断 ${f2(r.tackles)}`);
}
const realMean = {};
for (const k of Object.keys(realPer[0])) realMean[k] = m(realPer.map((r) => r[k]));
console.log(`真实均值：[普通射门] 射门 ${f2(realMean.shotsReg)} 进球 ${f2(realMean.goals)} 射正率 ${f3(realMean.onTargetRate)} 转化 ${f3(realMean.conversion)}`);
console.log(`          [含头球]   射门 ${f2(realMean.shotsTotal)} 进球 ${f2(realMean.goalsTotal)} 射正率 ${f3(realMean.onTargetRateTotal)} 转化 ${f3(realMean.conversionTotal)}`);
console.log(`          传球 ${f2(realMean.passTotal)} 失败传球 ${f2(realMean.passFail)} 成功率 ${f3(realMean.passSuccessRate)} 犯规 ${f2(realMean.fouls)} 抢断 ${f2(realMean.tackles)}`);
doc.real = real.map((g, i) => ({ game: g.game, ...g, rates: realPer[i] }));
doc.caliber.realPassSuccess = 'PASS 成功 ⟺ 下一条事件仍由同队产生；BALL OUT 显式排除（其 Team 是踢出界方）；无下一条/END HALF → 未定义，从分母剔除';

let engineSummary = null;
if (!noEngine) {
  console.log(`\n=== 引擎（${nSeeds} 场，seed ${seedStart}..${seedStart + nSeeds - 1}）===`);
  const per = await engineSide();
  const er = per.map(engineRates);
  engineSummary = {};
  for (const k of Object.keys(er[0])) engineSummary[k] = m(er.map((r) => r[k]));
  console.log(`引擎均值：[普通射门] 射门 ${f2(engineSummary.shotsReg)} 进球 ${f2(engineSummary.goals)} 射正率 ${f3(engineSummary.onTargetRate)} 转化 ${f3(engineSummary.conversion)}`);
  console.log(`          [含头球]   射门 ${f2(engineSummary.shotsTotal)} 进球 ${f2(engineSummary.goalsTotal)} 射正率 ${f3(engineSummary.onTargetRateTotal)} 转化 ${f3(engineSummary.conversionTotal)}`);
  console.log(`          传球 ${f2(engineSummary.passTotal)} 失败传球 ${f2(engineSummary.passFail)} `
    + `成功率(L1口径) ${f3(engineSummary.passSuccessRate)} 成功率(有向口径) ${f3(engineSummary.passSuccessRateDirected)} `
    + `犯规 ${f2(engineSummary.fouls)} 抢断 ${f2(engineSummary.tackles)}`);
  doc.engine = { seeds: nSeeds, seedStart, mean: engineSummary };
}
doc.realMean = realMean;

// ── 配对表：体积 vs 比率 ──────────────────────────────────────────────────
// 假说的可证伪形式：**体积低 ⟺ 比率高**。逐项列出来，让读者自己看配对是否成立。
const PAIRS = [
  ['普通射门/场', 'shotsReg', 'volume'],
  ['射门/场(含头球)', 'shotsTotal', 'volume'],
  ['进球/场(普通)', 'goals', 'volume'],
  ['进球/场(含头球)', 'goalsTotal', 'volume'],
  ['传球/场', 'passTotal', 'volume'],
  ['失败传球/场', 'passFail', 'volume'],
  ['射正率(普通)', 'onTargetRate', 'ratio'],
  ['射正率(含头球)', 'onTargetRateTotal', 'ratio'],
  ['转化率(普通)', 'conversion', 'ratio'],
  ['转化率(含头球)', 'conversionTotal', 'ratio'],
  ['传球成功率', 'passSuccessRate', 'ratio'],
  ['犯规/场', 'fouls', 'volume'],
  ['抢断/场', 'tackles', 'volume'],
  ['抢断成功率', 'tackleSuccessRate', 'ratio'],
];
console.log('\n=== 配对表（假说：体积低 ⟺ 比率高）===');
console.log('指标'.padEnd(16), '引擎'.padStart(10), '真实'.padStart(10), '引擎/真实'.padStart(10), '  性质');
for (const [name, key, kind] of PAIRS) {
  const e = engineSummary ? engineSummary[key] : NaN;
  const r = realMean[key];
  const ratio = Number.isFinite(e) && Number.isFinite(r) && r !== 0 ? e / r : NaN;
  console.log(name.padEnd(16), f2(e).toString().padStart(10), f2(r).toString().padStart(10),
    (Number.isFinite(ratio) ? ratio.toFixed(2) : 'NaN').padStart(10), `  ${kind}`);
  doc.comparison.push({ name, key, kind, engine: e, real: r, ratio });
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'volume-compensation.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`\n→ out/volume-compensation.json`);
