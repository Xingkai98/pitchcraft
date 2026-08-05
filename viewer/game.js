// 游戏循环：消费事件流 + 锚点时间线，推进播放时刻，计算每帧的球员/球位置
// 输入：事件流（含 lineup），输出：每帧 { players, ball }（归一化坐标）
//
// 解耦模式（当前用途）：每个事件是一个"独立片段"，默认不自动播放。
// 选中事件 → 显示该事件初始状态（球员/球在该事件起点，无过渡）。
// 点播放 → 只在该事件的时间窗口内推进（从事件 t 到该事件结束时间），播完停。

import { config } from './config.js';
import { buildTimeline } from './interpretation.js';
import { parseEventStream } from './protocol.js';

// 播放器状态机
export class Game {
  constructor(events, lineup) {
    this.events = events;
    this.lineup = lineup; // 初始站位 [{id, team, x, y}]
    // 当前每帧状态：球员位置（含初始站位）+ 球位置
    this.players = (lineup || []).map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y }));
    this.ball = { x: 0.5, y: 0.5 };
    // 播放控制
    this.playing = false; // 默认不自动播放（解耦模式）
    this.speedIndex = 0; // 0 -> 1x, 1 -> 2x, 2 -> 4x
    this.playTime = 0; // 当前播放的比赛秒
    this.timeline = buildTimeline(events); // 锚点时间线
    this._currentIndex = 0; // 当前选中事件索引
    // 每个事件的结束时间：该事件最后一个锚点的 t + 余量，作为独立片段时长
    this._eventEnds = this._computeEventEnds(events);
    // 初始化到第一个事件的初始状态
    this._initToEvent(0);
    this._prevPlayerPos = new Map(); // 调试：球员上一帧位置快照
    for (const p of this.players) {
      this._prevPlayerPos.set(p.id, { x: p.x, y: p.y });
    }
    this._lastLoggedEventIdx = -1; // 调试：上次日志的事件索引
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
  _initToEvent(index) {
    if (index < 0 || index >= this.events.length) return false;
    this._currentIndex = index;
    this.playTime = this.events[index].t;
    this.playing = false;
    this._lastLoggedEventIdx = -1; // 切换事件后，下次 step 会打 [EVENT] 日志
    this._updateFromTimeline();
    return true;
  }

  // 推进播放：dt 为真实秒。只在当前事件片段内推进，播完自动停。
  step(dt) {
    if (!this.playing) return;
    const speed = config.playback.speeds[this.speedIndex] || 1;
    const endT = this._eventEnds[this._currentIndex] ?? this.events[this._currentIndex]?.t ?? 0;
    // 推进，但不超过当前事件结束时间（独立片段，不进入下一个动作）
    this.playTime = Math.min(this.playTime + dt * speed, endT + 0.1); // +0.1 余量确保播完
    // 根据锚点时间线更新球员/球位置（插值）
    this._updateFromTimeline();
    // 若到达片段末尾，停止播放
    if (this.playTime >= endT) {
      this.playing = false;
    }
    // 调试日志：事件切换时打 [EVENT]，周期性打球/球员位置
    if (config.debug.enabled) {
      this._frameCount = (this._frameCount || 0) + 1;
      if (this._lastLoggedEventIdx !== this._currentIndex) {
        this._logEvent(this._currentIndex);
        this._lastLoggedEventIdx = this._currentIndex;
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
      for (const p of this.players) {
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

  // 由锚点插值出当前球员/球位置
  _updateFromTimeline() {
    const t = this.playTime;
    // 球：取最近的两个 ball 锚点插值
    this.ball = this._interpolateAnchors('ball', t) || this.ball;
    // 球员：逐球员取最近锚点插值
    for (const p of this.players) {
      const pos = this._interpolateAnchors('player', t, p.id);
      if (pos) {
        p.x = pos.x;
        p.y = pos.y;
      }
    }
  }

  _interpolateAnchors(kind, t, id) {
    // 找到 kind 匹配、id 匹配（可选）的相邻锚点
    let prev = null;
    let next = null;
    for (const a of this.timeline) {
      if (a.kind !== kind) continue;
      if (id !== undefined && a.id !== id) continue;
      if (a.t <= t) prev = a;
      else if (next === null) next = a;
    }
    if (!prev) return null;
    if (!next) return { x: prev.x, y: prev.y };
    // 事件间隙：prev/next 属于不同事件 → 停在 prev 位置，事件之间不滑动。
    // （同一事件内连续运动仍插值：带球、射门飞行、抢断逼近）
    if (prev.evt !== undefined && next.evt !== undefined && prev.evt !== next.evt) {
      return { x: prev.x, y: prev.y };
    }
    // 线性插值（第一版简单）
    const span = Math.max(next.t - prev.t, 1e-6);
    const u = Math.min(Math.max((t - prev.t) / span, 0), 1);
    return {
      x: prev.x + (next.x - prev.x) * u,
      y: prev.y + (next.y - prev.y) * u,
    };
  }

  togglePlay() {
    // 若已播完（playTime >= 事件结束），再点播放 → 重启当前片段
    if (!this.playing && this.playTime >= this._eventEnds[this._currentIndex]) {
      this._initToEvent(this._currentIndex);
    }
    this.playing = !this.playing;
  }

  // 重播当前动作：回到当前事件起点并开始播放
  replayCurrent() {
    if (this._initToEvent(this._currentIndex)) {
      this.playing = true;
    }
    return this.playing;
  }

  // 事件 id = 数组索引。当前选中事件（解耦模式下由 _currentIndex 维护，不从 playTime 反推）
  currentEventIndex() {
    return this._currentIndex;
  }

  get eventCount() {
    return this.events.length;
  }

  // 跳到指定事件（id = 索引）：切换到该事件的初始状态（无过渡，直接刷新），并暂停
  jumpToEvent(index) {
    return this._initToEvent(index);
  }

  // 上一/下一个事件（基于显式维护的索引）
  stepEvent(delta) {
    const cur = this._currentIndex !== undefined ? this._currentIndex : 0;
    const next = Math.max(0, Math.min(this.events.length - 1, cur + delta));
    return this._initToEvent(next);
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % config.playback.speeds.length;
    return config.playback.speeds[this.speedIndex];
  }

  getSpeed() {
    return config.playback.speeds[this.speedIndex];
  }

  getProgress() {
    // 当前事件片段内的进度（0~1）
    const idx = this._currentIndex;
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
