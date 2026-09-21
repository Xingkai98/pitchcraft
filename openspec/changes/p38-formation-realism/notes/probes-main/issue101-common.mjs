// wayfinder #101：**真实球员的横向位置由什么驱动**——共用装载器与统计工具。
//
// ── 与 P38 #90（q90-common.mjs）的关系 ──────────────────────────────────
// 装载层的**口径完全一致**并直接复用 `q90-common.mjs`：
//   - 客队镜像、x 统一到"离本方门线距离"
//   - 横向朝向归一 `yCanon`（半场换边 = 绕中心 180° 旋转，只翻 x 不翻 y 是镜像 bug）
//   - 逐场球场尺寸（104/105/106 不折算）
//   - 全点口径（外推点默认采信）——**显式声明**，见 `caliber` 字段
//   - 剔门将、每队非门将 < 7 人丢帧
// 本文件新增的只有**驱动因子**（candidates）与**建模工具**（正则化 OLS / 梯度提升 / kNN）。
//
// ── 样本 ────────────────────────────────────────────────────────────────
// **SkillCorner 全 20 场**（#101 的方法要求：比 Metrica 2 场大 10 倍，样本更足）。
// 场次清单从 `.scratch/p38-frames/convert-summary-20.json` 取**实际转换成功**的场，
// 不写死列表——样本量变化时报告数字与声称的样本量不会脱节。
//
// ⚠ **不硬编码 worktree 绝对路径**（P38 踩过四次）：一切路径从本文件位置上溯仓库根。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from './q90-common.mjs';
import { findRepoRoot } from '../probes/repo-root.mjs';
import * as rolesMod from '../probes/roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = findRepoRoot(HERE);
export const OUT_DIR = join(HERE, 'out');
export const { mean, std, PITCH_WIDTH_M, PITCH_LENGTH_M, KEEPER_IDS } = Q;

const corpus = Q.corpus;

// ── 装载：SkillCorner 全 20 场 ──────────────────────────────────────────

const SUMMARY = join(REPO, '.scratch', 'p38-frames', 'convert-summary-20.json');

/** 转换成功（且朝向自检通过）的场次 id，升序。 */
export function skillcorner20Ids() {
  if (!existsSync(SUMMARY)) {
    throw new Error(`缺少 ${SUMMARY}——先跑：node ${join(HERE, 'issue101-convert-all.mjs')}`);
  }
  const rows = JSON.parse(readFileSync(SUMMARY, 'utf8'));
  return rows.filter((r) => !r.skipped && r.meta).map((r) => r.id).sort();
}

/**
 * 装载一场 SkillCorner（帧 + 角色表 + 相位侧信道）。
 * 与 q90-common 的 `decorate` 同一构造，只是 id 不写死、可传入。
 */
export function loadSkillcorner(id) {
  const m = corpus.loadMatch('skillcorner', id);
  const roles = rolesMod.loadSkillcornerRoles(id);
  const phase = Q.loadSkillcornerPhase(id) || Q.buildSkillcornerPhase(id);
  return { id, dataset: 'skillcorner', frames: m.frames, meta: m.meta, roles, phase };
}

/** Metrica 两场（交叉核对用；口径与 P38 一致）。Metrica 无相位侧信道，相位退回最近球员代理。 */
export function loadMetrica() {
  return Q.METRICA_IDS.map((id) => {
    const m = corpus.loadMatch('metrica', id);
    return { id, dataset: 'metrica', frames: m.frames, meta: m.meta, roles: null, phase: null };
  });
}

/** 全 20 场 SkillCorner。 */
export function loadAll20() {
  return skillcorner20Ids().map(loadSkillcorner);
}

// ── 驱动因子 ────────────────────────────────────────────────────────────
//
// 每帧每队提取一组候选驱动。**一切"队友侧"的量一律留一**（不含本人），
// 否则 y_i 会出现在自己的自变量里，模型能精确重构因变量（P38 首版实测 R²=100%）。
//
// 单位：米。y 全部是 yCanon（该队"左"恒为 y 小的一侧）。

const K_LIST = [1, 3, 5]; // 最近邻的 k

