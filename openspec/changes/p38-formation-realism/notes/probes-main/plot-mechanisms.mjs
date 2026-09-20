// 线 B 曲线图：**swarm 对 latSd 的散点**——一眼看出"公共信号 vs 个体信号"的分野。
//
// 读法：
//   **左上角**（latSd 高 / swarm 低）= 个体各自动 = 想要的。
//   **右上角**（两个都高）= "一群鱼"（exp5 的失败模式）。
//   **右下角**（都低）= 基线（铁轨）。
// 右上角有一条**斜率为正的边界**（latSd 与 swarm 正相关）——那是"公共信号"的代价。
// 机制能否把点**压到那条边界的下方**，就是线 B 的全部问题。
//
// 用法：node plot-mechanisms.mjs [out.svg]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const dst = process.argv[2] || join(OUT, 'mechanisms.svg');

const rd = (f) => {
  const p = join(OUT, f);
  if (!existsSync(p)) return [];
  const t = readFileSync(p, 'utf8').trim();
  return t ? t.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const rows = [...rd('mechanisms.jsonl'), ...rd('combos.jsonl'), ...rd('variants.jsonl')];

const W = 900; const H = 560;
const M = { l: 76, r: 190, t: 56, b: 62 };
const PW = W - M.l - M.r; const PH = H - M.t - M.b;
const X = { min: 0, max: 10.5 };   // latSd
const Y = { min: 0, max: 1.0 };    // swarm
const px = (v) => M.l + ((v - X.min) / (X.max - X.min)) * PW;
const py = (v) => M.t + PH - ((v - Y.min) / (Y.max - Y.min)) * PH;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif">`;
svg += `<rect width="${W}" height="${H}" fill="#0f1419"/>`;
svg += `<text x="${M.l}" y="28" fill="#e6edf3" font-size="16" font-weight="600">swarm × latSd：公共信号（duty）vs 个体信号（local）</text>`;
svg += `<text x="${M.l}" y="46" fill="#8b949e" font-size="11.5">口径已修：逐场算再平均（拼接会虚高 6.5×，见 probe-latsd-caliber.mjs）。真实：latSd 10.5 / swarm 0.67</text>`;

for (let i = 0; i <= 7; i += 1) {
  const v = X.min + (i / 7) * (X.max - X.min);
  svg += `<line x1="${px(v)}" y1="${M.t}" x2="${px(v)}" y2="${M.t + PH}" stroke="#21262d"/>`;
  svg += `<text x="${px(v)}" y="${M.t + PH + 18}" fill="#8b949e" font-size="11" text-anchor="middle">${v.toFixed(1)}</text>`;
}
for (let i = 0; i <= 5; i += 1) {
  const v = Y.min + (i / 5) * (Y.max - Y.min);
  svg += `<line x1="${M.l}" y1="${py(v)}" x2="${M.l + PW}" y2="${py(v)}" stroke="#21262d"/>`;
  svg += `<text x="${M.l - 10}" y="${py(v) + 4}" fill="#8b949e" font-size="11" text-anchor="end">${v.toFixed(1)}</text>`;
}
svg += `<text x="${M.l + PW / 2}" y="${H - 16}" fill="#8b949e" font-size="12" text-anchor="middle">横向位移 sd (m) → 越右越好</text>`;
svg += `<text x="${M.l - 54}" y="${M.t + PH / 2}" fill="#8b949e" font-size="12" text-anchor="middle" transform="rotate(-90 ${M.l - 54} ${M.t + PH / 2})">swarm（y 两两相关）→ 越低越好</text>`;

// 判据带（真实 ± 容差）
const b = { lat: [7.015, 14.015], sw: [0.451, 0.891] };
svg += `<rect x="${px(b.lat[0])}" y="${py(b.sw[1])}" width="${Math.max(2, px(Math.min(b.lat[1], X.max)) - px(b.lat[0]))}" height="${py(b.sw[0]) - py(b.sw[1])}" fill="#238636" opacity="0.14"/>`;
svg += `<text x="${px(b.lat[0]) + 6}" y="${py(b.sw[1]) + 14}" fill="#3fb950" font-size="11">判据带（两条都达标才算过）</text>`;
svg += `<circle cx="${px(10.515)}" cy="${py(0.671)}" r="6" fill="none" stroke="#e6edf3" stroke-width="2"/>`;
svg += `<text x="${px(10.515) - 8}" y="${py(0.671) - 10}" fill="#e6edf3" font-size="11" text-anchor="end">真实</text>`;

// 分组上色
const STYLE = {
  duty: ['#f85149', '方形'], local: ['#3fb950', '圆'], both: ['#d29922', '菱形'], mark: ['#a371f7', '圆'],
};
for (const r of rows) {
  if (r.latSd == null || r.swarm == null || !Number.isFinite(r.latSd)) continue;
  if (r.latSd > X.max * 1.6) continue; // 超出画布的点不画（已被口径修正淘汰）
  const [c] = STYLE[r.mech] || ['#8b949e'];
  const cx = Math.min(px(r.latSd), M.l + PW); const cy = py(Math.min(r.swarm, Y.max));
  svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.combo ? 5 : 4}" fill="${c}"${r.combo ? ' stroke="#e6edf3" stroke-width="1.5"' : ''} opacity="0.9"/>`;
}
if (rows.some((r) => r.mech === 'local' && r.latSd < 0.7 && r.swarm < 0.35)) {
  svg += `<text x="${px(1.2)}" y="${py(0.16)}" fill="#3fb950" font-size="11">local：个体信号 → 左下（低 swarm）</text>`;
}
svg += `<text x="${px(2.2)}" y="${py(0.90)}" fill="#f85149" font-size="11">duty：公共信号 → 左上（高 swarm = 一群鱼）</text>`;

// 图例
let ly = M.t + 6;
svg += `<text x="${M.l + PW + 18}" y="${ly}" fill="#e6edf3" font-size="12" font-weight="600">图例</text>`;
ly += 20;
for (const [k, [c]] of Object.entries(STYLE)) {
  svg += `<circle cx="${M.l + PW + 24}" cy="${ly - 4}" r="5" fill="${c}"/>`;
  svg += `<text x="${M.l + PW + 36}" y="${ly}" fill="#8b949e" font-size="11.5">${esc(k)}</text>`;
  ly += 19;
}
svg += `<circle cx="${M.l + PW + 24}" cy="${ly - 4}" r="6" fill="none" stroke="#e6edf3" stroke-width="1.5"/>`;
svg += `<text x="${M.l + PW + 36}" y="${ly}" fill="#8b949e" font-size="11.5">+ exp4b 组合</text>`;
svg += '</svg>';
writeFileSync(dst, svg);
console.log(`→ ${dst}  点了 ${rows.filter((r) => Number.isFinite(r.latSd)).length} 个`);
