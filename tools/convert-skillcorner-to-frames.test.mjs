// SkillCorner 转换器单测：用**合成**的 match.json + tracking JSONL 锁住 design D1–D4 的
// 每一项要求——独立于 1.8GB 真实数据，纯逻辑可复现。
//
// 覆盖（对应 tasks P1.4）：
//   - LFS 指针识别（读到指针必须报错，不能静默产出 0 帧）
//   - 坐标归一（含 104/105/106 三种球场尺寸，不得硬编码）
//   - 朝向（left_to_right 与 right_to_left 两种，且判反要报错）
//   - 身份映射（含 position_group="Other" 的门将——必须用 player_role.name）
//   - 时间轴拼接（构造回跳输入，断言输出单调）
//   - 外推标记透传（is_detected=false → 坐标第三位）
//   - 缺球补全
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClock, parseTrackingJsonl, stitchTimeline, timelineGaps, isGoalkeeper,
  makeNormalizer, assignSkillcornerIds, convertSkillcorner, EXTRAPOLATED_FLAG,
} from './convert-skillcorner-to-frames.mjs';

// ── 合成数据构造 ────────────────────────────────────────────────────────

// 一支 11 人的队：1 门将 + 10 非门将。x 用米（球场中心原点）。
// `role` 决定 player_role.name；门将故意给 position_group="Other"（真实数据如此）。
function roster(teamId, ids, { keeperIsOther = true } = {}) {
  const out = [];
  ids.forEach((id, i) => {
    const isGk = i === 0;
    out.push({
      id,
      team_id: teamId,
      player_role: isGk
        ? { name: 'Goalkeeper', position_group: keeperIsOther ? 'Other' : 'Goalkeeper' }
        : { name: 'Center Back', position_group: 'Defender' },
    });
  });
  return out;
}

// 一帧：每队 11 点，x 按 depth 从本方门线铺开（主队攻向 x=1 时为 -L/2 + depth）。
// `side` 是 home_team_side[period-1]：'left_to_right' 表示主队该半场攻向 x=+。
function frameAt(frame, period, clockSec, { L, homeSide, detected = () => true } = {}) {
  const hh = String(Math.floor(clockSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((clockSec % 3600) / 60)).padStart(2, '0');
  const ss = (clockSec % 60).toFixed(2).padStart(5, '0');
  const player_data = [];
  const home = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const away = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  // 主队：攻向 +x 时 x = -L/2 + depth*L；攻向 -x 时镜像。
  const place = (i, attackPlus) => {
    const depth = 0.03 + i * 0.08; // 0.03 .. 0.83，门将最浅
    const x01 = attackPlus ? depth : 1 - depth;
    return [(x01 - 0.5) * L, 0];
  };
  const homeAttackPlus = homeSide === 'left_to_right';
  home.forEach((id, i) => {
    const [x, y] = place(i, homeAttackPlus);
    player_data.push({ player_id: id, x: x + (i % 2 ? 0.5 : -0.5), y, is_detected: detected(id, i) });
  });
  away.forEach((id, i) => {
    const [x, y] = place(i, !homeAttackPlus);
    player_data.push({ player_id: id, x: x + (i % 2 ? 0.5 : -0.5), y, is_detected: detected(id, i) });
  });
  return {
    frame,
    timestamp: `${hh}:${mm}:${ss}`,
    period,
    ball_data: { x: 0, y: 0, z: 0, is_detected: true },
    possession: { player_id: null, group: null },
    player_data,
  };
}

function makeMatch({ id = 999, L = 105, W = 68, homeSide = 'left_to_right' } = {}) {
  return {
    id,
    home_team: { id: 1 },
    away_team: { id: 2 },
    pitch_length: L,
    pitch_width: W,
    home_team_side: Array.isArray(homeSide) ? homeSide : [homeSide, homeSide],
    players: [...roster(1, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]),
      ...roster(2, [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210])],
  };
}

const jsonl = (frames) => frames.map((f) => JSON.stringify(f)).join('\n');

// ── parseClock / parseTrackingJsonl ─────────────────────────────────────

test('parseClock 解析 HH:MM:SS.ss，非法输入返回 null', () => {
  assert.equal(parseClock('00:00:00.00'), 0);
  assert.equal(parseClock('00:45:00.00'), 2700);
  assert.equal(parseClock('01:23:12.50'), 4992.5);
  assert.equal(parseClock(null), null);
  assert.equal(parseClock('garbage'), null);
  assert.equal(parseClock('1:2'), null);
});

