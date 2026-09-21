#!/usr/bin/env node
// 拉取 StatsBomb Open Data 的**比赛事件**到本地（供射门质量/转化率校准使用）。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
// 引擎要校准「射门转化率随射门质量如何变化」，需要**足够多场**的射门事件
// （Metrica 2–3 场 CI 宽到跨过判据边界；SkillCorner **完全没有射门事件**，已核实）。
// StatsBomb Open Data 有 4000+ 场带射门坐标 + 结果 + xG + 射门瞬间 freeze_frame。
//
// ── ⚠ 许可（必读，决定了产物怎么用）─────────────────────────────────────
// StatsBomb Public Data User Agreement（仓库内 `LICENSE.pdf`）**不是** MIT/CC：
//   · 免费，限 analysis / research 用途
//   · **1.2.1 不得编辑/扭曲/分发/复制/出售原始数据给第三方**
//   · **1.2.2 不得商用**（含基于该数据的分析）
//   · 1.4 公开发表分析须署名 StatsBomb
//   · 2.2 要求使用者先在官网登记（形式性）
//
// **对本仓库的含义（开源项目）**：
//   · 原始事件 JSON **绝不入库** —— 只落 `.scratch/tracking-data/`（.gitignore 已排除）
//   · **可入库的只有"派生出的聚合量"**（转化率表这类常数，不是逐条数据）——
//     类似 `viewer/data/benchmark-baseline.json` 的定位
//   · 任何公开产出（报告/README）须**署名 StatsBomb**
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node tools/fetch-statsbomb-shots.mjs --limit 240      # 取 ~240 场（默认，够 CI≤0.05）
//   node tools/fetch-statsbomb-shots.mjs --limit 0        # 全量 4000+ 场（~10GB）
//   node tools/fetch-statsbomb-shots.mjs --check          # 只报告本地已有什么
//
// 幂等：已下完整的场跳过；单场失败不影响其余（重跑续传）。
//
// ── 网络（本机实测）────────────────────────────────────────────────────
// `raw.githubusercontent.com` 与 `github.com` 被拦；走 **`api.github.com` 的 blobs API**
// （用 `gh auth token`，配额 5000/h）可达。故本脚本用后者。

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, '.scratch', 'tracking-data', 'statsbomb');
const EV_DIR = join(DEST, 'events');
const INDEX_PATH = join(DEST, 'match-index.json');

const REPO = 'hudl/open-data';
const API = `https://api.github.com/repos/${REPO}`;

// 取样时优先覆盖的赛事（跨联赛、跨年代、含女足——避免单一联赛偏倚）
const PREFERRED = [
  'La Liga', 'Premier League', 'Serie A', '1. Bundesliga', 'Ligue 1',
  'FIFA World Cup', 'UEFA Euro', 'Champions League',
  "FA Women's Super League", 'NWSL', "Women's World Cup",
  'Major League Soccer', 'Liga Profesional', 'African Cup of Nations', 'Copa America',
];

// ── HTTP ────────────────────────────────────────────────────────────────

let TOKEN = null;
function token() {
  if (TOKEN) return TOKEN;
  try {
    TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('需要 `gh` CLI 已登录（本机 github.com 被拦，只有 api.github.com 可达）。先跑 `gh auth login`。');
  }
  return TOKEN;
}

function apiGet(path) {
  const out = execFileSync('curl', [
    '-sSL', '--connect-timeout', '30', '--max-time', '180',
    '-H', `Authorization: Bearer ${token()}`,
    '-H', 'Accept: application/vnd.github+json',
    `${API}${path}`,
  ], { maxBuffer: 64 << 20, encoding: 'utf8' });
  const j = JSON.parse(out);
  if (j && j.message && !j.tree && !j.content) throw new Error(`GitHub API: ${j.message}`);
  return j;
}

/** 拉一个 blob（base64），返回文本。 */
function blobText(sha) {
  const j = apiGet(`/git/blobs/${sha}`);
  return Buffer.from(j.content, 'base64').toString('utf8');
}

// ── 索引 ────────────────────────────────────────────────────────────────

