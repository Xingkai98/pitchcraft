// viewer/observation.js 纯函数单测（无 DOM、无 WASM、无网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';
import {
  OBSERVATION_SCHEMA_VERSION,
  captureObservation,
  buildAuditInput,
  buildCliCommandTemplate,
  resolveObservationSelection,
  redactBundleForExport,
  deriveDiagnosisEndpoint,
} from './observation.js';
import { validateObservationBundle } from '../tools/bundle.mjs';

const MATCH_CONFIG = { match_duration_seconds: 2700, demo_mode: false };

function makeGame() {
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [
      { id: 0, x: 0.02, y: 0.5 }, { id: 1, x: 0.18, y: 0.3 },
    ]},
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 3, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.45, y2: 0.5, speed: 8, result: 'success' },
    { t: 6, type: 'pass', subject: 5, from: 5, to: 2, x: 0.45, y: 0.5, x2: 0.35, y2: 0.5, speed: 7, result: 'success' },
    { t: 9, type: 'dribble', subject: 2, x: 0.35, y: 0.5, x2: 0.45, y2: 0.45, speed: 3, result: 'success' },
  ];
  return new Game(events, [], 'continuous');
}

const deterministic = () => ({
  idFactory: (() => { let n = 0; return () => `obs-${++n}`; })(),
  now: 1700000000000,
});

test('deriveDiagnosisEndpoint maps localhost/127.0.0.1/empty to the loopback service', () => {
  assert.equal(deriveDiagnosisEndpoint('localhost'), 'http://127.0.0.1:8787');
  assert.equal(deriveDiagnosisEndpoint('127.0.0.1'), 'http://127.0.0.1:8787');
  assert.equal(deriveDiagnosisEndpoint(''), 'http://127.0.0.1:8787');
  assert.equal(deriveDiagnosisEndpoint('  '), 'http://127.0.0.1:8787');
  assert.equal(deriveDiagnosisEndpoint(undefined), 'http://127.0.0.1:8787');
  assert.equal(deriveDiagnosisEndpoint(null), 'http://127.0.0.1:8787');
});

test('deriveDiagnosisEndpoint targets the page hostname for tailscale/domain hosts', () => {
  // tailscale 网内地址：页面自动指向服务所在机器，无需手工配置端点。
  assert.equal(deriveDiagnosisEndpoint('100.114.76.34'), 'http://100.114.76.34:8787');
  assert.equal(deriveDiagnosisEndpoint('my-mac.tailnet.ts.net'), 'http://my-mac.tailnet.ts.net:8787');
  assert.equal(deriveDiagnosisEndpoint('example.com'), 'http://example.com:8787');
});

