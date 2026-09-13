// viewer/event-labels.js 单测（P20）：人话标签的类型分派、detail 区分、beat 折叠、队别。
//
// 验收样例取自 design 定稿（.scratch/issues/12-observation-confirmation.md）：
//   {index:55, t:51, type:'pass', subject:7, from:7, result:'contested', detail:'out_sideline'}
//   → #55 · t=51s · 传球出边线 · 主队 #7
// 以及真实案例 1 的类型错位（用户说「射门」，窗口里只有传球出底线）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, isCandidateEvent } from './event-labels.js';

const lineupOf = (...ids) => ids.map((id) => ({ id }));

test('P20 event-labels: 验收样例 —— 出边线传球', () => {
  const e = { index: 55, t: 51, type: 'pass', subject: 7, from: 7, result: 'contested', detail: 'out_sideline' };
  assert.equal(describeEvent(e, lineupOf(7)), '#55 · t=51s · 传球出边线 · 主队 #7');
});

test('P20 event-labels: 类型显眼 —— 传球 vs 射门不可混淆（案例 1 的类型错位）', () => {
  const pass = { index: 9, t: 12, type: 'pass', subject: 9, from: 9, result: 'success', detail: 'out_goal_line' };
  const shot = { index: 9, t: 12, type: 'shot', subject: 9, x2: 0.95, result: 'goal' };
  assert.match(describeEvent(pass, lineupOf(9)), /传球出底线/);
  assert.match(describeEvent(shot, lineupOf(9)), /射门得分/);
  assert.notEqual(describeEvent(pass, lineupOf(9)), describeEvent(shot, lineupOf(9)));
});

test('P27 event-labels: result=out 有 detail 时 detail 优先；无 detail 时兜底「传球出界」', () => {
  const base = { index: 3, t: 40, type: 'pass', subject: 9, from: 9, result: 'out' };
  // 引擎仍在出界时带 detail（P27 保留）→ 渲染成「传球出边线」
  assert.equal(describeEvent({ ...base, detail: 'out_sideline' }, lineupOf(9)), '#3 · t=40s · 传球出边线 · 主队 #9');
  // detail 缺失（阶段 2/3 若去掉 detail）时的兜底标签
  assert.equal(describeEvent(base, lineupOf(9)), '#3 · t=40s · 传球出界 · 主队 #9');
});

test('P20 event-labels: detail 区分同类事件（角球/界外球/任意球都是 pass）', () => {
  const base = { index: 1, t: 27, type: 'pass', subject: 5, from: 5 };
  assert.equal(describeEvent({ ...base, detail: 'corner' }, lineupOf(5)), '#1 · t=27s · 角球 · 主队 #5');
  assert.equal(describeEvent({ ...base, detail: 'throw_in' }, lineupOf(5)), '#1 · t=27s · 界外球 · 主队 #5');
  assert.equal(describeEvent({ ...base, detail: 'free_kick' }, lineupOf(5)), '#1 · t=27s · 任意球 · 主队 #5');
  // 无 detail → 回落到 result 限定词
  assert.equal(describeEvent({ ...base, result: 'intercepted' }, lineupOf(5)), '#1 · t=27s · 传球被断 · 主队 #5');
});

test('P20 event-labels: 射门结果限定词（goal/saved/off_target）', () => {
  const s = (result) => describeEvent({ index: 3, t: 15, type: 'shot', subject: 9, result }, lineupOf(9));
  assert.equal(s('goal'), '#3 · t=15s · 射门得分 · 主队 #9');
  assert.equal(s('saved'), '#3 · t=15s · 射门被扑 · 主队 #9');
  assert.equal(s('off_target'), '#3 · t=15s · 射门偏出 · 主队 #9');
  // 头球：detail 优先于 result
  assert.equal(
    describeEvent({ index: 3, t: 15, type: 'shot', subject: 9, result: 'goal', detail: 'header' }, lineupOf(9)),
    '#3 · t=15s · 射门头球 · 主队 #9'
  );
});

