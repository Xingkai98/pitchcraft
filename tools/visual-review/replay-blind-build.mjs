// 盲测回放基线：**构建 packet**（窗口表 → 渲图 → 盲法排布 → 密钥/评分表/自证/诊断）。
//
// 用法：
//   node tools/visual-review/replay-blind-build.mjs \
//     --config .scratch/notes/replay-blind-baseline-2026-10-23/preregistration.json \
//     --out .scratch/notes/replay-blind-baseline-2026-10-23 \
//     [--reuse-plan] [--plan-only]
//
// 规则（逐条对应预注册，不许在渲图后改）：
//   - 窗口表先写 windows.json + windows.sha256，渲图只读该表；
//   - 真实/引擎同一套阈值、同一渲染器、同一窗口长度/采样率；
//   - 图内无文字/标签；随机 id；按 kind 等长化 PNG 大小；mtime 固定；
//   - packet 的 manifest/评分表不含来源；密钥单独写，不进 packet。
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, utimesSync, existsSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './replay-blind-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = resolve(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OUT = resolve(args.out || join(ROOT, '.scratch/notes/replay-blind-baseline-2026-10-23'));
const CONFIG_PATH = resolve(args.config || join(OUT, 'preregistration.json'));
const PREREG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const PACKET = join(OUT, 'packet');
const ENGINE_WASM = resolve(args.engine || join(OUT, 'engine.wasm'));

const WINDOW_SEC = PREREG.window.sec;
const STEP_SEC = PREREG.window.canonical_step_sec;
const CONTACT_N = PREREG.window.contact_frames;
// 2026-10-28：预注册用 snake_case，core 读 camelCase——此前**没有任何映射**，阈值被
// DEFAULT_PREREG 的同值默认静默覆盖（值相同所以没人发现；本轮新增的 contact_min_team_blobs
// 因此被吞掉，才暴露）。这里显式映射，未列出的键传给 core 后由默认值兜底。
const T0 = PREREG.selection.thresholds || {};
const THRESHOLDS = {
  coverage: T0.coverage,
  allPlayersFrac: T0.all_players_frac,
  rawBallFrac: T0.raw_ball_frac,
  maxBallFillSec: T0.max_ball_fill_sec,
  ballInFieldFrac: T0.ball_in_field_frac,
  minBallPathM: T0.min_ball_path_m,
  minOutfieldMedianPathM: T0.min_outfield_median_path_m,
  maxDuplicateCoordFrac: T0.max_duplicate_coord_frac,
  contactSamplesOk: T0.contact_samples_ok,
  contactRawBall: T0.contact_raw_ball,
  contactBallInField: T0.contact_ball_in_field,
  contactMinTeamBlobs: T0.contact_min_team_blobs,
};
for (const [k, v] of Object.entries(THRESHOLDS)) if (v === undefined) delete THRESHOLDS[k];
const SELECT_OPTS = {
  windowSec: WINDOW_SEC,
  canonicalStepSec: STEP_SEC,
  contactFrames: CONTACT_N,
  usableMarginSec: PREREG.selection.usable_margin_sec,
  searchStepSec: PREREG.selection.search_step_sec,
  maxSearchOffsetSec: PREREG.selection.max_search_offset_sec,
  thresholds: THRESHOLDS,
};
const ID_SALT = PREREG.blinding.item_id_salt;
const ORDER_SALT = PREREG.blinding.order_salt_base;
const CONTROL_SALT = PREREG.blinding.control_order_salt_base;
const FIXED_MTIME = Math.floor(Date.parse(PREREG.render.png.fixed_mtime_utc) / 1000);

const log = (...a) => console.log(...a);
const sha256Text = (s) => C.sha256(s);
const json = (x) => JSON.stringify(x, null, 2);

// ── 源加载（按场/seed 缓存；规划与渲图共用同一份帧）────────────────────
const sources = new Map();
async function realSource(ds) {
  const key = ds.match;
  if (!sources.has(key)) {
    const path = resolve(ROOT, ds.path);
    const loaded = C.loadRealFrames(path, { pitchMeters: ds.pitch_meters });
    sources.set(key, { ...loaded, key, dataset: ds.dataset, match: ds.match, path });
  }
  return sources.get(key);
}
async function engineSource(seed) {
  const key = `seed-${seed}`;
  if (!sources.has(key)) {
    const loaded = await C.loadEngineFrames(ENGINE_WASM, seed, PREREG.engine.duration_sec, { sampleStepSec: STEP_SEC });
    sources.set(key, { ...loaded, key, dataset: 'engine', match: `seed-${seed}`, seed });
  }
  return sources.get(key);
}

function anchorForReal(frames, frac) {
  return C.anchorTime(frames, frac, { usableMarginSec: PREREG.selection.usable_margin_sec, windowSec: WINDOW_SEC });
}
function anchorForEngine(frac) {
  return PREREG.engine.duration_sec * frac;
}

