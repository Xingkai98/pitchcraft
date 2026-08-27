// GitHub issue 集成（P11 problem lifecycle, task 3.1/3.3）。
//
// 通过本机 `gh` CLI 创建 GitHub issue（`gh issue create --repo <repo> --title ... --
// body ...`）。凭证只来自本机 gh 登录：token 不进入 argv/日志/prompt。子进程环境复用
// provider 的净化策略（sanitizeChildEnv），剔除 CLAUDE_CODE_*/ANTHROPIC_AUTH_TOKEN 等
// 会话变量。仓库默认从 git remote origin 解析，失败回退 gh repo view，可用 repo 覆盖。
// issue 标题带 triage 前缀标记（[bug]/[design]/[discuss]），正文由 viewer/audit-report.js
// 的 buildChangeDraft 渲染 + 问题描述/讨论摘要；默认不传 --label。
//
// 错误映射：gh 缺失（ENOENT）→ "gh 不可用"；未登录 → "gh 未登录"；非零退出 → 带退出码
// 的中文错误。失败不触碰本地 Problem（服务端保证）。

import { spawn as nodeSpawn } from 'node:child_process';
import { execFile as nodeExecFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeChildEnv, redactKey } from './provider.mjs';
import { buildChangeDraft, redactText } from '../viewer/audit-report.js';

// triage 分类值（仅用于标题前缀标记与正文渲染；不作为默认 GitHub label）。
const TRIAGE_VALUES = ['bug', 'design', 'discuss', 'defer', 'wontfix'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- pure helpers ------------------------------------------------------------

// 从 git remote URL 解析 owner/repo（git@https/ssh 形式）。解析不出 → null。
export function resolveRepoFromRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  if (!t) return null;
  let m;
  // git@github.com:owner/repo.git
  if ((m = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(t))) return `${m[1]}/${m[2]}`;
  // https://github.com/owner/repo.git / ssh://git@github.com/owner/repo.git
  if ((m = /^(?:https?|ssh):\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(t))) {
    return `${m[1]}/${m[2]}`;
  }
  return null;
}

// 从 gh 输出的 issue URL 提取 issue 号（URL 末尾数字）。
export function parseIssueNumber(url) {
  const m = /(\d+)\/?$/.exec(String(url ?? '').trim());
  return m ? Number(m[1]) : null;
}

// 渲染 issue 载荷（纯函数）。triage 进标题前缀；正文 = 问题描述 + triage + change_ref +
// 诊断摘要（buildChangeDraft）+ 讨论摘要。所有外部文本渲染前抹除凭证。
export function buildIssuePayload(problem, { envKey } = {}) {
  const p = problem ?? {};
  const triage = TRIAGE_VALUES.includes(p.triage) ? p.triage : 'discuss';
  const rawTitle = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : '未命名问题';
  const title = redactKey(redactText(`[${triage}] ${rawTitle}`), envKey);
  const description =
    typeof p.description === 'string' && p.description.trim() ? p.description.trim() : '';
  const report = p.source?.report ?? null;
  const changeDraft = report && typeof report === 'object' ? buildChangeDraft(report) : '';

  const parts = ['## 问题描述', '', description || '（无描述）', '', `**triage**: ${triage}`];
  if (p.change_ref) parts.push(`**change_ref**: ${p.change_ref}`);
  if (changeDraft) parts.push('', '## 诊断摘要', '', changeDraft);
  const discussion =
    Array.isArray(p.discussion) && p.discussion.length > 0
      ? p.discussion.map((d) => `- **${d?.author ?? '匿名'}**: ${d?.text ?? ''}`).join('\n')
      : '';
  if (discussion) parts.push('', '## 讨论摘要', '', discussion);

  const body = redactKey(redactText(parts.join('\n')), envKey);
  return { title, body };
}

// --- repo resolution ---------------------------------------------------------

const defaultExecAsync = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    nodeExecFile(file, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(String(stdout ?? ''));
    });
  });

// 解析目标仓库：先 git remote origin，失败回退 gh repo view。返回 null 表示解析不出。
export async function resolveRepo({ cwd = repoRoot, execAsync = defaultExecAsync } = {}) {
  try {
    const stdout = await execAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    const repo = resolveRepoFromRemoteUrl(stdout);
    if (repo) return repo;
  } catch {
    /* fall through to gh repo view */
  }
  try {
    const stdout = await execAsync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd });
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.includes('/')) {
      return parsed.nameWithOwner;
    }
  } catch {
    /* unresolved */
  }
  return null;
}

// --- gh child process --------------------------------------------------------

