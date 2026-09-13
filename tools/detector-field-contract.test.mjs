// P21 D5/D6 契约断言 + 实现漂移守卫。
//
// 这份测试是「detector 读的字段」与「真实数据真有的字段」之间的看门人：
//   1) 契约清单里每个 reads 字段，在真实 audit_input（tools/fixtures/real-audit-input.json）
//      上必须有生产者、或登记为 known-gap —— 且真的能在真实数据里找到。
//   2) 实现漂移守卫：用记录型 Proxy 跑一遍 runAudit，把 detector 真正读到的键抓出来，
//      必须落在契约清单的 reads ∪ legacy_reads 内。detector 代码改了字段而清单没跟上 → 红。
//   3) legacy_reads（D2 布尔兼容位）在真实数据里必须从不出现 —— 它们是旧合成 fixture 的遗物。
//
// 真实 fixture 由 tools/fixtures/generate-real-audit-fixture.mjs 从真实引擎采集链路生成。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runAudit,
  detectInvariants,
  detectUnforcedOut,
  detectInactiveResponsibility,
  detectIgnoredInterception,
  detectPlayerOverlap,
  computePassOutcomes,
  DEFAULT_AUDIT_PROFILE,
} from './detectors.mjs';
import {
  DETECTOR_FIELD_CONTRACT,
  KNOWN_GAPS,
  AUDIT_INPUT_SCHEMA_VERSION,
  AUDIT_INPUT_TOP_LEVEL_KEYS,
  allowedReadKeys,
  allAllowedReadKeys,
  fieldsWithoutProducer,
} from './detector-field-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'real-audit-input.json'), 'utf8'));

const windowNamed = (label) => {
  const w = FIXTURE.windows.find((x) => x.label === label);
  assert.ok(w, `fixture should contain a window labelled ${label}`);
  return w;
};

const allRealEvents = () => FIXTURE.windows.flatMap((w) => w.audit_input.events);
const allRealSnapshots = () =>
  FIXTURE.windows.flatMap((w) => Object.values(w.audit_input.players).flat());

// --- 0. 源码级断言（F1/F2）：不依赖执行覆盖 --------------------------------
//
// 行为驱动的守卫只能看见「喂进去的输入走到」的路径——触发条件落在 fixture 窗口之外的
// 新 detector，或某个未被输入覆盖的分支里的未声明读取，都能全绿逃逸（审阅实测 M23/M24）。
// 契约是声明式的，守卫就该有声明式的一面。这两条源码扫描不看执行，只看代码文本。
// 分工：源码级 = 「有没有未声明的字段/ detector」（与触发条件无关）；
//      行为级 = 「读键归属到哪个条目」（跨条目串读，见下方逐条目守卫）。

const DETECTORS_SOURCE = readFileSync(join(HERE, 'detectors.mjs'), 'utf8');

// 去掉 // 注释（整行 + 行尾），避免注释里提到的字段名被当成读取。
const stripComments = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

// 输入形状的基变量名**从代码里推导**，不用硬编码清单——硬编码时把循环变量改个名
// （`for (const event of events)` → `for (const ev of events)`）就能让整个源码扫描闭眼
// （审阅实测）。推导规则：绑定自「**输入形状的容器**」的循环变量与回调形参都是基变量。
// 容器清单只放真正的 audit_input 负载，**不放**内部数组（findings/list/unknown 等）——
// 放了会把内部对象（finding/audit stat）误当输入，产生假阳性。
const INPUT_CONTAINERS = ['events', 'players', 'sorted', 'snaps', 'run'];
// 兜底：即便推导漏了某种绑定形态，这几个最常见名字仍然扫。
const INPUT_BASE_VARS_FALLBACK = ['event', 'e', 's', 'start', 'end'];
// 数组/对象自带属性与方法：不是 audit_input 字段（扫描器把容器绑定的变量也当基变量后，
// 会顺带看到 `.length` / `.forEach` 之类的读，必须排除）。
const NON_FIELD_SOURCE_READS = new Set([
  'length', 'forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex',
  'indexOf', 'lastIndexOf', 'includes', 'push', 'pop', 'shift', 'unshift',
  'slice', 'splice', 'join', 'concat', 'flat', 'flatMap', 'reduce', 'sort',
  'reverse', 'entries', 'values', 'keys', 'hasOwnProperty', 'constructor',
  'toString', 'valueOf', 'at', 'fill', 'copyWithin', 'then',
]);

function deriveInputBaseVars(code) {
  const vars = new Set(INPUT_BASE_VARS_FALLBACK);
  const containers = INPUT_CONTAINERS.join('|');
  // for (const X of <container>)  /  for (const X of <container> ?? [])  /  Object.entries(<container>)
  // 字符类必须同时排除 `]` 和**换行**：只排除 `]` 时 `[^\]]*` 会跨行贪婪匹配，把下一个
  // `for` 整个吞进分组（实测产生 2292 字符的 runaway），使被吞的那个函数（computePassOutcomes）
  // 的循环绑定永远推导不出来、只能靠 fallback 硬编码名兜住——改名即失明（审阅实测）。
  // 容器名后要跟**词边界或 `(`**：`(?:sorted)` 会误匹配 `sortedReasons`（`sorted` 是其
  // 前缀），把 `reason` 当成输入绑定（审阅发现的假阳性根因）。
  const loopRes = [
    new RegExp(
      `for\\s*\\(\\s*const\\s+(\\[?[^\\]\\n]*\\]?)\\s+of\\s+(?:Object\\.entries\\()?(?:${containers})\\b`,
      'g'
    ),
  ];
  for (const re of loopRes) {
    for (const m of code.matchAll(re)) {
      const binding = m[1].trim();
      if (binding.startsWith('[')) {
        // 解构绑定 [rawId, snaps]：取各名字（rawId 是键、snaps 是值，两个都算可能的基变量）
        for (const part of binding.replace(/[[\]]/g, '').split(',')) {
          const name = part.trim().match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
          if (name) vars.add(name[0]);
        }
      } else {
        const name = binding.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
        if (name) vars.add(name[0]);
      }
    }
  }
  // 回调形参：<container>.some((X) => / .filter((X) => / .map((X) => / .forEach((X) =>
  for (const m of code.matchAll(
    new RegExp(`(?:${containers})\\.(?:some|filter|map|forEach|find|every)\\s*\\(\\s*\\(?\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)`, 'g')
  )) {
    vars.add(m[1]);
  }

  // **调用点传播**：把逐事件逻辑抽成 helper 是常规重构，helper 的形参名爱叫什么叫什么
  // （`function isLost(pass)` / `const f = (candidate) => …`）。只认循环变量与回调形参时，
  // 改名后的 helper 形参读会被完全漏掉（审阅实测：形参叫 `ev`/`pass`/`item` 都逃逸）。
  // 做法：建函数形参表 → 扫调用点 → 若实参是已推导的基变量或输入容器，把对应形参名并入
  // 基变量集 → 迭代到不动点（函数可互相转发）。
  const signatures = [];
  // function name(a, b) {   /   const name = (a, b) =>   /   const name = function (a, b)
  for (const m of code.matchAll(
    /(?:function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:function\s*)?\(([^)]*)\)\s*=>)/g
  )) {
    const name = m[1] ?? m[3];
    const rawParams = m[2] ?? m[4] ?? '';
    const params = rawParams
      .split(',')
      .map((p) => p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim())
      .map((p) => p.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)$/))
      .map((p) => (p ? p[1] : null));
    if (name) signatures.push({ name, params });
  }
  const callArgs = (callee) => {
    const re = new RegExp(`\\b${callee}\\s*\\(([^)]*)\\)`, 'g');
    const out = [];
    for (const m of code.matchAll(re)) {
      out.push(
        m[1]
          .split(',')
          .map((a) => a.trim())
      );
    }
    return out;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, params } of signatures) {
      for (const args of callArgs(name)) {
        params.forEach((param, i) => {
          if (!param || vars.has(param)) return;
          const arg = (args[i] ?? '').trim();
          // 实参是已推导基变量，或直接是输入容器本身 → 该形参也是输入基变量。
          if (vars.has(arg) || INPUT_CONTAINERS.includes(arg)) {
            vars.add(param);
            changed = true;
          }
        });
      }
    }
  }
  return [...vars];
}

