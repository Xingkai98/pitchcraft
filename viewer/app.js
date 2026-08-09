// app.js：入口。加载 WASM 引擎 → 产事件流 → 创建 Game → 渲染循环 + 播放控制
// 任务 5.1：fetch engine.wasm 并实例化，调用 simulate(seed, config)。
// 注意：需通过本地 HTTP server 打开（file:// 下 fetch .wasm 会失败）。

// 版本号：改 JS 后统一更新（index.html 的 ?v= 也同步改）
// 顶层 import 带版本号，强制浏览器刷新入口模块；传递依赖（game.js/renderer.js 内部 import）
// 未带版本号（Node 测试不支持查询串），改动它们时靠 HTTP 重新校验/硬刷新兜底
import { config } from './config.js?v=20260808-12';
import { createRenderer, drawPitch, renderFrame } from './renderer.js?v=20260808-12';
import { createGame } from './game.js?v=20260808-12';
import { mockEventStream } from './mock-event-stream.js?v=20260808-12';
import { resetMicroMotion } from './micro-motion.js?v=20260808-12';

const canvas = document.getElementById('pitch');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const scoreEl = document.getElementById('score');
const btnToggle = document.getElementById('btn-toggle');
const btnDuration = document.getElementById('btn-duration');
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
// config：连续比赛（demo_mode: false）产整场事件流；比赛时长可调（P7：默认 90 分钟）
const MATCH_CONFIG = { demo_mode: false };
let durationIndex = config.playback.matchDurations.indexOf(config.playback.matchDuration);
if (durationIndex < 0) durationIndex = config.playback.matchDurations.length - 1;

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
    renderFrame(ctx, { players: game.players, ball: game.ball }, canvas.width, canvas.height, { playTime: game.playTime, movingIds, dt });
    // 比分显示（简单：从事件流里找最近一次 goal）
    updateScore();
    // 拖动进度条时 status 由 input handler 显示"已暂停"，不被帧循环覆盖
    if (!_seeking) {
      const skipping = game.isSkipping();
      if (skipping) {
        const detail = game.skipMode === 'fast' ? `${game.getSkipChoice()}x快进` : '跳转';
        statusEl.textContent = `比赛 ${formatMatchClock(game.playTime)} 跳过中(${detail})`;
      } else {
        statusEl.textContent = `比赛 ${formatMatchClock(game.playTime)} 播放率=${game.getPlaybackRate().toFixed(0)}x`;
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
      const durMin = config.playback.matchDurations[durationIndex] ?? 90;
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
    // 重置时长/跳过/速度按钮与跳转输入（新 game 回到当前时长、快速跳过、1x、事件 0）
    const durMin = config.playback.matchDurations[durationIndex] ?? 90;
    btnDuration.textContent = `比赛 ${durMin}min`;
    btnSkip.textContent = game.skipMode === 'fast' ? `跳过:快进${game.getSkipChoice()}x` : '跳过:直接跳';
    btnSpeed.textContent = `倍速 ${game.getSpeed()}x`;
    eventIdInput.value = '0';
  } catch (err) {
    statusEl.textContent = `错误: ${err.message}`;
    console.error(err);
  }
}

// 重新建 Game（时长改变后重新 simulate）
async function rebuildGame() {
  await init();
  resetMicroMotion();
  showNotice(`已切换为 ${config.playback.matchDurations[durationIndex]} 分钟比赛`);
}

// 控制按钮
btnToggle.addEventListener('click', () => {
  if (game) {
    game.togglePlay();
    showNotice(game.playing ? '播放中' : '已暂停');
  }
});
btnDuration.addEventListener('click', () => {
  // 比赛时长选项循环（5/10/45/90 分钟），重新 simulate
  durationIndex = (durationIndex + 1) % config.playback.matchDurations.length;
  rebuildGame();
});
btnSkip.addEventListener('click', () => {
  if (game) {
    if (game.skipMode === 'fast') {
      // fast → skip
      game.skipMode = 'skip';
      btnSkip.textContent = '跳过:直接跳';
      showNotice('跳过模式：直接跳过非精彩段（切到下一个高亮）');
    } else {
      // skip → fast（循环快进倍速）
      game.skipMode = 'fast';
      const c = game.cycleSkipChoice();
      btnSkip.textContent = `跳过:快进${c}x`;
      showNotice(`跳过模式：非精彩段 ${c}x 快进`);
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

// 启动：先尝试 WASM，再 init
tryLoadEngine().then(() => init());
requestAnimationFrame(frame);
