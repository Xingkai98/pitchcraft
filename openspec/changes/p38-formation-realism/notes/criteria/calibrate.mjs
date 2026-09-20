// P38 #91：阈值标定 + 变异自证
//
// 输入：table.json（7 个变体 × 11 个量的实测值，由 drive-criteria.mjs 生成）
// 目标：找出「成组否决」判据的阈值，使
//   - 真实值 通过
//   - 已知 hack 变体 全部被挡（这是变异自证）
//
// 不是拍脑袋：阈值由**反推**得到，且每个阈值都标注它挡了谁、漏了谁。

import { readFileSync, existsSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./table.json', import.meta.url).pathname, 'utf8'));
const real = rows.find((r) => r.tag.startsWith('REAL'));
const variants = rows.filter((r) => !r.tag.startsWith('REAL'));

// ── 固定夹具：`patches/` 覆盖不到的**靶子配置** ───────────────────────────
// `drive-criteria.mjs` 只跑 `notes/patches/*.patch`，而射门判据的动机靶子
// （exp4b「等间距块」，射门 0.56–4.2/场）在 `candidates/03-decouple` 与线 B 的扫描里，
// **不在那个目录**。不补进来的话，射门判据一条变体都挡不住——
// "变异自证通过"会变成**空转**（判据的靶子缺席 = 假绿，P36 同类教训）。
// 夹具由 `fixtures/build-fixtures.mjs` 从已跑完的归档实测提炼（只改名、不重跑）。
const FIXTURES = new URL('./fixtures/exp4b-family.jsonl', import.meta.url).pathname;
const fixtures = existsSync(FIXTURES)
  ? readFileSync(FIXTURES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
if (fixtures.length) variants.push(...fixtures);

// ── 判据定义 ────────────────────────────────────────────────────────────
// 方向 'band'：值须落在 center ± tol（双边）
//   `center` 缺省 = 真实值（`real[key]`）；显式给出时用它自己的（见 shotsReg）
//
// ⚠️ **shotsReg 是唯一一条"单边 + 不可用真实值标定"的判据**（阶段 1 决策，完整理由见
// criteria/README.md「射门口径」）。三段话，缺一段都会读错：
//
// ① **为什么不能用真实值标定**：真实侧普通射门 **16.5/场**（Metrica 2 场按 90 分钟归一），
//    而**引擎自己的 L1 门**（`engine/tests/realism.rs`）断言的是 **6–11/场**。不是引擎写错了——
//    引擎**没有二次进攻链**（篮板/补射/被封堵后二次起脚），为了保住进球数把命中率调高了，
//    射门数因此**设计上**就低于真实。用真实值做带 → 拒绝**引擎全部的合法配置**
//    （含干净基线 7.2）→ 判据永远为红、失去区分力。这是"标定对象与实现不同构"，
//    与 P37「口径分叉 = 数字不可比」同类，但方向相反：**这次是拿真实值去要求一个
//    架构上给不出该值的东西**。
//
// ② **为什么是单边（只有下界）**：上界同样没有可用锚点——真实 16.5 在引擎里**不可达**，
//    引擎合法簇的上沿（`exp8` 9.9）也不该被当成"太多"。故只保留**下界**，
//    语义明确：**挡"射门塌到地板"**（exp4b 0.56、exp4b+local 1.6/2.2），
//    不承诺射门体量向真实收敛。要真收敛须先补二次进攻链（#89 之后的量级）。
//
// ③ **下界 5.5 从哪来**：取自**引擎 L1 门的预注册下沿 6.0 − 0.5 余量**
//    （`engine/tests/realism.rs` 的 `(6.0..=11.0)`），**不是**从本表反推的——
//    反推会变成对着样本调参。实测分离度：塌缩簇最高 **4.2**（exp4b+local 0.7/10 种子），
//    合法簇最低 **5.9**（exp9-duty s=0.6）——两者相差 1.7，5.5 落在中间偏保守一侧。
//    ⚠️ 这个余量是**窄的**（0.4 / 1.3），说明射门这条判据的判别力弱于几何五条，
//    它是"地板哨兵"而不是"拟合度判据"。用 `min` 方向如实表达这一点。
const CRITERIA = [
  { key: 'hd', name: '纵深', group: '纵向', dir: 'band', tol: 2.5 },
  { key: 'spread', name: '紧凑度', group: '纵向', dir: 'band', tol: 1.8 },
  { key: 'gap', name: '重心间距', group: '纵向', dir: 'band', tol: 1.8 },
  { key: 'latSd', name: '横向位移 sd', group: '横向', dir: 'band', tol: 3.5 },
  { key: 'swarm', name: 'y 两两相关', group: '整体性', dir: 'band', tol: 0.22 },
  { key: 'fault', name: '断层幅度', group: '结构', dir: 'band', tol: 2.5 },
  { key: 'midBack', name: '各线均衡', group: '结构', dir: 'band', tol: 0.22 },
  {
    key: 'shotsReg',
    name: '普通射门/场',
    group: '行为',
    dir: 'min',
    floor: 5.5,
    note: '口径：普通射门（detail != header），逐场按 90 分钟归一后平均；'
      + '下界单边（真实 16.5 为参照、不设上界），锚在引擎 L1 门预注册下沿 6.0 − 0.5',
  },
];

const centerOf = (c) => (c.center !== undefined ? c.center : real[c.key]);
const within = (v, target, tol) => v != null && Number.isFinite(v) && Math.abs(v - target) <= tol;
// 判一条：'band' → |v − center| ≤ tol；'min' → v ≥ floor（**单边**，见上）
const okOf = (c, r) => {
  const v = r[c.key];
  if (v == null || !Number.isFinite(v)) return false;
  return c.dir === 'min' ? v >= c.floor : within(v, centerOf(c), c.tol);
};

console.log('=== 逐条判据：谁能挡住谁 ===\n');
for (const c of CRITERIA) {
  const pass = variants.filter((v) => okOf(c, v)).map((v) => v.tag);
  const fail = variants.filter((v) => !okOf(c, v)).map((v) => v.tag);
  const rule = c.dir === 'min'
    ? `下界 ${c.floor}（单边；真实 ${real[c.key]} 为参照、不设上界）`
    : `${c.center !== undefined ? '标定中心' : '真实值'} ${centerOf(c)}，容差 ±${c.tol}`;
  console.log(`【${c.group}】${c.name}（${rule}${c.note ? `；${c.note}` : ''}）`);
  console.log(`   漏过（被判"达标"）：${pass.length ? pass.join(', ') : '（无）'}`);
  console.log(`   挡住：${fail.join(', ')}`);
  console.log();
}

// ── 成组否决：任一条不通过 → 整体不通过 ────────────────────────────────
console.log(`=== 成组否决：全部 ${CRITERIA.length} 条同时达标才算通过 ===\n`);
const verdict = (r) => {
  const bad = CRITERIA.filter((c) => !okOf(c, r)).map((c) => c.name);
  return { pass: bad.length === 0, bad };
};
console.log(`真实值：${verdict(real).pass ? '✅ 通过' : `❌ 未通过（${verdict(real).bad.join(', ')}）`}`);
console.log();
let allBlocked = true;
for (const v of variants) {
  const r = verdict(v);
  if (r.pass) allBlocked = false;
  console.log(`  ${r.pass ? '⚠️ 漏过' : '✅ 挡住'}  ${v.tag.padEnd(24)} ${r.pass ? '' : `不达标：${r.bad.join(', ')}`}`);
}

// ── 每条判据的**独有**贡献：它是不是某个配置的**唯一**拦路者？ ─────────────
// 为什么必须算这个：成组否决里，一条判据若**从不**单独拦下任何配置，
// 它可能是冗余的（别人已经在挡），也可能只是"恰好所有靶子都被多条同时挡"。
// 分不清这两者，就说不清"新增这条判据到底有没有用"。P36 的教训是反面：
// 断言输入对目标变异没区分度 = 假绿；这里把"有没有区分度"**直接量出来**。
console.log('\n=== 每条判据的独有贡献（是否为某配置的唯一拦路者）===');
for (const c of CRITERIA) {
  const sole = variants.filter((v) => !okOf(c, v)
    && CRITERIA.every((o) => o === c || okOf(o, v))).map((v) => v.tag);
  const anyBlock = variants.filter((v) => !okOf(c, v)).length;
  console.log(`  ${c.name.padEnd(14)} 挡住 ${String(anyBlock).padStart(2)}/${variants.length}`
    + `   其中**唯一**拦下：${sole.length ? sole.join(', ') : '（无——与其它判据重叠）'}`);
}

console.log(`\n=== 变异自证 ===`);
console.log(allBlocked
  ? `✅ 全部 ${variants.length} 个变体被挡住 —— 判据组通过变异测试`
  : '⚠️ 有变体漏过 —— 阈值需收紧或增加判据');

// ── 输出标定结果 ────────────────────────────────────────────────────────
const spec = {
  note: 'P38 #91 判据组（成组否决：任一条不达标即不通过）',
  realReference: Object.fromEntries(CRITERIA.map((c) => [c.key, real[c.key]])),
  criteria: CRITERIA.map((c) => {
    // ⚠️ `dir`/`centerSource` 不可省：shotsReg 是**单边 + 不锚真实值**的一条，
    // 不写清楚，下一个读 criteria-spec.json 的人会 (a) 拿它当双边带，
    // (b) 把 5.5 误当成"引擎应有的射门数"或真实射门数。
    if (c.dir === 'min') {
      return {
        key: c.key, name: c.name, group: c.group,
        dir: 'min', floor: c.floor,
        centerSource: 'engine-l1-gate-lower-edge',
        realReference: real[c.key],
        ...(c.note ? { note: c.note } : {}),
      };
    }
    const center = centerOf(c);
    return {
      key: c.key, name: c.name, group: c.group,
      dir: 'band',
      center, tol: c.tol,
      lower: +(center - c.tol).toFixed(3),
      upper: +(center + c.tol).toFixed(3),
      centerSource: c.center !== undefined ? 'engine-l1-band' : 'real',
      ...(c.note ? { note: c.note } : {}),
    };
  }),
  mutationSelfTest: {
    variantsBlocked: variants.every((v) => !verdict(v).pass) ? variants.length : 'NOT ALL',
    totalVariants: variants.length,
    // 夹具不是随手的样本——它们是判据的**靶子**。这里把来源写进 spec，
    // 使"靶子被换掉/删掉"这件事可见（靶子缺席时变异自证是空转）。
    fixtures: fixtures.map((f) => ({ tag: f.tag, shotsReg: f.shotsReg, source: f.source })),
  },
  // 每条判据的**独有贡献**：是否为某配置的唯一拦路者。全 `无` 是**如实记录**，
  // 不是缺陷——它说明这些判据在**当前这批配置**上高度重叠（它们都是同一族
  // "压纵深 → 崩射门"的变体）。判据组的意义正在于等一个打破该重叠的机制出现。
  soleBlocker: Object.fromEntries(CRITERIA.map((c) => [
    c.key,
    variants.filter((v) => !okOf(c, v) && CRITERIA.every((o) => o === c || okOf(o, v))).map((v) => v.tag),
  ])),
};
console.log(`\n${JSON.stringify(spec, null, 2).slice(0, 400)}...`);
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./criteria-spec.json', import.meta.url).pathname, `${JSON.stringify(spec, null, 2)}\n`);
console.log('\n→ criteria-spec.json');
