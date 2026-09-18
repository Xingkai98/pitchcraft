// 真实比赛对照播放器：把 tracking 帧序列（tools/convert-tracking-to-frames.mjs 的产物）
// 按时间插值成每帧的 { players, ball }，与引擎比赛共用 renderer / 同一块球场。
//
// 定位：这是"参照物"，不是引擎的一部分。它绕过事件流与演绎层——tracking 数据本身就是
// 逐帧位置，直接插值渲染即可。设计说明见 .scratch/notes/real-match-reference.md。
//
// 与 Game 的接口差异：Game 消费事件流、有 clip/continuous 模式、事件导航、micro-motion；
// TrackingPlayer 只做"按时间插值 + 播放/暂停/拖动"。刻意保持最小，避免污染引擎侧逻辑。

// 帧序列 → 可直接渲染的状态。
export class TrackingPlayer {
  constructor(data) {
    if (!data || !Array.isArray(data.frames) || data.frames.length === 0) {
      throw new Error('tracking 数据为空或格式不对（需要 { meta, frames }）');
    }
    this.meta = data.meta || {};
    this.frames = data.frames;
    this.playing = false;
    this.playTime = this.frames[0].t;
    // 每帧的球员 id 集合固定为 0-21（转换器保证），预建一次避免每帧重建
    this._ids = Array.from({ length: 22 }, (_, i) => i);
    this._players = this._ids.map((id) => ({ id, team: id <= 10 ? 'home' : 'away', x: 0.5, y: 0.5 }));
    this.ball = { x: 0.5, y: 0.5 };
    this._ballFill = null;
    this._hasBall = false; // 该帧及之前是否观测到过球（见 ballVisible）
    // 每帧的「最后已知位置」：某球员在该帧缺失时用它停住，而不是让圆点凭空消失或
    // 跳回原点（tracking 不会告诉我们谁被罚下，保持原位是保守且不误导的选择）。
    // 预计算成 lastKnownAt[帧号][球员]，让画面只由帧号决定——若改用播放路径累积，
    // 「跳着拖进度条」和「顺着播」在缺帧处会给出不同画面，观察工具不能有这种歧义。
    this._buildLastKnown();
    this._update();
  }

  _buildLastKnown() {
    const n = this.frames.length;
    const at = new Array(n);
    const ballAt = new Array(n); // 同球员：第 i 帧及之前最后一次球观测
    const running = new Array(22).fill(null);
    let runningBall = null;
    for (let i = 0; i < n; i += 1) {
      const fr = this.frames[i];
      for (let k = 0; k < 22; k += 1) if (fr.players[k]) running[k] = fr.players[k];
      if (fr.ball) runningBall = fr.ball;
      at[i] = running.slice();
      ballAt[i] = runningBall;
    }
    this._lastKnownAt = at;
    this._lastKnownBallAt = ballAt;
  }

  get startTime() { return this.frames[0].t; }
  get endTime() { return this.frames[this.frames.length - 1].t; }
  get matchEnd() { return this.endTime; }

  // 当前帧是否用了推断的球位置（缺球补全）：数字 = 推断的持球者 id，"hold" = 沿用上一位置
  get ballFilled() { return this._ballFill; }

  // 此刻是否有球的已知位置（该帧及之前至少观测到过一次球）。
  // 为 false 时不该渲染球——渲染层若照画会把默认值 (0.5,0.5) 当成真球位，误导观察。
  get ballVisible() { return this._hasBall; }