/** 按 2D 距离取 k 近的球员（不含本人）。返回按距离升序的数组。 */
function kNearest(self, pool, k) {
  const d = pool
    .filter((q) => q.id !== self.id)
    .map((q) => ({ p: q, d2: (q.x - self.x) ** 2 + (q.y - self.y) ** 2 }))
    .sort((a, b) => a.d2 - b.d2);
  return d.slice(0, k).map((o) => o.p);
}

/**
 * 球门方向约束：球 → 球门 连线在"球员纵向位置"处的横向坐标。
 *
 * 语义：若球员站位是为了"堵住球到本方球门的通道"（防守）或"接应球到对方球门的
 * 通道"（进攻），他的 y 应当靠近这条线。两个球门都在 y = W/2（中线）。
 *
 * @param ballX 球离**本方**门线的距离（米）
 * @param x     球员离本方门线的距离（米）
 * @param goalX 目标门离本方门线的距离（0 = 本方门，L = 对方门）
 * 返回 null 当球与门线几乎重合（分母退化）。
 */
function yOnBallGoalLine(ballX, ballY, x, goalX, L) {
  const den = goalX - ballX;
  if (Math.abs(den) < 2) return null; // 球已在门线上/之后：连线无意义
  const s = (x - ballX) / den;
  return ballY + s * (PITCH_WIDTH_M / 2 - ballY);
}

/**
 * 提取一帧一队的**队伍层 + 个体层**驱动。
 * 返回 { cy, oppCy, ballY, ballX, phase, phaseKnown, ballObs, rows: [...] }；不可用返回 null。
 *
 * 每行（球员）：
 *   { uid, group, line, x, y,
 *     dev: {...}  相对**留一队友重心** mateY 的偏差（个体层的因变量与自变量都在这层）}
 *   dev.y 就是个体层的因变量（y_i − mateY）。
 */
export function extractFrame(m, frame, team, idx, { includeExtrapolated = true } = {}) {
  if (!frame || !frame.ball) return null;
  const [L] = frame.pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const mine = Q.framePlayers(m, frame, team, { idx, includeExtrapolated });
  if (mine.length < 7) return null; // MIN_OUTFIELD_PLAYERS（与 match-metrics 同口径）

  const theirs = Q.frameOpponents(m, frame, team, { idx, includeExtrapolated });
  const ballY = Q.ballYCanon(m, frame, team, idx);
  const ballX = Q.ballXCanon(m, frame, team, idx);
  if (ballY == null || ballX == null) return null;

  const phase = Q.phaseOf(m, frame, team, idx); // 1 本方控球 / 0 对方 / null 未知
  // 球是否是原始观测帧（SkillCorner）；Metrica 全部视为观测。
  const ballObs = !m.phase || m.phase.ballDet[idx] === 1;

  const cy = mean(mine.map((p) => p.y));
  const oppCy = theirs.length ? mean(theirs.map((p) => p.y)) : null;

  const rows = [];
  for (const p of mine) {
    const mates = mine.filter((q) => q.id !== p.id);
    const mateY = mean(mates.map((q) => q.y)); // 留一
    // 邻居：队友（不含本人）与对手，各自按 2D 距离取 k 近
    const nMates = {};
    for (const k of K_LIST) nMates[k] = kNearest(p, mates, k);
    const nOpps = {};
    for (const k of K_LIST) nOpps[k] = kNearest(p, theirs, k);
    // 局部邻域（两队混池，不含本人）
    const pool = [...mates, ...theirs];
    const nearestAnyone = kNearest(p, pool, 1)[0] || null;
    const nAny = {};
    for (const k of K_LIST) nAny[k] = kNearest(p, pool, k);

    rows.push({
      uid: p.id,
      group: p.group || null,
      line: p.line || null,
      x: p.x,
      y: p.y,
      // 队友重心（留一）——个体层的基准
      mateY,
      dev: {
        // ── 因变量 ──
        y: p.y - mateY,
        // ── 球 ──
        ballY: ballY - mateY,
        ballX, // 球离本方门线距离（绝对，不是偏差）
        // ── 对手 ──
        oppCy: oppCy == null ? null : oppCy - mateY,
        nearOppY: nOpps[1].length ? nOpps[1][0].y - mateY : null,
        k3OppY: nOpps[3].length ? mean(nOpps[3].map((q) => q.y)) - mateY : null,
        k5OppY: nOpps[5].length ? mean(nOpps[5].map((q) => q.y)) - mateY : null,
        // ── 队友（局部结构）──
        nearMateY: nMates[1].length ? nMates[1][0].y - mateY : null,
        k3MateY: nMates[3].length ? mean(nMates[3].map((q) => q.y)) - mateY : null,
        k5MateY: nMates[5].length ? mean(nMates[5].map((q) => q.y)) - mateY : null,
        // ── 局部邻域（不分队）──
        k3AnyY: nAny[3].length ? mean(nAny[3].map((q) => q.y)) - mateY : null,
        k5AnyY: nAny[5].length ? mean(nAny[5].map((q) => q.y)) - mateY : null,
        nearAnyDist: nearestAnyone
          ? Math.hypot(nearestAnyone.x - p.x, nearestAnyone.y - p.y) : null,
        // ── 球门方向约束 ──
        goalOwnY: (() => {
          const v = yOnBallGoalLine(ballX, ballY, p.x, 0, L);
          return v == null ? null : v - mateY;
        })(),
        goalOppY: (() => {
          const v = yOnBallGoalLine(ballX, ballY, p.x, L, L);
          return v == null ? null : v - mateY;
        })(),
      },
      // 相对队友的**二维**局部结构（不是绝对 y，而是相对位置关系）
      rel: {
        // 我与最近队友的 y 间距（正 = 我在他右边）
        nearMateGap: nMates[1].length ? p.y - nMates[1][0].y : null,
        nearOppGap: nOpps[1].length ? p.y - nOpps[1][0].y : null,
        nearMateDist: nMates[1].length
          ? Math.hypot(nMates[1][0].x - p.x, nMates[1][0].y - p.y) : null,
        nearOppDist: nOpps[1].length
          ? Math.hypot(nOpps[1][0].x - p.x, nOpps[1][0].y - p.y) : null,
      },
    });
  }

  return { L, cy, oppCy, ballY, ballX, phase, phaseKnown: phase != null, ballObs, rows };
}

