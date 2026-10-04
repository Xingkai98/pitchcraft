// visual-review 工具的守护测试。
// 重点守两件踩过坑的事：
//   1. render.mjs 必须**把球画出来**（引擎帧的 ball 是数组 [x,y]，曾用 ball.x 判断 → 球漏画）。
//      → 断 PNG 里"亮黄球像素"数量足够（球可见），且有红/蓝球员像素。
//   2. motion-metrics 的 windowStats 必须在**全窗**上算、并回报方向一致性（跨窗纪律）。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM = join(ROOT, 'viewer/engine.wasm');
const HAVE = existsSync(WASM) && existsSync(join(ROOT, 'viewer/data/real-game-1.json'));

test('render.mjs 把球画出来（球可见，不是漏画）', { skip: !HAVE && '缺 engine.wasm / real-game-1.json' }, () => {
  const out = join(mkdtempSync(join(tmpdir(), 'vr-')), 'cmp.png');
  execFileSync('node', [join(ROOT, 'tools/visual-review/render.mjs'), WASM, out, '42', '600', '12', '6'],
    { cwd: ROOT, stdio: 'pipe' });
  // parser PNG 需要解码库；本仓无依赖 → 用 python3 PIL（本机有）作外部校验，缺则跳过颜色断言。
  let yellow = -1, red = -1, blue = -1;
  try {
    const py = `from PIL import Image
from collections import Counter
c=Counter(Image.open(${JSON.stringify(out)}).convert('RGB').get_flattened_data())
y=sum(n for col,n in c.items() if col[0]>200 and col[1]>180 and col[2]<80)
r=sum(n for col,n in c.items() if col[0]>180 and col[1]<90 and col[2]<90)
b=sum(n for col,n in c.items() if col[2]>180 and col[0]<120 and col[1]>90)
print(y,r,b)`;
    [yellow, red, blue] = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  } catch { return; } // 无 PIL → 跳过（不阻塞）
  assert.ok(yellow > 200, `亮黄球像素太少（${yellow}）——球可能又漏画了（引擎 ball 是数组 [x,y]）`);
  assert.ok(red > 500 && blue > 500, `红/蓝球员像素不足（red=${red} blue=${blue}）`);
});

test('motion-metrics.windowStats 跨全窗 + 回报方向一致性', async () => {
  // motion-metrics.mjs 有 IS_ENTRY 守卫，import 不会跑主流程。
  const { windowStats } = await import('./motion-metrics.mjs');
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ t: i * 0.2, players: Array.from({ length: 20 }, (_, id) => ({ id: id + 1, x: 0.5 + i * 0.001 * (id % 3 - 1), y: 0.5 })) });
  }
  const w = windowStats(frames, 4);
  assert.ok(w.disp.length >= 1, '应有窗');
  assert.ok(w.dir.length >= 1, '应回报方向一致性（区分整队平移 vs 个体跑位的判据）');
  assert.ok(w.still.length === w.disp.length, '静止占比与位移同窗数');
});
