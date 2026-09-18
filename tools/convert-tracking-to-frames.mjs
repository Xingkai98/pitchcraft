#!/usr/bin/env node
// 真实比赛 tracking 数据 → 帧序列 JSON（供 viewer 的"真实比赛"对照模式）。
//
// 定位：这不是"事件流转换器"。tracking 数据本身就是逐帧位置，直接喂给
// viewer 的 renderFrame() 渲染即可——不经过引擎、不经过事件演绎层。
// 目的是让"真实比赛"和"我们引擎的比赛"在同一个球场里背靠背播，把调参从
// 口头描述变成直接视觉对照。设计说明见 .scratch/notes/real-match-reference.md。
//
// 输入格式（第一版）：Metrica Sports sample-data 的 3-CSV 格式（Sample Game 1/2）
//   <前缀>_RawTrackingData_Home_Team.csv   每行一帧，25Hz
//   <前缀>_RawTrackingData_Away_Team.csv
// Sample Game 3 是 EPTS/FIFA 纯文本（点列 + metadata.xml），第一版未支持。
//
// 输出 schema（v1）：
//   {
//     meta: { source, game, hz, keyframeHz, frames, startTime, endTime,
//             coord, orientation, idMap, coverage, notes },
//     frames: [ { t, players: [[x,y]|null × 22], ball: [x,y]|null, ballHeld?: true } ]
//   }
//   players 下标即事件协议球员 id（0-10 主队 / 11-21 客队）；缺帧为 null。
//
// 用法：
//   node tools/convert-tracking-to-frames.mjs --in <目录> --out <输出.json> \
//        [--keyframe-hz 5] [--from 0] [--to 300]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// ── 解析 ────────────────────────────────────────────────────────────────
//
// Metrica 每队一个 CSV，前两行是分组表头，第三行才是真列名：
//   ,,,Home,,Home,...
//   Period,Frame,Time [s],Player11,,Player1,,...
//   1,1,0.04,0.00082,0.48238,...
// 球员列成对出现（x,y），末尾两列是 Ball x,y。
export function parseTeamCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 4) throw new Error('CSV 行数不足（需要 2 行表头 + 至少 1 行数据）');
  const header = lines[2].split(',');

  const nativeIds = [];
  const colOfPlayer = [];
  const suspicious = [];
  for (let i = 3; i < header.length - 2; i += 1) {
    const h = (header[i] || '').trim();
    // 容忍 "Player 26" 这类带空格的写法——真实数据里就有（Sample_Game_2 客队第 26 列）。
    // 严格写成 /^Player(\d+)$/ 会**静默丢掉那名球员**：转换后该队整场少一人，
    // 而且因为只有个别文件有这种写法，极难发现（实测造成 game2 有 37.7% 的帧只有 21 人）。
    const m = /^Player\s*(\d+)$/.exec(h);
    if (m) {
      nativeIds.push(Number(m[1]));
      colOfPlayer.push(i);
    } else if (/^Player/i.test(h)) {
      suspicious.push(h);
    }
  }
  if (nativeIds.length === 0) throw new Error('表头里没找到 PlayerN 列');
  // 疑似球员列但没解析出来（如大小写/格式变体）：宁可报错也不静默漏人。
  if (suspicious.length > 0) {
    throw new Error(`表头里有无法解析的球员列：${suspicious.join(', ')}（期望形如 "Player12" 或 "Player 12"）——请修正常量或解析规则，勿静默丢弃球员`);
  }
  const ballCol = header.length - 2;

  const frames = [];
  for (let li = 3; li < lines.length; li += 1) {
    const c = lines[li].split(',');
    if (c.length < 3) continue;
    const period = Number(c[0]);
    const frame = Number(c[1]);
    const t = Number(c[2]);
    if (!Number.isFinite(period) || !Number.isFinite(frame) || !Number.isFinite(t)) continue;
    const players = colOfPlayer.map((ci) => {
      const x = Number(c[ci]);
      const y = Number(c[ci + 1]);
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    });
    const bx = Number(c[ballCol]);
    const by = Number(c[ballCol + 1]);
    const ball = Number.isFinite(bx) && Number.isFinite(by) ? [bx, by] : null;
    frames.push({ period, frame, t, players, ball });
  }
  return { nativeIds, frames };
}

