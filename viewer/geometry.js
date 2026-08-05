// 纯几何函数：归一化坐标 ↔ 画布像素（无 DOM 依赖，可单测）
// 约定：输入归一化坐标 (0-1)，输出画布像素坐标。保持球场比例、四周留白。

// 归一化 → 像素
// x: 0=左门线→1=右门线（画布从左到右）
// y: 0=下边线→1=上边线（画布从上到下 —— 注意：y=0 在下边线，所以 y=0 → py 大，y=1 → py 小）
// 返回 {px, py}，px ∈ [margin, width-margin]，py ∈ [margin, height-margin]
// 越界坐标钳制到 [0,1]（不抛错）——球进网时 x 可能略超 1.0，渲染应钳制而非崩溃。
export function normalizedToPixels(x, y, canvasWidth, canvasHeight, margin) {
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  const innerW = canvasWidth - 2 * margin;
  const innerH = canvasHeight - 2 * margin;
  return {
    px: margin + cx * innerW,
    py: margin + (1 - cy) * innerH, // y=0(下)→底部，y=1(上)→顶部
  };
}

// 像素 → 归一化（反向，供日志核对）
export function pixelsToNormalized(px, py, canvasWidth, canvasHeight, margin) {
  const innerW = canvasWidth - 2 * margin;
  const innerH = canvasHeight - 2 * margin;
  return {
    x: (px - margin) / innerW,
    y: 1 - (py - margin) / innerH,
  };
}

// 球场白线几何（归一化坐标）：边线、中线、中圈、禁区、球门、点球点
// 返回一组线段/圆/矩形，供画面层绘制
export function pitchLines() {
  const L = 0, R = 1, T = 1, B = 0; // 归一化：x∈[0,1], y∈[0,1]
  const boxDepth = 0.16; // 禁区深度（归一化）
  const boxWidth = 0.42; // 禁区宽度（围绕球门中心）
  const boxCenterY = 0.5;
  const goalDepth = 0.015; // 球门深度（归一化，约 1.6m）
  const goalHalfHeight = 0.045; // 球门半高（归一化，约 3.7m，球门宽 7.32m）

  const lines = [
    // 边线
    { type: 'line', x1: L, y1: B, x2: R, y2: B }, // 下边线
    { type: 'line', x1: R, y1: B, x2: R, y2: T }, // 右边线
    { type: 'line', x1: R, y1: T, x2: L, y2: T }, // 上边线
    { type: 'line', x1: L, y1: T, x2: L, y2: B }, // 左边线
    // 中线
    { type: 'line', x1: 0.5, y1: B, x2: 0.5, y2: T },
    // 中圈
    { type: 'circle', cx: 0.5, cy: 0.5, r: 0.12 },
    // 中点
    { type: 'point', x: 0.5, y: 0.5 },
    // 左禁区
    { type: 'line', x1: L, y1: boxCenterY - boxWidth / 2, x2: L + boxDepth, y2: boxCenterY - boxWidth / 2 },
    { type: 'line', x1: L + boxDepth, y1: boxCenterY - boxWidth / 2, x2: L + boxDepth, y2: boxCenterY + boxWidth / 2 },
    { type: 'line', x1: L + boxDepth, y1: boxCenterY + boxWidth / 2, x2: L, y2: boxCenterY + boxWidth / 2 },
    // 右禁区
    { type: 'line', x1: R, y1: boxCenterY - boxWidth / 2, x2: R - boxDepth, y2: boxCenterY - boxWidth / 2 },
    { type: 'line', x1: R - boxDepth, y1: boxCenterY - boxWidth / 2, x2: R - boxDepth, y2: boxCenterY + boxWidth / 2 },
    { type: 'line', x1: R - boxDepth, y1: boxCenterY + boxWidth / 2, x2: R, y2: boxCenterY + boxWidth / 2 },
    // 球门（左右各一个，画在门线上）
    { type: 'goal', x: L, y: boxCenterY, w: goalDepth, h: goalHalfHeight },
    { type: 'goal', x: R, y: boxCenterY, w: goalDepth, h: goalHalfHeight },
    // 点球点
    { type: 'point', x: 0.10, y: boxCenterY },
    { type: 'point', x: 0.90, y: boxCenterY },
  ];
  return lines;
}
