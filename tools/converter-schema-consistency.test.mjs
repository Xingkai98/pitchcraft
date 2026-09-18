// 两转换器产物 schema 一致性测试（tasks P1.6，守护 design D1 的「共用 schema」承诺）。
//
// ⚠️ 审阅 P3-5：初稿写「断言两者产物结构相同」——与外推标记**互斥**（标记只在一侧存在，
// 结构不可能完全相同）。故本测试断言的是**公共核 + 可选扩展**：
//   - **公共核**（`{ meta, frames: [{ t, players, ball }] }`）两个转换器都必须逐字段满足——
//     这是 P36 `fromTrackingFrame` 消费的唯一形状，破坏它 = 指标层静默读错；
//   - **可选扩展**（外推标记）断言「存在时形状正确、不存在时不报错」——
//     不要求两侧都带，但不能因为带与不带就把公共核写歪。
//
// 用**合成输入**跑真实转换逻辑（不依赖 1.8GB 真实数据）——真实数据缺失时测试仍能跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCsvPair, parseTeamCsv } from './convert-tracking-to-frames.mjs';
import { convertSkillcorner, EXTRAPOLATED_FLAG } from './convert-skillcorner-to-frames.mjs';
import { fromTrackingFrame } from '../viewer/match-metrics.js';

