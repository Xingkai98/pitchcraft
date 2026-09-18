// 比赛标尺：真实比赛（tracking）与引擎比赛共用的位置层指标实现（P36）。
//
// 定位：这是**测量工具**，不改被测量的东西（零引擎改动）。真实侧与引擎侧必须收敛到
// 同一份实现——口径若分叉（是否含门将、采样相位、估计量约定），数字就不可比，而这
// 类分叉最隐蔽：两边各写一份"看起来一样"的实现，差异只在细节里。本模块从结构上排除：
// 只有一种输入形状、一份指标代码。
//
// 统一帧表示（唯一输入形状，design D1）：
//   { t: 秒, players: [{id,x,y}|null × 22]（下标=id）, ball: [x,y]|null, ballFill?: ... }
//   - x/y 归一化 [0,1]；id 语义：0=主队门将、21=客队门将、1-10 主队、11-20 客队。
//   - ballFill 是 P35 转换器给的补全标记（数值=补全到的球员 id、'hold'=沿用上一位置）；
//     缺省（null/undefined）= 原始观测帧。真实侧约 40% 帧的球位是补全推断，任何**以球为
//     条件**的量在补全帧上测的是补全启发式而非数据，故球相关指标主口径只用原始球帧
//     （design D2「球相关指标的取帧策略」）。
//
// 口径（spec「指标口径固定且显式」，每一条都由测试守护，test 文件同名 + .test.js）：
//   1. 剔除门将：id 0/21 不参与任何队形指标（不剔则纵深变成"门将到前锋"，实测 33→64m）。
//   2. 瞬时队形：先对每帧算指标，再对帧取均值——不是把整场位置合并后取分位（两者差一倍）。
//   3. 纵深估计量 = **q10–q90 线性插值分位跨度**（P37 用户拍板，见下）。
//   4. 米制换算：按**该场自己的**球场尺寸（P37）——缺省 105×68（引擎侧与 Metrica）；
//      SkillCorner 有 104/105/106 三种场地，逐场传入 `pitchMeters`。
//   5. 控球代理：离球最近者所属球队（含门将参与最近者判定）。这是**代理**，不等于真实
//      持球权（不处理传球在途/二点球），只用于相位分桶与报告，必须显式标注。
//   6. 采样间隔 0.2s（5Hz）——与真实侧 keyframeHz 对齐；两侧同一间隔，相位同构。
//   7. 帧间聚合器 = 均值；某队非门将球员不足 7 人时该帧丢弃（不参与聚合）。
//   8. **外推点**（源数据标 `is_detected=false` 的点）默认**不参与**指标计算——与「缺失点
//      为 null 时不参与」同口径。它是**推断值不是观测**，采信它等于拿外推启发式对比真实观测。
//      全点口径（采信外推）作为**对照**并列输出，供读者看外推的影响量级（P37 D2）。
//
// ── 纵深估计量：为什么从 trim1 换成 q10–q90（P37 D2，用户拍板 β）──────────────
//
// P36 用 trim1（掐头去尾各 1 人）。它的隐含假设是**每帧参与人数恒定**——Metrica 与引擎
// 每队恒 10 名非门将，这个假设成立。P37 引入「默认跳过外推点」后，SkillCorner 的每帧
// 有效人数变成**浮动**（实测 0–10、中位 7–8），trim1 作为**顺序统计量**，其期望随 n 变：
// 掐固定 1 人时，n=10 保留 8/10（80%）、n=7 保留 5/7（71%）——保留比例本身在变，
// 于是两侧跑的不是同一个估计量。实测这个机械 n 效应占「全点 vs 仅真检测」口径差的
// **约 45%–61%**（单场 5.2m/8.5m；12 场汇总 59%），会被误当成物理信号。
//
// q10–q90 是**位置统计量**（不是顺序统计量），对 n 的依赖弱得多：实测把 n 效应从
// 2.7–5.2m 压到 **1.2m**，只留检测效应（≈3.6m）。代价是改动了 P36 冻结的口径 →
// **基线必须重生成**（`hashMetricsModule` 陈旧性校验会强制，这是设计意图）。
//
// ⚠️ 不要用「比例修剪」（掐 `max(1, round(0.1n))` 人）替代：在 n=7..10 上
// `round(0.1n)` **恒等于 1**，与 trim1 逐位相同——是空操作（P37 实现期复核）。
//
// **插值规则写死如下**（P36 曾以「约定歧义」否决过 p10–p90，故此处不留自由度）：
//   排序后 `q(p) = s[i] + (h − i)·(s[i+1] − s[i])`，其中 `h = (n−1)·p`、`i = floor(h)`；
//   边界：`i+1 ≥ n` 时取 `s[n−1]`（即 h 落在最后一点时不做越界插值）；n===1 时取该点。
//   这是 R 的 type-7 / NumPy 默认口径。q10–q90 = `q(0.9) − q(0.1)`。
export const QUANTILE_LO = 0.1;
export const QUANTILE_HI = 0.9;
//
// 两侧约定（design D5b）：引擎跑 5400s（引擎默认时长，不是 viewer 的 5 分钟传参），按与
// 真实相同的规则切 300s 窗（步长 900s）→ 5 种子 × 6 窗 = 30 窗；真实侧（P37）Metrica
// 2 场 + SkillCorner 20 场，900s 步长下合计 13 + 139 = 152 个满窗。
//
// ── P37 相对 P36 的行为变更（会触发基线陈旧性校验，属设计意图）────────────
//   a. 纵深估计量 trim1 → q10–q90（见上）。
//   b. 米制换算由「统一 105×68」改为「逐场尺寸」（帧上带 `pitchMeters` 时生效）。
//   c. `windowMetrics` 返回 `{ primary, allPoints }`（不再返回扁平对象）。
//   d. 外推点默认不参与（新概念；引擎侧与 Metrica 无此标记，行为不变）。
//   e. `summarizeWindowMetrics` 跳过 null 窗口并返回 `skippedWindows`。

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;

