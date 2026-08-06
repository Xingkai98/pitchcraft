// Mock 事件流（P0 开发用）：不依赖 Rust 引擎，先让画面层可跑可测。
// 当 engine.wasm 未就绪时，app 可用此数据替代 simulate()。
// 生产用引擎产出的真实事件流。

export function mockEventStream() {
  // 22 个球员初始站位（home 0-10 左半场，away 11-21 右半场）
  const lineup = [];
  const homeRows = [
    [0, 0.02, 0.5], [1, 0.18, 0.3], [2, 0.20, 0.5], [3, 0.18, 0.7],
    [4, 0.40, 0.25], [5, 0.42, 0.5], [6, 0.40, 0.75],
    [7, 0.62, 0.15], [8, 0.62, 0.85], [9, 0.68, 0.5], [10, 0.55, 0.5],
  ];
  const awayRows = [
    [21, 0.98, 0.5], [20, 0.82, 0.3], [19, 0.80, 0.5], [18, 0.82, 0.7],
    [17, 0.60, 0.25], [16, 0.58, 0.5], [15, 0.60, 0.75],
    [14, 0.38, 0.15], [13, 0.38, 0.85], [12, 0.32, 0.5], [11, 0.45, 0.5],
  ];
  for (const [id, x, y] of homeRows) lineup.push({ id, x, y });
  for (const [id, x, y] of awayRows) lineup.push({ id, x, y });

  return [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup },
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    // 回传
    { t: 3, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.45, y2: 0.5, speed: 8, lead: 0.1, result: 'success' },
    { t: 6, type: 'pass', subject: 5, from: 5, to: 2, x: 0.45, y: 0.5, x2: 0.35, y2: 0.5, speed: 7, lead: 0.1, result: 'success' },
    // 带球推进
    { t: 9, type: 'dribble', subject: 2, x: 0.35, y: 0.5, x2: 0.45, y2: 0.45, speed: 3, touch_freq: 1, result: 'success' },
    { t: 12, type: 'pass', subject: 2, from: 2, to: 9, x: 0.45, y: 0.45, x2: 0.62, y2: 0.4, speed: 12, lead: 0.3, result: 'success' },
    // 射门
    { t: 15, type: 'shot', subject: 9, x: 0.62, y: 0.4, x2: 0.95, y2: 0.5, speed: 20, result: 'goal' },
    { t: 15, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0', detail: 'kickoff_again' },
    // 客队反击
    { t: 18, type: 'kickoff', subject: 12, x: 0.5, y: 0.5 },
    { t: 21, type: 'pass', subject: 12, from: 12, to: 16, x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 8, lead: 0.1, result: 'success' },
    { t: 24, type: 'dribble', subject: 16, x: 0.55, y: 0.5, x2: 0.45, y2: 0.55, speed: 3, touch_freq: 1, result: 'success' },
    // 无球跑位（连续播放用）：有球动作间队友碎步调整
    { t: 27.5, type: 'off_ball_run', subject: 4, x: 0.40, y: 0.25, x2: 0.42, y2: 0.27, speed: 3, result: 'success' },
    { t: 28.5, type: 'off_ball_run', subject: 7, x: 0.62, y: 0.15, x2: 0.63, y2: 0.17, speed: 3, result: 'success' },
    { t: 29.5, type: 'off_ball_run', subject: 14, x: 0.38, y: 0.15, x2: 0.39, y2: 0.16, speed: 3, result: 'success' },
    // 抢断（成功）：home 10 逼近 away 16（持球），捅开球并把球拿下（演绎约到 t≈30.4，下一条放在之后）。
    // 16 从 (0.55,0.5) 带球到 (0.45,0.55) 途中被抢；loose 按 deflectPoint 规则。
    { t: 30, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55,
      carrier_from_x: 0.55, carrier_from_y: 0.5, loose_x: 0.4277, loose_y: 0.5053, result: 'success' },
    // 抢断（失败）：away 11 逼近 home 10，捅开球但 home 10（原持球人）重新拿回
    { t: 35, type: 'tackle', subject: 11, x: 0.45, y: 0.5, to: 10, x2: 0.43, y2: 0.51,
      carrier_from_x: 0.4277, carrier_from_y: 0.5053, loose_x: 0.4523, loose_y: 0.5547, result: 'fail' },
    { t: 37, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0', detail: 'half_time' },
  ];
}
