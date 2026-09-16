// 游戏循环：消费事件流 + 锚点时间线，推进播放时刻，计算每帧的球员/球位置
// 输入：事件流（含 lineup），输出：每帧 { players, ball }（归一化坐标）
//
// 两种播放模式：
//   continuous（默认）：整场连续播放。playTime 从事件流开头走到结尾，播完当前事件
//     自动切下一个；事件之间由 off_ball_run（无球跑位）锚点填满，画面持续有动作。
//   clip：每个事件是"独立片段"，选中事件 → 显示初始状态，点播放 → 只在该事件窗口推进，播完停。
//     （保留为调试/单事件点播工具。）

import { config } from './config.js';
import { buildTimeline } from './interpretation.js';
import { parseEventStream } from './protocol.js';

// 播放器状态机
export class Game {
  constructor(events, lineup, mode = 'continuous', opts = {}) {
    this.events = events;
    this.lineup = lineup; // 初始站位 [{id, team, x, y}]
    this.mode = mode === 'clip' ? 'clip' : 'continuous';
    // 当前每帧状态：球员位置（含初始站位）+ 球位置
    // 全量球员（位置由 `_updateFromTimeline` 每帧插值维护）；对外 `players` getter 会过滤
    // 罚下球员（渲染 / `viewer_snapshot` 都不应看到幽灵）。
    this._players = (lineup || []).map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y }));
    this.ball = { x: 0.5, y: 0.5 };
    // 播放控制
    this.playing = false; // 默认不自动播放
    this.speedIndex = 0; // 0 -> 1x, 1 -> 2x, 2 -> 4x
    this.playTime = 0; // 当前播放的比赛秒
    this.timeline = buildTimeline(events, this.mode); // 锚点时间线（continuous 启用 carry-beat 丢弃）
    // 罚下集合（红牌 / 二黄升级）。引擎 `apply_card` 把二黄升级也记为 `card:"red"`，故
    // `foul` 的 `card:"red"` 是罚下的唯一对外信号。罚下后引擎不再发射该球员的任何锚点
    // （spec：不得进 movers / 不得持球），但时间线会**保持其最后锚点**——若不在渲染层
    // 排除，红牌球员会以「幽灵」永远杵在场上（P34 审阅 R3-P2-3；同 `derive-audit-features`
    // 的 `sentOffTimes`，两处口径一致）。
    // id → 罚下时刻（该时刻之后才离场；时刻之前仍在场上，须正常渲染）。
    this.sentOffAt = new Map();
    for (const e of events) {
      if (e && e.type === 'foul' && e.card === 'red' && typeof e.subject === 'number') {
        if (!this.sentOffAt.has(e.subject)) this.sentOffAt.set(e.subject, e.t);
      }
    }
    this._buildAnchorIndex(); // 按实体分组的时间索引（P3.5：~2900 事件数万锚点，线性扫描会卡）
    this._clipIndex = 0; // clip 模式：当前选中事件索引
    // 每个事件的结束时间：该事件最后一个锚点的 t + 余量，作为独立片段时长（clip 用）
    this._eventEnds = this._computeEventEnds(events);
    // 比赛总时长（continuous 播到这就结束）：取最后锚点 t（保证尾部动画不被截断）
    this._matchEnd = this.timeline.length > 0
      ? Math.max(events[events.length - 1]?.t ?? 0, this.timeline[this.timeline.length - 1].t)
      : 0;
    // P7：跳过机制——高亮段正常播放（baseSpeed=1，球员真实速度），非精彩段（间隙 > 阈值）快进/跳过。
    // opts.baseSpeed 可覆盖基速（测试用 1x）；opts.skipThreshold 可覆盖间隙阈值（测试用 Infinity 关闭跳过）。
    this._baseSpeed = opts.baseSpeed ?? 1;
    this._skipThreshold = opts.skipThreshold ?? config.playback.skipThresholdSeconds;
    // 高亮事件索引（间隙检测用）
    this._buildHighlightIndex();
    // 跳过模式：fast（快速播放 skipChoice 倍速）/ skip（直接跳到下一个高亮）
    this.skipIndex = 0;
    this.skipMode = config.playback.skipMode === 'skip' ? 'skip' : 'fast';
    this.skipChoiceIndex = 0;
    // 初始化到第一个事件的初始状态
    this._initToEvent(0);
    this._prevPlayerPos = new Map(); // 调试：球员上一帧位置快照
    for (const p of this._players) {
      this._prevPlayerPos.set(p.id, { x: p.x, y: p.y });
    }
    this._lastLoggedEventIdx = -1; // 调试：上次日志的事件索引
  }

  // P7：高亮事件识别（跳过机制）——shot / tackle / pass detail 属精彩集合；
  // 普通 pass（无 detail）与 beat 是过渡段（可跳过）
  isHighlightEvent(e) {
    if (!e) return false;
    if (e.type === 'shot' || e.type === 'tackle' || e.type === 'foul') return true;
    if (e.type === 'pass' && e.detail) {
      return ['corner', 'out_sideline', 'out_goal_line', 'clearance', 'throw_in', 'free_kick'].includes(e.detail);
    }
    return false;
  }

  // 高亮事件窗口索引：[t, end]（窗口内正常播放，窗口外可跳过）。
  // 相邻高亮事件（间隔 < skipThreshold）合并成一个连续窗口——角球发球→争抢→头球整段连续播放，不中途跳过。
  _buildHighlightIndex() {
    this._highlightWindows = [];
    if (this._eventEnds) {
      let cur = null;
      for (let i = 0; i < this.events.length; i++) {
        if (this.isHighlightEvent(this.events[i])) {
          const w = { t: this.events[i].t, end: this._eventEnds[i] ?? this.events[i].t };
          if (cur && w.t <= cur.end + this._skipThreshold) {
            cur.end = Math.max(cur.end, w.end); // 合并级联（间隔 < 阈值）
          } else {
            cur = w;
            this._highlightWindows.push(cur);
          }
        }
      }
    }
  }

  // 当前时间是否在高亮事件窗口内
  _inHighlightWindow(t) {
    for (const w of this._highlightWindows) {
      if (t >= w.t - 0.01 && t <= w.end) return true;
    }
    return false;
  }

  // 下一个高亮事件开始时间（> t），无则 null
  _nextHighlightTime(t) {
    for (const w of this._highlightWindows) {
      if (w.t > t + 0.01) return w.t;
    }
    return null;
  }

  // 当前是否处于跳过段（非高亮窗口且距下一个高亮 > 阈值；尾部 nextHl=null 也算跳过）。
  // skipMode='off' 或 skipThreshold=Infinity 时跳过完全禁用（测试/关闭用）。
  isSkipping() {
    if (!this.isSkipEnabled()) return false;
    const nextHl = this._nextHighlightTime(this.playTime);
    const inHl = this._inHighlightWindow(this.playTime);
    return !inHl && (nextHl === null || (nextHl - this.playTime) > this._skipThreshold);
  }

  // P7：循环跳过模式（快速播放 → 直接跳 → 关闭）
  cycleSkipMode() {
    if (this.skipMode === 'fast') this.skipMode = 'skip';
    else if (this.skipMode === 'skip') this.skipMode = 'off';
    else this.skipMode = 'fast';
    return this.skipMode;
  }

  getSkipMode() {
    return this.skipMode;
  }

  // 跳过是否开启（off 时完全禁用，正常播放所有内容）
  isSkipEnabled() {
    return this.skipMode !== 'off' && this._skipThreshold < Infinity;
  }

  // P7：循环快速播放倍速（5x/10x）
  cycleSkipChoice() {
    this.skipChoiceIndex = (this.skipChoiceIndex + 1) % config.playback.skipChoices.length;
    return config.playback.skipChoices[this.skipChoiceIndex];
  }

  getSkipChoice() {
    return config.playback.skipChoices[this.skipChoiceIndex];
  }

  // 计算每个事件的结束时间：该事件所有锚点里最大的 t
  _computeEventEnds(events) {
    const ends = new Array(events.length);
    // 按 evt 索引收集每个事件的最大锚点 t
    const maxByEvt = new Map();
    for (const a of this.timeline) {
      const cur = maxByEvt.get(a.evt) ?? -Infinity;
      if (a.t > cur) maxByEvt.set(a.evt, a.t);
    }
    for (let i = 0; i < events.length; i++) {
      ends[i] = maxByEvt.get(i) ?? events[i].t;
    }
    return ends;
  }

  // 初始化/切换到某事件的初始状态：playTime = 事件 t，球员/球回到该事件起点锚点
  // 可见球员（渲染 / snapshot 用）：排除已罚下者——引擎罚下后不再发射其锚点、时间线却会
  // 保持最后锚点，若不排除会永远画一个静止「幽灵」（P34 审阅 R3-P2-3；口径同
  // `derive-audit-features` 的 `sentOffTimes`）。
  get players() {
    if (this.sentOffAt.size === 0) return this._players;
    const t = this.playTime;
    return this._players.filter((p) => {
      const offAt = this.sentOffAt.get(p.id);
      return offAt === undefined || t <= offAt;
    });
  }

  _initToEvent(index) {
    if (index < 0 || index >= this.events.length) return false;
    this._clipIndex = index;
    this.playTime = this.events[index].t;
    this.playing = false;
    this._lastLoggedEventIdx = -1; // 切换事件后，下次 step 会打 [EVENT] 日志
    this._updateFromTimeline();
    return true;
  }

  // 推进播放：dt 为真实秒。
  // continuous：整场推进，跨事件、事件间 off_ball_run 填满，播到比赛结束自动停。
  // clip：只在当前事件片段内推进，播完自动停。
  step(dt) {
    if (!this.playing) return;
    // 帧尖峰钳制（切标签页/GC 时 dt 数秒）：限制单帧步进，避免 fast 跳过整段高亮窗口
    dt = Math.min(dt, 0.1);
    // P7：高亮段基速 × 倍速；非精彩段（间隙 > 阈值）跳过（快速播放 × skipChoice 或直接跳）
    const speed = this._baseSpeed * (config.playback.speeds[this.speedIndex] || 1);
    if (this.mode === 'continuous') {
      const nextHl = this._nextHighlightTime(this.playTime);
      const inHl = this._inHighlightWindow(this.playTime);
      // 跳过条件：跳过开启、非高亮窗口且距下一个高亮 > 阈值；尾部（nextHl=null）也跳过剩余比赛
      const shouldSkip = this.isSkipEnabled()
        && !inHl && (nextHl === null || (nextHl - this.playTime) > this._skipThreshold);
      if (shouldSkip) {
        if (this.skipMode === 'skip') {
          this.playTime = nextHl !== null ? nextHl : this._matchEnd; // 直接跳（尾部 → 比赛结束）
        } else {
          this.playTime += dt * speed * this.getSkipChoice(); // 快速播放（比赛时钟快跳）
        }
      } else {
        this.playTime += dt * speed; // 高亮段正常播放
      }
      if (this.playTime >= this._matchEnd) {
        this.playTime = this._matchEnd;
        this.playing = false;
      }
    } else {
      const endT = this._eventEnds[this._clipIndex] ?? this.events[this._clipIndex]?.t ?? 0;
      this.playTime = Math.min(this.playTime + dt * speed, endT + 0.1); // +0.1 余量确保播完
      if (this.playTime >= endT) {
        this.playing = false;
      }
    }
    // 根据锚点时间线更新球员/球位置（插值）
    this._updateFromTimeline();
    // 调试日志：事件切换时打 [EVENT]，周期性打球/球员位置
    if (config.debug.enabled) {
      this._frameCount = (this._frameCount || 0) + 1;
      const idx = this.currentEventIndex();
      if (this._lastLoggedEventIdx !== idx) {
        this._logEvent(idx);
        this._lastLoggedEventIdx = idx;
      }
      if (this._frameCount % config.debug.logEveryNFrames === 0) {
        this._logFrame();
      }
    }
  }

  // 调试日志：打印当前事件摘要（id + 类型 + 关键参数）
  _logEvent(idx) {
    if (idx < 0 || idx >= this.events.length) return;
    const e = this.events[idx];
    const P = config.pitch;
    let s = `[EVENT #${idx}] ${e.type}`;
    if (e.speed !== undefined) s += ` speed=${e.speed.toFixed(1)}`;
    if (e.from !== undefined) s += ` from=${e.from}`;
    if (e.to !== undefined) s += ` to=${e.to}`;
    if (e.x2 !== undefined && e.y2 !== undefined) {
      const d = Math.hypot((e.x2 - e.x) * P.lengthMeters, (e.y2 - e.y) * P.widthMeters);
      s += ` dist=${d.toFixed(1)}m`;
    }
    if (e.result !== undefined) s += ` result=${e.result}`;
    console.log(s);
  }

  // 调试日志：打印当前球位置 + 正在移动的球员
  _logFrame() {
    const d = config.debug;
    const t = this.playTime;
    if (d.logBall) {
      console.log(`[t=${t.toFixed(2)}] 球=(${this.ball.x.toFixed(4)},${this.ball.y.toFixed(4)})`);
    }
    if (d.logMovingPlayers) {
      const moving = [];
      for (const p of this._players) {
        const prev = this._prevPlayerPos.get(p.id);
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        if (Math.hypot(dx, dy) > d.moveThreshold) {
          moving.push(`${p.id}→(${p.x.toFixed(4)},${p.y.toFixed(4)})`);
        }
        // 更新 prev 快照（拷贝，避免引用同一对象）
        prev.x = p.x;
        prev.y = p.y;
      }
      if (moving.length > 0) {
        console.log(`[t=${t.toFixed(2)}] 移动球员: ${moving.join('  ')}`);
      }
    }
  }

  // 当前时刻该球员是否在移动（同 evt 内相邻锚点位置不同 → 插值移动中；
  // 跨 evt 间隙 hold → 静止）。供 micro-motion 抑制判断（P5 S3）。
  isPlayerMoving(id) {
    const arr = this._playerAnchors.get(id);
    if (!arr || arr.length < 2) return false;
    const t = this.playTime;
    let lo = 0;
    let hi = arr.length - 1;
    let pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) { pos = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (pos < 0 || pos + 1 >= arr.length) return false;
    const prev = arr[pos];
    const next = arr[pos + 1];
    return prev.evt === next.evt && (prev.x !== next.x || prev.y !== next.y);
  }

  // 当前时刻的持球者（beat.main 的 carrier）——micro-motion 抑制用（main 持球者不微动，避免人球分离）
  currentCarrier() {
    const idx = this.currentEventIndex();
    const e = this.events[idx];
    if (e && e.type === 'beat' && e.main) return e.main.subject;
    return null;
  }

  // 当前高亮事件的参与者（pass 传球者/接球者、shot 射手/门将、tackle 双方）——micro-motion 抑制用
  // （spec：高亮参与者不微动；即使静止（传球者摆腿/门将待命）也抑制）
  currentHighlightParticipants() {
    const idx = this.currentEventIndex();
    const e = this.events[idx];
    if (!e) return [];
    if (e.type === 'pass') return [e.from, e.to].filter((x) => x !== undefined && x !== null);
    if (e.type === 'shot') {
      const keeper = typeof e.subject === 'number' && e.subject <= 10 ? 21 : 0;
      return [e.subject, keeper];
    }
    if (e.type === 'tackle') return [e.subject, e.carrier ?? e.to].filter((x) => x !== undefined && x !== null);
    if (e.type === 'foul') return [e.subject, e.carrier].filter((x) => x !== undefined && x !== null);
    return [];
  }

  // 当前处于出示中的纪律牌（犯规 card 事件 + 显示窗口内）：供画面层叠加牌图标。
  // foul ~23/场、card 仅部分 → 线性扫描成本可忽略。
  activeCards() {
    const cards = [];
    const dur = config.interpretation.foul.cardShowDuration;
    for (const e of this.events) {
      if (e.type === 'foul' && (e.card === 'yellow' || e.card === 'red')) {
        if (this.playTime >= e.t && this.playTime <= e.t + dur) {
          cards.push({ x: e.x, y: e.y, card: e.card, subject: e.subject });
        }
      }
    }
    return cards;
  }

  // 按实体构建时间索引：球一组、每球员一组（timeline 已按 t 排序，分组后仍有序）
  _buildAnchorIndex() {
    this._ballAnchors = [];
    this._playerAnchors = new Map();
    for (const a of this.timeline) {
      if (a.kind === 'ball') {
        this._ballAnchors.push(a);
      } else if (a.kind === 'player' && a.id !== undefined) {
        if (!this._playerAnchors.has(a.id)) this._playerAnchors.set(a.id, []);
        this._playerAnchors.get(a.id).push(a);
      }
    }
  }

  // 由锚点插值出当前球员/球位置
  _updateFromTimeline() {
    const t = this.playTime;
    // 球：取最近的两个 ball 锚点插值
    this.ball = this._interpolateAnchors('ball', t) || this.ball;
    // 球员：逐球员取最近锚点插值（对**全量**球员做，罚下球员虽不渲染也保持内部一致）
    for (const p of this._players) {
      const pos = this._interpolateAnchors('player', t, p.id);
      if (pos) {
        p.x = pos.x;
        p.y = pos.y;
      }
    }
  }

  _interpolateAnchors(kind, t, id) {
    // 找到 kind 匹配、id 匹配（可选）的相邻锚点，按 t 插值（二分，O(log n)）。
    // continuous 模式：沿整场时间线取最近锚点插值——事件密集，prev/next 相邻即自然衔接。
    //   clip 模式：只用【当前事件】锚点（prevCur/next 限当前事件），避免跨事件泄漏；
    //   当前事件未锚定该实体时，用更早事件兜底（hold）。
    if (this.mode === 'continuous') {
      const arr = kind === 'ball' ? this._ballAnchors : this._playerAnchors.get(id);
      if (!arr || arr.length === 0) return null;
      // 二分：最后一个 t <= 目标的锚点
      let lo = 0;
      let hi = arr.length - 1;
      let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t <= t) {
          pos = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (pos === -1) return null;
      const prev = arr[pos];
      const next = pos + 1 < arr.length ? arr[pos + 1] : null;
      if (!next) return { x: prev.x, y: prev.y, h: prev.h ?? 0 }; // 末尾，停在最后锚点
      // 事件间隙（不同 evt 的相邻锚点，中间无锚点）：hold 在 prev（事件之间不滑动）
      // v2：跨拍连续由引擎保证 from(N+1)==to(N)，hold 在相同位置无视觉跳变
      if (prev.evt !== undefined && next.evt !== undefined && prev.evt !== next.evt) {
        return { x: prev.x, y: prev.y, h: prev.h ?? 0 };
      }
      const span = Math.max(next.t - prev.t, 1e-6);
      const u = Math.min(Math.max((t - prev.t) / span, 0), 1);
      return {
        x: prev.x + (next.x - prev.x) * u,
        y: prev.y + (next.y - prev.y) * u,
        h: (prev.h ?? 0) + ((next.h ?? 0) - (prev.h ?? 0)) * u,
      };
    }
    // clip 模式
    const idx = this._clipIndex;
    const arr = kind === 'ball' ? this._ballAnchors : this._playerAnchors.get(id);
    if (!arr || arr.length === 0) return null;
    let prevCur = null;
    let prevAny = null;
    let next = null;
    for (const a of arr) {
      if (a.evt > idx) continue;
      if (a.t <= t) {
        if (a.evt === idx) prevCur = a;
        prevAny = a;
      } else if (a.evt === idx && next === null) {
        next = a;
      }
    }
    if (prevCur) {
      if (!next) return { x: prevCur.x, y: prevCur.y, h: prevCur.h ?? 0 };
      const span = Math.max(next.t - prevCur.t, 1e-6);
      const u = Math.min(Math.max((t - prevCur.t) / span, 0), 1);
      return {
        x: prevCur.x + (next.x - prevCur.x) * u,
        y: prevCur.y + (next.y - prevCur.y) * u,
        h: (prevCur.h ?? 0) + ((next.h ?? 0) - (prevCur.h ?? 0)) * u,
      };
    }
    if (prevAny) return { x: prevAny.x, y: prevAny.y };
    return null;
  }

  togglePlay() {
    if (this.mode === 'continuous') {
      // 若已播到比赛结束，再点播放 → 整场重播
      if (!this.playing && this.playTime >= this._matchEnd) {
        this.playTime = 0;
        this._updateFromTimeline();
      }
    } else {
      // clip 模式：若已播完，再点播放 → 重启当前片段
      if (!this.playing && this.playTime >= this._eventEnds[this._clipIndex]) {
        this._initToEvent(this._clipIndex);
      }
    }
    this.playing = !this.playing;
  }

  // 重播：continuous 从整场开头播放；clip 从当前事件起点播放
  replayCurrent() {
    if (this.mode === 'continuous') {
      this.playTime = 0;
      this._updateFromTimeline();
      this.playing = true;
    } else if (this._initToEvent(this._clipIndex)) {
      this.playing = true;
    }
    return this.playing;
  }

  // 当前事件 id：continuous 从 playTime 反推（处于哪个事件的时间窗）；clip 用显式索引
  currentEventIndex() {
    if (this.mode === 'continuous') {
      return this._indexAtTime(this.playTime);
    }
    return this._clipIndex;
  }

  // 给定比赛时刻，返回该时刻处于的事件索引（最后一个 t <= playTime 的事件；开始前 → 0）
  _indexAtTime(t) {
    let idx = 0;
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].t <= t + 1e-6) idx = i;
      else break;
    }
    return idx;
  }

  get eventCount() {
    return this.events.length;
  }

  // 跳到指定事件：continuous 把 playTime 设到该事件 t（从该事件继续连续播放）；clip 切到该事件初始状态。
  // 两种模式都暂停（与控件 notice 一致），播放状态由用户点"播放"恢复。
  jumpToEvent(index) {
    if (index < 0 || index >= this.events.length) return false;
    if (this.mode === 'continuous') {
      this._clipIndex = index;
      this.playTime = this.events[index].t;
      this.playing = false;
      this._lastLoggedEventIdx = -1;
      this._updateFromTimeline();
      return true;
    }
    return this._initToEvent(index);
  }

  // 上一/下一个事件
  stepEvent(delta) {
    const cur = this.currentEventIndex();
    const next = Math.max(0, Math.min(this.events.length - 1, cur + delta));
    return this.jumpToEvent(next);
  }

  // 跳到指定比赛时刻（进度条拖动用）：更新 playTime 并刷新画面，暂停。
  seekTo(t) {
    this.playTime = Math.max(0, Math.min(t, this._matchEnd));
    this.playing = false;
    this._lastLoggedEventIdx = -1;
    this._updateFromTimeline();
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % config.playback.speeds.length;
    return config.playback.speeds[this.speedIndex];
  }

  getSpeed() {
    return config.playback.speeds[this.speedIndex];
  }

  // 当前高亮段播放速率（比赛秒 / 真实秒）：基速 × 倍速
  getPlaybackRate() {
    return this._baseSpeed * (config.playback.speeds[this.speedIndex] || 1);
  }

  // 比赛总时长（秒）：进度条分母/seek 上限用
  get matchEnd() {
    return this._matchEnd;
  }

  getProgress() {
    // continuous：整场进度（0~1）；clip：当前事件片段内进度（0~1）
    if (this.mode === 'continuous') {
      if (this._matchEnd <= 0) return 0;
      return Math.min(Math.max(this.playTime / this._matchEnd, 0), 1);
    }
    const idx = this._clipIndex;
    if (idx < 0 || idx >= this.events.length) return 0;
    const startT = this.events[idx].t;
    const endT = this._eventEnds[idx] ?? startT;
    const span = endT - startT;
    if (span <= 0) return 1;
    return Math.min(Math.max((this.playTime - startT) / span, 0), 1);
  }
}

// 从事件流构造 Game（方便 app.js 一行调用）
export function createGame(eventStream) {
  const { events, lineup } = parseEventStream(eventStream);
  return new Game(events, lineup);
}
