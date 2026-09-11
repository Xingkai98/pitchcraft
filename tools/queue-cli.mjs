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

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildReplayInstructions } from './service.mjs';
import { confirmTask, redactTaskText } from './runner.mjs';
import { describeEvent, isCandidateEvent } from '../viewer/event-labels.js';
import { redactCredentialText, redactKey } from './provider.mjs';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

export const isCaptured = (task) => Boolean(task && task.status === 'captured');

// 可（重新）取任务：captured 待处理，或失败终态但任务源自入队（status_history 以
// captured 开头）——上次取任务失败（provider_unavailable/failed）不应永久消费队列项，
// 用户可再取一次续跑同一 runId。
export function isRerunnable(task) {
  if (!task) return false;
  if (task.status === 'captured') return true;
  // P20：confirmed（已确认锚点，等诊断）与 captured 同语义——都是「等人来取」的待处理态，
  // 确认步不自动触发诊断，由 queue-cli run 取走。
  if (task.status === 'confirmed') return true;
  const failedTerminal = ['failed', 'provider_unavailable', 'insufficient_evidence'].includes(task.status);
  return failedTerminal && Array.isArray(task.status_history) && task.status_history[0]?.status === 'captured';
}

// P20：可跑提案的任务态——captured 尚未提案，或 awaiting_confirmation/confirmed 想重新提案
// （提案可重跑，见 runProposal）。
export function isProposable(task) {
  if (!task) return false;
  return ['captured', 'awaiting_confirmation', 'confirmed'].includes(task.status);
}

// P20：任务是否「有下一步可做」——list 用它决定是否列进可取清单。captured/failed-retryable
// 可 run；awaiting_confirmation/confirmed 可 confirm 或 run。确认步的任务**不该**从 list 消失
// （list 是用户找待办的地方），故把确认两态也算可操作。
export function isActionable(task) {
  return isRerunnable(task) || isProposable(task);
}

// 状态 → list 里的提示后缀。之前是「非 captured 一律 (失败，可重试)」的二元判断，
// 会把已确认/待确认（乃至已诊断）的任务误标成失败——P20 新增两态后必须按状态给准确提示。
export function statusHint(status) {
  switch (status) {
    case 'captured':
      return '';
    case 'awaiting_confirmation':
      return ' (待确认事件锚点)';
    case 'confirmed':
      return ' (已确认，待跑诊断)';
    // 活动态（已被取走/在跑）：不是失败，别催重试。
    case 'auditing':
    case 'audit_ready':
    case 'diagnosing':
      return ' (进行中)';
    // 已出结果：--all 里出现时不是失败。
    case 'diagnosed':
      return ' (已完成)';
    case 'insufficient_evidence':
      return ' (证据不足)';
    // 失败终态（provider_unavailable/failed）与未知状态：可重试。
    default:
      return ' (失败，可重试)';
  }
}

// list 里的提示后缀（含重试可行性判断）。失败态里只有**可重试**（源自入队）的才提示
// 「可重试」——否则 --all 里一个非入队源的失败任务会写着「可重试」，而 run 实际拒收。
export function listHint(task) {
  const status = task?.status;
  if (status === 'failed' || status === 'provider_unavailable') {
    return isRerunnable(task) ? ' (失败，可重试)' : ' (失败)';
  }
  return statusHint(status);
}

// 状态 → 该状态下的「下一步命令」提示（list 尾部提示行）。以任务为单位判断，使失败但
// 不可重试的任务不给「重试」提示。
export function nextStepHint(task) {
  const status = task?.status;
  const id = task?.run_id ?? '<task-id>';
  if (status === 'awaiting_confirmation') {
    return `待确认锚点：node tools/queue-cli.mjs --tasks-dir <dir> events ${id}  →  confirm ${id} --events 3,5`;
  }
  if (status === 'confirmed') {
    return `跑诊断：node tools/queue-cli.mjs --tasks-dir <dir> run ${id}`;
  }
  if (status === 'captured') {
    return `提案：node tools/queue-cli.mjs --tasks-dir <dir> propose ${id}  →  或直接 run ${id}`;
  }
  return isRerunnable(task)
    ? `重试：node tools/queue-cli.mjs --tasks-dir <dir> run ${id}`
    : `查看：node tools/queue-cli.mjs --tasks-dir <dir> events ${id}`;
}

// P20：解析 `confirm <id> --events 3,5` 的 --events 值 → 非负整数数组。空串 → []。
// 非法（非数字/负数/空项）抛错，让 CLI 明确拒绝而不是静默丢弃用户输入。
export function parseEventIndexes(spec) {
  const s = String(spec ?? '').trim();
  if (s === '') return [];
  return s.split(',').map((part) => {
    const t = part.trim();
    if (!/^\d+$/.test(t)) throw new Error(`--events 含非法 index: ${JSON.stringify(part)}`);
    return Number(t);
  });
}

