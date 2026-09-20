// P38 #89：门变体的**批量扫参**（快车道 only：判据组 + JS 侧犯规/射门，不含 200 场 L1）。
//
// 一次 build 只服务一个配置（源码变了必须重编），所以这里按顺序跑、每个配置一次
// run-exp89（`--no-l1`）。**判定**必须回 L1 门；本脚本只用于排方向（见 run-exp89.mjs 注释）。
//
// 用法：node sweep-exp89.mjs [名单文件.json]
//   名单格式：[{ "form": "exp4b", "gate": "positionGate:{\"radius\":25,\"meters\":0.5}", "tag": "a" }]

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const listPath = process.argv[2] || join(HERE, 'exp89-sweep.json');
if (!existsSync(listPath)) { console.error(`缺 ${listPath}`); process.exit(1); }
const list = JSON.parse(readFileSync(listPath, 'utf8'));

const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const rows = [];
for (const cfg of list) {
  const args = [join(HERE, 'run-exp89.mjs'), cfg.form || '-', cfg.gate || '-', cfg.tag, '--no-l1'];
  const r = spawnSync('node', args, { env, encoding: 'utf8', timeout: 600000 });
  const line = (r.stdout || '').trim().split('\n').pop();
  let j = null;
  try { j = JSON.parse(line); } catch {
    console.error(`[${cfg.tag}] 解析失败：${(r.stdout || '').slice(-400)}\n${(r.stderr || '').slice(-400)}`);
    continue;
  }
  rows.push(j);
  console.log(`[${cfg.tag}] 纵深 ${j.hd} 射门 ${j.qShots} 犯规 ${j.qFouls} 抢断 ${j.qTackles} `
    + `判据组 latSd ${j.latSd} swarm ${j.swarm} fault ${j.fault} midBack ${j.midBack} gap ${j.gap} spread ${j.spread}`);
}
// 判据组 8 条逐条判（下界单边 + 带）
const SPEC = JSON.parse(readFileSync(join(HERE, '../criteria/criteria-spec.json'), 'utf8'));
const pass = (r) => {
  const bad = [];
  for (const c of SPEC.criteria) {
    const v = r[c.key];
    if (!Number.isFinite(v)) { bad.push(`${c.key}:NaN`); continue; }
    if (c.dir === 'min') { if (v < c.floor) bad.push(`${c.key}:${v}<${c.floor}`); }
    else if (v < c.lower || v > c.upper) bad.push(`${c.key}:${v}∉[${c.lower},${c.upper}]`);
  }
  return bad;
};
console.log('\n=== 判据组（8 条，成组否决）===');
for (const r of rows) {
  const bad = pass(r);
  console.log(`${(r.tag || '').padEnd(26)} ${bad.length === 0 ? '✅ 通过' : `❌ ${bad.join('  ')}`}`);
}
