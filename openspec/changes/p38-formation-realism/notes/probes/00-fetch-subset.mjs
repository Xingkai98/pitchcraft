// P38 真实队形规律调研：下载 SkillCorner 子样本（6 场）。
//
// 数据来源：SkillCorner/opendata（MIT），https://github.com/SkillCorner/opendata
//   - 骨架（matches.json + 每场 match.json）：codeload tar.gz，~25.7MB
//   - tracking 实体（LFS，走 media 通道，master 分支不是 main）：单场 ~90MB
//
// 复用仓库既有工具 tools/fetch-tracking-data.mjs 的 fetchSkillcorner()——
// 它自带「按 LFS 指针声明字节数精确校验 + 断点续传 + 重试」的逻辑，别自己重写
// （那条逻辑踩过坑：截断下载被误判为完整）。
//
// 本脚本只做一件事：把 20 场全量缩到 6 场，覆盖三种球场尺寸（104/105/106），
// 球队尽量分散（12 个出场名额、8 家俱乐部）。
//
// 运行：
//   node openspec/changes/p38-formation-realism/notes/probes/00-fetch-subset.mjs
//
// 下载落点：<repo>/.scratch/tracking-data/skillcorner/（.gitignore 已排除）
//   skeleton: .scratch/tracking-data/skillcorner/opendata-master/
//   tracking: .scratch/tracking-data/skillcorner/tracking/<id>_tracking_extrapolated.jsonl
//
// 如需换场次，改 SUBSET。全部 20 场见
//   .scratch/tracking-data/skillcorner/opendata-master/data/matches.json

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSkillcorner } from '../../../../../tools/fetch-tracking-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');

// 选场依据（逐场球场尺寸来自各场 match.json 的 pitch_length）：
//   1874553 105×68  Brisbane FC vs Adelaide United
//   1886347 104×68  Auckland FC vs Newcastle
//   1899585 104×68  Auckland FC vs Wellington P FC
//   1959846 106×68  Melbourne V FC vs Western United
//   2007448 105×68  Perth Glory vs Brisbane FC
//   2013725 106×68  Western United vs Sydney FC
// 2 场 / 尺寸档，覆盖赛季早中晚三段；1953632（status=not_started）不取。
export const SUBSET = ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];

const ds = {
  key: 'skillcorner-opendata',
  label: 'SkillCorner opendata（20 场，10fps 广播 CV，澳超 2024/25）',
  kind: 'skillcorner',
  repo: 'https://github.com/SkillCorner/opendata',
  dir: join(ROOT, '.scratch', 'tracking-data', 'skillcorner'),
  license: 'MIT（仓库根 LICENSE）',
  source: 'https://github.com/SkillCorner/opendata',
};

const ok = await fetchSkillcorner(ds, { ids: SUBSET });
process.exitCode = ok ? 0 : 1;