// **非输入读取的显式白名单**（baseVar → 允许的属性集）：当一个短名既是输入形参、又在别处
// 指向内部对象时，用这条精确声明「这个对象上的这个属性不是 audit_input 字段」。每条都必须
// 有注释说明为什么——白名单会削弱守卫，不得随意添加。
const NON_INPUT_PROPERTIES = {
  // aggregateAudit 里 `(audit?.stats ?? []).find((s) => s.detector_id === id)`：这里的 `s`
  // 是聚合 **stat 形**（内部结构），不是 audit_input 的球员快照。detector_id 也因此不在
  // 契约的 reads 里。审阅实测：不排除它会误报为「未声明字段」。
  s: new Set(['detector_id']),
};

// 允许出现在白名单里、但**不在**契约中的「内部键」。这些是 detector 自己产出的 finding /
// stat 结构上的键，不可能成为 audit_input 的输入字段。白名单只能登记这类键——它无法把
// 「本应是输入字段却忘了登记」的名字（如 `zz_hidden`）洗白，因为那类名字不在此集合里。
const NON_INPUT_INTERNAL_KEYS = new Set(['detector_id', 'severity', 'reason', 'features', 'thresholds']);

// 三种读取形态都要扫——只扫点读会漏掉解构与字符串下标（审阅实测：解构/方括号 + 分支不被
// 任何 guard 输入触发 = 全绿逃逸）。而 `const { corridor_distance } = event` 正是
// detectors.mjs 现在就在用的写法，不是假想。
//   ① 点读      base.prop
//   ② 解构      const { a, b } = base   /   ({ a } = base)
//   ③ 字符串下标 base['prop'] / base["prop"]
function sourceFieldReads(src = DETECTORS_SOURCE) {
  const code = stripComments(src);
  const reads = new Set();
  const bases = deriveInputBaseVars(code);
  for (const base of bases) {
    const allowed = NON_INPUT_PROPERTIES[base] ?? new Set();
    const add = (name) => {
      if (!allowed.has(name) && !NON_FIELD_SOURCE_READS.has(name)) reads.add(name);
    };
    const b = base.replace(/\$/g, '\\$');
    // ① 点读（含可选链 `?.`）
    for (const m of code.matchAll(new RegExp(`\\b${b}\\s*\\??\\.\\s*([a-zA-Z_][a-zA-Z0-9_]*)`, 'g'))) {
      add(m[1]);
    }
    // ② 解构：`const { ... } = base` / `let { ... } = base` / `({ ... } = base)`
    // 模式内用 `[^{}]*`（不许再嵌 `{`）：否则遇到 `if (x) { const { a } = event }` 会从外层
    // 大括号起匹配，把 `const` 当成字段名（抓到了变异却报错名字，也可能漏掉真字段）。
    for (const m of code.matchAll(
      new RegExp(`(?:const|let|var)?\\s*\\{([^{}]*)\\}\\s*=\\s*${b}\\b`, 'g')
    )) {
      for (const part of m[1].split(',')) {
        // `a` / `a: alias` / `a = default` → 取最前面的标识符
        const name = part.trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (name) add(name[1]);
      }
    }
    // ③ 字符串下标（含动态下标的变量名——变量名本身不是字段，但下标里的**字面量**是）
    for (const m of code.matchAll(new RegExp(`\\b${b}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g'))) {
      add(m[1]);
    }
  }
  return reads;
}

// 源码里所有「构造 detector id」的位置：字面量赋值 + statsFor 首参。非字面量赋值里只有
// 下列**转发点**是允许的——它们是参数/局部量，值来自别处已登记的 id，不引入新 id：
const DETECTOR_ID_FORWARDING = new Set([
  'detectorId', // statsFor(detectorId, ...) 的形参：值来自 statsFor('literal', ...) 调用点
  'id', // aggregateAudit 里 detector_id: id —— id 来自 stats 或 known 集合
  'f.detector_id', // runAudit 里把 finding 的 id 透传给 profile 查询
]);

const DETECTOR_ID_ASSIGN_RE = /detector_id:\s*([^,\n}]+)/g;
const DETECTOR_ID_LITERAL_RE = /detector_id:\s*'([^']+)'/g;
const STATSFOR_RE = /statsFor\(\s*'([^']+)'/g;

test('source-level: detector ids are discoverable — no non-literal detector_id passes silently (F2a)', () => {
  // 行为守卫看不见「触发条件在 fixture 窗口之外」的 detector；只扫字面量又会漏掉
  // 非字面量 id（审阅实测 `const GHOST='x'; detector_id: GHOST` 全绿逃逸）。这里要求
  // 每个 detector_id 赋值要么是字面量、要么是**已登记的转发点**，否则判红——逼实现者
  // 把它写成字面量（可被契约检查）。
  const code = stripComments(DETECTORS_SOURCE);
  const unhandled = [];
  for (const m of code.matchAll(DETECTOR_ID_ASSIGN_RE)) {
    const rhs = m[1].trim();
    if (/^'[^']+'$/.test(rhs)) continue;
    if (DETECTOR_ID_FORWARDING.has(rhs)) continue;
    unhandled.push(rhs);
  }
  assert.deepEqual(
    unhandled,
    [],
    `detector_id assigned from an unregistered expression — the guard cannot check its ` +
      `contract entry: ${unhandled.join(' | ')}. Write the id as a literal, or register the ` +
      `forwarding point in DETECTOR_ID_FORWARDING with a comment explaining its source.`
  );

  const literals = new Set();
  for (const m of code.matchAll(DETECTOR_ID_LITERAL_RE)) literals.add(m[1]);
  for (const m of code.matchAll(STATSFOR_RE)) literals.add(m[1]);
  assert.ok(literals.size > 0, 'source scan found no detector_id literals — scan is broken');
  const undeclared = [...literals].filter((id) => !(id in DETECTOR_FIELD_CONTRACT));
  assert.deepEqual(
    undeclared,
    [],
    `detectors.mjs declares detector ids with no contract entry: ${undeclared.join(', ')}`
  );
});

test('source-level: the discoverability guard catches a variable detector id (self-check)', () => {
  // 真注入自检：把 id 换成**未登记**的变量，discoverability 守卫必须报出来。
  const planted = `const f = { detector_id: GHOST_ID };`;
  const unhandled = [];
  for (const m of stripComments(planted).matchAll(DETECTOR_ID_ASSIGN_RE)) {
    const rhs = m[1].trim();
    if (/^'[^']+'$/.test(rhs) || DETECTOR_ID_FORWARDING.has(rhs)) continue;
    unhandled.push(rhs);
  }
  assert.deepEqual(unhandled, ['GHOST_ID'], 'guard must flag an unregistered detector_id expression');
  // 已登记的转发点不该被误报。
  assert.equal(DETECTOR_ID_FORWARDING.has('detectorId'), true);
});

// **已知残留缺口（诚实登记，非静默）**——静态扫描对**语法形态**有盲区：
//
// ① detector id 侧：若一个 helper 把 id 作为**形参**接收（`detector_id: detectorId` 是已登记
//    转发点），而调用点又用非字面量传入（`make(ghostIdVar)`），这个 id 不以字面量出现在源码里，
//    上面的守卫看不见。彻底修法是引入 **detector 注册表**（runAudit 遍历注册表而非内联 4 次
//    调用），使「有哪些 detector」成为运行时可枚举的事实——小幅重构，超出本 change 范围，
//    留给新增 detector 的 issue（#34/#35）一并处理。
// ② 字段读侧：扫描器已覆盖 点读 / 可选链 / 解构 / 字符串下标 / 改名循环变量 / 回调形参 /
//    **helper 形参（调用点传播到不动点）**。仍扫不到的三类：
//    (a) 把事件拷进非输入命名的局部量再读（`const x = event; x.zz`）；
//    (b) 计算下标 `event[k]`（k 是变量，不是字面量）；
//    (c) **经 Map/查找得到的变量**（`const sa = a.byT.get(t); sa.zz`）——`sa` 既不是容器
//        循环绑定、也不在调用点传播的实参链上，扫描器不把它当基变量，看不见它上面的读取。
//        **比 (a) 更容易撞上**：把快照按 t 索引再比较（player_overlap 的 D6 对齐）就是这种
//        自然写法。且它与行为 Proxy 叠加成完整盲区——Proxy 只看得见**执行到**的读，不可达
//        分支里的 `.zz` 两边都不报。**缓解是结构性的**：让「读原始快照字段」只发生在
//        容器循环里（见 detectors.mjs 的 `snapshotPoint`：Map 里存的是它造的数值点副本，
//        不是原始快照），配对阶段读到的就是自己的副本键，不再是 audit_input 字段。
//        若日后新增 detector 又在 Map 上直接读原始快照，这条盲区会复活。
//        **副本形状由 `snapshotPoint returns exactly {t,x,y}` 用例钉住**：谁给副本加字段，
//        那条会红，逼他在契约里登记新字段（否则走 (c) 的静默路径）。
//
//    判据：(a)/(b) 要先写一段「看起来无意义」的中转代码，属刻意规避；(c) 是自然写法，
//    所以本 change 用结构（副本 + 容器循环收口）而非扫描器增强来消解，扫描器本身未改。
//
// 判据：需要**刻意写死代码 / 无意义中转 / 变量下标**才能绕过的，登记为已知局限；
// **自然写法**能触发的（改循环变量名、解构、可选链、helper 形参读事件）都必须被守卫
// 抓住——这几类已全部覆盖（helper 形参经调用点传播，见 deriveInputBaseVars 末尾）。

test('source-level: every input field read in detectors.mjs is declared somewhere (F2)', () => {
  // 不看执行、只看文本：任何分支里的未声明读取都会被这条抓到，与是否被输入覆盖无关。
  // 字段归属到哪个条目由下面的行为级逐条目守卫负责（两者互补）。
  const declared = allAllowedReadKeys();
  const undeclared = [...sourceFieldReads()].filter((f) => !declared.has(f));
  assert.deepEqual(
    undeclared,
    [],
    `detectors.mjs reads input fields declared nowhere in the contract: ${undeclared.join(', ')}`
  );
});

test('source-level: the source scanner actually detects reads (self-check)', () => {
  // 防「扫描器永远空集」：确认真实源码确实扫出了已知字段。
  const reads = sourceFieldReads();
  assert.ok(reads.has('detail'), 'scanner must find event.detail');
  assert.ok(reads.has('nearest_defender_distance'), 'scanner must find the pressure-field read');
  assert.ok(reads.has('responsibility'), 'scanner must find the snapshot responsibility read');
});

test('source-level: injection self-check — the scanner detects a planted read (F2 proof)', () => {
  // 这才是真正的自检：往一份**合成源码**里种一个未声明读取，确认扫描器抓得到。
  // （上一版自检是从「允许集」里删字段再看判决非空——那只验证了集合差运算，没验证
  //  扫描器真的能看见代码里的读取，是一条假绿自检，由审阅发现。）
  const planted = `
    export function detectUnforcedOut(events, profile) {
      for (const event of events) {
        if (event.planted_dot === 7) continue;
      }
    }`;
  const reads = sourceFieldReads(planted);
  assert.ok(
    reads.has('planted_dot'),
    'scanner must surface a field read that exists in the source text'
  );
  // 反向：真实源码里不存在的字段不该出现（防扫描器把任意词都当字段）。
  assert.equal(sourceFieldReads(DETECTORS_SOURCE).has('planted_dot'), false);

  // 端到端：把种植读取接进「未声明即红」的判决，确认非空。
  const declared = allAllowedReadKeys();
  const undeclared = [...reads].filter((f) => !declared.has(f));
  assert.deepEqual(undeclared, ['planted_dot']);
});

test('source-level: the scanner covers destructuring and bracket reads (F1 proof)', () => {
  // 三种读取形态各注入一例，确认都被扫出。只钉点读会让解构/方括号 + 未被输入触发的分支
  // 全绿逃逸（审阅实测），而解构正是 detectors.mjs 现在就在用的写法。
  const cases = [
    [`const { destructured_field } = event;`, 'destructured_field'],
    // `{ key: alias }` 读取的是源对象的 **key**（别名只是本地名字），所以扫出 key。
    [`const { source_key: local_alias } = event;`, 'source_key'],
    [`let { plain_field, other_field } = event;`, 'plain_field'],
    [`({ reassigned_field } = event);`, 'reassigned_field'],
    [`void event['bracket_field'];`, 'bracket_field'],
    [`void event["double_quoted_field"];`, 'double_quoted_field'],
    [`void s.snapshot_dot_field;`, 'snapshot_dot_field'],
  ];
  for (const [src, expected] of cases) {
    assert.ok(
      sourceFieldReads(src).has(expected),
      `scanner must surface "${expected}" from: ${src}`
    );
  }
  // 可选链与动态推导的基变量（改名后的循环变量）也要扫出——硬编码名字时改个循环变量名
  // 就能让扫描闭眼（审阅实测的真实绕过路径）。
  assert.ok(
    sourceFieldReads(`for (const ev of events) { void ev?.opt_field; }`).has('opt_field'),
    'scanner must see an optional-chained read on a derived base'
  );
  assert.ok(
    sourceFieldReads(`for (const ev of events) { void ev.renamed_base_field; }`).has('renamed_base_field'),
    'scanner must derive the loop binding name (not a hardcoded list)'
  );
  assert.ok(
    sourceFieldReads(`for (const [id, sn] of Object.entries(players)) { void sn.snap_field; }`).has('snap_field'),
    'scanner must derive destructured loop bindings from players'
  );
  // helper 形参：把逐事件逻辑抽成 helper 是常规重构，形参名不可预测。调用点传播必须把
  // 「实参是输入基变量」的形参也纳入——否则形参叫 ev/candidate 就能让扫描闭眼（审阅实测）。
  assert.ok(
    sourceFieldReads(
      `function check(ev) { return ev.helper_field; }\nfor (const event of events) { check(event); }`
    ).has('helper_field'),
    'scanner must propagate through helper call sites (param named ev)'
  );
  assert.ok(
    sourceFieldReads(
      `const f = (candidate) => candidate.arrow_field;\nfor (const event of events) { f(event); }`
    ).has('arrow_field'),
    'scanner must propagate through arrow-helper call sites'
  );
  assert.ok(
    sourceFieldReads(
      `const g = (p) => p.chained_field;\nconst h = (e2) => g(e2);\nfor (const event of events) { h(event); }`
    ).has('chained_field'),
    'scanner must propagate transitively (h → g) to a fixpoint'
  );
  // 真实源码里解构读取（corridor_distance/pass_distance/pass_speed）必须被抓到——
  // 这些是 declared 字段，所以行为守卫也覆盖；这里确认扫描器同样看得见。
  const real = sourceFieldReads(DETECTORS_SOURCE);
  for (const f of ['corridor_distance', 'pass_distance', 'pass_speed']) {
    assert.ok(real.has(f), `scanner must see the real destructured read "${f}"`);
  }
});

test('source-level: the top-level allowlist is pinned to the exact known keys (F2 top-level)', () => {
  // AUDIT_INPUT_TOP_LEVEL_KEYS 与 NON_INPUT_PROPERTIES 是同一类白名单：它并进允许集、且
  // 逐条目守卫会跳过它。若没有约束，「加一个顶层键 + 读它」就能掩蔽未声明读取（审阅实测）。
  // 钉成精确集合：新增顶层键必须是有意为之（同时改这里），不能顺手洗白。
  assert.deepEqual(
    [...AUDIT_INPUT_TOP_LEVEL_KEYS].sort(),
    ['events', 'players', 'schema_version'],
    'AUDIT_INPUT_TOP_LEVEL_KEYS changed — add a comment explaining the new top-level field ' +
      'and update this pin so it cannot be used to mask an undeclared read'
  );
});

test('source-level: the non-input allowlist cannot mask an undeclared field (F2b)', () => {
  // 白名单会同时关掉「未声明读取」和「跨条目串读」两条守卫——若允许它登记任意字段，
  // 就能把真实缺陷藏起来（审阅实测：白名单塞 `zz_hidden` + 不可达读取 = 全绿逃逸）。
  // 约束：白名单里的每个属性名都必须是**契约已声明**的字段。这样它只能用来澄清
  // 「这个已声明字段在这里不是输入字段」，无法把未声明字段洗白。
  const declared = allAllowedReadKeys();
  const scannedBases = new Set(deriveInputBaseVars(stripComments(DETECTORS_SOURCE)));
  for (const [base, props] of Object.entries(NON_INPUT_PROPERTIES)) {
    assert.ok(scannedBases.has(base), `non-input allowlist key ${base} is not a scanned base var`);
    assert.ok(props instanceof Set, `non-input allowlist for ${base} must be a Set`);
    for (const prop of props) {
      // 白名单只允许两种东西：契约已声明的字段（澄清它在此处非输入），或 detector 自产的
      // 内部键（detector_id/severity/...，本就不可能成为输入）。任何别的名字都判红——
      // 这样白名单无法掩盖一个「忘了登记的输入字段」。
      assert.ok(
        declared.has(prop) || NON_INPUT_INTERNAL_KEYS.has(prop),
        `non-input allowlist masks "${prop}", which is neither a declared field nor a known ` +
          `internal finding/stat key — it may only reclassify one of those`
      );
    }
  }
  // 自检：一个既不在契约、也不在内部键集合的名字，必须被上面这条规则拒绝。
  assert.equal(NON_INPUT_INTERNAL_KEYS.has('zz_hidden'), false);
  assert.equal(declared.has('zz_hidden'), false);
});

// --- 1. 契约清单自身的完整性 ------------------------------------------------

test('the contract covers every detector runAudit actually emits (no unregistered detector)', () => {
  // 反向覆盖（防再犯的核心）：runAudit 实际产出的每个 detector_id 都必须在契约里登记。
  // 否则新加一个 detector（issue #34/#35 之类）时，它会静默不受契约保护、不参与漂移守卫、
  // 聚合摘要也不会带 calibration——正是 D5 要防的「代码与清单不一致」。
  //
  // 必须喂**真实窗口**而不只是空输入：空输入下 detector 靠 statsFor(...) 恒产 stats 行才
  // 被看见；一个只在有事件时才产 finding、又忘了配 statsFor 的新 detector 会完全逃逸
  // （审阅实测的 M8 变异）。跑真实窗口才能覆盖「只在真实数据上产 finding」的路径。
  const inputs = [
    { schema_version: AUDIT_INPUT_SCHEMA_VERSION, events: [], players: {} },
    ...FIXTURE.windows.map((w) => w.audit_input),
  ];
  const emitted = new Set();
  for (const input of inputs) {
    const { stats, findings } = runAudit(input);
    for (const s of stats) emitted.add(s.detector_id);
    for (const f of findings) if (f.detector_id) emitted.add(f.detector_id);
  }
  assert.ok(emitted.size > 0, 'runAudit must emit at least one detector');
  const undeclared = [...emitted].filter((id) => !(id in DETECTOR_FIELD_CONTRACT));
  assert.deepEqual(
    undeclared,
    [],
    `runAudit emits detectors missing from the contract: ${undeclared.join(', ')}`
  );
});

test('contract covers every detector and every entry is internally consistent', () => {
  const ids = Object.keys(DETECTOR_FIELD_CONTRACT);
  for (const expected of [
    'baseline_invariant',
    'unforced_out',
    'inactive_responsibility',
    'ignored_interception_opportunity',
    'player_overlap',
    'pass_outcomes',
  ]) {
    assert.ok(ids.includes(expected), `contract must cover ${expected}`);
  }
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    assert.ok(Array.isArray(entry.reads) && entry.reads.length > 0, `${id}.reads`);
    assert.ok(Array.isArray(entry.legacy_reads), `${id}.legacy_reads`);
    assert.ok(entry.producers && typeof entry.producers === 'object', `${id}.producers`);
    assert.ok(Array.isArray(entry.known_gaps), `${id}.known_gaps`);
    // reads 与 legacy_reads 不重叠：一个字段要么「必须有人产」要么「允许没人产」。
    for (const f of entry.legacy_reads) {
      assert.ok(!entry.reads.includes(f), `${id}: ${f} cannot be both reads and legacy_reads`);
    }
    // producers 里的生产方必须是已知取值，且**每个 producer 键都必须是被读取的字段**
    // （reads ∪ legacy_reads）——否则是没人读的僵尸生产登记（审阅实测：加
    // `producers.zz_ghost = 'derive'` 两套全绿；它不影响行为，但契约清单自洽性该兜住）。
    const readable = allowedReadKeys(entry);
    for (const [field, producer] of Object.entries(entry.producers)) {
      assert.ok(
        ['engine', 'derive', 'viewer'].includes(producer),
        `${id}.producers.${field} has unknown producer ${producer}`
      );
      assert.ok(
        readable.has(field),
        `${id}.producers registers "${field}" but the entry never reads it — ` +
          `a producer for an unread field is dead contract weight`
      );
    }
    // known_gaps 条目必须在 KNOWN_GAPS 里登记，且该条确实指向本 detector。
    for (const gapId of entry.known_gaps) {
      const gap = KNOWN_GAPS[gapId];
      assert.ok(gap, `${id} references unregistered known gap ${gapId}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(gap.detector_fields, id),
        `known gap ${gapId} must declare which field it excuses for ${id}`
      );
    }
  }
});

