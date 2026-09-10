// 观察包采集（P10 viewer 切片）。
// 纯函数、浏览器与 Node 均可运行。从当前 Game 对象构建版本化 ObservationBundle，
// 提供 audit_input（米制 + viewer 可观测特征推导）与 CLI 重放命令模板。
// 不含凭证、不做网络请求、不依赖 WASM。

import { deriveAuditInput } from './derive-audit-features.js';

export const OBSERVATION_SCHEMA_VERSION = '1';

// 本地诊断服务默认端口（tools/service.mjs 的 DEFAULT_PORT）。
export const OBSERVATION_SERVICE_PORT = 8787;

// 由页面来源 hostname 推导本地诊断服务端点（纯函数、可测）：
// - localhost / 127.0.0.1 / 空 → http://127.0.0.1:8787（本机 loopback）；
// - 其他 hostname（如 tailscale 网内地址 100.114.76.34 或域名）→
//   http://<hostname>:8787，让页面自动指向服务所在机器，无需手工配置。
export function deriveDiagnosisEndpoint(hostname) {
  const h = String(hostname ?? '').trim();
  if (h === '' || h === 'localhost' || h === '127.0.0.1') {
    return `http://127.0.0.1:${OBSERVATION_SERVICE_PORT}`;
  }
  return `http://${h}:${OBSERVATION_SERVICE_PORT}`;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// 深克隆：结构是数组/普通对象/基本类型；不处理函数/类实例（bundle 只存数据）。
function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

// 默认 id/时钟生成器（浏览器用 crypto.randomUUID；不可用时退回计数器+时间）。
// 测试通过 opts 注入确定性的 idFactory / now，避免随机性。
const DEFAULT_ID_FACTORY = (() => {
  let counter = 0;
  return () => {
    counter += 1;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const t = typeof Date === 'function' ? Date.now() : 0;
    return `obs-${t}-${counter}`;
  };
})();

const DEFAULT_CLOCK = () => (typeof Date === 'function' ? Date.now() : 0);

// 收集观察窗口内的 viewer 事件：t ∈ [matchTime-before, matchTime+after]。
// 前置 lineup/kickoff 事件（若有）始终带上，作为重放/审计的站位上下文。
// 每个事件附带它在完整事件流里的 `index`，供审计 finding 跳回原比赛时刻。
function collectWindowEvents(game, matchTime, win) {
  const lo = matchTime - win.before;
  const hi = matchTime + win.after;
  const out = [];
  (game.events ?? []).forEach((e, i) => {
    if (e.type === 'lineup' || e.type === 'kickoff') {
      if (out.length === 0) out.push({ ...e, index: i });
      return;
    }
    if (e.t >= lo && e.t <= hi) out.push({ ...e, index: i });
  });
  return out;
}

// 当前帧快照：球员位置 + 球位置 + 事件索引/播放时刻。全部克隆，后续游戏态变更不影响 bundle。
function buildViewerSnapshot(game, matchTime, eventIndex) {
  return {
    match_time: round3(matchTime),
    current_event_index: eventIndex,
    event_count: game.events?.length ?? 0,
    play_time: round3(matchTime),
    players: (game.players ?? []).map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y })),
    ball: { x: game.ball?.x ?? null, y: game.ball?.y ?? null },
  };
}

// 解析 opts.now：既支持传入值（时间戳/ISO 串），也支持传入函数（测试常用注入风格）。
function resolveNow(nowOpt) {
  if (typeof nowOpt === 'function') return nowOpt();
  return nowOpt ?? DEFAULT_CLOCK();
}

// 凭证形值（任意键下的串）：Claude sk-ant-*/sk-proj-*、GitHub ghp_*（20+ 字母数字）、
// github_pat_*（20+ body）。browser 无法知道存活 key，只能按形状识别；过度抹除是安全方向。
// 覆盖采集 statement、CLI 模板、导出/提交 bundle 的所有展示与输出路径。
const CREDENTIAL_VALUE_SRC =
  'sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}';
const CREDENTIAL_VALUE_RE = new RegExp(CREDENTIAL_VALUE_SRC);
const CREDENTIAL_VALUE_GLOB_RE = new RegExp(CREDENTIAL_VALUE_SRC, 'g');