// 门将 id：0 主队、21 客队（事件协议固定槽位，见 tools/convert-tracking-to-frames.mjs）
export const KEEPER_IDS = [0, 21];

// 采样间隔（秒）：真实侧 keyframeHz=5 的倒数；引擎侧按此步长采样
export const SAMPLE_INTERVAL_SEC = 0.2;

// 切窗规则：300s 窗、步长 900s（窗间有 600s 间隔——真实取的是散点切片，不是连续段）
export const WINDOW_SIZE_SEC = 300;
export const WINDOW_STEP_SEC = 900;

// 某队非门将球员少于该数时，该帧丢弃（不参与聚合）
export const MIN_OUTFIELD_PLAYERS = 7;

// 弹性报告的分桶最小样本：任一侧不足则丢弃该窗口（报告项的质量守卫，同审阅探针口径）
export const MIN_ELASTICITY_FRAMES = 30;

// 冻结种子集：禁止按结果重挑（对齐项目 L1 门「种子集冻结」的教训）
export const BENCHMARK_SEEDS = [42, 1, 7, 99, 123];

// 引擎采样时长 = 引擎默认 match_duration_seconds（design D5b 已核实：5400 是引擎默认，
// "5 分钟"是 viewer config 传参，标尺不用它）
export const ENGINE_DURATION_SEC = 5400;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── 统一帧构造 ──────────────────────────────────────────────────────────

// tracking 帧（tools/convert-*-to-frames.mjs 的产物：players 是 [[x,y]|null × 22]，
// 外推点带第三位 1）→ 统一帧。ballFill 原样透传（球相关指标的取帧策略依赖它）。
//
// **外推标记**（P37）：坐标第三位 === 1 → `extrapolated: true`。缺省即真观测。
// 两个转换器产出的都是这个形状（Metrica 没有外推概念，故全无标记）。
export function fromTrackingFrame(frame, opts = {}) {
  const out = {
    t: frame.t,
    players: frame.players.map((p, id) => (p == null ? null
      : (p.length > 2 && p[2] === 1 ? { id, x: p[0], y: p[1], extrapolated: true } : { id, x: p[0], y: p[1] }))),
    ball: frame.ball || null,
    ballFill: frame.ballFill !== undefined ? frame.ballFill : null,
  };
  // 逐场球场尺寸随帧携带（P37 D4）——帧是流经 cutWindows → windowMetrics 的单元，
  // 挂在这里可让下游零参数地按正确尺寸换算。缺省不挂（引擎侧与 Metrica 用 105×68）。
  if (opts.pitchMeters) out.pitchMeters = opts.pitchMeters;
  return out;
}

// 一帧的球场尺寸（米）：帧上带的（逐场，P37）优先，否则缺省 105×68。
export function framePitchMeters(frame) {
  return (frame && frame.pitchMeters) || [PITCH_LENGTH_M, PITCH_WIDTH_M];
}

// 该帧的球位是否是原始观测（ballFill 缺省）；补全帧的球位是启发式推断，不进主口径。
export function isRawBallFrame(frame) {
  return frame.ballFill === undefined || frame.ballFill === null;
}