test('captureObservation builds a valid bundle with all required fields', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({
    game,
    statement: '传球时防守队员完全不干扰',
    selectedEntities: [9, 5],
    window: { before: 5, after: 5 },
    seed: 42,
    config: MATCH_CONFIG,
    sourceRevision: 'abc123',
    opts: deterministic(),
  });
  assert.equal(b.schema_version, OBSERVATION_SCHEMA_VERSION);
  assert.equal(b.observation_id, 'obs-1');
  assert.equal(b.seed, 42);
  assert.equal(b.match_time, 6);
  assert.equal(b.source_revision, 'abc123');
  // engine_snapshot reflects the event-stream truth available to the viewer.
  assert.equal(b.engine_snapshot.kind, 'event-stream');
  assert.equal(b.engine_snapshot.match_time, 6);
  assert.equal(b.engine_snapshot.current_event_index, game.currentEventIndex());
  assert.equal(b.engine_snapshot.event_count, game.events.length);
  assert.deepEqual(b.engine_snapshot.window, { before: 5, after: 5 });
  assert.deepEqual(b.selected_entities, [9, 5]);
  assert.deepEqual(b.window, { before: 5, after: 5 });
  // window events: t in [1,11] 排除 lineup/kickoff(非窗口)，但 lineup 应带在最前
  assert.equal(b.events[0].type, 'lineup');
  const passes = b.events.filter((e) => e.type === 'pass');
  assert.equal(passes.length, 2);
  // 校验通过现有 bundle validator（含凭证检查）
  const { valid, errors } = validateObservationBundle(b);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('captureObservation attaches audit_input with meter events and pass_distance, and still validates', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  // audit_input present with meter events
  assert.ok(b.audit_input, 'bundle must carry audit_input');
  assert.ok(Array.isArray(b.audit_input.events));
  const pass = b.audit_input.events.find((e) => e.type === 'pass' && e.t === 3);
  assert.equal(pass.x, 52.5); // 0.5 * 105m
  assert.equal(pass.y, 34);   // 0.5 * 68m
  assert.ok(Math.abs(pass.pass_distance - 5.25) < 1e-9); // (0.5,0.5)->(0.45,0.5)
  // detector-specific fields stay absent (no fabricated evidence)
  assert.equal(pass.nearest_defender_distance, undefined);
  assert.equal(pass.corridor_distance, undefined);
  // bundle still passes the shared validator (incl. credential check on audit_input)
  const { valid, errors } = validateObservationBundle(b);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('captureObservation supports opts.now as a function (clock injection)', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({
    game,
    seed: 42,
    config: MATCH_CONFIG,
    opts: { idFactory: () => 'obs-fixed', now: () => '2026-08-26T00:00:00.000Z' },
  });
  assert.equal(b.captured_at, '2026-08-26T00:00:00.000Z');
  assert.equal(typeof b.captured_at, 'string');
  assert.equal(b.observation_id, 'obs-fixed');
});

test('resolveObservationSelection falls back to current event participants when empty', () => {
  const game = makeGame();
  game.seekTo(3); // pass 9 -> 5
  // explicit selection passes through
  assert.deepEqual(resolveObservationSelection([7], game), [7]);
  // empty falls back to highlight participants (pass from/to)
  const fallback = resolveObservationSelection([], game);
  assert.deepEqual(fallback, [9, 5]);
  // and is baked into the bundle when selection empty
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  assert.deepEqual(b.selected_entities, [9, 5]);
});

test('captureObservation viewer_snapshot carries current players/ball/index', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const vs = b.viewer_snapshot;
  assert.equal(vs.current_event_index, game.currentEventIndex());
  assert.equal(vs.play_time, 6);
  assert.equal(vs.event_count, 5);
  assert.ok(Array.isArray(vs.players));
  assert.ok(vs.players.every((p) => typeof p.x === 'number' && typeof p.y === 'number'));
  assert.equal(typeof vs.ball.x, 'number');
});

test('captureObservation defaults source_revision to the placeholder when none injected', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  assert.equal(b.source_revision, '<source-revision>');
  const { valid, errors } = validateObservationBundle(b);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('captureObservation redacts credential-shaped text from statement and CLI template', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({
    game,
    statement: '我的 key 是 sk-ant-abc123xyz，别发出去',
    seed: 42,
    config: MATCH_CONFIG,
    opts: deterministic(),
  });
  assert.doesNotMatch(b.statement, /sk-ant-/);
  assert.match(b.statement, /\[REDACTED\]/);
  const { valid, errors } = validateObservationBundle(b);
  assert.equal(valid, true, JSON.stringify(errors));

  const cmd = buildCliCommandTemplate({ revision: '<source-revision>', statement: 'sk-ant-abc123xyz' });
  assert.doesNotMatch(cmd, /sk-ant-/);
  assert.match(cmd, /\[REDACTED\]/);
});

test('capture statement and CLI template redact ghp_ tokens even without a key prefix', () => {
  const game = makeGame();
  game.seekTo(6);
  const ghp = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const b = captureObservation({
    game,
    statement: `token: ${ghp}`,
    seed: 42,
    config: MATCH_CONFIG,
    opts: deterministic(),
  });
  assert.doesNotMatch(b.statement, new RegExp(ghp));
  assert.doesNotMatch(b.statement, /ghp_/);
  const { valid, errors } = validateObservationBundle(b);
  assert.equal(valid, true, JSON.stringify(errors));

  const cmd = buildCliCommandTemplate({ revision: '<source-revision>', statement: `token: ${ghp}` });
  assert.doesNotMatch(cmd, new RegExp(ghp));
  assert.doesNotMatch(cmd, /ghp_/);
  assert.match(cmd, /\[REDACTED\]/);
});

test('captureObservation clones data so later game mutation does not leak into the bundle', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const originalBallX = b.viewer_snapshot.ball.x;
  // 改动 game（seek 会刷新球员/球位置）
  game.seekTo(9);
  assert.equal(b.viewer_snapshot.ball.x, originalBallX);
  assert.equal(b.match_time, 6);
  assert.deepEqual(b.config, MATCH_CONFIG);
});

