#!/usr/bin/env node
// P14 queue-only 取任务 CLI。
//
// 页面在 queue-only 模式下只把观察入队（bundle + captured task 落盘），不自动诊断。
// 本 CLI 让用户在 paseo / shell 侧：
//   list            列出队列中 captured（待处理）与所有任务
//   run <id> [opts] 取一个队列任务手动跑诊断（自动从 bundle 推导 bundle/audit 路径、
//                   replay 指令与 source revision，无需手工拼路径）
//
// Usage:
//   node tools/queue-cli.mjs --tasks-dir DIR list
//   node tools/queue-cli.mjs --tasks-dir DIR run <task-id> [--provider ...] [--permission ...]
//
// run 内部复用 runner-cli 的参数（--provider/--command/--model/--permission/--budget/
// --timeout/--max-retry），并透传 --run-id <task-id> 续跑该 captured 任务。
// 凭证只从进程环境读，绝不落盘/打印。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildReplayInstructions } from './service.mjs';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

export const isCaptured = (task) => Boolean(task && task.status === 'captured');

// 可（重新）取任务：captured 待处理，或失败终态但任务源自入队（status_history 以
// captured 开头）——上次取任务失败（provider_unavailable/failed）不应永久消费队列项，
// 用户可再取一次续跑同一 runId。
export function isRerunnable(task) {
  if (!task) return false;
  if (task.status === 'captured') return true;
  const failedTerminal = ['failed', 'provider_unavailable', 'insufficient_evidence'].includes(task.status);
  return failedTerminal && Array.isArray(task.status_history) && task.status_history[0]?.status === 'captured';
}

// 组装 runner-cli 参数（纯函数，可测）：从 captured 任务 id + bundle 推导
// bundle/audit/replay/revision，并透传 --run-id。opts 为 runner-cli 覆盖参数。
// runnerCliPath 可注入（测试用），默认用本文件所在 tools/ 目录下的 runner-cli.mjs 绝对路径，
// 使 queue-cli 从任意 cwd 运行都能 spawn 到正确脚本。
export function buildRunArgs({ tasksDir, taskId, bundle, opts = {}, runnerCliPath = join(TOOLS_DIR, 'runner-cli.mjs') }) {
  const replay = buildReplayInstructions(bundle);
  const revision = bundle.source_revision ?? '<unknown>';
  const args = [
    runnerCliPath,
    '--bundle', join(tasksDir, `${taskId}.bundle.json`),
    '--audit', join(tasksDir, `${taskId}.audit.json`),
    '--replay', replay,
    '--revision', revision,
    '--tasks-dir', tasksDir,
    '--run-id', taskId,
  ];
  const argMap = {
    provider: 'provider',
    command: 'command',
    model: 'model',
    permission: 'permission',
    budget: 'budget',
    timeout: 'timeout',
    maxRetry: 'max-retry',
  };
  for (const [optKey, flag] of Object.entries(argMap)) {
    if (opts[optKey]) args.push(`--${flag}`, opts[optKey]);
  }
  return args;
}

