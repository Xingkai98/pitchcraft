// 解析复核：把 `formation_target`（engine/src/lib.rs:3440）逐字重实现，算**目标**分边/纵深
// 随 c 的变化，含防线 clamp。**纯代数**，不跑引擎、不看实测——用于在预注册前核主 session §3。
// 用完即删。

const SIDE_SHIFT_FACTOR = 0.06;
const DEFENSE_PUSH_FACTOR = 0.12;
const PRESS_UP_OFFSET = 0.02;
const FORM_MIX_X = 0.5, FORM_SPREAD_X = 0.8, FORM_TRACK_X = 0.5;
const FORM_CENTER_OFFSET = 0.033, FORM_ATTACK_SIGN = 1.0;

const HOME = [
  { id: 1, x: 0.18, y: 0.3 }, { id: 2, x: 0.20, y: 0.5 }, { id: 3, x: 0.18, y: 0.7 }, { id: 4, x: 0.14, y: 0.5 },
  { id: 5, x: 0.40, y: 0.2 }, { id: 6, x: 0.42, y: 0.4 }, { id: 7, x: 0.42, y: 0.6 }, { id: 8, x: 0.40, y: 0.8 },
  { id: 9, x: 0.62, y: 0.35 }, { id: 10, x: 0.62, y: 0.65 },
];
const AWAY = [
  { id: 20, x: 0.82, y: 0.3 }, { id: 19, x: 0.80, y: 0.5 }, { id: 18, x: 0.82, y: 0.7 }, { id: 17, x: 0.86, y: 0.5 },
  { id: 16, x: 0.60, y: 0.2 }, { id: 15, x: 0.58, y: 0.4 }, { id: 14, x: 0.58, y: 0.6 }, { id: 13, x: 0.60, y: 0.8 },
  { id: 12, x: 0.38, y: 0.35 }, { id: 11, x: 0.38, y: 0.65 },
];
const DEF = { home: [1, 2, 3, 4], away: [17, 18, 19, 20] };

// c 压缩 + center0 取法
function table(c) { return { home: HOME.map(p => ({ ...p, x: 0.5 + (p.x - 0.5) * c })), away: AWAY.map(p => ({ ...p, x: 0.5 + (p.x - 0.5) * c })) }; }
function centers(c, variant) {
  if (variant === 'A') return { home: 0.358, away: 0.642 };
  const t = table(c);
  const m = a => a.reduce((s, p) => s + p.x, 0) / a.length;
  return { home: m(t.home), away: m(t.away) };
}

// 单人目标 x（不含 ix 抖动——它在两队的均值差上是残差，另算）
function tx2(team, p, ballX, myAttack, c0, isDef) {
  const home = team === 'home';
  const attackDir = home ? 1 : -1;
  const shift = (ballX - 0.5) * SIDE_SHIFT_FACTOR;
  const press = (myAttack ? 1 : -1) * PRESS_UP_OFFSET;
  let tx = p.x + shift + attackDir * press;
  if (isDef) {
    const ownGoal = home ? 0 : 1;
    const push = Math.abs(ballX - ownGoal) * DEFENSE_PUSH_FACTOR;
    const tf = tx + attackDir * push;
    tx = home ? Math.min(tf, ballX) : Math.max(tf, ballX);
    tx = home ? Math.max(tx, p.x) : Math.min(tx, p.x);
  }
  const cdx = Math.min(1, Math.max(-1, ballX - c0));
  const blockCx = c0 + FORM_TRACK_X * cdx + attackDir * (myAttack ? FORM_ATTACK_SIGN : -1) * FORM_CENTER_OFFSET;
  const blockTx = blockCx + (p.x - c0) * FORM_SPREAD_X;
  return FORM_MIX_X * blockTx + (1 - FORM_MIX_X) * tx;
}

