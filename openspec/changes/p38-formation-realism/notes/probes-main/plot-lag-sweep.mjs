// 线 A 曲线图：`DECOUPLE_LAG` → 场均射门 / 重心间距 / 纵深。**无依赖**，直接写 SVG。
//
// 为什么不用图库：项目硬约束是"从零写"，且 node_modules 是符号链接到主仓库的——
// 加图依赖会把这个符号链接依赖带进产物。SVG 是纯文本，手写几十行就够。
//
// 数据源（都在 out/，由 sweep-lag.mjs / sweep-variants.mjs 产出）：
//   lag-sweep.json  — 粗扫描 7 值
//   variants.jsonl  — 补点（variant=base）+ 变体（scope/curve/both）
//
// 用法：node plot-lag-sweep.mjs [out.svg]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const dst = process.argv[2] || join(OUT, 'lag-sweep.svg');

const rows = [];
if (existsSync(join(OUT, 'lag-sweep.json'))) {
  rows.push(...JSON.parse(readFileSync(join(OUT, 'lag-sweep.json'), 'utf8')).rows.map((r) => ({ ...r, variant: 'base' })));
}
if (existsSync(join(OUT, 'variants.jsonl'))) {
  rows.push(...readFileSync(join(OUT, 'variants.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
// **按 (variant, lag, curveK) 去重，保留最新一条**。
// 同一个配置被跑过两次的原因是口径修过（拼接 → 逐场，见 probe-latsd-caliber.mjs），
// 老行留在 jsonl 里；不去重就会画出两条同 lag 的点（图上看起来像抖动，其实是两个口径）。
const dedup = new Map();
for (const r of rows) dedup.set(`${r.variant}|${r.lag}|${r.curveK ?? ''}`, r);
const uniq = [...dedup.values()];
const base = uniq.filter((r) => r.variant === 'base').sort((a, b) => a.lag - b.lag);
const scope = uniq.filter((r) => r.variant === 'scope').sort((a, b) => a.lag - b.lag);
const curve = uniq.filter((r) => r.variant === 'curve').sort((a, b) => a.lag - b.lag);

// ── 布局 ──
const W = 980; const H = 560;
const M = { l: 78, r: 96, t: 56, b: 66 };
const PW = W - M.l - M.r; const PH = H - M.t - M.b;
const X_MIN = 0; const X_MAX = 0.42;
const S_MIN = 0; const S_MAX = 7;              // 左轴：场均普通射门
const G_MIN = 0; const G_MAX = 26;             // 右轴：重心间距（米）
const px = (lag) => M.l + ((lag - X_MIN) / (X_MAX - X_MIN)) * PW;
const pyS = (v) => M.t + PH - ((v - S_MIN) / (S_MAX - S_MIN)) * PH;
const pyG = (v) => M.t + PH - ((v - G_MIN) / (G_MAX - G_MIN)) * PH;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const path = (pts, X, Y) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif">`;
svg += `<rect width="${W}" height="${H}" fill="#0f1419"/>`;
svg += `<text x="${M.l}" y="28" fill="#e6edf3" font-size="17" font-weight="600">DECOUPLE_LAG 扫描：射门随滞后**单调上升**，重心间距同步恶化（无内部最优点）</text>`;
svg += `<text x="${M.l}" y="46" fill="#8b949e" font-size="12">基线 = exp4b 等间距块 + 候选03 两队解耦；10 种子 × 5400s/场；真实侧：普通射门 18/场，重心间距 8.3m</text>`;

// 网格 + 横轴
for (let i = 0; i <= 6; i += 1) {
  const v = S_MIN + (i / 6) * (S_MAX - S_MIN);
  svg += `<line x1="${M.l}" y1="${pyS(v)}" x2="${M.l + PW}" y2="${pyS(v)}" stroke="#21262d"/>`;
  svg += `<text x="${M.l - 10}" y="${pyS(v) + 4}" fill="#58a6ff" font-size="11" text-anchor="end">${v.toFixed(1)}</text>`;
}
for (const lag of [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]) {
  svg += `<line x1="${px(lag)}" y1="${M.t}" x2="${px(lag)}" y2="${M.t + PH}" stroke="#21262d"/>`;
  svg += `<text x="${px(lag)}" y="${M.t + PH + 20}" fill="#8b949e" font-size="11" text-anchor="middle">${lag.toFixed(2)}</text>`;
}
svg += `<text x="${M.l + PW / 2}" y="${H - 14}" fill="#8b949e" font-size="12" text-anchor="middle">DECOUPLE_LAG（归一化球场长；0.10 是候选03 的未调优初值）</text>`;
svg += `<text x="${M.l - 56}" y="${M.t + PH / 2}" fill="#58a6ff" font-size="12" text-anchor="middle" transform="rotate(-90 ${M.l - 56} ${M.t + PH / 2})">场均普通射门（左轴）</text>`;
svg += `<text x="${W - 22}" y="${M.t + PH / 2}" fill="#f0883e" font-size="12" text-anchor="middle" transform="rotate(90 ${W - 22} ${M.t + PH / 2})">重心间距 m（右轴）</text>`;

// 参照带：真实普通射门 18/场（超出左轴上限 → 画在顶部标线）；L1 门带 6–11
svg += `<rect x="${M.l}" y="${pyS(11)}" width="${PW}" height="${pyS(6) - pyS(11)}" fill="#238636" opacity="0.16"/>`;
svg += `<line x1="${M.l}" y1="${pyS(6)}" x2="${M.l + PW}" y2="${pyS(6)}" stroke="#3fb950" stroke-dasharray="5,4"/>`;
svg += `<line x1="${M.l}" y1="${pyS(11)}" x2="${M.l + PW}" y2="${pyS(11)}" stroke="#3fb950" stroke-dasharray="5,4"/>`;
svg += `<text x="${M.l + PW - 6}" y="${pyS(6) - 5}" fill="#3fb950" font-size="11" text-anchor="end">引擎 L1 门：普通射门 6–11/场</text>`;
// 真实重心间距 8.3m
svg += `<rect x="${M.l}" y="${pyG(10.14)}" width="${PW}" height="${pyG(6.54) - pyG(10.14)}" fill="#f0883e" opacity="0.12"/>`;
svg += `<text x="${M.l + 8}" y="${pyG(8.34) + 4}" fill="#f0883e" font-size="11">真实重心间距 8.3m（判据带 6.5–10.1）</text>`;

// 曲线
svg += `<path d="${path(base.map((r) => ({ x: r.lag, y: r.shotsRegularPerMatch })), px, pyS)}" fill="none" stroke="#58a6ff" stroke-width="2.5"/>`;
svg += `<path d="${path(base.map((r) => ({ x: r.lag, y: r.gap })), px, pyG)}" fill="none" stroke="#f0883e" stroke-width="2.5"/>`;
svg += `<path d="${path(scope.map((r) => ({ x: r.lag, y: r.shotsRegularPerMatch })), px, pyS)}" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.65"/>`;
svg += `<path d="${path(scope.map((r) => ({ x: r.lag, y: r.gap })), px, pyG)}" fill="none" stroke="#f0883e" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.65"/>`;

// 数据点（标注 nSeeds<10 的点）
for (const r of base) {
  svg += `<circle cx="${px(r.lag)}" cy="${pyS(r.shotsRegularPerMatch)}" r="4" fill="#58a6ff"/>`;
  svg += `<circle cx="${px(r.lag)}" cy="${pyG(r.gap)}" r="4" fill="#f0883e"/>`;
  if (r.nSeeds < 10) svg += `<text x="${px(r.lag)}" y="${pyS(r.shotsRegularPerMatch) - 10}" fill="#f85149" font-size="10" text-anchor="middle">n=${r.nSeeds}</text>`;
}

// 图例
const lg = [['#58a6ff', '场均普通射门（实线=全队解耦 base / 虚线=仅防线 scope，10 种子）', 0],
  ['#f0883e', '重心间距（米）— 越低越好，真实 8.3m', 1]];
for (const [c, t, i] of lg) {
  svg += `<rect x="${M.l}" y="${M.t + i * 20}" width="22" height="4" fill="${c}"/>`;
  svg += `<text x="${M.l + 30}" y="${M.t + i * 20 + 5}" fill="#8b949e" font-size="11.5">${esc(t)}</text>`;
}
svg += '</svg>';
writeFileSync(dst, svg);
console.log(`→ ${dst}`);
console.log(`base 点 ${base.length} 个（lag ${base.map((r) => r.lag).join(', ')}）`);
console.log(`scope 点 ${scope.length} 个；curve 点 ${curve.length} 个（curve 不在图上——见 lag-sweep.md 表）`);
