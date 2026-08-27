// tools/github.mjs 单测（P11 problem lifecycle, task 3.1/3.3）。
// gh issue create 子进程：argv/body 构造、环境净化（复用 provider 策略）、退出码
// 映射（未登录 / 非零退出 / ENOENT）、dryRun 不 spawn、token 永不进 argv/日志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createGithubIssue,
  buildIssuePayload,
  resolveRepoFromRemoteUrl,
  parseIssueNumber,
} from './github.mjs';

const FAKE_KEY = 'sk-ant-fake-secret-value-0001';
const REPO = 'Xingkai98/pitchcraft';

// 一个最小 fake gh 子进程：stdout/stderr 是 EventEmitter；测试驱动 close/error；
// kill 记录 killed（超时路径会调用）。
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
};

// spawn 捕获（cmd/args/env/cwd/child），返回同一个 fake child 供测试后续驱动。
const captureSpawn = (capture) => (cmd, args, opts) => {
  capture.cmd = cmd;
  capture.args = args;
  capture.env = opts?.env;
  capture.cwd = opts?.cwd;
  capture.child = fakeChild();
  return capture.child;
};

// 基于 (file, firstArg) 的 execAsync stub；未命中抛错。
const execStub = (responses) => async (file, args) => {
  const key = `${file} ${args[0]}`;
  const r = responses[key];
  if (r === undefined) throw new Error(`unexpected exec: ${key}`);
  if (r instanceof Error) throw r;
  return r;
};

const sampleProblem = (over = {}) => ({
  id: 'prob-1',
  title: 'pass out of play with no defender pressure',
  description: 'User saw defenders never press the ball carrier.',
  triage: 'bug',
  status: 'open',
  source: {
    task_id: 'task-1',
    report: {
      status: 'diagnosed',
      phenomenon_summary: 'pass out of play with no defender pressure',
      layer: 'engine',
      hypotheses: ['pressure distance threshold too high'],
      root_cause: 'engine/src/lib.rs: unforced out pressure gate misconfigured',
      proposed_fix: 'lower unforced_out.pressure_distance',
      verification: 'node tools/runner-cli.mjs --bundle obs.json --audit audit.json',
      confidence: 0.8,
      triage: { category: 'bug', rationale: 'clear root cause', confidence: 0.9 },
    },
  },
  discussion: [{ author: 'user', text: 'reproducible every time', at: 't0' }],
  change_ref: null,
  github: null,
  created_at: 't0',
  updated_at: 't0',
  ...over,
});

test('resolveRepoFromRemoteUrl parses git remote formats', () => {
  assert.equal(resolveRepoFromRemoteUrl('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl('git@github.com:owner/repo'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl('https://github.com/owner/repo/'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl('https://user@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(resolveRepoFromRemoteUrl(''), null);
  assert.equal(resolveRepoFromRemoteUrl('not a url'), null);
  assert.equal(resolveRepoFromRemoteUrl('https://github.com/owner'), null);
});

test('parseIssueNumber extracts the trailing number from the issue URL', () => {
  assert.equal(parseIssueNumber('https://github.com/owner/repo/issues/42\n'), 42);
  assert.equal(parseIssueNumber('https://github.com/owner/repo/pull/123/'), 123);
  assert.equal(parseIssueNumber('no number here'), null);
});

test('buildIssuePayload renders title/body with triage prefix and discussion summary', () => {
  const { title, body } = buildIssuePayload(sampleProblem());
  assert.equal(title, '[bug] pass out of play with no defender pressure');
  assert.match(body, /## 问题描述/);
  assert.match(body, /User saw defenders never press the ball carrier\./);
  assert.match(body, /\*\*triage\*\*: bug/);
  assert.match(body, /## 诊断摘要/);
  assert.match(body, /根因/);
  assert.match(body, /## 讨论摘要/);
  assert.match(body, /reproducible every time/);
});

test('buildIssuePayload includes change_ref and redacts credentials anywhere in the text', () => {
  const { title, body } = buildIssuePayload(
    sampleProblem({
      title: 'my token sk-ant-fake-secret-value-0001 leaked',
      description: 'see sk-proj-fake-secret-123456 attached',
      change_ref: 'p11-fix',
      triage: 'design',
    })
  );
  assert.equal(title, '[design] my token [REDACTED] leaked');
  assert.match(body, /\*\*change_ref\*\*: p11-fix/);
  assert.doesNotMatch(body, /sk-ant-fake-secret-value-0001/);
  assert.doesNotMatch(body, /sk-proj-fake-secret-123456/);
  assert.match(body, /\[REDACTED\]/);
});

test('createGithubIssue spawns gh with the exact argv and parses the issue URL on success', async () => {
  const capture = {};
  const child = fakeChild();
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: (cmd, args, opts) => {
      capture.cmd = cmd;
      capture.args = args;
      capture.env = opts?.env;
      return child;
    },
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(capture.cmd, 'gh');
  assert.equal(capture.args[0], 'issue');
  assert.equal(capture.args[1], 'create');
  assert.equal(capture.args[2], '--repo');
  assert.equal(capture.args[3], REPO);
  assert.equal(capture.args[4], '--title');
  assert.match(capture.args[5], /^\[bug\]/);
  assert.equal(capture.args[6], '--body');
  assert.match(capture.args[7], /## 问题描述/);
  // 默认不传 --label（避免依赖仓库预建 label）；triage 由标题 [bug] 前缀标记。
  assert.ok(!capture.args.includes('--label'), 'no --label by default');
  // token 永不进 argv。
  assert.ok(!capture.args.some((a) => a.includes(FAKE_KEY)));
  child.stdout.emit('data', 'https://github.com/owner/repo/issues/42\n');
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.issue_number, 42);
  assert.equal(result.url, 'https://github.com/owner/repo/issues/42');
  assert.equal(result.repo, REPO);
});

test('createGithubIssue sanitizes the child env (reuses provider policy)', async () => {
  const capture = {};
  const child = fakeChild();
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: captureSpawn(capture),
    env: {
      ANTHROPIC_API_KEY: FAKE_KEY,
      PATH: '/usr/bin',
      HOME: '/home/user',
      HTTPS_PROXY: 'http://proxy:8080',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'sess-1',
      CLAUDE_PID: '12345',
      ANTHROPIC_AUTH_TOKEN: 'tok-abc',
      ANTHROPIC_BASE_URL: 'http://proxy.internal',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      AI_AGENT: 'claude',
      CLAUDECODE: '1',
    },
  });
  assert.ok(capture.env, 'spawn must receive the sanitized env');
  for (const blocked of [
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PID',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'AI_AGENT',
    'CLAUDECODE',
  ]) {
    assert.equal(capture.env[blocked], undefined, `${blocked} must be stripped`);
  }
  assert.equal(capture.env.ANTHROPIC_API_KEY, FAKE_KEY);
  assert.equal(capture.env.PATH, '/usr/bin');
  assert.equal(capture.env.HTTP_PROXY ?? capture.env.HTTPS_PROXY, 'http://proxy:8080');
  capture.child.stdout.emit('data', 'https://github.com/owner/repo/issues/9\n');
  capture.child.emit('close', 0);
  const result = await pending;
  assert.equal(result.ok, true);
});

test('createGithubIssue maps gh not-logged-in stderr to a clear message', async () => {
  const capture = {};
  const child = fakeChild();
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: captureSpawn(capture),
  });
  capture.child.stderr.emit('data', 'To get started with GitHub CLI, please run:  gh auth login\n');
  capture.child.emit('close', 1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /gh 未登录/);
  assert.match(result.error, /gh auth login/);
});

test('createGithubIssue maps a non-zero exit to exit code and redacts stderr', async () => {
  const capture = {};
  const child = fakeChild();
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: captureSpawn(capture),
  });
  capture.child.stderr.emit('data', `graphql error: token sk-ant-fake-secret-value-0001 invalid\n`);
  capture.child.emit('close', 2);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /gh issue create 失败（exit 2）/);
  assert.doesNotMatch(result.error, /sk-ant-fake-secret-value-0001/);
  assert.match(result.error, /\[REDACTED\]/);
});