test('every field without a producer is excused by an unproducible known gap', () => {
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    const missing = fieldsWithoutProducer(entry);
    for (const field of missing) {
      const excused = entry.known_gaps.some((gapId) => {
        const gap = KNOWN_GAPS[gapId];
        return gap.kind === 'unproducible' && gap.detector_fields[id] === field;
      });
      assert.ok(
        excused,
        `${id} reads "${field}" but declares no producer and no 'unproducible' known gap for it`
      );
    }
  }
});

test('known gaps are internally consistent with reads/producers', () => {
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const gapId of entry.known_gaps) {
      const gap = KNOWN_GAPS[gapId];
      const field = gap.detector_fields[id];
      if (gap.kind === 'unproducible') {
        // 无生产者 = 必须在 reads 里、且没有 producers 登记。
        assert.ok(entry.reads.includes(field), `${id}: unproducible gap ${gapId} field must be in reads`);
        assert.ok(!entry.producers[field], `${id}: unproducible gap ${gapId} field must have no producer`);
      } else if (gap.kind === 'semantic') {
        // 有生产者，只是表达力不足。
        assert.ok(entry.producers[field], `${id}: semantic gap ${gapId} field must have a producer`);
      } else if (gap.kind === 'removed') {
        // 死代码已删：该字段不应再出现在 reads/legacy_reads 里。
        assert.ok(
          !entry.reads.includes(field) && !entry.legacy_reads.includes(field),
          `${id}: removed gap ${gapId} means the field must no longer be read`
        );
      } else {
        assert.fail(`${id}: known gap ${gapId} has unknown kind ${gap.kind}`);
      }
    }
  }
  // 反向覆盖：没有漏登记的 unproducible 字段（靠上一个测试兜住），也没有孤儿 gap id。
  for (const gapId of Object.keys(KNOWN_GAPS)) {
    const referenced = Object.values(DETECTOR_FIELD_CONTRACT).some((e) =>
      e.known_gaps.includes(gapId)
    );
    assert.ok(referenced, `known gap ${gapId} is registered but no detector references it`);
  }
  // 引用完整性（N2/N4）：gap ↔ entry 必须**双向**一致。
  //   正向：KNOWN_GAPS[g].detector_fields 里登记的每个条目，都必须在自己的 known_gaps 里
  //         引用回 g——否则是「登记了却没人 attach」的僵尸引用；反之，某条目悄悄删掉一条
  //         引用也会被发现（该 gap 若仍被别处引用，孤儿检查抓不到）。
  for (const [gapId, gap] of Object.entries(KNOWN_GAPS)) {
    for (const [entryId, field] of Object.entries(gap.detector_fields)) {
      const entry = DETECTOR_FIELD_CONTRACT[entryId];
      assert.ok(entry, `known gap ${gapId} names unknown contract entry ${entryId}`);
      assert.ok(
        entry.known_gaps.includes(gapId),
        `known gap ${gapId} lists ${entryId}.${field} but ${entryId}.known_gaps does not reference it back`
      );
    }
  }
});