function makeDescriptor({ source, dataset, match, seed, anchorFrac, frames, path, pitchMeters, eventHash }) {
  const anchorT = source === 'engine' ? anchorForEngine(anchorFrac) : anchorForReal(frames, anchorFrac);
  const sel = C.selectWindow(frames, anchorT, SELECT_OPTS);
  return {
    framesKey: source === 'engine' ? `seed-${seed}` : match,
    source,
    dataset,
    match,
    ...(seed != null ? { seed } : {}),
    anchorFrac,
    anchorT: Math.round(anchorT * 1000) / 1000,
    t0: sel.t0,
    t1: sel.t1,
    offsetSec: sel.offsetSec,
    searched: sel.searched,
    fallback: sel.fallback,
    stats: sel.stats,
    contactTimes: sel.contactTimes,
    pitchMeters,
    path,
    ...(eventHash ? { eventHash } : {}),
  };
}

// ── 1) 规划（写盘冻结）──────────────────────────────────────────────────
function buildPlan() {
  const main = [];
  const controlWindows = new Map();
  const coverage = { real: {}, engine: {} };

  for (const g of PREREG.real.metrica) {
    const src = realSourceSync(g);
    coverage.real[src.match] = { frames: src.frames.length, tEnd: src.frames.at(-1).t, path: src.path, pitchMeters: src.pitchMeters };
    for (const frac of PREREG.selection.anchors_main.metrica) {
      main.push(makeDescriptor({ source: 'real', dataset: src.dataset, match: src.match, anchorFrac: frac, frames: src.frames, path: src.path, pitchMeters: src.pitchMeters }));
    }
    for (const frac of PREREG.selection.anchors_control.metrica) {
      const d = makeDescriptor({ source: 'real', dataset: src.dataset, match: src.match, anchorFrac: frac, frames: src.frames, path: src.path, pitchMeters: src.pitchMeters });
      controlWindows.set(`${src.match}@${frac}`, d);
    }
  }

  for (const id of PREREG.real.skillcorner.match_ids) {
    const ds = { dataset: 'skillcorner', match: `skillcorner-${id}`, path: join(PREREG.real.skillcorner.dir, `skillcorner-${id}.json`), pitch_meters: PREREG.real.skillcorner.pitch_meters };
    if (!existsSync(resolve(ROOT, ds.path))) throw new Error(`缺 SkillCorner 转换帧：${ds.path}`);
    const src = realSourceSync(ds);
    coverage.real[src.match] = { frames: src.frames.length, tEnd: src.frames.at(-1).t, path: src.path, pitchMeters: src.pitchMeters };
    for (const frac of PREREG.selection.anchors_main.skillcorner) {
      main.push(makeDescriptor({ source: 'real', dataset: src.dataset, match: src.match, anchorFrac: frac, frames: src.frames, path: src.path, pitchMeters: src.pitchMeters }));
    }
    for (const frac of PREREG.selection.anchors_control.skillcorner) {
      const d = makeDescriptor({ source: 'real', dataset: src.dataset, match: src.match, anchorFrac: frac, frames: src.frames, path: src.path, pitchMeters: src.pitchMeters });
      controlWindows.set(`${src.match}@${frac}`, d);
    }
  }

  // 2026-10-28：seed 顺延规则（预注册）。若某 seed 的 anchor 窗口无法通过选择（fallback=true——
  // 例如全场 21 人：早红牌破坏 all-22 渲染不变量），跳过该 seed 并在 windows.json 留痕；
  // 按 PREREG.engine.seeds 顺序取满 PREREG.engine.target_count 个通过者。
  const rejectedSeeds = [];
  let taken = 0;
  for (const seed of PREREG.engine.seeds) {
    if (taken >= (PREREG.engine.target_count || PREREG.engine.seeds.length)) break;
    const src = engineSourceSync(seed);
    const descs = PREREG.selection.anchors_main.engine.map((frac) => makeDescriptor({ source: 'engine', dataset: 'engine', match: `seed-${seed}`, seed, anchorFrac: frac, frames: src.frames, path: ENGINE_WASM, pitchMeters: src.pitchMeters, eventHash: src.eventHash }));
    if (descs.some((d) => d.fallback)) {
      rejectedSeeds.push({ seed, reason: 'anchor 窗口 fallback（阈值未全过，常见形态：21 人 / 球缺失 / 死球）', stats: descs.map((d) => d.stats) });
      continue;
    }
    coverage.engine[`seed-${seed}`] = { frames: src.frames.length, tEnd: src.frames.at(-1).t, eventHash: src.eventHash, eventLength: src.eventLength };
    for (const d of descs) main.push(d);
    taken += 1;
    for (const frac of PREREG.selection.anchors_control.engine) {
      const d = makeDescriptor({ source: 'engine', dataset: 'engine', match: `seed-${seed}`, seed, anchorFrac: frac, frames: src.frames, path: ENGINE_WASM, pitchMeters: src.pitchMeters, eventHash: src.eventHash });
      controlWindows.set(`seed${seed}@${frac}`, d);
    }
  }

  // 主项 id（随机、不含源）
  for (const [i, d] of main.entries()) {
    const desc = `${d.source}|${d.dataset}|${d.match}|${d.seed ?? ''}|${d.anchorFrac}|${d.t0}`;
    d.id = C.itemId(ID_SALT, `main|${i}|${desc}`);
  }

  // 负控 pair
  const pairs = PREREG.items.control_composition.map((c, i) => {
    const a = controlWindows.get(c.a); const b = controlWindows.get(c.b);
    if (!a || !b) throw new Error(`负控窗口缺失：${c.a} / ${c.b}`);
    const id = `ctl-${sha256Text(`${ID_SALT}|control|${i}|${c.type}|${c.a}|${c.b}`).slice(0, 10)}`;
    return { id, type: c.type, aItem: a, bItem: b, composition: `${c.a} vs ${c.b}` };
  });

  const usedControlKeys = new Set(PREREG.items.control_composition.flatMap((c) => [c.a, c.b]));
  return {
    version: PREREG.version,
    frozen_at: PREREG.frozen_at,
    window: PREREG.window,
    selection: PREREG.selection,
    engine: { wasm: relative(ROOT, ENGINE_WASM), commit: PREREG.engine_commit, seeds: PREREG.engine.seeds, duration_sec: PREREG.engine.duration_sec, config: PREREG.engine.config },
    sources: coverage,
    items: main,
    controls: pairs,
    rejected_engine_seeds: rejectedSeeds,
    control_windows: [...controlWindows.entries()].map(([k, d]) => ({ key: k, ...d })),
    unused_control_windows: [...controlWindows.keys()].filter((k) => !usedControlKeys.has(k)),
  };
}

