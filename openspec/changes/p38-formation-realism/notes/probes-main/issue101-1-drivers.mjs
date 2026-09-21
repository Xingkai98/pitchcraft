// wayfinder #101 探针 1：**换一组候选驱动**——真实球员横向位置的可解释性阶梯。
//
// ── 要回答什么 ──────────────────────────────────────────────────────────
// P38 #90 已测过并**排除**：球 y（R² 0.167）、局部球响应（0.241）、球队重心 y（0.262）、
// 最近对手 y（0.849，假象——换成最近队友也 0.73）。
//
// 本探针问：**剩下还有什么**。候选覆盖 #101 正文点名的每一条：
//   时间维度（惯性）/ 局部结构（相对间距）/ 球门方向 / 纵向×相位交互 / 运动学（朝向代理）/ 角色
//
// ── 两个因变量 ──────────────────────────────────────────────────────────
//   DV_ind  = y_i − mateY（留一）← **主因变量**：P38 报全模型只有 39–40%，未解释的 60% 正是要攻的
//   DV_team = 本队重心 cy        ← 对照 P38 #90 §2.2
//
// ── 反泄漏（P38 的两个坑）──────────────────────────────────────────────
//   1. 一切"队友侧"的量一律**留一**（不含本人）
//   2. 逐「场·队·人」单元算再平均，绝不跨场拼接
//
// 运行：node issue101-1-drivers.mjs
// 产出：out/101-1-drivers.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import { buildPanel, readPanel, FACTORS, IDX, NF, COLS } from './issue101-panel.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });
const nUnits = meta.units.length;

say('# #101 探针 1：横向位置的候选驱动（可解释性阶梯）\n');
say(`样本：SkillCorner **${C.skillcorner20Ids().length} 场**（P38 #90 是 6 场），面板 **0.5Hz（Δt = 2.0s）**：源 10fps → 产物 5Hz → stride 10。`);
say(`面板：**${meta.nRows.toLocaleString()}** 人·采样点，「场·队·人」单元 **${nUnits}** 个，${meta.nFrames.toLocaleString()} 帧·场采样点。`);
say('因变量主口径 = `y_i − mateY`（留一队友重心），即**个体相对队友的横向位置**。');
say('聚合 = 逐单元回归后跨单元平均（P38 口径，绝不跨场拼接）。\n');

// ── 1.1 单变量解释力（流式累积）──────────────────────────────────────────
say('## 1.1 单变量解释力（alone R²，逐「场·队·人」单元）\n');
say('> 每个因子**单独**对因变量回归；逐单元算 R² 再平均。缺失成列删除，n 是该因子可用的人·采样点数。\n');

// 每个因子的逐单元充分统计量：Map<unit, {n,sx,sy,sxx,sxy,syy}>
class UniAcc {
  constructor() { this.u = new Map(); }
  add(unit, x, y) {
    let a = this.u.get(unit);
    if (!a) { a = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }; this.u.set(unit, a); }
    a.n += 1; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
  }
  solve(minN = 60) {
    const r2s = []; const slopes = []; let n = 0;
    for (const a of this.u.values()) {
      if (a.n < minN) continue;
      const vx = a.sxx - a.n * (a.sx / a.n) ** 2;
      const vy = a.syy - a.n * (a.sy / a.n) ** 2;
      if (vx <= 1e-12 || vy <= 1e-12) continue;
      const sxy = a.sxy - a.n * (a.sx / a.n) * (a.sy / a.n);
      r2s.push((sxy * sxy) / (vx * vy)); slopes.push(sxy / vx); n += a.n;
    }
    return r2s.length ? { r2: C.mean(r2s), slope: C.mean(slopes), n, units: r2s.length } : { r2: null, slope: null, n: 0, units: 0 };
  }
}

const accs = new Map(FACTORS.map((f) => [f.name, { f, acc: new UniAcc(), cov: 0 }]));
await readPanel((row) => {
  const unit = row[IDX.unit];
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  for (const { f, acc } of accs.values()) {
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN; // phase: 1 控球 / 0 失球 / NaN 未知
    if (!Number.isFinite(v)) continue;
    acc.add(unit, v, y);
    // eslint-disable-next-line no-param-reassign
  }
});
// 覆盖率（第二次遍历太贵，用 n 与总行数比）
const uni = [];
for (const { f, acc } of accs.values()) {
  const res = acc.solve(60);
  uni.push({ ...f, ...res, cov: res.n / meta.nRows });
}
uni.sort((a, b) => (b.r2 ?? -1) - (a.r2 ?? -1));