// ── 合成一份 Metrica 三行表头 CSV（与 convert-tracking-to-frames.test.mjs 同构）──
function metricaCsv(nids, frames, mirror) {
  const lines = [];
  lines.push(['', '', '', ...nids.flatMap(() => ['Home', ''])].join(','));
  lines.push(['', '', '', ...nids.flatMap((n) => [n, ''])].join(','));
  lines.push(['Period', 'Frame', 'Time [s]', ...nids.flatMap((n) => [`Player${n}`, '']), 'Ball', ''].join(','));
  for (const { period, frame, t } of frames) {
    const row = [period, frame, t];
    nids.forEach((nid, i) => {
      // 门将（第一个）贴本方门线，其余铺开；mirror 时整队镜像
      const depth = 0.05 + i * 0.09;
      const x = mirror ? 1 - depth : depth;
      row.push(x, 0.5);
    });
    row.push('0.5', '0.5');
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function metricaFrames(n, hz = 25) {
  return Array.from({ length: n }, (_, i) => ({ period: 1, frame: i + 1, t: (i + 1) / hz }));
}

function makeMetrica() {
  const home = [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const away = [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return convertCsvPair(
    metricaCsv(home, metricaFrames(40), false),
    metricaCsv(away, metricaFrames(40), true),
    { keyframeHz: 5 },
  );
}

// ── 合成一份 SkillCorner match.json + JSONL ──────────────────────────────
function makeSkillcorner() {
  const L = 105;
  const match = {
    id: 999,
    home_team: { id: 1 },
    away_team: { id: 2 },
    pitch_length: L,
    pitch_width: 68,
    home_team_side: ['left_to_right', 'left_to_right'],
    players: [
      ...[100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map((id, i) => ({
        id, team_id: 1, player_role: i === 0 ? { name: 'Goalkeeper', position_group: 'Other' } : { name: 'Center Back', position_group: 'Defender' },
      })),
      ...[200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210].map((id, i) => ({
        id, team_id: 2, player_role: i === 0 ? { name: 'Goalkeeper', position_group: 'Other' } : { name: 'Center Back', position_group: 'Defender' },
      })),
    ],
  };
  const mk = (frame, period, clock, ids) => ({
    frame,
    timestamp: `00:${String(Math.floor(clock / 60)).padStart(2, '0')}:${(clock % 60).toFixed(2).padStart(5, '0')}`,
    period,
    ball_data: { x: 0, y: 0, z: 0, is_detected: true },
    player_data: ids.map((id, i) => ({
      player_id: id, x: -L / 2 + (0.05 + i * 0.09) * L, y: 0,
      is_detected: i % 3 !== 0, // 故意混入外推点
    })),
  });
  const homeIds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const awayIds = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  const lines = [];
  for (let i = 0; i < 40; i += 1) lines.push(JSON.stringify(mk(i, 1, i * 0.1, [...homeIds, ...awayIds])));
  for (let i = 0; i < 40; i += 1) lines.push(JSON.stringify(mk(40 + i, 2, 2700 + i * 0.1, [...homeIds, ...awayIds])));
  return convertSkillcorner(match, lines.join('\n'), { keyframeHz: 5 });
}

// 公共核断言：两个产物都必须满足。返回检查过的字段，便于确认断言真的跑了。
function assertCommonCore(data, label) {
  assert.ok(data && typeof data === 'object', `${label}: 产物必须是对象`);
  assert.ok(data.meta && typeof data.meta === 'object', `${label}: 必须有 meta`);
  // meta 必备字段（指标层与基线依赖）
  for (const k of ['source', 'hz', 'keyframeHz', 'frames', 'startTime', 'endTime', 'coord']) {
    assert.ok(data.meta[k] !== undefined, `${label}: meta.${k} 缺失`);
  }
  assert.equal(data.meta.frames, data.frames.length, `${label}: meta.frames 与 frames.length 不符`);
  assert.ok(Array.isArray(data.frames) && data.frames.length > 0, `${label}: frames 必须是非空数组`);
  for (const f of data.frames) {
    assert.equal(typeof f.t, 'number', `${label}: frame.t 必须是数字`);
    assert.ok(Array.isArray(f.players), `${label}: frame.players 必须是数组`);
    assert.equal(f.players.length, 22, `${label}: players 必须是 22 槽位（事件协议约定）`);
    for (const p of f.players) {
      if (p == null) continue;
      assert.ok(Array.isArray(p), `${label}: 非空球员点必须是数组 [x,y]`);
      assert.ok(p.length >= 2, `${label}: 球员点至少 [x,y]`);
      assert.equal(typeof p[0], 'number', `${label}: 球员 x 必须是数字`);
      assert.equal(typeof p[1], 'number', `${label}: 球员 y 必须是数字`);
    }
    if (f.ball != null) {
      assert.ok(Array.isArray(f.ball) && f.ball.length >= 2, `${label}: ball 必须是 [x,y]`);
    }
  }
  return data.meta.frames;
}

// 可选扩展断言：外推标记——存在时形状正确、不存在时也不报错。
function assertOptionalExtension(data, label) {
  let sawFlag = 0;
  let sawPlain = 0;
  for (const f of data.frames) {
    for (const p of f.players) {
      if (p == null) continue;
      if (p.length === 3) {
        assert.equal(p[2], EXTRAPOLATED_FLAG, `${label}: 第三位出现时必须是外推标记 1`);
        sawFlag += 1;
      } else if (p.length === 2) {
        sawPlain += 1;
      } else {
        assert.fail(`${label}: 球员点长度只能是 2（真观测）或 3（外推），实际 ${p.length}`);
      }
    }
    if (f.ballFill !== undefined) {
      assert.ok([...Array(22).keys()].includes(f.ballFill) || f.ballFill === 'hold' || f.ballFill === 'extrapolated',
        `${label}: ballFill 取值域外：${f.ballFill}`);
    }
  }
  return { sawFlag, sawPlain };
}

test('公共核：两个转换器的产物都满足统一帧表示（P36 fromTrackingFrame 的输入形状）', () => {
  const met = makeMetrica();
  const sc = makeSkillcorner();
  const n1 = assertCommonCore(met, 'Metrica');
  const n2 = assertCommonCore(sc, 'SkillCorner');
  assert.ok(n1 > 0 && n2 > 0);
});

test('公共核：两产物都能被 fromTrackingFrame 无异常消费，且形状一致', () => {
  for (const [label, data] of [['Metrica', makeMetrica()], ['SkillCorner', makeSkillcorner()]]) {
    const f = fromTrackingFrame(data.frames[0]);
    assert.equal(typeof f.t, 'number', `${label}`);
    assert.equal(f.players.length, 22, `${label}: fromTrackingFrame 必须产出 22 槽位`);
    // 外推标记不能破坏 fromTrackingFrame（它只读 p[0]/p[1]）
    for (const p of f.players) {
      if (!p) continue;
      assert.equal(typeof p.id, 'number');
      assert.equal(typeof p.x, 'number');
      assert.equal(typeof p.y, 'number');
    }
  }
});

test('可选扩展：外推标记只在一侧存在——存在时形状正确、缺失时不报错', () => {
  const met = makeMetrica();
  const sc = makeSkillcorner();
  const metExt = assertOptionalExtension(met, 'Metrica');
  const scExt = assertOptionalExtension(sc, 'SkillCorner');
  // Metrica 全是真观测（无外推概念）：不应出现第三位
  assert.equal(metExt.sawFlag, 0, 'Metrica 不应带外推标记');
  assert.ok(metExt.sawPlain > 0);
  // SkillCorner 混入了外推点：必须既有标记、也有真观测（否则是静默全标或全不标）
  assert.ok(scExt.sawFlag > 0, 'SkillCorner 应当带外推标记');
  assert.ok(scExt.sawPlain > 0, 'SkillCorner 也应当有真观测点');
});

test('球员槽位语义一致：0/21 恒为门将（指标层靠剔 0/21 剔门将）', () => {
  for (const [label, data] of [['Metrica', makeMetrica()], ['SkillCorner', makeSkillcorner()]]) {
    // 每帧 0 与 21 槽都有人（合成的两队都是 11 人齐整）
    for (const f of data.frames) {
      assert.ok(f.players[0] != null, `${label}: id 0（主队门将槽）不该为空`);
      assert.ok(f.players[21] != null, `${label}: id 21（客队门将槽）不该为空`);
    }
  }
});
