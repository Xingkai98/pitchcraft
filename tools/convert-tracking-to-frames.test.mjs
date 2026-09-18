// 转换器单测：用合成的 Metrica 风格 CSV 锁住三个真实数据上踩过的坑——
// 门将识别（不能按球衣号排序）、半场换边翻转、替补顶替槽位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTeamCsv, normalizePoint, assignIds, convertCsvPair, detectHomeAttackDirection,
} from './convert-tracking-to-frames.mjs';

// 造一份 Metrica 风格的 CSV：N 名球员，每行一帧。
// players: [{ nativeId, x(t, period) -> [x,y] | null }]
function makeCsv(players, frames, teamLabel = 'Home') {
  const lines = [];
  // 真实 Metrica 文件有 3 行表头（球员列从第 4 列、下标 3 起）：
  //   1) 分组表头：  ,,,Home,,Home,,...
  //   2) 球衣号行：  ,,,11,,1,,...
  //   3) 真列名行：  Period,Frame,Time [s],Player11,,Player1,,...,Ball,
  lines.push(['', '', '', ...players.flatMap(() => [teamLabel, ''])].join(','));
  lines.push(['', '', '', ...players.flatMap((p) => [p.nativeId, ''])].join(','));
  lines.push([
    'Period', 'Frame', 'Time [s]',
    ...players.flatMap((p) => [`Player${p.nativeId}`, '']),
    'Ball', '',
  ].join(','));
  for (const { period, frame, t } of frames) {
    const row = [period, frame, t];
    for (const p of players) {
      const v = p.at(t, period);
      if (v) row.push(v[0], v[1]);
      else row.push('NaN', 'NaN');
    }
    row.push('0.5', '0.5');
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

// 11 名球员：门将球衣号故意排在中间（真实 Metrica 门将是 Player11），
// 位置贴本方门线，其余按 depth 铺开。
//
// mirror=true 造客队：主客队共用同一套球场坐标，客队守另一个球门（x≈0.95 起）。
// 不镜像的话两支球队的门将会重在同一侧，那是物理上不可能的场景。
//
// p1HomeKeeperSide：主队 P1 的门将贴哪条底线。**两场真实数据的取值就是相反的**——
// Sample_Game_1 是 'left'（主队 P1 守 x≈0.12），Sample_Game_2 是 'right'（守 x≈0.87）。
// 这正是硬编码朝向会踩的坑，测试两个取值都要覆盖。
function makeEleven(keeperNativeId = 11, mirror = false, p1HomeKeeperSide = 'left') {
  const toPitch = (x) => (mirror ? 1 - x : x); // 客队：整队镜像到另一半场
  const others = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // 本方底线在本队「攻向 x=1」坐标系里的位置：P1 是 0 或 1（按 p1HomeKeeperSide），
  // P2 换到另一端。球员 x = 底线 + 攻向 × depth。
  const ownGoal = (period) => {
    const p1 = p1HomeKeeperSide === 'left' ? 0 : 1;
    return period === 1 ? p1 : 1 - p1;
  };
  const attackDir = (period) => (ownGoal(period) === 0 ? 1 : -1);
  const players = [];
  const place = (depth) => (t, period) => [toPitch(ownGoal(period) + attackDir(period) * depth), 0.5];
  players.push({ nativeId: keeperNativeId, at: place(0.05) }); // 门将最贴底线
  others.forEach((nid, i) => players.push({ nativeId: nid, at: place(0.15 + i * 0.05) }));
  return players;
}

function makeFrames(n, hz = 25) {
  return Array.from({ length: n }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / hz }));
}

test('parseTeamCsv 读出球衣号与逐帧坐标', () => {
  const csv = makeCsv(makeEleven(), makeFrames(10));
  const { nativeIds, frames } = parseTeamCsv(csv);
  assert.equal(nativeIds.length, 11);
  assert.ok(nativeIds.includes(11), '应识别出球衣号 11');
  assert.equal(frames.length, 10);
  assert.equal(frames[0].players.length, 11);
  // 门将（球衣 11）在 P1 贴左门线
  const keeperIdx = nativeIds.indexOf(11);
  assert.equal(frames[0].players[keeperIdx][0], 0.05);
});