// 起 gh 子进程并收集 stdout/stderr，解析 spawn error / close 退出码 / 超时。
// 超时保护：gh 意外进入交互式等待（如设备登录）时不挂死服务端请求。
function spawnGh(spawnFn, args, env, cwd, timeoutMs = 60_000) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnFn('gh', args, { env, cwd });
    } catch (e) {
      resolvePromise({ spawnError: e });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolvePromise({ timeout: true, stdout, stderr });
    }, timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(payload);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

// 把 gh 的非零退出映射为明确的中文错误；stderr 一律净化后再进错误消息。
function mapGhFailure(code, stderr, envKey) {
  const safeStderr = redactKey(stderr, envKey);
  if (/not logged in|please run:\s*gh auth login|authentication required|to authenticate/i.test(safeStderr)) {
    return {
      error: 'gh 未登录：请先运行 gh auth login',
      exitCode: code,
      stderr: safeStderr,
    };
  }
  return {
    error: `gh issue create 失败（exit ${code}）：${safeStderr.trim() || '无错误输出'}`,
    exitCode: code,
    stderr: safeStderr,
  };
}

// --- main entry --------------------------------------------------------------

// 创建一个 GitHub issue。`repo` 覆盖仓库（缺省自动解析）；`dryRun` 只返回将要执行的
// argv，不 spawn gh（测试用）。`env`/`spawnFn`/`execAsync`/`sanitizeEnv` 可注入。
// 返回：
//   { ok: true,  issue_number, url, repo, dryRun: false }          成功
//   { ok: true,  dryRun: true, repo, title, body, labels, args }   预演
//   { ok: false, error, exitCode?, stderr?, repo }                 失败
export function createGithubIssue(problem, opts = {}) {
  const {
    repo = null,
    dryRun = false,
    labels = null,
    env = process.env,
    cwd = repoRoot,
    spawnFn = nodeSpawn,
    execAsync = defaultExecAsync,
    sanitizeEnv = sanitizeChildEnv,
    spawnTimeoutMs = 60_000,
  } = opts;
  return createGithubIssueImpl(problem, {
    repo,
    dryRun,
    labels,
    env,
    cwd,
    spawnFn,
    execAsync,
    sanitizeEnv,
    spawnTimeoutMs,
  });
}

export async function createGithubIssueImpl(
  problem,
  { repo, dryRun, labels, env, cwd, spawnFn, execAsync, sanitizeEnv, spawnTimeoutMs }
) {
  const envKey = env?.ANTHROPIC_API_KEY;
  const { title, body } = buildIssuePayload(problem, { envKey });
  const targetRepo = repo ?? (await resolveRepo({ cwd, execAsync }));
  if (!targetRepo) {
    return {
      ok: false,
      error: '无法解析 GitHub 仓库（git remote / gh repo view 均失败）；请用 repo 参数显式指定',
      repo: null,
    };
  }

  // 默认不传 --label（避免依赖仓库预建 label；triage 由标题 [bug]/[design]/[discuss]
  // 前缀标记）。仅当调用方显式传入 labels 时才附加。
  const args = ['issue', 'create', '--repo', targetRepo, '--title', title, '--body', body];
  const effectiveLabels = Array.isArray(labels) && labels.length > 0 ? labels.filter(Boolean) : [];
  for (const label of effectiveLabels) args.push('--label', label);

  if (dryRun) {
    return { ok: true, dryRun: true, repo: targetRepo, title, body, labels: effectiveLabels, args };
  }

  const childEnv = sanitizeEnv(env);
  const spawned = await spawnGh(spawnFn, args, childEnv, cwd, spawnTimeoutMs);
  if (spawned.timeout) {
    return {
      ok: false,
      error: `gh issue create 超时（${Math.round(spawnTimeoutMs / 1000)}s 无响应），请检查 gh 是否在等待登录或网络是否可用`,
      repo: targetRepo,
    };
  }
  if (spawned.spawnError) {
    if (spawned.spawnError.code === 'ENOENT') {
      return { ok: false, error: 'gh 不可用：未找到 gh 命令（请先安装 GitHub CLI）', repo: targetRepo };
    }
    return {
      ok: false,
      error: `gh 执行失败：${redactKey(spawned.spawnError.message, envKey)}`,
      repo: targetRepo,
    };
  }
  if (spawned.code !== 0) {
    const { error, exitCode, stderr } = mapGhFailure(spawned.code, spawned.stderr, envKey);
    return { ok: false, error, exitCode, stderr, repo: targetRepo };
  }

  const url = String(spawned.stdout ?? '').trim();
  const issueNumber = parseIssueNumber(url);
  if (!issueNumber) {
    return {
      ok: false,
      error: 'gh issue create 成功但无法从输出解析 issue 号',
      stdout: url,
      repo: targetRepo,
    };
  }
  return { ok: true, issue_number: issueNumber, url, repo: targetRepo, dryRun: false, title, body };
}