// 同步包装：规划阶段需要“先加载再选窗”。ESM 顶层 await 可用，但保持函数简单。
function realSourceSync(ds) {
  const key = ds.match;
  if (!sources.has(key)) {
    const path = resolve(ROOT, ds.path);
    const loaded = C.loadRealFrames(path, { pitchMeters: ds.pitch_meters });
    sources.set(key, { ...loaded, key, dataset: ds.dataset, match: ds.match, path });
  }
  return sources.get(key);
}
function engineSourceSync(seed) {
  const key = `seed-${seed}`;
  if (!sources.has(key)) throw new Error(`engine seed ${seed} 未预加载`);
  return sources.get(key);
}

async function preloadEngine() {
  for (const seed of PREREG.engine.seeds) {
    if (sources.has(`seed-${seed}`)) continue;
    const loaded = await C.loadEngineFrames(ENGINE_WASM, seed, PREREG.engine.duration_sec, { sampleStepSec: STEP_SEC });
    sources.set(`seed-${seed}`, { ...loaded, key: `seed-${seed}`, dataset: 'engine', match: `seed-${seed}`, seed });
  }
}

// --reuse-plan 时也要有帧源：从冻结的 plan 描述里恢复（不重新选窗）。
function preloadFromPlan(plan) {
  const seen = new Set();
  const load = (d) => {
    if (!d || !d.framesKey || seen.has(d.framesKey)) return;
    seen.add(d.framesKey);
    if (d.source === 'engine') return; // engine 已预加载
    realSourceSync({ dataset: d.dataset, match: d.match, path: d.path, pitch_meters: d.pitchMeters });
  };
  for (const it of plan.items) load(it);
  for (const p of plan.controls) { load(p.A || p.aItem); load(p.B || p.bItem); }
  for (const w of plan.control_windows || []) load(w);
}

// ── 2) 渲图 + 自证 ──────────────────────────────────────────────────────
function framesFor(desc) {
  const src = sources.get(desc.framesKey);
  if (!src) throw new Error(`源未加载：${desc.framesKey}`);
  return src;
}

function renderDescriptor(desc) {
  const src = framesFor(desc);
  const contact = desc.contactTimes.map((t) => {
    const hit = C.nearestFrame(src.frames, t, 0.3);
    if (!hit) throw new Error(`窗口 ${desc.id} contact t=${t} 取不到帧`);
    return hit.frame;
  });
  const samples = C.canonicalWindow(src.frames, desc.t0, { windowSec: WINDOW_SEC, canonicalStepSec: STEP_SEC });
  const contactImg = C.buildContactImage(contact);
  const trajImg = C.buildTrajectoryImage(samples);
  const contactCheck = C.verifyContactImage(contactImg.canvas, contactImg);
  const trajCheck = C.verifyTrajectoryImage(trajImg.canvas, trajImg);
  return {
    contactBuf: C.canvasToPngBuffer(contactImg.canvas),
    trajBuf: C.canvasToPngBuffer(trajImg.canvas),
    contactCheck: { ...contactCheck, id: desc.id },
    trajCheck: { ...trajCheck, id: desc.id },
    contactW: contactImg.W, contactH: contactImg.H,
    trajW: trajImg.W, trajH: trajImg.H,
    renderParams: contactImg.params,
  };
}

