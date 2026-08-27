// 画面渲染层：Canvas 绘制球场、球员、球
// 暴露 renderFrame 测试钩子（tasks 6.2 像素断言用）与调试日志（6.3）。

import { config } from './config.js';
import { normalizedToPixels, pitchLines } from './geometry.js';
import { microMotionOffset, microMotionFade } from './micro-motion.js';

// 用离屏 canvas 渲染一帧，返回 { canvas, ctx, imageData }
// 输入：pitch 当前状态（球员位置 + 球位置），canvas 尺寸取自 config
export function createRenderer() {
  const { width, height } = config.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return { canvas, ctx };
}

// 绘制球场（草地 + 白线）
export function drawPitch(ctx, width, height) {
  const margin = config.pitchMargin;
  const r = config.render;

  // 草地
  ctx.fillStyle = r.pitchBg;
  ctx.fillRect(0, 0, width, height);

  // 白线
  ctx.strokeStyle = r.pitchLine;
  ctx.lineWidth = 2;
  const lines = pitchLines();
  for (const l of lines) {
    if (l.type === 'line') {
      const p1 = normalizedToPixels(l.x1, l.y1, width, height, margin);
      const p2 = normalizedToPixels(l.x2, l.y2, width, height, margin);
      ctx.beginPath();
      ctx.moveTo(p1.px, p1.py);
      ctx.lineTo(p2.px, p2.py);
      ctx.stroke();
    } else if (l.type === 'circle') {
      const c = normalizedToPixels(l.cx, l.cy, width, height, margin);
      const rPx = l.r * Math.min(width - 2 * margin, height - 2 * margin);
      ctx.beginPath();
      ctx.arc(c.px, c.py, rPx / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (l.type === 'point') {
      const p = normalizedToPixels(l.x, l.y, width, height, margin);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (l.type === 'goal') {
      // 球门：画在门线上、向球场外伸出的矩形框（左门朝左外、右门朝右外）
      const yPx = normalizedToPixels(l.x, l.y, width, height, margin).py;
      // 深度与半高换算成像素（基于画布较短边）
      const ref = Math.min(width - 2 * margin, height - 2 * margin);
      const depthPx = l.w * ref;
      const halfHPx = l.h * ref;
      // 门线在 x=0（左门）或 x=1（右门），矩形向外（门线之外）凸出
      const x0 = l.x === 0 ? 0 : width; // 左门从画布左边、右门从画布右边
      const goalLinePx = normalizedToPixels(l.x, l.y, width, height, margin).px;
      // 左门：从门线往左画 depth；右门：从门线往右画 depth（超出画布，画在边线外侧）
      const gx = l.x === 0 ? goalLinePx - depthPx : goalLinePx;
      ctx.strokeStyle = r.pitchLine;
      ctx.lineWidth = 3;
      ctx.strokeRect(gx, yPx - halfHPx, depthPx, halfHPx * 2);
    }
  }
}

// 绘制球员圆点（主客队颜色；id 0-10 home，11-21 away）
// 放大圆点并在内部写球衣号码（便于精确定位/描述球员）
export function drawPlayer(ctx, x, y, id, width, height) {
  const margin = config.pitchMargin;
  const r = config.render;
  const p = normalizedToPixels(x, y, width, height, margin);
  const isHome = id >= 0 && id <= 10;
  const radius = (id === 0 || id === 21) ? r.keeperRadius : r.playerRadius;

  // 圆点
  ctx.fillStyle = isHome ? r.homeColor : r.awayColor;
  ctx.beginPath();
  ctx.arc(p.px, p.py, radius, 0, Math.PI * 2);
  ctx.fill();
  // 白描边
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // 球衣号码（白色，居中）
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(radius * 1.1)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(id), p.px, p.py);
}

// 绘制球（isBall=true 允许越界渲染：进球/打偏越底线时球心进入球门框/界外）。
// h 高度（协议 0-1，P6 批次1）：2D 里 z 轴高度看不出，借鉴 FM 用球大小表示高度——
// 球越高越大，球落回地面时恢复正常大小（P6 抛物线高度感；角球/门球大脚 h>0 球放大明显）。
export function drawBall(ctx, x, y, width, height, h = 0) {
  const margin = config.pitchMargin;
  const r = config.render;
  const p = normalizedToPixels(x, y, width, height, margin, true);
  // 球大小 = 基础半径 × (1 + h × 1.5)：h∈[0,1] → 半径放大 1.0-2.5 倍（h=0 基础半径/无高度）
  const radius = r.ballRadius * (1 + h * 1.5);
  ctx.fillStyle = r.ballColor;
  ctx.beginPath();
  ctx.arc(p.px, p.py, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// 渲染一帧：给定当前状态（22 球员位置 + 球位置），绘制到 ctx
// opts 可选：{ playTime, movingIds:Set, dt }——开启 micro-motion（静止球员小幅重心调整）。
// 返回 imageData（供测试断言）
export function renderFrame(ctx, state, width, height, opts = {}) {
  drawPitch(ctx, width, height);
  const t = opts.playTime;
  const movingIds = opts.movingIds;
  const dt = opts.dt ?? 1 / 60;
  const useMicro = typeof t === 'number' && movingIds instanceof Set;
  for (const p of state.players) {
    let x = p.x;
    let y = p.y;
    if (useMicro) {
      // micro-motion：静止球员（不在 movingIds）做小幅重心调整；移动/持球者抑制
      const active = !movingIds.has(p.id);
      const fade = microMotionFade(p.id, active, dt);
      if (fade > 0.0001) {
        const off = microMotionOffset(p.id, t);
        x += off.dx * fade;
        y += off.dy * fade;
      }
    }
    drawPlayer(ctx, x, y, p.id, width, height);
  }
  if (state.ball) drawBall(ctx, state.ball.x, state.ball.y, width, height, state.ball.h ?? 0);
  // 调试日志：输出已渲染的球屏幕坐标（tasks 6.3 文本核对）。
  // 由 config.debug.logRender 控制（默认 false，避免每帧 60 行刷屏；测试时开）。
  if (config.debug.enabled && config.debug.logRender) {
    const s = normalizedToPixels(state.ball.x, state.ball.y, width, height, config.pitchMargin);
    console.log(`[render] 球 screen=(${s.px.toFixed(1)},${s.py.toFixed(1)}) norm=(${state.ball.x.toFixed(4)},${state.ball.y.toFixed(4)})`);
  }
  return ctx.getImageData(0, 0, width, height);
}