// --- 2. 真实数据上的生产者断言 ----------------------------------------------

test('every contract read is actually produced by the real audit_input', () => {
  const eventKeys = new Set(allRealEvents().flatMap((e) => Object.keys(e)));
  const snapshotKeys = new Set(allRealSnapshots().flatMap((s) => Object.keys(s)));
  const topKeys = new Set(AUDIT_INPUT_TOP_LEVEL_KEYS);

  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    for (const field of entry.reads) {
      const produced =
        eventKeys.has(field) || snapshotKeys.has(field) || topKeys.has(field);
      assert.ok(
        produced,
        `${id} declares read "${field}" but the real audit_input never produces it ` +
          `(event keys ∪ snapshot keys do not contain it)`
      );
      // 有生产者的字段必须有明确生产方登记。
      assert.ok(
        entry.producers[field],
        `${id} reads "${field}" (present in real data) but declares no producer`
      );
    }
  }
});

test('the real fixture actually carries the out/restart shapes this change fixes', () => {
  const events = allRealEvents();
  const byDetail = (d) => events.filter((e) => e.type === 'pass' && e.detail === d);
  // P27 后的真实出界形状：result 显式 "out" + out_side + out_pos（真实越界坐标，可越界）；
  // x2/y2 仍是场内投影点（钳到边界线）——协议不破。
  const sideForDetail = { out_sideline: 'sideline', out_goal_line: 'goal_line' };
  for (const detail of ['out_sideline', 'out_goal_line']) {
    const sample = byDetail(detail)[0];
    assert.ok(sample, `fixture must carry a real ${detail} pass`);
    assert.equal(sample.result, 'out', `${detail}: engine now emits explicit result="out"`);
    assert.equal(sample.out_side, sideForDetail[detail], `${detail}: out_side must match the detail`);
    assert.ok(Array.isArray(sample.out_pos) && sample.out_pos.length === 2, `${detail}: out_pos must be [x,y]`);
    const [opx, opy] = sample.out_pos;
    const crosses = opx < 0 || opx > 1 || opy < 0 || opy > 1;
    assert.ok(crosses, `${detail}: out_pos must be a real out-of-pitch coord, got [${opx},${opy}]`);
    const clamped = sample.x2 === 0 || sample.x2 === 105 || sample.y2 === 0 || sample.y2 === 68;
    assert.ok(clamped, `${detail}: landing projection must stay on a boundary, got x2=${sample.x2} y2=${sample.y2}`);
  }
  // 四类排除位 detail 都在（证明排除位契约有真实数据可依）。
  for (const detail of ['corner', 'throw_in', 'free_kick', 'clearance']) {
    assert.ok(byDetail(detail).length > 0, `fixture must carry a real ${detail} pass`);
  }
});

