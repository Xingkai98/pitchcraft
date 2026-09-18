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
import { readFileSync } from 'node:fs';
import { createAppHarness } from './dom-test-harness.mjs';

let h;

beforeEach(() => {
  h = createAppHarness();
});

afterEach(() => {
  h.close();
  // 兜底还原：app.js 用的 config 是跨用例共享的模块实例，有用例会改它的值。用例自身在
  // finally 里已还原，这里是第二道防线——万一将来新增用例忘了还原（或还原逻辑被改坏），
  // 不至于把脏值漏给后续用例（P19 审阅 r2 指出：改坏还原逻辑时无任何用例会红）。
  if (_appConfig) _appConfig.playback.matchDuration = _appConfigOriginalMatchDuration;
});

// app.js 实际用的那个 config 模块实例。app.js 顶层 import 的是 './config.js?v=<版本>'（带
// cache-busting 查询串），与测试里裸 import './config.js' 是**两个不同模块实例**（查询串参与
// 模块身份，见 test-query-loader.mjs）——裸 import 拿到的是副本，改了 app.js 也读不到。
// 这里从 app.js 源码里抠出它真正用的说明符再 import，才能拿到同一实例、真正测到「改 config
// 即改时长」。不写死版本号：版本号每次改动都会 bump，写死必然过期（P18 审阅先例）。
let _appConfig;
let _appConfigOriginalMatchDuration;
async function appConfigInstance() {
  if (_appConfig) return _appConfig;
  const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const spec = src.match(/from '(\.\/config\.js[^']*)'/)?.[1];
  assert.ok(spec, 'app.js 顶层应 import ./config.js（带 ?v=）——测试据此取同一模块实例');
  _appConfig = (await import(spec)).config;
  _appConfigOriginalMatchDuration = _appConfig.playback.matchDuration; // 首次加载时记下原值
  return _appConfig;
}

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

  // 控制区只应有这几个按钮（白名单快照）。任何新增控件——按钮、下拉、滑块——都必须先
  // 在此登记，从而逼一次「这是不是时长切换」的自问；时长入口不可能悄悄溜回来。
  const BUTTON_IDS = ['btn-toggle', 'btn-skip', 'btn-speed', 'btn-replay'];
  const buttonIds = [...controls.querySelectorAll('button')].map((b) => b.id);
  assert.deepEqual(buttonIds, BUTTON_IDS, '控制区按钮应为白名单内的播放控制按钮');

  // 控制区不得含任何可切换数值的控件（下拉/滑块/数字输入）——时长切换无论换什么皮都逃不掉。
  const pickers = controls.querySelectorAll('select, option, input[type="range"], input[type="number"]');
  assert.deepEqual(
    [...pickers].map((el) => el.id || el.tagName),
    [],
    '控制区不应有 select/option/range/number 等可切换控件'
  );

  // 兜住「换皮文案」的入口：控制区任何文本都不该提「时长」，也不该出现「比赛 N 分钟」
  // （r1 原本只抓后者、r2 只抓前者，两者都留着才不漏——见审阅 r3 的 M7/M8 空档）。
  const mentionsDuration = [...controls.querySelectorAll('*')].filter((el) =>
    /时长|比赛\s*\d+\s*分钟/.test(el.textContent)
  );
  assert.deepEqual(
    mentionsDuration.map((el) => el.textContent),
    [],
    '控制区不应出现含「时长」或「比赛 N 分钟」的控件'
  );
});

test('P19：时长收敛为单一参数 matchDuration（单一数值，非选项数组）', async () => {
  const cfg = await appConfigInstance();
  assert.equal(cfg.playback.matchDuration, 5, '当前固定 5 分钟');
  assert.equal(cfg.playback.matchDurations, undefined, 'matchDurations 数组应已删除');
});

// --- P19 spec Scenario 1：「以配置的时长调用引擎」的端到端接线 ---
test('P19：app.js 用 config.playback.matchDuration 调引擎（非写死）', async () => {
  h.close();
  h = createAppHarness({ fakeEngine: true });
  await h.importApp();
  const cfg = await appConfigInstance();

  assert.equal(h.engineCalls.length, 1, '应恰好一次 simulate 调用');
  const { config: sentConfig, seed } = h.engineCalls[0];
  assert.equal(seed, 42, '固定种子 42');
  assert.equal(
    sentConfig.match_duration_seconds,
    cfg.playback.matchDuration * 60,
    'match_duration_seconds 应等于 config.playback.matchDuration × 60'
  );
  assert.equal(sentConfig.match_duration_seconds, 300, '当前配置 5 分钟 → 300 秒');
  assert.equal(sentConfig.demo_mode, false, '连续比赛模式');
});

