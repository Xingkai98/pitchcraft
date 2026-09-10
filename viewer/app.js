// app.js：入口。加载 WASM 引擎 → 产事件流 → 创建 Game → 渲染循环 + 播放控制
// 任务 5.1：fetch engine.wasm 并实例化，调用 simulate(seed, config)。
// 注意：需通过本地 HTTP server 打开（file:// 下 fetch .wasm 会失败）。

// 版本号：改 JS 后统一更新（index.html 的 ?v= 也同步改）
// 顶层 import 带版本号，强制浏览器刷新入口模块；传递依赖（game.js/renderer.js 内部 import）
// 未带版本号（Node 测试不支持查询串），改动它们时靠 HTTP 重新校验/硬刷新兜底
import { config } from './config.js?v=20260910-3';
import { createRenderer, drawPitch, renderFrame } from './renderer.js?v=20260910-3';
import { createGame } from './game.js?v=20260910-3';
import { mockEventStream } from './mock-event-stream.js?v=20260910-3';
import { resetMicroMotion } from './micro-motion.js?v=20260910-3';
import { captureObservation, buildCliCommandTemplate, resolveObservationSelection, redactBundleForExport, resolveSubmitStatement, deriveDiagnosisEndpoint } from './observation.js?v=20260910-3';
import {
  parseAuditImport,
  formatFinding,
  findingMarkers,
  formatReportSummary,
  redactText,
  taskResultToRender,
  formatTriage,
  buildChangeDraft,
  openQuestionsFromReport,
  confirmQuestionsFromReport,
} from './audit-report.js?v=20260910-3';
import {
  OBSERVATION_STATUSES,
  isTerminalStatus,
  isKnownStatus,
  createListEntry,
  addListEntry,
  updateListEntry,
  formatMatchTime,
  summarizeStatement,
  applyServerStatement,
  loadList,
  saveList,
} from './observation-list.js?v=20260910-3';
import {
  normalizeProblem,
  normalizeProblems,
  filterProblems,
  triageBadgeClass,
  problemSourceLabel,
  formatProblemTime,
  summarizeProblemTitle,
  problemDetailToRender,
  validateProblemAction,
  buildProblemPatch,
  createProblemApi,
  summarizeImportResult,
  pollRerunTask,
  formatDecisionText,
  fixRefToRender,
} from './problem-view.js?v=20260910-3';

const canvas = document.getElementById('pitch');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const scoreEl = document.getElementById('score');
const btnToggle = document.getElementById('btn-toggle');
const btnSkip = document.getElementById('btn-skip');
const btnSpeed = document.getElementById('btn-speed');
const btnReplay = document.getElementById('btn-replay');
const btnPrevEvent = document.getElementById('btn-prev-event');
const btnNextEvent = document.getElementById('btn-next-event');
const btnJumpEvent = document.getElementById('btn-jump-event');
const eventIndicator = document.getElementById('event-indicator');
const eventInfoEl = document.getElementById('event-info');
const eventIdInput = document.getElementById('event-id-input');
const noticeEl = document.getElementById('notice');
const progressBar = document.getElementById('progress-bar');
const progressTime = document.getElementById('progress-time');

// 观察采集（P10 viewer 切片）
const btnCapture = document.getElementById('btn-capture');
const btnExportBundle = document.getElementById('btn-export-bundle');
const btnSubmit = document.getElementById('btn-submit');
const btnImport = document.getElementById('btn-import');
const obsStatusEl = document.getElementById('obs-status');
const obsStatementEl = document.getElementById('obs-statement');
const obsBeforeEl = document.getElementById('obs-before');
const obsAfterEl = document.getElementById('obs-after');
const obsEntitiesEl = document.getElementById('obs-entities');
const obsListEl = document.getElementById('obs-list');
const obsImportEl = document.getElementById('obs-import');
const obsFindingsEl = document.getElementById('obs-findings');
const obsReportEl = document.getElementById('obs-report');
const obsNextEl = document.getElementById('obs-next');

// P10：诊断任务状态（对应 match-observation spec）。browser 只显示状态/错误摘要，绝不显示凭证。
const OBSERVATION_STATUS_STATES = OBSERVATION_STATUSES;
// 本地诊断服务端点：由页面来源 hostname 推导（localhost/127.0.0.1 → 本机
// loopback；tailscale 等网内 hostname → 同一 hostname 的 8787 端口，自动指向
// 服务所在机器，无需手工配置）。提交 → POST /observations → 轮询 GET /tasks/:id；
// 未配置或不可达时回退为「导出 bundle + CLI 模板」。browser 永不接触 API key。
const OBSERVATION_ENDPOINT = deriveDiagnosisEndpoint(location.hostname);
const OBSERVATION_POLL_MS = 2000;
const OBSERVATION_POLL_MAX_MS = 15 * 60 * 1000;
// 观察 bundle 的 source_revision：本切片无法读 git，用与 cache-busting 同步的 viewer
// 资源版本串。这是「源码/资源资产版本」，不是 git commit hash；与 index.html 的 ?v= 一致。
const VIEWER_SOURCE_REVISION = 'viewer-js:20260910-3';
let lastBundle = null;
// 观察列表状态（每次采集/提交一条）；localStorage 持久化元数据 + task_id。
const obsStorage = typeof localStorage !== 'undefined' ? localStorage : null;
let observationList = [];
let currentEntryId = null;

// 瞬时操作反馈（跳转/播放状态/错误）——显示在 notice，避免被帧循环的 status 时钟覆盖
let _noticeTimer = null;
function showNotice(msg) {
  noticeEl.textContent = msg;
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => { noticeEl.textContent = ''; }, 2500);
}

// 比赛时钟格式化（P7）：playTime 秒 → MM:SS（比赛时间，0-90:00）
function formatMatchClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 固定种子（Q8：固定种子 + 刷新重播）
const FIXED_SEED = 42;
// config：连续比赛（demo_mode: false）产整场事件流；比赛时长读 config.playback.matchDuration（P19：单一参数，无 UI 切换）
const MATCH_CONFIG = { demo_mode: false };

let game = null;
let renderer = null;
let lastFrameTime = null;

