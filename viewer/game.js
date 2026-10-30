// 游戏循环：消费事件流 + 锚点时间线，推进播放时刻，计算每帧的球员/球位置
// 输入：事件流（含 lineup），输出：每帧 { players, ball }（归一化坐标）
//
// 两种播放模式：
//   continuous（默认）：整场连续播放。playTime 从事件流开头走到结尾，播完当前事件
//     自动切下一个；事件之间由 off_ball_run（无球跑位）锚点填满，画面持续有动作。
//   clip：每个事件是"独立片段"，选中事件 → 显示初始状态，点播放 → 只在该事件窗口推进，播完停。
//     （保留为调试/单事件点播工具。）

import { config } from './config.js?v=20261029-1';
import { buildTimeline } from './interpretation.js?v=20261029-1';
import { parseEventStream } from './protocol.js';

// 每个锚点是否为其事件（`evt`）的**首 / 末**锚点。
// 同一事件的锚点在全局按 `t` 排序后**可能被别的事件"插队"**：如一次长传飞行跨过下一拍
// tick 时，传球事件的**末端**锚点（t ≈ 起飞+飞行时长）会排在下一拍 beat 的**起点**锚点
// （t = tick）之后——此时「相邻锚点 evt 不同」并不等于「处在事件间的间隙」（`prev` 所在
// 事件其实还没演完）。故用「每个 evt 的首 / 末索引」判定，而非只看相邻锚点。
function eventBoundaryFlags(arr) {
  const first = new Map();
  const last = new Map();
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i].evt;
    if (!first.has(e)) first.set(e, i);
    last.set(e, i);
  }
  return {
    isFirst: arr.map((a, i) => first.get(a.evt) === i),
    isLast: arr.map((a, i) => last.get(a.evt) === i),
  };
}

// ── R3 T1：球员路径纹理（viewer 层合成「拍内持续微调」，事件流零改动）───────────────
// 实测（22 场真实 tracking，0.2s 轨、运动步，24s 窗逐窗）：真实球员相邻步转角中位 3.0°、
// 1s 窗偏离弦 p50 0.059m / p75 0.120m —— 拍内也在持续微调方向；引擎拍内是直线
// （转角中位 1.1°、偏离弦 p50 0.027m），90s 轨迹图因此是「长直线 + 硬折角」的多边形网。
// 做法：段内加**垂直弦的弓形偏移**（sin²(π·u) 包络：两端值与斜率都为 0 ⇒ 锚点位置与
// 锚点切向逐位不变，与 C5 同一承诺），弓的符号按 blockSec=3s 分块哈希（相邻 2–3 拍同向
// ⇒ 跨拍走小弧，而非每拍一摆）；幅度按真实弦偏离 p50 定（0.12m ⇔ 0.061m vs 真实 0.059m，
// 同幅度下 0.2s 转角中位 2.99° vs 真实 3.02°）。确定性哈希，不依赖播放方式/帧率。
// 球不加：球路是物理量（飞行/滚动），纹理只属于球员跑动。
export const PLAYER_TEXTURE = { ampM: 0.12, blockSec: 3.0 };