// --- P19 spec Scenario 3：「改配置即改时长」 ---
// 上面那例断言的是「等于 config × 60」，但 config 当前就是 5——把 app.js 写死成 5 也照样成立。
// 要真正测到「时长是参数」，必须**真的改一次 config**：改成 90 后重新初始化，app.js 应以 5400
// 秒调引擎，且全程不改画面层代码。这一例正是「写死 5」的照妖镜（写死则恒为 300 → 红）。
test('P19：改 config 即改时长（改为 90 → 引擎收到 5400 秒）', async () => {
  const cfg = await appConfigInstance();
  const original = cfg.playback.matchDuration;
  try {
    cfg.playback.matchDuration = 90;
    h.close();
    h = createAppHarness({ fakeEngine: true });
    await h.importApp();

    assert.equal(h.engineCalls.length, 1, '应恰好一次 simulate 调用');
    assert.equal(
      h.engineCalls[0].config.match_duration_seconds,
      5400,
      '改 config 为 90 分钟后应以 5400 秒调引擎，无需改画面层逻辑'
    );
  } finally {
    cfg.playback.matchDuration = original; // config 是跨用例共享的模块实例，必须还原
  }
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

// --- P20 事件锚定确认：awaiting_confirmation 态渲染提案 + confirm 提交 ---
//
// 驱动路径与真实页面一致：localStorage 预置条目（含 task_id）→ importApp 时
// restoreObservationList 读回并 pollTask。fetch 桩对 GET /tasks/:id 返回带
// proposal/events/lineup 的响应，页面据此渲染确认面板（A+B）。
// 回归护栏：删掉 renderConfirmationInto / submitConfirmation 接线，下面用例即红。

// 一条 awaiting_confirmation 的服务端任务响应（含提案 + 窗口事件）。
function confirmationTask(over = {}) {
  return {
    task_status: 'awaiting_confirmation',
    statement: '踢出边线',
    proposal: {
      event_indexes: [55],
      candidates: [{ index: 55, why: '窗口内唯一出边线传球' }],
      drift_hints: [{ mention: '角球', hint: '窗口内无角球事件' }],
      source: 'llm',
    },
    confirmation: null,
    lineup: [{ id: 7, team: 'home' }],
    events: [
      { index: 0, type: 'lineup' },
      { index: 55, t: 51, type: 'pass', subject: 7, from: 7, result: 'contested', detail: 'out_sideline' },
      { index: 56, t: 52, type: 'beat', movers: [{ id: 4 }] },
    ],
    ...over,
  };
}

// 把 GET /tasks/:id 切到确认步响应；POST /tasks/:id/confirm 返回成功并记录 body。
function stubConfirmationFetch(taskJson, { taskStatus = 'awaiting_confirmation' } = {}) {
  const seen = { confirm: [] };
  h.fetch.setHandler((call) => {
    if (call.url.includes('/confirm')) {
      seen.confirm.push(call.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ task_id: 'task-abc', status: 'confirmed', confirmation: { event_indexes: call.body?.event_indexes ?? [], source: 'page', note: '' } }),
      });
    }
    if (call.url.includes('/tasks/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          task_id: 'task-abc', status: taskStatus, errors: [], report: null, findings: [],
          proposal: taskJson.proposal, confirmation: taskJson.confirmation,
          events: taskJson.events, lineup: taskJson.lineup, statement: taskJson.statement,
        }),
      });
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  return seen;
}

test('P20 确认 UI：awaiting_confirmation 条目渲染模型提案（人话标签 + why + 漂移提示）', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  stubConfirmationFetch(confirmationTask());

  await h.importApp();
  await h.flush(20);

  const card = h.document.querySelector('#obs-list .obs-entry');
  assert.ok(card, '应有观察条目卡片');
  const text = card.textContent;
  // A 面：模型提案的人话标签（与 CLI 共用 describeEvent）
  assert.match(text, /#55 · t=51s · 传球出边线 · 主队 #7/, '应渲染候选事件的人话标签');
  assert.match(text, /窗口内唯一出边线传球/, '应渲染候选的「为什么」');
  // 漂移提示（⚠️）
  assert.match(text, /角球/, '应渲染漂移提示');
  // 提交按钮就位
  assert.ok(card.querySelector('.obs-confirm-submit'), '应有「确认锚定」按钮');
  // 默认不展开全量列表（beat 不出现）
  assert.doesNotMatch(text, /无球跑动/, '默认不展开 beat');
});

test('P20 确认 UI：提交 confirm 发送 POST /tasks/:id/confirm，body 带勾选的 index', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  const seen = stubConfirmationFetch(confirmationTask());

  await h.importApp();
  await h.flush(20);

  await h.clickSelector('.obs-confirm-submit');
  await h.flush(20);

  assert.equal(seen.confirm.length, 1, '应发生一次 POST confirm');
  assert.deepEqual(seen.confirm[0].event_indexes, [55], '默认提交模型候选作为锚点');
  assert.equal(seen.confirm[0].source, 'page');
  // 提交后条目切到 confirmed
  assert.match(h.$('obs-list').textContent, /已确认/, '提交后应显示已确认');
});

