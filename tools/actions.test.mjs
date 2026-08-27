// tools/actions.mjs 单测（P13 verify/fix）：无真实子进程/网络/git。
// verify 用 fake exec；fix 用 fake adapter + fake gitExec。白名单/超时/截断/净化/
// 结构校验全在纯函数层断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  tokenizeCommand,
  expandTestPath,
  buildVerifyPlan,
  firstWhitelistedVerifyCommand,
  verifyProblem,
  buildFixPrompt,
  validateFixReport,
  runFix,
  fixTimestamp,
  FIX_STATUSES,
  VERIFY_OUTPUT_TAIL_BYTES,
  REPO_ROOT,
  DEFAULT_EXEC_FILE,
} from './actions.mjs';

const FAKE_KEY = 'sk-ant-fake-secret-value-0001';

// fake execFile：返回预设结果；记录调用。opts 原样透传。
const fakeExec = (result) => {
  const calls = [];
  const fn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return typeof result === 'function' ? result(calls.length - 1, { file, args, opts }) : result;
  };
  fn.calls = calls;
  return fn;
};

const execOk = (stdout = 'ok output') => ({ stdout, stderr: '', code: 0, error: null, timedOut: false, signal: null });
const execFail = (code = 1, stderr = 'boom') => ({ stdout: '', stderr, code, error: `exited with code ${code}`, timedOut: false, signal: null });
const execTimeout = () => ({ stdout: 'partial', stderr: '', code: null, error: 'timeout', timedOut: true, signal: null });

const reportWithVerification = (verification) => ({
  id: 'prob-1',
  title: 't',
  source: { report: { phenomenon_summary: 'p', verification } },
});

// --- tokenize / whitelist ----------------------------------------------------

test('tokenizeCommand handles quotes and escapes; unbalanced quotes return null', () => {
  assert.deepEqual(tokenizeCommand('node --test tools/a.test.mjs viewer/b.test.js'), [
    'node', '--test', 'tools/a.test.mjs', 'viewer/b.test.js',
  ]);
  assert.deepEqual(tokenizeCommand('cargo test "engine::physics"'), ['cargo', 'test', 'engine::physics']);
  assert.deepEqual(tokenizeCommand("git merge 'fix/a b'"), ['git', 'merge', 'fix/a b']);
  assert.deepEqual(tokenizeCommand('cd viewer && node --test *.test.js'), ['cd', 'viewer', '&&', 'node', '--test', '*.test.js']);
  assert.deepEqual(tokenizeCommand(''), []);
  assert.deepEqual(tokenizeCommand('   '), []);
  assert.equal(tokenizeCommand('echo "unbalanced'), null);
  assert.deepEqual(tokenizeCommand(null), []);
});

test('expandTestPath expands literal globs and concrete test files under tools/viewer only', () => {
  // 字面 glob：tools/*.test.mjs 展开为真实测试文件（绝对路径）。
  const glob = expandTestPath('tools/*.test.mjs');
  assert.ok(Array.isArray(glob) && glob.length > 0);
  for (const p of glob) assert.ok(p.endsWith('.test.mjs') && p.includes(`${REPO_ROOT}/tools/`));
  // viewer cwd 下 *.test.js。
  const viewerGlob = expandTestPath('*.test.js', REPO_ROOT, { viewerCwd: true });
  assert.ok(Array.isArray(viewerGlob) && viewerGlob.length > 0);
  for (const p of viewerGlob) assert.ok(p.endsWith('.test.js') && p.includes(`${REPO_ROOT}/viewer/`));
  // 具体文件存在。
  const concrete = expandTestPath('tools/actions.test.mjs');
  assert.deepEqual(concrete, [join(REPO_ROOT, 'tools/actions.test.mjs')]);
  // 越界/非法 → null。
  assert.equal(expandTestPath('../secret.test.mjs'), null);
  assert.equal(expandTestPath('/etc/passwd'), null);
  assert.equal(expandTestPath('tools/../../x.test.mjs'), null);
  assert.equal(expandTestPath('tools/*.test.js'), null); // 文件在 tools 下不存在 .test.js
  assert.equal(expandTestPath('node_modules/x.test.mjs'), null);
  assert.equal(expandTestPath('tools/missing.test.mjs'), null);
});

