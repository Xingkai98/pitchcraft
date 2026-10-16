// 双盲判别测试：刺激集生成器（可复跑，取样规则**全部写死**在本文件里）。
//
// 目的：产 48 张图（批1/2 = 原版；批3/4 = 配对「清理版」），交零上下文裁判回答
// 「哪些是真实比赛」。生成者（本脚本）**不当裁判**，也不预测裁判结果。
//
// 四批的构造（**逐位配对**：批 3 = 批 1 的清理版，批 4 = 批 2 的清理版）：
//   批 1 静止帧（原版）   12 张 = 6 真实 + 6 引擎
//   批 2 12s 接触表（原版）12 张 = 6 真实 + 6 引擎
//   批 3 静止帧（清理版） 12 张 —— 与批 1 同窗口/同 seed，只多一步「丢越界点」
//   批 4 12s 接触表（清理版）12 张 —— 与批 2 同窗口/同 seed
//
// 清理规则（批 3/4 生效，见 CLEAN_RULE）：渲染前把**坐标超出 [0,1]² 的球员点与球点丢弃**。
// **不夹到边界**——夹紧会造出「贴边」的假结构（把越界伪影变成一条贴在边线上的直线队形）。
// **不整帧丢弃**——优先保住同帧的其它 21 人（丢整帧会把「有缺陷」变成「少一整张」，
// 是另一种更醒目的线索）。
// 引擎侧本来就没有越界点 ⇒ 清理是空操作 ⇒ **批 3/4 的引擎图与批 1/2 的对应图逐字节相同**
// （脚本内断言，见 assertEngineByteIdentical）。于是**两套之间唯一的差别 = 真实侧的越界点**。
//
// 三条不许动的纪律（改了就不是预注册实验了）：
//   1. **取样时刻写死**（见下方 PRE-REGISTERED 常量），不许按「这张看起来不像/太像」重挑。
//   2. **渲染必须复用现成路径**：tools/visual-review/render.mjs 的 drawPanel / ballXY，
//      真实与引擎同函数、同尺寸、同球场口径（都是归一化 [0,1] 坐标 → 同一 toPx）。
//   3. **图上零文字**：drawPanel 的 label 一律传空串。
//
// 用法：
//   node .scratch/notes/p-discrimination-2026-10-15/gen-stimuli.mjs
// 产出：
//   /tmp/discrim/stimuli/stim-<字母>.png   48 张（**该目录只有 png**）
//   /tmp/discrim/KEY.json                  答案键（stim → {source, match, t0, seed, batch, cleaned, ...}）
//   /tmp/discrim/audit.json                非结构线索逐面板审计（同样**不在 stimuli/ 内**）
// 日志：stdout（进度）+ /tmp/discrim/gen.log（自检结果）

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────
// PRE-REGISTERED：以下常量在生成任何一张图之前定死，生成过程不得据结果修改。
// ─────────────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_DIR = '/tmp/discrim';
const STIM_DIR = join(OUT_DIR, 'stimuli');

// 真实侧（就这 2 场；SkillCorner 20 场要下 1.8 GB，本轮不下）
const REAL_GAMES = [
  { key: 'game1', file: 'viewer/data/real-game-1.json', label: 'metrica-Sample_Game_1' },
  { key: 'game2', file: 'viewer/data/real-game-2.json', label: 'metrica-Sample_Game_2' },
];

// 真实窗口时刻（秒）：每场 3 个 → 每次 6 张。
const REAL_WINDOW_T0S = [600, 1800, 3600];

// 引擎种子（预注册 6 个，含标尺冻结集 BENCHMARK_SEEDS=[42,1,7,99,123] + 追加 2）
const ENGINE_SEEDS = [42, 1, 7, 99, 123, 2];

// 取样时刻（秒）
const ENGINE_BATCH1_T = 1800;              // 批1/3：引擎静止帧时刻
const ENGINE_BATCH2_T0 = 3600;             // 批2/4：引擎接触表窗起点
const REAL_BATCH2_OFFSET = 600;            // 批2/4：真实 = 「同样的窗，换一个时刻」→ t0 + 600

// 接触表口径（与 render.mjs 的 12s/6 帧一致）
const CONTACT_WIN_SEC = 12;
const CONTACT_N = 6;

// 面板几何：直接取 render.mjs 的 LAYOUT（PW/PH），逐面板渲染与现成工具逐像素同口径。
const PW = 380, PH = 250, G = 10;

// 清理规则（只对批 3/4 生效）
const CLEAN_RULE = {
  // 丢坐标落在 [0,1]² 之外的球员点与球点（**不夹到边界**）
  dropOutOfRange: true,
  // 丢「同帧两人坐标完全相同」的追踪伪影。
  // ⚠️ **默认关，本轮不动它**，因为：① 规格把清理规则限定为「越界点」；② 开了就破坏
  // 「两套之间唯一差别 = 真实侧越界点」这条不变量（两套就会同时差在越界点与重合点上）。
  // 实测：本轮 2 处重合**都不涉及越界球员**（见 DESIGN §6.3），故按规格清理后它们仍然存在。
  // 主 session 若要把「重合点」也清掉，把这里改 true 再跑即可（脚本可复跑）。
  dropExactDuplicates: false,
};

// ─────────────────────────────────────────────────────────────────────────
// SET-CLEAN（干净版 24 张）的预注册常量。只被 `node gen-stimuli.mjs clean` 使用。
//
// 背景：上一版 48 张其实只有 24 个独立场面（配对版只在 5 张真实图上不同），且真实侧仍有三类
// 可见瑕疵（越界点 / 整图无球 / 重复坐标），还混进了死球窗。SET-CLEAN 逐条处理这三件事。
const CLEAN_OUT_DIR = '/tmp/discrim-clean';
const CLEAN_STIM_DIR = join(CLEAN_OUT_DIR, 'stimuli');

// 修复用的微小平移量（归一化单位）。0.008 ≈ x 方向 0.84 m、y 方向 0.54 m——
// 与真实 tracking 的抖动同量级，**小于点直径**（点半径 5 px / 面板宽 380 px = 0.0132）。
// ⚠️ 它不足以让两个点**视觉上完全分开**（见 audit-clean.json 的 visuallyMergedPairs），
// 故「看起来少一个人」这条线索是**减弱**而非保证消除——如实记录，不当作已解决。
const MICRO_OFFSET = 0.008;
const DOT_RADIUS_PX = 5; // 与 drawPanel 里 arc(px, py, 5, ...) 一致

// 真实侧候选窗阶梯（预注册，写死）：前三个 = 上一版的原预注册时刻，其后按 600s 步长补齐
// （跳过已列者）。两场比赛都从这条阶梯的**头部**往下走，取各自前 3 个通过的窗。
const CANDIDATE_BASE = [600, 1800, 3600, 1200, 2400, 3000, 4200, 4800, 5400];
// 接触表窗起点 = 阶梯值 + 300（⇒ still 时刻恒 ≡0 (mod 600)、sheet 起点恒 ≡300 (mod 600)，
// 两者相差 ≥300 s，**静帧永远不会落进接触表窗内**，两批天然不共享帧）。
const SHEET_START_OFFSET = 300;