// 加载 WASM 引擎（S2：fetch + instantiate）。返回 simulate 函数。
async function loadEngine() {
  // cache-busting：加时间戳查询参数，避免浏览器缓存旧 wasm（改引擎后看不到新效果）
  const response = await fetch(`./engine.wasm?v=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`failed to fetch engine.wasm: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  // WASM 接口契约（对齐 engine/src/wasm.rs）：
  //   simulate(seed: BigInt, cfgPtr, cfgLen) → 产事件流到导出缓冲区
  //   get_json_ptr() / get_json_length() / free_json()
  // config 直接写入 wasm 线性内存低地址区（避开 [1MB 起的数据段/栈]），
  // 传真实非零指针给 simulate。SCRATCH 必须是低地址（数据段在 1MB 起）。
  const SCRATCH_OFFSET = 1024; // 低地址安全区（wasm 静态数据段从 1MB 开始）
  return {
    simulate(seed, configObj) {
      const cfgBytes = encoder.encode(JSON.stringify(configObj));
      new Uint8Array(wasm.memory.buffer, SCRATCH_OFFSET, cfgBytes.length).set(cfgBytes);
      wasm.simulate(BigInt(seed), SCRATCH_OFFSET, cfgBytes.length);
      const outPtr = wasm.get_json_ptr();
      const outLen = wasm.get_json_length();
      const outBuf = new Uint8Array(wasm.memory.buffer, outPtr, outLen);
      const str = decoder.decode(outBuf);
      wasm.free_json();
      return str;
    },
  };
}

// 播放一帧
function frame(ts) {
  if (lastFrameTime === null) lastFrameTime = ts;
  const dt = (ts - lastFrameTime) / 1000;
  lastFrameTime = ts;

  if (game) {
    game.step(dt);
    // 渲染当前状态（renderFrame 返回 imageData 供测试；这里仅用于绘制）
    // micro-motion（P5 S3）：传 playTime + 移动球员集合 + 持球者，静止球员小幅重心调整
    const movingIds = new Set();
    for (const p of game.players) {
      if (game.isPlayerMoving(p.id)) movingIds.add(p.id);
    }
    // main 持球者不微动（避免人球分离）：即使静止（零位移控球）也抑制
    const carrier = game.currentCarrier();
    if (carrier !== null) movingIds.add(carrier);
    // 高亮参与者不微动（spec：即使静止也抑制——传球者摆腿/门将待命）
    for (const pid of game.currentHighlightParticipants()) movingIds.add(pid);
    renderFrame(ctx, { players: game.players, ball: game.ball }, canvas.width, canvas.height, {
      playTime: game.playTime,
      movingIds,
      dt,
      cards: game.activeCards(),
    });
    // 比分显示（简单：从事件流里找最近一次 goal）
    updateScore();
    // 拖动进度条时 status 由 input handler 显示"已暂停"，不被帧循环覆盖
    if (!_seeking) {
      const skipping = game.isSkipping();
      if (skipping) {
        const detail = game.skipMode === 'fast' ? `${game.getSkipChoice()}x 快进` : '跳到下段';
        statusEl.textContent = `比赛 ${formatMatchClock(game.playTime)} · 跳过中(${detail})`;
      } else {
        statusEl.textContent = `比赛 ${formatMatchClock(game.playTime)} · ${game.getPlaybackRate().toFixed(0)}x`;
      }
    }
    updateEventIndicator();
    updateProgress();
  }
  requestAnimationFrame(frame);
}

// 更新进度条（整场进度）与时间显示。拖动时由 _seeking 抑制回写，避免拖动被打断。
function updateProgress() {
  if (!game) return;
  if (_seeking) return;
  const pct = game.getProgress() * 100;
  progressBar.value = String(pct);
  progressTime.textContent = `${formatMatchClock(game.playTime)} / ${formatMatchClock(game.matchEnd)}`;
}

let _seeking = false;
progressBar.addEventListener('input', () => {
  if (!game) return;
  _seeking = true;
  const t = (progressBar.value / 100) * game.matchEnd;
  game.seekTo(t);
  resetMicroMotion(); // seek 后 micro-motion 相位不连续，从 fade 0 重新渐入（避免 snap）
  renderFrame(ctx, { players: game.players, ball: game.ball }, canvas.width, canvas.height);
  statusEl.textContent = `比赛 ${formatMatchClock(game.playTime)}（已暂停，拖动进度条）`;
  updateEventIndicator();
});
progressBar.addEventListener('change', () => {
  _seeking = false;
});

// 事件摘要：id + 距离（米）等，方便用户描述"哪个 id 球慢"
function describeEvent(e, id) {
  const P = config.pitch;
  const parts = [`#${id} ${e.type}`];
  if (e.speed !== undefined) parts.push(`speed=${e.speed.toFixed(1)}m/s`);
  if (e.x2 !== undefined && e.y2 !== undefined) {
    const d = Math.hypot((e.x2 - e.x) * P.lengthMeters, ((e.y2 ?? e.y) - e.y) * P.widthMeters);
    parts.push(`dist=${d.toFixed(1)}m`);
  }
  if (e.result !== undefined) parts.push(`result=${e.result}`);
  if (e.from !== undefined) parts.push(`from=${e.from}`);
  if (e.to !== undefined) parts.push(`to=${e.to}`);
  // foul：犯规类型 + 被犯规者 + 牌
  if (e.type === 'foul') {
    if (e.detail) parts.push(`foul=${e.detail}`);
    if (e.carrier !== undefined) parts.push(`victim=${e.carrier}`);
    if (e.card) parts.push(`card=${e.card}`);
  }
  return parts.join('  ');
}

function updateEventIndicator() {
  if (!game) return;
  const idx = game.currentEventIndex();
  eventIndicator.textContent = `事件 ${idx + 1}/${game.eventCount}`;
  if (idx >= 0 && idx < game.events.length) {
    const e = game.events[idx];
    eventInfoEl.textContent = describeEvent(e, idx);
  } else {
    eventInfoEl.textContent = '';
  }
}

// 跳转到事件并刷新显示
function jumpToEventFromUI(index) {
  if (!game) return;
  if (game.jumpToEvent(index)) {
    resetMicroMotion(); // 跳转后 micro-motion 相位不连续，从 fade 0 重新渐入
    updateEventIndicator();
    showNotice(`已跳转到事件 #${index}（暂停，点播放）`);
  } else {
    showNotice(`事件 #${index} 无效（0-${game.eventCount - 1}）`);
  }
}

function updateScore() {
  let home = 0;
  let away = 0;
  // 只统计已播放时刻（e.t <= playTime）的进球，避免开赛就显示最终比分
  const t = game.playTime;
  for (const e of game.events) {
    if (e.type === 'shot' && e.result === 'goal' && e.t <= t) {
      const scorerTeam = (typeof e.subject === 'number' && e.subject <= 10) ? 'home' : 'away';
      if (scorerTeam === 'home') home++;
      else away++;
    }
  }
  scoreEl.textContent = `${home} - ${away}`;
}

// 尝试加载 WASM 引擎；不可用时退回 mock 事件流（开发期）
let engine = null;
async function tryLoadEngine() {
  try {
    engine = await loadEngine();
    return true;
  } catch (err) {
    console.warn('engine.wasm 未就绪，使用 mock 事件流（开发模式）：', err.message);
    return false;
  }
}

// 初始化：加载引擎（或 mock）→ 建 Game（当前时长）
async function init() {
  statusEl.textContent = '加载引擎…';
  try {
    let streamStr = null;
    if (engine) {
      statusEl.textContent = '模拟中…';
      const durMin = config.playback.matchDuration;
      streamStr = engine.simulate(FIXED_SEED, { ...MATCH_CONFIG, match_duration_seconds: durMin * 60 });
      statusEl.textContent = '解析事件流…';
    } else {
      statusEl.textContent = '使用 mock 事件流…';
      streamStr = JSON.stringify(mockEventStream());
    }
    game = createGame(streamStr);
    renderer = createRenderer();
    lastFrameTime = null;
    statusEl.textContent = `事件数: ${game.events.length} | ${engine ? 'WASM 引擎' : 'mock 数据'}`;
    // 重置跳过/速度按钮与跳转输入（新 game 回到快速跳过、1x、事件 0）
    btnSkip.textContent = game.skipMode === 'fast' ? `跳过 快进${game.getSkipChoice()}x`
      : game.skipMode === 'skip' ? '跳过 直接跳' : '跳过 关';
    btnSkip.title = '跳过非精彩段：快进（连续画面）/ 直接跳（切到下一高亮）/ 关（全部播放）';
    btnSpeed.textContent = `倍速 ${game.getSpeed()}x`;
    btnSpeed.title = '精彩段播放倍速：1x/2x/4x';
    eventIdInput.value = '0';
  } catch (err) {
    statusEl.textContent = `错误: ${err.message}`;
    console.error(err);
  }
}

// 控制按钮
btnToggle.addEventListener('click', () => {
  if (game) {
    game.togglePlay();
    showNotice(game.playing ? '播放中' : '已暂停');
  }
});
btnSkip.addEventListener('click', () => {
  if (game) {
    // 循环：快进5x → 快进10x → 直接跳 → 关闭
    if (game.skipMode === 'fast') {
      const c = game.cycleSkipChoice();
      btnSkip.textContent = `跳过 快进${c}x`;
      showNotice(`跳过：非精彩段 ${c}x 快进（连续画面）`);
    } else if (game.skipMode === 'skip') {
      game.skipMode = 'off';
      btnSkip.textContent = '跳过 关';
      showNotice('跳过：关闭，正常播放全部比赛');
    } else {
      game.skipMode = 'fast';
      btnSkip.textContent = `跳过 快进${game.getSkipChoice()}x`;
      showNotice(`跳过：非精彩段 ${game.getSkipChoice()}x 快进`);
    }
  }
});
btnSpeed.addEventListener('click', () => {
  if (game) {
    const s = game.cycleSpeed();
    btnSpeed.textContent = `倍速 ${s}x`;
  }
});
btnReplay.addEventListener('click', () => {
  if (game) {
    game.replayCurrent();
    resetMicroMotion(); // 重播 playTime 跳回 0，micro-motion 相位不连续，从 fade 0 重新渐入
    updateEventIndicator();
    showNotice(game.mode === 'continuous' ? '已整场重播' : `重播事件 #${game.currentEventIndex()}`);
  }
});

// 事件导航：上一个/下一个/按 id 跳转
btnPrevEvent.addEventListener('click', () => {
  if (game) {
    const cur = game.currentEventIndex();
    jumpToEventFromUI(cur - 1);
  }
});
btnNextEvent.addEventListener('click', () => {
  if (game) {
    const cur = game.currentEventIndex();
    jumpToEventFromUI(cur + 1);
  }
});
btnJumpEvent.addEventListener('click', () => {
  const id = parseInt(eventIdInput.value, 10);
  if (!Number.isNaN(id)) jumpToEventFromUI(id);
});

// 键盘：← → 切换动作，空格 播放/暂停
document.addEventListener('keydown', (e) => {
  if (!game) return;
  if (e.key === 'ArrowLeft') {
    jumpToEventFromUI(game.currentEventIndex() - 1);
  } else if (e.key === 'ArrowRight') {
    jumpToEventFromUI(game.currentEventIndex() + 1);
  } else if (e.key === ' ') {
    e.preventDefault();
    game.togglePlay();
    showNotice(game.playing ? '播放中' : '已暂停');
  }
});

// --- P10 观察采集 / 诊断展示 ---

function setObsStatus(state, detail = '') {
  const s = OBSERVATION_STATUS_STATES.includes(state) ? state : 'failed';
  obsStatusEl.textContent = detail ? `${s} — ${detail}` : s;
}

// 从当前 UI 输入构建窗口/选中实体/陈述
function readObservationInputs() {
  const before = Number(obsBeforeEl.value) || 0;
  const after = Number(obsAfterEl.value) || 0;
  const rawEntities = (obsEntitiesEl.value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const selectedEntities = rawEntities
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 21);
  return {
    statement: obsStatementEl.value.trim(),
    selectedEntities,
    window: { before, after },
  };
}

// 选中实体为空时回退到当前事件参与者（highlight/current event ids），
// 让观察更好地锚定到正在发生的动作（纯逻辑在 observation.js，可测）。
function resolveEntitiesForCapture(selectedEntities) {
  return resolveObservationSelection(selectedEntities, game);
}

// --- 观察列表（每次采集/提交一条；localStorage 持久化元数据 + task_id）---

// 更新内存列表 + 持久化 + 重渲染。findingsDetail（轮询派生的渲染状态）只留内存。
function updateEntry(entryId, patch) {
  observationList = updateListEntry(observationList, entryId, patch);
  saveList(obsStorage, observationList);
  renderObservationList();
}

function markEntrySyncError(entryId, message) {
  updateEntry(entryId, { sync_error: true, detail_error: redactText(message) });
}

function renderObservationList() {
  obsListEl.innerHTML = '';
  if (!observationList.length) {
    obsListEl.textContent = '(暂无观察 — 点击「采集当前观察」后条目显示在这里)';
    return;
  }
  for (const entry of observationList) {
    obsListEl.appendChild(renderEntryCard(entry));
  }
}

function buildCliTemplateNode(entry) {
  const cli = document.createElement('pre');
  cli.className = 'obs-entry-cli';
  cli.textContent = buildCliCommandTemplate({ revision: '<source-revision>', statement: entry.statement });
  return cli;
}

function renderEntryCard(entry) {
  const card = document.createElement('div');
  card.className = 'obs-entry';
  card.dataset.entryId = entry.id;

  const head = document.createElement('div');
  head.className = 'obs-entry-head';

  const time = document.createElement('span');
  time.className = 'obs-entry-time';
  time.textContent =
    entry.match_time != null
      ? `${formatMatchTime(entry.match_time)} / event #${entry.event_index ?? '?'}`
      : '—';

  const statement = document.createElement('span');
  statement.className = 'obs-entry-statement';
  statement.textContent = summarizeStatement(entry.statement);
  statement.title = entry.statement || '';

  const badge = document.createElement('span');
  badge.className = `obs-entry-badge obs-badge-${entry.status}`;
  badge.textContent = entry.status;

  head.appendChild(time);
  head.appendChild(statement);
  head.appendChild(badge);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'obs-entry-body';
  if (entry.sync_error || (entry.task_id == null && entry.status === 'failed')) {
    // 服务不可达 / 提交失败 → 原因 + CLI 回退模板
    const err = document.createElement('div');
    err.className = 'obs-entry-error';
    err.textContent = entry.sync_error
      ? `本地诊断端点不可用（${redactText(entry.detail_error ?? '请求失败')}），已回退到 CLI`
      : redactText(entry.detail_error ?? '提交失败');
    body.appendChild(err);
    body.appendChild(buildCliTemplateNode(entry));
  } else if (entry.task_id != null && entry.findingsDetail) {
    // 终态：findings 红点可跳转 + 结构化报告
    const findings = document.createElement('div');
    findings.className = 'obs-entry-findings';
    renderFindingsInto(findings, entry.findingsDetail.markers);
    body.appendChild(findings);
    if (entry.findingsDetail.reportText) {
      const report = document.createElement('pre');
      report.className = 'obs-entry-report';
      report.textContent = entry.findingsDetail.reportText;
      body.appendChild(report);
    }
    // triage 徽章 + 按类别的后续动作面板（bug/design/discuss）+ 创建问题按钮。
    const actions = document.createElement('div');
    actions.className = 'obs-entry-actions';
    renderReportActions(actions, entry.findingsDetail.report, entry.statement, {
      taskId: entry.task_id,
      onCreateProblem: createProblemFromEntry,
    });
    body.appendChild(actions);
  } else if (entry.task_id != null && isTerminalStatus(entry.status)) {
    // 终态但结果尚未同步（刷新恢复中/服务未返回）
    const syncing = document.createElement('div');
    syncing.className = 'obs-entry-progress';
    syncing.textContent = `已结束（${entry.status}），正在同步结果…`;
    body.appendChild(syncing);
  } else if (entry.task_id == null) {
    // 已采集未提交：提示 + CLI 模板
    const hint = document.createElement('div');
    hint.className = 'obs-entry-hint';
    hint.textContent = '已采集（未提交）。可点击「提交诊断」发到本地服务，或用 CLI 审计：';
    body.appendChild(hint);
    body.appendChild(buildCliTemplateNode(entry));
  } else if (entry.status === 'captured' && entry.task_id != null) {
    // P14 queue-only：已入队、等待用户手动取任务跑（页面不轮询）。
    const progress = document.createElement('div');
    progress.className = 'obs-entry-progress';
    progress.textContent = '已入队，等待处理。在 paseo/CLI 用 queue-cli run 取任务跑。';
    body.appendChild(progress);
  } else {
    // 处理中（auditing / audit_ready / diagnosing）
    const progress = document.createElement('div');
    progress.className = 'obs-entry-progress';
    progress.textContent = `处理中…（${entry.status}）${entry.detail_error ? redactText(entry.detail_error) : ''}`;
    body.appendChild(progress);
  }
  card.appendChild(body);
  return card;
}

function captureCurrentObservation() {
  if (!game) {
    setObsStatus('failed', '比赛未就绪');
    return;
  }
  game.playing = false; // 采集即暂停在当前时刻
  const { statement, selectedEntities, window } = readObservationInputs();
  lastBundle = captureObservation({
    game,
    statement,
    selectedEntities: resolveEntitiesForCapture(selectedEntities),
    window,
    seed: FIXED_SEED,
    config: MATCH_CONFIG,
    sourceRevision: VIEWER_SOURCE_REVISION,
  });
  const entry = createListEntry({
    id: `obs-${lastBundle.observation_id}`,
    statement,
    match_time: lastBundle.match_time,
    event_index: lastBundle.viewer_snapshot?.current_event_index ?? null,
    status: 'captured',
    task_id: null,
  });
  currentEntryId = entry.id;
  observationList = addListEntry(observationList, entry);
  saveList(obsStorage, observationList);
  renderObservationList();
  // 采集后清空描述输入框：描述以「提交时输入框」为最终权威（见 submitObservation），
  // 不清空会让下一条观察继承上一条描述（P15 错位 bug）。
  obsStatementEl.value = '';
  setObsStatus('captured', `match_time=${lastBundle.match_time}s 事件 #${lastBundle.viewer_snapshot.current_event_index}`);
  showNotice('已采集观察，可导出 bundle 或提交诊断');
}

function downloadBundle() {
  if (!lastBundle) {
    setObsStatus('captured', '请先采集观察');
    return;
  }
  // 导出前深度抹除凭证（browser 侧第一道网；runner 校验仍权威）。
  const safeBundle = redactBundleForExport(lastBundle);
  const blob = new Blob([JSON.stringify(safeBundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `observation-${lastBundle.observation_id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 提交当前观察到本地服务；不可达时回退「导出 + CLI」。browser 永远看不到 API key。
async function submitObservation() {
  if (!lastBundle || !currentEntryId) {
    setObsStatus('captured', '请先采集观察');
    return;
  }
  // 描述以「提交时输入框」为最终权威（P15）：非空（抹除凭证后）覆盖采集时冻结的初值，
  // 空则保留冻结值。用户流程是「采集 → 描述 → 提交」，故必须在此重读，不能沿用采集时快照。
  const finalStatement = resolveSubmitStatement(lastBundle.statement, obsStatementEl.value);
  if (finalStatement !== lastBundle.statement) {
    lastBundle.statement = finalStatement;
    updateEntry(currentEntryId, { statement: finalStatement });
  }
  // 输入框内容已被消费（finalStatement 已落入 bundle 与列表条目），此处同样清空。只在采集
  // 时清空不够：提交后不清空的话，下一条采集会把本条描述冻结成初值，提交时若未再输入就
  // 沿用它 —— 与 P15 修的错位同源。无条件清空（即使 finalStatement 未变化，输入框也可能
  // 有抹除/裁剪后等值的残留文本）。
  obsStatementEl.value = '';
  if (!OBSERVATION_ENDPOINT) {
    updateEntry(currentEntryId, { sync_error: true, detail_error: '未配置本地诊断端点' });
    setObsStatus('provider_unavailable', '未配置本地诊断端点，已回退到 CLI 审计');
    showNotice('回退：导出 bundle + 用 CLI 审计/诊断');
    return;
  }
  try {
    setObsStatus('auditing', '提交 bundle 到本地服务…');
    // 提交前深度抹除凭证（browser 侧第一道网；runner 校验仍权威）。
    const safeBundle = redactBundleForExport(lastBundle);
    const res = await fetch(`${OBSERVATION_ENDPOINT}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safeBundle),
    });
    if (!res.ok) {
      let detail = `endpoint HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail += `: ${redactText(String(body.error))}`;
        if (Array.isArray(body?.errors) && body.errors.length > 0) {
          detail += ` (${body.errors.map((e) => redactText(String(e))).join('; ')})`;
        }
      } catch { /* non-JSON error body */ }
      updateEntry(currentEntryId, { status: 'failed', detail_error: detail, findingsDetail: null });
      setObsStatus('failed', redactText(detail));
      return;
    }
    const data = await res.json();
    if (!data?.task_id) throw new Error('本地服务未返回 task_id');
    updateEntry(currentEntryId, {
      task_id: data.task_id,
      status: 'auditing',
      sync_error: false,
      detail_error: null,
      findingsDetail: null,
    });
    if (data.queued === true) {
      // P14 queue-only：服务只入队不自动诊断。任务停在 captured，用户在 paseo/CLI 侧
      // 用 runner-cli --run-id 手动取任务跑。静默轮询：等人取走后自动回填终态，
      // 期间服务不在线/超时都不误报「回退 CLI/失败」。
      updateEntry(currentEntryId, {
        status: 'captured',
        sync_error: false,
        detail_error: null,
        findingsDetail: null,
      });
      setObsStatus('captured', `已入队等待处理，task=${data.task_id.slice(0, 8)}…`);
      await pollTask(currentEntryId, data.task_id, true);
      return;
    }
    setObsStatus('auditing', `已提交，task=${data.task_id.slice(0, 8)}…`);
    await pollTask(currentEntryId, data.task_id);
  } catch (err) {
    // 网络失败 → 回退 CLI，条目保留上次已知状态。
    updateEntry(currentEntryId, { sync_error: true, detail_error: redactText(String(err.message)) });
    setObsStatus('provider_unavailable', `本地诊断端点不可用（${redactText(String(err.message))}），已回退到 CLI`);
  }
}

// 轮询 GET /tasks/:id，状态变化实时更新徽章；终态渲染该条目的最终反馈。
// silent 模式（P14 queue-only captured 条目）：fetch 失败 / 超时 / HTTP 错误不置
// sync_error（不误报「端点不可用/回退 CLI」）——任务本就等人手动取，服务可不在线。
// 一旦观察到任务进入活动状态（auditing/diagnosing…）则退出静默，按正常报错处理；
// 若中途变为终态则照常渲染结果。
async function pollTask(entryId, taskId, silent = false) {
  const deadline = Date.now() + OBSERVATION_POLL_MAX_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`${OBSERVATION_ENDPOINT}/tasks/${encodeURIComponent(taskId)}`);
    } catch (err) {
      // 静默：服务不在线但任务已入队，保持「已入队」展示。continue 而非 return——
      // 服务短暂离线后本轮窗口内自动恢复，无需用户刷新。
      if (silent) { await new Promise((r) => setTimeout(r, OBSERVATION_POLL_MS)); continue; }
      markEntrySyncError(entryId, err.message);
      return;
    }
    if (!res.ok) {
      if (silent) { await new Promise((r) => setTimeout(r, OBSERVATION_POLL_MS)); continue; }
      markEntrySyncError(entryId, `轮询任务 HTTP ${res.status}`);
      return;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      if (silent) { await new Promise((r) => setTimeout(r, OBSERVATION_POLL_MS)); continue; }
      markEntrySyncError(entryId, '轮询响应不是 JSON');
      return;
    }
    const state = isKnownStatus(data?.status) ? data.status : 'failed';
    // 端点错误文本先抹除再渲染，避免 key 形片段显示在页面。
    const errors = Array.isArray(data?.errors) && data.errors.length > 0
      ? data.errors.map((e) => redactText(String(e))).join('; ')
      : '';
    const patch = { status: state, sync_error: false, detail_error: errors || null };
    // P18：服务端 bundle 是已提交条目 statement 的权威源——刷新/轮询时用它覆盖本地
    // 缓存（改服务端数据后刷新即可见）。applyServerStatement 只认字符串（含空串，
    // 即用户清空）为覆盖依据，null/undefined（bundle 缺失/旧服务）保持本地值。
    // 位置在下面终态 `return` 之前，故终态条目刷新时同样回填；restoreObservationList
    // 与提交后实时轮询两条路径都经过这里。
    const current = observationList.find((e) => e.id === entryId);
    if (current) {
      const applied = applyServerStatement(current, data?.statement);
      if (applied.statement !== current.statement) patch.statement = applied.statement;
    }
    updateEntry(entryId, patch);
    if (isTerminalStatus(state)) {
      renderEntryFeedback(entryId, data);
      return;
    }
    // 队列任务已被手动取走进入活动阶段 → 退出静默，后续失败按正常上报。
    if (silent && state !== 'captured') {
      silent = false;
    }
    await new Promise((r) => setTimeout(r, OBSERVATION_POLL_MS));
  }
  // 长时间未到终态：不再无限等待，标记同步错误并回退 CLI。
  if (!silent) markEntrySyncError(entryId, '等待诊断超时');
}

// triage 徽章 + 按类别的后续动作面板（bug → change 草稿复制/下载；design →
// open questions；discuss → 需确认问题清单）。所有展示文本先 redactText。
// opts.taskId + opts.onCreateProblem 时追加「创建问题」按钮（诊断终态一键建 Problem）。
function renderReportActions(container, report, statement = '', opts = {}) {
  container.innerHTML = '';
  const t = formatTriage(report);
  if (!t) return;
  const head = document.createElement('div');
  head.className = 'triage-head';
  const badge = document.createElement('span');
  badge.className = `triage-badge triage-${t.category}`;
  badge.textContent = t.category;
  const rationale = document.createElement('span');
  rationale.className = 'triage-rationale';
  rationale.textContent = redactText(t.rationale);
  head.appendChild(badge);
  head.appendChild(rationale);
  container.appendChild(head);

  const panel = document.createElement('div');
  panel.className = 'next-steps-panel';
  if (t.category === 'bug') {
    const draft = buildChangeDraft(report, { statement });
    const heading = document.createElement('div');
    heading.className = 'next-steps-heading';
    heading.textContent = '后续动作：生成 OpenSpec change 草稿（确认后进入 change 流程）';
    panel.appendChild(heading);
    const pre = document.createElement('pre');
    pre.className = 'next-steps-draft';
    pre.textContent = draft;
    panel.appendChild(pre);
    const copy = document.createElement('button');
    copy.textContent = '复制草稿';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(draft).then(
        () => showNotice('change 草稿已复制'),
        () => showNotice('复制失败，请手动选择复制')
      );
    });
    const download = document.createElement('button');
    download.textContent = '下载草稿(.md)';
    download.addEventListener('click', () => {
      const blob = new Blob([draft], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `change-draft-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });
    panel.appendChild(copy);
    panel.appendChild(download);
  } else if (t.category === 'design') {
    const heading = document.createElement('div');
    heading.className = 'next-steps-heading';
    heading.textContent = '后续动作：open questions（进入设计讨论，讨论后再立 change）';
    panel.appendChild(heading);
    for (const q of openQuestionsFromReport(report)) {
      const item = document.createElement('div');
      item.className = 'next-steps-item';
      item.textContent = `- ${redactText(q)}`;
      panel.appendChild(item);
    }
  } else {
    const heading = document.createElement('div');
    heading.className = 'next-steps-heading';
    heading.textContent = '后续动作：需用户确认的问题（答复后重新评估）';
    panel.appendChild(heading);
    for (const q of confirmQuestionsFromReport(report)) {
      const item = document.createElement('div');
      item.className = 'next-steps-item';
      item.textContent = `- ${redactText(q)}`;
      panel.appendChild(item);
    }
  }
  // P11：诊断终态（有 task_id）追加「创建问题」→ POST /problems {task_id}。
  if (opts?.taskId && opts.onCreateProblem) {
    const createBtn = document.createElement('button');
    createBtn.textContent = '创建问题';
    createBtn.addEventListener('click', () => opts.onCreateProblem(opts.taskId));
    panel.appendChild(createBtn);
  }
  container.appendChild(panel);
}

