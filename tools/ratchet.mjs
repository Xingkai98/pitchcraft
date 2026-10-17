// 验收 ratchet：把「现状」采成一份带口径的快照，改完自动判「变差 / 改善 / 不动」。
//
// ── 为什么有它 ────────────────────────────────────────────────────────────
// 本仓现有三个验收工具都是「报告期」：`check-criteria.mjs` 恒 `exit 0`、
// `like-football.mjs` 不在 `verify.sh` 里、P18 判据器只打印不阻塞。
// 于是「本次改动不许让任何指标变差」这句话**没有机器判定**，只能人眼看，
// 且各自手抄的数字还会混口径（10 seed vs 5 seed、Metrica 锚 vs SkillCorner 锚）。
// 这个工具只做三件事：**统一采集 → 带口径落盘 → 按方向判退化**。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node tools/ratchet.mjs save <path.json>     # 改动前：落盘现状
//   node tools/ratchet.mjs diff <path.json>     # 改动后：判退化（**有退化则 exit 1**）
//   node tools/ratchet.mjs list                 # 看指标清单与方向
//
// 退出码：0 = 无退化；1 = 有退化；2 = 采集失败（缺数据/缺产物/解析不到）。
// **缺数据一律 exit 2，绝不静默跳过**——静默跳过会让「没测」看起来像「没变差」。
//
// ── 口径纪律 ─────────────────────────────────────────────────────────────
// 每条指标都绑定 `source`（哪个工具）、`seeds`、`realAnchor`；保存时一并落盘。
// 不同 `source` 的数字**不可互相比较**（`hd` 在 criteria 是 10 seed、在 like-football 是 5 seed，
// 值都不同），所以这里不合并、只并列。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 指标登记表 ────────────────────────────────────────────────────────────
// dir: 'higher' 越高越好 | 'lower' 越低越好 | 'band' 落带内最好（用 distToBand 判）
// 取不到的指标一律 throw，不填默认值。
export const METRICS = [
  // ── like-football.mjs（5 seed × 12s 窗；真实锚 = Metrica real-game-1/2）──
  { id: 'lf.disp', label: '位移/窗', source: 'like', dir: 'higher', caliber: 'like-football · 5 seed · 12s 窗 · Metrica 2 场', re: /^\s*\S+\s+位移\/窗★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.lat', label: '横向占比', source: 'like', dir: 'higher', caliber: 'like-football · 5 seed · 12s 窗 · Metrica 2 场', re: /^\s*\S+\s+横向占比★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.mix', label: '混队度', source: 'like', dir: 'higher', caliber: 'like-football · 5 seed · 12s 窗 · Metrica 2 场', re: /^\s*\S+\s+混队度★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.hd', label: '纵深(主)', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · SkillCorner 结构锚', re: /^\s*\S+\s+纵深\(主\)\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.ad', label: '纵深(客)', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · SkillCorner 结构锚', re: /^\s*\S+\s+纵深\(客\)\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.spread', label: '紧凑度', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · SkillCorner 结构锚', re: /^\s*\S+\s+紧凑度\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.gap', label: '分边', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · SkillCorner 结构锚', re: /^\s*\S+\s+分边★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.ballDist', label: '球距', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · SkillCorner 结构锚', re: /^\s*\S+\s+球距\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.distance', label: '距离', source: 'like', dir: 'lower', caliber: 'like-football · 5 seed · 8 行 mean|ln(E/R)|', re: /距离（幅度量[^=]*=\s*([\d.]+)/m },

  // ── check-criteria.mjs（10 seed；真实锚 = Metrica；band 取自 criteria-spec）──
  { id: 'p38.hd', label: '纵深', source: 'criteria', dir: 'band', band: [23.385, 28.385], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /纵深\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.spread', label: '紧凑度', source: 'criteria', dir: 'band', band: [13.41, 17.01], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /紧凑度\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.gap', label: '重心间距', source: 'criteria', dir: 'band', band: [6.54, 10.14], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /重心间距\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.latSd', label: '横向位移 sd', source: 'criteria', dir: 'band', band: [7.015, 14.015], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /横向位移 sd\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.swarm', label: 'y 两两相关', source: 'criteria', dir: 'band', band: [0.451, 0.891], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /y 两两相关\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.fault', label: '断层幅度', source: 'criteria', dir: 'band', band: [2.45, 7.45], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /断层幅度\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  { id: 'p38.balance', label: '各线均衡', source: 'criteria', dir: 'band', band: [0.84, 1.28], caliber: 'check-criteria · 10 seed · Metrica 锚', re: /各线均衡\s+当前\s+([\d.]+)\s+目标\s+\[([\d.]+), ([\d.]+)\]/m },
  // 单边下界：只防崩，不是真实目标
  { id: 'p38.shotsReg', label: '普通射门/场', source: 'criteria', dir: 'higher', caliber: 'check-criteria · 10 seed · 单边下界（真实参照 16.51）', re: /普通射门\/场\s+当前\s+([\d.]+)/m },

  // ── check-behavior-gates.mjs（canary 30 seed；真实锚 = A-League 20 场）──
  { id: 'p18.a1', label: 'A1 链时长(s)', source: 'p18', dir: 'lower', caliber: 'p18 行为门 · canary 30 seed · 真实 A-League', re: /\[A1\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)\s+倍数\s+([\d.]+)×/m },
  { id: 'p18.a2', label: 'A2 动作间隔(s)', source: 'p18', dir: 'lower', caliber: 'p18 行为门 · canary 30 seed · 真实 A-League', re: /\[A2\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)\s+倍数\s+([\d.]+)×/m },
  { id: 'p18.b4', label: 'B4 压迫覆盖', source: 'p18', dir: 'higher', caliber: 'p18 行为门 · canary 30 seed · 真实 A-League', re: /\[B4\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)\s+倍数\s+([\d.]+)×/m },
  // A3/C1 是护栏（tool 恒判过），这里只存「引擎值」供对照，不进退化判定
  { id: 'p18.a3', label: 'A3 链内动作数', source: 'p18', dir: 'report', caliber: 'p18 行为门 · canary 30 seed · 护栏（工具恒判过）· 仅对照', re: /\[A3\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)/m },
  { id: 'p18.c1', label: 'C1 射门收尾链占比', source: 'p18', dir: 'report', caliber: 'p18 行为门 · canary 30 seed · 护栏（分母不可比）· 仅对照', re: /\[C1\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)/m },
];

const SRC = {
  like: ['node', ['tools/visual-review/like-football.mjs', 'viewer/engine.wasm', '5', '12']],
  criteria: ['node', ['openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs']],
  p18: ['node', ['openspec/changes/p18-behavior-verification-layer/notes/criteria/check-behavior-gates.mjs']],
};

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

function provenance() {
  let commit = 'unknown';
  try { commit = run('git', ['rev-parse', '--short', 'HEAD']).trim(); } catch { /* 非 git 环境：保留 unknown */ }
  let wasmSha = null;
  const wasm = join(ROOT, 'viewer/engine.wasm');
  if (existsSync(wasm)) wasmSha = createHash('sha256').update(readFileSync(wasm)).digest('hex').slice(0, 16);
  const games = ['real-game-1.json', 'real-game-2.json'].filter((f) => existsSync(join(ROOT, 'viewer/data', f))).length;
  return { commit, wasmSha, node: process.version, realGames: games, at: new Date().toISOString() };
}

/** 采集所有指标。任一 source 失败或缺数据 → 抛错（调用方转 exit 2）。 */
export function collect({ skipP18 = false } = {}) {
  const out = {};
  const texts = {};
  for (const [key, [cmd, args]] of Object.entries(SRC)) {
    if (key === 'p18' && skipP18) continue;
    texts[key] = run(cmd, args);
    // 「跳过」= 数据缺失，必须失败，不能当成「没变差」
    if (/跳过|缺产物|缺真实侧数据/.test(texts[key])) {
      throw new Error(`[${key}] 采集被跳过（缺数据/产物），拒绝对比：\n${texts[key].split('\n').filter((l) => /跳过|缺/.test(l)).join('\n')}`);
    }
  }
  for (const m of METRICS) {
    if (m.source === 'p18' && skipP18) continue;
    const t = texts[m.source];
    if (!t) throw new Error(`[${m.id}] 缺来源输出 ${m.source}`);
    const hit = t.match(m.re);
    if (!hit) throw new Error(`[${m.id}] 解析不到（${m.source} 的输出格式变了？）`);
    const val = Number(hit[1]);
    if (!Number.isFinite(val)) throw new Error(`[${m.id}] 解析出非数字：${hit[1]}`);
    out[m.id] = { value: val, real: hit[2] != null ? Number(hit[2]) : null };
  }
  return { metrics: out, provenance: provenance() };
}

/** 方向感知的退化判定。返回 'regress' | 'improve' | 'same' | 'report'。 */
export function judge(m, before, after) {
  if (m.dir === 'report') return 'report';
  const eps = Math.max(Math.abs(before) * 1e-4, 1e-6); // 抖动容差
  const d = after - before;
  if (Math.abs(d) <= eps) return 'same';
  if (m.dir === 'higher') return d < 0 ? 'regress' : 'improve';
  if (m.dir === 'lower') return d > 0 ? 'regress' : 'improve';
  // band：看「离带心的距离」是变远还是变近
  const [lo, hi] = m.band;
  const mid = (lo + hi) / 2;
  const outBefore = before < lo ? lo - before : before > hi ? before - hi : 0;
  const outAfter = after < lo ? lo - after : after > hi ? after - hi : 0;
  if (Math.abs(outBefore - outAfter) <= eps) {
    // 都在带内或同距：按离带心远近判
    return Math.abs(after - mid) <= Math.abs(before - mid) ? 'same' : 'regress';
  }
  return outAfter > outBefore ? 'regress' : 'improve';
}

function fmt(v) { return v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(3)); }

function main() {
  const [mode, path] = process.argv.slice(2);
  if (mode === 'list' || !mode) {
    console.log('指标清单（source 不同不可互比）：');
    for (const m of METRICS) console.log(`  ${m.id.padEnd(14)} ${m.label.padEnd(16)} dir=${m.dir.padEnd(6)} ${m.caliber}`);
    if (!mode) console.log('\n用法：save <path.json> | diff <path.json> | list');
    return 0;
  }
  if (!path) { console.error('缺 <path.json>'); return 2; }

  if (mode === 'save') {
    let snap;
    try { snap = collect(); } catch (e) { console.error(`✗ 采集失败：${e.message}`); return 2; }
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, metrics: METRICS.map((m) => ({ id: m.id, label: m.label, dir: m.dir, band: m.band ?? null, caliber: m.caliber })), ...snap }, null, 2));
    console.log(`✓ 已落盘 ${path}`);
    const p = snap.provenance;
    console.log(`  commit=${p.commit} wasm=${p.wasmSha ? p.wasmSha.slice(0, 8) : 'n/a'} realGames=${p.realGames} node=${p.node}`);
    if (p.realGames < 2) console.log('  ⚠ 真实帧只有 1 场：like-football 的运动行会与「2 场口径」不可比（见 START-HERE §5）');
    for (const m of METRICS) console.log(`  ${m.id.padEnd(14)} ${fmt(snap.metrics[m.id]?.value).padStart(10)}`);
    return 0;
  }

  if (mode === 'diff') {
    const before = JSON.parse(readFileSync(path, 'utf8'));
    let after;
    try { after = collect(); } catch (e) { console.error(`✗ 采集失败：${e.message}`); return 2; }
    const rows = [];
    let regress = 0;
    for (const m of METRICS) {
      const b = before.metrics[m.id]?.value;
      const a = after.metrics[m.id]?.value;
      if (b == null || a == null) { rows.push([m, b, a, 'report']); continue; }
      const v = judge(m, b, a);
      if (v === 'regress') regress += 1;
      rows.push([m, b, a, v]);
    }
    const tag = { regress: '✗ 变差', improve: '✓ 改善', same: '· 持平', report: '· 对照' };
    console.log(`ratchet：${path}`);
    console.log(`  before commit=${before.provenance.commit} wasm=${(before.provenance.wasmSha || 'n/a').slice(0, 8)} realGames=${before.provenance.realGames}`);
    console.log(`  after  commit=${after.provenance.commit} wasm=${(after.provenance.wasmSha || 'n/a').slice(0, 8)} realGames=${after.provenance.realGames}`);
    if (before.provenance.realGames !== after.provenance.realGames) {
      console.error('✗ 两次采集的真实数据场数不同，不可比（先补齐 viewer/data/real-game-2.json）');
      return 2;
    }
    console.log('');
    for (const [m, b, a, v] of rows) {
      console.log(`  ${m.id.padEnd(14)} ${fmt(b).padStart(10)} → ${fmt(a).padStart(10)}  ${tag[v]}   (${m.dir})`);
    }
    console.log('');
    console.log(regress === 0 ? '✓ 无退化' : `✗ ${regress} 项退化`);
    return regress === 0 ? 0 : 1;
  }

  console.error(`未知模式 ${mode}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
