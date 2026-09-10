// app.js DOM 行为测试（P16）：把 P15 的「采集/提交清空与覆盖」锁进 CI。
//
// 这些用例驱动的是**真实 app.js**——真实按钮监听器（btn-capture / btn-submit）、真实
// submitObservation / captureCurrentObservation，不是把逻辑重写一遍。harness（见
// ./dom-test-harness.mjs）只负责搭 DOM + stub 浏览器 API；测试点的是 app.js 自己绑的
// 监听器，断言的是它自己写进 DOM / 发出去的 bundle。
//
// 回归护栏：删掉 app.js 里 `obsStatementEl.value = ''` 或改动 resolveSubmitStatement 接线，
// 下面用例即红——这正是 P15 错位 bug 会静默回归的那两行。
//
// 对应 spec：openspec/specs/match-observation —— “观察采集/提交的 DOM 行为有自动化测试覆盖”。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './dom-test-harness.mjs';
import { config } from './config.js';

let h;

beforeEach(() => {
  h = createAppHarness();
});

afterEach(() => {
  h.close();
});

// 采集（点真实「采集当前观察」按钮）。前置：描述输入框已铺好内容（由用例设置）。
async function capture() {
  await h.click('btn-capture');
}

// 提交（点真实「提交诊断」按钮）并等 async 处理函数排空。
async function submit() {
  await h.click('btn-submit');
  await h.flush();
}

// 最近一次 POST /observations 实际提交出去的 bundle。
function submittedBundle() {
  const call = h.fetch.lastCall('POST');
  assert.ok(call, '应发生一次 POST /observations（提交路径）');
  assert.match(call.url, /\/observations$/);
  assert.ok(call.body, 'POST body 应为 JSON bundle');
  return call.body;
}

test('harness 驱动真实 app.js：初始化完成并拿到 mock 事件流', async () => {
  await h.importApp();
  // init 成功 = game 已建。status 由 app.js 自己写；用 mock 事件流（engine.wasm 走 fetch 桩失败）。
  assert.match(h.$('status').textContent, /^事件数: \d+ \| mock 数据$/);
  // 采集/提交按钮就位（index.html 的真实元素，app.js 顶层已取到并绑监听器）。
  assert.ok(h.$('btn-capture'), '应有「采集当前观察」按钮');
  assert.ok(h.$('btn-submit'), '应有「提交诊断」按钮');
  assert.equal(h.statement, '', '初始描述输入框为空');
  assert.deepEqual(h.entryStatements(), [], '初始观察列表为空');
});

// --- P19 spec：比赛时长是单一可配置参数，界面不提供切换 ---
test('P19：播放控制区无时长切换入口', async () => {
  await h.importApp();
  // 旧按钮已从 index.html 删除；再被加回来时此用例即红。
  assert.equal(h.$('btn-duration'), null, '不应存在时长切换按钮 #btn-duration');
  const controls = h.$('controls');
  assert.ok(controls, '应有播放控制区 #controls');
  // 兜住「换个 id 重新塞一个时长按钮」——控制区不该出现「比赛 N 分钟」这类文本。
  const switchLike = [...controls.querySelectorAll('button')].filter((b) =>
    /比赛\s*\d+\s*分钟/.test(b.textContent)
  );
  assert.deepEqual(switchLike.map((b) => b.textContent), [], '控制区不应有「比赛 N 分钟」切换按钮');
});

test('P19：时长收敛为单一参数 matchDuration（改 config 即改时长）', () => {
  // 单一数值参数，不是选项数组——app.js 直接读它算 match_duration_seconds。
  assert.equal(typeof config.playback.matchDuration, 'number');
  assert.equal(config.playback.matchDuration, 5, '当前固定 5 分钟');
  assert.equal(config.playback.matchDurations, undefined, 'matchDurations 数组应已删除');
});

