// wayfinder #101：把 SkillCorner **全部 20 场** tracking 转成统一帧序列 JSON。
//
// 为什么不用 P38 的 `probes/01-convert-subset.mjs`：那个脚本的 SUBSET 写死 6 场
// （P38 的子样本）。#101 的方法要求明确是"用 SkillCorner 20 场（比 Metrica 2 场
// 大 10 倍，样本更足）"，故这里遍历骨架里的全部 20 场。
//
// 判决口径与 P38 完全一致（同一个转换器 tools/convert-skillcorner-to-frames.mjs，
// 同一 keyframeHz=5），不重写任何逻辑——本脚本只是批处理驱动 + 幂等跳过。
//
// 运行：
//   node openspec/changes/p38-formation-realism/notes/probes-main/issue101-convert-all.mjs
//
// 产物：.scratch/p38-frames/skillcorner-<id>.json（.gitignore 已排除）
//       .scratch/p38-frames/convert-summary-20.json（机器可读汇总，报告数字的溯源）

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot(HERE);
const { convertSkillcorner, resolveTrackingPath } =
  await import(pathToFileURL(join(REPO, 'tools', 'convert-skillcorner-to-frames.mjs')).href);
const { expectedTrackingBytes, isCompleteTracking } =
  await import(pathToFileURL(join(REPO, 'tools', 'fetch-tracking-data.mjs')).href);

const SCAFFOLD = join(REPO, '.scratch', 'tracking-data', 'skillcorner', 'opendata-master', 'data', 'matches');
const OUT_DIR = join(REPO, '.scratch', 'p38-frames');
mkdirSync(OUT_DIR, { recursive: true });

// 场次清单从 matches.json 取（权威来源），按 id 排序保证可复现。
// 只取有 tracking 实体的（not_started 的场次没有实体）。
const all = JSON.parse(readFileSync(join(REPO, '.scratch', 'tracking-data', 'skillcorner', 'opendata-master', 'data', 'matches.json'), 'utf8'));
const ids = all.map((m) => String(m.id)).sort();

const summary = [];
for (const id of ids) {
  const out = join(OUT_DIR, `skillcorner-${id}.json`);
  const matchPath = join(SCAFFOLD, id, `${id}_match.json`);
  if (!existsSync(matchPath)) {
    console.warn(`… ${id} 缺 match.json，跳过`);
    summary.push({ id, skipped: true, reason: 'no-match-json' });
    continue;
  }
  const trackingPath = resolveTrackingPath(matchPath);
  if (!existsSync(trackingPath)) {
    console.warn(`… ${id} 缺 tracking 实体，跳过`);
    summary.push({ id, skipped: true, reason: 'no-tracking' });
    continue;
  }
  // 用 LFS 指针声明的精确字节数判"下全了没"（与 fetch 工具同一判据）。
  const expected = expectedTrackingBytes(join(SCAFFOLD, id, `${id}_tracking_extrapolated.jsonl`));
  if (!isCompleteTracking(trackingPath, expected)) {
    console.warn(`… ${id} tracking 未下全（${statSync(trackingPath).size}/${expected ?? '?'} 字节），跳过`);
    summary.push({ id, skipped: true, reason: 'incomplete' });
    continue;
  }
  if (existsSync(out) && statSync(out).size > 1024) {
    const prev = JSON.parse(readFileSync(out, 'utf8'));
    summary.push({ id, skipped: true, reason: 'exists', bytes: statSync(out).size, meta: prev.meta });
    console.error(`↻ ${id} 已转换，跳过`);
    continue;
  }
  const result = convertSkillcorner(
    JSON.parse(readFileSync(matchPath, 'utf8')),
    readFileSync(trackingPath, 'utf8'),
    { keyframeHz: 5 },
  );
  if (!result.meta.orientationDetected.keeperSideCheck.ok) {
    throw new Error(`${id} 朝向自检失败：${JSON.stringify(result.meta.orientationDetected.keeperSideCheck)}`);
  }
  writeFileSync(out, JSON.stringify(result));
  summary.push({ id, skipped: false, bytes: statSync(out).size, meta: result.meta });
  console.error(`✔ ${id}  ${result.meta.frames} 帧  ${(statSync(out).size / 1e6).toFixed(1)} MB`);
}

console.log('\n=== 转换汇总（#101 全量）===');
console.log('id        球场m     帧数   时长s   外推点%  球外推%  缺口处/总s  半场平移来源');
for (const s of summary) {
  if (s.skipped || !s.meta) { console.log(`${s.id}  (跳过: ${s.reason})`); continue; }
  const m = s.meta; const c = m.coverage;
  console.log(`${s.id}  ${String(m.pitchMeters.length + 'x' + m.pitchMeters.width).padEnd(10)}`
    + `${String(m.frames).padStart(6)}${m.endTime.toFixed(0).padStart(8)}`
    + `${String(c.extrapolatedPointPct).padStart(9)}${String(c.ballExtrapolatedPct).padStart(9)}`
    + `${String(m.timeAxis.gaps.count + '/' + m.timeAxis.gaps.totalSec).padStart(12)}`
    + `  ${m.timeAxis.shiftSource}`);
}
writeFileSync(join(OUT_DIR, 'convert-summary-20.json'), JSON.stringify(summary, null, 1));
console.log(`\n汇总写入 ${join(OUT_DIR, 'convert-summary-20.json')}`);
