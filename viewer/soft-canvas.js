// 无依赖软件 Canvas + PNG 编码器（视觉抽查管线用，非产品代码）
// 背景：项目从零写、无 node-canvas / headless 浏览器；renderer.js 依赖浏览器 Canvas 2D。
// 本模块用纯 JS 实现 renderer.js 实际用到的最小 Canvas 2D 子集（fillRect/strokeRect/
// beginPath/moveTo/lineTo/stroke/arc/fill/fillText + 颜色/font/对齐），把 drawPitch/
// drawPlayer/drawCard/drawBall 画进一个 Uint8 RGBA 帧缓冲，再编码成 PNG（node:zlib deflate）。
// 这样抽查帧与真实 viewer 用同一套 game.js 状态 + geometry 几何 + renderer.js 绘制逻辑，
// 只是光栅化端不同（浏览器 Canvas vs 本软光栅）。数字字体用嵌入式 5x7 点阵，避免外部字体依赖。
// 仅供开发期视觉抽查使用，不在浏览器里加载。

import { deflateSync } from 'node:zlib';

// ---------- 5x7 数字点阵（用于球衣号码）----------
// 每个字符 5 列 7 行，位串自左列到右列，自上到下的 '1' bit 为前景。
const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00110','01000','10000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  '-': ['00000','00000','00000','01110','00000','00000','00000'],
};
const FONT_W = 5;
const FONT_H = 7;

export class SoftCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ctx = new SoftContext(this);
  }
  getContext() { return this.ctx; }
}

export class SoftContext {
  constructor(canvas) {
    this._canvas = canvas;
    this._px = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    // 背景默认不透明黑
    for (let i = 0; i < canvas.width * canvas.height; i++) {
      this._px[i * 4 + 3] = 255;
    }
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    // path 状态
    this._path = [];
  }

  // ---- 颜色解析：支持 '#rgb' '#rrggbb' 或 'rgb(r,g,b)'，返回 [r,g,b] ----
  _parseColor(c) {
    if (typeof c !== 'string') c = String(c);
    c = c.trim();
    if (c.startsWith('#')) {
      let h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    // 常见颜色名
    const named = { white: [255,255,255], black: [0,0,0], red: [255,0,0], blue: [0,0,255], green: [0,128,0] };
    if (named[c.toLowerCase()]) return named[c.toLowerCase()];
    return [0, 0, 0];
  }

  // 设置单个像素，带 alpha 混合
  _setPx(x, y, [r, g, b], a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this._canvas.width || y >= this._canvas.height) return;
    const o = (y * this._canvas.width + x) * 4;
    if (a >= 255) {
      this._px[o] = r; this._px[o + 1] = g; this._px[o + 2] = b; this._px[o + 3] = 255;
    } else {
      const ar = a / 255;
      this._px[o] = this._px[o] * (1 - ar) + r * ar;
      this._px[o + 1] = this._px[o + 1] * (1 - ar) + g * ar;
      this._px[o + 2] = this._px[o + 2] * (1 - ar) + b * ar;
      this._px[o + 3] = 255;
    }
  }

