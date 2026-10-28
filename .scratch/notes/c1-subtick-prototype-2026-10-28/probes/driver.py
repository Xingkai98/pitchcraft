import re, subprocess, sys, os
ROOT = '/home/shared/deep-research-playground/projects/football-manager-clone/.claude/worktrees/in-box-shot-priority-2026-10-28'
LIB = f'{ROOT}/engine/src/lib.rs'
CFG = f'{ROOT}/viewer/config.js'

TICK_RE = re.compile(r'/// C1 原型：[^\n]*\n(pub const TICK_SECONDS: f64 = )[^;]+;\n(/// 每 1 秒的拍数[^\n]*\nconst TPF: u32 = )\d+;')
DRIB_RE = re.compile(r'(    \} else \{\n)(?:        // [^\n]*\n)?(        let dir = if home \{ 1\.0 \} else \{ -1\.0 \};\n)(?:.*?)(        \(clamp01\(x\), y\)\n    \};)', re.S)

VARIANTS = {
 'S':  dict(tick='0.5', tpf=2, body='''        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.03 * TICK_SECONDS;
        let y = clamp01(p.1 + ((rng.next_u64() % 21) as f64 / 1000.0 - 0.01) * wob);
'''),
 'D2': dict(tick='0.5', tpf=2, body='''        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.03;
        let y = clamp01(p.1 + ((rng.next_u64() % 21) as f64 / 1000.0 - 0.01) * wob);
'''),
 'D2l': dict(tick='0.5', tpf=2, body='''        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.015;
        let lat = (rng.next_u64() % 25) as f64 / 1000.0 - 0.012;
        let y = clamp01(p.1 + lat);
'''),
 'D3': dict(tick='0.3333333333333333', tpf=3, body='''        let dir = if home { 1.0 } else { -1.0 };
        let x = p.0 + dir * 0.03;
        let y = clamp01(p.1 + ((rng.next_u64() % 21) as f64 / 1000.0 - 0.01) * wob);
'''),
}

def patch(v):
    s = open(LIB).read()
    s, n1 = TICK_RE.subn(lambda m: f'/// C1 原型：TICK={v["tick"]}（{round(1/float(v["tick"]))} Hz 决策节拍）。`TPF` 与 `TICK_SECONDS` 必须手工同步。\n{m.group(1)}{v["tick"]};\n{m.group(2)}{v["tpf"]};', s, count=1)
    s, n2 = DRIB_RE.subn(lambda m: m.group(1) + '        // C1 原型带球变体\n' + m.group(2) + v['body'] + m.group(3), s, count=1)
    assert n1 == 1 and n2 == 1, (n1, n2)
    open(LIB, 'w').write(s)
    c = open(CFG).read()
    c, n3 = re.subn(r'tickSeconds: [0-9.]+,', f'tickSeconds: {v["tick"]},', c, count=1)
    assert n3 == 1
    open(CFG, 'w').write(c)

def run(cmd, log):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)
    out = r.stdout + r.stderr
    open(log, 'a').write(out + '\n')
    return out

LOG = '/tmp/c1proto/tiers.log'
open(LOG, 'w').write('')
for name in ['S', 'D2', 'D2l', 'D3']:
    patch(VARIANTS[name])
    open(LOG, 'a').write(f'\n######## {name} ########\n')
    r = subprocess.run('cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -E "^error|Finished" | tail -1 && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm && sha256sum ../viewer/engine.wasm',
                       shell=True, cwd=f'{ROOT}/engine', capture_output=True, text=True,
                       env={**os.environ, 'PATH': os.environ['HOME'] + '/.cargo/bin:' + os.environ['PATH']})
    open(LOG, 'a').write(r.stdout + r.stderr)
    if 'error' in r.stdout or 'error' in r.stderr:
        print('BUILD FAILED', name, r.stdout, r.stderr); sys.exit(1)
    run('node .scratch/notes/goal-loop-r4/fast-ballprobe.mjs 42,7,23,11 2>&1 | tail -4', LOG)
    run('node tools/visual-review/ball-travel.mjs viewer/engine.wasm 5 12 2>&1 | tail -8', LOG)
    run('node /tmp/c1proto/packet-windows.mjs 2>&1 | tail -2', LOG)
    run('node /tmp/c1proto/shortpass.mjs 2>&1 | head -2', LOG)
    print('done', name, flush=True)
print('ALL DONE')