// 引擎侧采样：Game.seekTo(t) + 按固定间隔读 { players, ball }。
// 不读引擎内部状态——标尺只消费两侧都能提供的观测（spec「引擎侧位置经采样获得」）。
// 用整数步长索引而非累加（浮点累加会漂，帧数不可复现）；时刻规整到微秒
// （i*0.2 的单次乘法仍有 1e-16 尾巴，如 3*0.2=0.6000000000000001——规整后两侧
// 切窗边界判定不受表示噪声影响）。
export function sampleEngineFrames(game, { stepSec = SAMPLE_INTERVAL_SEC } = {}) {
  const end = game.matchEnd;
  const steps = Math.round(end / stepSec);
  const frames = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = Math.round(i * stepSec * 1e6) / 1e6;
    game.seekTo(t);
    frames.push({
      t,
      players: game.players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
      ball: [game.ball.x, game.ball.y],
      ballFill: null,
    });
  }
  return frames;
}

// 切 300s 窗（步长 900s）：只取**完整窗**——起止都落在可观测时间内的窗。
// `T + 1` 的容差是为帧时间戳的浮点/采样相位差留的（300s 整窗在 T 略小于窗右界时仍算完整）。
// 两条排除机制分工不同（勿混）：
//   - 尾部残窗（game2 的 246s）由**循环边界** `s + sizeSec <= T + 1` 排除——窗起点必须在
//     可观测时间内且整窗放得下，残窗根本进不了循环。基线元数据如实记录其时长（design 要求）。
//   - minFrames 是**数据缺口**的安全网（某窗起点可切但源数据缺帧，帧数远少于 300s×5Hz）——
//     当前真实数据上从未触发，纯防御。
export function cutWindows(frames, {
  sizeSec = WINDOW_SIZE_SEC, stepSec = WINDOW_STEP_SEC, minFrames = 100,
} = {}) {
  if (frames.length === 0) return [];
  const T = frames[frames.length - 1].t;
  const out = [];
  for (let s = 0; s + sizeSec <= T + 1; s += stepSec) {
    const w = frames.filter((f) => f.t >= s && f.t < s + sizeSec);
    if (w.length > minFrames) out.push(w);
  }
  return out;
}

// ── 估计量（纯函数） ────────────────────────────────────────────────────

// 线性插值分位（R type-7 / NumPy 默认）。规则写死在文件头注释里——不留约定自由度。
// **必须传已排序数组**（调用方排一次、多个分位复用，避免重复排序）。
export function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const i = Math.floor(h);
  if (i + 1 >= n) return sorted[n - 1]; // h 落在最后一点：不越界插值
  return sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
}

// 纵深估计量：q10–q90 跨度（米）。输入是**已排序**的米制 x 数组。
// n 依赖弱（见文件头「为什么从 trim1 换成 q10–q90」）。
export function quantileSpan(sorted) {
  if (sorted.length < 2) return null;
  return quantileSorted(sorted, QUANTILE_HI) - quantileSorted(sorted, QUANTILE_LO);
}

// P36 的 trim1（掐头去尾各 1 人）。**保留仅供对照与测试**——P37 起默认估计量是
// q10–q90（见文件头）。基线里作为「旧口径」并列，便于解释与 P36 基线的差异来源。
export function trim1Span(sorted) {
  if (sorted.length < 3) return null;
  return sorted[sorted.length - 2] - sorted[1];
}

// ── 指标（纯函数） ──────────────────────────────────────────────────────

// 该球员点是否是**外推值**（源数据 `is_detected=false`）。转换器把它写进统一帧的
// `extrapolated` 布尔；缺省（引擎侧 / Metrica）即真观测。
const isExtrapolated = (p) => p && p.extrapolated === true;

