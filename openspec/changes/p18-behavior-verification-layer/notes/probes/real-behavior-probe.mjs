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
// [C2] 链（chain）= **连续同队 `player_possession`**，且相邻两行之间
//      `game_interruption_before` 为空（死球打断 ⇒ 不连成一条链）。
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

  const pp = ev.filter((r) => r.event_type === 'player_possession')
    .sort((a, b) => (a.period !== b.period ? a.period - b.period : T(a) - T(b)));
  const eng = ev.filter((r) => r.event_type === 'on_ball_engagement');

  // 链（口径 C2）
  const chains = [];
  for (let i = 0; i < pp.length; i++) {
    const r = pp[i];
    const cont = chains.length && chains[chains.length - 1].team === r.team_id
      && !pp[i - 1].game_interruption_before && pp[i - 1].period === r.period;
    if (cont) chains[chains.length - 1].rows.push(r);
    else chains.push({ team: r.team_id, rows: [r] });
  }
  return { id, pp, eng, chains, T, TE };
}

// ── 指标（每场一个值）──
function metrics(g) {
  const { chains, eng, T, TE } = g;
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
  };
}

const ids = readdirSync(DIR).filter((f) => /^\d+$/.test(f)).sort();
if (!ids.length) { console.error(`没有场次：${DIR}`); process.exit(1); }
const games = ids.map((id) => metrics(loadGame(DIR, id)));

// ── 输出：逐场 → 跨场 ──
const per = (f) => games.map(f);
const line = (name, arr, unit = '') => {
  const v = arr.filter(Number.isFinite);
  console.log(`${name}: ${mean(v).toFixed(4)}${unit} (跨场 sd ${sd(v).toFixed(4)}, n=${v.length} 场)  `
    + `p10=${pctl(v, 0.1).toFixed(4)} p50=${pctl(v, 0.5).toFixed(4)} p90=${pctl(v, 0.9).toFixed(4)}  `
    + `[${Math.min(...v).toFixed(4)}, ${Math.max(...v).toFixed(4)}]`);
};
console.log(`===== SkillCorner 真实侧（${ids.length} 场，逐场算再跨场平均）=====`);
console.log('⚠️ 单一联赛单一赛季：AUS - A-League - 2024/2025');
line('链时长(s) 仅正时长链      [C4]', per((g) => g.chainDurPos));
line('链动作数 全部链           [C4]', per((g) => g.actsAll));
line('链动作数 仅正时长链       [C4]', per((g) => g.actsPos));
line('间隔 start→start (s) 主口径[C3]', per((g) => g.gapSS));
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
console.log(`  P(延迟 <= 0.2s) = ${(allReact.filter((x) => x <= 0.2 + 1e-9).length / allReact.length).toFixed(4)}`);

// 机器可读
const out = {
  source: { dataset: 'SkillCorner opendata', license: 'MIT', games: ids.length,
    competition: 'AUS - A-League - 2024/2025', caliber: 'real-behavior-probe.mjs C1–C6' },
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
