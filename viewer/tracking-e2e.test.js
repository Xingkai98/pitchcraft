// 端到端：真实比赛 tracking 数据 → TrackingPlayer → renderFrame（真实 renderer + MockCanvas）。
//
// 这是"真实比赛对照"这条通路的验收测试：像素断言（不依赖视觉），验证真实数据经转换后
// 能被现有渲染层正确画出——22 个圆点、两队分色、门将分居两侧、球在场内。
//
// 依赖 viewer/data/real-game-1.json（由 tools/convert-tracking-to-frames.mjs 生成，不入库）。
// 数据不存在时整组跳过并打印生成方法——不能让缺一个大文件就把整个测试套件搞红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MockCanvas } from './mock-canvas.js';
import { renderFrame } from './renderer.js';
import { createTrackingPlayer } from './tracking-player.js';
import { config } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA1 = join(HERE, 'data', 'real-game-1.json');
const DATA2 = join(HERE, 'data', 'real-game-2.json');
const W = config.canvas.width;
const H = config.canvas.height;
const R = config.render;

const HAVE_DATA = existsSync(DATA1) && existsSync(DATA2);
const SKIP_REASON = '缺少 viewer/data/real-game-{1,2}.json —— 先生成：\n'
  + '  node tools/fetch-tracking-data.mjs   # 拉取公开数据集\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 --out viewer/data/real-game-1.json\n'
  + '  node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 --out viewer/data/real-game-2.json';

// 只保留球员圆点：MockContext 的 arc(x, y, radius, ...)，按半径区分球员/门将/球/球场线
function playerDots(calls) {
  return calls.filter((c) => c.method === 'arc'
    && (Math.abs(c.args[2] - R.playerRadius) < 0.01 || Math.abs(c.args[2] - R.keeperRadius) < 0.01));
}

function renderAt(player, t) {
  player.seekTo(t);
  const c = new MockCanvas(W, H);
  const calls = c.getContext().calls;
  renderFrame(c.getContext(), { players: player.players, ball: player.ball }, W, H, {});
  return calls;
}

test('端到端：真实比赛数据渲染出 22 个球员圆点 + 球', { skip: HAVE_DATA ? false : SKIP_REASON }, () => {
  const p = createTrackingPlayer(readFileSync(DATA1, 'utf8'));
  // 覆盖上下半场（整场约 5800s，中点约 2900s）
  for (const frac of [0.01, 0.3, 0.7, 0.99]) {
    const t = p.startTime + (p.endTime - p.startTime) * frac;
    const calls = renderAt(p, t);
    const dots = playerDots(calls);
    assert.equal(dots.length, 22, `t=${t} 应画满 22 个球员圆点，实际 ${dots.length}`);

    const home = dots.filter((a) => a.fillStyle === R.homeColor);
    const away = dots.filter((a) => a.fillStyle === R.awayColor);
    assert.equal(home.length, 11, `t=${t} 主队应有 11 个圆点`);
    assert.equal(away.length, 11, `t=${t} 客队应有 11 个圆点`);

    const ball = calls.filter((c) => c.method === 'arc' && Math.abs(c.args[2] - R.ballRadius) < 0.01);
    assert.equal(ball.length, 1, `t=${t} 应画 1 个球`);
    const [bx, by] = ball[0].args;
    assert.ok(bx >= 0 && bx <= W && by >= 0 && by <= H, `t=${t} 球应在画布内，实际 (${bx},${by})`);
  }
});

// 两场都测：它们的**源数据起始朝向相反**（game1 主队 P1 守左门、game2 守右门），
// 曾因硬编码朝向导致 game2 整体镜像。只测一场会漏掉这类 bug。
//
// 判据用「本方半场」而不是「贴近门线」：实测两场的门将全程 0 帧越过中线
// （game1 0/29002、game2 0/28232），但会随进攻大幅压上（最远到 x≈0.37，比禁区深得多）。
// 贴门线的断言会把这种真实的高位出击误判成 bug；半场判据既符合数据事实，
// 又正好能抓住镜像（镜像后主队门将会跑到 x>0.5 的对手半场）。
for (const [name, file] of [['Sample Game 1', DATA1], ['Sample Game 2', DATA2]]) {
  test(`端到端：门将始终在本方半场（${name}）`, { skip: HAVE_DATA ? false : SKIP_REASON }, () => {
    const p = createTrackingPlayer(readFileSync(file, 'utf8'));
    // 像素级验收「主队永远从 x=0 攻向 x=1」：无论源数据起始朝向如何、上下半场如何换边，
    // 主队门将都必须画在左半场、客队门将在右半场。
    for (let i = 0; i <= 20; i += 1) {
      const frac = i / 20;
      const t = p.startTime + (p.endTime - p.startTime) * frac;
      const calls = renderAt(p, t);
      const keepers = playerDots(calls).filter((a) => Math.abs(a.args[2] - R.keeperRadius) < 0.01);
      assert.equal(keepers.length, 2, `t=${t} 应有 2 个门将圆点`);
      const xs = keepers.map((k) => k.args[0]).sort((a, b) => a - b);
      assert.ok(xs[0] < W / 2, `t=${t}（${(frac * 100).toFixed(0)}%）主队门将应在左半场，实际 screen x=${xs[0]}`);
      assert.ok(xs[1] > W / 2, `t=${t}（${(frac * 100).toFixed(0)}%）客队门将应在右半场，实际 screen x=${xs[1]}`);
    }
  });
}

test('端到端：数据覆盖率如实反映在 meta 里', { skip: HAVE_DATA ? false : SKIP_REASON }, () => {
  const p = createTrackingPlayer(readFileSync(DATA1, "utf8"));
  assert.equal(p.meta.coverage.playerCellsFilledPct, 100, '球员帧应 100% 填充（替补顶槽位）');
  assert.ok(p.meta.coverage.ballMissingPct > 0, '球缺失率应如实记录（真实数据的固有局限）');
  assert.ok(p.meta.keyframeHz > 0);
});

test('端到端：缺球帧的球位落在某名球员脚下', { skip: HAVE_DATA ? false : SKIP_REASON }, () => {
  const p = createTrackingPlayer(readFileSync(DATA1, "utf8"));
  const filled = p.frames.filter((f) => typeof f.ballFill === 'number');
  assert.ok(filled.length > 0, '应有被补全的缺球帧');
  for (const f of filled.slice(0, 50)) {
    assert.deepEqual(f.ball, f.players[f.ballFill], '补全球位应等于该持球者位置');
  }
});
