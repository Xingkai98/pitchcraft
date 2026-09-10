// 画面层演绎节奏配置（票据 09 / S4 参数分工）
// 约定：config 只放【动画时序】——phase 时长、人球分离量。
//       per-event 速度/提前量/触球频率（speed/lead/touch_freq）来自事件载荷，事件值优先。
// 调参入口：改这里即可，无需改代码。

export const config = {
  // 画布尺寸（等比映射，保持球场比例 700×450，即 14:9）
  canvas: {
    width: 700,
    height: 450,
  },

  // 球场留白（归一化坐标 0-1 映射到画布时，四周留出的像素边距）
  pitchMargin: 20,

  // 球场真实尺寸（米）：用于把归一化距离换算成真实距离，再结合 speed 算动画时长
  pitch: {
    lengthMeters: 105, // x 方向（0-1 对应全场）
    widthMeters: 68,   // y 方向（0-1 对应全场）
  },

  // 事件未给 speed 时的默认速度（m/s）
  defaults: {
    passSpeed: 10,
    dribbleSpeed: 3,
    shotSpeed: 20,
    runSpeed: 6, // 无球跑动 / 逼近
  },

  // 播放：比赛时长参数（引擎模拟范围，P19 收敛为单一值）+ 跳过机制（P7：非精彩段快进/跳过）+ 倍速。
  // 跳过机制借鉴 FM：高亮事件（射门/角球/界外球/头球/抢断）正常播放，非精彩段（普通传球+beat）
  // 检测间隙后快速播放或直接跳过——比赛时钟照常走（快跳/瞬跳），跳过的时间段也跳过显示。
  playback: {
    // 比赛内容时长参数（分钟，引擎 match_duration_seconds = 该值 × 60）。
    // 改这里即改比赛时长，无需动画面层逻辑；界面不提供切换（当前固定 5 分钟）。
    matchDuration: 5,
    skipMode: 'fast',                // 'fast'=快进非精彩段 | 'skip'=直接跳到下一高亮 | 'off'=不跳过正常播
    skipChoices: [5, 10],            // 快速播放倍速档位（在基速上再乘）
    skipThresholdSeconds: 5,         // 间隙阈值（比赛秒）：距下一个高亮超过此值进入跳过模式
    speeds: [1, 2, 4],               // 高亮段倍速档位
  },

  // 演绎节奏（所有时长单位：真实秒）
  interpretation: {
    // 带球：踢-追周期（人球解耦，非人球平移）
    dribble: {
      touchDuration: 0.30, // 球被踢出，向前滚的时长
      chaseDuration: 0.35, // 人追上球的时长
      separation: 0.018, // 人球分离量（归一化单位，约 1.5-2 身位）
      windupDuration: 0.12, // 触球前"人先动"的摆腿/前冲时长
    },
    // 传球：传跑配合（接球者先跑位，球飞向落点，落点汇合）
    pass: {
      leadRatio: 0.6, // 提前量占传球距离的比例（引擎给 lead 时用引擎值）
      receiverStartDelay: 0.15, // 接球者启动延迟（传球者摆腿后）
      receiverBrakeDuration: 0.15, // 接球者到位前刹车时长
    },
    // 射门：球加速飞向球门
    shot: {
      flightDuration: 0.6, // 球飞行时长
      keeperReactDelay: 0.1, // 门将反应延迟（先动）
    },
    // 抢断：持球 → 逼近 → 碰撞捅开 → 弹开 + 捡球
    tackle: {
      deflectDistance: 0.05, // 归一化：球被捅开滚出的距离（约 5m）
      deflectSpeed: 5, // m/s：球被捅开后的速度
      collectDelay: 0.15, // 捡球人反应停顿（s）：球到弹开点后，人先停一拍再以跑速追球
    },
    // 犯规（本轮试点）：牌出示显示时长（黄/红卡图标在犯规点停留秒数）。牌显示窗口
    // 由 game.activeCards() 按此窗口计算；犯规 tick 无 beat，画面保持上拍末态到重开 beat。
    foul: {
      cardShowDuration: 1.2,
    },
    // 通用
    turnDuration: 0.25, // 球员转向时长
  },

  // 渲染视觉
  render: {
    playerRadius: 14, // 球员圆点半径（像素，放大以容纳号码）
    ballRadius: 4, // 球半径（像素）
    keeperRadius: 16, // 门将圆点稍大
    homeColor: '#e74c3c',
    awayColor: '#3498db',
    ballColor: '#ffffff',
    pitchBg: '#2d8a4e',
    pitchLine: '#ffffff',
  },

  // 调试日志：打印实际渲染的球/球员移动（归一化坐标），用文本验证代替视觉。
  // enabled 开时，每 logEveryNFrames 帧打印一次球 + 移动球员位置；
  // 事件切换时打印一条事件摘要。
  debug: {
    enabled: true,
    logEveryNFrames: 30, // 每 30 帧（约 0.5s @60fps）打一次
    logBall: true, // 打印球位置（game 层，归一化）
    logMovingPlayers: true, // 打印正在移动的球员（相对上帧移动 > threshold）
    moveThreshold: 0.002, // 归一化位移阈值，超过才算"移动中"
    logRender: false, // 打印渲染层球的屏幕坐标（每帧，测试用；开 true 会刷屏）
  },
};