// 抹除明显的凭证形片段（sk-ant-*/sk-proj-*/ghp_*/github_pat_*）。
// 采集的 statement / CLI 模板值先经此清理，保证 bundle 与模板不含此类凭证形文本。
// 导出：app.js（提交时重读描述）与测试复用同一口径。
export function redactCredentialText(s) {
  return String(s ?? '').replace(CREDENTIAL_VALUE_GLOB_RE, '[REDACTED]');
}

// 提交诊断时的最终描述（P15）：以「提交时输入框」为权威——非空（抹除凭证后）覆盖采集时
// 冻结的初值，空则保留冻结值。覆盖两种流程：(a) 采集前已输入、采集后输入框被清空且提交时
// 未改 → 保留 frozen；(b) 采集后才输入描述 → 覆盖。
export function resolveSubmitStatement(frozen, current) {
  const next = redactCredentialText(String(current ?? '').trim());
  return next !== '' ? next : String(frozen ?? '');
}

// 凭证键名（递归）：browser 端不知道存活 key 值，按键名保守抹除。与 tools/bundle.mjs
// 同口径——归一化 key 为小写字母数字后，包含 apikey/token/secret/authorization 任一
// 即视为凭证键（覆盖 ANTHROPIC_API_KEY、my_api_key、accessToken、clientSecret、authToken 等）。
function normalizeSecretKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isSecretKeyName(key) {
  const n = normalizeSecretKey(key);
  return n.includes('apikey') || n.includes('token') || n.includes('secret') || n.includes('authorization');
}

// 浏览器导出/提交 bundle 前的深度抹除：任意层级的凭证键名整体替换为 [REDACTED]，
// 凭证形 string 值替换为 [REDACTED]。这是防泄漏的第一道网；runner 侧的
// assertNoCredentials 校验仍然权威（泄露即拒收）。
export function redactBundleForExport(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return value.replace(CREDENTIAL_VALUE_GLOB_RE, '[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(redactBundleForExport);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKeyName(k)) out[k] = '[REDACTED]';
    else out[k] = redactBundleForExport(v);
  }
  return out;
}

// 引擎/事件流侧可用的 MVP 快照：反映 viewer 可见的引擎事实（事件流来源、时刻、
// 事件位置/总数、窗口、lineup）。只记录事件流里可推导的真相，绝不伪造隐藏引擎状态。
function buildEngineSnapshot(game, matchTime, win) {
  return {
    kind: 'event-stream',
    source: 'engine-event-stream',
    match_time: round3(matchTime),
    current_event_index: game?.currentEventIndex?.() ?? 0,
    event_count: game?.events?.length ?? 0,
    window: { before: win.before, after: win.after },
    lineup: deepClone(game?.lineup ?? []),
  };
}

// 选中实体回退：显式给定时原样返回（克隆）；为空时从当前事件参与者推导
// （currentHighlightParticipants 优先，其次当前事件的 subject/from/to），
// 让观察更好地锚定到正在发生的动作。
export function resolveObservationSelection(selectedEntities, game) {
  if (Array.isArray(selectedEntities) && selectedEntities.length > 0) {
    return selectedEntities.slice();
  }
  const candidates = [];
  for (const id of game?.currentHighlightParticipants?.() ?? []) {
    if (typeof id === 'number') candidates.push(id);
  }
  if (candidates.length > 0) return candidates;
  const e = game?.events?.[game?.currentEventIndex?.() ?? 0];
  if (e) {
    for (const k of ['subject', 'from', 'to']) {
      if (typeof e[k] === 'number') candidates.push(e[k]);
    }
  }
  return candidates;
}