test('parseTrackingJsonl 跳过无球员数据的空帧（转播间隙）', () => {
  const text = [
    JSON.stringify({ frame: 0, timestamp: null, period: null, player_data: [] }),
    JSON.stringify(frameAt(10, 1, 0)),
    JSON.stringify({ frame: 11, timestamp: null, period: null, player_data: [] }),
    JSON.stringify(frameAt(12, 1, 0.1)),
  ].join('\n');
  const frames = parseTrackingJsonl(text);
  assert.equal(frames.length, 2, '只保留有 player_data 的帧');
  assert.equal(frames[0].frame, 10);
  assert.equal(frames[1].frame, 12);
});

test('parseTrackingJsonl 单行损坏不废掉整场', () => {
  const text = `{bad json\n${JSON.stringify(frameAt(1, 1, 0))}`;
  assert.equal(parseTrackingJsonl(text).length, 1);
});

// ── 时间轴拼接（D3）─────────────────────────────────────────────────────

test('stitchTimeline 把回跳的半场时钟拼成单调轴', () => {
  // P1 到 100s 结束；P2 从 45:00（=2700s）起——不处理就是 2600s 的回跳。
  // shift = max(P1) − min(P2) = 100 − 2700 = −2600：拼接后 P2 的 2700 落到 100，
  // 与 P1 末尾**重合**（中场休息被压缩为一个点），末尾 2800 → 200。
  const frames = [
    ...Array.from({ length: 5 }, (_, i) => ({ ...frameAt(i, 1, i * 25), clock: i * 25, players: [] })),
    ...Array.from({ length: 5 }, (_, i) => ({ ...frameAt(100 + i, 2, 2700 + i * 25), clock: 2700 + i * 25, players: [] })),
  ];
  const { shift, frames: out } = stitchTimeline(frames);
  assert.equal(shift, 100 - 2700, 'shift = max(P1) - min(P2)');
  // 单调递增、无负间隔
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].t >= out[i - 1].t, `第 ${i} 帧回跳了：${out[i - 1].t} → ${out[i].t}`);
  }
  assert.equal(out[0].t, 0);
  assert.equal(out[out.length - 1].t, 200, 'P2 末尾 2800 平移 −2600 → 200');
  assert.equal(out[4].t, 100, 'P1 末帧');
  assert.equal(out[5].t, 100, 'P2 首帧与 P1 末帧重合（中场压缩为一个点，无缺口）');
});

test('stitchTimeline 单半场不平移', () => {
  const frames = Array.from({ length: 3 }, (_, i) => ({ ...frameAt(i, 1, i * 10), clock: i * 10 }));
  const { shift, frames: out } = stitchTimeline(frames);
  assert.equal(shift, 0);
  assert.deepEqual(out.map((f) => f.t), [0, 10, 20]);
});

test('timelineGaps 不把正常采样间隔当缺口（阈值须高于标称间隔）', () => {
  // 5Hz：正常间隔 0.2s。20 帧连续 → 0 缺口。
  const frames = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.2, frame: i }));
  assert.equal(timelineGaps(frames, 0.2).count, 0, '0.2s 的均匀间隔不是缺口');
  // 插一个 5s 的洞 → 恰好 1 处
  const withGap = [...frames.slice(0, 10), ...frames.slice(10).map((f) => ({ ...f, t: f.t + 5 }))];
  const g = timelineGaps(withGap, 0.2);
  assert.equal(g.count, 1);
  assert.ok(Math.abs(g.maxSec - 5.2) < 1e-6);
});

// ── 门将识别（D1 的"position_group 陷阱"）──────────────────────────────

test('isGoalkeeper 用 player_role.name，不靠 position_group（后者对门将是 "Other"）', () => {
  const p = { player_role: { name: 'Goalkeeper', position_group: 'Other' } };
  assert.equal(isGoalkeeper(p), true, 'position_group 是 Other 时仍须认出是门将');
  assert.equal(isGoalkeeper({ player_role: { name: 'Center Back', position_group: 'Defender' } }), false);
  assert.equal(isGoalkeeper({}), false);
});

// ── 坐标归一（D4）───────────────────────────────────────────────────────

test('makeNormalizer 按每场尺寸归一，不硬编码 105（104/105/106 三档均须成立）', () => {
  for (const L of [104, 105, 106]) {
    const norm = makeNormalizer(L, 68, ['left_to_right', 'left_to_right']);
    // 中心原点 x=0 → 0.5；左门线 x=-L/2 → 0；右门线 x=+L/2 → 1
    assert.ok(Math.abs(norm(0, 0, 1)[0] - 0.5) < 1e-9, `L=${L} 中心应映射到 0.5`);
    assert.ok(Math.abs(norm(-L / 2, 0, 1)[0] - 0) < 1e-9, `L=${L} 左门线应映射到 0`);
    assert.ok(Math.abs(norm(L / 2, 0, 1)[0] - 1) < 1e-9, `L=${L} 右门线应映射到 1`);
    // y 翻转：中心 0.5；下边线 y=-34 → 1（y=0 是下边线，与 Metrica 转换器一致）
    assert.ok(Math.abs(norm(0, 0, 1)[1] - 0.5) < 1e-9);
    assert.ok(Math.abs(norm(0, -34, 1)[1] - 1) < 1e-9, '下边线应映射到 y=1');
    assert.ok(Math.abs(norm(0, 34, 1)[1] - 0) < 1e-9, '上边线应映射到 y=0');
  }
});