// 确定性哈希 → [-1,1]（整数格点；同 (id,k,axis) 永远同值）。
function textureHash01(id, k, axis) {
  let h = (Math.imul(id | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(axis | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

// 每个事件的结束时间：该事件所有锚点里最大的 t（无锚点则回落事件自身的 t）。
function computeEventEnds(events, timeline) {
  const ends = new Array(events.length);
  // 按 evt 索引收集每个事件的最大锚点 t
  const maxByEvt = new Map();
  for (const a of timeline) {
    const cur = maxByEvt.get(a.evt) ?? -Infinity;
    if (a.t > cur) maxByEvt.set(a.evt, a.t);
  }
  for (let i = 0; i < events.length; i++) {
    ends[i] = maxByEvt.get(i) ?? events[i].t;
  }
  return ends;
}

// 静态索引：由 `(events, lineup, mode)` 与**建索引时刻读到的 `config` 常量**决定，
// **与播放时刻 `t` 无关**。
//
// 为什么单独抽出来（#154）：`Game` 构造的成本几乎全在这里——整场锚点时间线
// （P3.5 起 ~2900 事件数万锚点）+ 按实体分组的时间索引 + 每个事件的结束时间。
// 本仓的整场滑窗扫描（`tools/spacing-sweep.mjs`）对**同一份**事件流逐窗重建它，
// 实测占逐窗成本的 **91.5%**（`openspec/changes/p154-game-index-cache/design.md` §D1）。
// 把它算成**可复用的纯计算结果**：每份事件流算一次，逐窗传给
// `new Game(events, lineup, mode, { index })`。
//
// ⚠️ **`config` 是被烘进来的**（如实写，勿当「只依赖三个入参」）：`buildTimeline` 会读
// `config.interpretation.*` / `config.defaults.*` / `config.pitch.*`（实测活读取 5 个叶子：
// `shot.keeperReactDelay`、`tackle.deflectSpeed`、`defaults.runSpeed`、`pitch.lengthMeters`、
// `pitch.widthMeters`——#154 审阅 P2-4 实测）。同源守卫（身份比较，见构造函数）**看不见
// config 变化**：在「建索引」与「构造 `Game`」之间改 config，守卫会放行而索引已陈旧。
// 当前调用方不触碰这条边界（`tools/spacing-sweep-core.mjs` 在模块加载时设一次 config 后
// 不再改；App 侧不传索引），故如实记为**已知边界**而非缺口。
//
// 契约：本函数只读输入，返回对象的任何字段**在构造后都不被 `Game` 写入**
// （守卫见 §D7 的「索引在整轮扫描后逐位不变」用例）——故可安全跨窗复用。
export function buildGameIndex(events, lineup, mode = 'continuous') {
  const m = mode === 'clip' ? 'clip' : 'continuous';
  const timeline = buildTimeline(events, m); // 锚点时间线（continuous 启用 carry-beat 丢弃）
  // 按实体分组的时间索引（球一组、每球员一组）。timeline 已按 t 排序，分组后仍有序。
  const ballAnchors = [];
  const playerAnchors = new Map();
  for (const a of timeline) {
    if (a.kind === 'ball') {
      ballAnchors.push(a);
    } else if (a.kind === 'player' && a.id !== undefined) {
      if (!playerAnchors.has(a.id)) playerAnchors.set(a.id, []);
      playerAnchors.get(a.id).push(a);
    }
  }
  // 事件边界标记（供 `_interpolateAnchors` 区分「事件间真间隙」与「事件重叠」）。
  const ballBounds = eventBoundaryFlags(ballAnchors);
  const playerBounds = new Map();
  for (const [id, arr] of playerAnchors) playerBounds.set(id, eventBoundaryFlags(arr));
  // 比赛总时长（continuous 播到这就结束）：取最后锚点 t（保证尾部动画不被截断）
  const matchEnd = timeline.length > 0
    ? Math.max(events[events.length - 1]?.t ?? 0, timeline[timeline.length - 1].t)
    : 0;
  return {
    events,
    lineup,
    mode: m,
    timeline,
    ballAnchors,
    playerAnchors,
    ballBounds,
    playerBounds,
    eventEnds: computeEventEnds(events, timeline),
    matchEnd,
  };
}

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
    // 静态索引（timeline / 锚点索引 / 每事件结束时刻 / 比赛总时长）：只依赖 (events, lineup,
    // mode) 与建索引时刻的 config 常量，与 t 无关。默认**每次新建**（App 与其它单次构造路径
    // = 原行为，逐位不变）；调用方可传一份 `buildGameIndex` 算好的 `opts.index` 复用
    // （整场滑窗扫描逐窗构造：同一份事件流下这块是逐窗成本的主体，见 #154 §D1）。
    const index = opts.index ?? buildGameIndex(events, lineup, this.mode);
    // 缓存复用必须满足的前提：索引与本次的事件流/站位/模式同源。身份比较是 O(1)，
    // 且能挡住唯一现实的误用（把某条事件流的索引喂给另一条）——静默用错索引会产出
    // 「看起来正常但错」的位置与 finding，故这里**报错**而不是回落重建。
    if (index.events !== events || index.lineup !== lineup || index.mode !== this.mode) {
      throw new Error(
        'Game: opts.index 与本次构造的 (events, lineup, mode) 不同源——静态索引不得跨事件流复用'
      );
    }
    this.timeline = index.timeline; // 锚点时间线（continuous 启用 carry-beat 丢弃）
    this._ballAnchors = index.ballAnchors; // 按实体分组的时间索引（P3.5：数万锚点，线性扫描会卡）
    this._playerAnchors = index.playerAnchors;
    this._ballBounds = index.ballBounds;
    this._playerBounds = index.playerBounds;
    this._eventEnds = index.eventEnds; // 每事件的结束时刻（该事件最后一个锚点的 t）
    this._matchEnd = index.matchEnd; // 比赛总时长（continuous 播到这就结束；取最后锚点 t，尾部动画不被截断）
    // 罚下集合（红牌 / 二黄升级）。引擎 `apply_card` 把二黄升级也记为 `card:"red"`，故
    // `foul` 的 `card:"red"` 是罚下的唯一对外信号。罚下后引擎不再发射该球员的任何锚点
    // （spec：不得进 movers / 不得持球），但时间线会**保持其最后锚点**——若不在渲染层
    // 排除，红牌球员会以「幽灵」永远杵在场上（P34 审阅 R3-P2-3；同 `derive-audit-features`
    // 的 `sentOffTimes`，两处口径一致）。
    // id → 罚下时刻（该时刻之后才离场；时刻之前仍在场上，须正常渲染）。
    // 不进静态索引：它是**可变 Map**，逐窗重建（整场一遍线性扫描，成本可忽略），
    // 共享可变结构得不偿失。
    this.sentOffAt = new Map();
    for (const e of events) {
      if (e && e.type === 'foul' && e.card === 'red' && typeof e.subject === 'number') {
        if (!this.sentOffAt.has(e.subject)) this.sentOffAt.set(e.subject, e.t);
      }
    }
    this._clipIndex = 0; // clip 模式：当前选中事件索引
    // P7：跳过机制——高亮段正常播放（baseSpeed=1，球员真实速度），非精彩段（间隙 > 阈值）快进/跳过。
    // opts.baseSpeed 可覆盖基速（测试用 1x）；opts.skipThreshold 可覆盖间隙阈值（测试用 Infinity 关闭跳过）。
    this._baseSpeed = opts.baseSpeed ?? 1;
    this._skipThreshold = opts.skipThreshold ?? config.playback.skipThresholdSeconds;
    // R3 T1：球员纹理幅度（米）。默认来自 PLAYER_TEXTURE（已按真实转角分布校准）；
    // opts 仅给探针做标定扫描，生产路径不传。
    this._textureAmpM = opts.textureAmpM ?? PLAYER_TEXTURE.ampM;
    this._textureBlockSec = opts.textureBlockSec ?? PLAYER_TEXTURE.blockSec;
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

  // 高亮事件在时间轴上的有效窗口终点。
  // pass/shot 的 beat 在**同 tick 之后**（会遮蔽 currentEventIndex），tackle 的 beat 在同 tick
  // **之前**（不遮蔽），foul **不产 beat**（无锚点 → _eventEnds 回落 e.t，窗口零长度）——
  // foul 的语义窗口是纪律牌显示时长，故显式延长，避免抑制在犯规笛响瞬间失效。
  _highlightEnd(i) {
    const e = this.events[i];
    const end = this._eventEnds[i] ?? e.t;
    if (e.type === 'foul') return Math.max(end, e.t + config.interpretation.foul.cardShowDuration);
    return end;
  }

  // 当前覆盖 playTime 的高亮事件索引（无则 -1）。
  // 必须按「事件窗口 [t, _highlightEnd] 覆盖 playTime」回溯查找，而非直接取 currentEventIndex()
  // （后者对 pass/shot 恒落在同 tick 的 beat 上 → 参与者集恒为空；实测 98% 高亮帧）。
  _activeHighlightIndex() {
    const t = this.playTime;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t > t + 1e-6) continue;
      if (e.t < t - 12.5) break; // 高亮演绎理论上限 ≈12.5s（球场对角 125.1m ÷ pass 最低速 10 m/s = 12.5096s；实测最长 5.5s）；_eventEnds 非单调，不能按 end 提前退出
      if (e.type !== 'pass' && e.type !== 'shot' && e.type !== 'tackle' && e.type !== 'foul') continue;
      if (this._highlightEnd(i) >= t - 1e-6) return i;
    }
    return -1;
  }

  // 当前高亮事件的参与者（pass 传球者/接球者、shot 射手/门将、tackle 双方）——micro-motion 抑制用
  // （spec：高亮参与者不微动；即使静止（传球者摆腿/门将待命）也抑制）
  currentHighlightParticipants() {
    const idx = this._activeHighlightIndex();
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
      // 相邻锚点 evt 不同 → 可能是「事件间间隙」也可能是「事件重叠」（见 eventBoundaryFlags）。
      //   真间隙（prev 是其事件末锚点、next 是其事件首锚点）：hold 在 prev（事件之间不滑动）；
      //     v2 跨拍连续由引擎保证 from(N+1)==to(N)，hold 在相同位置无视觉跳变。
      //   重叠（prev 所在事件尚未演完，如长传飞行跨过下一拍 tick）：**不 hold**——否则球冻在
      //     飞行中段、待下一条锚点生效时瞬移（e2e-v2 实测 maxBallJump≈0.12）；照常插值延续本事件轨迹。
      if (prev.evt !== undefined && next.evt !== undefined && prev.evt !== next.evt) {
        const bounds = kind === 'ball' ? this._ballBounds : this._playerBounds.get(id);
        if (bounds && bounds.isLast[pos] && bounds.isFirst[pos + 1]) {
          return { x: prev.x, y: prev.y, h: prev.h ?? 0 };
        }
      }
      const span = Math.max(next.t - prev.t, 1e-6);
      const u = Math.min(Math.max((t - prev.t) / span, 0), 1);
      // C5（R2）：**球员**锚点转角平滑（跨拍 Catmull–Rom）。1s 拍链上线性插值让每名球员的
      // 轨迹在拍边界出现硬折角（盲测判据「直角阶梯/电路板走线」的形态来源之一）；真实球员
      // 因惯性会在转角处走弧。平滑只在**均匀拍链**上启用（两侧邻锚点时间跨度都接近本段），
      // 锚点时刻位置不变（曲线过锚点），中段最多外扩约 1/6 邻段（≈0.7m）。
      // 球不平滑：球路是物理量（飞行/滚动），平滑会歪曲球的真实轨迹。
      if (kind === 'player') {
        const smooth = this._smoothNeighborPositions(arr, pos, prev, next);
        if (smooth) {
          const { p0, p3 } = smooth;
          const u2 = u * u; const u3 = u2 * u;
          const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * u
            + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
          return this._applyTexture(kind, id, t, u, {
            x: Math.min(Math.max(cr(p0.x, prev.x, next.x, p3.x), 0), 1),
            y: Math.min(Math.max(cr(p0.y, prev.y, next.y, p3.y), 0), 1),
            h: 0,
          }, prev, next);
        }
      }
      return this._applyTexture(kind, id, t, u, {
        x: prev.x + (next.x - prev.x) * u,
        y: prev.y + (next.y - prev.y) * u,
        h: (prev.h ?? 0) + ((next.h ?? 0) - (prev.h ?? 0)) * u,
      }, prev, next);
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

  // R3 T1：段内**垂直弦**的弓形偏移（归一化坐标）。sin²(π·u) 包络：两端值为 0 且斜率 0
  // ⇒ 锚点时刻位置与切向都不变。弓的符号按 blockSec 分块哈希 → 相邻 2–3 拍同向（跨拍走弧）。
  _textureOffset(id, u, prev, next) {
    const amp = this._textureAmpM;
    if (!(amp > 0)) return null;
    const L = config.pitch.lengthMeters; const W = config.pitch.widthMeters;
    const vx = (next.x - prev.x) * L; const vy = (next.y - prev.y) * W;
    const len = Math.hypot(vx, vy);
    if (!(len > 1e-6)) return { dx: 0, dy: 0 };
    const block = Math.floor(prev.t / this._textureBlockSec);
    const sign = textureHash01(id, block, 7);
    const env = Math.sin(Math.PI * u) ** 2;
    const offM = amp * env * sign;
    return { dx: (offM * (-vy / len)) / L, dy: (offM * (vx / len)) / W };
  }

  // 只对球员叠纹理；球/无球锚点（hold 分支）不动。
  _applyTexture(kind, id, t, u, pos, prev, next) {
    if (kind !== 'player') return pos;
    const off = this._textureOffset(id, u, prev, next);
    if (!off) return pos;
    return {
      x: Math.min(Math.max(pos.x + off.dx, 0), 1),
      y: Math.min(Math.max(pos.y + off.dy, 0), 1),
      h: pos.h,
    };
  }

  // C5 辅助：为 Catmull–Rom 找相邻的「拍前 / 拍后」锚点（严格早于 prev.t / 晚于 next.t，
  // 跳过拍边界同时间戳的重复锚点）。返回 null = 不满足均匀拍链条件（退回线性）。
  //
  // ⚠️ 2 Hz 已知限制（P2，未改）：下面的 [0.5, 1.5] s 窗口是 1 Hz 标定的。beat 间距 0.5 s
  // 恰好卡在下界（含，仍平滑），而 fill-to-tick 的传球锚点间距 0.475 s 落在窗外 → 这些段
  // 静默退回线性插值。改窗口会改拍内纹理，必须配视觉验收（本轮未做）；先如实记录。
  _smoothNeighborPositions(arr, pos, prev, next) {
    const s1 = next.t - prev.t;
    if (!(s1 >= 0.5 && s1 <= 1.5)) return null;
    // 拍前：最后一个 t 严格小于 prev.t 的锚点（不含同时间戳重复点）
    let lo = 0; let hi = arr.length - 1; let p0i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < prev.t - 1e-6) { p0i = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    // 拍后：第一个 t 严格大于 next.t 的锚点
    lo = 0; hi = arr.length - 1; let p3i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t > next.t + 1e-6) { p3i = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (p0i < 0 || p3i < 0) return null;
    const p0 = arr[p0i]; const p3 = arr[p3i];
    const s0 = prev.t - p0.t; const s3 = p3.t - next.t;
    // 只在均匀拍链上平滑（高亮飞行/重开等非均匀段退回线性，避免把飞行弧线改形）
    if (!(s0 >= 0.5 && s0 <= 1.5 && s3 >= 0.5 && s3 <= 1.5)) return null;
    if (s0 > 2.2 * s1 || s3 > 2.2 * s1 || s1 > 2.2 * Math.min(s0, s3)) return null;
    return { p0, p3 };
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
