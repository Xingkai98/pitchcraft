// wayfinder #101：**面板构建器**——一次遍历 20 场，落盘为紧凑的**扁平数值行**。
//
// ── 为什么要缓存，以及为什么是"扁平数组 + 流式" ────────────────────────
// 20 场 ≈ 44 万帧 @5Hz。每帧要算留一重心 + 邻居搜索（O(n²)，n=10）。
// 每个探针各跑一遍要几分钟；#101 有 5 个探针 → 必须缓存。
//
// ⚠ **第一版是对象行 + 全量入内存，在 10 场处 OOM 被杀**（本机 7GB RAM）。
// 改为：
//   1. 每行是**纯数值数组**（单位=米，字符串全部内联化为整数索引）；
//   2. **逐场流式追加**写盘，绝不把全部行留在内存；
//   3. 探针侧用 `readPanel()` **流式逐行**读取并累积充分统计量。
//
// ── 口径 ────────────────────────────────────────────────────────────────
// 一切口径在 `issue101-common.extractFrame` 里（它复用 q90-common）：
// 客队镜像 / yCanon 朝向归一 / 逐场尺寸 / 全点口径 / 剔门将 / <7 人丢帧。
// 本文件只做"整理成列 + 补跨帧量（惯性/速度）"。
//
// 产物：`.scratch/p38-frames/issue101-panel.jsonl`（.gitignore 已排除）
//       `.scratch/p38-frames/issue101-panel.meta.json`（列名 + 单元表 + 签名）