test('P20 确认 UI：无模型提案（fallback-empty）直接展示全量事件列表供勾选', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  stubConfirmationFetch(confirmationTask({
    proposal: { event_indexes: [], candidates: [], drift_hints: [], source: 'fallback-empty' },
    confirmation: null,
  }));

  await h.importApp();
  await h.flush(20);

  const card = h.document.querySelector('#obs-list .obs-entry');
  assert.match(card.textContent, /无模型提案/, 'fallback-empty 应提示从列表勾选');
  // 点「从全部事件重选」→ 展开全量高亮事件（beat 折叠，不出现无球跑动）
  const expand = [...card.querySelectorAll('.obs-confirm-toggle')].find((b) => /从全部事件重选/.test(b.textContent));
  assert.ok(expand, '应有展开全量列表的按钮');
  expand.click();
  await h.flush(4);
  const after = h.document.querySelector('#obs-list .obs-entry');
  assert.match(after.textContent, /#55 · t=51s · 传球出边线 · 主队 #7/, '展开后应列出窗口高亮事件');
  assert.doesNotMatch(after.textContent, /无球跑动/, '默认折叠 beat');
  // 「显示全部」开关展开 beat
  const showAll = [...after.querySelectorAll('.obs-confirm-toggle')].find((b) => /显示全部/.test(b.textContent));
  assert.ok(showAll, '应有「显示全部」开关');
  showAll.click();
  await h.flush(4);
  assert.match(h.document.querySelector('#obs-list .obs-entry').textContent, /无球跑动/, '「显示全部」应展开 beat');
});

test('P20 确认 UI：展开全量后可改勾选，提交发送改后的 index 集合', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  const seen = stubConfirmationFetch(confirmationTask());

  await h.importApp();
  await h.flush(20);

  // 展开 B 面，勾上第二条高亮事件（#55 之外再加一个）
  let card = h.document.querySelector('#obs-list .obs-entry');
  [...card.querySelectorAll('.obs-confirm-toggle')].find((b) => /从全部事件重选/.test(b.textContent)).click();
  await h.flush(4);
  card = h.document.querySelector('#obs-list .obs-entry');
  const boxes = [...card.querySelectorAll('.obs-confirm-event input[type="checkbox"]')];
  // #55 应默认已勾（模型候选）
  const box55 = boxes.find((b) => b.dataset.eventIndex === '55');
  assert.ok(box55?.checked, '模型候选 #55 应默认勾选');
  // 取消勾选 → 提交空集合
  box55.click();
  await h.flush(4);
  await h.clickSelector('.obs-confirm-submit');
  await h.flush(20);
  assert.deepEqual(seen.confirm[0].event_indexes, [], '取消勾选后提交空锚点集合');
});

test('P20 确认 UI：confirmed 条目展示「已确认，等待诊断」与锚点', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'confirmed' }), task_id: 'task-abc' }]);
  stubConfirmationFetch(
    { ...confirmationTask(), confirmation: { event_indexes: [55], source: 'cli', note: '' } },
    { taskStatus: 'confirmed' }
  );

  await h.importApp();
  await h.flush(20);

  const text = h.$('obs-list').textContent;
  assert.match(text, /已确认/, 'confirmed 应显示已确认');
  assert.match(text, /#55/, '应展示已确认的锚点');
  assert.match(text, /等待诊断/, '应提示等待诊断');
});

test('P20 兼容：旧 captured 任务（无 proposal/confirmation）不渲染确认面板，行为不变', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'captured' }), task_id: 'task-old' }]);
  // 真实旧任务响应：服务端照常返回窗口 events/lineup（所有 bundle 都有 events），
  // 只是**没有** proposal/confirmation 字段。页面靠 renderEntryCard 的分支顺序（captured
  // 分支在 awaiting_confirmation 分支之前）走原「已入队」路径——不是靠
  // confirmationDetailFromTask 返回 null（那个 helper 只用于排除「无事件且无提案」）。
  h.fetch.setHandler((call) => {
    if (call.url.includes('/tasks/')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          task_id: 'task-old', status: 'captured', errors: [], report: null, findings: [],
          events: [{ index: 55, t: 51, type: 'pass', subject: 7, from: 7, result: 'contested', detail: 'out_sideline' }],
          lineup: [{ id: 7, team: 'home' }],
          // proposal / confirmation 缺省 → undefined
        }),
      });
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });

  await h.importApp();
  await h.flush(20);

  const text = h.$('obs-list').textContent;
  assert.match(text, /已入队/, '旧 captured 条目走原「已入队」路径');
  assert.equal(h.document.querySelector('.obs-confirm-submit'), null, '旧任务不应出现确认按钮');
});

// --- P20 复核 r2 修复：确认数据未就绪不提交 + 提交后锚点立即显示 ---

