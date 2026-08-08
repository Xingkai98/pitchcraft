// micro-motion（P5 S3）：静止球员的小幅重心调整（渲染层 polish）
// 确定性且连续：A/φ/T 由 hash(id) 一次派生并缓存（球员级常量），t 连续推进，
// 偏移 = A·sin(2π·t/T + φ)（x 用 sin、y 用 cos，形成小幅环动）。
// 仅影响渲染层（drawPlayer 时叠加），不进 game.players 逻辑位置。
// 抑制切换（移动↔静止）用启停渐变（fade in/out ~0.3s），避免渲染跳变。

const _params = new Map(); // id -> {A, T, phi}
const _fade = new Map();   // id -> 当前振幅系数 0..1

// 确定性球员哈希（xorshift 风格，纯整数）
export function hashPlayer(id) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// 球员级微动参数（A < 0.002 归一化，约 0.2m；T 2.5-5.4s；φ 全相位）
function paramsOf(id) {
  let m = _params.get(id);
  if (!m) {
    const h = hashPlayer(id);
    m = {
      A: 0.0015 + (h % 40) / 40 * 0.0004, // 0.0015-0.0019 < 0.002
      T: 2.5 + ((h >>> 7) % 30) / 10,     // 2.5-5.4s
      phi: ((h >>> 13) % 100) / 100 * Math.PI * 2,
    };
    _params.set(id, m);
  }
  return m;
}

// 当前渲染偏移（纯 sin/cos，t 连续推进 → 波形连续，tick 边界无跳变）
export function microMotionOffset(id, t) {
  const m = paramsOf(id);
  const w = 2 * Math.PI * t / m.T + m.phi;
  return {
    dx: m.A * Math.sin(w),
    dy: m.A * Math.cos(w),
  };
}

// 启停渐变系数：active=true 时向 1 逼近，false 时向 0 逼近（~0.3s 收敛）
export function microMotionFade(id, active, dt) {
  const cur = _fade.get(id) ?? (active ? 1 : 0);
  const target = active ? 1 : 0;
  const rate = dt > 0 ? dt / 0.3 : 0;
  const next = target > cur
    ? Math.min(1, cur + rate)
    : Math.max(0, cur - rate);
  _fade.set(id, next);
  return next;
}

// 测试用：清空 fade 状态
export function resetMicroMotion() {
  _fade.clear();
}