import { writeFileSync, readFileSync, existsSync, mkdirSync, createWriteStream, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import * as Q from './q90-common.mjs';

const DIR = join(C.REPO, '.scratch', 'p38-frames');
const PANEL_PATH = join(DIR, 'issue101-panel.jsonl');
const META_PATH = join(DIR, 'issue101-panel.meta.json');

// ── 列定义（**顺序即数组下标**，改这里必须同时清缓存）──────────────────
export const COLS = [
  'unit',      // 单元索引（见 meta.units）
  't',         // 帧时间（秒）
  'y',         // ★ 主因变量：y_i − mateY（留一队友重心）
  'yAbs',      // 绝对 y（米，yCanon）
  'mateY',     // 留一队友重心（绝对）
  'cy',        // 全队重心（含本人，绝对）——**只用于团队层因变量**
  'x',         // 离本方门线距离（米）
  'ballX',     // 球离本方门线距离（米，绝对）
  'ballYAbs',  // 球 y（绝对，yCanon）
  'phase',     // 1 本方控球 / 0 对方 / NaN 未知
  'ballObs',   // 1 球是真观测帧 / 0
  // ── 个体层因子（全部相对 mateY）──
  'ballY', 'ballDepth',
  'nearOppY', 'k3OppY', 'k5OppY', 'oppCy',
  'nearOppGap', 'nearOppDist',
  'nearMateY', 'k3MateY', 'k5MateY',
  'nearMateGap', 'nearMateDist',
  'k3AnyY', 'k5AnyY', 'nearAnyDist',
  'goalOwnY', 'goalOppY',
  'ownX', 'xXphase', 'ballXxPhase',
  // ── 跨帧（惯性 / 运动学）──
  'yPrev', 'dyPrev', 'dxPrev',
];
const IDX = Object.fromEntries(COLS.map((c, i) => [c, i]));
export const NF = COLS.length;

// ── 构建 ────────────────────────────────────────────────────────────────

/**
 * 构建面板（若缓存签名匹配则复用）。
 * @param {{stride?:number, force?:boolean, verbose?:boolean}} opts
 */
export async function buildPanel({ stride = 10, force = false, verbose = true } = {}) {
  const sig = { stride, ids: C.skillcorner20Ids(), cols: COLS };
  if (!force && existsSync(PANEL_PATH) && existsSync(META_PATH)) {
    const prev = JSON.parse(readFileSync(META_PATH, 'utf8'));
    if (JSON.stringify(prev.sig) === JSON.stringify(sig)) {
      if (verbose) console.error(`[panel] 缓存命中：${prev.nRows.toLocaleString()} 行（stride=${stride}）`);
      return prev;
    }
    if (verbose) console.error('[panel] 缓存签名不匹配，重建');
  }
  const meta = await computePanel(sig.ids, stride, verbose);
  meta.sig = sig;
  writeFileSync(META_PATH, JSON.stringify(meta));
  return meta;
}

/** 真正干活的部分：逐场流式写 JSONL。返回 meta（列名 + 单元表 + 行数）。 */
export async function computePanel(ids, stride = 10, verbose = true) {
  mkdirSync(DIR, { recursive: true });
  const ws = createWriteStream(PANEL_PATH);
  const units = [];               // 单元表：[{key, match, team, uid, line, group}]
  const unitIdx = new Map();
  let nRows = 0;
  let nFrames = 0;

  const unitOf = (match, team, uid, line, group) => {
    const key = `${match}|${team}|${uid}`;
    let i = unitIdx.get(key);
    if (i === undefined) { i = units.length; units.push({ key, match, team, uid, line, group }); unitIdx.set(key, i); }
    return i;
  };
  const write = (arr) => new Promise((res) => { if (!ws.write(arr)) ws.once('drain', res); else res(); });

  for (const id of ids) {
    const m = C.loadSkillcorner(id);
    const prev = new Map(); // 每个「队·人」的上一采样点
    let buf = '';
    for (let i = 0; i < m.frames.length; i += stride) {
      const f = m.frames[i];
      if (!f.ball) continue;
      const home = C.extractFrame(m, f, 'home', i);
      const away = C.extractFrame(m, f, 'away', i);
      if (!home && !away) continue;
      nFrames += 1;
      const period = Q.periodOf(m, i);
      for (const [team, e] of [['home', home], ['away', away]]) {
        if (!e) continue;
        for (const r of e.rows) {
          // ── 跨帧量（惯性/速度）：只在**同一 period** 内有效 ──
          // 跨半场换边时 yCanon 被镜像，Δy 无意义 → 断开（P38 §0.2-3）。
          let yPrev = NaN; let dyPrev = NaN; let dxPrev = NaN;
          const p = prev.get(`${id}|${team}|${r.uid}`);
          if (p && p.period === period) {
            const dt = f.t - p.t;
            if (dt > 1e-3 && dt <= stride * 0.2 * 2.5) {
              yPrev = p.y - p.mateY;
              dyPrev = (r.y - p.y) / dt;
              dxPrev = (r.x - p.x) / dt;
            }
          }
          prev.set(`${id}|${team}|${r.uid}`, { t: f.t, x: r.x, y: r.y, mateY: r.mateY, period });

          const d = r.dev;
          const row = new Array(NF).fill(NaN);
          row[IDX.unit] = unitOf(id, team, r.uid, r.line, r.group);
          row[IDX.t] = f.t;
          row[IDX.y] = r.dev.y;
          row[IDX.yAbs] = r.y;
          row[IDX.mateY] = r.mateY;
          row[IDX.cy] = e.cy;
          row[IDX.x] = r.x;
          row[IDX.ballX] = e.ballX;
          row[IDX.ballYAbs] = e.ballY;
          row[IDX.phase] = e.phase == null ? NaN : e.phase;
          row[IDX.ballObs] = e.ballObs ? 1 : 0;
          row[IDX.ballY] = d.ballY;
          row[IDX.ballDepth] = d.ballX;
          row[IDX.nearOppY] = d.nearOppY;
          row[IDX.k3OppY] = d.k3OppY;
          row[IDX.k5OppY] = d.k5OppY;
          row[IDX.oppCy] = d.oppCy;
          row[IDX.nearOppGap] = r.rel.nearOppGap;
          row[IDX.nearOppDist] = r.rel.nearOppDist;
          row[IDX.nearMateY] = d.nearMateY;
          row[IDX.k3MateY] = d.k3MateY;
          row[IDX.k5MateY] = d.k5MateY;
          row[IDX.nearMateGap] = r.rel.nearMateGap;
          row[IDX.nearMateDist] = r.rel.nearMateDist;
          row[IDX.k3AnyY] = d.k3AnyY;
          row[IDX.k5AnyY] = d.k5AnyY;
          row[IDX.nearAnyDist] = d.nearAnyDist;
          row[IDX.goalOwnY] = d.goalOwnY;
          row[IDX.goalOppY] = d.goalOppY;
          row[IDX.ownX] = r.x;
          row[IDX.xXphase] = e.phase == null ? NaN : r.x * (e.phase ? 1 : -1);
          row[IDX.ballXxPhase] = e.phase == null ? NaN : e.ballX * (e.phase ? 1 : -1);
          row[IDX.yPrev] = yPrev;
          row[IDX.dyPrev] = dyPrev;
          row[IDX.dxPrev] = dxPrev;
          // 数值压缩：定 3 位小数（0.001m 远低于 tracking 精度），NaN → null
          buf += `${row.map((v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)).join(',')}\n`;
          nRows += 1;
        }
      }
      if (buf.length > 1 << 20) { await write(buf); buf = ''; }
    }
    if (buf) await write(buf);
    if (verbose) console.error(`[panel] ${id} 完成（累计 ${nRows.toLocaleString()} 行）`);
  }
  await new Promise((res) => ws.end(res));
  if (verbose) console.error(`[panel] 完成：${nRows.toLocaleString()} 行 / ${nFrames.toLocaleString()} 帧·场采样点 / ${units.length} 单元`);
  return { cols: COLS, units, nRows, nFrames, path: PANEL_PATH };
}

// ── 读取 ────────────────────────────────────────────────────────────────

/**
 * 流式读取面板，对每行调用 fn(row:Float64Array, meta)。
 * **不把全部行留在内存**（第一版 OOM 的教训）。
 * @param {(row:Float64Array, meta:Object)=>void} fn
 * @param {{needLag?:boolean}} opts needLag=true 时跳过无跨帧量的行
 */
export async function readPanel(fn, { needLag = false, meta = null } = {}) {
  const M = meta || JSON.parse(readFileSync(META_PATH, 'utf8'));
  const rl = createInterface({ input: createReadStream(PANEL_PATH), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const parts = line.split(',');
    const row = new Float64Array(NF);
    for (let i = 0; i < NF; i += 1) {
      const s = parts[i];
      row[i] = (s === '' || s === 'null') ? NaN : Number(s);
    }
    if (needLag && !Number.isFinite(row[IDX.yPrev])) continue;
    fn(row, M);
    n += 1;
  }
  return n;
}

/** 同步读取 meta（列名 + 单元表）。 */
export function readMeta() { return JSON.parse(readFileSync(META_PATH, 'utf8')); }

/** 取某列的便捷函数。 */
export const col = (name) => IDX[name];
export { IDX };

// ── 因子表：name → 列（探针共用，改这里即改全部探针的定义）──────────────
//
// ⚠ 与 COLS 的对应是**显式**的：列名里有别名（ownX 与 x 同源、ballDepth 与 ballX 同源），
// 故意各留一份，方便按语义取用。
//
// ⚠⚠ **自指因子（`selfRef`）必须排除于一切多因子模型**（#101 踩过的大坑，留档）：
//
//   目标 `y = y_i − mateY`。而
//        nearMateGap = y_i − y_最近队友
//        nearMateY   = y_最近队友 − mateY
//   两者**代数上互补**：`nearMateGap + nearMateY ≡ y_i − mateY ≡ 目标`。
//   把两个都放进模型 → 模型用系数 (1,1) **精确重构**因变量，测试 R² = **1.0000**
//   （实测：本探针第一版就是这样，误报"横向 100% 可预测"）。
//   同理 `nearOppGap = y_i − y_最近对手` 也含 y_i。
//
//   规则：**DV 含 y_i ⟹ 因子不得含 y_i**。距离量（`nearMateDist` 等）虽由本人位置
//   算出，但不是 y_i 的线性函数，保留但标注。
//   单变量表可以报 `selfRef` 因子（它是有信息的相关），但**必须标注**其部分同义性。
export const FACTORS = [
  { name: 'ballY', group: '球', col: IDX.ballY },
  { name: 'ballDepth', group: '球（绝对）', col: IDX.ballX },
  { name: 'phase', group: '球', col: IDX.phase, signed: true },
  { name: 'nearOppY', group: '对手（k近）', col: IDX.nearOppY },
  { name: 'k3OppY', group: '对手（k近）', col: IDX.k3OppY },
  { name: 'k5OppY', group: '对手（k近）', col: IDX.k5OppY },
  { name: 'oppCy', group: '对手（重心）', col: IDX.oppCy },
  { name: 'nearOppGap', group: '对手（相对间距）', col: IDX.nearOppGap, selfRef: true },
  { name: 'nearOppDist', group: '对手（距离）', col: IDX.nearOppDist, selfPos: true },
  { name: 'nearMateY', group: '队友局部', col: IDX.nearMateY },
  { name: 'k3MateY', group: '队友局部', col: IDX.k3MateY },
  { name: 'k5MateY', group: '队友局部', col: IDX.k5MateY },
  { name: 'nearMateGap', group: '队友局部（间距）', col: IDX.nearMateGap, selfRef: true },
  { name: 'nearMateDist', group: '队友局部（距离）', col: IDX.nearMateDist, selfPos: true },
  { name: 'k3AnyY', group: '邻域', col: IDX.k3AnyY },
  { name: 'k5AnyY', group: '邻域', col: IDX.k5AnyY },
  { name: 'nearAnyDist', group: '邻域（距离）', col: IDX.nearAnyDist, selfPos: true },
  { name: 'goalOwnY', group: '球门方向', col: IDX.goalOwnY },
  { name: 'goalOppY', group: '球门方向', col: IDX.goalOppY },
  { name: 'ownX', group: '纵向（绝对）', col: IDX.x, selfPos: true },
  { name: 'xXphase', group: '纵向×相位', col: IDX.xXphase, selfPos: true },
  { name: 'ballXxPhase', group: '纵向×相位', col: IDX.ballXxPhase },
  { name: 'yPrev', group: '惯性（AR1）', col: IDX.yPrev, needLag: true, selfRef: true },
  { name: 'dyPrev', group: '惯性（速度）', col: IDX.dyPrev, needLag: true, selfRef: true },
  { name: 'dxPrev', group: '运动学（纵向速度）', col: IDX.dxPrev, needLag: true, selfPos: true },
];

/** 自检：把"自指因子"从多因子模型里剔除（DV 含 y_i 时）。 */
export const nonSelfRef = (names) => names.filter((n) => !FACTORS.find((f) => f.name === n).selfRef);

/** 从一行取因变量 y（主口径）。 */
export const dv = (row) => row[IDX.y];

// ── CLI ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const stride = Number(argOf('--stride', 10));
  const force = args.includes('--force');
  const meta = await buildPanel({ stride, force });
  console.log(`面板：${meta.nRows.toLocaleString()} 行 / ${meta.units.length} 单元 → ${PANEL_PATH}`);
}