export function gapTarget(c, variant, ballX, homeAttacks) {
  const t = table(c), ctr = centers(c, variant);
  const mean = (team, myAttack) => {
    const c0 = ctr[team], defs = DEF[team];
    const s = t[team].reduce((a, p) => a + tx2(team, p, ballX, myAttack, c0, defs.includes(p.id)), 0);
    return s / t[team].length;
  };
  const h = mean('home', homeAttacks), a = mean('away', !homeAttacks);
  return (h - a) * 105;
}
// type-7 线性插值分位（与 viewer/match-metrics.js 的 q10–q90 同口径）
function q(arr, t) {
  const s = arr.slice().sort((a, b) => a - b);
  const t2 = t * (s.length - 1), lo = Math.floor(t2), f = t2 - lo;
  return s[lo] + f * ((s[lo + 1] ?? s[lo]) - s[lo]);
}
// 纵深：**逐队** q10–q90 的 x 目标跨距（米）
export function hdTarget(c, variant, ballX, homeAttacks) {
  const t = table(c), ctr = centers(c, variant);
  const span = team => {
    const c0 = ctr[team], defs = DEF[team];
    const xs = t[team].map(p => tx2(team, p, ballX, team === 'home' ? homeAttacks : !homeAttacks, c0, defs.includes(p.id)));
    return (q(xs, 0.9) - q(xs, 0.1)) * 105;
  };
  return (span('home') + span('away')) / 2;
}
// y 目标（formation_target 的 ty；iy 取 0）：与 c 无关 ⇒ width 的内置对照
const FORM_MIX_Y = 0.7, FORM_SPREAD_Y = 1.3, FORM_TRACK_Y = 0.3;
function tyTarget(p, ballY) {
  const tyOld = p.y + (ballY - 0.5) * SIDE_SHIFT_FACTOR * 0.6;
  const blockTy = 0.5 + (ballY - 0.5) * FORM_TRACK_Y + (p.y - 0.5) * FORM_SPREAD_Y;
  return FORM_MIX_Y * blockTy + (1 - FORM_MIX_Y) * tyOld;
}
// spread = 到重心的平均距离（米），逐队取均值
export function spreadTarget(c, variant, ballX, ballY, homeAttacks) {
  const t = table(c), ctr = centers(c, variant);
  const sp = team => {
    const c0 = ctr[team], defs = DEF[team];
    const P = t[team].map(p => [tx2(team, p, ballX, team === 'home' ? homeAttacks : !homeAttacks, c0, defs.includes(p.id)) * 105, tyTarget(p, ballY) * 68]);
    const cx = P.reduce((a, q) => a + q[0], 0) / P.length, cy = P.reduce((a, q) => a + q[1], 0) / P.length;
    return P.reduce((a, q) => a + Math.hypot(q[0] - cx, q[1] - cy), 0) / P.length;
  };
  return (sp('home') + sp('away')) / 2;
}
// width = y 的 max−min（米）
export function widthTarget(c) { const ys = table(c).home.map(p => tyTarget(p, 0.5) * 68); return Math.max(...ys) - Math.min(...ys); }

// 逐帧「队均 x」对 ball.x 的斜率（数值差分）
export function slope(c, variant) {
  const mean = (team, ballX, myAttack) => {
    const t = table(c), c0 = centers(c, variant)[team], defs = DEF[team];
    return t[team].reduce((a, p) => a + tx2(team, p, ballX, myAttack, c0, defs.includes(p.id)), 0) / t[team].length;
  };
  const h = 1e-4, bx = 0.5;
  const dh = (mean('home', bx + h, true) - mean('home', bx - h, true)) / (2 * h);
  const da = (mean('away', bx + h, false) - mean('away', bx - h, false)) / (2 * h);
  return { home: dh, away: da };
}

const CS = [1.0, 0.7, 0.55, 0.45, 0.30];
const BS = [0.2, 0.35, 0.5, 0.65, 0.8];
const avgGap = (c, v) => BS.reduce((s, bx) => s + (Math.abs(gapTarget(c, v, bx, true)) + Math.abs(gapTarget(c, v, bx, false))) / 2, 0) / BS.length;
const avgHd = (c, v) => BS.reduce((s, bx) => s + (hdTarget(c, v, bx, true) + hdTarget(c, v, bx, false)) / 2, 0) / BS.length;