test('buildVerifyPlan accepts the whitelisted commands and rejects everything else', () => {
  const repo = REPO_ROOT;
  // 白名单内。
  assert.ok(buildVerifyPlan('cargo test', repo));
  assert.ok(buildVerifyPlan('cargo test engine::physics', repo));
  assert.ok(buildVerifyPlan('cargo test --release -- --ignored', repo));
  assert.ok(buildVerifyPlan('cargo build --target wasm32-unknown-unknown --release', repo));
  assert.ok(buildVerifyPlan('node --test tools/*.test.mjs', repo));
  assert.ok(buildVerifyPlan('node --test tools/actions.test.mjs', repo));
  assert.ok(buildVerifyPlan('cd viewer && node --test *.test.js', repo));
  assert.ok(buildVerifyPlan('./verify.sh', repo));
  // ./verify.sh 解析为绝对路径（execFile 的 file 相对进程 cwd，不能靠 cwd 选项）。
  assert.equal(buildVerifyPlan('./verify.sh', repo).file, join(repo, 'verify.sh'));
  // cargo 命令 cwd = engine（repo 根无 Cargo.toml）。
  assert.equal(buildVerifyPlan('cargo test', repo).cwd, join(repo, 'engine'));
  assert.equal(buildVerifyPlan('cargo build --target wasm32-unknown-unknown --release', repo).cwd, join(repo, 'engine'));

  // 白名单外。
  assert.equal(buildVerifyPlan('rm -rf /', repo), null);
  assert.equal(buildVerifyPlan('cargo test && rm -rf /', repo), null);
  assert.equal(buildVerifyPlan('node tools/runner-cli.mjs --bundle x', repo), null);
  assert.equal(buildVerifyPlan('node --test ../evil.test.mjs', repo), null);
  assert.equal(buildVerifyPlan('cd /etc && node --test *.test.js', repo), null);
  assert.equal(buildVerifyPlan('bash verify.sh', repo), null);
  assert.equal(buildVerifyPlan('cargo build', repo), null);
  assert.equal(buildVerifyPlan('cargo build --target wasm32-unknown-unknown', repo), null);
  assert.equal(buildVerifyPlan('node --test', repo), null);
  assert.equal(buildVerifyPlan('', repo), null);
  assert.equal(buildVerifyPlan(null, repo), null);
  assert.equal(buildVerifyPlan('cargo test $HOME', repo), null);
  // cargo test 的危险 flag 拒绝（--config/--manifest-path 可把构建/runner 指向仓库外）。
  assert.equal(buildVerifyPlan('cargo test --config /tmp/evil.toml', repo), null);
  assert.equal(buildVerifyPlan('cargo test --config', repo), null);
  assert.equal(buildVerifyPlan('cargo test --manifest-path /etc/x.toml', repo), null);
  assert.equal(buildVerifyPlan('cargo test -C /tmp/x', repo), null);
  assert.equal(buildVerifyPlan('cargo test --offline', repo), null);
});

test('firstWhitelistedVerifyCommand takes the first whitelisted line from verification', () => {
  // 多行 verification：首行为描述文本，第二行才是白名单命令。
  const multi = '1. Run the engine tests to prove the fix\ncargo test\n2. Then check the build';
  assert.equal(firstWhitelistedVerifyCommand(multi), 'cargo test');
  // 单行白名单命令。
  assert.equal(firstWhitelistedVerifyCommand('node --test tools/*.test.mjs'), 'node --test tools/*.test.mjs');
  // 数组形式。
  assert.equal(firstWhitelistedVerifyCommand(['cargo test']), 'cargo test');
  // 无白名单命令 → null。
  assert.equal(firstWhitelistedVerifyCommand('node tools/runner-cli.mjs --bundle x'), null);
  assert.equal(firstWhitelistedVerifyCommand(''), null);
  assert.equal(firstWhitelistedVerifyCommand(null), null);
});

