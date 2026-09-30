#!/usr/bin/env node
// #18 真实侧参照探针（**归档，可复现**）。
//
// 用法：
//   node real-behavior-probe.mjs <matches目录>
//   默认 <仓库根>/.scratch/tracking-data/skillcorner/opendata-master/data/matches
//
// 数据：SkillCorner opendata（MIT，20 场，A-League 2024/25）。
// 输入文件：<id>_dynamic_events.csv（**不是 LFS**，在仓库骨架 tar.gz 里）。
//
// ── 口径（**每一条都是决策，不是实现细节**）────────────────────────────────
//
// [C1] 时间轴：frame / 10 = 秒（dynamic_events 与 tracking 同网格，10 fps）。
//      每半场各自从 0 起，用 period 的最小 frame 作原点，再把 P2 抬到 P1 之后。
//
// [C2] 链（chain）= **连续同队 `player_possession`**，且相邻两行之间**没有死球打断**。
//      ⚠️ 「没有死球打断」有两种读法，**本探针两种都产出**：
//        宽松：只读前一行的 `game_interruption_before`（本探针初版）
//        严格：再读前一行的 `game_interruption_after`（口径原文「死球打断不连链」的完整实现）
//      实测两者让链时长差 **1.72×**（17.50 vs 10.18），故**主口径取严格**、两栏并列。
//      ⇒ 与引擎侧 `PossessionEpisode`（开放比赛、同队连续控制）同构。
//
// [C3] 间隔：**报告两栏**（start→start 与 end→start），主口径 start→start。
//      理由：引擎的决策事件是**瞬时点**，相邻决策的间隔 = 带球停留 + 飞行；
//      真实侧 pp 是**区间**，start→start = 上一段停留 + 空档 —— 与引擎同构。
//      end→start 只含空档，**不含停留**，故是另一件事。两栏并列供审计。
//
// [C4] 零时长 pp 行（`frame_end == frame_start`）：**保留在动作数里、排除在时长/间隔外**。
//      ⚠️ 这让「时长」与「动作数」的分母不同 —— 故**两栏都报**：
//      `*_all`（含零时长链）与 `*_pos`（仅正时长链）。**不得只报一栏。**
//
// [C5] 转换反应：一次开放比赛丢球 = 一条链结束且下一条链属**对方**（gap ≤ 20 s，
//      且本行 `game_interruption_after` 为空）。延迟 = 失球方首个
//      `on_ball_engagement` 的 start − 丢球时刻。窗口 [t0, t0+10)。
//      ⚠️ `on_ball_engagement` 是**标注者认为有接触**的事件，**不覆盖「有人跑向球」**。
//      这是与引擎侧 `Mover.action ∈ {chase, close_down}` 的**根本差异**，
//      故本量**只用于描述真实侧**，不与引擎直接相减（见 gates-spec 的 `sameThing`）。
//
// [C6] 聚合纪律：**逐场算再跨场平均**（绝不跨场拼接）——P38 实测拼接会让 sd 虚高 6.5×。
//
// [C7] 传球失败率：分母 = `end_type == pass` 的行；
//      失败 = `pass_outcome ∈ {unsuccessful, offside}`。
//      ⚠️ `pass_outcome` 为空 ⟺ `end_type != pass`（实测 18710 行完全一致），**不是"未知"**。
//      ⚠️ 引擎侧 `pass.result` 有 5 个取值（success/contested/intercepted/out/lost），
//      合并到真实的二分**是一次实质判断**（`contested` 占传球 5.4%，不是稀有值）。
//
// [C8] **链数本身两侧差 2.56×**（真实 262.9/场 vs 引擎 102.5/场）。
//      ⇒ 任何「**每条链**的占比 / 每链均值」在两侧**不可直接相减**
//      （分母本身差 2.56×）。比较前必须换算成「每场总量」或先声明这一点。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = join(
  process.env.SKILLCORNER_DIR
    || new URL('../../../../..', import.meta.url).pathname
      + '/.scratch/tracking-data/skillcorner/opendata-master/data/matches',
);
const DIR = process.argv[2] || DEFAULT_DIR;
const HZ = 10;