// ── 坐标归一化 ──────────────────────────────────────────────────────────
//
// Metrica：原点左上 (0,0)，y 向下增长。
// 引擎：x=0 是 home 侧门线；y=0 是下边线、y=1 是上边线（见 engine/src/lib.rs 头注释）。
// viewer 的 normalizedToPixels 做 py = margin + (1-y)*h，即 y=0 画在底部——与引擎一致。
//
// y 轴朝向恒定：y' = 1-y。
//
// x 方向的半场换边**不能靠"P1 翻转、P2 不翻转"这样的硬编码**——实测两场比赛的起始方向
// 约定就相反（Sample_Game_1 主队 P1 守 x≈0.12 左门；Sample_Game_2 主队 P1 守 x≈0.87 右门）。
// 硬编码会让其中一场整体镜像（两队左右颠倒），而且只在某一场暴露、极难发现。
// 所以方向由**数据自己决定**：见 detectHomeAttackDirection()。

// 哪些半场需要把 x 翻成 1-x，才能让主队始终从 x=0 攻向 x=1。
// 返回 [needsFlipForPeriod1, needsFlipForPeriod2]。
//
// 判据：**主队 P1 里最贴本方底线的那个人**（通常是门将）在哪一侧，那一侧就是主队 P1 的
// 防守端。用的量 `min(x, 1-x)` 与朝向无关（离最近一条底线的距离），所以不存在循环依赖。
//
// 它找的是「全场最贴底线的人」而非「名义上的门将」，因此比"认定门将"更稳健：即使门将
// 大幅压上、由某名后卫留守底线，判据仍给出正确朝向（已用构造的边界输入验证）。
// 无人在底线（极端退化）时退回默认约定 [false, true]，即「主队 P1 守左门」。
export function detectHomeAttackDirection(homeTeam, homeKeyframes) {
  const idx = new Map(homeTeam.nativeIds.map((nid, i) => [nid, i]));
  // 挑一个半场来观测。优先 P1；**若样本里没有 P1（例如 --from/--to 裁出的是纯 P2 片段），
  // 就用实际存在的那个半场**——否则会拿 P2 的观测去填 P1 的结论，方向整体判反。
  const periods = new Set(homeKeyframes.map((f) => (f.period > 1 ? 2 : 1)));
  const observed = periods.has(1) ? 1 : 2;
  const sample = homeKeyframes.filter((f) => (f.period > 1 ? 2 : 1) === observed);

  // 参与判定所需的最少观测数：样本越大要求越高（排除偶发出场的替补/噪声），
  // 但样本本身很小时不能卡死（2 帧的样本里每人最多也就 2 次观测）。
  const minObservations = Math.max(1, Math.min(3, Math.ceil(sample.length * 0.3)));

  let best = null;
  for (const nid of homeTeam.nativeIds) {
    const j = idx.get(nid);
    let sum = 0;
    let n = 0;
    for (const f of sample) {
      const p = f.players[j];
      if (p) { sum += Math.min(p[0], 1 - p[0]); n += 1; } // 贴最近底线的程度（与朝向无关）
    }
    if (n < minObservations) continue; // 出场太少的不参与判断
    const d = sum / n;
    if (!best || d < best.d) best = { nid, d, meanX: homeMeanX(sample, j) };
  }
  // 无从判断（样本里每人都没几次观测）。**宁可报错也不猜方向**：猜错会把整场镜像，
  // 而镜像在小窗口上极难被肉眼发现——静默给错比显式失败危险得多。
  if (!best) {
    throw new Error('无法从数据判定主队攻防方向（样本里每名球员的出场帧数都太少）——请用全量帧运行，或检查数据是否完整');
  }

  // 在半场 `observed` 里，主队留守者贴左门（meanX < 0.5）→ 该半场主队本就攻向 x=1，不翻转。
  const flipsInObserved = best.meanX > 0.5;
  // 换算到两个半场：主队 P1 与 P2 的攻防方向相反
  return observed === 1 ? [flipsInObserved, !flipsInObserved] : [!flipsInObserved, flipsInObserved];
}