test('buildVerifyPlan never repeats the binary name in args (regression: cargo cargo test)', () => {
  for (const cmd of [
    'cargo test',
    'cargo build --target wasm32-unknown-unknown --release',
    'node --test tools/*.test.mjs',
    'cd viewer && node --test *.test.js',
    './verify.sh',
  ]) {
    const plan = buildVerifyPlan(cmd, REPO_ROOT);
    assert.ok(plan, `plan for ${cmd}`);
    assert.ok(plan.args.length === 0 || plan.args[0] !== plan.file, `args must not repeat file for ${cmd}`);
  }
  // cargo 的 args 不再含命令名本身（execFile('cargo', ['cargo','test']) 会 exit 101）。
  assert.deepEqual(buildVerifyPlan('cargo test', REPO_ROOT).args, ['test']);
  assert.deepEqual(buildVerifyPlan('cargo build --target wasm32-unknown-unknown --release', REPO_ROOT).args, [
    'build', '--target', 'wasm32-unknown-unknown', '--release',
  ]);
});

test('verifyProblem runs a whitelisted command through real execFile with no duplicated binary name', async () => {
  // 真实子进程 smoke（不注入 fake exec）：node --test <small test file> 走真实
  // buildVerifyPlan → execFile('node', ['--test', absPath])。回归：若 plan.args 重复
  // 命令名（如早期 cargo cargo test），真实执行必非零退出；本测试断言真实执行 exit 0。
  const plan = buildVerifyPlan('node --test tools/dotenv.test.mjs', REPO_ROOT);
  assert.equal(plan.file, 'node');
  assert.deepEqual(plan.args, ['--test', join(REPO_ROOT, 'tools/dotenv.test.mjs')]);
  const result = await verifyProblem(reportWithVerification('node --test tools/dotenv.test.mjs'), {
    exec: DEFAULT_EXEC_FILE,
    envKey: FAKE_KEY,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.doesNotMatch(result.summary, /not found|Cannot find module/);
});

// --- verifyProblem -----------------------------------------------------------

test('verifyProblem runs the whitelisted command and returns exit_code + tail summary', async () => {
  const long = `line0\n${'x'.repeat(5000)}\nTAIL-MARKER`;
  const exec = fakeExec(execOk(long));
  const result = await verifyProblem(reportWithVerification('cargo test'), { exec, envKey: FAKE_KEY });
  assert.equal(result.ok, true);
  assert.equal(result.command, 'cargo test');
  assert.equal(result.exit_code, 0);
  assert.equal(result.timedOut, false);
  // 截断：只保留尾部 ~2KB，且尾部内容在。
  assert.ok(result.summary.length <= VERIFY_OUTPUT_TAIL_BYTES + 40);
  assert.match(result.summary, /TAIL-MARKER/);
  assert.doesNotMatch(result.summary, /line0/);
  // 执行参数：cargo 在 engine 目录运行（repo 根无 Cargo.toml），带超时。
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, 'cargo');
  assert.deepEqual(exec.calls[0].args, ['test']);
  assert.ok(exec.calls[0].opts.timeout >= 600_000);
  assert.equal(exec.calls[0].opts.cwd, join(REPO_ROOT, 'engine'));
});

test('verifyProblem redacts credentials from the summary', async () => {
  const exec = fakeExec(execOk(`please see ${FAKE_KEY} attached\nSECRET line`));
  const result = await verifyProblem(reportWithVerification('cargo test'), { exec, envKey: FAKE_KEY });
  assert.match(result.summary, /\[REDACTED\]/);
  assert.doesNotMatch(result.summary, new RegExp(FAKE_KEY));
  assert.doesNotMatch(result.summary, /sk-ant-/);
});

test('verifyProblem surfaces non-zero exit codes and timeouts', async () => {
  const failed = await verifyProblem(reportWithVerification('cargo test'), { exec: fakeExec(execFail(1, 'tests failed')), envKey: FAKE_KEY });
  assert.equal(failed.ok, true);
  assert.equal(failed.exit_code, 1);
  assert.match(failed.summary, /boom|tests failed/);

  const timed = await verifyProblem(reportWithVerification('cargo test'), { exec: fakeExec(execTimeout()), envKey: FAKE_KEY });
  assert.equal(timed.ok, true);
  assert.equal(timed.exit_code, null);
  assert.equal(timed.timedOut, true);
  assert.match(timed.summary, /超时/);
});

test('verifyProblem rejects non-whitelisted commands without executing', async () => {
  let called = false;
  const exec = fakeExec(() => {
    called = true;
    return execOk();
  });
  // 显式传白名单外命令 → 400 语义（不执行）。
  const result = await verifyProblem(reportWithVerification('cargo test'), {
    command: 'rm -rf /',
    exec,
    envKey: FAKE_KEY,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /command not allowed/);
  assert.equal(called, false);
});

test('verifyProblem returns no-command when the report has no whitelisted verification and no explicit command', async () => {
  const result = await verifyProblem(reportWithVerification('node tools/runner-cli.mjs --bundle x'), {
    exec: fakeExec(execOk()),
    envKey: FAKE_KEY,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no verification command/);
});

test('verifyProblem honors an explicit command even when the report has none', async () => {
  const exec = fakeExec(execOk('ok'));
  const result = await verifyProblem(reportWithVerification(''), { command: 'cargo test', exec, envKey: FAKE_KEY });
  assert.equal(result.ok, true);
  assert.equal(result.command, 'cargo test');
});

// --- fix prompt / validation -------------------------------------------------

test('buildFixPrompt includes phenomenon/root cause/proposed fix/verification + constraints', () => {
  const prompt = buildFixPrompt({
    phenomenon: 'pass out of play with no pressure',
    userDescription: 'user saw defenders ignore the ball',
    rootCause: 'engine/src/lib.rs pressure gate',
    proposedFix: 'lower pressure distance threshold',
    verification: 'cargo test',
    worktree: '/tmp/fix-x',
  });
  assert.match(prompt, /pass out of play with no pressure/);
  assert.match(prompt, /user saw defenders ignore the ball/);
  assert.match(prompt, /engine\/src\/lib\.rs pressure gate/);
  assert.match(prompt, /lower pressure distance threshold/);
  assert.match(prompt, /cargo test/);
  assert.match(prompt, /Tests first/);
  assert.match(prompt, /Only modify files relevant/);
  assert.match(prompt, /verification_results/);
  assert.match(prompt, /changed_files/);
  assert.match(prompt, /fixed \| failed \| insufficient/);
});

test('validateFixReport accepts a valid fix report and rejects bad shapes', () => {
  const ok = validateFixReport({
    status: 'fixed',
    summary: 'fixed the gate',
    changed_files: ['engine/src/lib.rs', 'engine/src/lib.test.rs'],
    verification_results: [{ command: 'cargo test', exit_code: 0, summary: 'all pass' }],
  });
  assert.equal(ok.valid, true);

  // 字符串包裹（fenced JSON）也能解析。
  const fenced = validateFixReport(`\`\`\`json\n${JSON.stringify({ status: 'fixed', summary: 's', changed_files: [], verification_results: [] })}\n\`\`\``);
  assert.equal(fenced.valid, true);

  // status 非法。
  assert.equal(validateFixReport({ status: 'done', summary: 's', changed_files: [], verification_results: [] }).valid, false);
  // 缺 summary。
  assert.equal(validateFixReport({ status: 'fixed', changed_files: [], verification_results: [] }).valid, false);
  // changed_files 非数组/含非字符串。
  assert.equal(validateFixReport({ status: 'fixed', summary: 's', changed_files: 'x', verification_results: [] }).valid, false);
  assert.equal(validateFixReport({ status: 'fixed', summary: 's', changed_files: [1], verification_results: [] }).valid, false);
  // verification_results 条目形状非法。
  assert.equal(validateFixReport({ status: 'fixed', summary: 's', changed_files: [], verification_results: [{ command: 'cargo test' }] }).valid, false);
  // 凭证形文本。
  assert.equal(validateFixReport({ status: 'fixed', summary: `see ${FAKE_KEY}`, changed_files: [], verification_results: [] }).valid, false);
  // 非 JSON。
  assert.equal(validateFixReport('not json').valid, false);
});

test('fixTimestamp is safe for a git ref, deterministic, and millisecond-unique', () => {
  const a = fixTimestamp('2026-08-27T15:30:00.000Z');
  const b = fixTimestamp('2026-08-27T15:30:00.000Z');
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9]+$/);
  assert.ok(a.length <= 24);
  // 毫秒级分辨率：同一秒不同毫秒 → 不同 ts（避免撞 worktree/分支名）。
  assert.notEqual(fixTimestamp('2026-08-27T15:30:00.000Z'), fixTimestamp('2026-08-27T15:30:00.123Z'));
  assert.equal(fixTimestamp('2026-08-27T15:30:00.000Z'), '20260827T153000000');
  assert.equal(fixTimestamp('garbage'), 'garbage'.replace(/[^A-Za-z0-9]/g, '').replace(/Z$/, ''));
});

// --- runFix（fake adapter + fake gitExec）------------------------------------

const fakeGit = (handler) => {
  const calls = [];
  const fn = async (args, opts) => {
    calls.push({ args, opts });
    return typeof handler === 'function' ? handler(calls.length - 1, { args, opts }) : handler;
  };
  fn.calls = calls;
  return fn;
};
const gitOk = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0 });

