// Provider adapter interface + ClaudeCodeAdapter.
//
// P10 vertical slice: run a diagnosis by spawning the local `claude`
// executable. Diagnosis defaults to bypass permission (full tool access);
// configuring `read-only`/`plan` maps to plan mode with edit tools disallowed.
// Authentication is read solely from the runner process environment
// (ANTHROPIC_API_KEY) and inherited to the child process; `--bare` disables the
// claude keychain/OAuth path so the key is the only auth source. The key value
// is never passed as an argument, written to the prompt, or persisted. No WASM.
//
// Invocation contract (confirmed against installed `claude --help`): `-p, --print`
// is the documented non-interactive mode ("Print response and exit (useful for
// pipes)"). There is no `-` stdin sentinel positional; the documented pipe form is
// `claude -p ...` with the prompt fed on stdin (default `--input-format text`).

import { spawn as nodeSpawn } from 'node:child_process';

// Read-only intent maps to Claude `plan` mode (no Edit/Write tools). The other
// entries pass through to the mode names Claude actually accepts:
// acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
const PERMISSION_MODES = {
  'read-only': 'plan',
  plan: 'plan',
  auto: 'auto',
  manual: 'manual',
  'dont-ask': 'dontAsk',
  dontAsk: 'dontAsk',
  'accept-edits': 'acceptEdits',
  bypass: 'bypassPermissions',
};

// Edit-capable tools always disallowed while read-only. Defense-in-depth on top
// of plan mode: plan mode is non-editing, and these tools are additionally
// forbidden so the safety claim is verifiable from the args.
//
// CLI contract (confirmed against installed `claude --help`): the flag is
// `--disallowedTools, --disallowed-tools <tools...>` and accepts a comma- or
// space-separated list of tool names. We emit the space-separated variadic form
// (`--disallowedTools Edit Write ...`), which this CLI parses correctly.
const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

// --- child process environment sanitization -----------------------------------

// Exact-name blocklist of Claude Code session / auth override variables. When a
// diagnosis runs under a Claude Code-hosted session, `process.env` carries these
// (CLAUDE_CODE_CHILD_SESSION, CLAUDE_PID, ANTHROPIC_AUTH_TOKEN, ...); passing
// them to a spawned `claude` child pulls it back into the parent child-session /
// proxy path instead of `--bare` direct-key auth to the default endpoint.
const CHILD_ENV_BLOCKLIST = new Set([
  'CLAUDE_PID',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'AI_AGENT',
  'CLAUDECODE',
]);

// Prefix blocklist: `CLAUDE_CODE_*` (session id, execpath, entrypoint, child
// session flag, ...) and `ANTHROPIC_DEFAULT_*` (model overrides).
const isBlockedEnvKey = (key) =>
  CHILD_ENV_BLOCKLIST.has(key) ||
  key.startsWith('CLAUDE_CODE_') ||
  key.startsWith('ANTHROPIC_DEFAULT_');

