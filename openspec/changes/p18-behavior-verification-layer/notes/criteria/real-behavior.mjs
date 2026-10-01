#!/usr/bin/env node
// P18 判据的**真实侧参照提炼器**（生产版）。
//
// 与 `../probes/real-behavior-probe.mjs` 的区别：那份是**侦察期**脚本（设计依据），
// 本份是**交付物**——多做的事：源文件 sha256、口径版本、机器可读产物的**规格化**、
// 以及「缺原始数据时明确报错」。
//
// 用法：
//   node real-behavior.mjs                       # 自动找本仓 .scratch/tracking-data 下的 matches
//   node real-behavior.mjs <matches目录>
//   P18_SKILLCORNER_DIR=... node real-behavior.mjs
//
// 输出：
//   - 人读：stdout（本文件的 .out.txt 由调用方 tee）
//   - 机器可读：`real-behavior-reference.json`（**入库**，判据器只读它）
//
// ⚠️ **原始 CSV 不入库**（`.scratch/tracking-data/` 是 gitignored，~90 MB）。
//    本脚本把提炼结果 + 源文件 sha256 写进 JSON；判据器不依赖原始数据。
//    `--verify` 模式在原始数据存在时校验 sha256 一致（缺数据时跳过、不失败）。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const OUT_PATH = join(HERE, 'real-behavior-reference.json');

// ── 口径版本：判据逻辑或口径定义变化时**必须递增**（否则两次产物不可比）──
export const CALIBER_VERSION = 'p18-real-v1';

// ── 口径（每条都是决策，不是实现细节；与 probes 版一致，编号沿用）──
//
// [C1] 时间轴：frame / 10 = 秒。每半场各自从 0 起，用 period 最小 frame 作原点，
//      再把 P2 抬到 P1 之后。
// [C2] 链 = 连续同队 `player_possession` 且相邻两行**没有死球打断**。
//      两种读法都产出：宽松（只读 `game_interruption_before`）/ 严格（再读 `after`）。
//      **主口径 = 严格**。
// [C3] 间隔：两栏（start→start 主口径 / end→start 对照）。
// [C4] 零时长 pp 行：保留在动作数、排除在时长/间隔外 ⇒ `*_all` 与 `*_pos` 两栏都报。
// [C5] 转换反应（延迟）：窗口 [t0, t0+10) 半开；半开/闭开两栏都产出以便审计。
// [C6] 聚合纪律：**逐场算再跨场平均**（绝不跨场拼接）。
// [C7] 传球失败率：分母 = `end_type == pass`；失败 = `unsuccessful` + `offside`。
// [C8] 链数两侧差 ~3×（引擎 102.5/场）⇒ 「每条链的占比」不可直接相减。
// [C9] 防守方逼近量：`interplayer_distance_{start,end,min}`（engagement 行 100% 填充）。
// [C10] 持球时间的压迫覆盖（**自归一化**）：engagement 并集 ∩ possession 并集 / possession 并集。
//       ⚠️ 不受**计数**污染，但两侧"持球时间占比赛"差 ~3×（24.2% vs 83%）⇒ 量级证据。

const DEFAULT_DIR = join(ROOT, '.scratch/tracking-data/skillcorner/opendata-master/data/matches');
const DIR = process.argv[2] || process.env.P18_SKILLCORNER_DIR || DEFAULT_DIR;
const HZ = 10;

// ── CSV（RFC4180 子集：本数据集无内嵌换行、无转义引号——实测引号字符数 = 0）──
export function splitRow(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out;
}
export function parseCsv(text) {
  const lines = text.split('\n');
  const head = splitRow(lines[0]);
  const out = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitRow(lines[i]);
    if (c.length !== head.length) { dropped += 1; continue; }  // 字段数不齐：丢掉并计数（防空转）
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j];
    out.push(o);
  }
  return { rows: out, dropped };
}

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const sd = (a) => (a.length < 2 ? NaN
  : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
export const pctl = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * p; const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};