// 终态轮询响应 → 复用导入渲染路径（taskResultToRender + findingMarkers + formatReportSummary）。
function renderEntryFeedback(entryId, data) {
  const parsed = taskResultToRender(data);
  const markers = findingMarkers(parsed.findings);
  let reportText = parsed.report ? formatReportSummary(parsed.report) : '';
  if (parsed.errors.length > 0) reportText += `\n[errors] ${parsed.errors.join('; ')}`;
  updateEntry(entryId, { findingsDetail: { markers, reportText, report: parsed.report } });
}

// 刷新后恢复：localStorage 条目 + task_id → 从服务重新拉任务状态同步最新进度。
function restoreObservationList() {
  observationList = loadList(obsStorage);
  renderObservationList();
  for (const entry of observationList) {
    if (entry.task_id) {
      // queue-only captured 条目：静默轮询（不误报回退 CLI/超时），等任务被人手动
      // 取走进入活动/终态后正常渲染。终态条目拉一次刷新最终反馈。
      pollTask(entry.id, entry.task_id, entry.status === 'captured');
    }
  }
}

// 跳转到 finding 证据：优先 event_index，回退 match_time。
function jumpToFinding(marker) {
  if (!game) return;
  if (marker.event_index != null && game.jumpToEvent(marker.event_index)) {
    updateEventIndicator();
    showNotice(`已跳转到 finding 证据事件 #${marker.event_index}`);
  } else if (marker.match_time != null) {
    game.seekTo(marker.match_time);
    updateEventIndicator();
    showNotice(`已跳转到 finding 证据 t=${marker.match_time}s`);
  } else {
    showNotice('该 finding 无定位证据');
  }
}