function homeMeanX(frames, col) {
  let sum = 0;
  let n = 0;
  for (const f of frames) {
    const p = f.players[col];
    if (p) { sum += p[0]; n += 1; }
  }
  return n ? sum / n : 0.5;
}

// 把逐帧坐标摆成「主队始终从 x=0 攻向 x=1」再加 y 翻转。
// flipX 是 [period1 是否翻转, period2 是否翻转]（由 detectHomeAttackDirection 给出）。
export function makeNormalizer(flipX) {
  return (p, period) => {
    if (p == null) return null;
    const [x, y] = p;
    const flip = period <= 1 ? flipX[0] : flipX[1];
    return [flip ? 1 - x : x, 1 - y];
  };
}

// 单点的 y 翻转（无方向信息时用；convertCsvPair 走 makeNormalizer）。
export function normalizePoint(p, period) {
  return makeNormalizer([false, true])(p, period);
}

// ── id 分配 ─────────────────────────────────────────────────────────────
//
// 输出 id 语义（事件协议）：0 = 主队门将，21 = 客队门将，1-10 / 11-20 其余。
//
// Metrica 每队有 14 名球员（11 主力 + 3 替补），不能按球衣号直接排序：
// 门将的球衣号是 11，排序后会落到中间。
//
// 识别门将 / 排防守深度用「距离本方门线的平均距离」：
//   depth = mean(x 折算到该队自己的攻防坐标系后的值)
//
// 折算依赖本场的实际朝向，由调用方传入 flipX（见 detectHomeAttackDirection）：把每帧摆成
// 「该队攻向 x=1」后，本方门线恒在 0，depth 就是离本方门线的距离，换边不变。
//
// 两个反面教材（都实测踩过）：
//   1. 用整场 x 中位数——换边把它抵回 0.5，门将认不出来；
//   2. 用 min(x, 1-x)——在 x=0.5 处折叠，踢过半场的前锋会被算得比后卫还"深"；
//   3. 硬编码「主队 P1 守左门」——两场比赛的起始方向约定可以相反（见 detectHomeAttackDirection），
//      硬编码会让其中一场整体镜像。
//
// depth 越小越贴本方门线：门将最小，其次后卫、中场、前锋。
export function assignIds(team, keyframes, isHome, flipX = [false, true]) {
  const idx = new Map(team.nativeIds.map((nid, i) => [nid, i]));
  const has = (f, nid) => f.players[idx.get(nid)] != null;
  const count = new Map(team.nativeIds.map((nid) => [nid, keyframes.reduce((a, f) => a + (has(f, nid) ? 1 : 0), 0)]));
  // 折算到「该队攻向 x=1」的坐标系：主队直接用检测出的 flipX；客队相反（同一块场地上
  // 两队朝向相反，客队守的是主队攻向的那一端）。
  const teamFlip = (period) => {
    const homeFlips = period <= 1 ? flipX[0] : flipX[1];
    return isHome ? homeFlips : !homeFlips;
  };
  const depth = new Map(team.nativeIds.map((nid) => {
    let sum = 0;
    let n = 0;
    for (const f of keyframes) {
      const p = f.players[idx.get(nid)];
      if (p) {
        sum += teamFlip(f.period) ? 1 - p[0] : p[0];
        n += 1;
      }
    }
    return [nid, n ? sum / n : 0.5];
  }));

  // 主力 = 出场帧数前 11；替补继承被换下主力的槽位
  const ranked = [...team.nativeIds].sort((a, b) => count.get(b) - count.get(a) || depth.get(a) - depth.get(b));
  const main = ranked.slice(0, 11);
  const subs = ranked.slice(11);

  // 槽位 0-10：按 depth 从后到前，主队门将占槽位 0（id 0）、客队门将占槽位 10（id 21）
  const slotOf = new Map();
  [...main].sort((a, b) => depth.get(a) - depth.get(b)).forEach((nid, i) => {
    slotOf.set(nid, isHome ? i : 10 - i);
  });

  const toId = (slot) => (isHome ? slot : 11 + slot);
  // 逐帧映射：主力在哪就给它的槽位；主力缺席时由在场替补顶上该槽位
  const frameIds = keyframes.map((f) => {
    const m = new Map();
    for (const nid of main) if (has(f, nid)) m.set(nid, toId(slotOf.get(nid)));
    const absent = main.filter((nid) => !has(f, nid));
    const subsOn = subs.filter((nid) => has(f, nid));
    absent.forEach((mainNid, i) => {
      if (subsOn[i] != null) m.set(subsOn[i], toId(slotOf.get(mainNid)));
    });
    return m;
  });

  const keeper = [...main].sort((a, b) => depth.get(a) - depth.get(b))[0];
  return { frameIds, keeper, main, subs, slotOf, toId, depth };
}

