// P38：把 SkillCorner 子样本的 6 场 tracking 转成统一帧序列 JSON。
//
// 直接复用仓库既有转换器 tools/convert-skillcorner-to-frames.mjs（口径唯一）；
// 本脚本只是批处理驱动 + 幂等跳过 + 元数据汇总。
//
// 运行：
//   node openspec/changes/p38-formation-realism/notes/probes/01-convert-subset.mjs
//
// 前置：00-fetch-subset.mjs 已把骨架与 tracking 实体拉齐。
// 产物：.scratch/p38-frames/skillcorner-<id>.json（.gitignore 已排除 .scratch/）
//
// 转换器关键字口径（读 tools/convert-skillcorner-to-frames.mjs 得）：
//   - player_id 对应 match.json.players[].id（**不是** trackable_object）
//   - 外推点（is_detected≠true）坐标带第三位 1；球的补全写 ballFill
//   - 半场时钟回跳由 stitchTimeline 拼接（shift 优先取 match_periods 权威边界）
//   - 朝向自检失败会**抛错**（拒绝静默输出镜像数据）
//   - 逐场球场尺寸从 match.json 的 pitch_length/width 读（不硬编码）

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot(HERE);
const { convertSkillcorner, resolveTrackingPath } =
  await import(pathToFileURL(join(REPO, 'tools', 'convert-skillcorner-to-frames.mjs')).href);
// 「下载是否完整」的判据（LFS 指针声明的精确字节数）由 fetch-tracking-data.mjs 导出——
// 从权威来源取，不在探针里复制一份（复制出来的判据会漂移）。
const { expectedTrackingBytes, isCompleteTracking } =
  await import(pathToFileURL(join(REPO, 'tools', 'fetch-tracking-data.mjs')).href);
// 与 corpus.mjs / 00-fetch-subset.mjs 保持一致（改场次要三处同改）
const SUBSET = ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];

const SCAFFOLD = join(REPO, '.scratch', 'tracking-data', 'skillcorner', 'opendata-master', 'data', 'matches');
const OUT_DIR = join(REPO, '.scratch', 'p38-frames');
mkdirSync(OUT_DIR, { recursive: true });

const summary = [];
for (const id of SUBSET) {
  const out = join(OUT_DIR, `skillcorner-${id}.json`);
  if (existsSync(out) && statSync(out).size > 1024) {
    // 已存在也读回 meta：汇总表要能**独立**反映全部 6 场（否则重跑时表格只印最后一场，
    // 报告里的"逐场尺寸/外推占比"就得靠前一次的日志，不可复现）。
    const prev = JSON.parse(readFileSync(out, 'utf8'));
    summary.push({ id, skipped: true, bytes: statSync(out).size, meta: prev.meta });
    continue;
  }
  const matchPath = join(SCAFFOLD, id, `${id}_match.json`);
  if (!existsSync(matchPath)) throw new Error(`缺少 match.json：${matchPath}（先跑 00-fetch-subset.mjs）`);
  const trackingPath = resolveTrackingPath(matchPath);
  if (!existsSync(trackingPath)) throw new Error(`缺少 tracking 实体：${trackingPath}（先跑 00-fetch-subset.mjs）`);
  // 下载**尚未完成**（还在 .part）时跳过而非抛错：下载与转换是两条独立进程，
  // 转换侧应当对"这一场还没备齐"免疫，跑完已就位的场次即可（重跑本脚本补齐）。
  // 判据用 LFS 指针声明的精确字节数（与 fetch 工具同一判据），不是拍脑袋的下限。
  const expected = expectedTrackingBytes(join(SCAFFOLD, id, `${id}_tracking_extrapolated.jsonl`));
  if (!isCompleteTracking(trackingPath, expected)) {
    console.warn(`… ${id} tracking 未下全（${statSync(trackingPath).size}/${expected ?? '?'} 字节），本轮跳过`);
    summary.push({ id, skipped: true, incomplete: true });
    continue;
  }
  const result = convertSkillcorner(
    JSON.parse(readFileSync(matchPath, 'utf8')),
    readFileSync(trackingPath, 'utf8'),
    { keyframeHz: 5 }, // 与 P36/P37 口径一致（真实侧 5Hz，与引擎采样 0.2s 相位同构）
  );
  // 与 CLI 同样拒绝朝向判反的产物（转换器已自检，这里再挡一道）
  if (!result.meta.orientationDetected.keeperSideCheck.ok) {
    throw new Error(`${id} 朝向自检失败：${JSON.stringify(result.meta.orientationDetected.keeperSideCheck)}`);
  }
  writeFileSync(out, JSON.stringify(result));
  summary.push({ id, skipped: false, bytes: statSync(out).size, meta: result.meta });
  console.error(`✔ ${id}  ${result.meta.frames} 帧  ${(statSync(out).size / 1e6).toFixed(1)} MB`);
}

// 汇总表：逐场尺寸、外推占比、缺口——写进报告时直接引用
console.log('\n=== 转换汇总（P38 子样本）===');
console.log('id        球场m    帧数   时长s   外推点%  球外推%  缺口处/总s  半场平移来源');
for (const s of summary) {
  if (s.skipped) { console.log(`${s.id}  (已存在跳过)`); continue; }
  const m = s.meta; const c = m.coverage;
  console.log(`${s.id}  ${String(m.pitchMeters.length + 'x' + m.pitchMeters.width).padEnd(8)}`
    + `${String(m.frames).padStart(6)}${m.endTime.toFixed(0).padStart(8)}`
    + `${String(c.extrapolatedPointPct).padStart(9)}${String(c.ballExtrapolatedPct).padStart(9)}`
    + `${String(m.timeAxis.gaps.count + '/' + m.timeAxis.gaps.totalSec).padStart(12)}`
    + `  ${m.timeAxis.shiftSource}`);
}
// 机器可读的汇总（报告数字的溯源）
writeFileSync(join(OUT_DIR, 'convert-summary.json'), JSON.stringify(summary, null, 1));
