#!/usr/bin/env node
// 拉取公开足球 tracking 数据集到本地（供"真实比赛对照"使用）。
//
// 数据入 .scratch/tracking-data/（.gitignore 已排除），不进仓库。
// 拉完用 convert-tracking-to-frames.mjs 转成 viewer 能吃的帧序列。
//
// 用法：
//   node tools/fetch-tracking-data.mjs            # 拉默认数据集（Metrica sample-data）
//   node tools/fetch-tracking-data.mjs --check    # 只报告本地已有什么，不下载

import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, '.scratch', 'tracking-data');

// 数据集清单。加新数据源时在这里追加。
const DATASETS = [
  {
    key: 'metrica-sample-data',
    label: 'Metrica Sports sample-data（3 场，25Hz，0-1 归一化坐标，105x68m）',
    repo: 'https://github.com/metrica-sports/sample-data',
    dir: join(DEST, 'sample-data'),
    // 只需要 data/ 与 documentation/，不拉 .git 全历史
    sparse: ['data', 'documentation'],
    license: '未声明正式许可；README 要求使用时注明来源并负责任使用（开发/研究用途）',
    source: 'https://github.com/metrica-sports/sample-data',
  },
];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function fetchDataset(ds) {
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

function reportLocal() {
  let found = false;
  for (const ds of DATASETS) {
    const ok = existsSync(ds.dir);
    console.log(`${ok ? '✓' : '✗'} ${ds.key} → ${ds.dir}`);
    if (ok) {
      found = true;
      const gameDirs = ['Sample_Game_1', 'Sample_Game_2', 'Sample_Game_3'];
      for (const g of gameDirs) {
        const p = join(ds.dir, 'data', g);
        if (existsSync(p)) console.log(`    - ${g}`);
      }
    }
  }
  return found;
}

const checkOnly = process.argv.includes('--check');
console.log(checkOnly ? '=== 本地已有 ===' : '=== 拉取公开 tracking 数据集 ===');
if (!checkOnly) {
  let allOk = true;
  for (const ds of DATASETS) allOk = fetchDataset(ds) && allOk;
  console.log('');
  if (!allOk) process.exitCode = 1;
}
reportLocal();
if (!checkOnly) {
  console.log('\n下一步：把某场转成 viewer 能吃的帧序列，例如');
  console.log(`  node tools/convert-tracking-to-frames.mjs --in ${join(DEST, 'sample-data', 'data', 'Sample_Game_1')} --out viewer/data/real-game-1.json --keyframe-hz 5`);
}