/**
 * 建（或读）"比赛 → 赛事/赛季"索引。
 * 走 `data/matches/<comp>/<season>.json`（每个是一次比赛列表），不逐场拉。
 */
function buildIndex() {
  if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

  console.log('⬇ 拉仓库文件清单…');
  const tree = apiGet('/git/trees/master?recursive=1');
  const shas = new Map(tree.tree.map((x) => [x.path, x.sha]));
  console.log(`  文件 ${shas.size.toLocaleString()} 项`);

  const matchFiles = [...shas.keys()].filter((p) => /^data\/matches\/[^/]+\/[^/]+\.json$/.test(p));
  console.log(`  比赛列表文件 ${matchFiles.length} 个，逐个拉（取赛事/赛季）…`);

  const index = [];
  for (let i = 0; i < matchFiles.length; i += 1) {
    const p = matchFiles[i];
    const [, comp, seasonFile] = p.match(/^data\/matches\/([^/]+)\/([^/]+)\.json$/);
    let list;
    try { list = JSON.parse(blobText(shas.get(p))); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (m && m.match_id != null) {
        index.push({ match_id: m.match_id, comp, season: seasonFile.replace(/\.json$/, ''), match_file: p });
      }
    }
    if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${matchFiles.length}`);
  }
  mkdirSync(DEST, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1));
  console.log(`  索引 ${index.length.toLocaleString()} 场 → ${INDEX_PATH}`);
  return index;
}

/** 事件文件的 path（用来查 sha）。 */
const eventsPath = (mid) => `data/events/${mid}.json`;

/**
 * 按"每个赛事-赛季取几场"分层抽样，保证跨联赛/年代覆盖。
 *
 * 为什么不用纯随机：纯随机会被场次最多的赛事（西甲 18 季）淹没。
 * 分层后每个「赛事-赛季」等量取样，**样本的代表性靠设计而非运气**。
 */
export function stratifiedSample(index, limit) {
  const byCS = new Map();
  for (const m of index) {
    const k = `${m.comp}|${m.season}`;
    if (!byCS.has(k)) byCS.set(k, []);
    byCS.get(k).push(m);
  }
  // 优先赛事排前，其余排后；组内按 match_id 稳定排序（**不用随机**，保证可复现）
  const keys = [...byCS.keys()].sort((a, b) => {
    const pa = PREFERRED.includes(a.split('|')[0]) ? 0 : 1;
    const pb = PREFERRED.includes(b.split('|')[0]) ? 0 : 1;
    return pa - pb || a.localeCompare(b);
  });
  for (const k of keys) byCS.get(k).sort((a, b) => String(a.match_id).localeCompare(String(b.match_id)));

  const out = [];
  if (!limit || limit <= 0) {
    for (const k of keys) out.push(...byCS.get(k));
    return out;
  }
  // 轮转取样：第 1 轮每组取第 1 场，第 2 轮取第 2 场……直到够数
  const maxPerGroup = Math.max(...keys.map((k) => byCS.get(k).length));
  for (let r = 0; r < maxPerGroup && out.length < limit; r += 1) {
    for (const k of keys) {
      const g = byCS.get(k);
      if (r < g.length && out.length < limit) out.push(g[r]);
    }
  }
  return out;
}

// ── 下载 ────────────────────────────────────────────────────────────────

export function isCompleteEventFile(path) {
  if (!existsSync(path)) return false;
  try {
    if (statSync(path).size < 1024) return false;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j) && j.length > 0 && j[0].type;
  } catch { return false; }
}

async function fetchAll(ids, shas, { concurrency = 8 } = {}) {
  mkdirSync(EV_DIR, { recursive: true });
  const queue = [...ids];
  const failed = [];
  let done = 0; let skipped = 0;

  const worker = async () => {
    for (;;) {
      const mid = queue.shift();
      if (mid == null) return;
      const out = join(EV_DIR, `${mid}.json`);
      if (isCompleteEventFile(out)) { skipped += 1; continue; }
      const sha = shas.get(eventsPath(mid));
      if (!sha) { failed.push(mid); continue; }
      // 重试 3 次（api.github.com 偶发 5xx / 限流）
      let ok = false; let lastErr = null;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        try {
          const txt = blobText(sha);
          JSON.parse(txt); // 校验是合法 JSON 再落盘
          writeFileSync(out, txt);
          ok = true;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      if (ok) {
        done += 1;
        if (done % 20 === 0) console.log(`  ✔ ${done}/${ids.length}（跳过 ${skipped}）`);
      } else {
        failed.push(mid);
        console.warn(`  ✗ ${mid}: ${String(lastErr && lastErr.message).slice(0, 80)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return { done, skipped, failed };
}

// ── 入口 ────────────────────────────────────────────────────────────────

function reportLocal() {
  const n = existsSync(EV_DIR) ? readdirSync(EV_DIR).filter((f) => f.endsWith('.json')).length : 0;
  const complete = existsSync(EV_DIR)
    ? readdirSync(EV_DIR).filter((f) => isCompleteEventFile(join(EV_DIR, f))).length : 0;
  const bytes = existsSync(EV_DIR)
    ? readdirSync(EV_DIR).reduce((s, f) => s + statSync(join(EV_DIR, f)).size, 0) : 0;
  console.log(`✓ statsbomb → ${DEST}`);
  console.log(`    events/ ${complete}/${n} 场完整（${(bytes / 1e6).toFixed(0)} MB）`);
  console.log(`    索引 ${existsSync(INDEX_PATH) ? '已就位' : '缺失（先跑一次不带 --check）'}`);
  return complete > 0;
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const limit = Number(argOf('--limit', 240));
  const concurrency = Number(argOf('--concurrency', 8));

  console.log('=== StatsBomb Open Data（射门事件，供转化率校准）===');
  console.log('⚠ 许可：StatsBomb Public Data User Agreement —— 非商用、禁再分发原始数据、须署名。');
  console.log('   原始 JSON 只落 .scratch/（gitignored），**不入库**；入库的只有派生聚合量。\n');

  if (args.includes('--check')) { reportLocal(); return; }

  const index = buildIndex();
  const want = stratifiedSample(index, limit);
  console.log(`\n⬇ 目标 ${want.length} 场（分层抽样：每个「赛事-赛季」轮转取，覆盖 ${new Set(want.map((m) => m.comp)).size} 个赛事）`);

  const tree = apiGet('/git/trees/master?recursive=1');
  const shas = new Map(tree.tree.map((x) => [x.path, x.sha]));

  const { done, skipped, failed } = await fetchAll(want.map((m) => m.match_id), shas, { concurrency });

  // ── 写 manifest：**样本可审计** ────────────────────────────────────────
  // 报告里的每个数字都要能回答"用的哪些场"。manifest 记录**实际落在 events/ 的**
  // 全部场（不只本轮下的），含字节数与 sha256 —— 换机器重跑后若样本变了，哈希就变。
  const { createHash } = await import('node:crypto');
  const present = readdirSync(EV_DIR).filter((f) => f.endsWith('.json')).sort();
  const manifest = present.map((f) => {
    const mid = f.replace(/\.json$/, '');
    const buf = readFileSync(join(EV_DIR, f));
    return { match_id: mid, comp: index.find((m) => String(m.match_id) === mid)?.comp ?? '?', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  });
  const sampleHash = createHash('sha256').update(present.join('\n')).digest('hex');
  writeFileSync(join(DEST, 'manifest.json'), JSON.stringify({ generatedBy: 'tools/fetch-statsbomb-shots.mjs', dataset: 'StatsBomb Open Data', license: 'StatsBomb Public Data User Agreement（非商用/禁再分发原始数据/须署名）', matches: manifest.length, sampleHash, files: manifest }, null, 1));
  console.log(`\n✔ ${done} 场下载 + ${skipped} 场已完整 = ${done + skipped}/${want.length}`);
  console.log(`  样本：events/ 共 ${present.length} 场 → manifest.json（sampleHash ${sampleHash.slice(0, 12)}）`);
  if (failed.length) {
    console.warn(`⚠ ${failed.length} 场失败（重跑本脚本即可续传）：${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ' …' : ''}`);
  }
  console.log('\n下一步：node openspec/changes/p38-formation-realism/notes/probes-main/probe-shot-conversion-real.mjs');
  process.exitCode = failed.length ? 0 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