  // 二分找最后一个 t <= target 的帧
  _indexAt(t) {
    const f = this.frames;
    let lo = 0;
    let hi = f.length - 1;
    let pos = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].t <= t) { pos = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return pos;
  }

  _update() {
    const t = this.playTime;
    const i = this._indexAt(t);
    const lastKnown = this._lastKnownAt[i];
    const lastKnownBall = this._lastKnownBallAt[i];
    const a = this.frames[i];
    const b = i + 1 < this.frames.length ? this.frames[i + 1] : null;
    const span = b ? b.t - a.t : 0;
    const u = b && span > 1e-6 ? Math.min(Math.max((t - a.t) / span, 0), 1) : 0;

    for (let k = 0; k < 22; k += 1) {
      const pa = a.players[k];
      const pb = b ? b.players[k] : null;
      const p = this._players[k];
      if (pa && pb) {
        p.x = pa[0] + (pb[0] - pa[0]) * u;
        p.y = pa[1] + (pb[1] - pa[1]) * u;
        p.visible = true;
      } else {
        // 当前帧缺该球员（换人或单帧噪声）：用「此刻之前」的最后已知位置停住。
        // 刻意不回退到下一帧——那是未来位置，会让圆点先跳到还没发生的地方，
        // 而且会让「跳过中间帧直达此刻」与「顺着播到此刻」给出不同画面。
        const last = pa || lastKnown[k];
        if (last) {
          p.x = last[0];
          p.y = last[1];
          p.visible = true;
        } else {
          p.visible = false; // 该帧之前从未出现过
        }
      }
    }

    // 球与球员同策略：只用当前帧与**过去**的观测，不回退到下一帧。
    // 曾写成 ba 为空就用 bb——那会让球在 t 时刻出现在 t+1 才该到的位置（借未来帧），
    // 球在缺球段结束时提前 0.2s 瞬移到下一观测点。与球员侧「刻意不回退到下一帧」的
    // 原则保持一致，画面才只由「此刻及之前」决定。
    //
    // 可见性（_hasBall）也只由帧号推导，不能靠播放路径累积：否则「直接 seek 到第 5 帧」
    // 会因为没经过第 3 帧而判成"没见过球"，与顺着播到第 5 帧给出不同画面。
    const ba = a.ball;
    const bb = b ? b.ball : null;
    this._hasBall = lastKnownBall != null;
    if (ba && bb) {
      this.ball.x = ba[0] + (bb[0] - ba[0]) * u;
      this.ball.y = ba[1] + (bb[1] - ba[1]) * u;
    } else if (ba) {
      this.ball.x = ba[0];
      this.ball.y = ba[1];
    } else if (lastKnownBall) {
      // 当前帧无球观测：停在最后一次已知位置（不借未来帧）
      this.ball.x = lastKnownBall[0];
      this.ball.y = lastKnownBall[1];
    } else {
      // 该帧及之前从未观测到球：重置为默认值（由 ballVisible=false 提示渲染层不要画）。
      // 必须显式重置——否则从"有球"的帧倒回"还没球"的帧时，坐标会残留未来值，
      // 违反「画面只由帧号决定」。
      this.ball.x = 0.5;
      this.ball.y = 0.5;
    }
    // 补全标记取当前帧（u 跨帧时以起始帧为准，避免闪烁）
    this._ballFill = a.ballFill !== undefined ? a.ballFill : null;
    // 位置未定的球员（visible=false）不参与渲染
    this.players = this._players.filter((p) => p.visible);
  }

  // 推进：dt 为真实秒（与引擎比赛同样原速播放）。
  // 帧尖峰钳制到 0.1s 且丢弃超出部分——刻意与 Game.step 逐字一致：切标签页/GC 后
  // 首帧 dt 可能是几十秒，若不钳制会一口气快进掉整段内容，而这恰恰是观察工具最不能
  // 丢的东西。两侧行为一致，并排对照才不会被播放器差异干扰。
  step(dt) {
    if (!this.playing) return;
    dt = Math.min(dt, 0.1);
    this.playTime += dt;
    if (this.playTime >= this.endTime) {
      this.playTime = this.endTime;
      this.playing = false;
    }
    this._update();
  }

  togglePlay() {
    if (!this.playing && this.playTime >= this.endTime) this.playTime = this.startTime;
    this.playing = !this.playing;
  }

  replay() {
    this.playTime = this.startTime;
    this.playing = true;
    this._update();
  }

  seekTo(t) {
    this.playTime = Math.max(this.startTime, Math.min(t, this.endTime));
    this.playing = false;
    this._update();
  }

  getProgress() {
    const span = this.endTime - this.startTime;
    if (span <= 0) return 0;
    return Math.min(Math.max((this.playTime - this.startTime) / span, 0), 1);
  }
}

// 从已 fetch 的 JSON 文本构造（供 app.js 一行调用）
export function createTrackingPlayer(jsonText) {
  return new TrackingPlayer(JSON.parse(jsonText));
}
