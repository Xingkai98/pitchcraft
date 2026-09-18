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
//   3. 纵深估计量 = trim1：每队非门将按 x 排序，掐头去尾各 1 人取剩余 8 人跨度。
//      两侧对称（最前/最后各 0% 权重）、无分位插值约定歧义。max-min 只由两极值两人决定
//      （单个离群球员可撑大 180m）；floor 索引的分位在防守侧与 max-min 一样脆弱
//      （探针实测 +177m）——两轮设计审阅的结论，勿回退。
//   4. 米制换算：x×105、y×68（Metrica 与本引擎同为 105×68 米）。
//   5. 控球代理：离球最近者所属队（含门将参与最近者判定）。这是**代理**，不等于真实
//      持球权（不处理传球在途/二点球），只用于相位分桶与报告，必须显式标注。
//   6. 采样间隔 0.2s（5Hz）——与真实侧 keyframeHz 对齐；两侧同一间隔，相位同构。
//   7. 帧间聚合器 = 均值；某队非门将球员不足 7 人时该帧丢弃（不参与聚合）。
//
// 两侧约定（design D5b）：引擎跑 5400s（引擎默认时长，不是 viewer 的 5 分钟传参），按与
// 真实相同的规则切 300s 窗（步长 900s）→ 5 种子 × 6 窗 = 30 窗；真实侧 2 场 × 7/6 窗
// = 13 个满窗（game2 尾部 246s 残窗丢弃）。

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