test('朝向 right_to_left 时翻 x（主队恒攻向 x=1）', () => {
  const ltr = makeNormalizer(105, 68, ['left_to_right', 'left_to_right']);
  const rtl = makeNormalizer(105, 68, ['right_to_left', 'right_to_left']);
  const x = -52.5; // 左门线
  assert.ok(Math.abs(ltr(x, 0, 1)[0] - 0) < 1e-9);
  assert.ok(Math.abs(rtl(x, 0, 1)[0] - 1) < 1e-9, 'right_to_left 时左门线应翻到 1');
  // 两个半场可以不同朝向（真实数据如此）
  const mixed = makeNormalizer(105, 68, ['right_to_left', 'left_to_right']);
  assert.ok(Math.abs(mixed(x, 0, 1)[0] - 1) < 1e-9);
  assert.ok(Math.abs(mixed(x, 0, 2)[0] - 0) < 1e-9, 'P2 按 home_team_side[1] 各自判');
});

// ── 端到端转换 ──────────────────────────────────────────────────────────

function synthMatch({ L = 105, homeSides = ['left_to_right', 'left_to_right'], n = 40, skipFrames = [] } = {}) {
  const frames = [];
  for (let i = 0; i < n; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L, homeSide: homeSides[0] });
    if (!skipFrames.includes(i)) frames.push(f);
  }
  // P2：时钟从 2700 起（回跳）
  for (let i = 0; i < n; i += 1) {
    const f = frameAt(n + i, 2, 2700 + i * 0.1, { L, homeSide: homeSides[1] });
    if (!skipFrames.includes(n + i)) frames.push(f);
  }
  return convertSkillcorner(makeMatch({ L, homeSide: homeSides }), jsonl(frames), { keyframeHz: 5 });
}

test('convertSkillcorner 端到端：单调时间轴 + 22 人槽位 + 门将在 0/21', () => {
  const out = synthMatch();
  assert.ok(out.frames.length > 0);
  for (let i = 1; i < out.frames.length; i += 1) {
    assert.ok(out.frames[i].t >= out.frames[i - 1].t, '时间轴必须单调');
  }
  // 每帧 22 个槽位都有人（数据保证每帧 22 点）
  const f = out.frames[10];
  assert.equal(f.players.filter(Boolean).length, 22);
  // 门将必须落在 id 0 / 21（指标层靠剔 0/21 剔门将）
  const idMap = out.meta.idMap;
  assert.equal(idMap.home['100'], 0, '主队门将 100 → id 0');
  assert.equal(idMap.away['200'], 21, '客队门将 200 → id 21');
  assert.equal(out.meta.orientationDetected.keeperSideCheck.ok, true);
});

test('convertSkillcorner 归一化后主队门将贴 x≈0、客队门将贴 x≈1（朝向不镜像）', () => {
  for (const homeSides of [['left_to_right', 'left_to_right'], ['right_to_left', 'left_to_right']]) {
    const out = synthMatch({ homeSides });
    const gkHome = out.frames.map((f) => f.players[0]).filter(Boolean);
    const gkAway = out.frames.map((f) => f.players[21]).filter(Boolean);
    const meanH = gkHome.reduce((a, p) => a + p[0], 0) / gkHome.length;
    const meanA = gkAway.reduce((a, p) => a + p[0], 0) / gkAway.length;
    assert.ok(meanH < 0.25, `主队门将应在 x≈0，实际 ${meanH.toFixed(3)}（homeSides=${homeSides}）`);
    assert.ok(meanA > 0.75, `客队门将应在 x≈1，实际 ${meanA.toFixed(3)}（homeSides=${homeSides}）`);
  }
});

test('convertSkillcorner 逐场球场尺寸记入 meta，不硬编码 105', () => {
  for (const L of [104, 105, 106]) {
    const out = synthMatch({ L });
    assert.equal(out.meta.pitchMeters.length, L);
    assert.equal(out.meta.pitchMeters.width, 68);
  }
});

// ── 外推标记透传（D2 的"如实暴露"）─────────────────────────────────────