// 把 markers 渲染进任意容器（导入路径与列表条目共用）。
function renderFindingsInto(container, markers) {
  container.innerHTML = '';
  if (!markers || markers.length === 0) {
    container.textContent = '(无 findings)';
    return;
  }
  for (const marker of markers) {
    const item = document.createElement('div');
    item.className = 'finding-item';
    const span = document.createElement('span');
    span.textContent = marker.label;
    const btn = document.createElement('button');
    btn.className = 'jump-btn';
    btn.textContent = '跳转';
    btn.addEventListener('click', () => jumpToFinding(marker));
    item.appendChild(span);
    item.appendChild(btn);
    container.appendChild(item);
  }
}

function renderFindings(markers) {
  renderFindingsInto(obsFindingsEl, markers);
}

function importAuditReport() {
  const parsed = parseAuditImport(obsImportEl.value);
  if (parsed.kind === 'invalid' || parsed.kind === 'unknown') {
    setObsStatus('failed', parsed.errors.join('; ') || '无法识别导入内容');
    obsFindingsEl.textContent = '';
    obsReportEl.textContent = '';
    return;
  }
  const markers = findingMarkers(parsed.findings);
  setObsStatus(parsed.status, `导入 ${parsed.kind}，${markers.length} 条 finding`);
  renderFindings(markers);
  obsReportEl.textContent = parsed.report ? formatReportSummary(parsed.report) : '';
  if (parsed.errors && parsed.errors.length > 0) {
    obsReportEl.textContent += `\n[errors] ${parsed.errors.join('; ')}`;
  }
  // triage 徽章 + 按类别的后续动作面板（导入路径）。
  renderReportActions(obsNextEl, parsed.report, '');
}