// ── CSV（RFC4180 子集：本例无内嵌换行、无转义引号）──
function splitRow(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out;
}
function parseCsv(text) {
  const lines = text.split('\n');
  const head = splitRow(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitRow(lines[i]);
    if (c.length !== head.length) continue;   // 字段数不齐的行丢掉（并计数）
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j];
    out.push(o);
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => (a.length < 2 ? NaN
  : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const pctl = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * p; const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};

// ── 单场解析 ──
function loadGame(dir, id) {
  const ev = parseCsv(readFileSync(join(dir, id, `${id}_dynamic_events.csv`), 'utf8'));
  const org = new Map(); const span = new Map();
  for (const r of ev) {
    const p = r.period; const f = +r.frame_start;
    if (!org.has(p) || f < org.get(p)) org.set(p, f);
    const sp1 = (+r.frame_end - org.get(p)) / HZ;
    if (!span.has(p) || sp1 > span.get(p)) span.set(p, sp1);
  }
  const off = new Map(); let acc = 0;
  for (const p of [...org.keys()].sort()) { off.set(p, acc); acc += (span.get(p) ?? 0) + 5; }
  const T = (r) => off.get(r.period) + (+r.frame_start - org.get(r.period)) / HZ;
  const TE = (r) => off.get(r.period) + (+r.frame_end - org.get(r.period)) / HZ;

  // 联赛/赛季：从 match.json 读出（**不是写死的字面量**）
  let competition = null; let nPlayers = null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, id, `${id}_match.json`), 'utf8'));
    competition = meta.competition_edition?.name ?? null;
    nPlayers = Array.isArray(meta.players) ? meta.players.length : null;
  } catch { /* match.json 缺失时留 null，输出里会显示 */ }

  const pp = ev.filter((r) => r.event_type === 'player_possession')
    .sort((a, b) => (a.period !== b.period ? a.period - b.period : T(a) - T(b)));
  const eng = ev.filter((r) => r.event_type === 'on_ball_engagement');

  // 链（口径 C2）。两种切分规则**都产出**——它们差 1.6×（见输出），
  // 只报一种就是口径单点。
  //   strict=false：只读前一行的 `game_interruption_before`（本探针初版）
  //   strict=true ：再读前一行的 `game_interruption_after`（口径原文完整实现）
  const split = (strict) => {
    const chains = [];
    for (let i = 0; i < pp.length; i++) {
      const r = pp[i];
      const prev = pp[i - 1];
      const broken = prev && (prev.game_interruption_before
        || (strict && prev.game_interruption_after) || prev.period !== r.period);
      const cont = chains.length && chains[chains.length - 1].team === r.team_id && !broken;
      if (cont) chains[chains.length - 1].rows.push(r);
      else chains.push({ team: r.team_id, rows: [r] });
    }
    return chains;
  };
  // 传球失败率（口径 C7）：分母 = end_type == pass 的行
  const passRows = pp.filter((r) => r.end_type === 'pass');
  const passFail = passRows.filter((r) => r.pass_outcome === 'unsuccessful' || r.pass_outcome === 'offside');
  const offside = pp.filter((r) => r.pass_outcome === 'offside').length;
  const zeroDur = pp.filter((r) => +r.frame_end === +r.frame_start).length;
  return {
    id, pp, eng, T, TE, competition, nPlayers,
    chains: split(false), chainsStrict: split(true),
    passFailRate: passRows.length ? passFail.length / passRows.length : NaN,
    offside, zeroDur, nPass: passRows.length, nPp: pp.length,
  };
}

// ── 指标（每场一个值）──
function metrics(g, chains) {
  const { eng, T, TE } = g;
  const ss = []; const es = []; const durPos = []; const actsAll = []; const actsPos = [];
  const lastShot = []; const someShot = [];
  for (const c of chains) {
    actsAll.push(c.rows.length);
    for (let i = 1; i < c.rows.length; i++) {
      ss.push(T(c.rows[i]) - T(c.rows[i - 1]));
      es.push(T(c.rows[i]) - TE(c.rows[i - 1]));
    }
    const a = TE(c.rows[c.rows.length - 1]) - T(c.rows[0]);
    if (a > 0) { durPos.push(a); actsPos.push(c.rows.length); }
    lastShot.push(c.rows[c.rows.length - 1].end_type === 'shot');
    someShot.push(c.rows.some((r) => r.end_type === 'shot'));
  }

  // 转换反应（口径 C5）
  const react = []; let reactNone = 0; let reactOpps = 0;
  for (let i = 0; i < chains.length - 1; i++) {
    const a = chains[i]; const b = chains[i + 1];
    if (b.team === a.team) continue;
    const lastRow = a.rows[a.rows.length - 1];
    if (lastRow.game_interruption_after) continue;
    const t0 = TE(lastRow); const t1 = T(b.rows[0]);
    if (t1 - t0 > 20) continue;
    reactOpps++;
    let hit = null;
    for (const e of eng) {
      if (e.team_id !== a.team) continue;
      const et = T(e);
      if (et < t0 - 1e-9) continue;
      if (et >= t0 + 10) break;
      hit = et - t0; break;
    }
    if (hit === null) reactNone++; else react.push(hit);
  }
  return {
    id: g.id,
    chainDurPos: mean(durPos), chainDurPosArr: durPos,
    actsAll: mean(actsAll), actsPos: mean(actsPos),
    gapSS: mean(ss), gapES: mean(es),
    shotLast: mean(lastShot.map(Number)), shotSome: mean(someShot.map(Number)),
    reactArr: react, reactNoneShare: reactOpps ? reactNone / reactOpps : NaN,
    chainsPerGame: chains.length,
    shotEndChains: lastShot.reduce((a, b) => a + Number(b), 0),
    shotEndChainShare: mean(lastShot.map(Number)),
    passFailRate: g.passFailRate,
    offside: g.offside,
    zeroDurShare: g.zeroDur / g.nPp,
  };
}

