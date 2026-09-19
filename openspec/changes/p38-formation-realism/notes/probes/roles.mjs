// P38：把 SkillCorner 的**真实位置标签**接到统一帧的球员 id 上。
//
// 为什么需要：统一帧的 id 是**按平均深度排的槽位**（转换器 assignSkillcornerIds：
// 最深者得 id 1，最前者得 id 10），不是位置身份。若按 id 分组当"防线/中场/锋线"，
// 那是 probe1 犯过的错（用整场平均值近似瞬时身份）。SkillCorner 的 match.json 里
// 每个球员带 `player_role.position_group`，而转换产物的 `meta.idMap` 给出
// 槽位 ↔ 原生 player_id 的双射，两者对接即可得到**真实位置**分组。
//
// 口径与限制（必须与报告一致）：
//   - 槽位的位置标签取**该槽位首发球员**的 position_group。替补顶槽位时沿用该槽位的
//     标签（"替补顶的是位置，不是身份"）——转换器的 idMap 只含首发，故替补在
//     match.json 里的自身标签取不到，也不必取。
//   - position_group 只有 6 个值（实测 6 场汇总）：
//       Central Defender / Full Back / Midfield / Wide Attacker / Center Forward / Other
//     **`Other` 包含门将与替补**（转换器注释已记：门将的 position_group 是 "Other"），
//     故门将不能用 position_group 判，须用 player_role.name === 'Goalkeeper'。
//   - 因此本模块只给**非门将首发**打位置标签；`Other` 的非门将槽位（改打位置/非常规）
//     标为 'Unknown'，探针会如实报告有多少帧的槽位是 Unknown。
//
// Metrica 无位置标签（转换器按深度分槽），故位置分线分析**仅 SkillCorner**；
// Metrica 只参与次序统计量口径的分析（与引擎可比）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot(HERE);
const SCAFFOLD = join(REPO, '.scratch', 'tracking-data', 'skillcorner', 'opendata-master', 'data', 'matches');
const P38_FRAMES = join(REPO, '.scratch', 'p38-frames');

// 位置 → 线。三个"线"的定义（本报告全部沿用）：
//   后防 = Central Defender ∪ Full Back（中卫 + 边卫，即真实的"后卫线"）
//   中场 = Midfield
//   锋线 = Wide Attacker ∪ Center Forward（边锋 + 中锋）
export const LINE_OF_GROUP = {
  'Central Defender': 'defence',
  'Full Back': 'defence',
  Midfield: 'midfield',
  'Wide Attacker': 'attack',
  'Center Forward': 'attack',
};

export const LINE_NAMES = ['defence', 'midfield', 'attack'];

function isGk(player) {
  return !!(player && player.player_role && player.player_role.name === 'Goalkeeper');
}

// 一场 SkillCorner 比赛的角色表。
// 返回 { roleById: Map<统一 id(0-21), {group, line, name}>, shape: {...} }
//   roleById 覆盖该场全部 22 个槽位（含门将，line=null）。
export function loadSkillcornerRoles(id) {
  const convPath = join(P38_FRAMES, `skillcorner-${id}.json`);
  const matchPath = join(SCAFFOLD, id, `${id}_match.json`);
  if (!existsSync(convPath)) throw new Error(`缺少转换产物 ${convPath}（先跑 01-convert-subset.mjs）`);
  if (!existsSync(matchPath)) throw new Error(`缺少 match.json ${matchPath}（先跑 00-fetch-subset.mjs）`);

  const conv = JSON.parse(readFileSync(convPath, 'utf8'));
  const match = JSON.parse(readFileSync(matchPath, 'utf8'));
  const byNativeId = new Map(match.players.map((p) => [p.id, p]));

  const roleById = new Map();
  const shape = { home: {}, away: {} };
  for (const side of ['home', 'away']) {
    const map = conv.meta.idMap[side];
    if (!map) throw new Error(`${id} 的转换产物缺 meta.idMap.${side}`);
    for (const [nativeId, uid] of Object.entries(map)) {
      const p = byNativeId.get(Number(nativeId));
      if (!p) continue;
      const group = p.player_role && p.player_role.position_group;
      const line = LINE_OF_GROUP[group] || null;
      const gk = isGk(p);
      roleById.set(uid, {
        group: gk ? 'Goalkeeper' : (group || 'Unknown'),
        line: gk ? null : line,
        name: p.short_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      });
      if (gk) continue;
      const key = line || 'unknown';
      shape[side][key] = (shape[side][key] || 0) + 1;
    }
  }
  return { id, roleById, shape, homeSides: match.home_team_side };
}

// 全部 SkillCorner 子样本的角色表（逐场）。返回 Map<id, loadSkillcornerRoles 结果>。
export function loadAllSkillcornerRoles(ids) {
  const out = new Map();
  for (const id of ids) out.set(id, loadSkillcornerRoles(id));
  return out;
}

// 一帧某队**带位置标签的逐人条目**（用于「位置 ↔ 次序排名」与横向通道分析）。
// 返回 [{ id, x, y, line, group }]：x 已统一到"离本方门线距离"（客队镜像），
// y 是原始米制（主客共用同一条 y 轴，**不镜像**）。外推点默认跳过。
// 与 linesOfFrame 用同一份坐标与同一套过滤——两者只差聚合方式，不差口径。
export function labelledEntries(frame, team, roleById, { includeExtrapolated = false } = {}) {
  const isHome = team === 'home';
  const [L, W] = frame.pitchMeters || [105, 68];
  const out = [];
  for (const p of (frame && frame.players) || []) {
    if (!p) continue;
    const mine = isHome ? p.id <= 10 : p.id >= 11;
    if (!mine) continue;
    if (!includeExtrapolated && p.extrapolated === true) continue;
    const role = roleById.get(p.id);
    if (!role || role.group === 'Goalkeeper') continue;
    let x = p.x * L;
    if (!isHome) x = L - x;
    out.push({ id: p.id, x, y: p.y * W, line: role.line, group: role.group });
  }
  return out;
}

// 一帧某队的**按线分组**的 x（米，统一到"离本方门线距离"）。
// 返回 { defence: [x...], midfield: [...], attack: [...], unknown: n, keeper: x|null }
//   - 只有位置标签已知的球员进对应线；Unknown 的计入 unknown 计数。
//   - 客队自动镜像（x → 该场长度 − x）。
//   - 外推点默认跳过（与 match-metrics 主口径一致）。
export function linesOfFrame(frame, team, roleById, { includeExtrapolated = false } = {}) {
  const isHome = team === 'home';
  const [L] = frame.pitchMeters || [105, 68];
  const out = { defence: [], midfield: [], attack: [], unknown: 0, keeper: null };
  const players = (frame && frame.players) || [];
  let n = 0;
  for (const p of players) {
    if (!p) continue;
    const mine = isHome ? p.id <= 10 : p.id >= 11;
    if (!mine) continue;
    if (!includeExtrapolated && p.extrapolated === true) continue;
    let x = p.x * L;
    if (!isHome) x = L - x;
    const role = roleById.get(p.id);
    if (!role || role.group === 'Goalkeeper') {
      // 门将单独记（不参与队形）；无标签的也单独记
      if (role && role.group === 'Goalkeeper') out.keeper = x;
      else out.unknown += 1;
      continue;
    }
    n += 1;
    const line = role.line;
    if (line && out[line]) out[line].push(x);
    else out.unknown += 1;
  }
  out.outfieldKnown = out.defence.length + out.midfield.length + out.attack.length;
  return out;
}