// 队形指标（单帧、单队、瞬时）。非门将球员不足 MIN_OUTFIELD_PLAYERS 时返回 null（丢帧）。
//   depth  = q10–q90 纵深（米）：非门将 x 的 10%–90% 分位跨度
//   width  = y 方向跨度（米）（报告项；实测与真实重叠，不进断言；**仍是 max-min**，
//            未随 depth 换成位置统计量——它是报告项、不承载校准目标）
//   cx/cy  = 非门将球员重心（米）
//   spread = 到重心的平均距离（米）——「紧凑度」
//
// opts.pitchMeters = [lengthM, widthM]，缺省 [105, 68]。**逐场传入**——把 104/106 的场地
// 按 105 折算会引入按场地尺寸系统性分组的偏置（P37 D4）。
// opts.includeExtrapolated = true 时**采信**外推点（对照口径）；默认 false（跳过）。
export function teamShape(frame, team, opts = {}) {
  const players = frame && Array.isArray(frame.players) ? frame.players : null;
  if (!players) return null;
  const { includeExtrapolated = false } = opts;
  const [L, W] = opts.pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const isHome = team === 'home';
  const outfield = players.filter((p) => p && !KEEPER_IDS.includes(p.id)
    && (isHome ? p.id <= 10 : p.id >= 11)
    && (includeExtrapolated || !isExtrapolated(p)));
  if (outfield.length < MIN_OUTFIELD_PLAYERS) return null;

  // 排序一次，供分位与重心复用（重心与 spread 用未排序的 (x,y) 配对——历史教训：
  // 探针曾把排序后的 x 与未排序的 y 按下标配对，差 ~0.1-0.2m，属口径错误）
  const xs = outfield.map((p) => p.x * L);
  const ys = outfield.map((p) => p.y * W);
  const depth = quantileSpan([...xs].sort((a, b) => a - b));

  const cx = mean(xs);
  const cy = mean(ys);
  const spread = mean(outfield.map((p, i) => Math.hypot(xs[i] - cx, ys[i] - cy)));

  return { depth, width: Math.max(...ys) - Math.min(...ys), cx, cy, spread, n: outfield.length };
}

// 控球代理：离球最近者所属队（含门将参与判定）。显式标注为**代理**——不等于真实持球权
// （不处理传球在途、二点球）；只用于相位分桶与报告，不作为引擎事实。
// 默认跳过外推点（P37 D2）——采信外推点会把这个代理建立在推断值上。
export function possessionProxy(frame, opts = {}) {
  if (!frame || !frame.ball || !Array.isArray(frame.players)) return null;
  const { includeExtrapolated = false, pitchMeters } = opts;
  const [L, W] = pitchMeters || [PITCH_LENGTH_M, PITCH_WIDTH_M];
  const [bx, by] = [frame.ball[0] * L, frame.ball[1] * W];
  let best = null;
  for (const p of frame.players) {
    if (!p) continue;
    if (!includeExtrapolated && isExtrapolated(p)) continue;
    const d = Math.hypot(p.x * L - bx, p.y * W - by);
    if (!best || d < best.d) best = { d, id: p.id };
  }
  return best ? (best.id <= 10 ? 'home' : 'away') : null;
}

// 单帧的对队形指标（需要两队都有效；任一队非门将 <7 → 整帧丢弃）。
// ballDist = 主队重心到球的距离（米），无球帧为 null（球相关指标不进非球帧的聚合）。
export function frameMetrics(frame, opts = {}) {
  const eff = { ...opts, pitchMeters: opts.pitchMeters || (frame && frame.pitchMeters) };
  const home = teamShape(frame, 'home', eff);
  const away = teamShape(frame, 'away', eff);
  if (!home || !away) return null;
  const [L, W] = framePitchMeters(eff);
  let ballDist = null;
  if (frame.ball && isFiniteNumber(frame.ball[0]) && isFiniteNumber(frame.ball[1])) {
    ballDist = Math.hypot(home.cx - frame.ball[0] * L, home.cy - frame.ball[1] * W);
  }
  return { home, away, gap: Math.hypot(home.cx - away.cx, home.cy - away.cy), ballDist };
}