test('legacy boolean exclusion keys never appear in real engine data', () => {
  const eventKeys = new Set(allRealEvents().flatMap((e) => Object.keys(e)));
  for (const key of ['dead_ball', 'goal_kick', 'contested', 'clearance', 'corner', 'throw_in']) {
    // 这些布尔排除位是 D2 删掉的语义错乱/无生产者键；真实数据里若出现说明契约又漂了。
    const asEventField = eventKeys.has(key) && allRealEvents().some(
      (e) => e.type === 'pass' && typeof e[key] === 'boolean'
    );
    assert.equal(
      asEventField,
      false,
      `real pass events must not carry the legacy boolean key "${key}"`
    );
  }
});

// 合成边界输入（P4.2 保留的少数人造用例之一）：真实数据里已经没有布尔排除位，但 detector
// 仍声明兼容它们。喂一份带布尔位的输入，证明兼容分支确实被代码读到（不是僵尸声明）。
function syntheticLegacyInput() {
  return {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [
      { index: 0, t: 1, type: 'pass', result: 'out', nearest_defender_distance: 12, clearance: true },
      { index: 1, t: 2, type: 'pass', result: 'out', nearest_defender_distance: 12, corner: true },
      { index: 2, t: 3, type: 'pass', result: 'out', nearest_defender_distance: 12, throw_in: true },
    ],
    players: {},
  };
}