btnCapture.addEventListener('click', captureCurrentObservation);
btnExportBundle.addEventListener('click', downloadBundle);
btnSubmit.addEventListener('click', submitObservation);
btnImport.addEventListener('click', importAuditReport);

// --- P11 问题管理视图（task 4.1/4.2）---

const tabMatch = document.getElementById('tab-match');
const tabProblems = document.getElementById('tab-problems');
const matchViewEl = document.getElementById('match-view');
const problemViewEl = document.getElementById('problem-view');
const problemListEl = document.getElementById('problem-list');
const problemDetailEl = document.getElementById('problem-detail');
const problemFilterTriage = document.getElementById('problem-filter-triage');
const problemFilterStatus = document.getElementById('problem-filter-status');
const problemRefreshBtn = document.getElementById('problem-refresh');
const problemImportBtn = document.getElementById('problem-import');
const problemStatusEl = document.getElementById('problem-status');

// 复用观察诊断端点（POST /observations 与 /problems 同服务）。
const problemApi = createProblemApi({ endpoint: OBSERVATION_ENDPOINT });
let currentProblems = [];
let currentProblemDetailId = null;

function showProblemStatus(msg) {
  problemStatusEl.textContent = msg;
}

// 视图切换：比赛 / 问题。切到问题时自动拉取列表。
function switchView(view) {
  const isProblems = view === 'problems';
  matchViewEl.hidden = isProblems;
  problemViewEl.hidden = !isProblems;
  tabMatch.classList.toggle('active', !isProblems);
  tabProblems.classList.toggle('active', isProblems);
  if (isProblems) refreshProblemList();
}