  _fillRectPx(x, y, w, h, [r, g, b]) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this._canvas.width, Math.ceil(x + w));
    const y1 = Math.min(this._canvas.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * this._canvas.width + xx) * 4;
        this._px[o] = r; this._px[o + 1] = g; this._px[o + 2] = b; this._px[o + 3] = 255;
      }
    }
  }

  _strokeLine(x0, y0, x1, y1, [r, g, b], width) {
    // Bresenham + 线宽（简化为沿主轴的矩形覆盖）
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const w = width || 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      // 画一个以 (x,y) 为中心的 w×w 方块
      const r0 = w / 2;
      for (let yy = Math.floor(y - r0); yy <= Math.ceil(y + r0); yy++) {
        for (let xx = Math.floor(x - r0); xx <= Math.ceil(x + r0); xx++) {
          this._setPx(xx, yy, [r, g, b]);
        }
      }
    }
  }

  // ---- Canvas 2D API ----
  fillRect(x, y, w, h) { this._fillRectPx(x, y, w, h, this._parseColor(this.fillStyle)); }
  strokeRect(x, y, w, h) {
    const [r, g, b] = this._parseColor(this.strokeStyle);
    const lw = Math.max(1, this.lineWidth || 1);
    this._strokeLine(x, y, x + w, y, [r, g, b], lw);
    this._strokeLine(x + w, y, x + w, y + h, [r, g, b], lw);
    this._strokeLine(x + w, y + h, x, y + h, [r, g, b], lw);
    this._strokeLine(x, y + h, x, y, [r, g, b], lw);
  }
  beginPath() { this._path = []; }
  moveTo(x, y) { this._path.push({ op: 'M', x, y }); }
  lineTo(x, y) { this._path.push({ op: 'L', x, y }); }
  arc(cx, cy, r, startAngle, endAngle) {
    // 只支持整圆（renderer 画球员/球/中圈都是 0..2PI）
    this._path.push({ op: 'A', cx, cy, r, startAngle, endAngle });
  }
  fill() {
    // 只处理实心圆（arc 闭合填充）；开放路径的 fill 不支持（renderer 没用到）
    const [r, g, b] = this._parseColor(this.fillStyle);
    for (const seg of this._path) {
      if (seg.op === 'A') {
        // 扇形填充：近似整圆（start 0, end 2PI 常见）
        const full = seg.endAngle - seg.startAngle >= 2 * Math.PI - 1e-6;
        const rr = Math.max(0, seg.r);
        const x0 = Math.floor(seg.cx - rr - 1), x1 = Math.ceil(seg.cx + rr + 1);
        const y0 = Math.floor(seg.cy - rr - 1), y1 = Math.ceil(seg.cy + rr + 1);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const d = (xx - seg.cx) ** 2 + (yy - seg.cy) ** 2;
            if (d <= rr * rr) {
              if (full) {
                this._setPx(xx, yy, [r, g, b]);
              } else {
                // 扇形：粗略角度判断
                let ang = Math.atan2(yy - seg.cy, xx - seg.cx);
                while (ang < 0) ang += 2 * Math.PI;
                let a0 = seg.startAngle, a1 = seg.endAngle;
                while (a1 < a0) a1 += 2 * Math.PI;
                if (ang >= a0 && ang <= a1) this._setPx(xx, yy, [r, g, b]);
              }
            }
          }
        }
      }
    }
    this._path = [];
  }
  stroke() {
    const [r, g, b] = this._parseColor(this.strokeStyle);
    const lw = Math.max(1, this.lineWidth || 1);
    let start = null, last = null;
    for (const seg of this._path) {
      if (seg.op === 'M') { start = { x: seg.x, y: seg.y }; last = start; }
      else if (seg.op === 'L') { this._strokeLine(last.x, last.y, seg.x, seg.y, [r, g, b], lw); last = { x: seg.x, y: seg.y }; }
      else if (seg.op === 'A') {
        // 圆/圆弧描边：画圆周
        const rr = Math.max(0, seg.r);
        const full = seg.endAngle - seg.startAngle >= 2 * Math.PI - 1e-6;
        const N = Math.max(24, Math.ceil(rr * 2 * Math.PI));
        for (let i = 0; i < N; i++) {
          const a0 = seg.startAngle + (seg.endAngle - seg.startAngle) * i / N;
          const a1 = seg.startAngle + (seg.endAngle - seg.startAngle) * (i + 1) / N;
          if (!full && a1 > seg.endAngle) break;
          const x0 = seg.cx + rr * Math.cos(a0), y0 = seg.cy + rr * Math.sin(a0);
          const x1 = seg.cx + rr * Math.cos(a1), y1 = seg.cy + rr * Math.sin(a1);
          this._strokeLine(x0, y0, x1, y1, [r, g, b], lw);
        }
      }
    }
    this._path = [];
  }

  fillText(text, x, y) {
    const [r, g, b] = this._parseColor(this.fillStyle);
    // 解析字号（取 px 前的数字）；textAlign center 已由调用方用 textAlign 属性控制
    const fontSize = Number((this.font.match(/(\d+(?:\.\d+)?)px/) || [0, 10])[1]) || 10;
    const scale = fontSize / 7; // 点阵 7 行高 → 目标字号
    const chars = String(text).split('');
    // textAlign: 'center' 时整体居中偏移
    let offsetX = 0;
    if (this.textAlign === 'center') {
      const totalW = chars.length * FONT_W * scale;
      offsetX = -totalW / 2;
    }
    // textBaseline: 只处理 middle（近似按 font 高居中）；alphabetic 默认在 y 基线
    let baseOffsetY = 0;
    if (this.textBaseline === 'middle') baseOffsetY = -fontSize * 0.35;
    let cx = x + offsetX;
    const cy = y + baseOffsetY;
    for (const ch of chars) {
      const glyph = FONT[ch] || FONT['-'];
      if (glyph) {
        for (let row = 0; row < FONT_H; row++) {
          for (let col = 0; col < FONT_W; col++) {
            if (glyph[row][col] === '1') {
              // 每个点阵像素画成 scale×scale 方块
              for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                  this._setPx(cx + col * scale + dx, cy + row * scale + dy, [r, g, b]);
                }
              }
            }
          }
        }
      }
      cx += FONT_W * scale;
    }
  }

  getImageData(x, y, w, h) {
    x = x || 0; y = y || 0; w = w || this._canvas.width; h = h || this._canvas.height;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx, sy = y + yy;
        const src = (sy * this._canvas.width + sx) * 4;
        const dst = (yy * w + xx) * 4;
        if (sx >= 0 && sy >= 0 && sx < this._canvas.width && sy < this._canvas.height) {
          data[dst] = this._px[src]; data[dst + 1] = this._px[src + 1];
          data[dst + 2] = this._px[src + 2]; data[dst + 3] = this._px[src + 3];
        }
      }
    }
    return { data, width: w, height: h };
  }
}

// 序列化成 PNG buffer（RGBA, 8bit）。输出与浏览器 drawImage/toBlob 产物格式一致。
export function canvasToPng(canvas) {
  const { width, height } = canvas;
  const px = canvas.ctx._px;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const o = y * (1 + width * 4) + 1 + x * 4;
      raw[o] = px[s]; raw[o + 1] = px[s + 1]; raw[o + 2] = px[s + 2]; raw[o + 3] = px[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