test('P20 确认 UI：确认数据未就绪且无错误时显示中性「加载中」，不渲染提交按钮', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  // GET /tasks/:id 永远挂起 → confirmationDetail 拿不到，且无 detail_error。这是刷新页面后
  // 首轮轮询前的正常状态，应显示中性「加载中」而非失败文案（复核 r4 NIT）。
  // 关键：绝不能放行一个会 POST 空 event_indexes、覆盖 CLI/对话面已确认锚点的按钮。
  h.fetch.setHandler((call) => {
    if (call.url.includes('/tasks/')) return new Promise(() => {}); // 永不 resolve
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });

  await h.importApp();
  await h.flush(8);

  const text = h.$('obs-list').textContent;
  assert.equal(h.document.querySelector('.obs-confirm-submit'), null, '数据未就绪时不应出现可提交的确认按钮');
  assert.match(text, /正在加载确认数据/, '无错误时应显示中性加载提示');
  assert.doesNotMatch(text, /拿不到窗口事件数据/, '无错误时不应误报失败');
});

test('P20 确认 UI：确认数据拿不到且带错误时，给原因 + CLI 回退，不渲染提交按钮', async () => {
  // 提案因 bundle 不可读失败：服务返回 awaiting_confirmation 但 events 为空、proposal 为 null
  // → confirmationDetail 永远为 null。此时（有 detail_error）应给出原因 + CLI 回退，而不是
  // 一个永远禁用的死按钮（复核 NEW-1）。
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  h.fetch.setHandler((call) => {
    if (call.url.includes('/tasks/')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          task_id: 'task-abc', status: 'awaiting_confirmation', errors: ['bundle 不可读'],
          report: null, findings: [], events: [], lineup: [], proposal: null, confirmation: null,
        }),
      });
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });

  await h.importApp();
  await h.flush(20);

  const text = h.$('obs-list').textContent;
  assert.equal(h.document.querySelector('.obs-confirm-submit'), null, '数据拿不到时不应出现可提交的确认按钮');
  assert.match(text, /拿不到窗口事件数据/, '应说明拿不到确认数据');
  assert.match(text, /runner-cli\.mjs/, '应给出 CLI 回退模板');
});

