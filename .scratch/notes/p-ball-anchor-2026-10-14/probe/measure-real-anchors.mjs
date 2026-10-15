// 第0步：从 Metrica 真实帧量 phase_offset 与 BLOCK_SCALE。**不碰引擎**。
//
// 口径（写死，报告里照抄）：
//   数据源  ：viewer/data/real-game-{1,2}.json（Metrica sample-data，tools/convert-tracking-to-frames.mjs 产物）
//   球场尺寸：帧上无 pitchMeters ⇒ 缺省 105×68（两场都是；逐场尺寸只有 SkillCorner 才有）
//   帧采样  ：源帧 25 Hz 全量（不从 0.2s 抽样——这里量的是瞬时几何，样本越多越好；不做跨帧插值）
//   控球代理：**离球最近的球员（含门将）所属队**（metric 的 possessionProxy，口径一致）
//   球帧口径：球相关量只用**原始球帧**（ballFill == null）；补全帧的球位是启发式推断
//   外场    ：剔除门将 id 0/21；每队外场 <7 的帧整帧丢弃（MIN_OUTFIELD_PLAYERS）
//   块心    ：该队**外场**球员位置均值（与 FORM_CENTER_HOME/AWAY 同定义：home 外场 base.x 均值 = 0.358）
//   攻向    ：home 攻 +x、away 攻 −x（meta.orientation: home always attacks x=0 -> x=1）
//
// 产出：JSON 到 stdout（人读 + 机读）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));

const GAMES = [
  join(ROOT, 'viewer/data/real-game-1.json'),
  join(ROOT, 'viewer/data/real-game-2.json'),
];

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const KEEP = mm.KEEPER_IDS; // [0, 21]
const L = 105, W = 68;

// 一队的瞬时形状（米，相对球场）。返回 { cx, cy, depth(q10-q90 x), yspan(max-min), yq(q10-q90) , n }
function teamShape(f, isHome) {
  const ps = f.players.filter((p) => p && !KEEP.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11) && p.extrapolated !== true);
  if (ps.length < mm.MIN_OUTFIELD_PLAYERS) return null;
  const xs = ps.map((p) => p.x * L).sort((a, b) => a - b);
  const ysM = ps.map((p) => p.y * W);
  const ysS = [...ysM].sort((a, b) => a - b);
  return {
    cx: mean(ps.map((p) => p.x * L)), cy: mean(ysM),
    depth: mm.quantileSpan(xs),
    yspan: Math.max(...ysM) - Math.min(...ysM),
    yq: mm.quantileSpan(ysS),
    n: ps.length,
  };
}

const rows = [];      // 每帧一行（球为原始帧才入）
const shapeRows = []; // 每帧每队的形状（不要求原始球帧）
const perGame = [];

for (let gi = 0; gi < GAMES.length; gi++) {
  const g = JSON.parse(readFileSync(GAMES[gi], 'utf8'));
  const pm = g.meta && g.meta.pitchMeters ? [g.meta.pitchMeters.length, g.meta.pitchMeters.width] : null;
  const frames = g.frames.map((f) => mm.fromTrackingFrame(f, { pitchMeters: pm }));
  let used = 0, ballUsed = 0;
  for (const f of frames) {
    const home = teamShape(f, true), away = teamShape(f, false);
    if (!home || !away) continue;
    used++;
    shapeRows.push({ g: gi, home, away });
    if (!mm.isRawBallFrame(f)) continue;         // 球相关只用原始球帧
    if (!f.ball) continue;
    const bx = f.ball[0] * L, by = f.ball[1] * W;
    const pos = mm.possessionProxy(f, { pitchMeters: pm });
    if (!pos) continue;
    ballUsed++;
    const attHome = pos === 'home';
    const att = attHome ? home : away;
    const def = attHome ? away : home;
    const dir = attHome ? 1 : -1;                 // 进攻方自己的攻向
    rows.push({
      g: gi, bx, by, dir, attHome,
      dAtt: (att.cx - bx) * dir,                  // 攻方块心相对球，进攻方向上为正 = 在球前
      dDef: (def.cx - bx) * dir,                  // 守方块心相对球，同一坐标系
      dAttY: att.cy - by, dDefY: def.cy - by,     // 横向：攻/守方块心 y 相对球 y
      ballAbsY: Math.abs(f.ball[1] - 0.5),
    });
  }
  perGame.push({ game: gi + 1, frames: frames.length, framesUsed: used, rawBallFramesUsed: ballUsed });
}

