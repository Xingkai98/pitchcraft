// P13 problem actions: verify / fix dispatch + merge-close orchestration.
//
// verifyProblem: runs a whitelisted verification command in the main checkout
//   (child_process, never a shell), with a timeout and tail-truncated redacted
//   output. Returns { ok, command, exit_code, summary, timedOut }.
// runFix: creates an isolated git worktree branched from main, runs the provider
//   (bypass, sanitized env, structured output validation) to fix + self-verify,
//   and returns the structured result for the service to write back. The main
//   checkout is never modified by the fix flow.
// gitRun: generic `git` child-process helper shared by the fix flow and the
//   merge-close endpoint (worktree add / rev-parse / merge / worktree remove).
//
// Security: verify commands are whitelisted and parsed into a concrete argv —
//  the raw command string is never passed to a shell. All user/CLI-controlled
//  text is scrubbed (redactKey + redactCredentialText) before it reaches a
//  prompt or a persisted decision. Credentials live only in the process env.

import { execFile as nodeExecFile } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderAdapter, redactKey, redactCredentialText } from './provider.mjs';
import { extractReportJSON } from './runner.mjs';
import { assertNoCredentials } from './bundle.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VERIFY_DEFAULT_TIMEOUT_MS = 600_000;
export const VERIFY_OUTPUT_TAIL_BYTES = 2048;
export const GIT_DEFAULT_TIMEOUT_MS = 120_000;

// --- verify command whitelist ------------------------------------------------

// 安全 token：只允许标识符/路径/版本段字符，绝不包含 shell 元字符
// （空格/`;|&$(){}` 等）。cargo test 的过滤名（如 `engine::physics`）与 wasm
// target 名都在此字符集内。
const SAFE_TOKEN_RE = /^[A-Za-z0-9._\-/:+]+$/;
const isSafeToken = (t) => SAFE_TOKEN_RE.test(t);

// 简单 shell 风格分词：支持单双引号与反斜杠转义。不平衡引号 → null。
// 只用于把白名单命令切成 argv 再逐 token 校验，绝不把原串交给 shell。
export function tokenizeCommand(command) {
  const s = String(command ?? '');
  const tokens = [];
  let i = 0;
  let current = '';
  let inToken = false;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      inToken = true;
      const quote = c;
      i += 1;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '\\' && quote === '"' && i + 1 < s.length) {
          current += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          closed = true;
          i += 1;
          break;
        }
        current += s[i];
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      inToken = true;
      current += s[i + 1];
      i += 2;
      continue;
    }
    inToken = true;
    current += c;
    i += 1;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// cargo 命令必须在 engine crate 目录下运行（repo 根没有 Cargo.toml）。
const CARGO_CWD = (repoRoot) => join(repoRoot, 'engine');

// cargo test 追加参数白名单：允许的 flag 只有这几个（`--` 是 test harness 分隔符；
// `--ignored`/`--nocapture`/`--exact` 是 harness flag；`--release` 是 cargo flag）。
// 其余 `-` 开头 token（--config/--manifest-path/-C 等可把构建/runner 指向仓库外
// 任意文件 → 任意代码执行）一律拒绝。
const CARGO_TEST_SAFE_FLAGS = new Set(['--release', '--', '--ignored', '--nocapture', '--exact']);

// cargo test 尾部参数校验：非 `-` 开头的过滤名（安全 token）或白名单 flag。
function cargoTestArgsOk(rest) {
  for (const t of rest.slice(1)) {
    if (t.startsWith('-')) {
      if (!CARGO_TEST_SAFE_FLAGS.has(t)) return false;
    } else if (!isSafeToken(t)) {
      return false;
    }
  }
  return true;
}