// Return a sanitized copy of `env` for the provider child process. Keeps base
// variables (PATH/HOME/TERM/LANG/SHELL/...), proxy variables (a user behind a
// proxy needs HTTP(S)_PROXY/NO_PROXY to reach the API), and — critically —
// `ANTHROPIC_API_KEY`. Strips the session/auth variables listed above so `--bare`
// semantics hold. The input is never mutated.
export function sanitizeChildEnv(env = process.env) {
  if (!env) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isBlockedEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

const DEFAULT_SPAWN = (command, args, opts) => nodeSpawn(command, args, opts);

// Create the adapter for a provider name. The provider config only carries
// command/model/permission/budget/timeout — never credentials.
export function createProviderAdapter(config, deps = {}) {
  const provider = config?.provider || 'claude-code';
  if (provider === 'claude-code') return new ClaudeCodeAdapter(config, deps);
  throw new Error(`unsupported provider: ${provider}`);
}

// Run a diagnosis against the local claude executable (bypass by default).
//
// Interface (shared by all adapters):
//   run(prompt, { env, timeoutMs }) -> Promise<{
//     ok, status: 'success'|'provider_unavailable'|'error'|'timeout',
//     stdout, stderr, exitCode, timedOut, error
//   }>
export class ClaudeCodeAdapter {
  constructor(config = {}, deps = {}) {
    this.config = config;
    this.spawn = deps.spawn ?? DEFAULT_SPAWN;
    this.readEnv = deps.readEnv ?? (() => process.env);
  }

  get provider() {
    return 'claude-code';
  }

  // Build the child process argument vector (the prompt itself goes via stdin).
  // Exposed for tests to assert the safety-relevant flags and the absence of
  // any credential material.
  buildArgs(env = {}) {
    const mode = PERMISSION_MODES[this.config.permission] ?? 'plan';
    // Read-only intent disallows edit-capable tools regardless of which valid
    // permission mode is configured. `read_only` defaults to true only when the
    // config omits it (fail-closed for bare construction); the runner default
    // config sets read_only=false (bypass), so the default build does NOT
    // disallow edit tools.
    const readOnly = this.config.read_only !== false;
    // Documented pipe form: `claude -p` + prompt on stdin. No standalone `-`
    // positional (claude has no stdin sentinel; `-` would be treated as a literal
    // prompt and stdin ignored). `--input-format text` is explicit but is the
    // documented default for --print.
    const args = ['-p', '--output-format', 'text', '--input-format', 'text', '--bare'];
    args.push('--permission-mode', mode);
    if (this.config.model) args.push('--model', this.config.model);
    // A configured USD budget maps to the stable claude flag --max-budget-usd
    // (works with --print). Only set when positive and finite.
    if (typeof this.config.budget === 'number' && Number.isFinite(this.config.budget) && this.config.budget > 0) {
      args.push('--max-budget-usd', String(this.config.budget));
    }
    if (readOnly) {
      args.push('--disallowedTools', ...READ_ONLY_DISALLOWED_TOOLS);
    }
    return args;
  }

  async run(
    prompt,
    {
      env = this.readEnv(),
      timeoutMs = (this.config.timeout_seconds ?? 300) * 1000,
      cwd = null,
    } = {}
  ) {
    // Authentication exists only in the process environment. If it is absent we
    // do not spawn the provider and never fabricate a run.
    if (!env || !env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        status: 'provider_unavailable',
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        error: 'ANTHROPIC_API_KEY is not set in the runner process environment',
      };
    }

    const key = env.ANTHROPIC_API_KEY;
    // Strip Claude Code session/auth overrides before spawning: the child must
    // run in `--bare` mode (direct key auth to the default endpoint), not inherit
    // the parent's child-session / proxy-auth environment. `cwd` (optional) lets
    // the caller run the provider inside an isolated worktree (P13 fix flow).
    const sanitizedEnv = sanitizeChildEnv(env);
    const args = this.buildArgs(env);
    const spawnOpts = { env: sanitizedEnv, ...(cwd ? { cwd } : {}) };
    let child;
    try {
      child = this.spawn(this.config.command || 'claude', args, spawnOpts);
    } catch (e) {
      return {
        ok: false,
        status: 'error',
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        error: `failed to spawn provider: ${e.message}`,
      };
    }

    // The child may exit before consuming stdin, causing an async EPIPE on our
    // write stream. An unhandled 'error' event on a stream would crash the
    // runner, so always attach a listener first. Benign errors (EPIPE / stream
    // destroyed) are ignored; any other stdin failure surfaces through the
    // child's own close/error path, which is authoritative and resolves once.
    const isBenignStdinError = (err) =>
      err && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err.code);
    child.stdin?.on('error', (err) => {
      if (!isBenignStdinError(err)) {
        // Non-benign: do nothing here — child 'close'/'error' will surface it.
      }
    });

    // Deliver the prompt reliably via stdin, then close it so the provider sees
    // EOF. Synchronous write errors are surfaced by close/error as well.
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* the provider exited before reading stdin; close/error will surface it */
    }

    return new Promise((resolve) => {
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
        resolve({
          ok: false,
          status: 'timeout',
          stdout: redactKey(stdout, key),
          stderr: redactKey(stderr, key),
          exitCode: null,
          timedOut: true,
          error: `provider timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };

      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        finish({
          ok: false,
          status: 'error',
          stdout: redactKey(stdout, key),
          stderr: redactKey(stderr, key),
          exitCode: null,
          timedOut: false,
          error: redactKey(err.message, key),
        });
      });
      child.on('close', (code) => {
        const safeStderr = redactKey(stderr, key);
        if (code === 0) {
          finish({
            ok: true,
            status: 'success',
            stdout: redactKey(stdout, key),
            stderr: safeStderr,
            exitCode: code,
            timedOut: false,
            error: null,
          });
        } else {
          // Non-zero exit is a provider error even if stdout looks plausible;
          // never let it be treated as a successful diagnosis.
          const detail = safeStderr.trim() ? `: ${safeStderr.trim()}` : '';
          finish({
            ok: false,
            status: 'error',
            stdout: redactKey(stdout, key),
            stderr: safeStderr,
            exitCode: code,
            timedOut: false,
            error: `provider exited with code ${code}${detail}`,
          });
        }
      });
    });
  }
}

// Scrub a live key value from text before it can reach logs or persisted output.
// Also scrubs known credential-shaped value patterns (sk-ant-*, sk-proj-*,
// ghp_*, github_pat_*) anywhere in the text, not just after a key name.
export function redactKey(text, secret) {
  let out = String(text ?? '');
  if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  out = out.replace(
    /sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
    '[REDACTED]'
  );
  return out;
}

// 凭证键名判定（与 viewer/audit-report.js redactText 同口径）：归一化 key 为小写
// 字母数字后，包含 apikey/token/secret/authorization 任一即视为凭证键
// （ANTHROPIC_API_KEY、my_api_key、accessToken、clientSecret、authToken 等）。
export function hasCredentialTerm(key) {
  const n = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.includes('apikey') || n.includes('token') || n.includes('secret') || n.includes('authorization');
}

// 抹除通用凭证形状（服务端落盘/响应 final safety net，与 viewer redactText 同规则）：
// 已知凭证形值（sk-ant-*/sk-proj-*/ghp_*/github_pat_*）+ JSON 风格键值对
// `"any_credential_key":"value"`（键名允许前缀/后缀与分隔符 - _ .）+ 未加引号的
// `KEY: value` / `KEY = value`（值须像秘密：8+ 个字母数字/符号或引号包裹，避免误伤
// "token: of the month" 这类短语）。过度抹除是安全方向。
export function redactCredentialText(text) {
  let s = String(text ?? '');
  s = s.replace(
    /sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
    '[REDACTED]'
  );
  // JSON 风格键值对："client_secret":"x" / 'access-token':"y"。
  s = s.replace(
    /(["'])([A-Za-z0-9_.-]+)\1\s*:\s*(")([^"]*)(")/g,
    (m, q, key, vq, value, ve) => (hasCredentialTerm(key) ? `${q}${key}${q}: ${vq}[REDACTED]${ve}` : m)
  );
  // 未加引号 `KEY: value` / `KEY = value`：键名含凭证词且值像秘密才抹除。
  s = s.replace(
    /\b([A-Za-z0-9_.-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[A-Za-z0-9_\-./+=]{8,})/g,
    (m, key) => (hasCredentialTerm(key) ? `${key}: [REDACTED]` : m)
  );
  return s;
}