test('is_detected=false 的点写入外推标记（坐标第三位），true 的不带', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' });
    // 球员 105 与 205 全部帧外推；其余真检测
    for (const p of f.player_data) if (p.player_id === 105 || p.player_id === 205) p.is_detected = false;
    frames.push(f);
  }
  const out = convertSkillcorner(makeMatch(), jsonl(frames), { keyframeHz: 5 });
  const slot105 = out.meta.idMap.home['105'];
  const slot205 = out.meta.idMap.away['205'];
  assert.notEqual(slot105, undefined);
  assert.notEqual(slot205, undefined);
  for (const f of out.frames) {
    const p = f.players[slot105];
    assert.equal(p.length, 3, '外推点应有第三位标记');
    assert.equal(p[2], EXTRAPOLATED_FLAG);
    const q = f.players[out.meta.idMap.home['101']];
    if (q) assert.equal(q.length, 2, '真检测点不应带标记');
  }
  assert.ok(out.meta.coverage.extrapolatedPointPct > 0);
});

test('is_detected 缺省/null 一律按外推处理（未知即不信任）', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' });
    for (const p of f.player_data) if (p.player_id === 103) p.is_detected = null;
    frames.push(f);
  }
  const out = convertSkillcorner(makeMatch(), jsonl(frames), { keyframeHz: 5 });
  const slot = out.meta.idMap.home['103'];
  assert.equal(out.frames[0].players[slot].length, 3, 'null 标记应视为外推');
});

// ── 缺球补全 ────────────────────────────────────────────────────────────

test('缺球时按 ballFill 语义补全（nearest 放到最近球员，带 ballFill 标记）', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' });
    if (i >= 5) f.ball_data = { x: null, y: null, z: null, is_detected: null };
    frames.push(f);
  }
  const out = convertSkillcorner(makeMatch(), jsonl(frames), { keyframeHz: 5 });
  const filled = out.frames.filter((f) => f.ballFill !== undefined);
  assert.ok(filled.length > 0, '应有补全帧');
  assert.ok(filled.every((f) => f.ball !== null), '补全帧必须有球位');
  assert.ok(out.meta.coverage.ballMissingPct > 0);
});

test('--ball-fill none 时缺球留 null', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' });
    if (i >= 5) f.ball_data = { x: null, y: null, z: null, is_detected: null };
    frames.push(f);
  }
  const out = convertSkillcorner(makeMatch(), jsonl(frames), { keyframeHz: 5, ballFill: 'none' });
  assert.ok(out.frames.slice(5).every((f) => f.ball === null));
});

test('外推的球标 ballFill="extrapolated"（使「只取原始球帧」口径能排除它）', () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const f = frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' });
    if (i < 10) f.ball_data = { x: 0, y: 0, z: 0, is_detected: false }; // 前 10 帧球是外推
    frames.push(f);
  }
  const out = convertSkillcorner(makeMatch(), jsonl(frames), { keyframeHz: 5 });
  const extrap = out.frames.filter((f) => f.ballFill === 'extrapolated');
  assert.ok(extrap.length > 0, '外推球应有 ballFill 标记');
  assert.ok(extrap.every((f) => f.ball !== null), '外推球仍有坐标（只是不可信）');
  // 关键：真检测球不得带 ballFill（否则「原始球帧」口径把真观测也排除了）
  const raw = out.frames.filter((f) => f.ballFill === undefined);
  assert.ok(raw.length > 0, '真检测球帧不应带 ballFill');
  assert.ok(out.meta.coverage.ballExtrapolatedPct > 0);
});

// ── LFS 指针（P1.2 的路径解析坑）───────────────────────────────────────

test('tracking 是 LFS 指针时 CLI 报错而非产出空帧', async () => {
  const { isLfsPointerFile } = await import('./convert-skillcorner-to-frames.mjs');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'lfs-'));
  const p = join(dir, 'x.jsonl');
  writeFileSync(p, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 89543442\n');
  assert.equal(isLfsPointerFile(p), true);
  writeFileSync(p, '{"frame":0}');
  assert.equal(isLfsPointerFile(p), false);
});

// ── 边界：时间窗裁剪 ────────────────────────────────────────────────────

test('--from/--to 裁剪只影响输出范围，不影响朝向判定', () => {
  const full = synthMatch();
  const clipped = convertSkillcorner(makeMatch(), jsonl([
    ...Array.from({ length: 40 }, (_, i) => frameAt(i, 1, i * 0.1, { L: 105, homeSide: 'left_to_right' })),
    ...Array.from({ length: 40 }, (_, i) => frameAt(40 + i, 2, 2700 + i * 0.1, { L: 105, homeSide: 'left_to_right' })),
  ]), { keyframeHz: 5, from: 0, to: 3 });
  assert.ok(clipped.frames.length < full.frames.length);
  assert.equal(clipped.meta.orientationDetected.keeperSideCheck.ok, true, '短窗裁剪后朝向自检仍须通过');
  assert.equal(clipped.meta.idMap.home['100'], 0, '槽位分配用全量帧，裁剪不改门将槽位');
});