// 把测试文件路径/glob 展开为绝对路径列表。允许的根只有 tools/ 与 viewer/；
// glob 只接受字面 `tools/*.test.mjs` / `viewer/*.test.js` 形式（以及 viewer cwd
// 下的 `*.test.js`），具体文件必须是 `.test.mjs|js` 且真实存在。解析不出 → null。
export function expandTestPath(path, repoRoot = REPO_ROOT, { viewerCwd = false } = {}) {
  const p = String(path ?? '');
  const readTestFiles = (root, ext) => {
    try {
      const files = readdirSync(join(repoRoot, root))
        .filter((f) => f.endsWith(`.test.${ext}`))
        .sort()
        .map((f) => join(repoRoot, root, f));
      return files.length > 0 ? files : null; // glob 空展开 → 无效（无可运行文件）
    } catch {
      return null;
    }
  };
  if (viewerCwd) {
    if (p === '*.test.js') return readTestFiles('viewer', 'js');
    if (/^[A-Za-z0-9._-]+\.test\.js$/.test(p)) {
      const full = join(repoRoot, 'viewer', p);
      return existsSync(full) ? [full] : null;
    }
    return null;
  }
  const glob = /^(tools|viewer)\/\*\.test\.(mjs|js)$/.exec(p);
  if (glob) return readTestFiles(glob[1], glob[2]);
  const concrete = /^(tools|viewer)\/([A-Za-z0-9._-]+\.test\.(?:mjs|js))$/.exec(p);
  if (concrete) {
    const full = join(repoRoot, concrete[1], concrete[2]);
    return existsSync(full) ? [full] : null;
  }
  return null;
}

// 把白名单命令解析为具体子进程调用：{ file, args, cwd }。file 对相对命令在构建
// 期就解析为绝对路径（execFile 的 file 相对当前进程 cwd 解析，不能依赖 cwd 选项）；
// node --test 的 glob 在构建期展开为绝对文件路径。白名单外/无法解析 → null。
export function buildVerifyPlan(command, repoRoot = REPO_ROOT) {
  const tokens = tokenizeCommand(command);
  if (!tokens || tokens.length === 0) return null;
  const [file, ...rest] = tokens;

  // ./verify.sh —— 精确。
  if (file === './verify.sh' && rest.length === 0) {
    return { file: join(repoRoot, 'verify.sh'), args: [], cwd: repoRoot };
  }

  if (file === 'cargo') {
    // cargo test [<filter>...] —— 尾部参数限安全 token（过滤名）+ 白名单 flag；
    // cwd = engine（repo 根无 Cargo.toml）。
    if (rest[0] === 'test' && cargoTestArgsOk(rest)) {
      return { file: 'cargo', args: rest, cwd: CARGO_CWD(repoRoot) };
    }
    // cargo build --target wasm32-unknown-unknown --release —— 精确；cwd = engine。
    if (
      rest.length === 4 &&
      rest[0] === 'build' &&
      rest[1] === '--target' &&
      rest[2] === 'wasm32-unknown-unknown' &&
      rest[3] === '--release'
    ) {
      return { file: 'cargo', args: rest, cwd: CARGO_CWD(repoRoot) };
    }
    return null;
  }

  if (file === 'node') {
    // node --test <paths> —— 每个路径必须是 tools/viewer 下的测试文件或字面 glob。
    if (rest[0] === '--test' && rest.length >= 2) {
      const expanded = [];
      for (const p of rest.slice(1)) {
        const files = expandTestPath(p, repoRoot);
        if (!files || files.length === 0) return null;
        expanded.push(...files);
      }
      return { file: 'node', args: ['--test', ...expanded], cwd: repoRoot };
    }
    return null;
  }

  // cd viewer && node --test *.test.js —— 复合白名单命令（cwd = viewer）。
  if (
    tokens[0] === 'cd' &&
    tokens[1] === 'viewer' &&
    tokens[2] === '&&' &&
    tokens[3] === 'node' &&
    tokens[4] === '--test' &&
    tokens.length >= 6
  ) {
    const expanded = [];
    for (const p of tokens.slice(5)) {
      const files = expandTestPath(p, repoRoot, { viewerCwd: true });
      if (!files || files.length === 0) return null;
      expanded.push(...files);
    }
    return { file: 'node', args: ['--test', ...expanded], cwd: join(repoRoot, 'viewer') };
  }

  return null;
}

// 从 report.verification 文本里取第一条白名单内命令（可多行：逐行取首个可执行行；
// verification 也可能是命令数组）。没有 → null。
export function firstWhitelistedVerifyCommand(verification, repoRoot = REPO_ROOT) {
  const lines = Array.isArray(verification) ? verification : String(verification ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const cmd = String(raw ?? '').trim();
    if (!cmd) continue;
    if (buildVerifyPlan(cmd, repoRoot)) return cmd;
  }
  return null;
}

// --- exec helpers ------------------------------------------------------------

