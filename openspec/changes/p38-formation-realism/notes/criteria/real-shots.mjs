// P38 #91 阶段 1：从真实比赛的事件表里数**普通射门**，产出 `real-shots.json`。
//
// 为什么单独一个探针：真实侧射门数**不在** `viewer/data/real-game-*.json` 里——
// 那是坐标帧序列（转换器只保留位置），射门只存在于 Metrica 的 RawEventsData.csv。
// 而那份 CSV 在 `.scratch/tracking-data/`（gitignored、190MB 级），**不能**让评测器依赖它。
// 故：本探针一次性把「每场普通射门数」提炼成一个小 JSON 入库（含 provenance 哈希），
// 评测器（eval-criteria.mjs --real）只读那个 JSON——确定性、可离线、口径可审计。
//
// 口径（与引擎侧对齐，见 README「射门口径」一节）：
//   - 普通射门 = SHOT 事件中**非头球**的（`Subtype` 不含 `HEAD`）
//   - 真实 `Subtype` 里头球有四种写法（HEAD-OFF TARGET-OUT / HEAD-ON TARGET-SAVED /
//     HEAD-WOODWORK-OUT / OFF TARGET-HEAD-OUT）——**用子串 'HEAD' 判定**，别用前缀
//   - BLOCKED 计入（被挡的封堵仍是一次起脚；引擎侧没有对应 detail，不构成口径分叉）
//
// 用法：
//   node real-shots.mjs                     # 自动找本仓 .scratch/tracking-data 下的 CSV
//   node real-shots.mjs /path/to/data       # 指定 Sample_Game_{1,2} 所在目录
//   METRICA_EVENTS_DIR=... node real-shots.mjs
//
// ⚠️ 脚本内**不硬编码任何 worktree 绝对路径**（本 campaign 踩过两次），一律从脚本位置
// 上溯到本仓根，再在本仓内找数据。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));          // …/notes/criteria
const ROOT = join(HERE, '../../../../..');                     // 仓库根

const dir = process.argv[2] || process.env.METRICA_EVENTS_DIR
  || join(ROOT, '.scratch/tracking-data/sample-data/data');

const isHeader = (subtype) => subtype.toUpperCase().includes('HEAD');

// 最小 CSV 解析：Metrica 的事件表字段有引号包裹（`"OFF TARGET-OUT"` 之类），
// 逗号分隔且无内嵌换行——按行切 + 逐字段去引号即可，不引入依赖。
function parseEventsCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const iType = head.indexOf('Type');
  const iSub = head.indexOf('Subtype');
  if (iType < 0 || iSub < 0) throw new Error(`事件表缺 Type/Subtype 列：${head.join('|')}`);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split(',');
    out.push({ type: cells[iType].replace(/"/g, ''), subtype: cells[iSub].replace(/"/g, '') });
  }
  return out;
}

const games = [];
for (const g of [1, 2]) {
  const p = join(dir, `Sample_Game_${g}`, `Sample_Game_${g}_RawEventsData.csv`);
  if (!existsSync(p)) {
    console.error(`缺 ${p}\n（真实事件表在 .scratch/tracking-data/ 下，属 gitignored；`
      + '本仓没有时从主仓库拷 Sample_Game_*_RawEventsData.csv，或用参数指定目录）');
    process.exit(1);
  }
  const raw = readFileSync(p);
  const evs = parseEventsCsv(raw.toString('utf8'));
  const shots = evs.filter((e) => e.type === 'SHOT');
  const headers = shots.filter((e) => isHeader(e.subtype));
  games.push({
    game: g,
    shotsTotal: shots.length,
    shotsHeader: headers.length,
    shotsRegular: shots.length - headers.length,
    source: `Sample_Game_${g}_RawEventsData.csv`,
    sourceSha256: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  });
  const r = games[games.length - 1];
  console.log(`game${g}: SHOT ${r.shotsTotal} = 普通 ${r.shotsRegular} + 头球 ${r.shotsHeader}`);
}

const doc = {
  note: '真实（Metrica 2 场）每场**普通射门**原始计数。由 real-shots.mjs 从 RawEventsData.csv 提炼；'
    + '评测器只读本文件（CSV 是 gitignored 的大文件，不进依赖）。',
  caliber: '普通射门 = Type==SHOT 且 Subtype 不含 HEAD；BLOCKED 计入',
  eventsDir: dir.replace(`${ROOT}/`, '<ROOT>/'),
  games,
};
writeFileSync(join(HERE, 'real-shots.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`\n→ real-shots.json（普通射门 ${games.map((x) => x.shotsRegular).join(' / ')}）`);