// ── 主转换 ──────────────────────────────────────────────────────────────

export function convertCsvPair(homeCsvText, awayCsvText, opts = {}) {
  const keyframeHz = opts.keyframeHz ?? 5;
  const hz = opts.hz ?? 25;
  // 缺球补全策略：nearest（默认，放到最近球员脚下）| hold（沿用上一位置）| none（留 null）
  const ballFillMode = opts.ballFill ?? 'nearest';
  if (keyframeHz > hz) throw new Error(`--keyframe-hz (${keyframeHz}) 不能大于源频率 (${hz})`);
  const stride = Math.max(1, Math.round(hz / keyframeHz));

  const home = parseTeamCsv(homeCsvText);
  const away = parseTeamCsv(awayCsvText);
  if (home.frames.length !== away.frames.length) {
    throw new Error(`主客队帧数不一致（home=${home.frames.length} away=${away.frames.length}）——两份文件应对应同一场比赛`);
  }

  // 时间窗裁剪（秒），在降采样之前做
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const pick = (frames) => frames.filter((f) => f.t >= from && f.t <= to);
  const homeSel = pick(home.frames);
  const awaySel = pick(away.frames);
  if (homeSel.length === 0) throw new Error(`时间窗 [${from}, ${to}] 内没有帧`);

  const keyframes = homeSel.filter((_, i) => i % stride === 0).map((hf, k) => ({ h: hf, a: awaySel[k * stride] }));
  const homeKf = keyframes.map((x) => x.h);
  const awayKf = keyframes.map((x) => x.a);

  // 朝向由数据决定，不靠约定（见 detectHomeAttackDirection 的注释：两场比赛的起始方向可以相反）。
  //
  // **必须在全量帧上检测，不能用裁剪后的 keyframes**：朝向是整场比赛的属性，而裁剪窗口
  // 可能只覆盖很短一段（见 --from/--to）。短窗口里「最贴底线的人」可能是开角球的边后卫或
  // 己方禁区内的防守球员，据此判方向会**静默镜像**。实测 game1 的 55-65s、630-750s 窗口
  // 都因此判反。全量帧让偶发个例在平均中抵消；这样裁剪只影响输出范围，不影响朝向判定。
  const fullKeyframes = home.frames.filter((_, i) => i % stride === 0);
  const flipX = detectHomeAttackDirection(home, fullKeyframes);
  const normalize = makeNormalizer(flipX);

  const homeIds = assignIds(home, homeKf, true, flipX);
  const awayIds = assignIds(away, awayKf, false, flipX);

  let ballMissing = 0;
  let lastBall = null;
  const frames = keyframes.map(({ h, a }, k) => {
    const players = new Array(22).fill(null);
    for (const nid of home.nativeIds) {
      const id = homeIds.frameIds[k].get(nid);
      if (id != null) players[id] = normalize(h.players[home.nativeIds.indexOf(nid)], h.period);
    }
    for (const nid of away.nativeIds) {
      const id = awayIds.frameIds[k].get(nid);
      if (id != null) players[id] = normalize(a.players[away.nativeIds.indexOf(nid)], a.period);
    }
    const rawBall = normalize(h.ball, h.period);
    let ball = rawBall;
    let ballFill = null;
    if (ball) {
      lastBall = ball;
    } else {
      ballMissing += 1;
      // 球的缺失是长时段（实测最长 131s），直接沿用上一个已知位置会让球原地冻结、
      // 反而误导观察。缺球时按控球直觉补：把球放在「离最后已知球位最近的球员」脚下。
      // 这是启发式补全，不是真实观测——用 ballFill 标出来，画面层可以据此弱化显示。
      if (ballFillMode === 'nearest' && lastBall) {
        let bestId = -1;
        let bestD = Infinity;
        for (let i = 0; i < 22; i += 1) {
          const p = players[i];
          if (!p) continue;
          const d = (p[0] - lastBall[0]) ** 2 + (p[1] - lastBall[1]) ** 2;
          if (d < bestD) { bestD = d; bestId = i; }
        }
        if (bestId >= 0) {
          ball = players[bestId];
          ballFill = bestId;
          lastBall = ball;
        }
      } else if (ballFillMode === 'hold' && lastBall) {
        ball = lastBall;
        ballFill = 'hold';
      }
    }
    const out = { t: h.t, players, ball };
    if (ballFill !== null) out.ballFill = ballFill;
    return out;
  });

  const playerCells = frames.length * 22;
  const filled = frames.reduce((a, f) => a + f.players.filter(Boolean).length, 0);

  // 场上人数不足 22 的帧（源数据里就少人，例如被换下后无替补顶上）
  let shortHanded = 0;
  for (const f of frames) if (f.players.filter(Boolean).length < 22) shortHanded += 1;

  // 重复坐标伪影：原始数据里同一帧两名球员坐标完全相同（实测 Sample_Game_1 主队队内
  // 1.78% 的原始帧；5Hz 采样后同队 + 跨队合计 4.86%）。跨队精确重合物理上几乎不可能，
  // 是追踪伪影，不是真实贴身。渲染时会表现为两个圆点完全重叠（看起来像一个）。
  // 如实统计而不去重：这是参照数据的真实质量，静默挪动位置比暴露它更误导。
  let dupFrames = 0;
  for (const f of frames) {
    const seen = new Set();
    let dup = false;
    for (const p of f.players) {
      if (!p) continue;
      const key = `${p[0]},${p[1]}`;
      if (seen.has(key)) dup = true;
      else seen.add(key);
    }
    if (dup) dupFrames += 1;
  }

  return {
    meta: {
      source: 'metrica-sports/sample-data',
      format: 'metrica-3csv',
      hz,
      keyframeHz,
      frames: frames.length,
      startTime: frames[0].t,
      endTime: frames[frames.length - 1].t,
      coord: { origin: 'bottom-left', axis: '0-1', note: '与引擎一致：x=0 是 home 门线，y=0 是下边线' },
      orientation: 'normalized: home always attacks x=0 -> x=1',
      // 检测出的翻转策略（[P1 是否翻, P2 是否翻]）与源数据的原始朝向，便于排查
      orientationDetected: { flipX, sourcePeriod1HomeKeeperSide: flipX[0] ? 'right' : 'left' },
      idMap: {
        home: Object.fromEntries([...homeIds.slotOf].map(([nid, slot]) => [nid, homeIds.toId(slot)])),
        away: Object.fromEntries([...awayIds.slotOf].map(([nid, slot]) => [nid, awayIds.toId(slot)])),
      },
      coverage: {
        playerCellsFilledPct: Number((100 * filled / playerCells).toFixed(2)),
        // 场上人数不足 22 的帧占比：源数据里球员被换下后可能**无人顶上**（原始 CSV 如此），
        // 此时如实反映、不造假人补位。当前两场 Metrica 数据都是 0%。
        // 留作安全网——「少一个圆点」容易被误当成渲染 bug，有个显式指标能一眼排除。
        // 注意 playerCellsFilledPct 会把"整场少一人"稀释成 ~1.7%，单看那个数字容易漏读。
        shortHandedPct: Number((100 * shortHanded / frames.length).toFixed(2)),
        ballMissingPct: Number((100 * ballMissing / frames.length).toFixed(2)),
        ballFillMode,
        duplicateCoordPct: Number((100 * dupFrames / frames.length).toFixed(2)),
        note: '均为数据固有质量指标，非转换错误：球缺失是长时段（实测最长连续 131s），补全帧带 ballFill 标记；人数不足是被换下后无人顶上（如实反映，不造假人）；重复坐标是追踪伪影（同帧两人坐标完全相同，渲染时圆点重叠），未去重以免静默挪动位置',
      },
    },
    frames,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { keyframeHz: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--keyframe-hz') out.keyframeHz = Number(argv[++i]);
    else if (a === '--hz') out.hz = Number(argv[++i]);
    else if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--ball-fill') out.ballFill = argv[++i];
  }
  if (out.ballFill !== undefined && !['nearest', 'hold', 'none'].includes(out.ballFill)) {
    throw new Error(`--ball-fill 只接受 nearest / hold / none，收到 ${out.ballFill}`);
  }
  return out;
}

export function resolveInputs(inPath) {
  const p = resolve(inPath);
  if (p.endsWith('.csv')) {
    return { homePath: p, awayPath: p.replace(/_Home_Team\.csv$/, '_Away_Team.csv') };
  }
  const files = readdirSync(p);
  const homeName = files.find((f) => f.endsWith('_RawTrackingData_Home_Team.csv'));
  if (!homeName) throw new Error(`目录里找不到 *_RawTrackingData_Home_Team.csv：${p}`);
  return { homePath: resolve(p, homeName), awayPath: resolve(p, homeName.replace('_Home_Team.csv', '_Away_Team.csv')) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error('用法: node tools/convert-tracking-to-frames.mjs --in <目录或 Home CSV> --out <输出.json> [--keyframe-hz 5] [--from 0] [--to 300]');
    process.exit(1);
  }
  const { homePath, awayPath } = resolveInputs(args.in);
  if (!existsSync(homePath) || !existsSync(awayPath)) {
    throw new Error(`找不到 tracking CSV：\n  ${homePath}\n  ${awayPath}`);
  }
  const result = convertCsvPair(readFileSync(homePath, 'utf8'), readFileSync(awayPath, 'utf8'), {
    keyframeHz: args.keyframeHz, hz: args.hz, from: args.from, to: args.to,
    ballFill: args.ballFill,
  });
  result.meta.game = basename(homePath).split('_').slice(0, 3).join('_');
  writeFileSync(args.out, JSON.stringify(result));
  const bytes = readFileSync(args.out).length;
  const c = result.meta.coverage;
  console.error(`✔ ${args.out}`);
  console.error(`  ${result.meta.frames} 帧 @ ${result.meta.keyframeHz}Hz | 时长 ${result.meta.startTime.toFixed(1)}-${result.meta.endTime.toFixed(1)}s | ${(bytes / 1e6).toFixed(2)} MB`);
  console.error(`  球员填充率 ${c.playerCellsFilledPct}% | 球缺失率 ${c.ballMissingPct}%`
    + (c.shortHandedPct > 0 ? ` | 人数不足帧 ${c.shortHandedPct}%` : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
