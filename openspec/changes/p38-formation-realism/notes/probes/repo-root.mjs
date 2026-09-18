// 探针目录很深（openspec/changes/<change>/notes/probes/），用 `../..` 数层数
// 一改目录结构就断（已经踩过一次：多算/少算一层，报 ERR_MODULE_NOT_FOUND，
// 错因看起来像"文件不存在"而不是"路径层数写错"）。这里改为**向上找仓库根标志**
// （package.json + viewer/match-metrics.js），层数无关、移动探针目录也不断。

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件所在目录 = probes/ 的上溯起点（供只导出常量、不想再算一次的调用方用）。
export const P38_PROBES_DIR = dirname(fileURLToPath(import.meta.url));
// 仓库根（由本文件位置推出，与各探针传入的 HERE 同一判据）。
export const P38_REPO = findRepoRoot(P38_PROBES_DIR);

// 从 start 起逐级上溯，返回第一个同时含 package.json 与 viewer/match-metrics.js 的目录。
export function findRepoRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'viewer', 'match-metrics.js'))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`从 ${start} 上溯 12 级未找到仓库根（判据：package.json + viewer/match-metrics.js）`);
}