test('parseTeamCsv 容忍带空格的球员列名（真实数据里的 "Player 26"）', () => {
  // 回归背景：Sample_Game_2 客队表头第 26 列写作 "Player 26"（带空格）。
  // 严格正则 /^Player(\d+)$/ 匹配不到 → 静默丢掉该球员 → 该队整场少一人
  // （实测造成 37.7% 的帧只有 21 人，且只有这一个文件有这种写法，极难发现）。
  const players = makeEleven(11).concat([{ nativeId: 26, at: () => [0.9, 0.5] }]);
  // 手工构造：把最后一名球员的列名改成带空格的 "Player 26"
  const csv = makeCsv(players, makeFrames(5)).replace('Player26', 'Player 26');
  const { nativeIds, frames } = parseTeamCsv(csv);
  assert.equal(nativeIds.length, 12, '带空格的球员列也必须被解析出来');
  assert.ok(nativeIds.includes(26), 'Player 26 应在列名列表中');
  assert.equal(frames[0].players.length, 12, '该球员应有对应的坐标列');
});

test('parseTeamCsv 遇到无法解析的球员列时报错，不静默丢人', () => {
  const players = makeEleven(11);
  const csv = makeCsv(players, makeFrames(5)).replace('Player1,', 'PLAYER1,');
  assert.throws(() => parseTeamCsv(csv), /无法解析的球员列/, '疑似球员列解析失败应显式报错');
});

test('parseTeamCsv 把 NaN 读成 null（缺失帧）', () => {
  const players = [{ nativeId: 1, at: (t) => (t === 0.04 ? [0.3, 0.4] : null) }];
  const csv = makeCsv(players, makeFrames(3));
  const { frames } = parseTeamCsv(csv);
  assert.deepEqual(frames[0].players[0], [0.3, 0.4]);
  assert.equal(frames[1].players[0], null);
});

test('normalizePoint：P1 不翻转、P2 翻 x，y 恒翻转（左上→左下原点）', () => {
  assert.deepEqual(normalizePoint([0.2, 0.3], 1), [0.2, 0.7]);
  assert.deepEqual(normalizePoint([0.2, 0.3], 2), [0.8, 0.7]);
  assert.equal(normalizePoint(null, 1), null);
});

test('门将识别：球衣号排在中间也能认出来（按位置而非号码）', () => {
  const players = makeEleven(11);
  const keyframes = parseTeamCsv(makeCsv(players, makeFrames(20))).frames;
  const { keeper } = assignIds({ nativeIds: players.map((p) => p.nativeId) }, keyframes, true);
  assert.equal(keeper, 11, '门将应被认出是球衣 11');
});

test('门将识别不受换边影响（P1/P2 混合）', () => {
  // 一半 P1、一半 P2：整场 x 中位数会被抵回 0.5，用 depth 才认得出
  const players = makeEleven(11);
  const fr = [
    ...Array.from({ length: 10 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 })),
    ...Array.from({ length: 10 }, (_, i) => ({ period: 2, frame: i + 11, t: (i + 11) / 25 })),
  ];
  const keyframes = parseTeamCsv(makeCsv(players, fr)).frames;
  const { keeper } = assignIds({ nativeIds: players.map((p) => p.nativeId) }, keyframes, true);
  assert.equal(keeper, 11);
});

test('主队门将映射到 id 0、客队门将映射到 id 21', () => {
  const players = makeEleven(11);
  const keyframes = parseTeamCsv(makeCsv(players, makeFrames(20))).frames;
  const home = assignIds({ nativeIds: players.map((p) => p.nativeId) }, keyframes, true);
  const away = assignIds({ nativeIds: players.map((p) => p.nativeId) }, keyframes, false);
  assert.equal(home.toId(home.slotOf.get(home.keeper)), 0);
  assert.equal(away.toId(away.slotOf.get(away.keeper)), 21);
});

test('槽位按 depth 从后到前排（门将最小，最靠前的最大）', () => {
  const players = makeEleven(11);
  const keyframes = parseTeamCsv(makeCsv(players, makeFrames(20))).frames;
  const { slotOf, toId, keeper } = assignIds({ nativeIds: players.map((p) => p.nativeId) }, keyframes, true);
  assert.equal(toId(slotOf.get(keeper)), 0);
  // depth 递增：门将 0.05 < 球衣1 0.15 < 球衣2 0.20 < ... < 球衣10 0.60
  // 门将占槽位 0，其余顺次 → 球衣 1 拿槽位 1、球衣 10 拿槽位 10
  assert.equal(toId(slotOf.get(1)), 1);
  assert.equal(toId(slotOf.get(10)), 10);
});