test('every declared legacy read is genuinely read by its detector', () => {
  // legacy_reads 允许无生产者，但不能是没人读的僵尸条目（否则清单在自说自话）。
  // 这里也逐 detector 归属：读到的键必须落在**那个 detector** 的 legacy_reads 里。
  const perDetector = {};
  for (const id of Object.keys(DETECTOR_ENTRY)) perDetector[id] = new Set();
  const inputs = [
    syntheticLegacyInput(),
    ...FIXTURE.windows.map((w) => w.audit_input),
    ...BRANCH_COVERAGE_INPUTS,
  ];
  for (const input of inputs) {
    for (const [id, run] of Object.entries(DETECTOR_ENTRY)) {
      for (const k of recordReads(input, run)) perDetector[id].add(k);
    }
  }
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    // 不静默跳过：没有 runner 的条目由「every contract entry has a drift-guard runner」兜住。
    const reads = perDetector[id];
    assert.ok(reads, `no drift-guard runner for ${id}`);
    for (const field of entry.legacy_reads) {
      assert.ok(
        reads.has(field),
        `${id} declares legacy read "${field}" but its implementation never reads it`
      );
    }
  }
});

// --- 3. 实现漂移守卫 --------------------------------------------------------

// 允许被「读到」的非字段属性：数组/对象方法、迭代器、JSON 钩子。这些不是字段契约。
const NON_FIELD_PROPS = new Set([
  'length', 'then', 'toJSON', 'constructor', 'toString', 'valueOf',
  'filter', 'map', 'some', 'every', 'find', 'findIndex', 'forEach', 'reduce',
  'slice', 'splice', 'concat', 'join', 'push', 'pop', 'shift', 'unshift',
  'sort', 'reverse', 'includes', 'indexOf', 'lastIndexOf', 'flat', 'flatMap',
  'entries', 'values', 'keys', 'hasOwnProperty', 'propertyIsEnumerable',
  'isPrototypeOf', 'at', 'fill', 'copyWithin', 'splice',
]);

// 用记录型 Proxy 包住 audit_input，跑一遍 runAudit，收集所有被 get 到的键。
// 只记录「普通对象上的非数字字符串键」——数组下标与数组/对象方法是结构访问，不是字段读取。
function recordReads(input, fn) {
  const reads = new Set();
  const cache = new WeakMap();
  const wrap = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (cache.has(value)) return cache.get(value);
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !NON_FIELD_PROPS.has(prop)) {
          const numeric = /^\d+$/.test(prop);
          if (!numeric) reads.add(prop);
        }
        return wrap(Reflect.get(target, prop, receiver));
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  fn(wrap(input));
  return reads;
}

const recordAuditReads = (input) => recordReads(input, (pi) => runAudit(pi));