// --- spec Scenario 1：采集后清空输入框 ---
test('采集后清空：描述输入框被真实采集监听器清空', async () => {
  await h.importApp();
  // 采集前先输入：证明清空发生在采集动作里，而不是「本来就是空的」。
  h.statement = '传球太慢';
  assert.equal(h.statement, '传球太慢');

  await capture();

  assert.equal(h.statement, '', '采集后描述输入框应被清空（P15 错位修复）');
  // 采集动作确实发生了：列表新增一条，且冻结了采集时的描述。
  assert.deepEqual(h.entryStatements(), ['传球太慢'], '采集应新增一条观察并冻结描述');
  assert.match(h.$('obs-status').textContent, /^captured — /);
});

// --- spec Scenario 2：提交时覆盖描述 ---
test('提交覆盖：采集时描述为空，随后输入 → 提交的 statement 为输入值', async () => {
  await h.importApp();
  // 采集时描述为空 → bundle 冻结的 statement 为 ''（错位 bug 的初始条件）。
  assert.equal(h.statement, '');
  await capture();
  assert.deepEqual(h.entryStatements(), [''], '采集时冻结空描述');

  // 采集后才输入描述（真实用户流程「采集 → 描述 → 提交」）。
  h.statement = '应该更早出球';
  await submit();

  assert.equal(submittedBundle().statement, '应该更早出球', '提交应以输入框内容覆盖冻结值');
  assert.deepEqual(h.entryStatements(), ['应该更早出球'], '列表条目描述应同步为提交值');
});

// --- spec Scenario 3：提交后清空输入框 ---
test('提交后清空：提交完成，描述输入框被清空', async () => {
  await h.importApp();
  await capture();
  h.statement = '提交前的描述';
  assert.equal(h.statement, '提交前的描述');

  await submit();

  assert.equal(h.statement, '', '提交后描述输入框应被清空');
});

test('提交后清空：即使输入被裁剪/抹除后与冻结值等值，输入框也无条件清空', async () => {
  await h.importApp();
  await capture(); // 冻结 statement = ''
  h.statement = '   '; // 仅空白：resolveSubmitStatement 裁剪后为 ''，finalStatement 未变化

  await submit();

  // 覆盖路径不会因「值没变」而跳过清空（残留文本同样要清，否则污染下一条采集）。
  assert.equal(h.statement, '', '提交后应无条件清空输入框');
  assert.equal(submittedBundle().statement, '', '空白描述回退为冻结值');
});

// --- spec Scenario 4（design D4）：凭证抹除 ---
test('凭证抹除：含 sk-ant- 的描述在提交前被抹除', async () => {
  await h.importApp();
  await capture();
  h.statement = '用 sk-ant-api03-AbCdEf123456 复现';

  await submit();

  const sent = submittedBundle().statement;
  assert.equal(sent, '用 [REDACTED] 复现', '提交的 statement 应抹除凭证形片段');
  assert.ok(!sent.includes('sk-ant-'), '提交的 bundle 不得含凭证形文本');
  assert.deepEqual(h.entryStatements(), ['用 [REDACTED] 复现'], '列表条目同样抹除');
});

// --- spec Scenario 5（design D4）：保留 frozen ---
test('保留 frozen：采集前输入、采集后未再输入 → 提交保留采集时冻结值', async () => {
  await h.importApp();
  h.statement = '采集前写的描述';
  await capture(); // 冻结该描述并清空输入框
  assert.equal(h.statement, '', '采集后输入框已清空');
  assert.deepEqual(h.entryStatements(), ['采集前写的描述']);

  // 直接提交（未再输入）：输入框为空 → 应保留冻结值，而不是被空值覆盖。
  await submit();

  assert.equal(submittedBundle().statement, '采集前写的描述', '空输入应保留采集时冻结的描述');
  assert.deepEqual(h.entryStatements(), ['采集前写的描述'], '列表条目保持冻结描述');
});

// --- P18：刷新恢复时 statement 以服务端 bundle 为权威回填 ---
//
// 驱动路径与真实刷新完全一致：localStorage 预置条目（含 task_id）→ importApp 时 app.js
// 顶层的 restoreObservationList() 读回它们并 pollTask 拉服务端状态。harness 的 fetch 桩
// 对 engine.wasm 照旧抛错（走 mock 事件流），只对 GET /tasks/:id 返回带 statement 的响应。