function readTask(tasksDir, id) {
  const p = join(tasksDir, `${id}.task.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listTasks(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith('.task.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(tasksDir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
}

function usage() {
  return `usage: node tools/queue-cli.mjs --tasks-dir DIR <list|run> [task-id] [options]

commands:
  list                  list queue tasks you can pick up (captured + failed-but-retryable),
                        newest first. Add --all to include every task.
  run <task-id>         pick up a queued task and run its diagnosis
                        (paths/replay/revision are derived from the stored bundle;
                        failed attempts can be retried with the same task-id)

options:
  --tasks-dir DIR       directory the service/runner persists task files into (required)
  --provider NAME       provider adapter (default: claude-code)
  --command CMD         provider executable (default: claude)
  --model M             provider model
  --permission MODE     bypass (default) | read-only | plan | ...
  --budget USD          max API spend
  --timeout SECONDS     provider timeout (default: 300)
  --max-retry N         retries on invalid agent output (default: 1)
  --all                 (with list) also show tasks you cannot pick up (diagnosed/auditing/etc.)
`;
}

function parseArgv(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--tasks-dir') opts.tasksDir = next();
    else if (a === '--provider') opts.provider = next();
    else if (a === '--command') opts.command = next();
    else if (a === '--model') opts.model = next();
    else if (a === '--permission') opts.permission = next();
    else if (a === '--budget') opts.budget = next();
    else if (a === '--timeout') opts.timeout = next();
    else if (a === '--max-retry') opts.maxRetry = next();
    else if (a === '--all') opts.all = true;
    else positional.push(a);
  }
  opts.commandName = positional[0] ?? null;
  opts.taskId = positional[1] ?? null;
  return opts;
}

function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help || !opts.tasksDir || !opts.commandName) {
    console.log(usage());
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  const tasksDir = opts.tasksDir;
  const { commandName, taskId } = opts;

  if (commandName === 'list') {
    const tasks = listTasks(tasksDir);
    if (tasks.length === 0) {
      console.log('(队列为空)');
      return;
    }
    const ready = tasks.filter(isRerunnable);
    const rest = opts.all ? tasks.filter((t) => !isRerunnable(t)) : [];
    const shown = opts.all ? [...ready, ...rest] : ready;
    if (shown.length === 0) {
      console.log(`没有可取的队列任务（captured 或失败可重试）。共 ${tasks.length} 个任务（加 --all 查看全部）。`);
      return;
    }
    for (const t of shown) {
      // captured 任务 input_summary 为空 → best-effort 读 bundle 补 statement/seed/match_time
      let stmt = t.input_summary?.statement ?? '';
      let info = '';
      if (!stmt) {
        try {
          const b = JSON.parse(readFileSync(join(tasksDir, `${t.run_id}.bundle.json`), 'utf8'));
          stmt = b.statement ?? '';
          if (b.seed != null || b.match_time != null) {
            info = ` seed=${b.seed ?? '?'} t=${b.match_time ?? '?'}`;
          }
        } catch { /* bundle 缺失/不可读——只显示 id */ }
      }
      const hint = t.status === 'captured' ? '' : ' (失败，可重试)';
      console.log(`${t.status.padEnd(14)} ${String(t.run_id).padEnd(12)} started=${t.started_at ?? '?'}${info}${hint}${stmt ? `  「${String(stmt).slice(0, 60)}」` : ''}`);
    }
    if (ready.length > 0) {
      console.log(`\n取任务跑：node tools/queue-cli.mjs --tasks-dir <dir> run <task-id>`);
    }
    return;
  }

  if (commandName === 'run') {
    if (!taskId) {
      console.error('run 需要 <task-id>。先 list 看队列。');
      process.exitCode = 2;
      return;
    }
    const task = readTask(tasksDir, taskId);
    if (!task) {
      console.error(`task ${taskId} 不存在于 ${tasksDir}`);
      process.exitCode = 2;
      return;
    }
    if (!isRerunnable(task)) {
      console.error(`task ${taskId} 状态是 ${task.status}，不可取（只取 captured 或失败可重试任务）。`);
      process.exitCode = 2;
      return;
    }
    const bundlePath = join(tasksDir, `${taskId}.bundle.json`);
    if (!existsSync(bundlePath)) {
      console.error(`bundle 缺失：${bundlePath}`);
      process.exitCode = 2;
      return;
    }
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    } catch {
      console.error(`bundle 无法解析：${bundlePath}`);
      process.exitCode = 2;
      return;
    }
    // 复用 runner-cli：自动推导 bundle/audit/replay/revision + 透传 --run-id。
    const args = buildRunArgs({ tasksDir, taskId, bundle, opts });
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }

  console.error(`未知命令：${commandName}`);
  console.log(usage());
  process.exitCode = 2;
}

// 仅直接执行时跑 CLI（import 用于测试 buildRunArgs/isCaptured 时不触发）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