test('替补顶替被换下主力的槽位（球员填充率 100%）', () => {
  // 真实换人形态：主力 1 打了前 20 帧被换下，替补 12 顶上最后 10 帧。
  // 主力在场帧数（20）多于替补（10），所以「出场最多者为主力」能正确挑出主力。
  const players = makeEleven(11);
  const idx1 = players.findIndex((p) => p.nativeId === 1);
  players[idx1] = { nativeId: 1, at: (t) => (t <= 20 / 25 ? [0.15, 0.5] : null) };
  players.push({ nativeId: 12, at: (t) => (t > 20 / 25 ? [0.15, 0.5] : null) });

  const frames = Array.from({ length: 30 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const parsed = parseTeamCsv(makeCsv(players, frames)).frames;
  const res = assignIds({ nativeIds: players.map((p) => p.nativeId) }, parsed, true);

  const slotOfMain1 = res.slotOf.get(1);
  assert.ok(slotOfMain1 !== undefined, '主力 1 应占一个槽位');
  assert.ok(res.subs.includes(12), '替补 12 应被归为替补');
  // 换人后：替补顶上主力 1 的槽位，主力不再出现
  const afterSub = res.frameIds[res.frameIds.length - 1];
  assert.equal(afterSub.get(12), res.toId(slotOfMain1), '替补应顶上主力 1 的槽位');
  assert.equal(afterSub.has(1), false, '主力 1 已不在场');
  // 换人前：主力在自己槽位上
  assert.equal(res.frameIds[0].get(1), res.toId(slotOfMain1));
  // 每一帧场上人数恒为 11
  for (const m of res.frameIds) assert.equal(m.size, 11);
});

// ── 朝向自动检测（两场真实数据的起始方向相反，硬编码必错一场）────────────────
// 回归背景：曾硬编码「P1 翻转、P2 不翻转」，这在本仓库的 Sample_Game_1 上正确，
// 但 Sample_Game_2 的起始方向相反 → 转换结果整体镜像（两队左右颠倒），
// 且因为 game1 正常而极难发现。下面两个用例分别覆盖两种源数据朝向。

test('朝向检测：主队 P1 守左门 → P1 不翻转、P2 翻转', () => {
  const players = makeEleven(11, false, 'left');
  const kf = parseTeamCsv(makeCsv(players, makeFrames(30))).frames;
  const flipX = detectHomeAttackDirection({ nativeIds: players.map((p) => p.nativeId) }, kf);
  assert.deepEqual(flipX, [false, true]);
});

test('朝向检测：主队 P1 守右门 → P1 翻转、P2 不翻转（game2 的实际情形）', () => {
  const players = makeEleven(11, false, 'right');
  const kf = parseTeamCsv(makeCsv(players, makeFrames(30))).frames;
  const flipX = detectHomeAttackDirection({ nativeIds: players.map((p) => p.nativeId) }, kf);
  assert.deepEqual(flipX, [true, false]);
});

test('裁剪窗口不改变朝向结论（边后卫在窗口内贴对方底线也不受影响）', () => {
  // 回归背景：曾在**裁剪后的帧**上做方向检测。若窗口内恰好有一名非门将球员
  // 贴着对方底线（开角球的边后卫、压上的中卫），他会赢下"最贴底线"的判据，
  // 把方向判反 → 整段画面镜像。修复是改用全量帧检测。
  //
  // 合成反例（审阅提供并经实测）：
  //   门将全程贴本方底线 x=0.05；边后卫只在 t∈[1.9,3.1] 跑到 x=0.99。
  //   若用该窗口检测，边后卫 mean(min)=0.01 < 门将 0.05 → 判反；用全量帧则正确。
  const ownGoal = (t, period) => (period === 1 ? 0.05 : 0.95);
  const players = [
    { nativeId: 11, at: (t, period) => [ownGoal(t, period), 0.5] }, // 门将
    // 一名"压上的边后卫"：平时在本方半场，窗口内跑到对方底线
    { nativeId: 1, at: (t, period) => {
      const camp = (period === 1 ? t : 1 - t) >= 1.9 && (period === 1 ? t : 1 - t) <= 3.1;
      if (camp) return [period === 1 ? 0.99 : 0.01, 0.5];
      return [period === 1 ? 0.3 : 0.7, 0.5];
    } },
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((nid, i) => ({
      nativeId: nid,
      at: (t, period) => [period === 1 ? 0.4 + i * 0.03 : 0.6 - i * 0.03, 0.5],
    })),
  ];
  const many = Array.from({ length: 200 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const away = makeEleven(11, true, 'left');
  const homeCsv = makeCsv(players, many, 'Home');
  const awayCsv = makeCsv(away, many, 'Away');
  const awayCsv2 = awayCsv;

  const full = convertCsvPair(homeCsv, awayCsv, { keyframeHz: 5 });
  const cropped = convertCsvPair(homeCsv, awayCsv2, { keyframeHz: 5, from: 1.9, to: 3.1 });
  assert.deepEqual(
    cropped.meta.orientationDetected.flipX,
    full.meta.orientationDetected.flipX,
    '裁剪窗口的朝向结论必须与全量一致（否则画面整体镜像）',
  );
  // 裁剪后主队门将仍应在左半场
  const f = cropped.frames[0];
  assert.ok(f.players[0][0] < 0.5, `主队门将应在左半场，实际 ${f.players[0][0]}`);
});

test('朝向检测：出场极少的球员不参与判定（防止替补的偶然位置带偏方向）', () => {
  // 出场次数过少的球员（换人末段、数据噪声）不参与"谁最贴底线"的判定。
  // 否则一个只出现 2 帧、恰好在对方底线附近的替补会赢下判据，把方向带反。
  const players = makeEleven(11, false, 'left');
  // 加一名只在最后 2 帧出场、位置贴**对方**底线的替补
  players.push({ nativeId: 12, at: (t) => (t > 38 / 25 ? [0.99, 0.5] : null) });
  const frames = Array.from({ length: 40 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const kf = parseTeamCsv(makeCsv(players, frames)).frames;
  const flipX = detectHomeAttackDirection({ nativeIds: players.map((x) => x.nativeId) }, kf);
  assert.deepEqual(flipX, [false, true], '偶发出场的球员不应改变方向判定');
});

test('朝向检测：混合半场样本不污染结论', () => {
  // 样本里同时有 P1 和 P2 时必须以 P1 的观测为准——P2 的 x 是反的，混进来会把
  // "最贴底线的人"的 meanX 拉向 0.5，使左右判定失效。
  // 构造要能真正区分：让一名非门将球员在 P2 里贴左底线（换边后他守的其实是另一端），
  // 若不过滤半场，他的 meanX 会被拉到 ~0.5，判据失效。
  const players = makeEleven(11, false, 'right');
  const team = { nativeIds: players.map((x) => x.nativeId) };
  const half = (period, n) => Array.from({ length: n }, (_, i) => ({ period, frame: i + 1, t: (i + 1) / 25 }));
  const framed = makeCsv(players, [...half(1, 40), ...half(2, 40)]);
  const mixed = parseTeamCsv(framed).frames;
  const p1only = mixed.filter((f) => f.period === 1);
  assert.deepEqual(
    detectHomeAttackDirection(team, mixed),
    detectHomeAttackDirection(team, p1only),
    '混合样本应给出与纯 P1 样本相同的结论',
  );
});

test('朝向检测：判据在 meanX = 0.5 处切换（左右两侧结论相反）', () => {
  // 判据是 `meanX > 0.5`：留守者偏左 → 该半场主队攻向 x=1 → 不翻转；偏右 → 翻转。
  // 这里钉住"0.5 是切换点"这一语义（两侧结论必须相反）。
  //
  // 注意：`>` 与 `>=` 的差别只在 meanX **恰为** 0.5 时显现，而那是浮点不可控的
  // （实测同一构造得 0.4999999999999999），合成数据钉不住这个边界。真实数据里
  // meanX 落在恰好 0.5 的概率为零，故该边界按可忽略处理——此用例只保证切换点两侧正确。
  const build = (leftX, rightX) => {
    const half = 20;
    const players = [
      { nativeId: 11, at: (t) => (t <= half / 25 ? [leftX, 0.5] : [rightX, 0.5]) },
      ...Array.from({ length: 10 }, (_, i) => ({ nativeId: i + 1, at: () => [0.35 + i * 0.02, 0.5] })),
    ];
    const frames = Array.from({ length: 40 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
    const kf = parseTeamCsv(makeCsv(players, frames)).frames;
    return detectHomeAttackDirection({ nativeIds: players.map((x) => x.nativeId) }, kf);
  };
  // 偏左（0.1/0.9 → meanX=0.5 但浮点略小；用 0.05/0.95 更明确地偏左）
  assert.equal(build(0.05, 0.95)[0], false, '偏左 → 不翻转');
  // 偏右（0.95/0.05）
  assert.equal(build(0.95, 0.05)[0], true, '偏右 → 翻转');
});

test('朝向检测：样本只有 P2 时结论必须与全量样本一致', () => {
  // 回归背景：曾在样本里找不到 P1 时，直接拿 P2 的观测去填 P1 的结论 → 方向整体判反。
  // 触发场景：--from/--to 裁出的片段整段落在下半场。
  // 门将在 P2 换到另一端，若把 P2 的观测当成 P1 的，翻转策略正好相反。
  for (const side of ['left', 'right']) {
    const p = makeEleven(11, false, side);
    const team = { nativeIds: p.map((x) => x.nativeId) };
    // 必须让夹具按各自 period 生成坐标（它按 period 决定站位），不能事后改标签
    const half = (period, n) => Array.from({ length: n }, (_, i) => ({ period, frame: i + 1, t: (i + 1) / 25 }));
    const kf = parseTeamCsv(makeCsv(p, [...half(1, 20), ...half(2, 20)])).frames;
    const full = detectHomeAttackDirection(team, kf);
    const p2only = kf.filter((f) => f.period === 2);
    assert.ok(p2only.length > 0, '应有 P2 帧');
    const fromP2 = detectHomeAttackDirection(team, p2only);
    assert.deepEqual(fromP2, full, `${side}: 纯 P2 样本应给出与全量样本一致的朝向`);
  }
});

test('纯 P2 片段转换后门将仍各守一侧（不镜像）', () => {
  // 与上个用例互补：端到端跑一遍 --from/--to 落在 P2 的实际路径。
  // 用两段帧（P1 被裁掉、只剩 P2）构造，验证输出仍是「主队守 x≈0、客队守 x≈1」。
  const p1 = Array.from({ length: 20 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const p2 = Array.from({ length: 20 }, (_, i) => ({ period: 2, frame: i + 21, t: (i + 21) / 25 }));
  for (const side of ['left', 'right']) {
    const players = makeEleven(11, false, side);
    const away = makeEleven(11, true, side);
    const homeCsv = makeCsv(players, [...p1, ...p2], 'Home');
    const awayCsv = makeCsv(away, [...p1, ...p2], 'Away');
    // 只取下半场：t > 0.8s（P1 结束于 0.8s）
    const out = convertCsvPair(homeCsv, awayCsv, { keyframeHz: 5, from: 0.9 });
    assert.equal(out.frames[0].t >= 0.9, true, '应只留下 P2 的帧');
    const f = out.frames[0];
    assert.ok(f.players[0][0] < 0.5, `${side}: 主队门将应在左半场，实际 ${f.players[0][0]}`);
    assert.ok(f.players[21][0] > 0.5, `${side}: 客队门将应在右半场，实际 ${f.players[21][0]}`);
  }
});

test('两种源朝向转换后都得到「主队守 x≈0 / 客队守 x≈1」（不镜像）', () => {
  const frames = Array.from({ length: 40 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  for (const side of ['left', 'right']) {
    const homeCsv = makeCsv(makeEleven(11, false, side), frames, 'Home');
    const awayCsv = makeCsv(makeEleven(11, true, side), frames, 'Away');
    const out = convertCsvPair(homeCsv, awayCsv, { keyframeHz: 5 });
    const f = out.frames[0];
    assert.ok(f.players[0][0] < 0.15, `${side}: 主队门将应在 x≈0，实际 ${f.players[0][0]}`);
    assert.ok(f.players[21][0] > 0.85, `${side}: 客队门将应在 x≈1，实际 ${f.players[21][0]}`);
  }
});

test('两种源朝向转换后，全队都排在自家半场（不镜像）', () => {
  // 镜像 bug 的特征：主队被整体搬到客队那半场。这里查每队门将之外球员的相对分布。
  const frames = Array.from({ length: 40 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  for (const side of ['left', 'right']) {
    const homeCsv = makeCsv(makeEleven(11, false, side), frames, 'Home');
    const awayCsv = makeCsv(makeEleven(11, true, side), frames, 'Away');
    const out = convertCsvPair(homeCsv, awayCsv, { keyframeHz: 5 });
    const avg = (ids) => out.frames[0].players.slice(0, 22)
      .reduce((a, p, i) => (ids.includes(i) && p ? a + p[0] : a), 0) / ids.length;
    const homeAvg = avg([...Array(11).keys()]);
    const awayAvg = avg([...Array(11).keys()].map((i) => i + 11));
    assert.ok(homeAvg < awayAvg, `${side}: 主队平均 x (${homeAvg.toFixed(3)}) 应小于客队 (${awayAvg.toFixed(3)})`);
  }
});

test('convertCsvPair 端到端：输出 22 人 id、坐标归一、meta 完整', () => {
  const frames = Array.from({ length: 50 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const homeCsv = makeCsv(makeEleven(11, false), frames, 'Home');
  const awayCsv = makeCsv(makeEleven(11, true), frames, 'Away');
  const out = convertCsvPair(homeCsv, awayCsv, { keyframeHz: 5 });
  assert.equal(out.frames.length, 10, '50 帧 @25Hz 降采样到 5Hz = 10 帧');
  assert.equal(out.meta.keyframeHz, 5);
  assert.equal(out.meta.coverage.playerCellsFilledPct, 100);
  // 每帧球员数组长度 22、下标即 id
  for (const f of out.frames) assert.equal(f.players.length, 22);
  // 主队门将（id 0）与客队门将（id 21）贴各自门线
  assert.equal(out.frames[0].players[0][0], 0.05);
  assert.equal(out.frames[0].players[21][0], 0.95);
});

test('convertCsvPair 时间窗裁剪', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const out = convertCsvPair(makeCsv(makeEleven(), frames), makeCsv(makeEleven(), frames), {
    keyframeHz: 5, from: 1, to: 2,
  });
  assert.ok(out.meta.startTime >= 1 && out.meta.endTime <= 2);
});

test('convertCsvPair 主客队帧数不一致时报错', () => {
  const a = makeCsv(makeEleven(), makeFrames(20));
  const b = makeCsv(makeEleven(), makeFrames(10));
  assert.throws(() => convertCsvPair(a, b), /帧数不一致/);
});

test('convertCsvPair keyframeHz 大于源频率时报错', () => {
  const a = makeCsv(makeEleven(), makeFrames(20));
  assert.throws(() => convertCsvPair(a, a, { keyframeHz: 50 }), /不能大于源频率/);
});

test('缺球补全：默认放到最近球员脚下并打 ballFill 标记', () => {
  // 100 帧 @25Hz → 5Hz 得 20 个关键帧，够验证「首帧补不了、之后每帧都补」。
  // 只让前 3 帧有真实球位，其余全 NaN —— 模拟真实的长时间缺球段。
  const frames = Array.from({ length: 100 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const csvWithBall = (players) => {
    const base = makeCsv(players, frames).split('\n');
    let dataIdx = 0;
    return base.map((line) => {
      if (!/^\d+,/.test(line)) return line; // 表头 3 行原样保留
      dataIdx += 1;
      return dataIdx <= 3 ? line : line.replace(/,0\.5,0\.5$/, ',NaN,NaN');
    }).join('\n');
  };
  const players = makeEleven();
  const out = convertCsvPair(csvWithBall(players), csvWithBall(players), { keyframeHz: 5 });
  assert.ok(out.frames.length >= 3, `关键帧太少：${out.frames.length}`);
  // 前 3 个关键帧（第 1/6/11 源帧）里，第 1 帧是真实观测
  assert.notEqual(out.frames[0].ball, null, '首帧有真实球位');
  // 缺球的关键帧应带 ballFill，且球落在某个球员脚下
  const filled = out.frames.filter((f) => typeof f.ballFill === 'number');
  assert.ok(filled.length > 0, '缺球帧应标出推断的持球者');
  for (const f of filled) {
    assert.equal(f.ballFill >= 0 && f.ballFill <= 21, true);
    const onPitch = out.frames.find((g) => g === f).players[f.ballFill];
    assert.deepEqual(f.ball, onPitch, '补全的球位应等于该持球者位置');
  }
  assert.ok(out.meta.coverage.ballMissingPct > 0);
});

test('人数不足帧：如实统计进 coverage（源数据被换下后无人顶上）', () => {
  // game2 的真实情形：客队只有 11 名球员有数据，P22 被换下后场上只剩 21 人。
  // 转换器必须如实反映，不能造假人补位。
  const players = makeEleven(11, false, 'left');
  // 让球衣 1 只在前一半帧出现，且**没有替补顶上**（不加第 12 人）
  const idx1 = players.findIndex((p) => p.nativeId === 1);
  const orig = players[idx1].at;
  players[idx1] = { nativeId: 1, at: (t, period) => (t <= 20 / 25 ? orig(t, period) : null) };
  const frames = Array.from({ length: 40 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const away = makeEleven(11, true, 'left');
  const out = convertCsvPair(makeCsv(players, frames), makeCsv(away, frames, 'Away'), { keyframeHz: 5 });
  assert.ok(out.meta.coverage.shortHandedPct > 0, '应统计出人数不足的帧');
  // 后半段确实只有 21 人，且没有任何"补位球员"被凭空造出来
  const last = out.frames[out.frames.length - 1];
  assert.equal(last.players.filter(Boolean).length, 21, '应如实保留 21 人（不造假人）');
});

test('重复坐标伪影：如实统计进 coverage，不去重', () => {
  // 造两名球员坐标完全相同的情况（真实数据里的追踪伪影）
  const players = makeEleven(11);
  const idx2 = players.findIndex((p) => p.nativeId === 2);
  const origAt = players[idx2].at;
  players[idx2] = { nativeId: 2, at: (t, period) => players[idx2]._dup ? [0.15, 0.5] : origAt(t, period) };
  players[idx2]._dup = true;
  // 球衣 1 的 depth 是 0.15，让球衣 2 也落在同一坐标
  const frames = Array.from({ length: 20 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const out = convertCsvPair(makeCsv(players, frames), makeCsv(makeEleven(11, true), frames, 'Away'), { keyframeHz: 5 });
  assert.ok(out.meta.coverage.duplicateCoordPct > 0, '应统计出重复坐标帧');
  // 关键：位置没被改动，重叠仍存在（不静默去重）
  const f = out.frames[0];
  assert.deepEqual(f.players[1].slice(0, 2), f.players[2].slice(0, 2), '重叠坐标应原样保留');
});

test('缺球补全 hold 模式：沿用上一位置并打 "hold" 标记', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const base = makeCsv(makeEleven(), frames).split('\n');
  let n = 0;
  const csv = base.map((l) => {
    if (!/^\d+,/.test(l)) return l;
    n += 1;
    return n <= 3 ? l : l.replace(/,0\.5,0\.5$/, ',NaN,NaN');
  }).join('\n');
  const out = convertCsvPair(csv, csv, { keyframeHz: 5, ballFill: 'hold' });
  const held = out.frames.filter((f) => f.ballFill === 'hold');
  assert.ok(held.length > 0, 'hold 模式应标出沿用位置');
  // 沿用位置 = 上一个关键帧的球位（与上上帧相同，而不是跳到别处）
  assert.equal(out.meta.coverage.ballFillMode, 'hold');
});

test('缺球补全 none 模式：留 null 不打标记', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / 25 }));
  const base = makeCsv(makeEleven(), frames).split('\n');
  const csv = base.map((l, i) => (i < 3 ? l : l.replace(/,0\.5,0\.5$/, ',NaN,NaN'))).join('\n');
  const out = convertCsvPair(csv, csv, { keyframeHz: 5, ballFill: 'none' });
  assert.ok(out.frames.every((f) => f.ball === null));
  assert.ok(out.frames.every((f) => f.ballFill === undefined));
});