// 拉取 /problems 列表；服务不可达时回退提示（不阻塞诊断链路）。
async function refreshProblemList() {
  showProblemStatus('加载中…');
  try {
    const res = await problemApi.list();
    if (!res.ok) {
      showProblemStatus(`加载问题失败：${res.data?.error ?? `HTTP ${res.status}`}`);
      currentProblems = [];
    } else {
      currentProblems = normalizeProblems(res.data?.problems);
    }
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}），请确认 service 已启动`);
    currentProblems = [];
  }
  renderProblemList();
}

function renderProblemList() {
  const filtered = filterProblems(currentProblems, {
    triage: problemFilterTriage.value || undefined,
    status: problemFilterStatus.value || undefined,
  });
  problemListEl.innerHTML = '';
  if (filtered.length === 0) {
    problemListEl.textContent = '(暂无匹配的问题 — 在「观察采集 / 诊断」面板对已诊断结果点「创建问题」)';
    return;
  }
  for (const p of filtered) problemListEl.appendChild(buildProblemCard(p));
}

function buildProblemCard(p) {
  const card = document.createElement('div');
  card.className = 'problem-card';
  card.dataset.problemId = p.id;
  const head = document.createElement('div');
  head.className = 'problem-card-head';
  const badge = document.createElement('span');
  badge.className = `problem-triage-badge ${triageBadgeClass(p.triage)}`;
  badge.textContent = p.triage;
  const title = document.createElement('span');
  title.className = 'problem-card-title';
  title.textContent = redactText(summarizeProblemTitle(p.title));
  title.title = redactText(p.title);
  const status = document.createElement('span');
  status.className = `problem-status-badge problem-status-${p.status}`;
  status.textContent = p.status;
  const source = document.createElement('span');
  source.className = 'problem-source';
  source.textContent = problemSourceLabel(p);
  head.append(badge, title, status, source);
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'problem-card-meta';
  if (p.github?.issue_number) {
    const url = p.github.url ?? '';
    const safeUrl = /^https?:\/\//i.test(url) ? url : null;
    const a = document.createElement('a');
    a.className = 'problem-issue-link';
    if (safeUrl) {
      a.href = safeUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      // 卡片整体可点击打开详情；链接点击只导航，不冒泡触发详情。
      a.addEventListener('click', (e) => e.stopPropagation());
    }
    a.textContent = `#${p.github.issue_number}`;
    meta.appendChild(a);
  }
  if (p.change_ref) {
    const ref = document.createElement('span');
    ref.className = 'problem-ref';
    ref.textContent = `change: ${redactText(p.change_ref)}`;
    meta.appendChild(ref);
  }
  const time = document.createElement('span');
  time.className = 'problem-time';
  time.textContent = formatProblemTime(p.created_at);
  meta.appendChild(time);
  card.appendChild(meta);

  card.addEventListener('click', () => openProblemDetail(p.id));
  return card;
}