test('captureObservation leaves detector-specific audit fields absent in viewer events', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const pass = b.events.find((e) => e.type === 'pass');
  // viewer 事件保留归一化坐标，且不伪造 detector 特征
  assert.ok(pass.x >= 0 && pass.x <= 1);
  assert.equal(pass.nearest_defender_distance, undefined);
  assert.equal(pass.corridor_distance, undefined);
});

test('buildAuditInput converts normalized coords to meters and adds pass_distance', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const input = buildAuditInput({ game, bundle: b, config: { pitch: { lengthMeters: 105, widthMeters: 68 } } });
  const pass = input.events.find((e) => e.type === 'pass');
  // (0.5,0.5)->(0.45,0.5): dx=-0.05*105=5.25m, dy=0 -> pass_distance=5.25
  assert.equal(pass.x, 52.5);
  assert.equal(pass.y, 34);
  assert.ok(Math.abs(pass.pass_distance - 5.25) < 1e-9);
  // 窗口内的 pass 事件归一化坐标均已转米
  assert.equal(input.events.find((e) => e.type === 'pass' && e.t === 3).x, 52.5);
});

test('buildAuditInput player snapshots are per-player meter timeline without responsibility flags', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({ game, seed: 42, config: MATCH_CONFIG, opts: deterministic() });
  const input = buildAuditInput({ game, bundle: b, config: { pitch: { lengthMeters: 105, widthMeters: 68 } } });
  // 至少一个球员有快照；坐标转米；无 responsibility 标记（→ detector unknown）
  const ids = Object.keys(input.players);
  assert.ok(ids.length > 0);
  const snap = input.players[ids[0]][0];
  assert.ok(snap.x > 1, 'player snapshot x should be in meters, not normalized');
  // 无 responsibility 标记（→ detector unknown，而非臆断站桩）
  assert.equal(snap.responsibility, undefined);
  assert.equal(snap.dead_ball, undefined);
});

test('buildCliCommandTemplate emits a secret-free paste-safe placeholder command', () => {
  const cmd = buildCliCommandTemplate({ revision: 'abc123', statement: '传球无干扰' });
  assert.match(cmd, /node tools\/runner-cli\.mjs/);
  // Placeholders are single-quoted so pasting is shell-inert (`<...>` would
  // otherwise be a redirection).
  assert.match(cmd, /--bundle '<observation-bundle\.json>'/);
  assert.match(cmd, /--revision 'abc123'/);
  assert.match(cmd, /--statement '传球无干扰'/);
  assert.doesNotMatch(cmd, /sk-ant|ANTHROPIC_API_KEY|api[_-]?key|secret|token/i);
});