// 等长化：同 kind 全部补到 max+4096；私有 ancillary chunk 全零。
function padAll(buffers, kind) {
  const max = Math.max(...buffers.map((b) => b.buf.length));
  const target = max + 4096;
  for (const b of buffers) b.final = C.padPngToSize(b.buf, target);
  return { kind, count: buffers.length, target };
}

function writePacketFile(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

function setMtimeRecursive(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) setMtimeRecursive(p);
    else utimesSync(p, FIXED_MTIME, FIXED_MTIME);
  }
}

// ── 3) 指标（只作诊断）──────────────────────────────────────────────────
async function metricsFor(desc) {
  const src = framesFor(desc);
  const mm = await import('../../viewer/match-metrics.js');
  const motion = await import('./motion-metrics.mjs');
  const c2 = await import('./c2-shadow-target.mjs');
  const samples = C.canonicalWindow(src.frames, desc.t0, { windowSec: WINDOW_SEC, canonicalStepSec: STEP_SEC })
    .map((s) => s.frame).filter(Boolean);
  const wm = mm.windowMetrics(samples, { pitchMeters: src.pitchMeters }).primary;
  const ws = motion.windowStats(samples, WINDOW_SEC);
  const cm = c2.commonModeFromFrames(samples);
  let playerPts = 0; let extPts = 0;
  for (const f of samples) for (const p of f.players) { playerPts += 1; if (p.extrapolated) extPts += 1; }
  return {
    shape: wm,
    motion: {
      disp: C.median(ws.disp), dir: C.median(ws.dir), still: C.median(ws.still),
      lat: C.median(ws.lat), mix: C.median(ws.mix),
    },
    common: cm,
    extrapolatedFrac: playerPts ? extPts / playerPts : null,
  };
}

// 非人类裁判的“像素统计审计”：文件大小已等长化；这里看**内容特征**能否被一个
// 简单阈值分出源。高 AUC 是内容信号（轨迹长度/密度），不是元数据泄漏——但它提示
// “只看轨迹图就可能很容易”，判读时必须结合 contact 与自由文本线索。
function leakAudit(imageChecks, items) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const rows = [];
  for (const chk of imageChecks) {
    if (!byId.has(chk.id)) continue;
    const it = byId.get(chk.id);
    if (chk.kind === 'contact') {
      rows.push({
        kind: 'contact', source: it.source,
        redPixels: chk.panels.reduce((a, p) => a + p.redPixels, 0),
        bluePixels: chk.panels.reduce((a, p) => a + p.bluePixels, 0),
        redComponents: chk.panels.reduce((a, p) => a + p.redComponents, 0),
        blueComponents: chk.panels.reduce((a, p) => a + p.blueComponents, 0),
      });
    } else {
      rows.push({
        kind: 'trajectory', source: it.source,
        yellowPixels: chk.yellowPixels, redPixels: chk.redPixels, bluePixels: chk.bluePixels,
        totalColored: chk.yellowPixels + chk.redPixels + chk.bluePixels,
      });
    }
  }
  const out = {};
  for (const kind of ['contact', 'trajectory']) {
    const rr = rows.filter((r) => r.kind === kind);
    out[kind] = {};
    for (const f of ['redPixels', 'bluePixels', 'redComponents', 'blueComponents', 'yellowPixels', 'totalColored']) {
      const real = rr.filter((r) => r.source === 'real').map((r) => r[f]).filter((v) => v != null);
      const eng = rr.filter((r) => r.source === 'engine').map((r) => r[f]).filter((v) => v != null);
      if (!real.length || !eng.length) continue;
      out[kind][f] = { realMean: C.mean(real), engineMean: C.mean(eng), aucRealHigher: C.auc(real, eng) };
    }
  }
  return {
    caveat: '简单像素统计的判别上界；高 AUC 是内容信号（尤其轨迹长度），不是文件大小/元数据泄漏（已按 kind 等长化）。',
    features: out,
  };
}