// 死球过滤阈值（预注册）
const STILL_BALL_LOOKBACK_SEC = 2;
const STILL_MIN_BALL_DISP_M = 2;
const SHEET_MIN_BALL_DISP_M = 15;

// 真实侧球场尺寸（米）：Metrica meta 无 pitchMeters，用 match-metrics 的缺省口径 105×68。
// 仅用于**过滤阈值**的米制换算；渲染本身只用归一化坐标。
const METERS_PER_X = 105;
const METERS_PER_Y = 68;

// 命名：新码必须与上一版那 48 个码**不重复**。上一版码由 (旧种子, 旧池) 确定性生成，
// 这里重算出来当排除表——不读旧 KEY.json，脚本自洽、可复跑。
const OLD_SHUFFLE_SEED = 20261015;
const OLD_CODE_COUNT = 48;
const NEW_SHUFFLE_SEED = 20261016;
const NEW_CODE_COUNT = 24;

// 呈现顺序：洗牌种子**写死为一条规则**——从 1 开始逐个试，取第一个满足独立性检验的种子。
// 检验（预注册）：该顺序**前 12 个**里 真实张数 ∈ [4,8] **且** 静止帧张数 ∈ [4,8]。
const PRESENTATION_SEED_START = 1;
const PRESENTATION_HALF = 12;
const PRESENTATION_MIN = 4;
const PRESENTATION_MAX = 8;

// ─────────────────────────────────────────────────────────────────────────

// 命名打乱：确定性 Fisher–Yates（mulberry32）。**48 张放进同一次洗牌、同一个码池**——
// 若给批 3/4 换一套「看起来不同」的名字（小写 / 后缀 / 另一种形状），清理版就会在命名上
// 与原版成对可辨，等于泄题。故 48 个名字来自一个池、一次洗牌、**形状完全一致**。
//
// 池 = 双字母码 A–Z × A–Z（676 个）里洗出 48 个。为什么不用单字符 `A–Z + a–z`：
// 那样要保证「同名异 case 不同时出现」才能免于在大小写不敏感的文件系统上撞名，
// 而 52 个字符里最多只能挑出 **26** 个（每个字母只能取一种大小写），凑不满 48。
// 双字母码同时满足三件事：48 个互不相同、形状统一、无大小写歧义。
const SHUFFLE_SEED = 20261015;

// ─────────────────────────────────────────────────────────────────────────

const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { drawPanel, ballXY } = await import(join(ROOT, 'tools/visual-review/render.mjs'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const logLines = [];
function log(msg) { console.log(msg); logLines.push(msg); }
function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

// 取样：与 render.mjs / contact-sheet.mjs 的 `near` 逐字同口径（并列取更早者 → 确定性）。
function near(frames, t) {
  let best = frames[0], bd = Infinity;
  for (const f of frames) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
  return best;
}

// 真实帧加载：与 render.mjs 入口逐字同口径（index → id；剔除 null 槽位）。
function loadRealFrames(relPath) {
  const g = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
  const frames = g.frames.map((f) => ({
    t: f.t,
    players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)).filter(Boolean),
    ball: f.ball,
  }));
  return { frames, meta: g.meta };
}

const inRange = (x, y) => x >= 0 && x <= 1 && y >= 0 && y <= 1;

// ── 清理（批 3/4）：丢越界点。**不改坐标值**（不夹紧），只做删除。
// 返回新帧 + 被删清单（清单进 KEY.json，是「两套唯一差别」的证据）。
function cleanFrame(f) {
  const removedPlayers = [];
  const players = f.players.filter((p) => {
    if (inRange(p.x, p.y)) return true;
    removedPlayers.push({ id: p.id, x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
    return false;
  });
  let ball = f.ball;
  let removedBall = false;
  const b = ballXY(ball);
  if (b && !inRange(b[0], b[1])) {
    if (CLEAN_RULE.dropOutOfRange) { ball = null; removedBall = true; }
  }
  if (CLEAN_RULE.dropExactDuplicates) {
    const seen = new Set();
    const kept = [];
    for (const p of players) {
      const k = `${p.x} ${p.y}`;
      if (seen.has(k)) { removedPlayers.push({ id: p.id, x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)), reason: 'dup' }); continue; }
      seen.add(k); kept.push(p);
    }
    return { frame: { t: f.t, players: kept, ball }, removed: { players: removedPlayers, ball: removedBall } };
  }
  return { frame: { t: f.t, players, ball }, removed: { players: removedPlayers, ball: removedBall } };
}

// ── 渲染：一「行」= 1 或 6 个面板。面板原点与 render.mjs 同一公式（ox = G + c*(PW+G), oy = G）。
// label 一律空串 → 图上零文字。
function renderRow(frameList) {
  const n = frameList.length;
  const W = n * PW + (n + 1) * G;
  const H = PH + 2 * G;
  const cv = new SoftCanvas(W, H);
  const ctx = cv.getContext();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); // 与 render.mjs 的底同色
  for (let c = 0; c < n; c++) {
    const f = frameList[c];
    drawPanel(ctx, G + c * (PW + G), G, PW, PH, f.players, f.ball, '');
  }
  return cv;
}

// ── 自检 1：图上零文字。drawPanel 的 label 色是 '#cfe8cf'，只被 fillText 使用；
// 本软光栅无抗锯齿（_setPx 写精确值），故「该 RGB 不出现」等价于「没画字」。
function assertNoLabelPixels(cv) {
  const { data } = cv.getContext().getImageData(0, 0, cv.width, cv.height);
  let hits = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 0xcf && data[i + 1] === 0xe8 && data[i + 2] === 0xcf) hits++;
  }
  if (hits > 0) throw new Error(`图上出现标签色像素 ${hits} 个 —— 有文字泄漏`);
  return hits;
}

// ── 自检 2：PNG 无元数据。canvasToPng 只写 IHDR/IDAT/IEND；此处从字节里把 chunk 列表读回来核验。
function pngChunks(buf) {
  const out = [];
  let o = 8; // 跳签名
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.slice(o + 4, o + 8).toString('ascii');
    out.push(type);
    o += 12 + len;
  }
  return out;
}

