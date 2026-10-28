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
  // ── like-football.mjs（5 seed × 12s 窗）──
  // 2026-10-28：软指标从「比当前高/低」改为「以真实为中心的带」（±25%），带内 = 不退化——
  // 方向正确但中间小回退的候选不再被一刀切（第 1 轮 K1a/K2a/K4 均因此被错杀）。
  // 真实值出处：disp/lat/mix = Metrica 2 场（like-football 基线行）；hd/ad/spread/gap =
  // SkillCorner **allPoints**（dbg-caliber 探针，盲测渲染口径）；球距 ≈ 15m。带 = 真实 ×(0.75,1.25)。
  { id: 'lf.disp', label: '位移/窗', source: 'like', dir: 'band', band: [10.1, 16.8], caliber: 'like-football · 5 seed · Metrica 真实 13.46 ±25%', re: /^\s*\S+\s+位移\/窗★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.lat', label: '横向占比', source: 'like', dir: 'band', band: [0.32, 0.54], caliber: 'like-football · 5 seed · Metrica 真实 0.43 ±25%', re: /^\s*\S+\s+横向占比★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.mix', label: '混队度', source: 'like', dir: 'band', band: [0.60, 1.00], caliber: 'like-football · 5 seed · Metrica 真实 0.80 ±25%(上界封1)', re: /^\s*\S+\s+混队度★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.hd', label: '纵深(主)', source: 'like', dir: 'band', band: [19.4, 32.3], caliber: 'like-football · 5 seed · SkillCorner allPoints 25.82 ±25%', re: /^\s*\S+\s+纵深\(主\)\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.ad', label: '纵深(客)', source: 'like', dir: 'band', band: [19.2, 32.0], caliber: 'like-football · 5 seed · SkillCorner allPoints 25.63 ±25%', re: /^\s*\S+\s+纵深\(客\)\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.spread', label: '紧凑度', source: 'like', dir: 'band', band: [11.1, 18.5], caliber: 'like-football · 5 seed · SkillCorner allPoints 14.78 ±25%', re: /^\s*\S+\s+紧凑度\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.gap', label: '分边', source: 'like', dir: 'band', band: [5.2, 8.6], caliber: 'like-football · 5 seed · SkillCorner allPoints 6.88 ±25%', re: /^\s*\S+\s+分边★\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.ballDist', label: '球距', source: 'like', dir: 'band', band: [11.2, 18.7], caliber: 'like-football · 5 seed · SkillCorner 结构锚 ~15m ±25%', re: /^\s*\S+\s+球距\s+([\d.]+)\s+([\d.]+)/m },
  { id: 'lf.distance', label: '距离', source: 'like', dir: 'report', caliber: 'like-football · 5 seed · 8 行 mean|ln(E/R)| · 报告项(不判退化)', re: /距离（幅度量[^=]*=\s*([\d.]+)/m },

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
  { id: 'p18.b4', label: 'B4 压迫覆盖', source: 'p18', dir: 'lower', caliber: 'p18 行为门 · canary 30 seed · 真实 A-League', re: /\[B4\][\s\S]*?引擎\s+([\d.]+)\s+真实\s+([\d.]+)\s+倍数\s+([\d.]+)×/m },
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
  // 引擎源码指纹：只看 lib.rs（引擎的全部生产逻辑都在里面；observation.rs 不产事件流位置）
  const lib = join(ROOT, 'engine/src/lib.rs');
  const libSha = existsSync(lib) ? createHash('sha256').update(readFileSync(lib)).digest('hex').slice(0, 16) : null;
  const games = ['real-game-1.json', 'real-game-2.json'].filter((f) => existsSync(join(ROOT, 'viewer/data', f))).length;
  return { commit, wasmSha, libSha, node: process.version, realGames: games, at: new Date().toISOString() };
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
  // band：带内 = 可接受（不退化）；带外 = 越远越退化、越近越改善。
  // 2026-10-28 起：带内朝边缘走不再判退化（软指标 lf.* 用「真实 ±25%」带，方向正确但中间
  // 小回退不拦；p38.* 本就用真实 q10-q90 带，同语义）。
  const [lo, hi] = m.band;
  const outBefore = before < lo ? lo - before : before > hi ? before - hi : 0;
  const outAfter = after < lo ? lo - after : after > hi ? after - hi : 0;
  if (outBefore <= eps && outAfter <= eps) return 'same'; // 都在带内
  if (Math.abs(outAfter - outBefore) <= eps) return 'same';
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
    console.log(`  commit=${p.commit} wasm=${p.wasmSha ? p.wasmSha.slice(0, 8) : 'n/a'} lib=${p.libSha ? p.libSha.slice(0, 8) : 'n/a'} realGames=${p.realGames} node=${p.node}`);
    if (p.realGames < 2) {
      console.error(`✗ 真实帧只有 ${p.realGames} 场（需要 real-game-1/2.json 两场）。`);
      console.error('  单场时 like-football 的运动行会静默变成 13.33/0.42 口径，与票据的 13.46/0.43 不可比——拒绝落盘。');
      return 2;
    }
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
    console.log(`  before commit=${before.provenance.commit} wasm=${(before.provenance.wasmSha || 'n/a').slice(0, 8)} lib=${(before.provenance.libSha || 'n/a').slice(0, 8)} realGames=${before.provenance.realGames}`);
    console.log(`  after  commit=${after.provenance.commit} wasm=${(after.provenance.wasmSha || 'n/a').slice(0, 8)} lib=${(after.provenance.libSha || 'n/a').slice(0, 8)} realGames=${after.provenance.realGames}`);
    if (before.provenance.realGames !== after.provenance.realGames) {
      console.error('✗ 两次采集的真实数据场数不同，不可比（先补齐 viewer/data/real-game-2.json）');
      return 2;
    }
    // 防假绿：引擎源码变了、但 wasm 没重建 ⇒ 两次量的是同一份旧产物，必然「全持平」
    if (before.provenance.libSha && after.provenance.libSha
        && before.provenance.libSha !== after.provenance.libSha
        && before.provenance.wasmSha === after.provenance.wasmSha) {
      console.error('✗ engine/src/lib.rs 已变化，但 viewer/engine.wasm 未重建（sha 相同）——两份快照量的是同一份旧产物。');
      console.error('  先跑：cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm');
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
