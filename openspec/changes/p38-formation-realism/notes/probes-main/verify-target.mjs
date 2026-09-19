// 独立验证方法论审阅的核心主张：靶子 18.31m 是「跳过外推点」的构造性产物。
//
// 主张（方法论审阅）：SkillCorner 的外推率按**队形深度排名**呈 U 形——
//   最深的人 57.1% 外推、中间 27.7%、最前 46.7%。
//   跳过外推点 = 系统性削掉队形**两端** → 纵深被人为压小。
// 若成立：同口径下 Metrica 与 SkillCorner 应当接近（~25），而非 18.31。
//
// 本脚本独立实现（不复用审阅者的代码），用 4 种口径算纵深：
//   A. 全点（含外推）
//   B. 仅真检测（P37 主口径）
//   C. 随机 k 子集（n 匹配对照：从全点里随机抽 k 个，k = 该帧真检测数）
//   D. 两端的检测率（检验 U 形）

import { readFileSync, readdirSync } from 'node:fs';

const SC_DIR = '/home/happy/.claude/worktrees/wayfinder-realism/.scratch/p38-frames';
const L = 105;

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function q(s, p) { const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); }

// 确定性 RNG（禁止 Math.random，保证可复现）
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

console.log('=== 检查 A：SkillCorner 外推率 vs 队形深度排名 ===');
console.log('（每帧把该队非门将按深度排序，统计各次序位置的外推比例）');

// 帧格式：players[[x,y]|null] 或 [x,y,1]（第三位=外推）；先探测实际格式
const files = readdirSync(SC_DIR).filter((f) => f.endsWith('.json') && f.includes('skillcorner')).slice(0, 3);
console.log('样本文件:', files.join(', '));
if (files.length === 0) { console.log('⚠️ 没找到 skillcorner 转换产物，看目录：'); console.log(readdirSync(SC_DIR).slice(0, 20)); process.exit(0); }

const detByRank = Array.from({ length: 10 }, () => ({ det: 0, tot: 0 }));
const depths = { all: [], det: [], matched: [] };
let ndep = 0;

for (const f of files) {
  const g = JSON.parse(readFileSync(`${SC_DIR}/${f}`, 'utf8'));
  const pitchM = g.meta?.pitchMeters?.[0] || L;
  for (const fr of g.frames) {
    for (const team of ['home', 'away']) {
      // 收集该队非门将：{x, extrap}
      const ps = [];
      for (let id = 0; id < 22; id += 1) {
        const p = fr.players[id];
        if (!p) continue;
        const isHome = id <= 10;
        if (team === 'home' ? !isHome : isHome) continue;
        if (id === 0 || id === 21) continue; // 门将
        const extrap = Array.isArray(p) ? p[2] === 1 : !!p.extrapolated;
        const x = Array.isArray(p) ? p[0] : p.x;
        ps.push({ x, extrap });
      }
      if (ps.length < 7) continue;
      // 统一到「离本方门线距离」
      const xsAll = ps.map((p) => ({ v: (team === 'home' ? p.x : 1 - p.x) * pitchM, e: p.extrap }));
      const det = xsAll.filter((p) => !p.e);
      // 排序后按次序记检测率
      const sorted = [...xsAll].sort((a, b) => a.v - b.v);
      for (let i = 0; i < 10; i += 1) { detByRank[i].tot += 1; if (!sorted[i].e) detByRank[i].det += 1; }
      ndep += 1;
      // 口径 A：全点
      const a = sorted.map((p) => p.v);
      depths.all.push(q(a, 0.9) - q(a, 0.1));
      // 口径 B：仅真检测
      if (det.length >= 7) {
        const b = det.map((p) => p.v).sort((x, y) => x - y);
        depths.det.push(q(b, 0.9) - q(b, 0.1));
        // 口径 C：n 匹配——从全点随机抽 k=det.length 个
        const rng = mulberry32(ndep * 7919 + 13);
        const idx = [...a.keys()];
        for (let i = idx.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        const sub = idx.slice(0, det.length).map((i) => a[i]).sort((x, y) => x - y);
        depths.matched.push(q(sub, 0.9) - q(sub, 0.1));
      }
    }
  }
}

console.log('\n次序位置  真检测率');
for (let i = 0; i < 10; i += 1) {
  const r = detByRank[i];
  console.log(`  ${String(i + 1).padStart(2)}     ${(100 * r.det / r.tot).toFixed(1)}%   (n=${r.tot})`);
}

console.log(`\n=== 检查 B：三种口径的纵深（SkillCorner，${files.length} 场，${ndep} 帧·队）===`);
const f2 = (v) => v.toFixed(2);
console.log(`  A 全点（含外推）      ${f2(mean(depths.all))}   n=${depths.all.length}`);
console.log(`  B 仅真检测（P37主口径） ${f2(mean(depths.det))}   n=${depths.det.length}`);
console.log(`  C n 匹配随机子集       ${f2(mean(depths.matched))}   n=${depths.matched.length}`);
console.log('\n  → 若 B 明显小于 A，而 C 接近 A，说明差距主要是**人数效应**；');
console.log('    若 B 与 C 都明显小于 A，说明是**检测选择性**（外推点集中在两端）。');

// 直接检验：外推点在队形两端的富集
console.log('\n=== 检查 C：外推点是否富集在队形两端 ===');
const detRank = detByRank.map((r, i) => ({ i: i + 1, rate: r.det / r.tot }));
const mid = mean(detRank.slice(3, 7).map((r) => r.rate));
const ends = mean([detRank[0].rate, detRank[1].rate, detRank[8].rate, detRank[9].rate]);
console.log(`  中间 4 个次序的平均真检测率: ${(100 * mid).toFixed(1)}%`);
console.log(`  两端 4 个次序的平均真检测率: ${(100 * ends).toFixed(1)}%`);
console.log(`  → 两端低 ${(100 * (mid - ends)).toFixed(1)} 个百分点 = 跳过外推会削掉两端`);