test('P20 event-labels: beat 折叠 —— 有 main 显示带球，纯 beat 显示无球跑动', () => {
  const withMain = {
    index: 40,
    t: 30,
    type: 'beat',
    main: { type: 'dribble', subject: 16, x: 0.55, y: 0.5, x2: 0.45, y2: 0.55 },
    movers: [{ id: 4, from_x: 0, from_y: 0, to_x: 0.1, to_y: 0.1 }],
  };
  const pureBeat = {
    index: 41,
    t: 31,
    type: 'beat',
    movers: [{ id: 4, from_x: 0, from_y: 0, to_x: 0.1, to_y: 0.1 }],
  };
  assert.equal(describeEvent(withMain, lineupOf(16)), '#40 · t=30s · 带球 · 客队 #16');
  // 纯 beat 无 main（只有 movers/ball）→ 无球跑动，且不指向某个球员
  assert.equal(describeEvent(pureBeat, lineupOf(4)), '#41 · t=31s · 无球跑动');
});

test('P20 event-labels: 队别来自 lineup，缺失时按 id 区间回退', () => {
  const pass = { index: 2, t: 6, type: 'pass', subject: 5, from: 5, result: 'success' };
  // lineup 显式给出 away：即便 id 5 落在主队区间，也以 lineup 为准。
  assert.match(describeEvent(pass, [{ id: 5, team: 'away' }]), /客队 #5$/);
  // 无 lineup → 0-10 主队
  assert.match(describeEvent(pass, null), /主队 #5$/);
  // 11-21 客队
  assert.match(describeEvent({ ...pass, subject: 16, from: 16 }, null), /客队 #16$/);
  // team 用数字 0/1 也要收
  assert.match(describeEvent(pass, [{ id: 5, team: 0 }]), /主队 #5$/);
  assert.match(describeEvent(pass, [{ id: 5, team: 1 }]), /客队 #5$/);
});

test('P20 event-labels: whistle/lineup 不渲染占位球员（subject 0 是哨声占位）', () => {
  assert.equal(describeEvent({ index: 20, t: 44, type: 'whistle', subject: 0, detail: 'half_time' }, null), '#20 · t=44s · 哨声（半场）');
  assert.equal(describeEvent({ index: 0, t: 0, type: 'lineup' }, null), '#0 · t=0s · 首发站位');
});

test('P20 event-labels: 具体动作类型（抢断/犯规/带球/拦截/无球跑动）', () => {
  const l = lineupOf(10, 11);
  assert.match(describeEvent({ index: 1, t: 30, type: 'tackle', subject: 10, to: 16 }, l), /^#1 · t=30s · 抢断 · 主队 #10$/);
  assert.match(describeEvent({ index: 2, t: 40, type: 'foul', subject: 15, carrier: 9, detail: 'foul_trip' }, l), /犯规绊人 · 客队 #15$/);
  assert.match(describeEvent({ index: 3, t: 9, type: 'dribble', subject: 2 }, l), /带球 · 主队 #2$/);
  assert.match(describeEvent({ index: 4, t: 28, type: 'off_ball_run', subject: 4 }, l), /无球跑动 · 主队 #4$/);
  assert.match(describeEvent({ index: 5, t: 18, type: 'kickoff', subject: 12 }, l), /开球 · 客队 #12$/);
});

test('P20 event-labels: 字段时间小数取整，非有限值兜底不抛', () => {
  assert.match(describeEvent({ index: 7, t: 27.5, type: 'pass', subject: 1 }, null), /#7 · t=28s /);
  assert.doesNotThrow(() => describeEvent({ index: 8, t: undefined, type: 'pass', subject: 1 }, null));
  assert.match(describeEvent({ index: 8, t: undefined, type: 'pass', subject: 1 }, null), /t=\?s/);
  // 无效输入返回占位串，不抛
  assert.equal(describeEvent(null, null), '（无效事件）');
  assert.equal(describeEvent([], null), '（无效事件）');
  // 未知类型不渲染成空白
  assert.match(describeEvent({ index: 9, t: 1, type: 'brand_new', subject: 3 }, null), /brand_new/);
});

test('P20 event-labels: isCandidateEvent 只收高亮动作，折叠 beat/过渡事件', () => {
  for (const type of ['pass', 'shot', 'tackle', 'foul']) {
    assert.equal(isCandidateEvent({ type }), true, `${type} 应进默认候选列表`);
  }
  for (const type of ['beat', 'off_ball_run', 'dribble', 'interception', 'whistle', 'kickoff', 'lineup']) {
    assert.equal(isCandidateEvent({ type }), false, `${type} 默认折叠`);
  }
  assert.equal(isCandidateEvent(null), false);
});