// ── 统计工具 ────────────────────────────────────────────────────────────

/**
 * 逐单元最小二乘累加器：按 (场, 队, 球员) 分组累积正规方程，各自求解后**跨单元平均**。
 *
 * 为什么这样：P38 的口径教训是"**逐场算再平均**"——跨场拼接会把场间偏移算进方差
 * （latSd 虚高 6.5× 且**奖励 hack**）。回归同理：把 20 场拼成一个大回归，
 * 场间差异会被当成"可解释方差"，而那不是同一场比赛内的可预测性。
 *
 * 用法：
 *   const acc = new UnitOLS(F);
 *   acc.add(unitKey, x /* Float64Array(F) *\/, y);
 *   const res = acc.solve();   // { perUnit: [{key,n,beta,r2}], beta: 均值, r2: 均值, n }
 */
export class UnitOLS {
  constructor(F) {
    this.F = F;
    this.K = F + 1; // 含截距
    this.units = new Map();
  }

  add(key, x, y) {
    let u = this.units.get(key);
    if (!u) {
      u = { key, n: 0, XtX: new Float64Array(this.K * this.K), Xty: new Float64Array(this.K), syy: 0, sy: 0 };
      this.units.set(key, u);
    }
    const { K } = this;
    const { XtX, Xty } = u;
    // 扩充为含截距的一行：row = [1, x0, x1, ...]
    for (let i = 0; i < K; i += 1) {
      const xi = i === 0 ? 1 : x[i - 1];
      if (xi === 0) continue;
      for (let j = 0; j < K; j += 1) {
        const xj = j === 0 ? 1 : x[j - 1];
        XtX[i * K + j] += xi * xj;
      }
      Xty[i] += xi * y;
    }
    u.n += 1; u.sy += y; u.syy += y * y;
  }