const ids = readdirSync(DIR).filter((f) => /^\d+$/.test(f)).sort();
if (!ids.length) { console.error(`没有场次：${DIR}`); process.exit(1); }
const loaded = ids.map((id) => loadGame(DIR, id));
const games = loaded.map((g) => metrics(g, g.chains));          // 规则 B（宽松）
const gamesStrict = loaded.map((g) => metrics(g, g.chainsStrict)); // 规则 C（严格）

// ── 输出：逐场 → 跨场 ──
const per = (f) => games.map(f);
const line = (name, arr, unit = '') => {
  const v = arr.filter(Number.isFinite);
  console.log(`${name}: ${mean(v).toFixed(4)}${unit} (跨场 sd ${sd(v).toFixed(4)}, n=${v.length} 场)  `
    + `p10=${pctl(v, 0.1).toFixed(4)} p50=${pctl(v, 0.5).toFixed(4)} p90=${pctl(v, 0.9).toFixed(4)}  `
    + `[${Math.min(...v).toFixed(4)}, ${Math.max(...v).toFixed(4)}]`);
};
console.log(`===== SkillCorner 真实侧（${ids.length} 场，逐场算再跨场平均）=====`);
console.log('⚠️ 下面这一段用**宽松**链切分规则；严格规则（主口径）的对照在「链切分规则敏感性」一节');
const comps = new Map();
for (const g of loaded) comps.set(g.competition ?? '<缺 match.json>', (comps.get(g.competition ?? '<缺 match.json>') ?? 0) + 1);
console.log(`联赛/赛季（**读自 match.json**）：${[...comps.entries()].map(([k, v]) => `${k} ×${v}`).join('；')}`);
const teamIds = new Set();
for (const g of loaded) { const m = g.nPlayers; if (m) teamIds.add(m); }
console.log(`⚠️ 若上表只有一项 ⇒ **单一联赛单赛季**，跨场 sd 里含该联赛的系统偏差（design §3.2/§9.1）`);
line('链时长(s) 仅正时长链 宽松 [C4]', per((g) => g.chainDurPos));
line('链动作数 全部链           [C4]', per((g) => g.actsAll));
line('链动作数 仅正时长链       [C4]', per((g) => g.actsPos));
line('间隔 start→start (s) 宽松规则[C3]', per((g) => g.gapSS));
line('间隔 end→start   (s) 对照  [C3]', per((g) => g.gapES));
line('以射门【收尾】的链占比     ', per((g) => g.shotLast));
line('【含】射门的链占比  对照   ', per((g) => g.shotSome));
line('10s 内无 engagement 占比  [C5]', per((g) => g.reactNoneShare));
line('链数/场                   ', per((g) => g.chainsPerGame));

// 反应延迟的**整体分布**（不是场均值的分布——两者不同，勿混）
const allReact = games.flatMap((g) => g.reactArr);
console.log(`\n反应延迟整体分布（池化描述，n=${allReact.length}）：`
  + `p10=${pctl(allReact, 0.1).toFixed(2)} p50=${pctl(allReact, 0.5).toFixed(2)} `
  + `p90=${pctl(allReact, 0.9).toFixed(2)} max=${Math.max(...allReact).toFixed(2)}`);