// 详情：拉取最新问题并渲染（动作/讨论后刷新用同一路径）。
async function openProblemDetail(id) {
  try {
    const res = await problemApi.get(id);
    if (!res.ok) {
      showProblemStatus(`加载问题失败：${res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    const p = normalizeProblem(res.data);
    if (!p) {
      showProblemStatus('问题数据无效');
      return;
    }
    currentProblemDetailId = id;
    problemDetailEl.innerHTML = '';
    problemDetailEl.appendChild(buildProblemDetail(p));
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

function buildProblemDetail(p) {
  const r = problemDetailToRender(p);
  const wrap = document.createElement('div');
  wrap.className = 'problem-detail';

  const back = document.createElement('button');
  back.textContent = '← 返回列表';
  back.addEventListener('click', () => {
    problemDetailEl.innerHTML = '';
    currentProblemDetailId = null;
  });
  wrap.appendChild(back);

  const head = document.createElement('div');
  head.className = 'problem-detail-head';
  const badge = document.createElement('span');
  badge.className = `problem-triage-badge ${triageBadgeClass(p.triage)}`;
  badge.textContent = p.triage;
  const status = document.createElement('span');
  status.className = `problem-status-badge problem-status-${p.status}`;
  status.textContent = p.status;
  const source = document.createElement('span');
  source.className = 'problem-source';
  source.textContent = `来源: ${r.source}`;
  const time = document.createElement('span');
  time.className = 'problem-time';
  time.textContent = `创建 ${formatProblemTime(p.created_at)}`;
  head.append(badge, status, source, time);
  wrap.appendChild(head);

  const title = document.createElement('div');
  title.className = 'problem-detail-title';
  title.textContent = r.title;
  wrap.appendChild(title);

  if (r.description) {
    const desc = document.createElement('div');
    desc.className = 'problem-detail-desc';
    desc.textContent = r.description;
    wrap.appendChild(desc);
  }

  const ghUrl = r.github?.url ?? '';
  if (r.github && /^https?:\/\//i.test(ghUrl)) {
    const a = document.createElement('a');
    a.className = 'problem-issue-link';
    a.href = ghUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `GitHub issue #${r.github.issue_number}`;
    wrap.appendChild(a);
  }

  if (r.reportText) {
    const report = document.createElement('pre');
    report.className = 'problem-report';
    report.textContent = r.reportText;
    wrap.appendChild(report);
  }

  if (r.fix_ref) {
    wrap.appendChild(buildFixRefSection(r.fix_ref));
  }

  if (r.decisions.length) {
    const dec = document.createElement('div');
    dec.className = 'problem-decisions';
    const heading = document.createElement('div');
    heading.className = 'problem-section-heading';
    heading.textContent = '决策轨迹';
    dec.appendChild(heading);
    for (const d of r.decisions) {
      const row = document.createElement('div');
      row.className = 'problem-decision-row';
      row.textContent = formatDecisionText(d);
      dec.appendChild(row);
    }
    wrap.appendChild(dec);
  }

  wrap.appendChild(buildChangeRefEditor(p));
  wrap.appendChild(buildProblemActions(p));
  wrap.appendChild(buildDiscussionArea(p));
  return wrap;
}

// fix_ref 摘要区块：worktree / branch / status（pending_confirm 展示合入与拒绝按钮，
// merged/rejected 展示时间）。全部 textContent + redactText（渲染数据已净化）。
function buildFixRefSection(fr) {
  const sec = document.createElement('div');
  sec.className = 'problem-fixref';
  const heading = document.createElement('div');
  heading.className = 'problem-section-heading';
  heading.textContent = '修复 (fix_ref)';
  sec.appendChild(heading);
  const lines = [
    `状态: ${fr.status}`,
    fr.branch ? `分支: ${fr.branch}` : null,
    fr.worktree ? `worktree: ${fr.worktree}` : null,
    fr.status === 'merged' && fr.merged_at ? `合入时间: ${fr.merged_at}` : null,
    fr.status === 'rejected' && fr.rejected_at ? `拒绝时间: ${fr.rejected_at}` : null,
  ].filter(Boolean);
  const text = document.createElement('div');
  text.className = 'problem-decision-row';
  text.textContent = lines.join('\n');
  sec.appendChild(text);
  return sec;
}

function buildChangeRefEditor(p) {
  const row = document.createElement('div');
  row.className = 'problem-action-row';
  const label = document.createElement('label');
  label.textContent = 'change_ref';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '如 p12-fix（留空 = 清除）';
  input.value = p.change_ref ?? '';
  const save = document.createElement('button');
  save.textContent = '保存';
  save.addEventListener('click', () => patchProblemAndRefresh(p.id, buildProblemPatch({ change_ref: input.value })));
  row.append(label, input, save);
  return row;
}

function buildProblemActions(p) {
  const wrap = document.createElement('div');
  wrap.className = 'problem-actions';
  const heading = document.createElement('div');
  heading.className = 'problem-section-heading';
  heading.textContent = '动作';
  wrap.appendChild(heading);

  const triageRow = document.createElement('div');
  triageRow.className = 'problem-action-row';
  triageRow.appendChild(document.createTextNode('分类:'));
  for (const t of ['bug', 'design', 'discuss']) {
    const b = document.createElement('button');
    b.textContent = t;
    b.disabled = p.triage === t;
    b.addEventListener('click', () => patchProblemAndRefresh(p.id, buildProblemPatch({ triage: t })));
    triageRow.appendChild(b);
  }
  const deferBtn = document.createElement('button');
  deferBtn.textContent = 'defer';
  deferBtn.addEventListener('click', () => requestReasonedAction(p.id, 'defer'));
  const wontfixBtn = document.createElement('button');
  wontfixBtn.textContent = 'wontfix';
  wontfixBtn.addEventListener('click', () => requestReasonedAction(p.id, 'wontfix'));
  triageRow.appendChild(deferBtn);
  triageRow.appendChild(wontfixBtn);
  if (p.triage === 'defer' || p.triage === 'wontfix') {
    const reopenBtn = document.createElement('button');
    reopenBtn.textContent = '重开';
    reopenBtn.addEventListener('click', () =>
      patchProblemAndRefresh(p.id, buildProblemPatch({ triage: 'discuss', reason: 'reopen' }))
    );
    triageRow.appendChild(reopenBtn);
  }
  wrap.appendChild(triageRow);

  const statusRow = document.createElement('div');
  statusRow.className = 'problem-action-row';
  statusRow.appendChild(document.createTextNode('状态:'));
  for (const s of ['in_progress', 'fixed', 'closed']) {
    const b = document.createElement('button');
    b.textContent = s;
    b.disabled = p.status === s;
    b.addEventListener('click', () => patchProblemAndRefresh(p.id, buildProblemPatch({ status: s })));
    statusRow.appendChild(b);
  }
  wrap.appendChild(statusRow);

  const ghRow = document.createElement('div');
  ghRow.className = 'problem-action-row';
  const ghBtn = document.createElement('button');
  if (p.triage === 'defer' || p.triage === 'wontfix') {
    // 废弃/暂停的问题不落 issue。
    ghBtn.textContent = '提交 GitHub issue';
    ghBtn.disabled = true;
    ghBtn.title = 'defer/wontfix 问题不提交 issue';
  } else {
    ghBtn.textContent = p.triage === 'discuss' ? '转为 issue' : '提交 GitHub issue';
    ghBtn.addEventListener('click', () => submitGithubIssue(p.id));
  }
  ghRow.appendChild(ghBtn);
  wrap.appendChild(ghRow);

  // P12：重跑诊断（有关联任务时）与删除（confirm 确认）。
  const opsRow = document.createElement('div');
  opsRow.className = 'problem-action-row';
  if (p.source?.task_id) {
    const rerunBtn = document.createElement('button');
    rerunBtn.textContent = '重跑诊断';
    rerunBtn.addEventListener('click', () => rerunProblemDiagnosis(p.id));
    opsRow.appendChild(rerunBtn);
  }
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => deleteProblemConfirm(p.id));
  opsRow.appendChild(deleteBtn);
  wrap.appendChild(opsRow);

  // P13：验证下发（白名单命令，可勾选「验证并标记 fixed」）。
  const verifyRow = document.createElement('div');
  verifyRow.className = 'problem-action-row';
  verifyRow.appendChild(document.createTextNode('验证:'));
  const verifyCmdInput = document.createElement('input');
  verifyCmdInput.type = 'text';
  verifyCmdInput.placeholder = '验证命令（留空 = 报告默认）';
  const verifyFixedBox = document.createElement('label');
  const verifyFixedCheck = document.createElement('input');
  verifyFixedCheck.type = 'checkbox';
  verifyFixedBox.append(verifyFixedCheck, document.createTextNode('并标记 fixed'));
  const verifyBtn = document.createElement('button');
  verifyBtn.textContent = '验证';
  verifyBtn.addEventListener('click', () => runVerify(p.id, verifyCmdInput.value, verifyFixedCheck.checked));
  verifyRow.append(verifyCmdInput, verifyFixedBox, verifyBtn);
  wrap.appendChild(verifyRow);

  // P13：修复下发（隔离 worktree + bypass agent）。已有 pending fix 时禁用。
  const fixRow = document.createElement('div');
  fixRow.className = 'problem-action-row';
  fixRow.appendChild(document.createTextNode('修复:'));
  const fixBtn = document.createElement('button');
  fixBtn.textContent = '修复';
  const pendingConfirm = p.fix_ref?.status === 'pending_confirm';
  fixBtn.disabled = pendingConfirm;
  fixBtn.title = pendingConfirm ? '已有待确认的修复' : '在隔离 worktree 启动修复 agent';
  fixBtn.addEventListener('click', () => dispatchFix(p.id));
  fixRow.appendChild(fixBtn);
  if (pendingConfirm) {
    const mergeBtn = document.createElement('button');
    mergeBtn.textContent = '确认合入';
    mergeBtn.addEventListener('click', () => confirmMergeFix(p.id));
    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = '拒绝修复';
    rejectBtn.addEventListener('click', () => rejectFix(p.id));
    fixRow.append(mergeBtn, rejectBtn);
  }
  wrap.appendChild(fixRow);
  return wrap;
}

// defer/wontfix 弹输入框要求 reason（必填校验）。
function requestReasonedAction(id, triage) {
  const reason = window.prompt(`填写「${triage}」理由（必填）：`, '');
  if (reason === null) return; // 用户取消
  const check = validateProblemAction({ triage, reason });
  if (!check.ok) {
    showProblemStatus(check.error);
    return;
  }
  patchProblemAndRefresh(id, buildProblemPatch({ triage, reason }));
}

// 动作 → PATCH → 刷新列表 + 重渲染详情。
async function patchProblemAndRefresh(id, patch) {
  const check = validateProblemAction(patch);
  if (!check.ok) {
    showProblemStatus(check.error);
    return;
  }
  try {
    const res = await problemApi.patch(id, patch);
    if (!res.ok) {
      showProblemStatus(`更新失败：${res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    await refreshProblemList();
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// 提交 GitHub issue：成功回写 github 引用；失败展示明确错误，本地 problem 不变。
async function submitGithubIssue(id) {
  try {
    const res = await problemApi.github(id, {});
    if (!res.ok) {
      showProblemStatus(`GitHub 提交失败：${res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    if (res.data?.dryRun) {
      showProblemStatus('dryRun：未实际创建 issue');
      return;
    }
    const num = res.data?.github?.issue_number;
    showProblemStatus(num ? `已提交 GitHub issue #${num}` : '已提交 GitHub issue');
    await refreshProblemList();
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// 重跑诊断：POST rerun → 202 {task_id} → 轮询新任务终态 → diagnosed 刷新详情拿新报告；
// 其它终态（failed/insufficient_evidence/provider_unavailable）提示失败，不当作成功。
async function rerunProblemDiagnosis(id) {
  try {
    const res = await problemApi.rerun(id, {});
    if (!res.ok) {
      showProblemStatus(`重跑失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    const taskId = res.data?.task_id;
    if (!taskId) {
      showProblemStatus('重跑失败：服务未返回 task_id');
      return;
    }
    showProblemStatus('重跑诊断已提交，等待完成…');
    const poll = await pollRerunTask(taskId, {
      endpoint: OBSERVATION_ENDPOINT,
      pollMs: OBSERVATION_POLL_MS,
      maxMs: OBSERVATION_POLL_MAX_MS,
    });
    if (!poll.ok) {
      showProblemStatus(poll.error);
      return;
    }
    showProblemStatus('重跑完成，已刷新问题详情');
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// 删除：confirm 确认后 DELETE；若正显示该详情则回到列表。
async function deleteProblemConfirm(id) {
  if (!window.confirm(`确定删除问题 ${id}？此操作不可撤销。`)) return;
  try {
    const res = await problemApi.remove(id);
    if (!res.ok) {
      showProblemStatus(`删除失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showProblemStatus('已删除问题');
    if (currentProblemDetailId === id) {
      problemDetailEl.innerHTML = '';
      currentProblemDetailId = null;
    }
    await refreshProblemList();
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// P13 验证下发：POST verify（command 可空 = 服务端取报告默认白名单命令；mark_fixed
// 勾选时 exit 0 自动置 fixed）。完成后刷新详情看决策与状态。
async function runVerify(id, command, markFixed) {
  const body = { mark_fixed: markFixed === true };
  if (command && command.trim()) body.command = command.trim();
  try {
    showProblemStatus('验证中…（可能耗时）');
    const res = await problemApi.verify(id, body);
    if (!res.ok) {
      showProblemStatus(`验证失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showProblemStatus(res.data?.status === 'fixed' ? '验证通过，已标记 fixed' : '验证完成');
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// P13 修复下发：POST fix（同步等待 provider 完成）。成功建 fix_ref pending_confirm，
// 失败只记决策。主 checkout 零改动。
async function dispatchFix(id) {
  if (!window.confirm('将在隔离 worktree 启动修复 agent（bypass，可能耗时数分钟）。主 checkout 不受影响；完成后需人工确认合入。继续？')) {
    return;
  }
  try {
    showProblemStatus('修复中…（可能耗时数分钟，请勿关闭页面）');
    const res = await problemApi.fix(id, {});
    if (!res.ok) {
      showProblemStatus(`修复失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    if (res.data?.fix_ref?.status === 'pending_confirm') {
      showProblemStatus('修复完成：已生成隔离修复分支，等待确认合入');
    } else {
      showProblemStatus('修复未成功（见决策轨迹）');
    }
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// P13 确认合入：POST merge-fix（git merge --no-ff + worktree 清理 + problem closed）。
async function confirmMergeFix(id) {
  if (!window.confirm('确认将修复分支合入主 checkout？合入后问题将关闭（change_ref 自动填写）。')) {
    return;
  }
  try {
    const res = await problemApi.mergeFix(id, {});
    if (!res.ok) {
      showProblemStatus(`合入失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showProblemStatus('修复已合入，问题已关闭');
    await refreshProblemList();
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// P13 拒绝修复：POST merge-fix {reject:true}（worktree 保留，fix_ref rejected）。
async function rejectFix(id) {
  const reason = window.prompt('拒绝理由（可选）：', '');
  if (reason === null) return;
  try {
    const res = await problemApi.mergeFix(id, { reject: true, reason });
    if (!res.ok) {
      showProblemStatus(`拒绝失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showProblemStatus('已拒绝修复（worktree 保留，问题未闭环）');
    await openProblemDetail(id);
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

// 导入历史任务：POST /problems/import → 刷新列表 + notice 显示 created/skipped 摘要。
async function importHistoryProblems() {
  try {
    const res = await problemApi.importProblems({});
    if (!res.ok) {
      showProblemStatus(`导入失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showNotice(summarizeImportResult(res.data));
    await refreshProblemList();
  } catch (err) {
    showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

function buildDiscussionArea(p) {
  const wrap = document.createElement('div');
  wrap.className = 'problem-discussion';
  const heading = document.createElement('div');
  heading.className = 'problem-section-heading';
  heading.textContent = `讨论（${p.discussion.length}）`;
  wrap.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'problem-discussion-list';
  for (const d of problemDetailToRender(p).discussion) {
    const row = document.createElement('div');
    row.className = 'problem-discussion-row';
    const meta = document.createElement('span');
    meta.className = 'problem-discussion-meta';
    meta.textContent = `${d.author} @ ${d.at}`;
    const text = document.createElement('div');
    text.className = 'problem-discussion-text';
    text.textContent = d.text;
    row.append(meta, text);
    list.appendChild(row);
  }
  wrap.appendChild(list);

  const inputRow = document.createElement('div');
  inputRow.className = 'problem-action-row';
  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.placeholder = '作者（留空 = 匿名）';
  authorInput.value = 'user';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = '留言…';
  const sendBtn = document.createElement('button');
  sendBtn.textContent = '留言';
  sendBtn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    if (!text) {
      showProblemStatus('留言内容不能为空');
      return;
    }
    const author = authorInput.value.trim() || '匿名';
    try {
      const res = await problemApi.discuss(p.id, { author, text });
      if (!res.ok) {
        showProblemStatus(`留言失败：${res.data?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      textInput.value = '';
      await openProblemDetail(p.id);
    } catch (err) {
      showProblemStatus(`本地诊断服务不可达（${redactText(String(err.message))}）`);
    }
  });
  inputRow.append(authorInput, textInput, sendBtn);
  wrap.appendChild(inputRow);
  return wrap;
}

// 观察面板「创建问题」按钮 → POST /problems {task_id} → 切问题视图。服务不可达
// 回退提示，不阻塞诊断链路（轮询/CLI 回退照常）。
async function createProblemFromEntry(taskId) {
  try {
    const res = await problemApi.create({ task_id: taskId });
    if (!res.ok) {
      showNotice(`创建问题失败：${redactText(res.data?.error ?? `HTTP ${res.status}`)}`);
      return;
    }
    showNotice(`已创建问题 ${res.data?.id ?? ''}，切到问题视图`);
    switchView('problems');
  } catch (err) {
    showNotice(`创建问题失败：本地诊断服务不可达（${redactText(String(err.message))}）`);
  }
}

tabMatch.addEventListener('click', () => switchView('match'));
tabProblems.addEventListener('click', () => switchView('problems'));
problemFilterTriage.addEventListener('change', renderProblemList);
problemFilterStatus.addEventListener('change', renderProblemList);
problemRefreshBtn.addEventListener('click', refreshProblemList);
problemImportBtn.addEventListener('click', importHistoryProblems);

// 启动：先尝试 WASM，再 init
tryLoadEngine().then(() => init());
// 恢复观察列表（localStorage 元数据 + task_id → 从服务重新同步状态）
restoreObservationList();
requestAnimationFrame(frame);