  /** 逐单元解正规方程（含岭正则化，防共线退化）。返回每单元系数、R² 与跨单元均值。 */
  solve({ ridge = 1e-8, minN = 200 } = {}) {
    const perUnit = [];
    for (const u of this.units.values()) {
      if (u.n < minN) continue;
      const beta = solveNormal(u.XtX, u.Xty, this.K, ridge);
      if (!beta) continue;
      // R² = 1 − SSE/SST（SST 用单元内的 y 方差，含截距的 OLS 同一分解）
      let sse = u.syy - 2 * dot(beta, u.Xty) + quad(beta, u.XtX, this.K);
      const my = u.sy / u.n;
      const sst = u.syy - u.n * my * my;
      const r2 = sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0;
      perUnit.push({ key: u.key, n: u.n, beta, r2 });
    }
    if (!perUnit.length) return { perUnit: [], beta: null, r2: null, n: 0 };
    const K = this.K;
    const beta = new Float64Array(K);
    for (const u of perUnit) for (let i = 0; i < K; i += 1) beta[i] += u.beta[i];
    for (let i = 0; i < K; i += 1) beta[i] /= perUnit.length;
    const r2 = mean(perUnit.map((u) => u.r2));
    const n = perUnit.reduce((s, u) => s + u.n, 0);
    return { perUnit, beta, r2, n, units: perUnit.length };
  }
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; }
function quad(b, A, K) {
  let s = 0;
  for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) s += b[i] * A[i * K + j] * b[j];
  return s;
}

/** 解 (A + λI) β = b（高斯-约当，含部分主元）。奇异返回 null。 */
function solveNormal(A, b, K, ridge) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? ridge : 0);
    M[i * (K + 1) + K] = b[i];
  }
  for (let c = 0; c < K; c += 1) {
    let piv = c;
    for (let r = c + 1; r < K; r += 1) {
      if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[piv * (K + 1) + c])) piv = r;
    }
    if (Math.abs(M[piv * (K + 1) + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let j = c; j <= K; j += 1) {
        const t = M[c * (K + 1) + j]; M[c * (K + 1) + j] = M[piv * (K + 1) + j]; M[piv * (K + 1) + j] = t;
      }
    }
    const d = M[c * (K + 1) + c];
    for (let j = c; j <= K; j += 1) M[c * (K + 1) + j] /= d;
    for (let r = 0; r < K; r += 1) {
      if (r === c) continue;
      const f = M[r * (K + 1) + c];
      if (f === 0) continue;
      for (let j = c; j <= K; j += 1) M[r * (K + 1) + j] -= f * M[c * (K + 1) + j];
    }
  }
  const out = new Float64Array(K);
  for (let i = 0; i < K; i += 1) out[i] = M[i * (K + 1) + K];
  return out;
}

/**
 * 逐单元单变量回归（DV ~ 1 + x），跨单元平均 R²。
 * 用于"某个候选驱动单独解释多少"——与 UnitOLS 同一口径（逐场再平均）。
 */
export function univariateByUnit(pairs, minN = 200) {
  const units = new Map();
  for (const { key, x, y } of pairs) {
    let u = units.get(key);
    if (!u) { u = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }; units.set(key, u); }
    u.n += 1; u.sx += x; u.sy += y; u.sxx += x * x; u.sxy += x * y; u.syy += y * y;
  }
  const r2s = []; const slopes = []; let n = 0;
  for (const u of units.values()) {
    if (u.n < minN) continue;
    const vx = u.sxx - u.n * (u.sx / u.n) ** 2;
    const vy = u.syy - u.n * (u.sy / u.n) ** 2;
    if (vx <= 1e-12 || vy <= 1e-12) continue;
    const sxy = u.sxy - u.n * (u.sx / u.n) * (u.sy / u.n);
    const b = sxy / vx;
    const r2 = (sxy * sxy) / (vx * vy);
    r2s.push(r2); slopes.push(b); n += u.n;
  }
  if (!r2s.length) return { r2: null, slope: null, n: 0, units: 0 };
  // 跨单元均值（n 加权，与"逐场算再平均"同义：先各场算、再平均）
  return { r2: mean(r2s), slope: mean(slopes), n, units: r2s.length };
}

/**
 * 增量式"唯一解释力"：对每个因子算 **ΔR² = R²(全模型) − R²(去掉该因子)**。
 * 与逐因子单独回归（alone R²）并列给出——两者回答不同问题：
 *   alone R²   = 这个因子自己有多少信息
 *   unique R²  = 别的因子已经在场时，它还多带来多少
 * 共线严重时 alone 高而 unique 低（P38 的 oppY/ballY 就是这一对）。
 */
