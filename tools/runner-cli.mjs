#!/usr/bin/env node
// Local diagnosis runner CLI.
//
// Accepts an observation bundle path, validates it, runs the deterministic
// audit, then coordinates a diagnosis via the configured provider adapter
// (default permission bypass — the agent may execute verification commands and
// modify files; pass --permission read-only for the strict plan+no-edit mode).
// Prints the persisted task record (redacted — no credentials) to stdout and
// sets an exit code reflecting the task status.
//
// Usage:
//   node tools/runner-cli.mjs \
//     --bundle PATH --audit PATH --replay "..." --revision REV \
//     --tasks-dir DIR [--provider claude-code] [--command claude] \
//     [--model M] [--permission bypass] [--budget 2.5] \
//     [--timeout 300] [--max-retry 1]
//
// Reads ANTHROPIC_API_KEY only from the process environment. Never logs it.

import { runDiagnosis } from './runner.mjs';
import { loadDotEnv } from './dotenv.mjs';

function usage() {
  return `usage: node tools/runner-cli.mjs --bundle <path> --audit <path> --replay <txt> --revision <rev> --tasks-dir <dir> [options]

required:
  --bundle PATH    observation bundle JSON path
  --audit PATH     audit report output path (written by the runner)
  --replay TXT     replay / verification instructions for the diagnosis agent
  --revision REV   current source revision
  --tasks-dir DIR  directory to persist task + raw output files

options:
  --provider NAME      provider adapter (default: claude-code)
  --command CMD        provider executable (default: claude)
  --model M            provider model
  --permission MODE    bypass (default) | read-only | plan | auto | manual | dont-ask | accept-edits
                       bypass = full tool access (agent may run verification commands and modify files)
                       read-only/plan map to Claude plan mode with edit tools disallowed
  --budget USD         max API spend in USD, maps to --max-budget-usd (default: unset)
  --timeout SECONDS    provider timeout (default: 300)
  --max-retry N        retries on invalid agent output (default: 1)
  --statement TXT      optional user natural-language statement
  --run-id ID          resume a queued (captured) task by its existing id instead of
                       generating a new one (P14 queue-only manual pickup)
`;
}

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--bundle') opts.bundle = next();
    else if (a === '--audit') opts.audit = next();
    else if (a === '--replay') opts.replay = next();
    else if (a === '--revision') opts.revision = next();
    else if (a === '--tasks-dir') opts.tasksDir = next();
    else if (a === '--provider') opts.provider = next();
    else if (a === '--command') opts.command = next();
    else if (a === '--model') opts.model = next();
    else if (a === '--permission') opts.permission = next();
    else if (a === '--budget') opts.budget = Number(next());
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--max-retry') opts.maxRetry = Number(next());
    else if (a === '--statement') opts.statement = next();
    else if (a === '--run-id') opts.runId = next();
  }
  return opts;
}

async function main() {
  // Entry-layer .env loading: repo-root `.env` fills in missing process env
  // (existing values win). Parse failures warn, never exit. Values never logged.
  loadDotEnv();
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }
  const missing = ['bundle', 'audit', 'replay', 'revision', 'tasksDir'].filter(
    (k) => !opts[k]
  );
  if (missing.length > 0) {
    console.error(`missing required argument(s): ${missing.join(', ')}`);
    console.error(usage());
    process.exit(2);
  }

  const config = {
    provider: opts.provider ?? 'claude-code',
    command: opts.command ?? 'claude',
    model: opts.model ?? null,
    permission: opts.permission ?? 'bypass',
    budget: Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : null,
    timeout_seconds: opts.timeout ?? 300,
    max_retry: opts.maxRetry ?? 1,
  };

  const task = await runDiagnosis({
    bundlePath: opts.bundle,
    auditPath: opts.audit,
    replayInstructions: opts.replay,
    sourceRevision: opts.revision,
    statement: opts.statement ?? null,
    tasksDir: opts.tasksDir,
    config,
    runId: opts.runId ?? null,
  });

  // The task object is persisted redacted; printing it also carries no credential.
  console.log(JSON.stringify(task, null, 2));

  const exitCode =
    task.status === 'diagnosed' ? 0 : task.status === 'insufficient_evidence' ? 3 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`runner failed: ${err.message}`);
  process.exit(1);
});