const LIST_STORAGE_KEY = 'p10.observation.list.v1';

// 预置 localStorage 里的观察列表（app.js 启动时 restoreObservationList 会读它）。
function seedObservationList(entries) {
  h.window.localStorage.setItem(LIST_STORAGE_KEY, JSON.stringify(entries));
}

// 一条已提交（有 task_id）的本地条目，statement 为本地旧值。
function submittedEntry({ id = 'e1', statement = '本地旧值', status = 'diagnosed' } = {}) {
  return {
    id,
    statement,
    match_time: 100,
    event_index: 3,
    status,
    task_id: 'task-abc',
    created_at: '2026-09-10T00:00:00.000Z',
    sync_error: false,
    detail_error: null,
  };
}

// fetch 桩：GET /tasks/:id → 200 + 给定任务 JSON；其余（engine.wasm）照旧抛错。
// 返回它实际收到的 task 请求 URL 列表，供「未提交条目不轮询」断言用。
function stubTaskFetch(taskJson, { taskStatus = 'diagnosed' } = {}) {
  const seen = [];
  h.fetch.setHandler((call) => {
    if (call.url.includes('/tasks/')) {
      seen.push(call.url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ task_id: 'task-abc', status: taskStatus, errors: [], report: null, findings: [], ...taskJson }),
      });
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  return seen;
}

test('刷新回填：服务端 statement 覆盖本地旧值（终态条目不例外）', async () => {
  seedObservationList([submittedEntry({ statement: '本地旧值' })]);
  stubTaskFetch({ statement: '球员射门偏出太多了' });

  await h.importApp();
  await h.flush(20);

  assert.deepEqual(h.entryStatements(), ['球员射门偏出太多了'], '刷新后应以服务端 bundle 的描述为准');
});

test('刷新回填：服务端空描述覆盖本地脏值', async () => {
  seedObservationList([submittedEntry({ statement: '本地脏值' })]);
  stubTaskFetch({ statement: '' });

  await h.importApp();
  await h.flush(20);

  assert.deepEqual(h.entryStatements(), [''], '服务端空串是有效值，应清掉本地旧描述');
});

test('刷新回填：服务端未返回 statement 时保持本地值', async () => {
  seedObservationList([submittedEntry({ statement: '本地保留值' })]);
  stubTaskFetch({}); // 响应无 statement 字段（bundle 缺失 / 旧服务）

  await h.importApp();
  await h.flush(20);

  assert.deepEqual(h.entryStatements(), ['本地保留值'], '服务端未返回该字段时不得清空本地值');
});

test('刷新回填：未提交（无 task_id）的条目不轮询、保持本地值', async () => {
  seedObservationList([
    { ...submittedEntry({ id: 'e1' }), statement: '未提交本地值', task_id: null, status: 'captured' },
  ]);
  const seen = stubTaskFetch({ statement: '服务端值' });

  await h.importApp();
  await h.flush(20);

  assert.deepEqual(seen, [], '无 task_id 的条目不该发起任务轮询');
  assert.deepEqual(h.entryStatements(), ['未提交本地值'], '未提交条目保持本地描述');
});

// --- 跨观察隔离：提交清空后，下一条采集不继承上一条描述（P15 错位 bug 的整体回归） ---
test('跨观察隔离：第二条采集不继承第一条的描述', async () => {
  await h.importApp();
  await capture();
  h.statement = '第一条的描述';
  await submit();
  assert.equal(h.statement, '', '第一条提交后输入框清空');

  // 第二条：不输入任何描述直接采集 → 冻结值应为空，不得残留『第一条的描述』。
  await capture();

  assert.deepEqual(h.entryStatements(), ['第一条的描述', ''], '第二条采集应冻结空描述');
  await submit();
  assert.equal(submittedBundle().statement, '', '第二条提交的 statement 不应继承上一条描述');
});