// tracking 帧（tools/convert-tracking-to-frames.mjs 产物：players 是 [[x,y]|null × 22]）
// → 统一帧。ballFill 原样透传（球相关指标的取帧策略依赖它）。
export function fromTrackingFrame(frame) {
  return {
    t: frame.t,
    players: frame.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
    ball: frame.ball || null,
    ballFill: frame.ballFill !== undefined ? frame.ballFill : null,
  };
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
// `T + 1` 的容差是为帧时间戳的浮点/采样相位差留的（300s 整窗在 T=5400 时正好贴边）。
// minFrames 是安全网：源数据有缺口时，远短于 300s 的窗不进统计（真实侧 game2 尾部的
// 246s 残窗就由此排除，design 要求如实记录它的存在——基线元数据里有它的时长）。
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

// ── 指标（纯函数） ──────────────────────────────────────────────────────

// 队形指标（单帧、单队、瞬时）。非门将球员不足 MIN_OUTFIELD_PLAYERS 时返回 null（丢帧）。
//   depth  = trim1 纵深（米）：按 x 排序后掐头去尾各 1 人，剩余球员的 x 跨度
//   width  = y 方向跨度（米）（报告项；实测与真实重叠，不进断言）
//   cx/cy  = 非门将球员重心（米）
//   spread = 到重心的平均距离（米）——「紧凑度」
export function teamShape(frame, team) {
  const players = frame && Array.isArray(frame.players) ? frame.players : null;
  if (!players) return null;
  const isHome = team === 'home';
  const outfield = players.filter((p) => p && !KEEPER_IDS.includes(p.id)
    && (isHome ? p.id <= 10 : p.id >= 11));
  if (outfield.length < MIN_OUTFIELD_PLAYERS) return null;

  // trim1：排序后 s[len-2] - s[1]（掐掉最小与最大各 1 人；只掐坐标，与球员身份无关）
  const xs = outfield.map((p) => p.x * PITCH_LENGTH_M).sort((a, b) => a - b);
  const ys = outfield.map((p) => p.y * PITCH_WIDTH_M);
  const depth = xs[xs.length - 2] - xs[1];

  // 重心与 spread 按**同一球员**的 (x,y) 配对计算（历史教训：探针曾把排序后的 x 与
  // 未排序的 y 按下标配对，结果差 ~0.1-0.2m——量级小但属于口径错误，实现按正确配对）
  const cx = mean(xs);
  const cy = mean(ys);
  const spread = mean(outfield.map((p) => Math.hypot(
    p.x * PITCH_LENGTH_M - cx, p.y * PITCH_WIDTH_M - cy,
  )));

  return { depth, width: Math.max(...ys) - Math.min(...ys), cx, cy, spread, n: outfield.length };
}

// 控球代理：离球最近者所属队（含门将参与判定）。显式标注为**代理**——不等于真实持球权
// （不处理传球在途、二点球）；只用于相位分桶与报告，不作为引擎事实。
export function possessionProxy(frame) {
  if (!frame || !frame.ball || !Array.isArray(frame.players)) return null;
  const [bx, by] = [frame.ball[0] * PITCH_LENGTH_M, frame.ball[1] * PITCH_WIDTH_M];
  let best = null;
  for (const p of frame.players) {
    if (!p) continue;
    const d = Math.hypot(p.x * PITCH_LENGTH_M - bx, p.y * PITCH_WIDTH_M - by);
    if (!best || d < best.d) best = { d, id: p.id };
  }
  return best ? (best.id <= 10 ? 'home' : 'away') : null;
}

// 单帧的对队形指标（需要两队都有效；任一队非门将 <7 → 整帧丢弃）。
// ballDist = 主队重心到球的距离（米），无球帧为 null（球相关指标不进非球帧的聚合）。
export function frameMetrics(frame) {
  const home = teamShape(frame, 'home');
  const away = teamShape(frame, 'away');
  if (!home || !away) return null;
  let ballDist = null;
  if (frame.ball && isFiniteNumber(frame.ball[0]) && isFiniteNumber(frame.ball[1])) {
    ballDist = Math.hypot(
      home.cx - frame.ball[0] * PITCH_LENGTH_M,
      home.cy - frame.ball[1] * PITCH_WIDTH_M,
    );
  }
  return { home, away, gap: Math.hypot(home.cx - away.cx, home.cy - away.cy), ballDist };
}

// 窗口聚合：先对每帧算指标（瞬时队形），再对帧取均值（口径 2 与 7）。
// 主口径（rawBallOnly=true）的球相关量只用原始球帧；全帧对照并列返回（报告项）。
export function windowMetrics(frames, { rawBallOnly = true } = {}) {
  const hd = []; const ad = []; const spread = []; const gap = []; const width = [];
  const ballDist = []; const ballDistAll = [];
  let possessionHome = 0; let possessionN = 0;
  let frameCount = 0;
  for (const f of frames) {
    const m = frameMetrics(f);
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
        const pos = possessionProxy(f);
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
}

// 弹性（口径敏感性报告，不作校准目标、不进断言——design D4）：
// 主队纵深在「球在本队一侧」与「球在对方一侧」两桶间的均值差 Δ = opp - own。
// 两种同样合理的分桶口径并列：'half'=球在主队半场与否；'centroid'=球在本队重心前后。
// 「半场口径下真实 4.5m vs 引擎 11.3m 的 2.6×」是分桶口径的产物——换重心口径信号消失
// （真实 −0.1m）。这个量不稳，报告出来是为了让读者看到它对口径的依赖。
export function elasticity(frames, { divider = 'half', rawBallOnly = true } = {}) {
  const own = []; const opp = [];
  for (const f of frames) {
    if (!f.ball || !isFiniteNumber(f.ball[0])) continue;
    if (rawBallOnly && !isRawBallFrame(f)) continue;
    const shape = teamShape(f, 'home');
    if (!shape) continue;
    const inOwnSide = divider === 'half'
      ? f.ball[0] < 0.5
      : f.ball[0] * PITCH_LENGTH_M < shape.cx;
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
export function summarizeWindowMetrics(metricsList) {
  const keys = ['hd', 'ad', 'spread', 'gap', 'width', 'ballDist', 'ballDistAllFrames',
    'possessionHome', 'ballDistFrames', 'possessionFrames', 'frameCount'];
  const out = {};
  for (const k of keys) {
    const vals = metricsList.map((m) => m[k]).filter((v) => v != null);
    out[k] = summarizeValues(vals);
  }
  return out;
}