const hist = new Map();
for (const x of allReact) hist.set(x.toFixed(1), (hist.get(x.toFixed(1)) ?? 0) + 1);
console.log('  直方图(秒:计数，前 12)：'
  + [...hist.entries()].sort((a, b) => +a[0] - +b[0]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join('  '));
console.log(`  P(延迟 == 0) = 0（最小正值 ${Math.min(...allReact).toFixed(2)} s = 1 帧）`);
console.log(`  P(延迟 <= 0.2s) = ${(allReact.filter((x) => x <= 0.2 + 1e-9).length / allReact.length).toFixed(4)}  ← **池化**`);
console.log(`  P(延迟 <= 0.2s) 逐场再跨场 = ${mean(per((g) => { const r = g.reactArr; return r.length ? r.filter((x) => x <= 0.2 + 1e-9).length / r.length : NaN; })).toFixed(4)}  ← **主口径（C6）**`);

// ── 两种链切分规则的对照（口径单点防护）──
const perStrict = (f) => gamesStrict.map(f);
console.log('\n===== 链切分规则敏感性（口径 C2）=====');
console.log('⚠️ 规则差异会让链时长差 1.6×，故两种都报，主口径为**严格规则**（与口径原文一致）');
line('链数/场        宽松(只读 prev.gib)  ', per((g) => g.chainsPerGame));
line('链数/场        严格(+prev.gia)      ', perStrict((g) => g.chainsPerGame));
line('链时长(s)      宽松                 ', per((g) => g.chainDurPos));
line('链时长(s)      严格                 ', perStrict((g) => g.chainDurPos));
line('链动作数       严格(全部链)         ', perStrict((g) => g.actsAll));
line('链动作数       严格(仅正时长链)     ', perStrict((g) => g.actsPos));
line('间隔 start→start 严格              ', perStrict((g) => g.gapSS));
line('间隔 end→start   严格              ', perStrict((g) => g.gapES));
line('射门【收尾】链占比 严格            ', perStrict((g) => g.shotLast));
line('射门【收尾】链数/场 严格           ', perStrict((g) => g.shotEndChains));
line('【含】射门链占比   严格            ', perStrict((g) => g.shotSome));
line('传球失败率 (C7)                    ', per((g) => g.passFailRate));

// ── 每场总量（与链切分无关的量，用于判断"占比"类指标的分母是否可比）──
const totals = loaded.map((g) => ({
  id: g.id,
  pp: g.nPp,
  nPass: g.nPass,
  zeroDurShare: g.zeroDur / g.nPp,
  offside: g.offside,
}));
console.log('\n===== 每场总量 =====');
console.log(`pp 行/场        : ${mean(totals.map((t) => t.pp)).toFixed(1)}`);
console.log(`pass 行/场      : ${mean(totals.map((t) => t.nPass)).toFixed(1)}`);
console.log(`零时长 pp 行占比: ${mean(totals.map((t) => t.zeroDurShare)).toFixed(4)}`);
console.log(`offside 总次数  : ${totals.reduce((a, t) => a + t.offside, 0)}`);
console.log(`⚠️ 引擎侧对照：链数 102.5/场、episode 3075/30 —— **链数差 2.56×**，`);
console.log(`   故任何「每条链的占比」在两侧不可直接相减（见 design §2.3）。`);

// 机器可读
const out = {
  source: { dataset: 'SkillCorner opendata', license: 'MIT', games: ids.length,
    competition: [...comps.keys()], caliber: 'real-behavior-probe.mjs C1–C8' },
  perGame: games,
  cross: {
    chainDurPos: mean(per((g) => g.chainDurPos)), chainDurPosSd: sd(per((g) => g.chainDurPos)),
    actsAll: mean(per((g) => g.actsAll)), actsPos: mean(per((g) => g.actsPos)),
    gapSS: mean(per((g) => g.gapSS)), gapSSSd: sd(per((g) => g.gapSS)),
    gapES: mean(per((g) => g.gapES)),
    shotLast: mean(per((g) => g.shotLast)), shotLastSd: sd(per((g) => g.shotLast)),
    shotSome: mean(per((g) => g.shotSome)),
    reactNoneShare: mean(per((g) => g.reactNoneShare)),
  },
  reactDelayPooled: { n: allReact.length, p10: pctl(allReact, 0.1), p50: pctl(allReact, 0.5),
    p90: pctl(allReact, 0.9), min: Math.min(...allReact) },
};
if (process.env.P18_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.P18_OUT, JSON.stringify(out, null, 2));
  console.log(`\n→ ${process.env.P18_OUT}`);
}