// ── phase_offset（米，沿进攻轴）──
const phase = {
  n: rows.length,
  attMean: mean(rows.map((r) => r.dAtt)),
  attMedian: median(rows.map((r) => r.dAtt)),
  attSd: sd(rows.map((r) => r.dAtt)),
  defMean: mean(rows.map((r) => r.dDef)),
  defMedian: median(rows.map((r) => r.dDef)),
  defSd: sd(rows.map((r) => r.dDef)),
  // 横向：块心 y 相对球 y（攻/守分列）
  attYMean: mean(rows.map((r) => r.dAttY)),
  defYMean: mean(rows.map((r) => r.dDefY)),
};
// 逐场
phase.perGame = GAMES.map((_, gi) => {
  const r = rows.filter((x) => x.g === gi);
  return {
    game: gi + 1, n: r.length,
    attMean: mean(r.map((x) => x.dAtt)), defMean: mean(r.map((x) => x.dDef)),
    attYMean: mean(r.map((x) => x.dAttY)), defYMean: mean(r.map((x) => x.dDefY)),
  };
});
// 分箱：按球位 x 三等分（进攻轴上的场区）——看相位是否随场区漂移
phase.byBallThird = [0, 1, 2].map((k) => {
  const r = rows.filter((x) => Math.min(2, Math.floor((x.attHome ? x.bx : 105 - x.bx) / (105 / 3))) === k);
  return {
    thirdFromAttackerGoal: k + 1, n: r.length,
    attMean: mean(r.map((x) => x.dAtt)), defMean: mean(r.map((x) => x.dDef)),
    ballXNormMean: mean(r.map((x) => x.bx / 105)),
  };
});
// 分箱：按控球方（home/away 作攻方）
phase.byAttacker = [true, false].map((attHome) => {
  const r = rows.filter((x) => x.attHome === attHome);
  return {
    attacker: attHome ? 'home' : 'away', n: r.length,
    attMean: mean(r.map((x) => x.dAtt)), defMean: mean(r.map((x) => x.dDef)),
    attYMean: mean(r.map((x) => x.dAttY)), defYMean: mean(r.map((x) => x.dDefY)),
  };
});

// ── 真实队形分布（米）──
const shape = {
  n: shapeRows.length,
  home: {
    depth: { mean: mean(shapeRows.map((r) => r.home.depth)), median: median(shapeRows.map((r) => r.home.depth)), sd: sd(shapeRows.map((r) => r.home.depth)) },
    yspan: { mean: mean(shapeRows.map((r) => r.home.yspan)), median: median(shapeRows.map((r) => r.home.yspan)) },
    yq: { mean: mean(shapeRows.map((r) => r.home.yq)), median: median(shapeRows.map((r) => r.home.yq)) },
  },
  away: {
    depth: { mean: mean(shapeRows.map((r) => r.away.depth)), median: median(shapeRows.map((r) => r.away.depth)), sd: sd(shapeRows.map((r) => r.away.depth)) },
    yspan: { mean: mean(shapeRows.map((r) => r.away.yspan)), median: median(shapeRows.map((r) => r.away.yspan)) },
    yq: { mean: mean(shapeRows.map((r) => r.away.yq)), median: median(shapeRows.map((r) => r.away.yq)) },
  },
};
shape.perGame = GAMES.map((_, gi) => {
  const r = shapeRows.filter((x) => x.g === gi);
  return {
    game: gi + 1, n: r.length,
    hd: mean(r.map((x) => x.home.depth)), ad: mean(r.map((x) => x.away.depth)),
    hYspan: mean(r.map((x) => x.home.yspan)), aYspan: mean(r.map((x) => x.away.yspan)),
    hYq: mean(r.map((x) => x.home.yq)), aYq: mean(r.map((x) => x.away.yq)),
  };
});