export function uniqueContributions(F, rowsFn, factorIdx, minN = 200, ridge = 1e-6) {
  const full = new UnitOLS(F);
  const dropped = new Map();
  const dF = F - 1;
  for (const idx of factorIdx) dropped.set(idx, new UnitOLS(dF));
  for (const { key, x, y } of rowsFn()) {
    full.add(key, x, y);
    for (const [idx, acc] of dropped) {
      const xs = new Float64Array(dF);
      let t = 0;
      for (let i = 0; i < F; i += 1) { if (i !== idx) xs[t++] = x[i]; }
      acc.add(key, xs, y);
    }
  }
  const rf = full.solve({ minN, ridge });
  const out = new Map();
  for (const [idx, acc] of dropped) {
    const rd = acc.solve({ minN, ridge });
    out.set(idx, { alone: null, unique: rf.r2 != null && rd.r2 != null ? rf.r2 - rd.r2 : null });
  }
  return { full: rf, unique: out };
}

// ── 可预测性上限：梯度提升树（GBM）────────────────────────────────────────
//
// **为什么自己写**（不引依赖）：项目约束是"不依赖现成框架/库"，且要能在
// **留一场**（leave-one-match-out）下评估泛化——sklearn 式的现成实现既进不来也不透明。
// 这里实现最小可用的回归树 + 梯度提升（平方损失），足够给"可解释方差上限"一个诚实读数。
//
// 唯一要小心的：**不能把测试场的信息带进训练**。故接口按"逐场独立调用"设计，
// 由调用方保证训练/测试场次不重叠。

// ── 实现注记：为什么是"预排序 + 直方图"而不是"每节点重排序"──────────────
// 第一版每个节点对每个特征都 `idx.slice().sort()`——实测 100k 行 × 14 特征 × 深度 3
// 下 **3.4 s/棵**，80 棵 = 4.5 分钟/折，20 折 LOOMO 要 90 分钟（不可行）。
// 优化：**每个特征预排序一次**（全局，O(F·n log n)），节点切分时把落入该节点的行
// 按"该特征预排序序"扫一遍即可（O(n) per feature per node），总代价降到 ~1/20。
// 数值等价（同一组候选切分、同一 SSE 判据），只是不重复排序。
function presort(X, idx) {
  const F = X[0].length;
  const orders = [];
  for (let f = 0; f < F; f += 1) {
    const o = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
    orders.push(o);
  }
  return orders;
}

/**
 * 回归树（CART，平方损失）。`orders` = 预排序索引（见 presort）。
 *
 * 切分扫描的实现要点（两版优化的教训，留档）：
 *    v1 每节点对每特征重新 `.sort()` → 3.4 s/棵（100k 行）。
 *    v2 预排序 + `Set` 判归属 + 跳过非本节点行 → 1.7 s/棵（Set 慢 + 重复扫跳过段）。
 *    v3（本版）预排序 + **逐特征把本节点行过滤成连续数组**后再扫 → 内层无分支、
 *        无哈希查找，实测再快约 4×。数值与前两版**逐位等价**（同一候选集合、同一 SSE 判据）。
 */
function fitTree(X, y, idx, orders, depth, { maxDepth, minLeaf }, mask) {
  const n = idx.length;
  let sy = 0;
  for (const i of idx) sy += y[i];
  const node = { value: sy / n };
  if (depth >= maxDepth || n < 2 * minLeaf) return node;

  const F = X[0].length;
  // `mask` 由调用方按 X.length 一次性分配（每节点新分配 1MB 会造成大量 GC）。
  for (const i of idx) mask[i] = 1;

  let best = null;
  for (let f = 0; f < F; f += 1) {
    // 过滤出"属于本节点"的行，保持该特征的预排序序（连续数组，内层无分支）
    const o = orders[f];
    const col = [];
    for (let t = 0; t < o.length; t += 1) if (mask[o[t]] === 1) col.push(o[t]);
    let sl = 0; let nl = 0; let sr = sy; let nr = n;
    for (let t = 0; t < col.length - 1; t += 1) {
      const i = col[t];
      sl += y[i]; nl += 1; sr -= y[i]; nr -= 1;
      if (nl < minLeaf || nr < minLeaf) continue;
      const vl = X[i][f]; const vr = X[col[t + 1]][f];
      if (vl === vr) continue;
      const sse = sl * sl / nl + sr * sr / nr;
      if (!best || sse > best.sse) best = { f, thr: (vl + vr) / 2, sse };
    }
  }
  for (const i of idx) mask[i] = 0;

  if (!best) return node;
  const left = []; const right = [];
  for (const i of idx) (X[i][best.f] <= best.thr ? left : right).push(i);
  if (!left.length || !right.length) return node;
  node.f = best.f; node.thr = best.thr;
  node.left = fitTree(X, y, left, orders, depth + 1, { maxDepth, minLeaf }, mask);
  node.right = fitTree(X, y, right, orders, depth + 1, { maxDepth, minLeaf }, mask);
  return node;
}