const METRIC_KEYS = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist', 'disp', 'lat', 'mix', 'commonX', 'commonY'];
function metricValue(m, k) {
  if (!m) return null; // 窗口 primary 全空（如 SkillCorner 外推点过多）→ 诊断行记 null，不让聚合崩溃
  if (['disp', 'dir', 'still', 'lat', 'mix'].includes(k)) return m.motion ? m.motion[k] : null;
  if (k === 'commonX') return m.common?.x;
  if (k === 'commonY') return m.common?.y;
  return m.shape ? m.shape[k] : null;
}
function aggregate(rows) {
  const out = {};
  for (const k of METRIC_KEYS) {
    const vals = rows.map((r) => metricValue(r.metrics, k)).filter((v) => v != null && Number.isFinite(v));
    out[k] = vals.length ? { n: vals.length, mean: C.mean(vals), median: C.median(vals), min: Math.min(...vals), max: Math.max(...vals) } : null;
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  log(`[prereg] ${CONFIG_PATH}`);
  log(`[engine] ${ENGINE_WASM}`);
  await preloadEngine();

  let plan;
  const planPath = join(OUT, 'windows.json');
  const planHashPath = join(OUT, 'windows.sha256');
  if (args['reuse-plan']) {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const expect = readFileSync(planHashPath, 'utf8').trim().split(/\s+/)[0];
    const got = sha256Text(json(plan));
    if (got !== expect) throw new Error(`windows.json 哈希不符：${got} != ${expect}`);
    preloadFromPlan(plan);
    log(`[plan] reuse ${plan.items.length} items / ${plan.controls.length} controls`);
  } else {
    plan = buildPlan();
    writeFileSync(planPath, json(plan));
    const hash = sha256Text(json(plan));
    writeFileSync(planHashPath, `${hash}  windows.json\n`);
    log(`[plan] ${plan.items.length} items / ${plan.controls.length} controls → ${planPath} (${hash.slice(0, 12)})`);
  }

  if (args['plan-only']) {
    log('[plan-only] done');
    return;
  }

  // 清空 packet（只清本工具的 packet；不碰其它目录）
  if (existsSync(PACKET)) rmSync(PACKET, { recursive: true, force: true });
  mkdirSync(PACKET, { recursive: true });

  // 排布主项
  const order = C.orderWithCheck(plan.items, ORDER_SALT, C.mainOrderCheck);
  log(`[blind] order salt k=${order.k} firstHalfReal=${order.check.realInFirstHalf} maxRun=${order.check.maxRun}`);

  // 负控排布
  const ctlOrder = C.orderControls(plan.controls, CONTROL_SALT);
  log(`[blind] control salt k=${ctlOrder.k} aReal=${ctlOrder.check.aReal}`);

  // 渲主项
  const contactBufs = []; const trajBufs = [];
  const imageChecks = [];
  const itemRender = new Map();
  for (const [i, item] of order.items.entries()) {
    if (i % 6 === 0) log(`[render] ${i + 1}/${order.items.length}`);
    const r = renderDescriptor(item);
    itemRender.set(item.id, r);
    contactBufs.push({ id: item.id, buf: r.contactBuf, kind: 'item' });
    trajBufs.push({ id: item.id, buf: r.trajBuf, kind: 'item' });
    imageChecks.push({ kind: 'contact', ...r.contactCheck }, { kind: 'trajectory', ...r.trajCheck });
  }

  // 渲负控（每个 pair 的 A/B 两侧）
  const controlRender = new Map();
  for (const [i, p] of ctlOrder.pairs.entries()) {
    if (i % 3 === 0) log(`[render] control ${i + 1}/${ctlOrder.pairs.length}`);
    const A = renderDescriptor(p.A);
    const B = renderDescriptor(p.B);
    controlRender.set(p.id, { A, B });
    for (const [side, r] of [['a', A], ['b', B]]) {
      contactBufs.push({ id: `${p.id}-${side}`, buf: r.contactBuf, kind: 'control' });
      trajBufs.push({ id: `${p.id}-${side}`, buf: r.trajBuf, kind: 'control' });
      imageChecks.push({ kind: 'contact', ...r.contactCheck, pair: p.id, side }, { kind: 'trajectory', ...r.trajCheck, pair: p.id, side });
    }
  }

  const contactPad = padAll(contactBufs, 'contact');
  const trajPad = padAll(trajBufs, 'trajectory');
  log(`[png] contact target=${contactPad.target}B ×${contactPad.count}; trajectory target=${trajPad.target}B ×${trajPad.count}`);

  // 写图 + 收集元数据
  const manifestItems = [];
  for (const item of order.items) {
    const r = itemRender.get(item.id);
    const dir = join(PACKET, 'items', item.id);
    const cPath = join(dir, 'contact.png');
    const tPath = join(dir, 'trajectory.png');
    const cBuf = contactBufs.find((b) => b.id === item.id).final;
    const tBuf = trajBufs.find((b) => b.id === item.id).final;
    writePacketFile(cPath, cBuf);
    writePacketFile(tPath, tBuf);
    manifestItems.push({
      id: item.id,
      order: manifestItems.length + 1,
      files: { contact: relative(PACKET, cPath), trajectory: relative(PACKET, tPath) },
      contact: { w: r.contactW, h: r.contactH, bytes: cBuf.length, sha256: sha256Text(cBuf) },
      trajectory: { w: r.trajW, h: r.trajH, bytes: tBuf.length, sha256: sha256Text(tBuf) },
    });
  }
  const manifestControls = [];
  for (const p of ctlOrder.pairs) {
    const r = controlRender.get(p.id);
    const dir = join(PACKET, 'controls', p.id);
    const files = {};
    for (const side of ['a', 'b']) {
      const cPath = join(dir, `${side}-contact.png`);
      const tPath = join(dir, `${side}-trajectory.png`);
      const cBuf = contactBufs.find((b) => b.id === `${p.id}-${side}`).final;
      const tBuf = trajBufs.find((b) => b.id === `${p.id}-${side}`).final;
      writePacketFile(cPath, cBuf);
      writePacketFile(tPath, tBuf);
      files[side] = { contact: relative(PACKET, cPath), trajectory: relative(PACKET, tPath) };
    }
    manifestControls.push({ id: p.id, order: manifestControls.length + 1, files });
  }

  // PNG 自证（块类型/禁用块/大小/无文字）
  const pngChecks = [];
  for (const b of contactBufs) {
    const final = b.final;
    pngChecks.push({ id: b.id, kind: 'contact', bytes: final.length, chunks: C.pngChunks(final).map((c) => c.type), forbiddenChunks: C.forbiddenPngChunks(final) });
  }
  for (const b of trajBufs) {
    const final = b.final;
    pngChecks.push({ id: b.id, kind: 'trajectory', bytes: final.length, chunks: C.pngChunks(final).map((c) => c.type), forbiddenChunks: C.forbiddenPngChunks(final) });
  }

  // manifest / 评分表 / 协议（不含来源）
  const manifest = {
    version: PREREG.version,
    window_sec: WINDOW_SEC,
    contact_frames: CONTACT_N,
    item_count: manifestItems.length,
    control_pair_count: manifestControls.length,
    order: order.items.map((x) => x.id),
    items: manifestItems,
    controls: manifestControls,
    note: '每条含 24s 窗口的 8 帧 contact sheet 与 24s 球员/球轨迹图；文件名随机、图内无标签。',
  };
  writeFileSync(join(PACKET, 'manifest.json'), json(manifest));

  const scoreSheet = {
    version: PREREG.version,
    judge_id: null,
    judged_at: null,
    instructions: '对每个 item 独立回答 A/B；不要根据文件名或元数据推断。controls 回答同源/不同源；mixed 另答哪侧更像真实。',
    items: order.items.map((it, i) => ({ order: i + 1, id: it.id, A_guess: null, A_confidence: null, B_score: null, cues: null })),
    controls: ctlOrder.pairs.map((p, i) => ({ order: i + 1, id: p.id, same_source: null, confidence: null, more_real: null, notes: null })),
  };
  writeFileSync(join(PACKET, 'score-sheet.json'), json(scoreSheet));
  // 三个评判位的空白模板（同一结构；judge_id 预填，避免路由时混淆）。
  for (const id of ['user', 'model-1', 'model-2']) {
    writeFileSync(join(PACKET, `score-sheet-${id}.json`), json({ ...scoreSheet, judge_id: id }));
  }

  const protocol = `# Blind replay judging protocol

你有两件事要判断：**这是真实比赛 tracking 的 2D 回放，还是游戏引擎生成的？**
以及**它有多像真实比赛的 2D 回放？**

## 材料

- \`items/<id>/contact.png\`：24 s 窗口内的 8 帧（同一场/同一段），无标签。
- \`items/<id>/trajectory.png\`：同一 24 s 的 22 名球员轨迹 + 球轨迹（黄）。
- 所有图由同一渲染器生成；文件名是随机的，图内没有时间/来源/编号文字。
- 请只依据画面内容判断，不要依据文件名、文件大小、目录顺序或图片元数据。

## 主项（${manifestItems.length} 项）

对每一项回答：

- **A**：\`real\` 或 \`engine\`。
- **A_confidence**：1–5（1=猜的，5=非常确定）。
- **B_score**：1–5，这段 24 s 的 2D 回放有多像真实比赛（1=完全不像/机械，5=非常像真实回放）。
- **cues**（可选）：写下暴露线索，例如：水平车道、整队同步、间距、球与人关系、静止段、折返、队形、其他。

每一项独立判断；有些项可能与其它项来自同一来源，但不要跨项合并答案。

## 负控（${manifestControls.length} 对）

对 \`controls/<id>/\` 下的 A/B 两侧（各有 contact 与 trajectory）：

- **same_source**：\`same\` 或 \`different\`。\`same\` = 两侧都是真实，或两侧都是引擎；\`different\` = 一侧真实、一侧引擎。
- **confidence**：1–5。
- **more_real**：若判 different，写 \`A\` 或 \`B\`（哪侧更像真实）；否则留空。
- **notes**（可选）。

## 交付

把答案填进 \`score-sheet.json\`（保持 id 不变），或按同样结构另存为 \`judge-<name>.json\`。不要修改图片。
`;
  writeFileSync(join(PACKET, 'README.md'), protocol);

  // 盲密钥（**不在 packet 内**）
  const keyItems = order.items.map((it, i) => {
    const r = itemRender.get(it.id);
    const src = sources.get(it.framesKey);
    const sampleFrames = C.canonicalWindow(src.frames, it.t0, { windowSec: WINDOW_SEC, canonicalStepSec: STEP_SEC })
      .map((s) => s.frame).filter(Boolean);
    let playerPts = 0; let extPts = 0;
    for (const f of sampleFrames) for (const p of f.players) { playerPts += 1; if (p.extrapolated) extPts += 1; }
    return {
      id: it.id,
      order: i + 1,
      source: it.source,
      dataset: it.dataset,
      match: it.match,
      ...(it.seed != null ? { seed: it.seed } : {}),
      anchorFrac: it.anchorFrac,
      anchorT: it.anchorT,
      t0: it.t0,
      t1: it.t1,
      offsetSec: it.offsetSec,
      searched: it.searched,
      fallback: it.fallback,
      stats: it.stats,
      contactTimes: it.contactTimes,
      pitchMeters: it.pitchMeters,
      path: it.source === 'engine' ? ENGINE_WASM : it.path,
      ...(it.source === 'engine' && src?.eventHash ? { eventHash: src.eventHash } : (it.eventHash ? { eventHash: it.eventHash } : {})),
      extrapolatedFrac: playerPts ? extPts / playerPts : null,
      renderParamsHash: C.RENDER_PARAMS_HASH,
      imageFiles: { contact: `items/${it.id}/contact.png`, trajectory: `items/${it.id}/trajectory.png` },
    };
  });
  const keyControls = ctlOrder.pairs.map((p, i) => ({
    id: p.id,
    order: i + 1,
    type: p.type,
    composition: p.composition,
    A: { source: p.A.source, dataset: p.A.dataset, match: p.A.match, seed: p.A.seed ?? null, t0: p.A.t0, t1: p.A.t1, anchorFrac: p.A.anchorFrac, fallback: p.A.fallback },
    B: { source: p.B.source, dataset: p.B.dataset, match: p.B.match, seed: p.B.seed ?? null, t0: p.B.t0, t1: p.B.t1, anchorFrac: p.B.anchorFrac, fallback: p.B.fallback },
  }));
  const key = {
    version: PREREG.version,
    generated_at: PREREG.frozen_at,
    preregistration_sha256: sha256Text(readFileSync(CONFIG_PATH)),
    windows_sha256: sha256Text(json(plan)),
    engine: {
      commit: PREREG.engine_commit,
      wasm_sha256: sha256Text(readFileSync(ENGINE_WASM)),
      lib_rs_sha256: sha256Text(readFileSync(join(ROOT, 'engine/src/lib.rs'))),
      cargo_lock_sha256: sha256Text(readFileSync(join(ROOT, 'engine/Cargo.lock'))),
      build_command: '(cd engine && cargo build --target wasm32-unknown-unknown --release)',
      config: PREREG.engine.config,
      eventHashes: PREREG.engine.seeds.map((seed) => ({ seed, ...(sources.get(`seed-${seed}`)?.eventHash ? { hash: sources.get(`seed-${seed}`).eventHash, length: sources.get(`seed-${seed}`).eventLength } : {}) })),
    },
    render: { params_hash: C.RENDER_PARAMS_HASH, params: C.RENDER_PARAMS, renderer_files: ['tools/visual-review/render.mjs', 'viewer/soft-canvas.js', 'tools/visual-review/replay-blind-core.mjs'] },
    blinding: {
      item_id_salt: ID_SALT,
      order_salt: order.salt,
      order_k: order.k,
      order_check: order.check,
      control_salt: ctlOrder.salt,
      control_k: ctlOrder.k,
      control_check: ctlOrder.check,
    },
    sources: plan.sources,
    items: keyItems,
    controls: keyControls,
    control_windows: (plan.control_windows || []).map((w) => ({
      ...w,
      ...(w.source === 'engine' && sources.get(w.framesKey)?.eventHash
        ? { eventHash: sources.get(w.framesKey).eventHash } : {}),
    })),
    unused_control_windows: plan.unused_control_windows,
  };
  writeFileSync(join(OUT, 'blind-key.json'), json(key));

  // 渲染自证
  const calibration = C.verifyCalibration();
  const allImagePass = imageChecks.every((c) => c.pass);
  const allPngPass = pngChecks.every((c) => c.forbiddenChunks.length === 0);
  const contactSizes = [...new Set(contactBufs.map((b) => b.final.length))];
  const trajSizes = [...new Set(trajBufs.map((b) => b.final.length))];
  const selfcheck = {
    version: PREREG.version,
    calibration,
    images: imageChecks,
    png: pngChecks,
    summary: {
      images: imageChecks.length,
      allImagePass,
      allPngPass,
      contactSizeSet: contactSizes,
      trajectorySizeSet: trajSizes,
      sameRendererParams: new Set([...itemRender.values()].map((r) => C.sha256(JSON.stringify(r.renderParams)))).size === 1,
      renderParamsHash: C.RENDER_PARAMS_HASH,
      contactPanelsWithBall: imageChecks.filter((c) => c.kind === 'contact' && c.pass).length,
      trajectoryPanelsWithBallAndPlayers: imageChecks.filter((c) => c.kind === 'trajectory' && c.pass).length,
    },
  };
  writeFileSync(join(OUT, 'render-selfcheck.json'), json(selfcheck));

  // 指标诊断
  log('[metrics] 计算同批窗口指标...');
  const diagRows = [];
  for (const it of order.items) {
    const metrics = await metricsFor(it);
    diagRows.push({ id: it.id, source: it.source, dataset: it.dataset, match: it.match, ...(it.seed != null ? { seed: it.seed } : {}), t0: it.t0, metrics });
  }
  const realRows = diagRows.filter((r) => r.source === 'real');
  const engRows = diagRows.filter((r) => r.source === 'engine');
  const aggReal = aggregate(realRows);
  const aggEng = aggregate(engRows);
  const magnitude = ['hd', 'ad', 'spread', 'gap', 'ballDist', 'disp'];
  const bounded = ['lat', 'mix', 'commonX', 'commonY'];
  const distance = magnitude.map((k) => {
    const e = aggEng[k]?.mean; const r = aggReal[k]?.mean;
    const ok = e != null && r != null && e > 0 && r > 0;
    return { key: k, engine: e, real: r, logRatio: ok ? Math.log(e / r) : null, absLog: ok ? Math.abs(Math.log(e / r)) : null };
  });
  const boundedDiff = bounded.map((k) => ({ key: k, engine: aggEng[k]?.mean ?? null, real: aggReal[k]?.mean ?? null, diff: (aggEng[k]?.mean != null && aggReal[k]?.mean != null) ? aggEng[k].mean - aggReal[k].mean : null }));
  const diagnostics = {
    version: PREREG.version,
    caveat: '指标只作诊断，不作验收。24s 窗口口径与 committed 300s 基线不同；指标全绿 ≠ 回放感。',
    perItem: diagRows,
    aggregates: {
      real: aggReal,
      engine: aggEng,
      realByDataset: {
        metrica: aggregate(realRows.filter((r) => r.dataset === 'metrica')),
        skillcorner: aggregate(realRows.filter((r) => r.dataset === 'skillcorner')),
      },
      engineBySeed: Object.fromEntries(PREREG.engine.seeds.map((s) => [`seed-${s}`, aggregate(engRows.filter((r) => r.seed === s))])),
    },
    matchedDistance24s: {
      magnitude: distance,
      meanAbsLog: distance.filter((d) => d.absLog != null).length ? C.mean(distance.filter((d) => d.absLog != null).map((d) => d.absLog)) : null,
      boundedDiff,
      widthReportOnly: aggEng.width && aggReal.width ? { engine: aggEng.width.mean, real: aggReal.width.mean } : null,
    },
    leakAudit: leakAudit(imageChecks, order.items),
  };
  writeFileSync(join(OUT, 'diagnostics.json'), json(diagnostics));

  // packet 泄漏检查（只查 manifest / score sheet / 文件名；答案选项除外）
  const forbidden = /\b(metrica|skillcorner|seed|real-game|engine\.wasm|1874553|1927964|1996435|2007448|2013725|2017461|401|403|42)\b/i;
  const packetStrings = [
    JSON.stringify(manifest),
    JSON.stringify(order.items.map((x) => x.id)),
    JSON.stringify(manifestControls.map((x) => x.id)),
  ];
  const leaks = packetStrings.map((s) => s.match(forbidden)?.[0]).filter(Boolean);

  // mtime 固定
  setMtimeRecursive(PACKET);

  log('\n=== DONE ===');
  log(`packet: ${PACKET}`);
  log(`key:    ${join(OUT, 'blind-key.json')}`);
  log(`items:  ${manifestItems.length} (real ${plan.items.filter((x) => x.source === 'real').length} / engine ${plan.items.filter((x) => x.source === 'engine').length})`);
  log(`controls: ${manifestControls.length} pairs`);
  log(`selfcheck: allImagePass=${allImagePass} allPngPass=${allPngPass} calibration=${calibration.pass}`);
  log(`leaks: ${leaks.length ? leaks.join(',') : 'none'}`);
  log(`matched 24s mean|ln|: ${diagnostics.matchedDistance24s.meanAbsLog?.toFixed(3) ?? 'n/a'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