// ── base 站位表的相对形状（同一套估计量；只有 10 名外场）──
// 从 default_lineup 抄（lib.rs:522）：home 外场 id1..10 的 (x,y)
const HOME_OF = [[0.18, 0.3], [0.20, 0.5], [0.18, 0.7], [0.14, 0.5], [0.40, 0.2], [0.42, 0.4], [0.42, 0.6], [0.40, 0.8], [0.62, 0.35], [0.62, 0.65]];
const AWAY_OF = [[0.82, 0.3], [0.80, 0.5], [0.82, 0.7], [0.86, 0.5], [0.60, 0.2], [0.58, 0.4], [0.58, 0.6], [0.60, 0.8], [0.38, 0.35], [0.38, 0.65]];
function baseShape(rowsN) {
  const cx = mean(rowsN.map((r) => r[0])); // 归一化
  const cy = mean(rowsN.map((r) => r[1]));
  const xsM = rowsN.map((r) => (r[0] - cx) * L).sort((a, b) => a - b);
  const ysM = rowsN.map((r) => (r[1] - cy) * W);
  const ysS = [...ysM].sort((a, b) => a - b);
  return {
    cx, cy,
    depth: mm.quantileSpan(xsM),      // = q10-q90 of base.x（平移不变）
    yspan: Math.max(...ysM) - Math.min(...ysM),
    yq: mm.quantileSpan(ysS),
  };
}
const base = { home: baseShape(HOME_OF), away: baseShape(AWAY_OF) };

// ── BLOCK_SCALE 反解（只看纵深）──
// real 侧用两数据集带宽 [skillcorner, metrica]（committed 基线 datasets.*.perMetric）：
const SK = { hd: 18.307066208744036, ad: 18.448783008993612 };
const MET = { hd: 25.93902330923077, ad: 26.79333066307693 };
const geo = (a, b) => Math.sqrt(a * b);
const realDepthTarget = {
  hdSkillcorner: SK.hd, hdMetrica: MET.hd, hdBandMid: geo(SK.hd, MET.hd),
  adSkillcorner: SK.ad, adMetrica: MET.ad, adBandMid: geo(SK.ad, MET.ad),
};
const midDepth = (realDepthTarget.hdBandMid + realDepthTarget.adBandMid) / 2;
const scaleFromDepth = {
  baseDepthHomeM: base.home.depth, baseDepthAwayM: base.away.depth,
  targetDepthM: midDepth,
  BLOCK_SCALE: midDepth / ((base.home.depth + base.away.depth) / 2),
  // 对照：若按单数据集锚
  bySkillcorner: (SK.hd + SK.ad) / 2 / ((base.home.depth + base.away.depth) / 2),
  byMetrica: (MET.hd + MET.ad) / 2 / ((base.home.depth + base.away.depth) / 2),
};
// 同一 scale 下 width 会变成什么（诊断用，不是判据）
scaleFromDepth.widthImpliedM = base.home.yspan * scaleFromDepth.BLOCK_SCALE;
scaleFromDepth.widthRealMetrica = 39.580609737435914;
scaleFromDepth.widthRealSkillcorner = 35.959739890170525;
scaleFromDepth.widthScaleNeeded_Metrica = 39.580609737435914 / base.home.yspan;
scaleFromDepth.widthScaleNeeded_Skillcorner = 35.959739890170525 / base.home.yspan;
scaleFromDepth.baseYspanM = base.home.yspan;
scaleFromDepth.baseYqM = base.home.yq;

console.log(JSON.stringify({ perGame, phase, shape, base, realDepthTarget, scaleFromDepth }, null, 1));
