// 重新生成 tools/fixtures/real-audit-input.json（P21 P4.1）。
//
// 真实形状的来源：不手写任何字段值——用真实引擎（viewer/engine.wasm）跑到真实比赛，
// 走真实采集链路（protocol.parseEventStream → Game → observation.captureObservation），
// 把真实 audit_input 抽出来落盘。这样 fixture 里的 `result:"contested"` + `detail:"out_*"`
// + 钳制坐标就是生产链路真实产出的形状，而不是我们对形状的猜测。
//
// 用法（仓库根）：
//   1) 先有 viewer/engine.wasm：
//      (cd engine && cargo build --target wasm32-unknown-unknown --release) \
//        && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm
//   2) node tools/fixtures/generate-real-audit-fixture.mjs
//
// 不进测试路径（verify.sh 只 glob tools/*.test.mjs），测试直接读落盘的 JSON。
// 输出为确定性：固定 seed/duration/window/采样，同一 engine.wasm 产生同一文件。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'real-audit-input.json');
const WASM = join(ROOT, 'viewer', 'engine.wasm');

const SEED = 42;
const DURATION = 5400; // 90 分钟
const WINDOW = { before: 5, after: 5 }; // 项目默认采集窗口（observation.js 默认 ±5s）
// 每个窗口最多保留多少名球员的快照子集（控制 fixture 体积；事件不裁剪）。
// 2 足够覆盖 is_gk / responsibility / moved_toward_* / dead_ball 全部可观测标记。
const MAX_PLAYER_SUBSET = 2;

// fixture 覆盖的真实窗口：出界（sideline/goal_line）、四类排除位、死球快照。
// `match_time` 取自真实流里第一个该 detail 的 pass 事件时间（见 pickWindows）。
const LABELS = ['out_sideline', 'throw_in', 'free_kick', 'corner', 'out_goal_line', 'clearance'];

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!readFileSync) fail('unreachable');
let wasmBytes;
try {
  wasmBytes = readFileSync(WASM);
} catch {
  fail(
    `缺少 ${WASM}。先构建 WASM：\n` +
      '  (cd engine && cargo build --target wasm32-unknown-unknown --release)\n' +
      '  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm'
  );
}

const { config } = await import(join(ROOT, 'viewer', 'config.js'));