test('createGithubIssue maps spawn ENOENT to gh-unavailable', async () => {
  const capture = {};
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: captureSpawn(capture),
  });
  capture.child.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /gh 不可用/);
  assert.match(result.error, /安装 GitHub CLI/);
});

test('createGithubIssue dryRun returns the planned args without spawning', async () => {
  let spawned = false;
  const result = await createGithubIssue(sampleProblem(), {
    repo: REPO,
    dryRun: true,
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });
  assert.equal(spawned, false);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.repo, REPO);
  assert.deepEqual(result.args.slice(0, 4), ['issue', 'create', '--repo', REPO]);
  assert.ok(!result.args.includes('--label'), 'no --label by default');
  assert.deepEqual(result.labels, []);
});

test('createGithubIssue passes --label only when the labels option is provided', async () => {
  const capture = {};
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    labels: ['bug'],
    spawnFn: captureSpawn(capture),
  });
  assert.ok(capture.args.includes('--label'));
  assert.ok(capture.args.includes('bug'));
  capture.child.stdout.emit('data', 'https://github.com/owner/repo/issues/7\n');
  capture.child.emit('close', 0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.issue_number, 7);
});

test('createGithubIssue resolves the repo from git remote when repo is omitted', async () => {
  let spawned = false;
  const result = await createGithubIssue(sampleProblem(), {
    dryRun: true,
    execAsync: execStub({ 'git remote': 'https://github.com/owner/repo.git' }),
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });
  assert.equal(spawned, false);
  assert.equal(result.repo, 'owner/repo');
});

test('createGithubIssue falls back to gh repo view when git remote fails', async () => {
  const result = await createGithubIssue(sampleProblem(), {
    dryRun: true,
    execAsync: execStub({
      'git remote': new Error('not a git repository'),
      'gh repo': JSON.stringify({ nameWithOwner: 'gh-user/gh-repo' }),
    }),
  });
  assert.equal(result.repo, 'gh-user/gh-repo');
});

test('createGithubIssue times out and kills the child when gh hangs', async () => {
  const capture = {};
  const pending = createGithubIssue(sampleProblem(), {
    repo: REPO,
    spawnFn: captureSpawn(capture),
    spawnTimeoutMs: 20,
  });
  // 不 emit close —— 20ms 后应超时并 kill 子进程。
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(capture.child.killed, true);
});

test('createGithubIssue fails clearly when the repo cannot be resolved', async () => {
  const result = await createGithubIssue(sampleProblem(), {
    dryRun: true,
    execAsync: execStub({
      'git remote': new Error('no remote'),
      'gh repo': new Error('gh not logged in'),
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /无法解析 GitHub 仓库/);
});