test('buildCliCommandTemplate quotes every placeholder arg and warns it is a template', () => {
  const cmd = buildCliCommandTemplate();
  // 占位符全部单引号包裹 → 粘贴安全（裸 <...> 会被 shell 当作重定向）。
  assert.match(cmd, /--revision '<source-revision>'/);
  assert.match(cmd, /--bundle '<observation-bundle\.json>'/);
  assert.match(cmd, /--audit '<audit-report\.json>'/);
  assert.match(cmd, /--replay '<replay or verification instructions>'/);
  assert.match(cmd, /--tasks-dir '<tasks-dir>'/);
  // 显式非命令提示行。
  assert.match(cmd, /^# Paste-safe template:/);
  // 无 statement 时省略该行
  assert.doesNotMatch(cmd, /--statement/);
});

test('buildCliCommandTemplate keeps the warning comment on its own line (not line-continued)', () => {
  const cmd = buildCliCommandTemplate();
  const [first, second, ...rest] = cmd.split('\n');
  // POSIX 在处理注释前先处理反斜杠-换行：注释行绝不能以 \ 结尾，否则 `node ...` 会被
  // 并进注释、整段被注释掉，CLI 回退路径粘贴后什么都不执行。
  assert.match(first, /^# Paste-safe template:/);
  assert.ok(!first.endsWith('\\'), 'comment line must not end with a line continuation');
  // 第二行是命令第一行：以 node ... 开头，命令跨行时带续行符是正常的。
  assert.match(second, /^node tools\/runner-cli\.mjs/);
  // 后续命令参数行可以用续行符。
  assert.ok(rest.length >= 5);
  assert.ok(rest.some((l) => l.trim().startsWith('--bundle ')));
});

test('buildCliCommandTemplate single-quotes statements with shell metacharacters (no expansion)', () => {
  const statements = [
    '$(rm -rf /)',
    '`touch /tmp/pwned`',
    '$HOME',
    'say "hi" there',
    'C:\\path\\to\\file',
    'line1\nline2',
  ];
  for (const s of statements) {
    const cmd = buildCliCommandTemplate({ statement: s });
    const arg = cmd
      .split(' \\\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('--statement'));
    assert.ok(arg, `missing --statement for ${JSON.stringify(s)}`);
    // 单引号包裹：绝不出现 --statement " 的双引号展开形式
    assert.ok(arg.startsWith('--statement \''), `must be single-quoted: ${JSON.stringify(arg)}`);
    assert.ok(arg.endsWith('\''), `must end in single quote: ${JSON.stringify(arg)}`);
    assert.ok(!arg.startsWith('--statement "'), `must not be double-quoted: ${JSON.stringify(arg)}`);
    // 内容原样保留在单引号内（inert，不会被 shell 展开）
    assert.ok(arg.includes(s), `statement content must be preserved: ${JSON.stringify(arg)}`);
  }
});

test('buildCliCommandTemplate escapes single quotes per POSIX', () => {
  const cmd = buildCliCommandTemplate({ statement: "it's a pass" });
  // 'it's a pass' → 'it'\''s a pass'（POSIX 关闭-转义-重开单引号）
  assert.ok(cmd.includes("--statement 'it'\\''s a pass'"));
});

test('buildCliCommandTemplate quotes user-controlled revision too', () => {
  // 非占位符的 revision（用户/配置可控）必须单引号转义，不可被 shell 展开
  const cmd = buildCliCommandTemplate({ revision: '$(whoami)' });
  assert.ok(cmd.includes("--revision '$(whoami)'"));
  assert.doesNotMatch(cmd, /--revision "\$\(whoami\)/, 'must not double-quote revision');
});

test('redactBundleForExport scrubs token-shaped values in statement and credential keys anywhere', () => {
  const out = redactBundleForExport({
    schema_version: '1',
    statement: 'use token: ghp_abcdefghijklmnopqrstuvwxyz now',
    config: { auth: { api_key: 'live-key' } },
    events: [{ note: 'sk-proj-abc123def456', token: 'nested-secret' }],
    viewer_snapshot: { ball: { x: 0.5 } },
  });
  assert.equal(out.statement, 'use token: [REDACTED] now');
  assert.equal(out.config.auth.api_key, '[REDACTED]');
  assert.equal(out.events[0].token, '[REDACTED]');
  assert.equal(out.events[0].note, '[REDACTED]'); // sk-proj-* is a credential shape
  assert.equal(out.viewer_snapshot.ball.x, 0.5); // non-secret data untouched
});

test('redactBundleForExport redacts keys matching the broad normalized rule (ANTHROPIC_API_KEY, my_api_key)', () => {
  const out = redactBundleForExport({
    ANTHROPIC_API_KEY: 'plain-secret-value',
    nested: {
      my_api_key: 'plain-secret-value',
      authToken: 'plain-secret-value',
      token: 'plain-secret-value',
    },
    safe: { playerId: 5, note: 'keep-me' },
  });
  assert.equal(out.ANTHROPIC_API_KEY, '[REDACTED]');
  assert.equal(out.nested.my_api_key, '[REDACTED]');
  assert.equal(out.nested.authToken, '[REDACTED]');
  assert.equal(out.nested.token, '[REDACTED]');
  assert.deepEqual(out.safe, { playerId: 5, note: 'keep-me' });
});

test('redactBundleForExport covers sk-ant, ghp_, github_pat_, and sk-proj- values', () => {
  const out = redactBundleForExport({
    a: 'sk-ant-abcdefghij',
    b: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
    c: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    d: 'sk-proj-abcdefghij',
    e: 'normal text',
  });
  for (const k of ['a', 'b', 'c', 'd']) {
    assert.equal(out[k], '[REDACTED]', `${k} should be redacted`);
  }
  assert.equal(out.e, 'normal text');
});

test('redactBundleForExport output still passes the shared bundle validator', () => {
  const game = makeGame();
  game.seekTo(6);
  const b = captureObservation({
    game,
    statement: 'key sk-ant-abc123xyz ghp_abcdefghijklmnopqrstuvwxyz123456',
    seed: 42,
    config: { ...MATCH_CONFIG, custom: { api_key: 'nested-value' } },
    opts: deterministic(),
  });
  const safe = redactBundleForExport(b);
  const { valid, errors } = validateObservationBundle(safe);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.doesNotMatch(JSON.stringify(safe), /sk-ant-|ghp_/);
});