// 默认 execFile promisified（可注入测试）：返回 { stdout, stderr, code, error,
// timedOut, signal }。非零退出码落在 code；超时（execFile 的 timeout kill）→
// code null + timedOut true；spawn 失败 → code null + error。
export const DEFAULT_EXEC_FILE = (file, args, opts = {}) =>
  new Promise((resolvePromise) => {
    nodeExecFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof err.code === 'number' ? err.code : null,
          error: err.message ?? String(err),
          timedOut: err.killed === true,
          signal: err.signal ?? null,
        });
      } else {
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: 0,
          error: null,
          timedOut: false,
          signal: null,
        });
      }
    });
  });

// 通用 git 执行（可注入 execFile）：返回 { ok, stdout, stderr, code }。
// 超时保护：merge / worktree 操作意外挂起时不无限阻塞服务端请求。
export async function gitRun(args, { cwd = REPO_ROOT, exec = DEFAULT_EXEC_FILE, timeoutMs = GIT_DEFAULT_TIMEOUT_MS } = {}) {
  const run = await exec('git', args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
  return {
    ok: run.code === 0,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    code: run.code,
    timedOut: run.timedOut === true,
  };
}

// --- verifyProblem -----------------------------------------------------------

// 执行一次 verify：白名单命令 → 超时 kill → 输出尾部截断 + 净化 → 结果对象。
// command 缺省取报告 verification 首条白名单命令；无命令/白名单外 → { ok:false,
// error }（服务层映射 400）。exec 可注入（测试用 fake）。verify 不改文件（只读
// 工作树；命令本身被白名单约束）。
export async function verifyProblem(
  problem,
  {
    command = null,
    cwd = REPO_ROOT,
    timeoutMs = VERIFY_DEFAULT_TIMEOUT_MS,
    envKey = null,
    exec = DEFAULT_EXEC_FILE,
    repoRoot = REPO_ROOT,
  } = {}
) {
  const cmd = (command && String(command).trim()) || firstWhitelistedVerifyCommand(problem?.source?.report?.verification, repoRoot);
  if (!cmd) return { ok: false, error: 'no verification command available' };
  const plan = buildVerifyPlan(cmd, repoRoot);
  if (!plan) return { ok: false, error: `command not allowed: ${redactKey(cmd, envKey)}` };
  const run = await exec(plan.file, plan.args, {
    cwd: plan.cwd ?? cwd,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const tail = combined.slice(-VERIFY_OUTPUT_TAIL_BYTES);
  const safe = redactCredentialText(redactKey(tail, envKey));
  const timedOut = run.timedOut === true;
  const summary = timedOut
    ? `[verify 超时：${Math.round(timeoutMs / 1000)}s]\n${safe}`
    : safe;
  return {
    ok: true,
    command: cmd,
    exit_code: run.code ?? null,
    summary,
    timedOut,
  };
}

// --- fix orchestration -------------------------------------------------------

export const FIX_STATUSES = ['fixed', 'failed', 'insufficient'];

// 默认 fix provider 配置：bypass（full tool access）、较长超时（agent 要跑验证
// 命令）。凭证只在进程环境，config 永不携带凭证。
export const DEFAULT_FIX_CONFIG = {
  provider: 'claude-code',
  command: 'claude',
  model: null,
  permission: 'bypass',
  read_only: false,
  budget: null,
  timeout_seconds: 600,
};

export const defaultFixWorktreesDir = () => join(tmpdir(), 'p13-fix');

// 分支名时间戳：ISO → 只留字母数字（安全 ref 段），保留毫秒避免同一秒内重复下发
// fix 撞 worktree/分支名（git worktree add 会因分支已存在而失败）。确定性（测试用
// 固定 now）。
export function fixTimestamp(nowIso) {
  const s = String(nowIso ?? '');
  const clean = s.replace(/[^A-Za-z0-9]/g, '').replace(/Z$/, '');
  return clean || 'ts';
}

const scrubFixText = (text, key) => redactCredentialText(redactKey(String(text ?? ''), key));

// 构建 fix prompt（纯函数，可测）：现象/根因/修复方案/验证命令 + 约束（测试先行、
// 不越界、完成后自验证、提交留待确认）。调用方先把各字段净化（runFix 里 scrub）。
export function buildFixPrompt({
  phenomenon,
  userDescription = '',
  rootCause = '',
  proposedFix = '',
  verification = '',
  extraInstructions = '',
  worktree,
}) {
  const lines = [
    'You are fixing a diagnosed problem in a football-manager 2D clone.',
    '',
    `You are working in an isolated git worktree: ${worktree}`,
    'Your changes stay inside this worktree; do NOT touch the main checkout.',
    '',
    '现象 (phenomenon):',
    phenomenon || '（未提供）',
    userDescription ? `\n用户描述 (user description):\n${userDescription}` : null,
    rootCause ? `\n根因 (root cause):\n${rootCause}` : null,
    proposedFix ? `\n修复方案 (proposed fix):\n${proposedFix}` : null,
    verification ? `\n验证命令 (verification commands):\n${verification}` : null,
    extraInstructions ? `\n额外指令 (extra instructions):\n${extraInstructions}` : null,
    '\n约束 (constraints):',
    '- Tests first: write or update failing tests before implementing the fix.',
    '- Only modify files relevant to this problem; do not touch unrelated files.',
    '- Run the verification command(s) yourself in this worktree and record real results.',
    '- Commit your changes with a descriptive message (the merge step needs a commit on this branch).',
    '',
    'Respond with a single JSON object containing EXACTLY these keys:',
    '- status: one of fixed | failed | insufficient',
    '- summary: a string describing what you changed and the verification outcome',
    '- changed_files: an array of file paths relative to the worktree root',
    '- verification_results: an array of { command: string, exit_code: number, summary: string }',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

// 校验 fix agent 的结构化输出。无效输出必须当作任务失败（不建 fix_ref）。
// errors 永不包含凭证值。
export function validateFixReport(report) {
  const errors = [];
  let value = report;
  if (typeof report === 'string') {
    value = extractReportJSON(report);
    if (value === null) {
      return { valid: false, report: null, errors: ['output does not contain a parseable JSON report'] };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, report: null, errors: ['fix report must be a JSON object'] };
  }
  if (!FIX_STATUSES.includes(value.status)) {
    errors.push(`fix status must be one of: ${FIX_STATUSES.join(', ')}`);
  }
  if (typeof value.summary !== 'string') {
    errors.push('fix report summary must be a string');
  }
  if (!Array.isArray(value.changed_files)) {
    errors.push('fix report changed_files must be an array of strings');
  } else if (value.changed_files.some((f) => typeof f !== 'string')) {
    errors.push('fix report changed_files must contain only strings');
  }
  if (!Array.isArray(value.verification_results)) {
    errors.push('fix report verification_results must be an array');
  } else {
    for (const v of value.verification_results) {
      const entryOk =
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof v.command === 'string' &&
        typeof v.summary === 'string' &&
        (typeof v.exit_code === 'number' || v.exit_code === null);
      if (!entryOk) {
        errors.push('verification_results entries must be { command, exit_code, summary }');
        break;
      }
    }
  }
  try {
    assertNoCredentials(value);
  } catch (e) {
    errors.push(e.message);
  }
  return { valid: errors.length === 0, report: value, errors };
}

// 清理 fix 失败时留下的 worktree（best-effort）：provider 失败/超时/无效输出或
// agent 自报 failed 时主 checkout 零改动，残留 worktree 一并移除防泄漏。
async function removeWorktree(gitExec, worktree, repoRoot) {
  if (!worktree) return;
  try {
    await gitExec(['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
  } catch {
    /* best-effort */
  }
}

// 执行一次 fix：隔离 worktree（从 main 分叉）→ 构建 prompt → 运行 provider
// （bypass + 净化 env + cwd=worktree + 结构化输出校验）→ 返回结果。
// 成功（agent 自报 fixed）→ { ok:true, outcome:'fixed', worktree, branch, summary,
// changed_files, verification_results }，服务层写回 fix_ref + status in_progress。
// 失败（provider 层 / 无效输出 / agent 自报 failed|insufficient）→ { ok:false,
// outcome, error, ... }，服务层只记录 decisions，problem 状态与字段不变。
// git 操作经 gitExec 注入（测试用 fake）；provider 经 adapter 注入。
export async function runFix({
  problem,
  extraInstructions = '',
  repoRoot = REPO_ROOT,
  worktreesDir = null,
  providerConfig = DEFAULT_FIX_CONFIG,
  adapter = null,
  env = process.env,
  now = () => new Date().toISOString(),
  gitExec = gitRun,
} = {}) {
  const envKey = env?.ANTHROPIC_API_KEY;
  const cfg = { ...DEFAULT_FIX_CONFIG, ...providerConfig };
  const worktreesRoot = worktreesDir ?? defaultFixWorktreesDir();

  // 1. 凭证 gate（与 runner 同口径）：key 只存在于进程环境。
  if (!envKey) {
    return { ok: false, outcome: 'provider_unavailable', error: 'ANTHROPIC_API_KEY is not set in the runner process environment' };
  }

  const id = problem?.id ?? 'prob';
  const ts = fixTimestamp(now());
  const branch = `fix/${id}/${ts}`;
  const worktree = join(worktreesRoot, `fix-${id}-${ts}`);

  // 2. 隔离 worktree：从 main 分叉；主 checkout 零改动。gitExec 异常归一化为失败
  //    （与 removeWorktree 的 best-effort 一起防半途残留）。
  let add;
  try {
    add = await gitExec(['worktree', 'add', worktree, '-b', branch, 'main'], { cwd: repoRoot });
  } catch (e) {
    await removeWorktree(gitExec, worktree, repoRoot);
    return {
      ok: false,
      outcome: 'failed',
      error: `git worktree add failed: ${redactKey(e?.message ?? String(e), envKey)}`,
      worktree,
      branch,
    };
  }
  if (!add.ok) {
    // stderr 源头净化（与异常分支一致）：git 输出可能携带路径/环境信息。
    const detail = redactKey(String(add.stderr || add.stdout || '').trim(), envKey);
    await removeWorktree(gitExec, worktree, repoRoot);
    return {
      ok: false,
      outcome: 'failed',
      error: `git worktree add failed${detail ? `: ${detail}` : ''}`,
      worktree,
      branch,
    };
  }

  // 3. 构建 fix prompt。problem 落盘副本已深净化，这里对每个字段再兜底 scrub
  //    （redactKey + redactCredentialText），凭证形文本绝不进 prompt。
  const report = problem?.source?.report ?? {};
  const prompt = buildFixPrompt({
    phenomenon: scrubFixText(report.phenomenon_summary, envKey),
    userDescription: scrubFixText(problem?.description, envKey),
    rootCause: scrubFixText(report.root_cause, envKey),
    proposedFix: scrubFixText(report.proposed_fix, envKey),
    verification: scrubFixText(report.verification, envKey),
    extraInstructions: scrubFixText(extraInstructions, envKey),
    worktree,
  });

  // 4. 运行 provider（bypass + 净化 env + cwd=worktree）。
  const provider = adapter ?? createProviderAdapter(cfg);
  let run;
  try {
    run = await provider.run(prompt, {
      env,
      timeoutMs: (cfg.timeout_seconds ?? 600) * 1000,
      cwd: worktree,
    });
  } catch (e) {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'provider_error', error: redactKey(e?.message ?? String(e), envKey), worktree, branch };
  }

  if (run.status === 'provider_unavailable') {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'provider_unavailable', error: redactKey(run.error ?? 'provider unavailable', envKey), worktree, branch };
  }
  if (run.status === 'timeout') {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'timeout', error: redactKey(run.error ?? 'provider timed out', envKey), worktree, branch };
  }
  if (run.ok === false || run.status === 'error') {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'provider_error', error: redactKey(run.error ?? 'provider run failed', envKey), worktree, branch };
  }
  if (run.exitCode !== null && run.exitCode !== 0) {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'provider_error', error: `provider exited with code ${run.exitCode}; fix output not accepted`, worktree, branch };
  }

  const check = validateFixReport(run.stdout ?? '');
  if (!check.valid) {
    await removeWorktree(gitExec, worktree, repoRoot);
    return { ok: false, outcome: 'invalid_agent_output', error: check.errors.join('; '), worktree, branch };
  }
  const fixReport = check.report;
  if (fixReport.status !== 'fixed') {
    // agent 自报 failed/insufficient：只记失败，不建 fix_ref；worktree 清理。
    await removeWorktree(gitExec, worktree, repoRoot);
    return {
      ok: false,
      outcome: fixReport.status,
      error: `fix agent reported status ${fixReport.status}`,
      summary: fixReport.summary ?? null,
      changed_files: Array.isArray(fixReport.changed_files) ? fixReport.changed_files : [],
      verification_results: Array.isArray(fixReport.verification_results) ? fixReport.verification_results : [],
      worktree,
      branch,
    };
  }
  return {
    ok: true,
    outcome: 'fixed',
    worktree,
    branch,
    summary: fixReport.summary ?? '',
    changed_files: Array.isArray(fixReport.changed_files) ? fixReport.changed_files : [],
    verification_results: Array.isArray(fixReport.verification_results) ? fixReport.verification_results : [],
  };
}
