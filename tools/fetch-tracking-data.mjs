#!/usr/bin/env node
// 拉取公开足球 tracking 数据集到本地（供"真实比赛对照"使用）。
//
// 数据入 .scratch/tracking-data/（.gitignore 已排除），不进仓库。
// 拉完用 convert-tracking-to-frames.mjs 转成 viewer 能吃的帧序列。
//
// 用法：
//   node tools/fetch-tracking-data.mjs            # 拉默认数据集（Metrica sample-data）
//   node tools/fetch-tracking-data.mjs --check    # 只报告本地已有什么，不下载

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, '.scratch', 'tracking-data');

// SkillCorner opendata 的 tracking 实体在仓库里是 **Git LFS 指针**（133 字节），
// git clone 拿到的只是一行 `version https://git-lfs.github.com/spec/v1`，不是数据。
// 实体须走 media.githubusercontent.com 的 media 通道。
//
// ⚠ 分支是 **master**（不是 main）：`.../refs/heads/main` 与 `.../media/.../main/...`
// 都会 404。实测 2026-09-18。
const SKILLCORNER_TARBALL = 'https://codeload.github.com/SkillCorner/opendata/tar.gz/refs/heads/master';
const SKILLCORNER_MEDIA_BASE = 'https://media.githubusercontent.com/media/SkillCorner/opendata/master/data/matches';

// 完整性判据：**用 LFS 指针里声明的精确字节数**（每场 tracking 的 LFS 指针带 `size N`）。
// 早先版本的教训：拿一个拍脑袋的"最小字节数"当判据（如 1 MB）会把**截断的下载**
// 当成完整——实测截断产物 3.1 MB / 65 MB 都被放过，直到解析时才炸，且错因看起来像
// "数据格式不对"。精确比对是唯一可靠的判据。
//
// 没有指针可比对时的兜底下限（LFS 指针 ~133B；真文件 ~90MB）。
const MIN_TRACKING_BYTES = 1024 * 1024;

// 单场下载的尝试次数。media 通道会中途掐断（实测），断点续传 + 重试能补齐。
const TRACKING_MAX_ATTEMPTS = 6;

// 并发下载的 worker 数。实测单连接速率在 90 KB/s – 2 MB/s 之间大幅波动
// （media 通道限速/抖动），串行 20 场 × 90MB 最坏要几小时；并发让总带宽不被
// 单个慢连接拖住。6 路在实测环境里稳定跑满，再高收益递减。
const TRACKING_CONCURRENCY = 6;

// 数据集清单。加新数据源时在这里追加。
const DATASETS = [
  {
    key: 'metrica-sample-data',
    label: 'Metrica Sports sample-data（3 场，25Hz，0-1 归一化坐标，105x68m）',
    kind: 'git-sparse',
    repo: 'https://github.com/metrica-sports/sample-data',
    dir: join(DEST, 'sample-data'),
    // 只需要 data/ 与 documentation/，不拉 .git 全历史
    sparse: ['data', 'documentation'],
    license: '未声明正式许可；README 要求使用时注明来源并负责任使用（开发/研究用途）',
    source: 'https://github.com/metrica-sports/sample-data',
  },
  {
    key: 'skillcorner-opendata',
    label: 'SkillCorner opendata（20 场，10fps 广播 CV，澳超 2024/25）',
    kind: 'skillcorner',
    repo: 'https://github.com/SkillCorner/opendata',
    dir: join(DEST, 'skillcorner'),
    license: 'MIT（仓库根 LICENSE）',
    source: 'https://github.com/SkillCorner/opendata',
    note: 'tracking 是 LFS 实体（~1.82 GB / 20 场），走 media.githubusercontent.com media 通道 + master 分支',
  },
];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// curl 封装：失败即抛（调用方决定跳过还是中止）。
// -L 跟随重定向（media 通道会 302）。
// **刻意不加 --retry**：curl 自带的 --retry 与 -C - 组合会对"续传偏移"产生歧义
// （重试时从哪续），而调用方的重试循环**每轮核对字节数**、以字节数为唯一判据——
// 让重试逻辑只有一处（调用方），curl 只负责"下这一轮"。
// **异步**：并发下载要求 curl 跑在子进程里不阻塞事件循环——用 execFileSync 会把
// worker 池串行化，并发形同虚设（实测踩过）。
function curl(url, out, { resume = false } = {}) {
  const args = ['-sSL', '--connect-timeout', '30', '-o', out];
  if (resume) args.push('-C', '-');
  args.push(url);
  return new Promise((resolveP, rejectP) => {
    execFile('curl', args, { maxBuffer: 1 << 20 }, (err) => (err ? rejectP(err) : resolveP()));
  });
}

// LFS 指针文件长这样（约 133 字节），不是真数据。下载"成功"但拿到它是最阴的失败模式：
// 后续解析会报出莫名其妙的 JSON 错误，而根因（LFS 通道走错/分支写错）在错误信息里看不见。
export function isLfsPointer(buf) {
  return buf.slice(0, 64).toString('utf8').startsWith('version https://git-lfs');
}