// ── 非结构线索审计（泄题红线 3）：逐面板列出「与战术结构无关、但可被用来猜来源」的缺陷。
// **审计对象 = 真正送进 drawPanel 的帧**，所以它描述的就是图上有什么（清理版上越界恒为 0）。
function auditFrame(f) {
  const xy = (p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
  const seen = new Map();
  let dupPairs = 0;
  for (const p of f.players) {
    const k = xy(p);
    if (seen.has(k)) dupPairs++; else seen.set(k, p.id);
  }
  const outOfRange = f.players.filter((p) => !inRange(p.x, p.y)).length;
  const b = ballXY(f.ball);
  return {
    nPlayers: f.players.length,
    ballPresent: b != null,
    ballInRange: b == null ? null : inRange(b[0], b[1]),
    ballXY: b == null ? null : [Number(b[0].toFixed(6)), Number(b[1].toFixed(6))],
    dupCoordCount: dupPairs,
    outOfRangePlayers: outOfRange,
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 48 个互不相同的双字母码（形状统一、无大小写歧义），顺序由确定性洗牌决定。
function drawCodes(n) {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pool = [];
  for (const a of L) for (const b of L) pool.push(a + b);
  const rand = mulberry32(SHUFFLE_SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = pool.slice(0, n);
  if (out.length < n || new Set(out).size !== n) throw new Error('码池不够或有重复');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────

async function runBase() {
  rmSync(STIM_DIR, { recursive: true, force: true });
  mkdirSync(STIM_DIR, { recursive: true });

  const engineFp = {
    wasmSha256: sha256File(join(ROOT, 'viewer/engine.wasm')),
    libRsSha256: sha256File(join(ROOT, 'engine/src/lib.rs')),
    metricsJsSha256: sha256File(join(ROOT, 'viewer/match-metrics.js')),
    renderMjsSha256: sha256File(join(ROOT, 'tools/visual-review/render.mjs')),
  };
  log(`# 引擎源码指纹 engine/src/lib.rs sha256 = ${engineFp.libRsSha256}`);
  log(`# 引擎 wasm sha256 = ${engineFp.wasmSha256}`);
  log(`# 指标模块 sha256 = ${engineFp.metricsJsSha256}`);

  // ── 1. 真实侧：载入两场
  const realByGame = {};
  for (const g of REAL_GAMES) {
    const { frames, meta } = loadRealFrames(g.file);
    realByGame[g.key] = frames;
    log(`# 真实 ${g.key}: ${frames.length} 帧, t=[${frames[0].t}, ${frames[frames.length - 1].t}], `
      + `keyframeHz=${meta.keyframeHz}, pitchMeters=${JSON.stringify(meta.pitchMeters ?? null)}`);
  }

  // ── 2. 引擎侧：6 个预注册 seed，各跑一次 5400s（标尺口径），同一帧序列供四批共用
  const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  if (!ok) throw new Error('wasm 加载失败');
  const engineBySeed = {};
  for (const seed of ENGINE_SEEDS) {
    const game = createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
    const frames = mm.sampleEngineFrames(game);
    engineBySeed[seed] = frames;
    log(`# 引擎 seed=${seed}: matchEnd=${game.matchEnd}s, 采样 ${frames.length} 帧 @${mm.SAMPLE_INTERVAL_SEC}s`);
  }

  // ── 3. 组装四批条目。批 3/4 = 批 1/2 的逐位配对（同 specs，只多 cleaned:true）
  const step = CONTACT_WIN_SEC / (CONTACT_N - 1);
  const staticSpecs = () => {
    const out = [];
    for (const g of REAL_GAMES) {
      for (const t0 of REAL_WINDOW_T0S) {
        out.push({ source: 'real', match: g.key, matchLabel: g.label, t0, times: [t0] });
      }
    }
    for (const seed of ENGINE_SEEDS) {
      out.push({ source: 'engine', match: null, seed, t0: ENGINE_BATCH1_T, times: [ENGINE_BATCH1_T] });
    }
    return out;
  };
  const contactSpecs = () => {
    const out = [];
    for (const g of REAL_GAMES) {
      for (const t0 of REAL_WINDOW_T0S) {
        const start = t0 + REAL_BATCH2_OFFSET;
        out.push({
          source: 'real', match: g.key, matchLabel: g.label, t0: start, t0Base: t0,
          times: Array.from({ length: CONTACT_N }, (_, k) => start + k * step),
        });
      }
    }
    for (const seed of ENGINE_SEEDS) {
      out.push({
        source: 'engine', match: null, seed, t0: ENGINE_BATCH2_T0,
        times: Array.from({ length: CONTACT_N }, (_, k) => ENGINE_BATCH2_T0 + k * step),
      });
    }
    return out;
  };

  // pairId 是**两个方向共用**的配对键：S<i> = 静止帧第 i 对（批1 原版 ↔ 批3 清理版），
  // C<i> = 接触表第 i 对（批2 原版 ↔ 批4 清理版）。
  const raw = [
    ...staticSpecs().map((s, i) => ({ ...s, batch: 1, cleaned: false, pairId: `S${i}` })),
    ...contactSpecs().map((s, i) => ({ ...s, batch: 2, cleaned: false, pairId: `C${i}` })),
  ];
  const cleaned = [
    ...staticSpecs().map((s, i) => ({ ...s, batch: 3, cleaned: true, pairId: `S${i}` })),
    ...contactSpecs().map((s, i) => ({ ...s, batch: 4, cleaned: true, pairId: `C${i}` })),
  ];
  const items = [...raw, ...cleaned];
  if (items.length !== 48) throw new Error(`条目数 ${items.length} ≠ 48`);
  if (new Set(items.map((it) => `${it.pairId}:${it.cleaned}`)).size !== 48) {
    throw new Error('pairId × cleaned 不唯一');
  }

  // ── 4. 打乱命名（48 张同池同洗牌）
  const letters = drawCodes(items.length);

  const key = { meta: {}, stimuli: {} };
  const audit = { stimuli: {} };
  let totalLabelPixels = 0;
  const engineByteChecks = [];
  const removedSummary = [];

  items.forEach((it, idx) => {
    const src = it.source === 'real' ? realByGame[it.match] : engineBySeed[it.seed];
    const picked = it.times.map((t) => near(src, t));

    // 同一份帧序列渲两次：raw 与 cleaned。批 1/2 出 raw，批 3/4 出 cleaned。
    const rawCv = renderRow(picked);
    const cleanedFrames = [];
    const removed = { players: [], ball: false };
    for (const f of picked) {
      const { frame, removed: r } = cleanFrame(f);
      cleanedFrames.push(frame);
      for (const p of r.players) removed.players.push({ ...p, t: Number(f.t.toFixed(6)) });
      if (r.ball) removed.ball = true;
    }
    const cleanedCv = renderRow(cleanedFrames);

    const usedCv = it.cleaned ? cleanedCv : rawCv;
    totalLabelPixels += assertNoLabelPixels(usedCv);
    const png = canvasToPng(usedCv);
    const rawPng = canvasToPng(rawCv);
    const cleanedPng = canvasToPng(cleanedCv);
    const chunks = pngChunks(png);
    const bad = chunks.filter((c) => !['IHDR', 'IDAT', 'IEND'].includes(c));
    if (bad.length) throw new Error(`PNG 含额外 chunk：${bad.join(',')}`);

    const name = `stim-${letters[idx]}.png`;
    writeFileSync(join(STIM_DIR, name), png);

    // 断言：清理对引擎侧是空操作 → 引擎的 cleaned 图与 raw 图逐字节相同
    if (it.source === 'engine') {
      const same = cleanedPng.equals(rawPng);
      engineByteChecks.push({ name, batch: it.batch, seed: it.seed, byteIdentical: same });
      if (!same) throw new Error(`引擎侧清理非空操作：${name}（清理版与原版字节不同）`);
    }

    const rec = {
      source: it.source,
      match: it.match,
      t0: it.t0,
      seed: it.source === 'engine' ? it.seed : null,
      batch: it.batch,
      cleaned: it.cleaned,
      pairId: it.pairId,
      resolvedTimes: picked.map((f) => Number(f.t.toFixed(6))),
      removedByCleaning: removed,
      file: name,
      w: usedCv.width, h: usedCv.height, bytes: png.length,
    };
    if (it.t0Base !== undefined) rec.t0Base = it.t0Base;
    key.stimuli[name] = rec;
    if (it.cleaned && (removed.players.length || removed.ball)) {
      removedSummary.push(`${name}(${it.pairId}): 丢球员${removed.players.length} 丢球${removed.ball ? 1 : 0}`);
    }

    // 审计对象 = 送进渲染的帧（清理版即清理后）
    audit.stimuli[name] = {
      batch: it.batch,
      cleaned: it.cleaned,
      panels: (it.cleaned ? cleanedFrames : picked).map(auditFrame),
      panelSize: [PW, PH],
      labelPixels: 0,
      pngChunks: chunks.join(','),
    };
  });

  // ── 5. 配对校验：按 pairId 找孪生图，比对字节。
  // 期望：引擎对**全部逐字节相同**（清理是空操作）；真实对**全部不同**（清理真的动了点）。
  const pairChecks = [];
  const names0 = Object.keys(key.stimuli);
  for (const name of names0) {
    const r = key.stimuli[name];
    if (!r.cleaned) continue;
    const twinName = names0.find((n) => key.stimuli[n].pairId === r.pairId && !key.stimuli[n].cleaned);
    if (!twinName) throw new Error(`找不到 ${name} 的孪生图（pairId=${r.pairId}）`);
    key.stimuli[name].twinFile = twinName;
    key.stimuli[twinName].twinFile = name;
    const a = readFileSync(join(STIM_DIR, name));
    const b = readFileSync(join(STIM_DIR, twinName));
    pairChecks.push({ pairId: r.pairId, cleaned: name, raw: twinName, source: r.source,
      byteIdentical: a.equals(b), cleanedBytes: a.length, rawBytes: b.length });
  }

  // ── 5b. 批 3/4 清理后的**残余线索**摘要（进 KEY.meta，供下游直接读，不必翻日志）。
  // 这是本追加轮最重要的读数：清理是否真的把「越界点」这条线索清零，以及它换来了什么新线索。
  const allNames = Object.keys(key.stimuli).sort();
  const residueByBatch = {};
  for (const b of [3, 4]) {
    const ns = allNames.filter((n) => key.stimuli[n].batch === b);
    let panels = 0, oor = 0, dup = 0, noBall = 0, short = 0;
    const ballDropped = [], playerDropped = [];
    for (const n of ns) {
      const rec = key.stimuli[n];
      if (rec.removedByCleaning.ball) ballDropped.push(n);
      if (rec.removedByCleaning.players.length) playerDropped.push(n);
      for (const p of audit.stimuli[n].panels) {
        panels++;
        if (p.outOfRangePlayers > 0) oor++;
        if (p.dupCoordCount > 0) dup++;
        if (!p.ballPresent) noBall++;
        if (p.nPlayers < 22) short++;
      }
    }
    const target = ns.filter((n) => key.stimuli[n].source === 'real').length * (b === 3 ? 1 : CONTACT_N);
    residueByBatch[b] = {
      images: ns.length, panels,
      realPanels: target,
      outOfRangePanels: oor,        // 目标：0
      dupCoordPanels: dup,          // 规格未要求清（CLEAN_RULE.dropExactDuplicates=false）
      ballMissingPanels: noBall,    // 清理的**新**残余：球被丢 ⇒ 该面板无球
      under22PlayersPanels: short,  // 清理的**新**残余：球员被丢 ⇒ 该面板 <22 人
      imagesWithBallDropped: ballDropped,
      imagesWithPlayerDropped: playerDropped,
    };
  }

  key.meta = {
    generator: '.scratch/notes/p-discrimination-2026-10-15/gen-stimuli.mjs',
    generatorSha256: sha256File(fileURLToPath(import.meta.url)),
    design: '.scratch/notes/p-discrimination-2026-10-15/DESIGN.md',
    shuffleSeed: SHUFFLE_SEED,
    namingNote: '48 张来自同一个双字母码池（A-Z × A-Z，676 选 48）的一次确定性洗牌，'
      + '形状统一、无大小写歧义。清理版与原版在命名上不可区分'
      + '（不给批 3/4 换小写/后缀/另一种形状——那会让清理版成对可辨）。',
    engineFingerprint: engineFp,
    engineConfig: { demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: mm.ENGINE_DURATION_SEC },
    panelSize: [PW, PH], gutter: G,
    contactWinSec: CONTACT_WIN_SEC, contactN: CONTACT_N,
    realBatch2OffsetSec: REAL_BATCH2_OFFSET,
    engineBatch1T: ENGINE_BATCH1_T, engineBatch2T0: ENGINE_BATCH2_T0,
    engineSeeds: ENGINE_SEEDS, realWindowT0s: REAL_WINDOW_T0S,
    cleanRule: CLEAN_RULE,
    cleanRuleNote: '批 3/4：渲染前丢弃坐标超出 [0,1]² 的球员点与球点；不夹到边界、不丢整帧。'
      + '引擎侧无越界点 ⇒ 清理是空操作 ⇒ 批 3/4 的引擎图与批 1/2 对应图逐字节相同（见 pairChecks）。',
    positiveRatePerBatch: 0.5,
    batches: {
      1: '静止帧·原版（6 真 + 6 引擎）',
      2: '12s 接触表·原版（6 真 + 6 引擎）',
      3: '静止帧·清理版（与批 1 逐位配对）',
      4: '12s 接触表·清理版（与批 2 逐位配对）',
    },
    pairChecksSummary: {
      total: pairChecks.length,
      byteIdentical: pairChecks.filter((p) => p.byteIdentical).length,
      enginePairs: pairChecks.filter((p) => p.source === 'engine').length,
      enginePairsByteIdentical: pairChecks.filter((p) => p.source === 'engine' && p.byteIdentical).length,
      realPairs: pairChecks.filter((p) => p.source === 'real').length,
      realPairsChanged: pairChecks.filter((p) => p.source === 'real' && !p.byteIdentical).length,
      realPairsUnchanged: pairChecks.filter((p) => p.source === 'real' && p.byteIdentical).length,
    },
    residueAfterCleaning: residueByBatch,
  };
  key.pairChecks = pairChecks;
  writeFileSync(join(OUT_DIR, 'KEY.json'), JSON.stringify(key, null, 2));
  writeFileSync(join(OUT_DIR, 'audit.json'), JSON.stringify(audit, null, 2));

  // ── 6. 生成期自检汇总
  const names = Object.keys(key.stimuli).sort();
  const byBatchSrc = {};
  for (const n of names) {
    const r = key.stimuli[n];
    const k = `b${r.batch}${r.cleaned ? 'C' : ''}-${r.source}`;
    byBatchSrc[k] = (byBatchSrc[k] || 0) + 1;
  }
  log(`# 生成 ${names.length} 张：${JSON.stringify(byBatchSrc)}`);
  log(`# 自检：标签色像素总数 = ${totalLabelPixels}（应为 0）；全部 PNG chunk ⊆ {IHDR,IDAT,IEND} 已核验`);
  const s = key.meta.pairChecksSummary;
  log(`# 配对校验：${s.total} 对 | 引擎 ${s.enginePairs} 对，逐字节相同 ${s.enginePairsByteIdentical}`
    + `（应为 ${s.enginePairs} ⇒ 清理对引擎是空操作）| 真实 ${s.realPairs} 对，`
    + `因清理改变 ${s.realPairsChanged}、未变 ${s.realPairsUnchanged}（未变者 = 该图本来就没有越界点）`);
  if (s.enginePairsByteIdentical !== s.enginePairs) throw new Error('引擎侧配对图字节不同 —— 清理不是空操作');
  log(`# 批 3/4 上真正执行的清理：${removedSummary.length} 张（应为 5 = 越界图数）→ `
    + `${removedSummary.join(' | ') || '（无）'}`);

  // 批 3/4 审计汇总（同时也在 KEY.meta.residueAfterCleaning 里）
  for (const b of [3, 4]) {
    const r = key.meta.residueAfterCleaning[b];
    log(`# 批 ${b} 审计：${r.panels} 面板（真实 ${r.realPanels}）| 越界点面板 ${r.outOfRangePanels}（目标 0）`
      + ` | 重合点面板 ${r.dupCoordPanels} | 无球面板 ${r.ballMissingPanels} | 不足 22 人面板 ${r.under22PlayersPanels}`);
  }

  writeFileSync(join(OUT_DIR, 'gen.log'), logLines.join('\n') + '\n');
}

// ═════════════════════════════════════════════════════════════════════════
// SET-CLEAN（干净版 24 张）
// ═════════════════════════════════════════════════════════════════════════

// 球位（归一化）→ 米。缺球返回 null。
function ballMeters(b) {
  const xy = ballXY(b);
  return xy ? [xy[0] * METERS_PER_X, xy[1] * METERS_PER_Y] : null;
}

// 球位移（米）：以窗内**第一个可观测球位**为基准，取窗内各帧到该基准的**最大**距离。
// 为什么用「最大离起点距离」而不是「首末净位移」：净位移会把「球跑出去又回来」判成死球
// （假阴性方向是安全的——只是多换一个窗），而最大离起点距离同时覆盖「单调推进」与「往返拉锯」。
// 为什么不用「路径长度」：路径长度对逐帧抖动敏感（追踪噪声会累加出虚假的"活球"）。
function ballDispMeters(frames, t0, t1) {
  const win = frames.filter((f) => f.t >= t0 - 1e-6 && f.t <= t1 + 1e-6);
  const pts = win.map((f) => ballMeters(f.ball)).filter(Boolean);
  if (pts.length < 2) return { disp: null, n: pts.length };
  const [x0, y0] = pts[0];
  let best = 0;
  for (const [x, y] of pts) best = Math.max(best, Math.hypot(x - x0, y - y0));
  return { disp: best, n: pts.length };
}

const coordKey = (x, y) => `${x.toFixed(9)},${y.toFixed(9)}`;

// ── 修复一帧（只动真实侧；引擎侧调用它是空操作，脚本会断言）
//
// 三类瑕疵的处理（顺序即规格 bullet 顺序）：
//   1. 越界球员点 → **夹到 [0,1]²**（不丢整点：丢点会造出「少一个人」这条新线索）。
//      若夹紧后与另一点**完全重合** → 按规格**丢掉被夹的那一个**；但这会让该面板只剩 21 人，
//      与「每面板恒 22 人」冲突 ⇒ 该窗判为**不可满足**，走 bullet 4 换下一个窗（脚本会记录）。
//   2. 越界球点 → **夹到 [0,1]²**（球必须始终在场内且可见，绝不允许无球面板）。
//   3. 本来就重合的坐标 → **微小平移**（MICRO_OFFSET）后重绘，**保住 22 个点**。
//      （规格 bullet 3 说「同一坐标只画一个点」，但那样面板就只剩 21 个可见点——正是要消除的
//      那条线索；故按同一 bullet 的括注「若合并导致少画，改为微小平移后重绘」执行。）
function repairFrame(f) {
  const rec = { clampedPlayers: [], clampedBall: null, clampCollisionDropped: [], microOffset: [] };
  const wasClamped = new Set();
  const players = f.players.map((p) => ({ ...p }));

  for (const p of players) {
    if (inRange(p.x, p.y)) continue;
    rec.clampedPlayers.push({ id: p.id, from: [+p.x.toFixed(6), +p.y.toFixed(6)] });
    p.x = Math.min(1, Math.max(0, p.x));
    p.y = Math.min(1, Math.max(0, p.y));
    wasClamped.add(p.id);
  }

  let ball = f.ball;
  const b = ballXY(ball);
  if (b && !inRange(b[0], b[1])) {
    const c = [Math.min(1, Math.max(0, b[0])), Math.min(1, Math.max(0, b[1]))];
    rec.clampedBall = { from: [+b[0].toFixed(6), +b[1].toFixed(6)], to: [+c[0].toFixed(6), +c[1].toFixed(6)] };
    ball = c;
  }

  // 按坐标分组 → 组内处理
  const groups = new Map();
  for (const p of players) {
    const k = coordKey(p.x, p.y);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const out = [];
  for (const [, grp] of groups) {
    let g = grp;
    if (g.length > 1) {
      const clampedInGroup = g.filter((p) => wasClamped.has(p.id));
      if (clampedInGroup.length > 0) {
        // 夹紧造成的重合：丢被夹的那些（规格 bullet 1）
        for (const p of clampedInGroup) rec.clampCollisionDropped.push(p.id);
        g = g.filter((p) => !wasClamped.has(p.id));
      }
    }
    g.forEach((p, i) => {
      if (i === 0) { out.push(p); return; }
      // 本来重合 → 微小平移（方向取「不越界」的那一侧）
      const step = MICRO_OFFSET * i;
      let nx = p.x + step;
      if (nx > 1) nx = p.x - step;
      const moved = { ...p, x: nx, y: p.y };
      rec.microOffset.push({ id: p.id, from: [+p.x.toFixed(6), +p.y.toFixed(6)], to: [+nx.toFixed(6), +p.y.toFixed(6)] });
      out.push(moved);
    });
  }
  return { frame: { t: f.t, players: out, ball }, rec };
}

// 「恰好贴在 [0,1] 边界上」的点（夹紧的副产品）。渲染口径：坐标恰好 0/1 落在球场线上。
// 审计报它是因为**夹紧会把越界点变成贴线点**——若只有真实侧出现，那本身就是新线索。
function onBoundaryCount(f) {
  let n = 0;
  for (const p of f.players) if (p.x === 0 || p.x === 1 || p.y === 0 || p.y === 1) n++;
  const b = ballXY(f.ball);
  if (b && (b[0] === 0 || b[0] === 1 || b[1] === 0 || b[1] === 1)) n++;
  return n;
}

// 逐面板判「可满足」：22 人 + 无越界 + 无重合 + 有球且球在场内
function panelOk(f) {
  if (f.players.length !== 22) return `人数 ${f.players.length}`;
  if (f.players.some((p) => !inRange(p.x, p.y))) return '仍有越界球员';
  const ks = new Set(f.players.map((p) => coordKey(p.x, p.y)));
  if (ks.size !== f.players.length) return '仍有重合坐标';
  const b = ballXY(f.ball);
  if (!b) return '无球';
  if (!inRange(b[0], b[1])) return '球越界';
  return null;
}

// 一对点在**像素空间**的距离是否小于点直径（= 视觉上会糊成一个）。审计用。
function visuallyMergedPairs(f) {
  const n = f.players.length;
  let cnt = 0;
  const thr = 2 * DOT_RADIUS_PX;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = (f.players[i].x - f.players[j].x) * PW;
    const dy = (f.players[i].y - f.players[j].y) * PH;
    if (Math.hypot(dx, dy) < thr) cnt++;
  }
  return cnt;
}

// 引擎侧断言用：修复必须是空操作（引擎坐标恒在 [0,1] 内、不会两点重合）
function assertRepairNoop(f, tag) {
  const { rec } = repairFrame(f);
  const touched = rec.clampedPlayers.length + rec.clampCollisionDropped.length
    + rec.microOffset.length + (rec.clampedBall ? 1 : 0);
  if (touched > 0) throw new Error(`引擎侧修复非空操作（${tag}）：${JSON.stringify(rec)}`);
}

// 真实的候选窗（按预注册阶梯 + 死球过滤 + 可修复性，逐个往下走）
// kind='still'：时刻 = 阶梯值，死球判据 = 前 2 s 球位移 ≥ 2 m
// kind='sheet'：窗 = [阶梯值+300, 阶梯值+300+12]，死球判据 = 窗内球位移 ≥ 15 m
export function selectRealWindows(frames, kind, need, log, matchKey) {
  const picked = [];
  const rejected = [];
  for (const base of CANDIDATE_BASE) {
    if (picked.length >= need) break;
    const times = kind === 'still'
      ? [base]
      : Array.from({ length: CONTACT_N }, (_, k) => base + SHEET_START_OFFSET + k * (CONTACT_WIN_SEC / (CONTACT_N - 1)));
    const tFirst = times[0], tLast = times[times.length - 1];
    // 可用性：整窗必须落在可观测时段内
    if (tFirst < STILL_BALL_LOOKBACK_SEC || tLast > frames[frames.length - 1].t) {
      rejected.push({ base, reason: `超出可观测时段（末帧 ${frames[frames.length - 1].t}s）` });
      continue;
    }
    // 死球过滤
    const { disp, n } = kind === 'still'
      ? ballDispMeters(frames, base - STILL_BALL_LOOKBACK_SEC, base)
      : ballDispMeters(frames, tFirst, tLast);
    const need_m = kind === 'still' ? STILL_MIN_BALL_DISP_M : SHEET_MIN_BALL_DISP_M;
    if (disp == null || n < 2) { rejected.push({ base, reason: `球位可观测帧不足（${n}）` }); continue; }
    if (disp < need_m) {
      rejected.push({ base, reason: `死球：球位移 ${disp.toFixed(2)} m < ${need_m} m` });
      continue;
    }
    // 取样 + 修复 + 可满足性
    const pickedFrames = times.map((t) => near(frames, t));
    const repaired = pickedFrames.map((f) => repairFrame(f).frame);
    const bad = repaired.map(panelOk).filter(Boolean);
    if (bad.length) { rejected.push({ base, reason: `修复后仍不满足：${bad.join('/')}` }); continue; }
    picked.push({ base, times, frames: repaired, rawFrames: pickedFrames, ballDisp: disp });
  }
  if (rejected.length) {
    for (const r of rejected) log(`#   [${matchKey}/${kind}] 弃窗 t0=${r.base}：${r.reason}`);
  }
  return { picked, rejected };
}

async function runClean() {
  rmSync(CLEAN_STIM_DIR, { recursive: true, force: true });
  mkdirSync(CLEAN_STIM_DIR, { recursive: true });

  const fp = {
    wasmSha256: sha256File(join(ROOT, 'viewer/engine.wasm')),
    libRsSha256: sha256File(join(ROOT, 'engine/src/lib.rs')),
    metricsJsSha256: sha256File(join(ROOT, 'viewer/match-metrics.js')),
    renderMjsSha256: sha256File(join(ROOT, 'tools/visual-review/render.mjs')),
  };
  log(`# [SET-CLEAN] 引擎源码指纹 lib.rs=${fp.libRsSha256.slice(0, 8)}… wasm=${fp.wasmSha256.slice(0, 8)}…`);

  const realByGame = {};
  for (const g of REAL_GAMES) {
    const { frames } = loadRealFrames(g.file);
    realByGame[g.key] = frames;
    log(`# [SET-CLEAN] 真实 ${g.key}: ${frames.length} 帧，末帧 ${frames[frames.length - 1].t}s`);
  }

  const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
  if (!ok) throw new Error('wasm 加载失败');
  const engineBySeed = {};
  for (const seed of ENGINE_SEEDS) {
    const game = createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
    engineBySeed[seed] = mm.sampleEngineFrames(game);
  }

  // ── 真实侧：每场 3 个静帧 + 3 个接触表
  const items = [];
  const rejectLog = [];
  for (const g of REAL_GAMES) {
    for (const kind of ['still', 'sheet']) {
      const { picked, rejected } = selectRealWindows(realByGame[g.key], kind, 3, log, g.key);
      for (const r of rejected) rejectLog.push({ match: g.key, kind, ...r });
      if (picked.length < 3) throw new Error(`${g.key}/${kind} 只找到 ${picked.length} 个可用窗`);
      for (const w of picked) {
        items.push({
          source: 'real', match: g.key, kind, t0: w.base, seed: null,
          times: w.times, frames: w.frames, rawFrames: w.rawFrames, ballDisp: w.ballDisp,
        });
      }
    }
  }

  // ── 引擎侧：6 seed × 2 kind（无死球过滤，修复必须为空操作）
  for (const seed of ENGINE_SEEDS) {
    const fr = engineBySeed[seed];
    const still = [near(fr, ENGINE_BATCH1_T)];
    const sheet = Array.from({ length: CONTACT_N }, (_, k) => ENGINE_BATCH2_T0 + k * (CONTACT_WIN_SEC / (CONTACT_N - 1))).map((t) => near(fr, t));
    for (const [kind, raw] of [['still', still], ['sheet', sheet]]) {
      for (const f of raw) assertRepairNoop(f, `seed=${seed}/${kind}`);
      const bb = ballDispMeters(fr, kind === 'still' ? ENGINE_BATCH1_T - STILL_BALL_LOOKBACK_SEC : ENGINE_BATCH2_T0,
        kind === 'still' ? ENGINE_BATCH1_T : ENGINE_BATCH2_T0 + CONTACT_WIN_SEC);
      items.push({
        source: 'engine', match: null, kind, t0: kind === 'still' ? ENGINE_BATCH1_T : ENGINE_BATCH2_T0,
        seed, times: raw.map((f) => f.t), frames: raw, rawFrames: raw, ballDisp: bb.disp,
      });
    }
  }
  if (items.length !== NEW_CODE_COUNT) throw new Error(`SET-CLEAN 条目数 ${items.length} ≠ ${NEW_CODE_COUNT}`);

  // ── 新码：从同一 676 池洗出新一组，排除上一版用掉的 48 个
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const fullPool = [];
  for (const a of L) for (const b of L) fullPool.push(a + b);
  const shuffleWith = (seed) => {
    const p = [...fullPool];
    const rand = mulberry32(seed);
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
  };
  const oldCodes = new Set(shuffleWith(OLD_SHUFFLE_SEED).slice(0, OLD_CODE_COUNT));
  const codes = shuffleWith(NEW_SHUFFLE_SEED).filter((c) => !oldCodes.has(c)).slice(0, NEW_CODE_COUNT);
  if (codes.length < NEW_CODE_COUNT) throw new Error('新码池不够');
  const overlap = codes.filter((c) => oldCodes.has(c));
  if (overlap.length) throw new Error(`新码与上一版重复：${overlap.join(',')}`);

  // ── 渲染 + 审计
  const key = { meta: {}, stimuli: {} };
  const audit = { panels: {}, stimuli: {} };
  let labelPixels = 0;
  items.forEach((it, idx) => {
    const cv = renderRow(it.frames);
    labelPixels += assertNoLabelPixels(cv);
    const png = canvasToPng(cv);
    const chunks = pngChunks(png);
    const badChunks = chunks.filter((c) => !['IHDR', 'IDAT', 'IEND'].includes(c));
    if (badChunks.length) throw new Error(`PNG 含额外 chunk：${badChunks.join(',')}`);
    const name = `stim-${codes[idx]}.png`;
    writeFileSync(join(CLEAN_STIM_DIR, name), png);

    // 逐面板审计（**在真正送进渲染的帧上算**）+ 逐面板修复记录（规格要求「如实记录」）
    const repairs = it.rawFrames.map((f, i) => ({ panel: i, t: Number(f.t.toFixed(6)), ...repairFrame(f).rec }));
    const panels = it.frames.map((f) => ({
      ...auditFrame(f),
      visuallyMergedPairs: visuallyMergedPairs(f),
      onBoundaryPoints: onBoundaryCount(f),
    }));
    const repairedCount = repairs.reduce((acc, r) => acc
      + r.clampedPlayers.length + r.microOffset.length + (r.clampedBall ? 1 : 0) + r.clampCollisionDropped.length, 0);
    audit.stimuli[name] = {
      kind: it.kind, source: it.source, panels,
      panelSize: [PW, PH], labelPixels: 0, pngChunks: chunks.join(','), repairsApplied: repairedCount,
    };
    key.stimuli[name] = {
      source: it.source,
      match: it.match,
      t0: it.t0,
      seed: it.seed,
      kind: it.kind,
      ballDisp: it.ballDisp == null ? null : Number(it.ballDisp.toFixed(3)),
      resolvedTimes: it.times.map((t) => Number(t.toFixed(6))),
      repairsApplied: repairedCount,
      repairs: repairedCount ? repairs.filter((r) => r.clampedPlayers.length || r.clampedBall
        || r.clampCollisionDropped.length || r.microOffset.length) : [],
      file: name, w: cv.width, h: cv.height, bytes: png.length,
    };
  });

  // ── 呈现顺序：洗牌种子按写死的规则搜（从 1 开始，取第一个通过独立性检验的）
  const files = Object.keys(key.stimuli);
  const orderOk = (ord) => {
    const head = ord.slice(0, PRESENTATION_HALF).map((n) => key.stimuli[n]);
    const nReal = head.filter((r) => r.source === 'real').length;
    const nStill = head.filter((r) => r.kind === 'still').length;
    return nReal >= PRESENTATION_MIN && nReal <= PRESENTATION_MAX
      && nStill >= PRESENTATION_MIN && nStill <= PRESENTATION_MAX;
  };
  let presSeed = PRESENTATION_SEED_START, order = null;
  const rejects = [];
  for (; presSeed < 10000; presSeed++) {
    const rand = mulberry32(presSeed);
    const o = [...files];
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    if (orderOk(o)) { order = o; break; }
    rejects.push(presSeed);
  }
  if (!order) throw new Error('找不到满足独立性检验的呈现顺序种子');
  const head = order.slice(0, PRESENTATION_HALF).map((n) => key.stimuli[n]);
  writeFileSync(join(CLEAN_OUT_DIR, 'presentation-order.txt'), order.join('\n') + '\n');

  // ── 汇总 + 断言
  const all = Object.values(audit.stimuli).flatMap((s) => s.panels);
  const agg = {
    images: files.length,
    panels: all.length,
    outOfRangePanels: all.filter((p) => p.outOfRangePlayers > 0).length,
    ballMissingPanels: all.filter((p) => !p.ballPresent).length,
    ballOutOfRangePanels: all.filter((p) => p.ballPresent && !p.ballInRange).length,
    dupCoordPanels: all.filter((p) => p.dupCoordCount > 0).length,
    not22Panels: all.filter((p) => p.nPlayers !== 22).length,
    visuallyMergedPanels: all.filter((p) => p.visuallyMergedPairs > 0).length,
    visuallyMergedPairs: all.reduce((a, p) => a + p.visuallyMergedPairs, 0),
    onBoundaryPanels: all.filter((p) => p.onBoundaryPoints > 0).length,
    onBoundaryPoints: all.reduce((a, p) => a + p.onBoundaryPoints, 0),
  };
  // 按来源拆（判断某条残余是不是「只有一边有」= 新线索）
  const split = (fn) => ({
    real: Object.entries(audit.stimuli).filter(([n]) => key.stimuli[n].source === 'real').flatMap(([, s]) => s.panels).filter(fn).length,
    engine: Object.entries(audit.stimuli).filter(([n]) => key.stimuli[n].source === 'engine').flatMap(([, s]) => s.panels).filter(fn).length,
    realPanels: 42, enginePanels: 42,
  });
  agg.bySource = {
    visuallyMergedPanels: split((p) => p.visuallyMergedPairs > 0),
    onBoundaryPanels: split((p) => p.onBoundaryPoints > 0),
    imagesWithRepairs: {
      real: Object.entries(key.stimuli).filter(([n, r]) => r.source === 'real' && r.repairsApplied > 0).length,
      engine: Object.entries(key.stimuli).filter(([n, r]) => r.source === 'engine' && r.repairsApplied > 0).length,
    },
  };
  key.meta = {
    set: 'SET-CLEAN',
    generator: '.scratch/notes/p-discrimination-2026-10-15/gen-stimuli.mjs',
    generatorSha256: sha256File(fileURLToPath(import.meta.url)),
    design: '.scratch/notes/p-discrimination-2026-10-15/DESIGN-CLEAN.md',
    engineFingerprint: fp,
    engineConfig: { demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: mm.ENGINE_DURATION_SEC },
    panelSize: [PW, PH], gutter: G, contactWinSec: CONTACT_WIN_SEC, contactN: CONTACT_N,
    engineSeeds: ENGINE_SEEDS, engineStillT: ENGINE_BATCH1_T, engineSheetT0: ENGINE_BATCH2_T0,
    candidateBase: CANDIDATE_BASE, sheetStartOffset: SHEET_START_OFFSET,
    deadBallRule: { still: `前 ${STILL_BALL_LOOKBACK_SEC}s 球位移 ≥ ${STILL_MIN_BALL_DISP_M} m`,
      sheet: `窗内球位移 ≥ ${SHEET_MIN_BALL_DISP_M} m` },
    deadBallMetric: '窗内以首个可观测球位为基准的最大距离（米），105×68 换算',
    repairRule: {
      outOfRangePlayer: 'clamp 到 [0,1]²；若夹紧致与另一点完全重合 → 丢被夹者，并判该窗不可满足 → 换窗',
      outOfRangeBall: 'clamp 到 [0,1]²（球必须始终在场内且可见）',
      duplicate: `微小平移 ${MICRO_OFFSET}（归一化）后重绘，保住 22 个点`,
    },
    microOffset: MICRO_OFFSET,
    dotRadiusPx: DOT_RADIUS_PX,
    positiveRatePerBatch: null,
    independenceCheck: {
      rule: `呈现顺序前 ${PRESENTATION_HALF} 个里 真实张数 ∈ [${PRESENTATION_MIN},${PRESENTATION_MAX}] 且 静止帧张数 ∈ [${PRESENTATION_MIN},${PRESENTATION_MAX}]`,
      seedSearchRule: `从 ${PRESENTATION_SEED_START} 开始逐个试，取第一个通过者`,
      seed: presSeed, rejectedSeeds: rejects,
      head12: { real: head.filter((r) => r.source === 'real').length, still: head.filter((r) => r.kind === 'still').length },
    },
    aggregate: agg,
    rejectLog,
    note: '真实 12 = 6 静止帧 + 6 接触表（game-1/game-2 各 3+3）；引擎 12 = 6 seed × {静止帧, 接触表}。'
      + '每个场面只出一张，不做配对双份。',
  };
  key.presentationOrder = order.map((n, i) => ({ i: i + 1, file: n, source: key.stimuli[n].source, kind: key.stimuli[n].kind }));
  writeFileSync(join(CLEAN_OUT_DIR, 'KEY.json'), JSON.stringify(key, null, 2));
  audit.meta = { aggregate: agg, ...fp };
  writeFileSync(join(CLEAN_OUT_DIR, 'audit-clean.json'), JSON.stringify(audit, null, 2));

  // ── 断言：三类瑕疵 + 人数
  const problems = [];
  if (agg.outOfRangePanels) problems.push(`越界面板 ${agg.outOfRangePanels}`);
  if (agg.ballMissingPanels) problems.push(`无球面板 ${agg.ballMissingPanels}`);
  if (agg.ballOutOfRangePanels) problems.push(`球越界面板 ${agg.ballOutOfRangePanels}`);
  if (agg.dupCoordPanels) problems.push(`重合坐标面板 ${agg.dupCoordPanels}`);
  if (agg.not22Panels) problems.push(`非 22 人面板 ${agg.not22Panels}`);
  if (problems.length) throw new Error(`SET-CLEAN 审计未达标：${problems.join(' / ')}`);

  log(`# [SET-CLEAN] 生成 ${files.length} 张（真实 ${files.filter((n) => key.stimuli[n].source === 'real').length}）`);
  log(`# [SET-CLEAN] 标签色像素 = ${labelPixels}（应 0）| PNG chunk ⊆ {IHDR,IDAT,IEND} 已核验`);
  log(`# [SET-CLEAN] 审计：${agg.panels} 面板 | 越界 ${agg.outOfRangePanels} | 无球 ${agg.ballMissingPanels} `
    + `| 球越界 ${agg.ballOutOfRangePanels} | 重合 ${agg.dupCoordPanels} | 非 22 人 ${agg.not22Panels} —— 全部应为 0`);
  log(`# [SET-CLEAN] 修复动作：真实 ${agg.bySource.imagesWithRepairs.real} 张图被动过、`
    + `引擎 ${agg.bySource.imagesWithRepairs.engine} 张（引擎应为 0）`);
  log(`# [SET-CLEAN] 视觉糊团（两点像素距 < 点直径）面板：真实 ${agg.bySource.visuallyMergedPanels.real}/42 `
    + `vs 引擎 ${agg.bySource.visuallyMergedPanels.engine}/42 —— 这是**站位聚集**的结构差异，不是数据缺陷`);
  log(`# [SET-CLEAN] 恰好贴 [0,1] 边界的点（夹紧副产品）面板：真实 ${agg.bySource.onBoundaryPanels.real}/42 `
    + `vs 引擎 ${agg.bySource.onBoundaryPanels.engine}/42`);
  log(`# [SET-CLEAN] 真实侧弃窗 ${rejectLog.length} 个：`
    + (rejectLog.map((r) => `${r.match}/${r.kind}@${r.base}(${r.reason})`).join(' | ') || '（无）'));
  log(`# [SET-CLEAN] 呈现顺序种子 ${presSeed}（试过并否掉 ${rejects.length} 个）；前 12 个：`
    + `真实 ${key.meta.independenceCheck.head12.real} / 静止帧 ${key.meta.independenceCheck.head12.still}`);
  writeFileSync(join(CLEAN_OUT_DIR, 'gen-clean.log'), logLines.join('\n') + '\n');
}

const IS_CLEAN = process.argv[2] === 'clean';
if (IS_CLEAN) await runClean(); else await runBase();