const fakeAdapter = (runResult) => {
  const calls = [];
  const adapter = {
    provider: 'claude-code',
    async run(prompt, opts) {
      calls.push({ prompt, opts });
      return typeof runResult === 'function' ? runResult(calls.length - 1, { prompt, opts }) : runResult;
    },
  };
  adapter.calls = calls;
  return adapter;
};

const fixProblem = () => ({
  id: 'prob-1',
  title: 'pressure gate',
  description: 'user description',
  source: {
    report: {
      phenomenon_summary: 'pass out of play with no pressure',
      root_cause: 'engine/src/lib.rs pressure gate',
      proposed_fix: 'lower threshold',
      verification: 'cargo test',
    },
  },
});

const fixEnv = () => ({ ANTHROPIC_API_KEY: FAKE_KEY });

test('runFix creates the worktree, runs the provider in it, and returns a fixed result', async () => {
  const git = fakeGit(gitOk());
  const adapter = fakeAdapter({
    ok: true,
    status: 'success',
    stdout: JSON.stringify({
      status: 'fixed',
      summary: 'lowered the threshold',
      changed_files: ['engine/src/lib.rs'],
      verification_results: [{ command: 'cargo test', exit_code: 0, summary: 'all pass' }],
    }),
    exitCode: 0,
    stderr: '',
    error: null,
  });
  const result = await runFix({
    problem: fixProblem(),
    worktreesDir: '/tmp/p13-fix-test',
    now: () => '2026-08-27T15:30:00.000Z',
    gitExec: git,
    adapter,
    env: fixEnv(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'fixed');
  assert.equal(result.branch, 'fix/prob-1/20260827T153000000');
  assert.equal(result.worktree, '/tmp/p13-fix-test/fix-prob-1-20260827T153000000');
  assert.equal(result.summary, 'lowered the threshold');
  assert.deepEqual(result.changed_files, ['engine/src/lib.rs']);

  // git worktree add：从 main 分叉，只动隔离 worktree。
  assert.deepEqual(git.calls[0].args, ['worktree', 'add', result.worktree, '-b', result.branch, 'main']);
  assert.equal(git.calls[0].opts.cwd, REPO_ROOT);
  // provider 在 worktree cwd 下运行，env 原样（净化在 adapter 内做），带超时。
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].opts.cwd, result.worktree);
  assert.equal(adapter.calls[0].opts.env.ANTHROPIC_API_KEY, FAKE_KEY);
  assert.ok(adapter.calls[0].opts.timeoutMs >= 600_000);
  // prompt 携带修复方案与验证命令（且不含凭证）。
  assert.match(adapter.calls[0].prompt, /lower threshold/);
  assert.match(adapter.calls[0].prompt, /cargo test/);
  assert.doesNotMatch(adapter.calls[0].prompt, /sk-ant-/);
});