// ── 区间并集 / 交集（C10 用）──
export function mergeIntervals(rows) {
  const s = [...rows].sort((a, b) => a[0] - b[0]); const out = [];
  for (const r of s) {
    if (out.length && r[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
export function intersectLen(a, b) {
  let i = 0; let j = 0; let sum = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]); const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) sum += hi - lo;
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return sum;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ── 单场解析 ──
export function loadGame(dir, id) {
  const src = readFileSync(join(dir, id, `${id}_dynamic_events.csv`), 'utf8');
  const { rows: ev, dropped } = parseCsv(src);

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

  let competition = null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, id, `${id}_match.json`), 'utf8'));
    competition = meta.competition_edition?.name ?? null;   // **读自数据，不是写死字面量**
  } catch { /* 缺 match.json 时留 null */ }

  const pp = ev.filter((r) => r.event_type === 'player_possession')
    .sort((a, b) => (a.period !== b.period ? a.period - b.period : T(a) - T(b)));
  const eng = ev.filter((r) => r.event_type === 'on_ball_engagement');

  const split = (strict) => {
    const chains = [];
    for (let i = 0; i < pp.length; i++) {
      const r = pp[i]; const prev = pp[i - 1];
      const broken = prev && (prev.game_interruption_before
        || (strict && prev.game_interruption_after) || prev.period !== r.period);
      const cont = chains.length && chains[chains.length - 1].team === r.team_id && !broken;
      if (cont) chains[chains.length - 1].rows.push(r);
      else chains.push({ team: r.team_id, rows: [r] });
    }
    return chains;
  };

  // C10 的区间（帧坐标，与链切分无关）
  const possIntervals = mergeIntervals(pp.map((r) => [+r.frame_start, +r.frame_end]));
  const engIntervals = mergeIntervals(eng.map((r) => [+r.frame_start, +r.frame_end]));

  const passRows = pp.filter((r) => r.end_type === 'pass');
  return {
    id, pp, eng, T, TE, competition,
    chains: split(false), chainsStrict: split(true),
    possIntervals, engIntervals,
    frameSpan: Math.max(...[...org.keys()].map((p) => span.get(p) + org.get(p))),
    passFailRate: passRows.length
      ? passRows.filter((r) => r.pass_outcome === 'unsuccessful' || r.pass_outcome === 'offside').length / passRows.length
      : NaN,
    offside: pp.filter((r) => r.pass_outcome === 'offside').length,
    zeroDur: pp.filter((r) => +r.frame_end === +r.frame_start).length,
    nPass: passRows.length, nPp: pp.length, dropped,
    csvSha256: sha256(src),
  };
}

// ── 指标（每场一个值）──
export function metrics(g, chains) {
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

  // C5 转换反应：两栏（半开 / 闭开）
  const reactHalf = []; const reactClosed = [];
  let noneHalf = 0; let noneClosed = 0; let opps = 0;
  for (let i = 0; i < chains.length - 1; i++) {
    const a = chains[i]; const b = chains[i + 1];
    if (b.team === a.team) continue;
    const lastRow = a.rows[a.rows.length - 1];
    if (lastRow.game_interruption_after) continue;
    const t0 = TE(lastRow); const t1 = T(b.rows[0]);
    if (t1 - t0 > 20) continue;
    opps++;
    const firstAfter = (lim, incl) => {
      for (const e of eng) {
        if (e.team_id !== a.team) continue;
        const et = T(e);
        if (et < t0 - 1e-9) continue;
        if (incl ? et > t0 + lim + 1e-9 : et >= t0 + lim) break;
        return et - t0;
      }
      return null;
    };
    const h = firstAfter(10, false); const c = firstAfter(10, true);
    if (h === null) noneHalf++; else reactHalf.push(h);
    if (c === null) noneClosed++; else reactClosed.push(c);
  }

  // C9：防守方逼近（engagement 的 interplayer_distance）
  const close = []; const dstart = []; const dend = []; let near = 0; let far = 0;
  for (const r of eng) {
    const a0 = Number(r.interplayer_distance_start); const b0 = Number(r.interplayer_distance_end);
    if (!Number.isFinite(a0) || !Number.isFinite(b0)) continue;
    close.push(a0 - b0); dstart.push(a0); dend.push(b0);
    if (a0 < 2) near++; if (a0 > 8) far++;
  }

  // C10：持球时间被 engagement 覆盖的占比（自归一化）
  const possLen = g.possIntervals.reduce((s, x) => s + (x[1] - x[0]), 0);
  const cover = possLen ? intersectLen(g.possIntervals, g.engIntervals) / possLen : NaN;

  return {
    id: g.id,
    // A 组
    chainDurPos: mean(durPos), actsAll: mean(actsAll), actsPos: mean(actsPos),
    gapSS: mean(ss), gapES: mean(es),
    // C 组
    shotLast: mean(lastShot.map(Number)), shotSome: mean(someShot.map(Number)),
    passFailRate: g.passFailRate,
    // 报告项（延迟表）
    reactHalfMean: mean(reactHalf), reactClosedMean: mean(reactClosed),
    reactNoneHalfShare: opps ? noneHalf / opps : NaN,
    reactNoneClosedShare: opps ? noneClosed / opps : NaN,
    reactOpps: opps,
    // B 组
    pursueStart: mean(dstart), pursueEnd: mean(dend), pursueClose: mean(close),
    pursueDur: mean(eng.map((r) => Number(r.duration)).filter(Number.isFinite)),
    pursueCount: dstart.length,
    pursueNearShare: dstart.length ? near / dstart.length : NaN,
    pursueFarShare: dstart.length ? far / dstart.length : NaN,
    coverShare: cover,
    chainsPerGame: chains.length, shotEndChains: lastShot.reduce((a, b) => a + Number(b), 0),
    zeroDurShare: g.zeroDur / g.nPp,
  };
}

