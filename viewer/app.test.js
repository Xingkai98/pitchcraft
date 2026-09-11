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