test('runFix returns provider_unavailable without git/worktree when the key is missing', async () => {
  let gitCalled = false;
  const git = fakeGit(() => {
    gitCalled = true;
    return gitOk();
  });
  const result = await runFix({ problem: fixProblem(), gitExec: git, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'provider_unavailable');
  assert.equal(gitCalled, false);
});

test('runFix records nothing on worktree add failure (no provider run) and cleans best-effort', async () => {
  const git = fakeGit({ ok: false, stdout: '', stderr: 'main not found', code: 128 });
  let adapterCalled = false;
  const adapter = fakeAdapter(() => {
    adapterCalled = true;
    return { ok: true, status: 'success', stdout: '', exitCode: 0 };
  });
  const result = await runFix({ problem: fixProblem(), worktreesDir: '/tmp/x', now: () => 't', gitExec: git, adapter, env: fixEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /git worktree add failed/);
  assert.equal(adapterCalled, false);
  // 半途残留 worktree 也 best-effort 清理。
  const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
  assert.ok(removeCall, 'expected a best-effort worktree remove on add failure');
});

test('runFix normalizes a throwing gitExec into a failed outcome (no crash, no provider run)', async () => {
  const git = fakeGit(() => {
    throw new Error('git exploded');
  });
  let adapterCalled = false;
  const adapter = fakeAdapter(() => {
    adapterCalled = true;
    return { ok: true, status: 'success', stdout: '', exitCode: 0 };
  });
  const result = await runFix({ problem: fixProblem(), worktreesDir: '/tmp/x', now: () => 't', gitExec: git, adapter, env: fixEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /git worktree add failed/);
  assert.equal(adapterCalled, false);
});

test('runFix fails cleanly on invalid agent output and cleans the worktree', async () => {
  const git = fakeGit(gitOk());
  const adapter = fakeAdapter({ ok: true, status: 'success', stdout: 'not json', exitCode: 0 });
  const result = await runFix({ problem: fixProblem(), worktreesDir: '/tmp/x', now: () => 't', gitExec: git, adapter, env: fixEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'invalid_agent_output');
  assert.match(result.error, /parseable JSON/);
  // 失败时清理残留 worktree。
  const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
  assert.ok(removeCall, 'expected a worktree remove call');
  assert.deepEqual(removeCall.args, ['worktree', 'remove', '--force', '/tmp/x/fix-prob-1-t']);
});

test('runFix treats an agent-reported failed status as a failure (no fix_ref)', async () => {
  const git = fakeGit(gitOk());
  const adapter = fakeAdapter({
    ok: true,
    status: 'success',
    stdout: JSON.stringify({ status: 'failed', summary: 'could not reproduce', changed_files: [], verification_results: [] }),
    exitCode: 0,
  });
  const result = await runFix({ problem: fixProblem(), worktreesDir: '/tmp/x', now: () => 't', gitExec: git, adapter, env: fixEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /fix agent reported status failed/);
  assert.equal(result.summary, 'could not reproduce');
});

test('runFix scrubs credential-shaped text out of the prompt', async () => {
  const git = fakeGit(gitOk());
  const adapter = fakeAdapter({ ok: true, status: 'success', stdout: JSON.stringify({ status: 'fixed', summary: 'ok', changed_files: [], verification_results: [] }), exitCode: 0 });
  const problem = fixProblem();
  problem.description = `user pasted ${FAKE_KEY} into the description`;
  await runFix({ problem, worktreesDir: '/tmp/x', now: () => 't', gitExec: git, adapter, env: fixEnv() });
  assert.doesNotMatch(adapter.calls[0].prompt, new RegExp(FAKE_KEY));
  assert.match(adapter.calls[0].prompt, /\[REDACTED\]/);
});

test('FIX_STATUSES matches the spec enum', () => {
  assert.deepEqual(FIX_STATUSES, ['fixed', 'failed', 'insufficient']);
});