function predictTree(node, x) {
  while (node.f !== undefined) node = x[node.f] <= node.thr ? node.left : node.right;
  return node.value;
}

/**
 * 梯度提升回归。返回 { predict(x), trainR2, nTrees }。
 * @param X Array<Float64Array|number[]>
 * @param opts {nTrees, lr, maxDepth, minLeaf, subsample, seed}
 */
export function fitGBM(X, y, { nTrees = 120, lr = 0.08, maxDepth = 4, minLeaf = 200, subsample = 0.6, seed = 1 } = {}) {
  const n = X.length;
  const rnd = mulberry32(seed);
  const pred = new Float64Array(n).fill(mean(y));
  const trees = [];
  const all = Array.from({ length: n }, (_, i) => i);
  const mask = new Uint8Array(n); // 复用于所有树/节点（避免每节点 1MB 的分配）
  // ⚠ **预排序在整份训练集上做一次**，全树复用。
  // 第一版在**每棵树**里对子样本重新 presort——代价 14 特征 × n log n × nTrees，
  // 80 棵 × 36k 行 ≈ 6 亿次比较/折，是真正的瓶颈（实测单折 >10 分钟）。
  // 复用后：子样本只通过 `mask` 生效（fitTree 会过滤掉不在本节点的行），
  // 扫描时会多走一些不属于本树的行（约 1/0.6 = 1.7×），但总代价降一个量级。
  const orders = presort(X, all);
  for (let t = 0; t < nTrees; t += 1) {
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i += 1) resid[i] = y[i] - pred[i];
    let idx = all;
    if (subsample < 1) {
      idx = all.filter(() => rnd() < subsample);
      if (idx.length < 4 * minLeaf) idx = all;
    }
    const tree = fitTree(X, resid, idx, orders, 0, { maxDepth, minLeaf }, mask);
    trees.push(tree);
    for (let i = 0; i < n; i += 1) pred[i] += lr * predictTree(tree, X[i]);
  }
  return {
    nTrees: trees.length,
    predict: (x) => { let s = 0; for (const tr of trees) s += lr * predictTree(tr, x); return s; },
    predictAvg: null,
    _bias: mean(y),
  };
}

/** 用 GBM 对一批行做预测（含初始值）。 */
export function predictGBM(model, X) {
  const out = new Float64Array(X.length);
  for (let i = 0; i < X.length; i += 1) out[i] = model.predict(X[i]);
  return out;
}

/** 拟合前的偏置必须显式加回（树拟合的是残差，初始预测 = 训练集均值）。 */
export function gbmFit(X, y, opts) {
  const m = fitGBM(X, y, opts);
  const bias = m._bias;
  return {
    ...m,
    predict: (x) => bias + m.predict(x),
    predictAll: (Xx) => Float64Array.from(Xx, (x) => bias + m.predict(x)),
  };
}

export function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** R²（对给定 y 与预测 pred）。 */
export function r2Of(y, pred) {
  const my = mean(y);
  let sse = 0; let sst = 0;
  for (let i = 0; i < y.length; i += 1) { sse += (y[i] - pred[i]) ** 2; sst += (y[i] - my) ** 2; }
  return sst > 0 ? 1 - sse / sst : 0;
}

/** 分层抽样：每 stride 行取 1（保证时间上均匀，避免连续帧挤在同一动作里）。 */
export function strided(rows, stride) {
  return rows.filter((_, i) => i % stride === 0);
}

/** 简单的 ANSI 表格打印（与 q90 的 table 同风格）。 */
export function tsv(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((v) => (v == null ? '-' : String(v))));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  return all.map((r) => r.map((v, i) => String(v ?? '-').padEnd(w[i])).join('  ')).join('\n');
}

export const f2 = (v, d = 2) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