say(C.tsv(['因子', '组', 'alone R²', '斜率', 'n（人·点）', '单元', '覆盖'],
  uni.map((u) => [u.name, u.group, C.f2(u.r2, 3), C.f2(u.slope, 3), u.n.toLocaleString(), u.units, `${(100 * u.cov).toFixed(0)}%`])));
say('');

const byGroup = new Map();
for (const u of uni) if (!byGroup.has(u.group) || (u.r2 ?? -1) > (byGroup.get(u.group).r2 ?? -1)) byGroup.set(u.group, u);
say('### 按候选类别的最佳单项\n');
say(C.tsv(['类别', '最佳因子', 'alone R²'], [...byGroup.values()].sort((a, b) => (b.r2 ?? -1) - (a.r2 ?? -1))
  .map((u) => [u.group, u.name, C.f2(u.r2, 3)])));
say('');

// ── 1.2 多因子：全模型 R² 与 unique R² ──────────────────────────────────
say('## 1.2 多因子模型：全模型 R² 与各因子的**唯一**贡献\n');
say('> `unique R²` = 全模型 R² − 去掉该因子后的 R²。共线严重时 alone 高而 unique 低');
say('> （P38 的 oppY/ballY 就是这样一对）。');
say('> ⚠ **全部为非自指因子**——DV 含 `y_i`，故因子不得含 `y_i`（见 panel 的 FACTORS 注释）。\n');

const MODEL = ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy',
  'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'];
const modelF = MODEL.map((n) => FACTORS.find((f) => f.name === n));
const MF = modelF.length;
const mCols = modelF.map((f) => f.col);

// 逐单元累积 XtX（全模型 + 每个 drop-one）
const drops = new Map(MODEL.map((_, k) => [k, new C.UnitOLS(MF - 1)]));
const fullAcc = new C.UnitOLS(MF);
let mRows = 0;
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const xs = new Float64Array(MF);
  for (let k = 0; k < MF; k += 1) {
    const f = modelF[k];
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
    if (!Number.isFinite(v)) return;
    xs[k] = v;
  }
  const u = row[IDX.unit];
  fullAcc.add(u, xs, y);
  for (const [k, acc] of drops) {
    const sub = new Float64Array(MF - 1); let t = 0;
    for (let i = 0; i < MF; i += 1) if (i !== k) sub[t++] = xs[i];
    acc.add(u, sub, y);
  }
  mRows += 1;
});
const rf = fullAcc.solve({ minN: 60 });
const uq = [];
for (const [k, acc] of drops) {
  const rd = acc.solve({ minN: 60 });
  uq.push({ name: MODEL[k], alone: uni.find((u) => u.name === MODEL[k])?.r2 ?? null,
    unique: rf.r2 != null && rd.r2 != null ? rf.r2 - rd.r2 : null, beta: rf.beta ? rf.beta[k + 1] : null });
}
uq.sort((a, b) => (b.unique ?? -1) - (a.unique ?? -1));

say(`进入全模型的行：**${mRows.toLocaleString()}** / ${meta.nRows.toLocaleString()}（成列删除）`);
say(`**全模型 R²（逐单元平均）= ${C.f2(rf.r2, 3)}**（${rf.units} 单元）\n`);
say(C.tsv(['因子', 'alone R²', 'unique R²', 'β'],
  uq.map((u) => [u.name, C.f2(u.alone, 3), C.f2(u.unique, 3), C.f2(u.beta, 3)])));
say('');
say('> **读法**：`unique R²` **不能相加当全模型 R²**——共线因子共享的方差两边都不计入。');
say('> 若所有 unique 都接近 0 而全模型 R² 高 → 这些因子是**同一件事的不同侧面**。');
say('> 探测"局部结构"是否为真信号见**探针 6（置换零假设）**。\n');

writeFileSync(join(C.OUT_DIR, '101-1-drivers.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-1-drivers.txt')}`);