// 逐条目直接调用，把读键**归属到具体条目**——按并集断言会漏掉
// 「条目 A 读了契约里只属于 B 的字段」这类串读（审阅发现的守卫盲区）。
// 注意：pass_outcomes 不是 detector，但它和 unforced_out 共享出界/排除位契约，
// 也必须有自己的 runner；否则它在守卫里会被静默跳过（审阅发现的第二个盲区）。
const DETECTOR_ENTRY = {
  baseline_invariant: (pi) =>
    detectInvariants(pi.events ?? [], pi.players ?? {}, DEFAULT_AUDIT_PROFILE),
  unforced_out: (pi) => detectUnforcedOut(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
  inactive_responsibility: (pi) =>
    detectInactiveResponsibility(pi.players ?? {}, DEFAULT_AUDIT_PROFILE),
  ignored_interception_opportunity: (pi) =>
    detectIgnoredInterception(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
  player_overlap: (pi) => detectPlayerOverlap(pi.players ?? {}, DEFAULT_AUDIT_PROFILE),
  pass_outcomes: (pi) => computePassOutcomes(pi.events ?? [], DEFAULT_AUDIT_PROFILE),
};

// 真实窗口是主输入，但真实数据不一定走遍每个分支（例如真实 pass 都带 detail，于是
// 「无 detail 的普通传球」这条读 result 的路径就不会被走到）。守卫要断言「契约声明的读
// 确实被实现读到」，就必须把这几个分支也喂进去——否则会把真实存在但未被 fixture 覆盖的
// 读误判成僵尸声明。这些合成输入是**为分支覆盖而造**，形状取自 protocol.js 的合法枚举。
const BRANCH_COVERAGE_INPUTS = [
  // 普通传球（无 detail）：走 classifyPassOutcome 的 result 分支。
  {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [
      { index: 0, t: 1, type: 'pass', result: 'success', x: 50, y: 30, x2: 60, y2: 30, nearest_defender_distance: 12, pass_distance: 10 },
      { index: 1, t: 2, type: 'pass', x: 50, y: 30, x2: 60, y2: 30, nearest_defender_distance: 12, pass_distance: 10 },
    ],
    players: {},
  },
  // 责任快照：走 inactive_responsibility 的 disqualified/moved 分支。
  {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: [],
    players: {
      4: [
        { t: 1, x: 5, y: 5, responsibility: 'ball_entered_zone' },
        { t: 4.5, x: 5.05, y: 5, responsibility: 'ball_entered_zone', dead_ball: true },
        { t: 6, x: 5.1, y: 5, responsibility: 'ball_entered_zone', is_gk: true },
        { t: 8, x: 9, y: 5, responsibility: 'ball_entered_zone', moved_toward_goal: true },
        { t: 10, x: 9, y: 9, responsibility: 'ball_entered_zone', moved_toward_ball: true },
      ],
    },
  },
];

test('every contract entry has a drift-guard runner (no silently-skipped entry)', () => {
  // 防「条目没有 runner → 逐条目断言里被静默 continue 跳过」这个盲区：
  // 契约里每个条目都必须能在 DETECTOR_ENTRY 里找到归属 runner。
  for (const id of Object.keys(DETECTOR_FIELD_CONTRACT)) {
    assert.ok(
      typeof DETECTOR_ENTRY[id] === 'function',
      `contract entry ${id} has no runner in the drift guard — its reads would go unchecked`
    );
  }
});

// 逐条目跑遍真实窗口 + 分支覆盖输入，返回 { 条目 id: Set(读到的键) }。
function recordReadsPerDetector() {
  const perDetector = {};
  for (const id of Object.keys(DETECTOR_ENTRY)) perDetector[id] = new Set();
  const inputs = [...FIXTURE.windows.map((w) => w.audit_input), ...BRANCH_COVERAGE_INPUTS];
  for (const input of inputs) {
    for (const [id, run] of Object.entries(DETECTOR_ENTRY)) {
      for (const k of recordReads(input, run)) perDetector[id].add(k);
    }
  }
  return perDetector;
}

// 全部窗口的并集读键（用于「清单里没有僵尸字段」的反向覆盖）。
function recordReadsAcrossFixture() {
  const reads = new Set();
  for (const w of FIXTURE.windows) {
    for (const k of recordAuditReads(w.audit_input)) reads.add(k);
  }
  return reads;
}

test('each detector only reads fields its own contract entry declares', () => {
  // 逐 detector 归属断言（不是并集）：A 读了只登记在 B 名下的字段 → 这条会红。
  const perDetector = recordReadsPerDetector();
  for (const [id, reads] of Object.entries(perDetector)) {
    const entry = DETECTOR_FIELD_CONTRACT[id];
    assert.ok(entry, `detector ${id} has no contract entry`);
    const allowed = allowedReadKeys(entry);
    const undeclared = [...reads].filter((k) => !allowed.has(k) && !AUDIT_INPUT_TOP_LEVEL_KEYS.includes(k));
    assert.deepEqual(
      undeclared,
      [],
      `${id} reads fields not declared in its own contract entry: ${undeclared.join(', ')}`
    );
  }
});

test('no contract read is declared by an entry that does not read it (cross-entry guard)', () => {
  // 反向：契约说条目 X 读字段 F，但 X 实际没读 F（F 只在别的条目下出现）→ 僵尸声明。
  const perDetector = recordReadsPerDetector();
  for (const [id, entry] of Object.entries(DETECTOR_FIELD_CONTRACT)) {
    // 不静默跳过（pass_outcomes 也有 runner）；缺 runner 由专门用例报错。
    const reads = perDetector[id];
    assert.ok(reads, `no drift-guard runner for ${id}`);
    for (const field of entry.reads) {
      if (AUDIT_INPUT_TOP_LEVEL_KEYS.includes(field)) continue;
      assert.ok(
        reads.has(field),
        `${id} declares read "${field}" but its implementation never reads it`
      );
    }
  }
});

test('the drift guard actually catches an undeclared read (self-check)', () => {
  // 防「守卫本身永远绿」：先确认记录器真的能观测到已知读取……
  const recorded = recordReadsAcrossFixture();
  assert.ok(recorded.has('detail'), 'recorder must observe real reads such as "detail"');
  assert.ok(recorded.has('nearest_defender_distance'));
  // ……再确认契约的允许集确实排除了本 change 删掉的字段（写了就红）。
  const allowed = allAllowedReadKeys();
  assert.equal(allowed.has('target_distance'), false, 'target_distance must not be declared (D3 removes it)');
  assert.equal(allowed.has('dead_ball'), true, 'dead_ball snapshot flag is a declared read');
  // 反向自检：从允许集里剔除一个确实被读取的字段，守卫必须立刻把它报成「未声明」。
  // （直接验证「契约少了字段 → 判决非空」这条因果，而不是猜 detector 会读什么。）
  const withoutDetail = new Set(allowed);
  withoutDetail.delete('detail');
  const flagged = [...recorded].filter((k) => !withoutDetail.has(k));
  assert.deepEqual(
    flagged,
    ['detail'],
    'the guard must surface a read field that the contract fails to declare'
  );
  // 逐 detector 归属守卫的自检：跨 detector 的字段必须被逐 detector 判定拒绝。
  // 例：`corridor_distance` 只登记在 ignored_interception_opportunity 名下，
  // 逐 detector 的允许集里 unforced_out 不该有它。
  const unforcedAllowed = allowedReadKeys(DETECTOR_FIELD_CONTRACT.unforced_out);
  assert.equal(unforcedAllowed.has('corridor_distance'), false);
  assert.equal(unforcedAllowed.has('detail'), true);
});

// --- 4. schema_version 版本保护 (D6) ----------------------------------------

test('AUDIT_INPUT_SCHEMA_VERSION is a non-empty string and matches the fixture', () => {
  assert.equal(typeof AUDIT_INPUT_SCHEMA_VERSION, 'string');
  assert.ok(AUDIT_INPUT_SCHEMA_VERSION.length > 0);
  // 真实采集现在必须带版本号，否则 runner 会拒绝。
  for (const w of FIXTURE.windows) {
    // 生成器落盘时冻结的是当时采集到的 audit_input；版本字段由 derive 层加。
    assert.ok(
      w.audit_input.schema_version === undefined ||
        w.audit_input.schema_version === AUDIT_INPUT_SCHEMA_VERSION,
      `${w.label}: unexpected schema_version ${w.audit_input.schema_version}`
    );
  }
});

// --- 5. 契约驱动的行为回归（真实数据） ---------------------------------------

test('real out-of-play pass is classified out via the result main path (D4)', () => {
  const w = windowNamed('out_sideline');
  const { findings, pass_outcomes } = runAudit(w.audit_input);
  const pass = w.audit_input.events.find((e) => e.detail === 'out_sideline');
  assert.equal(pass.result, 'out', 'P27: real out passes now use result:"out"');
  assert.equal(pass.out_side, 'sideline');
  assert.equal(pass.y2, 0, 'landing projection is still clamped to the touch line');
  const unforced = findings.filter(
    (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index
  );
  assert.equal(unforced.length, 1, JSON.stringify(findings));
  assert.notEqual(unforced[0].severity, 'unknown', 'must no longer be unknown');
  assert.equal(unforced[0].features.out_evidence, 'event.result');
  assert.equal(unforced[0].features.out_reason, 'sideline');
  assert.equal(pass_outcomes.unpressured.out_count + pass_outcomes.pressured.out_count, 1);
});

test('real out-of-play pass on the goal line is also classified out (D1)', () => {
  const w = windowNamed('out_goal_line');
  const { findings } = runAudit(w.audit_input);
  const pass = w.audit_input.events.find((e) => e.detail === 'out_goal_line');
  assert.equal(pass.x2, 105, 'landing projection is still clamped to the touch line');
  const unforced = findings.find(
    (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index
  );
  assert.ok(unforced, 'out_goal_line must produce an unforced_out finding');
  assert.notEqual(unforced.severity, 'unknown');
  assert.equal(unforced.features.out_evidence, 'event.result');
  assert.equal(unforced.features.out_reason, 'goal_line');
});

test('real dead-ball details are excluded from the ordinary-pass buckets (D2)', () => {
  for (const label of ['corner', 'throw_in', 'free_kick', 'clearance']) {
    const w = windowNamed(label);
    const { pass_outcomes, findings } = runAudit(w.audit_input);
    const pass = w.audit_input.events.find((e) => e.detail === label);
    assert.ok(pass, `${label}: fixture should carry the pass`);
    assert.ok(pass_outcomes.excluded.sample_count >= 1, `${label} must be excluded`);
    const unforced = findings.find(
      (f) => f.detector_id === 'unforced_out' && f.event_index === pass.index && f.severity !== 'unknown'
    );
    assert.equal(unforced, undefined, `${label} must not produce an unforced_out finding`);
  }
});

test('a contested result alone never excludes a pass (D2)', () => {
  // `contested` 是「落点是争抢点」（门球/角球发球），**不是**排除位。P27 后出界 pass 改发
  // result="out"，但门球/角球发球仍是 contested——这条钉住「contest 不是排除 token」。
  const { pass_outcomes } = runAudit({
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    players: {},
    events: [
      { index: 0, t: 1, type: 'pass', result: 'contested', x2: 0.5, y2: 0.5, nearest_defender_distance: 12, pass_distance: 25 },
    ],
  });
  assert.equal(pass_outcomes.excluded.sample_count, 0, 'contested must not be an exclusion token');
  // 真实角球发球（result=contested + detail=corner）仍按 detail 排除——排除的是 detail，不是 result。
  const w = windowNamed('corner');
  const pass = w.audit_input.events.find((e) => e.detail === 'corner');
  assert.equal(pass.result, 'contested');
  assert.ok(runAudit(w.audit_input).pass_outcomes.excluded.sample_count >= 1);
});

test('real dead-ball snapshots carry the produced dead_ball flag', () => {
  const w = windowNamed('whistle_dead_ball');
  const snaps = Object.values(w.audit_input.players).flat();
  const dead = snaps.filter((s) => s.dead_ball === true);
  assert.ok(dead.length > 0, 'whistle window must carry snapshots with dead_ball:true');
  // 该位有生产者（derive 层 isDeadBallEvent + 球静止）→ 是契约里的正常 reads，
  // 不是 legacy 布尔位。detector 的资格判定仍会读它（见漂移守卫）。
  assert.equal(recordReadsAcrossFixture().has('dead_ball'), true);
});

test('a real out pass is never excluded from the ordinary-pass buckets (D2 regression)', () => {
  // 出界 detail 是 out_*，不在 EXCLUSION_DETAILS 里 → 出界 pass 必须进 ordinary 桶并按 out 分类。
  // （P21 时代出界球 result 是 contested；P27 改 out。两条都不得被判成 excluded——排除读的是
  //  detail 集合，与 result 取值无关。）
  for (const label of ['out_sideline', 'out_goal_line']) {
    const w = windowNamed(label);
    const { pass_outcomes, findings } = runAudit(w.audit_input);
    assert.equal(pass_outcomes.excluded.sample_count, 0, `${label} must not be excluded`);
    const pass = w.audit_input.events.find((e) => e.detail === label);
    assert.equal(pass.result, 'out');
    const f = findings.find((x) => x.detector_id === 'unforced_out' && x.event_index === pass.index);
    assert.ok(f, `${label} must yield an unforced_out finding`);
    assert.doesNotMatch(f.reason ?? '', /excluded/, `${label} must not be excluded`);
    assert.equal(f.features.out_evidence, 'event.result', `${label}: must classify via the result main path`);
  }
});

test('a gap that names a produced field records why the producer is not enough', () => {
  // dead_ball 有生产者（whistle 路径有效），但 isDeadBallEvent 里还有同类死分支
  // （result==="out" / kickoff x2），真实数据里出界/进球后被标成死球。这不是「字段没人产」，
  // 而是「产出的覆盖面不够」——登记为 semantic gap，并断言它的字段确实有生产者，
  // 免得有人把它误当 unproducible 去改 detector（该修的是 derive 层）。
  const gap = KNOWN_GAPS.dead_ball_event_detection;
  assert.equal(gap.kind, 'semantic');
  assert.equal(gap.detector_fields.inactive_responsibility, 'dead_ball');
  const entry = DETECTOR_FIELD_CONTRACT.inactive_responsibility;
  assert.ok(entry.producers.dead_ball, 'dead_ball has a (partial) producer, hence a semantic gap');
  assert.ok(entry.known_gaps.includes('dead_ball_event_detection'));
  // 反向：真实 fixture 确实产出了 dead_ball（whistle 窗口），所以不能登记成 unproducible。
  const dead = allRealSnapshots().filter((s) => s.dead_ball === true);
  assert.ok(dead.length > 0, 'the real fixture must carry produced dead_ball snapshots');
});

test('source-level: destructuring scan reads the field name, not a neighbouring keyword (F1 precision)', () => {
  // 回归：解构正则若允许模式内嵌 `{`，会从外层大括号起匹配，把 `const` 当成字段名。
  // 这里直接验证「块内解构」扫出的名字是字段本身。
  const planted = `
    export function detectUnforcedOut(events, profile) {
      for (const event of events) {
        if (false) { const { zz_inner_field } = event; void zz_inner_field; }
      }
    }`;
  const reads = sourceFieldReads(planted);
  assert.ok(reads.has('zz_inner_field'), 'scanner must name the destructured field');
  assert.equal(reads.has('const'), false, 'scanner must not mistake a keyword for a field');
});

const DERIVE_SOURCE = readFileSync(join(HERE, '..', 'viewer', 'derive-audit-features.js'), 'utf8');

test('responsibility trigger values produced by derive match the values detectors accept (N2)', () => {
  // 值契约（枚举）此前无守卫：把 derive 层产出的 `possession_transition` 改名为 `transition`
  // 两套全绿，但真实数据上该 trigger 静默失效（审阅实测 60 次 capture 里 6 次输出变化）。
  // 注意：不能只查 fixture——7 个窗口只采到 `ball_entered_zone`，`possession_transition`
  // 在别的窗口才出现。所以**从 derive 源码里**枚举它可能产出的值，再与 detector 接受的集合比对。
  const produced = new Set();
  for (const m of DERIVE_SOURCE.matchAll(/\bresponsibility\s*=\s*'([^']+)'/g)) produced.add(m[1]);
  assert.ok(produced.size > 0, 'could not find any responsibility assignment in derive source');
  // 也把 fixture 里实际采到的值并进来（双保险）。
  for (const w of FIXTURE.windows) {
    for (const snaps of Object.values(w.audit_input.players)) {
      for (const s of snaps) if (s.responsibility) produced.add(s.responsibility);
    }
  }
  // RESPONSIBILITY_TRIGGERS 是 detectors.mjs 内部常量；从源码文本解析（避免为测试导出内部量）。
  const m = /const RESPONSIBILITY_TRIGGERS = \[([^\]]*)\]/.exec(DETECTORS_SOURCE);
  assert.ok(m, 'could not locate RESPONSIBILITY_TRIGGERS in detectors.mjs');
  const accepted = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  const unaccepted = [...produced].filter((v) => !accepted.has(v));
  assert.deepEqual(
    unaccepted,
    [],
    `derive layer can produce responsibility values the detector does not accept: ${unaccepted.join(', ')}`
  );
});

test('source-level: every input-container loop binding is derived, not fallback-covered', () => {
  // 这条把「推导 vs 兜底」变成可观测事实：正则若漏掉某个 `for (const X of events|players|…)`
  // （如跨行贪婪吞并），X 会落入 INPUT_BASE_VARS_FALLBACK 的硬编码名字，改名即失明。
  // 断言每个循环绑定名都出现在 deriveInputBaseVars 的结果里，且不是靠 fallback 碰巧命中。
  const code = stripComments(DETECTORS_SOURCE);
  const containers = INPUT_CONTAINERS.join('|');
  const re = new RegExp(
    `for\\s*\\(\\s*const\\s+(\\[?[^\\]\\n]*\\]?)\\s+of\\s+(?:Object\\.entries\\()?(?:${containers})\\b`,
    'g'
  );
  const derived = new Set(deriveInputBaseVars(code));
  const bindings = [];
  for (const m of code.matchAll(re)) {
    const raw = m[1].trim();
    const names = raw.startsWith('[')
      ? raw.replace(/[[\]]/g, '').split(',').map((p) => p.trim())
      : [raw];
    bindings.push(...names);
  }
  assert.ok(bindings.length > 0, 'found no input-container loop bindings — regex is broken');
  const missing = bindings.filter((n) => !derived.has(n));
  assert.deepEqual(
    missing,
    [],
    `loop bindings not derived (would be invisible if renamed): ${missing.join(', ')}`
  );
  // 非绑定名不该被推导（确保推导不是「把任意名字都塞进去」）：`sortedReasons` 是内部容器，
  // 它的绑定 `reason` 不在输入容器里。
  assert.equal(derived.has('reason'), false, 'non-input binding must NOT be derived');

  // **有牙自检**：真实源码里所有循环绑定恰好都叫 fallback 名（`event`）或能从别处推出，
  // 所以拿 pristine 源码测不出「正则吞掉某个绑定」。用一段合成的、绑定名唯一的源码验证
  // ——正则若跨行贪婪吞并（漏 `\n`），这个绑定就推导不出来。
  const synthetic = [
    'for (const onlyBinding of events) {',
    '  void onlyBinding.a;',
    '}',
    'for (const secondBinding of players) {',
    '  void secondBinding.b;',
    '}',
  ].join('\n');
  const synthDerived = new Set(deriveInputBaseVars(synthetic));
  for (const b of ['onlyBinding', 'secondBinding']) {
    assert.ok(
      synthDerived.has(b),
      `binding "${b}" must be derived — a runaway regex would swallow it`
    );
  }
});