// 窗口聚合：先对每帧算指标（瞬时队形），再对帧取均值（口径 2 与 7）。
// 主口径（rawBallOnly=true）的球相关量只用原始球帧；全帧对照并列返回（报告项）。
//
// opts.pitchMeters：逐场球场尺寸（P37 D4），缺省 105×68。
//
// **返回结构**（P37 起）：`{ primary, allPoints }` —— 默认口径（跳过外推点）与全点口径
// （采信外推）**并列**，让外推的影响量级可被直接读出（P37 D2 的要求）。
// 用 `windowMetrics(...).primary` 取旧的扁平结构（含 frameCount 等）。
// ⚠️ 旧调用方若直接读顶层字段会拿到 undefined——**必须显式取 .primary**
// （这是刻意的破坏性变更：口径变了，旧基线本就应当失效重生成）。
export function windowMetrics(frames, opts = {}) {
  const { rawBallOnly = true } = opts;
  // 逐场尺寸：显式传入优先，否则从帧上取（fromTrackingFrame 会带），再否则缺省 105×68。
  const pitchMeters = opts.pitchMeters || (frames.length ? frames[0].pitchMeters : null);
  const agg = (includeExtrapolated) => {
    const shapeOpts = { pitchMeters, includeExtrapolated };
    const hd = []; const ad = []; const spread = []; const gap = []; const width = [];
    const ballDist = []; const ballDistAll = [];
    let possessionHome = 0; let possessionN = 0;
    let frameCount = 0;
    for (const f of frames) {
      const m = frameMetrics(f, shapeOpts);
      if (!m) continue;
      frameCount += 1;
      hd.push(m.home.depth);
      ad.push(m.away.depth);
      spread.push(m.home.spread);
      gap.push(m.gap);
      width.push(m.home.width);
      if (m.ballDist != null) {
        ballDistAll.push(m.ballDist);
        if (!rawBallOnly || isRawBallFrame(f)) {
          ballDist.push(m.ballDist);
          const pos = possessionProxy(f, shapeOpts);
          if (pos) { possessionN += 1; if (pos === 'home') possessionHome += 1; }
        }
      }
    }
    if (frameCount === 0) return null;
    return {
      frameCount,
      hd: mean(hd),
      ad: mean(ad),
      spread: mean(spread),
      gap: mean(gap),
      width: mean(width),
      ballDist: ballDist.length ? mean(ballDist) : null,
      ballDistAllFrames: ballDistAll.length ? mean(ballDistAll) : null,
      ballDistFrames: ballDist.length,
      ballDistAllFramesCount: ballDistAll.length,
      possessionHome: possessionN ? possessionHome / possessionN : null,
      possessionFrames: possessionN,
    };
  };
  // 两种口径**始终并列**输出（P37 D2）：primary 跳过外推点（与「缺失不参与」同口径），
  // allPoints 采信外推（对照，让影响量级可读）。窗口内 0 可用帧时 primary 为 null。
  return { primary: agg(false), allPoints: agg(true) };
}

// 弹性（口径敏感性报告，不作校准目标、不进断言——design D4）：
// 主队纵深在「球在本队一侧」与「球在对方一侧」两桶间的均值差 Δ = opp - own。
// 两种同样合理的分桶口径并列：'half'=球在主队半场与否；'centroid'=球在本队重心前后。
// 「半场口径下真实 4.5m vs 引擎 11.3m 的 2.6×」是分桶口径的产物——换重心口径信号消失
// （真实 −0.1m）。这个量不稳，报告出来是为了让读者看到它对口径的依赖。
export function elasticity(frames, { divider = 'half', rawBallOnly = true, pitchMeters: pm } = {}) {
  const pitchMeters = pm || (frames.length ? frames[0].pitchMeters : null);
  const [L] = framePitchMeters({ pitchMeters });
  const own = []; const opp = [];
  for (const f of frames) {
    if (!f.ball || !isFiniteNumber(f.ball[0])) continue;
    if (rawBallOnly && !isRawBallFrame(f)) continue;
    const shape = teamShape(f, 'home', { pitchMeters }); // 默认跳过外推点（P37 D2）
    if (!shape) continue;
    const inOwnSide = divider === 'half'
      ? f.ball[0] < 0.5
      : f.ball[0] * L < shape.cx;
    (inOwnSide ? own : opp).push(shape.depth);
  }
  if (own.length < MIN_ELASTICITY_FRAMES || opp.length < MIN_ELASTICITY_FRAMES) return null;
  return {
    own: mean(own), opp: mean(opp), delta: mean(opp) - mean(own),
    nOwn: own.length, nOpp: opp.length,
  };
}

// 分布摘要：一组窗口值 → { avg, min, max, n }。空输入返回 null。
// 基线（观测范围）与对比（引擎值）用同一函数，保证两侧摘要口径一致。
export function summarizeValues(values) {
  if (!values || values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { avg: mean(values), min, max, n: values.length };
}

// 一组窗口指标对象 → 逐指标摘要。数值键全部摘要，null（该窗缺该项）跳过。
//
// P37：**跳过 null 窗口条目**。`windowMetrics` 在主口径下整窗 0 可用帧时返回
// `{ primary: null, ... }`；调用方传进来的列表可能含 null。旧实现直接 `m[k]`，
// 遇到 null 会抛 TypeError（Metrica 每窗恒 1500 帧、从未触发；P37 引入外推过滤后才可能）。
// 同时返回 `skippedWindows`，让「多少窗被跳过」可审计——不静默缩小样本。
export function summarizeWindowMetrics(metricsList) {
  const keys = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist', 'ballDistAllFrames',
    'possessionHome', 'ballDistFrames', 'possessionFrames', 'frameCount'];
  const present = metricsList.filter((m) => m != null);
  const out = { skippedWindows: metricsList.length - present.length };
  for (const k of keys) {
    const vals = present.map((m) => m[k]).filter((v) => v != null);
    out[k] = summarizeValues(vals);
  }
  return out;
}