async function main() {
  const { parseEventStream } = await import(join(ROOT, 'viewer', 'protocol.js'));
  const { Game } = await import(join(ROOT, 'viewer', 'game.js'));
  const { captureObservation } = await import(join(ROOT, 'viewer', 'observation.js'));

  // 关掉调试日志；关掉跳过机制（跳过会让 playTime 跳变，采集窗口不对齐）。
  config.debug.enabled = false;
  config.playback.skipThresholdSeconds = Infinity;

  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const SCRATCH = 1024;
  const cfgBytes = encoder.encode(JSON.stringify({ match_duration_seconds: DURATION }));
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfgBytes.length).set(cfgBytes);
  wasm.simulate(BigInt(SEED), SCRATCH, cfgBytes.length);
  const outPtr = wasm.get_json_ptr();
  const outLen = wasm.get_json_length();
  const raw = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen)));
  wasm.free_json();

  const { events, lineup } = parseEventStream(raw);

  // 每个 label 取真实流里第一个命中的 pass 事件时间。
  const pickWindows = () => {
    const picked = {};
    for (const e of events) {
      if (e.type !== 'pass' || !e.detail) continue;
      if (LABELS.includes(e.detail) && picked[e.detail] === undefined) picked[e.detail] = e.t;
    }
    return picked;
  };
  const picked = pickWindows();

  // 死球窗口：真实 whistle 时刻（快照 dead_ball 标记的唯一来源）。
  const whistleT = events.find((e) => e.type === 'whistle')?.t ?? DURATION;
  for (const label of LABELS) {
    if (picked[label] === undefined) fail(`真实流里找不到 detail=${label} 的 pass 事件`);
  }

  const windowAt = (matchTime) => {
    const game = new Game(events, lineup, 'continuous');
    game.seekTo(matchTime);
    const bundle = captureObservation({
      game,
      statement: '',
      selectedEntities: [],
      window: WINDOW,
      seed: SEED,
      config: { match_duration_seconds: DURATION },
      sourceRevision: '<fixture>',
      opts: { idFactory: () => 'obs-fixture', now: 1700000000000 },
    });
    return bundle.audit_input;
  };

  // 球员快照子集：只保留「带可观测标记」的球员（is_gk / responsibility / moved_toward_* /
  // dead_ball），快照本身逐字段保留、不裁剪不重写。事件不裁剪。
  const trimPlayers = (players) => {
    const scored = [];
    for (const [id, snaps] of Object.entries(players ?? {})) {
      const flags = new Set();
      for (const s of snaps) {
        if (s.is_gk) flags.add('is_gk');
        if (s.responsibility) flags.add('responsibility');
        if (s.moved_toward_goal) flags.add('moved_toward_goal');
        if (s.moved_toward_ball) flags.add('moved_toward_ball');
        if (s.dead_ball) flags.add('dead_ball');
      }
      scored.push({ id, snaps, score: flags.size, flags: [...flags].sort() });
    }
    scored.sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id));
    const kept = scored.filter((s) => s.score > 0).slice(0, MAX_PLAYER_SUBSET);
    const out = {};
    for (const s of kept) out[s.id] = s.snaps;
    return {
      players: out,
      kept: kept.map((s) => ({ id: s.id, flags: s.flags, snapshot_count: s.snaps.length })),
      dropped_player_count: Object.keys(players ?? {}).length - kept.length,
    };
  };

  const windows = [];
  for (const label of LABELS) {
    const matchTime = picked[label];
    const auditInput = windowAt(matchTime);
    const trimmed = trimPlayers(auditInput.players);
    windows.push({
      label,
      match_time: matchTime,
      notes: `real capture at t=${matchTime}s (window ±${WINDOW.before}s); events verbatim`,
      audit_input: {
        ...auditInput,
        players: trimmed.players,
      },
      _player_subset: { kept: trimmed.kept, dropped_player_count: trimmed.dropped_player_count },
    });
  }
  // 死球窗口：证明快照 dead_ball 有生产者。
  {
    const auditInput = windowAt(whistleT);
    const trimmed = trimPlayers(auditInput.players);
    windows.push({
      label: 'whistle_dead_ball',
      match_time: whistleT,
      notes: `real whistle capture at t=${whistleT}s; snapshot dead_ball flag is produced here`,
      audit_input: { ...auditInput, players: trimmed.players },
      _player_subset: { kept: trimmed.kept, dropped_player_count: trimmed.dropped_player_count },
    });
  }

  const fixture = {
    _provenance: {
      generator: 'tools/fixtures/generate-real-audit-fixture.mjs',
      how: 'real engine.wasm -> protocol.parseEventStream -> Game.seekTo -> observation.captureObservation -> audit_input',
      seed: SEED,
      match_duration_seconds: DURATION,
      window: WINDOW,
      event_indexes_reference: 'events are verbatim from the real capture; player snapshots are the verbatim real snapshots of the players carrying observable flags',
      warnings: [
        'does not contain dead_ball/corner/throw_in/goal_kick/contested boolean keys: the engine never produces them (that is the bug this change fixes)',
        'out passes carry result:"contested" + detail:"out_*" and CLAMPED landing coords (y2=0 / x2=105)',
      ],
    },
    windows,
  };

  mkdirSync(HERE, { recursive: true });
  // 紧凑写出（不缩进）：这是机器生成、机器消费的真实数据 fixture，缩进会让
  // 体积翻近三倍。形状由生成器与 tools/detector-field-contract.test.mjs 共同说明；
  // 需要人眼核对时用 `node -e "..."` 或 jq 取单个窗口。
  writeFileSync(OUT, `${JSON.stringify(fixture)}\n`);
  const bytes = readFileSync(OUT).length;
  console.log(`wrote ${OUT} (${bytes} bytes, ${windows.length} windows)`);
  for (const w of windows) {
    const passes = w.audit_input.events.filter((e) => e.type === 'pass');
    console.log(
      `  ${w.label.padEnd(18)} t=${String(w.match_time).padStart(5)} ` +
        `events=${w.audit_input.events.length} passes=${passes.length} ` +
        `players=${Object.keys(w.audit_input.players).length} details=[${passes.map((p) => p.detail ?? '-').join(',')}]`
    );
  }
  if (bytes > 150000) console.warn(`警告：fixture 体积 ${bytes} 字节，考虑收紧子集`);
}

await main();