if (process.argv[1] && process.argv[1].endsWith('zz_target_model.mjs')) {
  console.log('== A. 目标 gap（含防线 clamp），逐 ball.x 中位数 ==');
  for (const c of CS) {
    const row = BS.map(bx => `${bx}:${((Math.abs(gapTarget(c, 'C', bx, true)) + Math.abs(gapTarget(c, 'C', bx, false))) / 2).toFixed(2)}`);
    const rowA = BS.map(bx => `${((Math.abs(gapTarget(c, 'A', bx, true)) + Math.abs(gapTarget(c, 'A', bx, false))) / 2).toFixed(2)}`);
    console.log(`c=${c.toFixed(2)} C[${row.join(' ')}]  avg=${avgGap(c, 'C').toFixed(2)} | A[${rowA.join(' ')}] avg=${avgGap(c, 'A').toFixed(2)}`);
  }
  console.log('\n== B. 目标 hd（逐队 q10–q90 x 跨距，米）==');
  for (const c of CS) console.log(`c=${c.toFixed(2)}  C=${avgHd(c, 'C').toFixed(2)}   A=${avgHd(c, 'A').toFixed(2)}   静态 46.6c=${(46.6 * c).toFixed(2)}`);
  console.log('\n== C. 队均 x 对 ball.x 的斜率（目标层；队均随球走的程度）==');
  for (const c of CS) { const s = slope(c, 'C'); console.log(`c=${c.toFixed(2)}  主 ${s.home.toFixed(3)}  客 ${s.away.toFixed(3)}`); }
  console.log('\n== D. §3 纯解析（**不做 clamp**）：C ⇒ 22.37c ；A ⇒ |4.47 − 26.84c| ==');
  for (const c of CS) console.log(`c=${c.toFixed(2)}  C=${(22.37 * c).toFixed(2)}  A=|${(4.47 - 26.84 * c).toFixed(2)}|`);
  console.log('\n== E. 我口径（0.968×目标；hd 比 1.01） vs 主 session §3（19.2c / 39.1c） ==');
  console.log('c      mine-gap  brief-gap | mine-hd  brief-hd | spread  width');
  const avgSp = (c, v) => BS.reduce((s, bx) => s + (spreadTarget(c, v, bx, 0.5, true) + spreadTarget(c, v, bx, 0.5, false)) / 2, 0) / BS.length;
  for (const c of CS) console.log(`${c.toFixed(2)}   ${(0.968 * avgGap(c, 'C')).toFixed(1)}      ${(19.2 * c).toFixed(1)}    | ${(1.01 * avgHd(c, 'C')).toFixed(1)}    ${(39.1 * c).toFixed(1)}    | ${avgSp(c, 'C').toFixed(1)}   ${widthTarget(c).toFixed(1)}`);
  console.log('\n== F. 带穿越（实测 = 0.968×目标）：gap 带 [5.24,8.32] / hd 带 [18.31,25.94] ==');
  const cross = (f, v, lo, hi) => { const xs = []; for (const b of [lo, hi]) { let prev = null; for (let c = 1.0; c >= 0.20; c -= 0.005) { const y = f(c, v); if (prev && ((prev.y - b) * (y - b) <= 0)) xs.push(c + 0.005 * (prev.y - b) / (prev.y - y)); prev = { y }; } } return xs; };
  for (const v of ['C', 'A']) {
    console.log(`变体 ${v}: gap 带内 c ∈ [${cross(avgGap, v, 5.24 / 0.968, 8.32 / 0.968).map(x => x.toFixed(3)).join(', ')}]`);
    console.log(`变体 ${v}: hd  带内 c ∈ [${cross((c, vv) => 1.01 * avgHd(c, vv), v, 18.31, 25.94).map(x => x.toFixed(3)).join(', ')}]`);
  }
}