// P20：把窗口事件渲染成人话标签行，供 `queue-cli events` 展示（与页面共用 describeEvent）。
// 默认只列高亮事件（design：shot/pass/corner/tackle/foul/throw_in）；showAll 时列全量（beat 折叠）。
export function formatEventLines(bundle, { showAll = false } = {}) {
  const events = Array.isArray(bundle?.events) ? bundle.events : [];
  const lineup = Array.isArray(bundle?.lineup) ? bundle.lineup : null;
  const shown = showAll ? events : events.filter(isCandidateEvent);
  return shown.map((e) => describeEvent(e, lineup));
}

// 组装 runner-cli --propose 参数（纯函数，可测）：只提案不诊断，故不需要 audit/replay/
// revision。opts 里的 provider 覆盖参数（provider/command/model/permission/budget/timeout/
// maxRetry）与 run 同一套，缺省即不传（复核 N2：此前 propose 会静默丢弃这些 flag）。
export function buildProposeArgs({ tasksDir, taskId, statement = null, opts = {}, runnerCliPath = join(TOOLS_DIR, 'runner-cli.mjs') }) {
  const args = [
    runnerCliPath,
    '--bundle', join(tasksDir, `${taskId}.bundle.json`),
    '--tasks-dir', tasksDir,
    '--run-id', taskId,
    '--propose',
  ];
  if (statement) args.push('--statement', statement);
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
  return `usage: node tools/queue-cli.mjs --tasks-dir DIR <command> [task-id] [options]

commands:
  list                  list queue tasks you can pick up (captured + failed-but-retryable),
                        newest first. Add --all to include every task.
  run <task-id>         pick up a queued task and run its diagnosis
                        (paths/replay/revision are derived from the stored bundle;
                        failed attempts can be retried with the same task-id)
  propose <task-id>     P20: run the event-anchoring PROPOSAL step (no diagnosis).
                        Writes awaiting_confirmation + proposal to the task.
  events <task-id>      P20: show the proposal + the window events as human labels.
                        Add --all to expand past the highlight events (incl. beat).
  confirm <task-id>     P20: confirm the event anchors -> status confirmed (no diagnosis).
                        --events 3,5   anchor these event indexes (default: none)
                        --note "..."   optional free-text note

options:
  --tasks-dir DIR       directory the service/runner persists task files into (required)
  --provider NAME       provider adapter (default: claude-code)
  --command CMD         provider executable (default: claude)
  --model M             provider model
  --permission MODE     bypass (default) | read-only | plan | ...
  --budget USD          max API spend
  --timeout SECONDS     provider timeout (default: 300)
  --max-retry N         retries on invalid agent output (default: 1)
  --events LIST         (with confirm) comma-separated event indexes, e.g. 3,5
  --note TXT            (with confirm) note recorded on the confirmation
  --all                 (with list) also show tasks you cannot pick up;
                        (with events) expand past the highlight events
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
    else if (a === '--events') opts.events = next();
    else if (a === '--note') opts.note = next();
    else if (a === '--all') opts.all = true;
    else positional.push(a);
  }
  opts.commandName = positional[0] ?? null;
  opts.taskId = positional[1] ?? null;
  return opts;
}

// 读 bundle（propose/events/confirm 都要）。缺失/不可解析返回 null，由调用方报错。
function readBundle(tasksDir, taskId) {
  const p = join(tasksDir, `${taskId}.bundle.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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
    const ready = tasks.filter(isActionable);
    const rest = opts.all ? tasks.filter((t) => !isActionable(t)) : [];
    const shown = opts.all ? [...ready, ...rest] : ready;
    if (shown.length === 0) {
      console.log(`没有可取的队列任务（captured 待提案/待确认/已确认，或失败可重试）。共 ${tasks.length} 个任务（加 --all 查看全部）。`);
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
      console.log(`${t.status.padEnd(20)} ${String(t.run_id).padEnd(12)} started=${t.started_at ?? '?'}${info}${listHint(t)}${stmt ? `  「${String(stmt).slice(0, 60)}」` : ''}`);
    }
    if (ready.length > 0) {
      console.log(`\n下一步（按状态）：\n  ${nextStepHint(ready[0])}`);
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

  if (commandName === 'propose') {
    if (!taskId) {
      console.error('propose 需要 <task-id>。先 list 看队列。');
      process.exitCode = 2;
      return;
    }
    const task = readTask(tasksDir, taskId);
    if (!task) {
      console.error(`task ${taskId} 不存在于 ${tasksDir}`);
      process.exitCode = 2;
      return;
    }
    if (!isProposable(task)) {
      console.error(`task ${taskId} 状态是 ${task.status}，不可提案（只对 captured/awaiting_confirmation/confirmed）。`);
      process.exitCode = 2;
      return;
    }
    const bundle = readBundle(tasksDir, taskId);
    if (!bundle) {
      console.error(`bundle 缺失或无法解析：${join(tasksDir, `${taskId}.bundle.json`)}`);
      process.exitCode = 2;
      return;
    }
    // 复用 runner-cli --propose：只提案不诊断。statement 优先用旧任务 input_summary，
    // 回退 bundle.statement（captured 任务 input_summary 为空）。
    const statement = task.input_summary?.statement ?? bundle.statement ?? null;
    const args = buildProposeArgs({ tasksDir, taskId, statement, opts });
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }

  if (commandName === 'events') {
    if (!taskId) {
      console.error('events 需要 <task-id>。');
      process.exitCode = 2;
      return;
    }
    const task = readTask(tasksDir, taskId);
    if (!task) {
      console.error(`task ${taskId} 不存在于 ${tasksDir}`);
      process.exitCode = 2;
      return;
    }
    const bundle = readBundle(tasksDir, taskId);
    if (!bundle) {
      console.error(`bundle 缺失或无法解析：${join(tasksDir, `${taskId}.bundle.json`)}`);
      process.exitCode = 2;
      return;
    }
    console.log(`task ${taskId}  status=${task.status}`);
    if (bundle.statement) console.log(`描述：${bundle.statement}`);
    // 提案（模型候选 + 漂移提示）。
    const proposal = task.proposal;
    if (proposal) {
      const src = proposal.source === 'fallback-empty' ? '（无模型：从下方全量列表自行勾选）' : '';
      console.log(`\n提案 [${proposal.source}] ${src}`);
      if (Array.isArray(proposal.candidates) && proposal.candidates.length > 0) {
        const byIndex = new Map((bundle.events ?? []).map((e) => [e.index, e]));
        for (const c of proposal.candidates) {
          const label = byIndex.has(c.index) ? describeEvent(byIndex.get(c.index), bundle.lineup) : `#${c.index}`;
          console.log(`  ✔ ${label}${c.why ? `  — ${c.why}` : ''}`);
        }
      } else {
        console.log('  （无候选）');
      }
      for (const h of proposal.drift_hints ?? []) {
        console.log(`  ⚠️ 描述里的「${h.mention}」：${h.hint}`);
      }
    } else {
      console.log('\n（尚未提案 —— 先 `propose` 让模型给候选）');
    }
    // 已确认锚点。
    if (task.confirmation) {
      console.log(`\n已确认锚点 [${task.confirmation.source}]：${task.confirmation.event_indexes.join(', ') || '（空）'}${task.confirmation.note ? `  note=${task.confirmation.note}` : ''}`);
    }
    // 窗口事件全量/高亮人话标签。
    const lines = formatEventLines(bundle, { showAll: opts.all });
    const header = opts.all ? '窗口事件（全量）' : '窗口高亮事件（--all 展开全部，含 beat）';
    console.log(`\n${header}：`);
    if (lines.length === 0) console.log('  （窗口内无高亮事件 —— 加 --all 看全部）');
    for (const l of lines) console.log(`  ${l}`);
    console.log(`\n确认锚点：node tools/queue-cli.mjs --tasks-dir <dir> confirm ${taskId} --events 3,5`);
    return;
  }

  if (commandName === 'confirm') {
    if (!taskId) {
      console.error('confirm 需要 <task-id>。');
      process.exitCode = 2;
      return;
    }
    let eventIndexes;
    try {
      eventIndexes = parseEventIndexes(opts.events ?? '');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    const task = readTask(tasksDir, taskId);
    if (!task) {
      console.error(`task ${taskId} 不存在于 ${tasksDir}`);
      process.exitCode = 2;
      return;
    }
    // 走与 service 共用的 confirmTask，避免两处校验/流转漂移。
    const result = confirmTask(task, {
      event_indexes: eventIndexes,
      source: 'cli',
      note: redactCredentialText(redactKey(opts.note ?? '', process.env.ANTHROPIC_API_KEY)),
    });
    if (!result.ok) {
      console.error(`确认失败（${result.code}）：${result.error}`);
      process.exitCode = result.code === 'NOT_FOUND' ? 2 : 1;
      return;
    }
    const taskPath = join(tasksDir, `${taskId}.task.json`);
    try {
      writeFileSync(taskPath, JSON.stringify(JSON.parse(redactTaskText(result.task, process.env.ANTHROPIC_API_KEY)), null, 2));
    } catch (e) {
      console.error(`写任务失败：${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`task ${taskId} 已确认 → confirmed`);
    console.log(`  锚点：${result.task.confirmation.event_indexes.join(', ') || '（空）'}`);
    if (result.task.confirmation.note) console.log(`  note：${result.task.confirmation.note}`);
    // confirmed 与 captured 同语义：等人来取诊断（不自动跑）。
    console.log(`\n跑诊断：node tools/queue-cli.mjs --tasks-dir <dir> run ${taskId}`);
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
