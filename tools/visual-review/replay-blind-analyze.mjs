// 盲测回放基线：**读评分 → 判别准确率 / 置信度 / 负控 / 暴露线索**。
//
// 用法：
//   node tools/visual-review/replay-blind-analyze.mjs \
//     --key .scratch/notes/replay-blind-baseline-2026-10-23/blind-key.json \
//     --judge /path/to/judge-a.json --judge /path/to/judge-b.json \
//     [--out .scratch/notes/replay-blind-baseline-2026-10-23/summary.json]
//
// 纪律：
//   - 只读 key + judge 文件，不改评分；
//   - 主项准确率与 0.5 基线比；n=36 的 SE ≈ 8.3pp，2–3pp 的差不结论；
//   - 负控单独报（同源/不同源 + mixed 方向），不混进主项准确率；
//   - B 分是“像不像”，不是“真假”；两者分开报，不合成单一标量。
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from './replay-blind-core.mjs';

function parseArgs(argv) {
  const out = { judge: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--judge') { out.judge.push(argv[i + 1]); i += 1; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.key || !args.judge.length) {
  console.error('用法: node replay-blind-analyze.mjs --key <blind-key.json> --judge <judge.json> [--judge ...] [--out <json>]');
  process.exit(2);
}
const key = JSON.parse(readFileSync(args.key, 'utf8'));
const judges = args.judge.map((p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { path: p, summary: C.analyzeJudgments(key, j) };
});

const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 2) => (x == null ? 'n/a' : x.toFixed(d));

for (const { path, summary } of judges) {
  const m = summary.main;
  console.log(`\n=== judge: ${summary.judge_id || path} ===`);
  console.log(`主项：${m.correct}/${m.n} = ${pct(m.accuracy)}  (95% CI ${pct(m.accuracyCI95?.lo)}–${pct(m.accuracyCI95?.hi)})`);
  console.log(`  混淆：real→real ${m.confusion.real_as_real} | real→engine ${m.confusion.real_as_engine} | engine→real ${m.confusion.engine_as_real} | engine→engine ${m.confusion.engine_as_engine}`);
  console.log(`  B 分（1–5 像不像）：real mean ${num(m.bScore.real.mean)} / median ${num(m.bScore.real.median)}；engine mean ${num(m.bScore.engine.mean)} / median ${num(m.bScore.engine.median)}；AUC(real higher) ${num(m.bScore.aucRealHigher, 3)}`);
  console.log(`  置信度：高置信(>=4) n=${m.confidenceBuckets.high.n} acc ${pct(m.confidenceBuckets.high.accuracy)}；低置信(<=2) n=${m.confidenceBuckets.low.n} acc ${pct(m.confidenceBuckets.low.accuracy)}`);
  const c = summary.controls;
  console.log(`负控：n=${c.n} balanced acc ${pct(c.balancedAccuracy)} | real-real ${c.byType['real-real'].correct}/${c.byType['real-real'].n} | engine-engine ${c.byType['engine-engine'].correct}/${c.byType['engine-engine'].n} | mixed ${c.byType['real-engine'].correct}/${c.byType['real-engine'].n} | mixed 方向 ${pct(c.mixedMoreRealAccuracy)}`);
  console.log(`暴露线索：${summary.cues.length ? summary.cues.map((x) => `${x.cue}×${x.count}`).join('；') : '（无）'}`);
}

if (judges.length > 1) {
  const accs = judges.map((x) => x.summary.main.accuracy).filter((x) => x != null);
  const bal = judges.map((x) => x.summary.controls.balancedAccuracy).filter((x) => x != null);
  console.log(`\n=== 跨裁判 ===`);
  console.log(`主项准确率 mean ${pct(C.mean(accs))}（n=${accs.length}；个体 ${accs.map(pct).join(' / ')}）`);
  console.log(`负控 balanced acc mean ${pct(C.mean(bal))}（${bal.map(pct).join(' / ')}）`);
}

if (args.out) {
  const out = {
    key: args.key,
    judges: judges.map((x) => ({ path: x.path, ...x.summary })),
    aggregate: {
      nJudges: judges.length,
      meanMainAccuracy: C.mean(judges.map((x) => x.summary.main.accuracy).filter((x) => x != null)),
      meanControlBalancedAccuracy: C.mean(judges.map((x) => x.summary.controls.balancedAccuracy).filter((x) => x != null)),
    },
  };
  writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(`\n→ ${args.out}`);
}
