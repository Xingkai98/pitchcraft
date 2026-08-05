// 最小 Canvas 2D context mock（Node 测试用，无浏览器依赖）
// 记录绘制调用，供断言"画了什么、画在哪"。
// 用于 task 6.2 像素断言：验证球员/球渲染在正确位置。

export class MockCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ctx = new MockContext();
  }

  getContext() {
    return this.ctx;
  }
}

export class MockContext {
  constructor() {
    this.calls = []; // 记录所有绘制调用
    this.fillStyle = null;
    this.strokeStyle = null;
    this.lineWidth = 0;
  }

  _record(method, args) {
    this.calls.push({ method, args: [...args], fillStyle: this.fillStyle, strokeStyle: this.strokeStyle });
  }

  fillRect(...a) { this._record('fillRect', a); }
  strokeRect(...a) { this._record('strokeRect', a); }
  beginPath() { this._record('beginPath', []); }
  moveTo(...a) { this._record('moveTo', a); }
  lineTo(...a) { this._record('lineTo', a); }
  arc(...a) { this._record('arc', a); }
  fill() { this._record('fill', []); }
  stroke() { this._record('stroke', []); }
  fillText(...a) { this._record('fillText', a); }
  set font(v) { this._font = v; }
  get font() { return this._font; }
  set textAlign(v) { this._textAlign = v; }
  set textBaseline(v) { this._textBaseline = v; }
  getImageData() {
    // 返回假的 imageData（像素断言测试用；实际断言靠 calls 记录）
    return { data: new Uint8ClampedArray(this.width * this.height * 4), width: this.width, height: this.height };
  }
}