test('P20 确认 UI：提交成功后 confirmed 卡片立即显示锚点（不等下一次轮询）', async () => {
  seedObservationList([{ ...submittedEntry({ id: 'e1', status: 'awaiting_confirmation' }), task_id: 'task-abc' }]);
  stubConfirmationFetch(confirmationTask());

  await h.importApp();
  await h.flush(20);
  await h.clickSelector('.obs-confirm-submit');
  await h.flush(20);

  const text = h.$('obs-list').textContent;
  assert.match(text, /已确认/, '应显示已确认');
  assert.match(text, /#55/, 'POST 返回的锚点应立即可见（复核 N8），而非显示「未锚定具体事件」');
  assert.doesNotMatch(text, /未锚定具体事件/, '不应短暂显示未锚定');
});

// ── 真实比赛对照：数据源切换的 DOM 行为 ──────────────────────────────────────
// 驱动真实 app.js 的 #source-select / #tracking-select 监听器，断言它写进 DOM 的状态。
// 删掉 app.js 里的数据源接线，这些用例即红。

// 造一份最小的 tracking 帧序列（2 帧、22 人齐），供 fetch 桩返回。
function fakeTrackingJson(endTime = 0.2) {
  const players = (u) => Array.from({ length: 22 }, (_, id) => [0.1 + u * 0.2, id <= 10 ? 0.3 : 0.7]);
  // 两帧，时长可配（默认 0.2s；需要观察进度变化的用例传更大的值）
  return JSON.stringify({
    meta: { keyframeHz: 5, frames: 2, startTime: 0, endTime, coverage: { playerCellsFilledPct: 100, ballMissingPct: 0 } },
    frames: [
      { t: 0, players: players(0), ball: [0.5, 0.5] },
      { t: endTime, players: players(1), ball: [0.6, 0.5] },
    ],
  });
}

// 让 fetch 对 tracking 数据返回给定内容，其余请求照旧走断网桩。
function serveTracking(h) {
  const body = fakeTrackingJson();
  h.fetch.setHandler(async (call) => {
    if (/real-game-\d+\.json/.test(call.url)) {
      return { ok: true, status: 200, text: async () => body };
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
}

test('切到真实比赛：加载数据、禁用事件导航、显示数据质量信息', async () => {
  serveTracking(h);
  await h.importApp();
  // 初始在上引擎数据源，事件导航可用
  assert.equal(h.$('btn-next-event').disabled, false, '引擎数据源下事件导航应可用');
  assert.equal(h.$('tracking-select-wrap').hidden, true, '初始不显示场次选择');

  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.driveFrame(0); // 比分/进度在帧循环里更新，需驱动一帧

  assert.equal(h.$('btn-next-event').disabled, true, '真实比赛无事件流，导航应禁用');
  assert.equal(h.$('event-id-input').disabled, true);
  // 状态栏与 meta 条反映真实数据
  assert.match(h.$('tracking-meta').textContent, /5Hz/, '应显示采样率');
  assert.match(h.$('tracking-meta').textContent, /球缺失 0%/, '应如实显示球缺失率');
  assert.equal(h.$('score').textContent, '真实比赛（对照）');
});

test('切回引擎比赛：恢复事件导航与计分板', async () => {
  serveTracking(h);
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  h.$('source-select').value = 'engine';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  assert.equal(h.$('btn-next-event').disabled, false, '切回引擎后事件导航应恢复');
  assert.notEqual(h.$('score').textContent, '真实比赛（对照）', '计分板应还原');
  assert.equal(h.$('tracking-select-wrap').hidden, true);
});

test('真实比赛数据缺失：报错后回到引擎数据源，导航不被卡死', async () => {
  // 不 serve tracking → fetch 桩抛错 → loadTracking 失败
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  // 回退到引擎数据源：下拉框复位、场次选择收起、事件导航保持可用
  assert.equal(h.$('source-select').value, 'engine', '加载失败应把下拉框拨回引擎');
  assert.equal(h.$('tracking-select-wrap').hidden, true);
  assert.equal(h.$('btn-next-event').disabled, false, '失败后事件导航不能被卡在禁用态');
  assert.match(h.$('status').textContent, /错误|加载失败/, '应给出可读的错误提示');
});

test('真实比赛播放：播放按钮真的推进时间，进度条与状态栏跟随', async () => {
  const body = fakeTrackingJson(60); // 60s 时长，够看出时间前进
  h.fetch.setHandler(async (call) => {
    if (/real-game-\d+\.json/.test(call.url)) return { ok: true, status: 200, text: async () => body };
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.driveFrame(0);

  // 进度条分母是 tracking 自己的时长，而非引擎比赛的 5 分钟（formatMatchClock 是 mm:ss）
  assert.notEqual(h.$('progress-time').textContent, '00:00 / 05:00', '不应沿用引擎比赛时长');
  assert.match(h.$('progress-time').textContent, /^00:00 \/ 01:00$/);

  // 断言「播放真的推进了 tracking 的时间」，而不是只匹配按钮文案——
  // 只匹配文案的话，播放按钮没接到 tracking 上（仍作用于引擎 game）也会绿。
  const before = h.$('progress-time').textContent;
  await h.click('btn-toggle');
  // 逐帧推进若干秒（每帧 dt 上限 0.1s，与 Game.step 的钳制一致）
  let ts = 100;
  for (let i = 0; i < 60; i += 1) { ts += 100; h.driveFrame(ts); }
  assert.notEqual(h.$('progress-time').textContent, before, '播放后进度/时间必须变化');
  assert.match(h.$('progress-time').textContent, /^00:0[1-9] \/ 01:00$/, 'playTime 应已前进若干秒');
  assert.match(h.$('status').textContent, /真实比赛 00:0[1-9]/);
});

test('进度条拖动映射到 tracking 时间轴（startTime≠0 时也对）', async () => {
  // 逆映射必须与 getProgress 对称：startTime + pct × (endTime - startTime)。
  // 曾写成 pct × matchEnd——对 startTime≈0 的整场数据碰巧对，对裁剪数据会把 50% 拖成 0。
  const body = JSON.stringify({
    meta: { keyframeHz: 5, frames: 2, startTime: 300, endTime: 400, coverage: {} },
    frames: [
      { t: 300, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.5, 0.5] },
      { t: 400, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.5, 0.5] },
    ],
  });
  h.fetch.setHandler(async (call) => {
    if (/real-game-\d+\.json/.test(call.url)) return { ok: true, status: 200, text: async () => body };
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.driveFrame(0);

  // 拖到 50%：应落在时间轴中点（350s），而非被钳回 startTime
  h.$('progress-bar').value = '50';
  h.$('progress-bar').dispatchEvent(new h.window.Event('input'));
  await h.flush();
  assert.match(h.$('status').textContent, /05:50/, '50% 应映射到 350s（05:50），而不是 300s');
});

test('加载途中切回引擎：慢加载落地后四态一致，事件导航不被卡死', async () => {
  // 回归背景（X1）：切到真实比赛（18MB 加载中）→ 在完成前切回引擎。若不作废在途请求，
  // 慢加载落地后会把 activeSource 掰回 tracking（控件与画面错位）；若只作废、不让调用方
  // 知道，await 之后的 setEventNavEnabled(false) 仍会执行，用户被卡在"引擎 + 导航变灰"。
  // 这里断言「数据源 / 信息条 / 计分板 / 事件导航」四态一致。
  const body = fakeTrackingJson();
  let releaseSlow;
  const slow = new Promise((r) => { releaseSlow = r; });
  h.fetch.setHandler(async (call) => {
    if (/real-game-\d+\.json/.test(call.url)) {
      await slow; // 挂住加载，模拟慢网络
      return { ok: true, status: 200, text: async () => body };
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();

  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush(); // 加载已发起、仍挂起

  // 加载完成前切回引擎
  h.$('source-select').value = 'engine';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  // 放行慢加载：它此时已作废，不得改动任何状态
  releaseSlow();
  await h.flush();
  h.driveFrame(0);

  assert.equal(h.$('source-select').value, 'engine', '应停留在引擎数据源');
  assert.equal(h.$('tracking-meta').textContent, '', '信息条应清空（不能显示真实比赛）');
  assert.notEqual(h.$('score').textContent, '真实比赛（对照）', '计分板不能显示真实比赛');
  assert.equal(h.$('btn-next-event').disabled, false, '事件导航不能被卡在禁用态');
  // 状态栏由帧循环按当前数据源写；引擎模式下是"比赛 MM:SS"（不是"真实比赛 …"）
  assert.doesNotMatch(h.$('status').textContent, /真实比赛/, '状态栏不能显示真实比赛');
});

test('加载途中选回当前场：慢的旧请求不得覆盖', async () => {
  // 回归背景（X2，与 F1/F3/X1 同族的第三条路径）：tracking 播放 game1 时选 game2（加载中），
  // 又选回 game1 → 命中"已是这一场"的早退分支。该分支曾是唯一 return 早于 ++loadSeq 的路径，
  // 不作废在途请求 → game2 慢加载落地后把画面掰成 game2（下拉框 game1、信息条 game2）。
  const body = fakeTrackingJson();
  let releaseSlow;
  const slow = new Promise((r) => { releaseSlow = r; });
  h.fetch.setHandler(async (call) => {
    if (/real-game-1\.json/.test(call.url)) return { ok: true, status: 200, text: async () => body };
    if (/real-game-2\.json/.test(call.url)) {
      await slow; // game2 慢：挂住
      return { ok: true, status: 200, text: async () => body };
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  // 先加载 game1 并停在 tracking 模式
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  assert.match(h.$('tracking-meta').textContent, /Sample Game 1/);

  // 选 game2（慢，挂起），再选回 game1（命中早退）
  h.$('tracking-select').value = 'metrica-game2';
  h.$('tracking-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.$('tracking-select').value = 'metrica-game1';
  h.$('tracking-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  // 放行 game2 的慢请求：它已被作废，不得覆盖
  releaseSlow();
  await h.flush();
  assert.match(h.$('tracking-meta').textContent, /Sample Game 1/,
    '信息条必须仍是 game1（慢的旧请求不得覆盖）');
  assert.equal(h.$('tracking-select').value, 'metrica-game1', '下拉框应仍是 game1');
});

// ── 数据源状态机的穷举交错（同一族竞态已出过 4 个变体：F1/F3/X1/X2）─────────
// 与其逐个追，不如把所有「慢加载在途时能做什么」的组合都跑一遍，断言四态自洽。
// 不变式（tracking 模式）：meta 非空、导航禁用、下拉框指向的场次与信息条一致；
// （engine 模式）：meta 空、计分板非"真实比赛"、导航可用。

// 场景执行器：可配"哪一场慢/哪一场失败/是否预加载 g1"，跑完断言四态自洽。
async function raceScenario({ slowGame = null, failGame = null, act }) {
  const body = fakeTrackingJson(60);
  let releaseSlow = () => {};
  const slow = new Promise((r) => { releaseSlow = r; });
  h.fetch.setHandler(async (call) => {
    const m = /real-game-(\d)\.json/.exec(call.url);
    if (!m) throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
    if (m[1] === failGame) throw new Error('模拟加载失败');
    if (m[1] === slowGame) await slow;
    return { ok: true, status: 200, text: async () => body };
  });
  await h.importApp();
  await act({ releaseSlow, flush: h.flush });
  h.driveFrame(0);
  const s = {
    src: h.$('source-select').value,
    meta: h.$('tracking-meta').textContent,
    score: h.$('score').textContent,
    navDis: h.$('btn-next-event').disabled,
    sel: h.$('tracking-select').value,
  };
  const errs = [];
  if (s.src === 'engine') {
    if (s.meta !== '') errs.push('engine 模式 meta 应空');
    if (s.score === '真实比赛（对照）') errs.push('engine 模式计分板不应是真实比赛');
    if (s.navDis) errs.push('engine 模式导航应可用');
  } else {
    if (s.meta === '') errs.push('tracking 模式 meta 不应空');
    if (!s.navDis) errs.push('tracking 模式导航应禁用');
    // 下拉框指向的场次必须与信息条一致（此前注释声称检查、代码却没写，
    // 正是这个盲区让"首次加载在途改选"那类场景逃逸）
    const want = s.sel === 'metrica-game1' ? 'Sample Game 1' : 'Sample Game 2';
    if (!s.meta.includes(want)) errs.push(`下拉框=${s.sel} 与信息条不一致：${s.meta}`);
  }
  return { s, errs };
}

const setSel = (id, v) => {
  h.$(id).value = v;
  h.$(id).dispatchEvent(new h.window.Event('change'));
};

test('竞态交错矩阵：慢加载在途的每个后续动作组合，四态都自洽', async () => {
  // 每个场景用独立 harness 跑一遍，覆盖两类起点：
  //   A 类「g1 已加载完」——在 tracking 模式播放 g1 时选 g2（慢）再做后续动作；
  //   B 类「首次加载在途」——刚切到 tracking（g1 慢），尚未提交时改选 g2。
  // 后者是矩阵此前的盲区（所有场景都从 A 类起步）。
  const scenarios = [
    // ── B 类：首次加载在途 ─────────────────────────────────────────────
    ['首次 g1 在途 → 改选 g2（快，提交）', { slowGame: '1' }, async (releaseSlow, flush) => {
      setSel('source-select', 'tracking'); await flush(); // g1 发起、挂起
      setSel('tracking-select', 'metrica-game2'); await flush(); // g2 立即提交
      releaseSlow(); await flush(); // 迟到的 g1 已作废，不得覆盖
    }],
    ['首次 g1 在途 → 改选 g2（失败）→ 放行 g1', { slowGame: '1', failGame: '2' }, async (releaseSlow, flush) => {
      setSel('source-select', 'tracking'); await flush();
      setSel('tracking-select', 'metrica-game2'); await flush(); // g2 失败
      releaseSlow(); await flush(); // g1 已被 g2 作废，也不得落地
    }],
    // ── A 类：g1 已加载完 ──────────────────────────────────────────────
    ['g1 在播，g2 在途 → 切回引擎', { slowGame: '2', preload: 'g1' }, async (releaseSlow, flush) => {
      setSel('tracking-select', 'metrica-game2'); await flush();
      setSel('source-select', 'engine'); await flush();
      releaseSlow(); await flush();
    }],
    ['g1 在播，g2 在途 → 选回当前场 g1', { slowGame: '2', preload: 'g1' }, async (releaseSlow, flush) => {
      setSel('tracking-select', 'metrica-game2'); await flush();
      setSel('tracking-select', 'metrica-game1'); await flush();
      releaseSlow(); await flush();
    }],
    ['g1 在播，g2 在途 → 切引擎 → 放行 → 再切 tracking', { slowGame: '2', preload: 'g1' }, async (releaseSlow, flush) => {
      setSel('tracking-select', 'metrica-game2'); await flush();
      setSel('source-select', 'engine'); await flush();
      releaseSlow(); await flush();
      setSel('source-select', 'tracking'); await flush();
    }],
    ['g1 在播，g2 在途 → 切引擎 → 放行 → 再选 g2', { slowGame: '2', preload: 'g1' }, async (releaseSlow, flush) => {
      setSel('tracking-select', 'metrica-game2'); await flush();
      setSel('source-select', 'engine'); await flush();
      releaseSlow(); await flush();
      setSel('source-select', 'tracking'); await flush();
      setSel('tracking-select', 'metrica-game2'); await flush();
    }],
    ['g1 在播，g2 在途 → 直接改选 g1 再改选 g2', { slowGame: '2', preload: 'g1' }, async (releaseSlow, flush) => {
      setSel('tracking-select', 'metrica-game2'); await flush();
      setSel('tracking-select', 'metrica-game1'); await flush();
      setSel('tracking-select', 'metrica-game2'); await flush();
      releaseSlow(); await flush();
    }],
  ];
  const failures = [];
  for (const [name, opts, act] of scenarios) {
    h.close();
    h = createAppHarness();
    const { s, errs } = await raceScenario({
      ...opts,
      act: async ({ releaseSlow, flush }) => {
        // A 类起点：先把 g1 加载好并停在 tracking
        if (opts.preload) { setSel('source-select', 'tracking'); await flush(); }
        await act(releaseSlow, flush);
      },
    });
    if (errs.length) failures.push(`${name}\n    状态=${JSON.stringify(s)}\n    ${errs.join('; ')}`);
  }
  assert.deepEqual(failures, [], `交错场景应全部自洽，实际：\n${failures.join('\n')}`);
});

test('真实比赛模式下事件导航处理器不生效（即使按钮被解除禁用）', async () => {
  // 用例不能只断言按钮 disabled——那只证明属性被设了，没证明处理器本身有守卫。
  // 这里绕开 disabled 直接派发点击，断言 notice 里没有"已跳转"。
  // （status 每帧被 tracking 覆写、指示器也有自己的守卫，两者都不是有效观测点。）
  serveTracking(h);
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.driveFrame(0);

  h.$('btn-next-event').disabled = false;
  h.$('btn-next-event').click();
  await h.flush();
  assert.doesNotMatch(h.$('notice').textContent, /已跳转/, 'tracking 模式下不应执行事件跳转');

  h.$('notice').textContent = '';
  h.document.dispatchEvent(new h.window.Event('keydown', { key: 'ArrowRight', bubbles: true }));
  await h.flush();
  assert.doesNotMatch(h.$('notice').textContent, /已跳转/, 'tracking 模式下方向键不应执行事件跳转');
});

test('真实比赛模式下采集被拒绝（不采到隐藏的引擎状态）', async () => {
  // 回归背景（审阅 P2-G）：采集读的是隐藏的引擎 game（冻结在切换时刻），
  // 在 tracking 模式下点采集会采到"引擎的那一刻"而不是用户正看的真实比赛。
  serveTracking(h);
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();

  h.statement = '在真实比赛模式下采集';
  await h.click('btn-capture');
  assert.match(h.$('obs-status').textContent, /failed/, 'tracking 模式下采集应被拒绝');
  assert.match(h.$('obs-status').textContent, /真实比赛模式/, '应说明原因与出路');
  assert.deepEqual(h.entryStatements(), [], '不应产生任何观察条目');
});

// ── 审阅发现的三处状态机缺陷（回归护栏） ──────────────────────────────────

// F1：加载失败时下拉框必须拨回**真正加载成功的那场**。
// 曾用 `trackingSelect.value` 当"旧值"回滚——change 触发时浏览器已把它改成新值，
// 回滚是空操作，结果下拉框停在没加载进来的场次上（画面/信息条/下拉框三处不一致）。
test('加载失败：下拉框拨回上次成功加载的场次（不是停在失败的那场）', async () => {
  const body = fakeTrackingJson();
  h.fetch.setHandler(async (call) => {
    // game1 成功；game2 失败
    if (/real-game-1\.json/.test(call.url)) return { ok: true, status: 200, text: async () => body };
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  // 切到会失败的 game2
  h.$('tracking-select').value = 'metrica-game2';
  h.$('tracking-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  assert.equal(h.$('tracking-select').value, 'metrica-game1',
    '失败后下拉框应显示仍在使用的那场，而不是失败的 game2');
});

// F2：坏数据不能进缓存，否则之后每次切到该场都从缓存抛出、只能刷新页面。
// 关键：要**重选同一场**（game1），才能区分"缓存里有坏数据"和"重新 fetch"。
test('加载失败：坏数据不进缓存，重选同一场会重新尝试', async () => {
  let attempts = 0;
  h.fetch.setHandler(async (call) => {
    if (/real-game-1\.json/.test(call.url)) {
      attempts += 1;
      // 第一次返回坏 JSON，之后返回好的
      return { ok: true, status: 200, text: async () => (attempts === 1 ? '{坏 JSON' : fakeTrackingJson()) };
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  assert.equal(attempts, 1, '首次应发起请求并失败');

  // 切走再切回**同一场**：若坏数据被缓存，这里不会重新 fetch
  h.$('source-select').value = 'engine';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  assert.equal(attempts, 2, '坏数据不应被缓存——重选同一场应重新尝试加载');
  // 第二次拿到好数据，应加载成功
  assert.equal(h.$('btn-next-event').disabled, true, '重试成功后应进入真实比赛模式');
});

// F3：慢请求竞态——先发出的请求后到达，不能覆盖用户后来选的场次。
test('竞态：慢的旧请求不覆盖新选中的场次', async () => {
  const body = fakeTrackingJson();
  let releaseSlow;
  const slow = new Promise((r) => { releaseSlow = r; });
  h.fetch.setHandler(async (call) => {
    if (/real-game-1\.json/.test(call.url)) {
      await slow; // game1 慢：挂住，等我们放行
      return { ok: true, status: 200, text: async () => body };
    }
    if (/real-game-2\.json/.test(call.url)) {
      return { ok: true, status: 200, text: async () => body };
    }
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  });
  await h.importApp();
  // 发起 game1（慢），不等它完成
  h.$('source-select').value = 'tracking';
  h.$('source-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  // 立刻切到 game2（快）
  h.$('tracking-select').value = 'metrica-game2';
  h.$('tracking-select').dispatchEvent(new h.window.Event('change'));
  await h.flush();
  // 放行慢请求：它此时已经过期，不得覆盖 game2
  releaseSlow();
  await h.flush();
  assert.equal(h.$('tracking-select').value, 'metrica-game2', '下拉框应仍是 game2');
  assert.match(h.$('tracking-meta').textContent, /Sample Game 2/,
    '信息条必须是 game2（过期响应不得覆盖）');
});