// 从当前 Game 状态构建版本化 ObservationBundle。
// opts: { idFactory, now } 供测试注入确定性 id/时钟（now 支持值或函数）。
// bundle 携带 audit_input（米制事件 + 球员快照），供 runner 直接审计，避免把
// 归一化 [0,1] 坐标误当米。detector 专属字段无证据时保持缺失 → 审计输出 unknown。
export function captureObservation({
  game,
  statement = '',
  selectedEntities = [],
  window: win = { before: 5, after: 5 },
  seed,
  config,
  sourceRevision = null,
  opts = {},
}) {
  const idFactory = opts.idFactory ?? DEFAULT_ID_FACTORY;
  const now = resolveNow(opts.now);
  const matchTime = game?.playTime ?? 0;
  const eventIndex = game?.currentEventIndex?.() ?? 0;
  // 未注入具体版本时用占位符兜底：它标记「待填」，不是真实修订的证明。
  const revision =
    typeof sourceRevision === 'string' && sourceRevision.length > 0
      ? sourceRevision
      : '<source-revision>';

  const bundle = {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observation_id: idFactory(),
    seed,
    config: deepClone(config ?? {}),
    match_time: round3(matchTime),
    window: { before: win.before, after: win.after },
    source_revision: revision,
    selected_entities: resolveObservationSelection(selectedEntities, game),
    statement: redactCredentialText(statement),
    events: collectWindowEvents(game, matchTime, win).map(deepClone),
    lineup: deepClone(game?.lineup ?? []),
    engine_snapshot: buildEngineSnapshot(game, matchTime, win),
    viewer_snapshot: buildViewerSnapshot(game, matchTime, eventIndex),
    captured_at: now,
  };
  // 让导出/提交的 bundle 直接带上审计输入（米制），runner 据此审计而非原始归一化坐标。
  bundle.audit_input = buildAuditInput({ game, bundle, config });
  return bundle;
}

// 归一化坐标 → 米：x 沿 pitch.lengthMeters，y 沿 pitch.widthMeters。
function metersFor(config) {
  return {
    length: config?.pitch?.lengthMeters ?? 105,
    width: config?.pitch?.widthMeters ?? 68,
  };
}

// 构建审计输入（detectors 消费的米制事件 + 球员快照）。
// 对 viewer 可观测事实做特征推导（最近防守者距离、传球走廊/拦截、责任/静止），
// 无法观测的引擎内部决策保持缺失 → 审计输出 unknown，而非伪造结论。
// 推导只使用事件流 + 锚点位置（几何事实），推导来源在 features_derived 中标注。
export function buildAuditInput({ game, bundle, config }) {
  const m = metersFor(config);
  return deriveAuditInput({
    events: bundle?.events ?? [],
    timeline: game?.timeline ?? [],
    lineup: game?.lineup ?? [],
    pitch: { length: m.length, width: m.width },
    defaults: {
      passSpeed: config?.defaults?.passSpeed ?? 10,
      dribbleSpeed: config?.defaults?.dribbleSpeed ?? 3,
      shotSpeed: config?.defaults?.shotSpeed ?? 20,
    },
    window: bundle?.window ?? { before: 5, after: 5 },
    matchTime: bundle?.match_time ?? 0,
  });
}

// POSIX 单引号 shell 转义：整个串包单引号，内部的 ' 替换为 '\''。
// 对任意内容（空串、换行、$()、反引号、$VAR、反斜杠、双引号）都安全——单引号内不展开。
function shellQuote(v) {
  if (v === '') return "''";
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// CLI 重放/审计命令模板。浏览器不知道 bundle 落盘路径，用显式占位符。
// 不含任何凭证。statement/revision 来自用户输入，先抹除凭证形片段，再单引号转义。
// 占位符也全部单引号包裹：`<...>` 在 shell 里是重定向，裸占位符粘贴执行不安全；
// 用户替换占位符时保留单引号即可（`--bundle 'obs.json'`）。
// 注释行必须单独成行、不能带行继续符：POSIX 在处理注释前先处理反斜杠-换行，
// 若把注释行也 `\` 续行，`node tools/runner-cli.mjs` 会被并进注释、整段被注释掉。
export function buildCliCommandTemplate({ revision = '<source-revision>', statement = '' } = {}) {
  const safeRevision = redactCredentialText(revision);
  const safeStatement = redactCredentialText(statement);
  const comment =
    '# Paste-safe template: replace each <placeholder> (keep the single quotes), then run from the repo root.';
  const lines = [
    'node tools/runner-cli.mjs',
    `  --bundle ${shellQuote('<observation-bundle.json>')}`,
    `  --audit ${shellQuote('<audit-report.json>')}`,
    `  --replay ${shellQuote('<replay or verification instructions>')}`,
    `  --revision ${shellQuote(safeRevision)}`,
    `  --tasks-dir ${shellQuote('<tasks-dir>')}`,
  ];
  if (safeStatement && safeStatement.length > 0) {
    lines.push(`  --statement ${shellQuote(safeStatement)}`);
  }
  return `${comment}\n${lines.join(' \\\n')}`;
}