async function fetchDataset(ds) {
  if (ds.kind === 'skillcorner') return fetchSkillcorner(ds);
  return fetchGitSparse(ds);
}

function fetchGitSparse(ds) {
  if (existsSync(join(ds.dir, '.git'))) {
    console.log(`↻ ${ds.key} 已存在，更新中…`);
    try {
      sh('git', ['-C', ds.dir, 'pull', '--ff-only']);
    } catch {
      console.warn(`  ⚠ 更新失败（可能离线），沿用本地副本`);
    }
    return true;
  }
  console.log(`⬇ ${ds.key} — ${ds.label}`);
  mkdirSync(ds.dir, { recursive: true });
  try {
    // 浅克隆 + 稀疏检出：只取需要的大目录，避免全量历史
    sh('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', ds.repo, ds.dir]);
    sh('git', ['-C', ds.dir, 'sparse-checkout', 'set', ...ds.sparse]);
    console.log(`  ✔ 已拉到 ${ds.dir}`);
    console.log(`  ⚠ 许可：${ds.license}`);
    return true;
  } catch (err) {
    console.error(`  ✗ 拉取失败：${err.message}`);
    console.error(`    （网络受限时可在有网的机器上克隆后拷到 ${ds.dir}）`);
    return false;
  }
}

// SkillCorner 分两步：
//   1) 仓库骨架（codeload tar.gz，~25.7MB）——含 matches.json 与每场的 match.json。
//      tracking 是 LFS 指针，tar.gz 里只有指针，故第 2 步单独拉实体。
//   2) 逐场 tracking 实体（media 通道，20 场 ~1.82GB）。
//
// **单场失败可跳过/可续**（design 风险节要求）：任一场的成败不影响其余场次，
// 已下载完整的场在重跑时跳过（idempotent）。末尾汇总失败清单并给出重跑提示。
export async function fetchSkillcorner(ds, { ids = null } = {}) {
  const tarPath = join(ds.dir, 'opendata.tar.gz');
  const srcDir = join(ds.dir, 'opendata-master');
  const trackingDir = join(ds.dir, 'tracking');
  mkdirSync(trackingDir, { recursive: true });

  // ── 1) 骨架 ──
  if (!existsSync(join(srcDir, 'data', 'matches.json'))) {
    console.log(`⬇ ${ds.key} 骨架（codeload tar.gz，~25.7MB）`);
    try {
      curl(SKILLCORNER_TARBALL, tarPath);
      console.log('  解包中…');
      sh('tar', ['xzf', tarPath, '-C', ds.dir]);
      rmSync(tarPath, { force: true });
    } catch (err) {
      console.error(`  ✗ 骨架拉取失败：${err.message}`);
      console.error(`    （网络受限时可在有网的机器上取 ${SKILLCORNER_TARBALL} 解到 ${ds.dir}）`);
      return false;
    }
  } else {
    console.log(`↻ ${ds.key} 骨架已存在`);
  }
  console.log(`  ⚠ 许可：${ds.license}（来源 ${ds.source}）`);

  // ── 2) tracking 实体，逐场（并发）──
  const all = JSON.parse(readFileSync(join(srcDir, 'data', 'matches.json'), 'utf8'));
  const wanted = ids ? all.filter((m) => ids.includes(String(m.id))) : all;
  console.log(`⬇ tracking 实体：${wanted.length} 场（LFS → media 通道，master 分支，${TRACKING_CONCURRENCY} 路并发）`);

  const failed = [];
  const queue = [...wanted];
  const results = { done: 0, skipped: 0 };
  const worker = async () => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const id = String(m.id);
      const out = join(trackingDir, `${id}_tracking_extrapolated.jsonl`);
      // 期望字节数：同目录下的 LFS 指针（骨架里必有）给出精确值。
      const expected = expectedTrackingBytes(join(srcDir, 'data', 'matches', id, `${id}_tracking_extrapolated.jsonl`));
      if (isCompleteTracking(out, expected)) { results.skipped += 1; continue; } // 已完整：跳过（幂等/可续）
      const url = `${SKILLCORNER_MEDIA_BASE}/${id}/${id}_tracking_extrapolated.jsonl`;
      try {
        // 下到 .part 再改名：中断时留下的是 .part，不会被 isCompleteTracking 误认为完整。
        const part = `${out}.part`;
        // 已有 .part 是 LFS 指针或**超过**期望大小（错文件/拼接垃圾）→ 从零重下。
        if (existsSync(part)) {
          const ps = statSync(part).size;
          if (isLfsPointer(readFileSync(part)) || (expected && ps > expected)) rmSync(part, { force: true });
        }
        // 断点续传 + 重试：media 通道实测会中途掐断；每轮 curl 返回后核对字节数，
        // 不达标就再来一轮（-C - 从已落盘的位置接着下），直到精确匹配期望值或耗尽尝试。
        let ok = false;
        for (let attempt = 1; attempt <= TRACKING_MAX_ATTEMPTS; attempt += 1) {
          await curl(url, part, { resume: true });
          if (isCompleteTracking(part, expected)) { ok = true; break; }
          const got = existsSync(part) ? statSync(part).size : 0;
          console.warn(`  … ${id} 第 ${attempt}/${TRACKING_MAX_ATTEMPTS} 次后 ${(got / 1e6).toFixed(1)}`
            + `/${expected ? (expected / 1e6).toFixed(1) : '?'} MB，续传重试`);
        }
        if (!ok) throw new Error(`重试 ${TRACKING_MAX_ATTEMPTS} 次仍未下全（期望 ${expected} 字节）`);
        renameSync(part, out);
        results.done += 1;
        console.log(`  ✔ ${id} (${(statSync(out).size / 1e6).toFixed(1)} MB) [${results.done}/${wanted.length}]`);
      } catch (err) {
        failed.push(id);
        console.warn(`  ✗ ${id}: ${err.message.split('\n')[0]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRACKING_CONCURRENCY, wanted.length) }, worker));

  if (failed.length > 0) {
    console.error(`  ⚠ ${failed.length}/${wanted.length} 场失败：${failed.join(', ')}`);
    console.error('    重跑本脚本即可续传（已完整的场次会跳过）；单场失败不影响其余场次。');
  }
  console.log(`  ✔ ${results.done} 场下载 + ${results.skipped} 场已完整 = ${results.done + results.skipped}/${wanted.length} 在 ${trackingDir}`);
  return failed.length === 0;
}

// 从 LFS 指针文件里读出 `size N`（期望字节数）。读不到返回 null（调用方退回下限判据）。
export function expectedTrackingBytes(pointerPath) {
  try {
    const m = /^size (\d+)$/m.exec(readFileSync(pointerPath, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// 一场 tracking 是否已完整落盘。
// expected 给定时按**精确字节数**判定（唯一可靠的判据，见上方注释）；否则退回
// 「够大且不是 LFS 指针」的弱判据（仅当拿不到指针时有意义）。
export function isCompleteTracking(path, expected = null) {
  if (!existsSync(path)) return false;
  try {
    const size = statSync(path).size;
    if (expected != null) return size === expected;
    if (size < MIN_TRACKING_BYTES) return false;
    return !isLfsPointer(readFileSync(path));
  } catch {
    return false;
  }
}

function reportLocal() {
  let found = false;
  for (const ds of DATASETS) {
    const ok = existsSync(ds.dir);
    console.log(`${ok ? '✓' : '✗'} ${ds.key} → ${ds.dir}`);
    if (!ok) continue;
    found = true;
    if (ds.kind === 'skillcorner') {
      const trackingDir = join(ds.dir, 'tracking');
      const files = existsSync(trackingDir) ? readdirSync(trackingDir).filter((f) => f.endsWith('.jsonl')) : [];
      const complete = files.filter((f) => isCompleteTracking(join(trackingDir, f)));
      console.log(`    - tracking 实体 ${complete.length}/${files.length} 场完整`);
      console.log(`    - 骨架 ${existsSync(join(ds.dir, 'opendata-master', 'data', 'matches.json')) ? '已就位' : '缺失'}`);
    } else {
      const gameDirs = ['Sample_Game_1', 'Sample_Game_2', 'Sample_Game_3'];
      for (const g of gameDirs) {
        const p = join(ds.dir, 'data', g);
        if (existsSync(p)) console.log(`    - ${g}`);
      }
    }
  }
  return found;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const onlyIdx = process.argv.indexOf('--dataset');
  const onlyKey = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  console.log(checkOnly ? '=== 本地已有 ===' : '=== 拉取公开 tracking 数据集 ===');
  if (!checkOnly) {
    const selected = onlyKey ? DATASETS.filter((d) => d.key === onlyKey) : DATASETS;
    if (onlyKey && selected.length === 0) {
      console.error(`未知数据集 ${onlyKey}；可选：${DATASETS.map((d) => d.key).join(', ')}`);
      process.exit(1);
    }
    let allOk = true;
    for (const ds of selected) allOk = (await fetchDataset(ds)) && allOk;
    console.log('');
    if (!allOk) process.exitCode = 1;
  }
  reportLocal();
  if (!checkOnly) {
    console.log('\n下一步：把某场转成 viewer 能吃的帧序列，例如');
    console.log(`  node tools/convert-tracking-to-frames.mjs --in ${join(DEST, 'sample-data', 'data', 'Sample_Game_1')} --out viewer/data/real-game-1.json --keyframe-hz 5`);
    console.log(`  node tools/convert-skillcorner-to-frames.mjs --match ${join(DEST, 'skillcorner', 'opendata-master', 'data', 'matches', '1874553', '1874553_match.json')} --out viewer/data/skillcorner-game.json`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