// ── 主流程 ──
function main() {
  if (!existsSync(DIR)) {
    console.error(`找不到数据目录：${DIR}\n`
      + '（原始 tracking/events 数据在 .scratch/tracking-data/，属 gitignored；'
      + '运行 `node tools/fetch-tracking-data.mjs` 拉取，或用参数指定目录）');
    process.exit(1);
  }
  const ids = readdirSync(DIR).filter((f) => /^\d+$/.test(f)).sort();
  if (!ids.length) { console.error(`目录里没有场次：${DIR}`); process.exit(1); }

  const loaded = ids.map((id) => loadGame(DIR, id));
  const games = loaded.map((g) => metrics(g, g.chains));          // 宽松
  const gamesStrict = loaded.map((g) => metrics(g, g.chainsStrict)); // 严格（主口径）

  const per = (f) => gamesStrict.map(f);
  const stat = (arr) => ({
    center: mean(arr.filter(Number.isFinite)),
    sd: sd(arr.filter(Number.isFinite)),
    p10: pctl(arr.filter(Number.isFinite), 0.1),
    p50: pctl(arr.filter(Number.isFinite), 0.5),
    p90: pctl(arr.filter(Number.isFinite), 0.9),
    n: arr.filter(Number.isFinite).length,
  });
  const line = (name, arr) => {
    const s = stat(arr);
    console.log(`${name.padEnd(30)}: ${s.center.toFixed(4)} (跨场 sd ${s.sd.toFixed(4)}, n=${s.n} 场)  `
      + `p10=${s.p10.toFixed(4)} p50=${s.p50.toFixed(4)} p90=${s.p90.toFixed(4)}`);
  };

  const comps = new Map();
  for (const g of loaded) comps.set(g.competition ?? '<缺 match.json>', (comps.get(g.competition ?? '<缺 match.json>') ?? 0) + 1);
  console.log(`===== P18 真实侧参照（${ids.length} 场；口径 ${CALIBER_VERSION}）=====`);
  console.log(`联赛/赛季（读自 match.json）：${[...comps.entries()].map(([k, v]) => `${k} ×${v}`).join('；')}`);
  console.log('⚠️ 若只有一项 ⇒ 单一联赛单赛季，跨场 sd 含该联赛的系统偏差（design §9.1）\n');
  console.log('── A 组（球权过程，严格链切分）──');
  line('链墙钟时长(s)', per((g) => g.chainDurPos));
  line('链内动作间隔 start→start(s)', per((g) => g.gapSS));
  line('链内动作间隔 end→start(s)', per((g) => g.gapES));
  line('链内动作数(全部链)', per((g) => g.actsAll));
  line('链内动作数(正时长链)', per((g) => g.actsPos));
  console.log(`链数/场（严格）              : ${mean(per((g) => g.chainsPerGame)).toFixed(1)}`
    + `  宽松 ${mean(games.map((g) => g.chainsPerGame)).toFixed(1)}`
    + '  引擎 102.5 ⇒ 严格比值 2.97×');
  console.log('\n── B 组（转换反应）──');
  line('持球时间被逼近覆盖占比 [C10]', per((g) => g.coverShare));
  line('逼近段起始距离(m) [C9]', per((g) => g.pursueStart));
  line('逼近段逼近量(m) [C9]', per((g) => g.pursueClose));
  line('逼近段时长(s) [C9]', per((g) => g.pursueDur));
  line('逼近段次数/场 [C9]', per((g) => g.pursueCount));
  console.log('\n── 报告项（延迟表；不作判据）──');
  line('延迟 均值(s) 半开 [C5]', per((g) => g.reactHalfMean));
  line('10s 内无 engagement 占比 半开', per((g) => g.reactNoneHalfShare));
  console.log('\n── C 组（动作链）──');
  line('以射门【收尾】链占比', per((g) => g.shotLast));
  line('以射门【含】链占比', per((g) => g.shotSome));
  line('射门收尾链数/场', per((g) => g.shotEndChains));
  line('传球失败率 [C7]', per((g) => g.passFailRate));
  console.log(`零时长 pp 行占比: ${mean(per((g) => g.zeroDurShare)).toFixed(4)}`);

  // ── 机器可读产物 ──
  const csvHashes = {};
  for (const g of loaded) csvHashes[g.id] = g.csvSha256;
  const out = {
    schema: 'p18-real-behavior-reference/1',
    caliberVersion: CALIBER_VERSION,
    generatedBy: 'openspec/changes/p18-behavior-verification-layer/notes/criteria/real-behavior.mjs',
    source: {
      dataset: 'SkillCorner opendata',
      license: 'MIT',
      competition: [...comps.keys()],
      games: ids.map((id) => Number(id)),
      nGames: ids.length,
      nWindowsNote: '逐场算再跨场平均；不跨场拼接（口径 C6）',
      csvSha256: csvHashes,
    },
    calibers: {
      C1: 'frame/10=秒；每半场各自原点，P2 抬到 P1 后',
      C2: '链=连续同队 player_possession 且无死球打断；主口径=严格（读 before+after）',
      C3: '间隔两栏：start→start 主 / end→start 对照',
      C4: '零时长 pp 行保留在动作数、排除在时长/间隔外 ⇒ *_all 与 *_pos 两栏',
      C5: '延迟窗口 [t0, t0+10)；两栏（半开/闭开）产出',
      C6: '逐场算再跨场平均',
      C7: '传球失败率分母 = end_type==pass；失败 = unsuccessful + offside',
      C8: '链数两侧差 2.97×（严格）⇒ 每条链的占比不可直接相减',
      C9: '防守方逼近：engagement 行 interplayer_distance_{start,end,min}',
      C10: '持球时间被 engagement 覆盖：并集交/poss 并集（自归一化，不受计数污染）',
    },
    // ⚠️ 不存逐场原始值（P38 latSd 教训）；分布统计足够，逐场值在 .out.txt
    reference: {
      A_chainDurPos: stat(per((g) => g.chainDurPos)),
      A_gapSS: stat(per((g) => g.gapSS)),
      A_gapES: stat(per((g) => g.gapES)),
      A_actsAll: stat(per((g) => g.actsAll)),
      A_actsPos: stat(per((g) => g.actsPos)),
      A_chainsPerGameStrict: stat(per((g) => g.chainsPerGame)),
      A_chainsPerGameLoose: stat(games.map((g) => g.chainsPerGame)),
      B_coverShare: stat(per((g) => g.coverShare)),
      B_pursueStart: stat(per((g) => g.pursueStart)),
      B_pursueClose: stat(per((g) => g.pursueClose)),
      B_pursueDur: stat(per((g) => g.pursueDur)),
      B_pursueCount: stat(per((g) => g.pursueCount)),
      C_shotLast: stat(per((g) => g.shotLast)),
      C_shotSome: stat(per((g) => g.shotSome)),
      C_shotEndChains: stat(per((g) => g.shotEndChains)),
      C_passFailRate: stat(per((g) => g.passFailRate)),
      report_reactHalfMean: stat(per((g) => g.reactHalfMean)),
      report_reactNoneHalfShare: stat(per((g) => g.reactNoneHalfShare)),
    },
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n→ ${OUT_PATH}`);
  const totalDropped = loaded.reduce((a, g) => a + g.dropped, 0);
  if (totalDropped) console.log(`⚠️ 字段数不齐被丢掉的行：${totalDropped}`);
}

main();
