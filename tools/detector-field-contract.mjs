// detector 字段契约清单（P21 D5）——单一事实来源。
//
// 目的：detector 读的字段，与引擎/推导层真正产出的字段，过去靠人脑心算对齐，于是
// 「单测全绿、生产全漏」的字段断裂（issue #26）能潜伏几个月。这份清单把「谁读、谁产、
// 谁没有生产者」写死成数据，由 tools/detector-field-contract.test.mjs 对着**真实**
// audit_input 断言。detector 代码新增/改读某个字段而清单没跟上 → 测试红。
//
// 术语：
//   reads         detector 依赖、且当前生产链路必须有人产的字段（无生产者即缺陷）。
//   legacy_reads  detector 仍兼容、但明确允许无生产者的字段（P21 D2 的布尔排除位：
//                 引擎从不产，保留只为兼容旧合成 fixture；真实数据里应当从不出现）。
//   known_gaps   已知且登记在案的缺口（无生产者的读取字段 = field 非 null 的那些），
//                 每条带 issue 号。本轮不做，但必须显式登记而非默默漂移。
//
// 生产方（producer）取值：
//   'engine'  viewer 可见的事件流字段（引擎直出，经协议校验）。
//   'derive'  viewer/derive-audit-features.js 推导（米制化/几何事实/可观测代理）。
//   'viewer'  viewer 采集层直出（事件索引、时间戳、快照采样）。
//
// 边界：本模块是「detector **读取面**」的清单——只列 detector 会去读的字段及其生产方，
// **不是引擎产出面的清单**（引擎真实事件还有 subject/from/speed/… 等 detector 不读的字段，
// 不在此登记）。它也不描述字段语义（那在 protocol.js / derive-audit-features.js），
// 不覆盖 #25 要改的引擎侧编码。
//
// 注意：「有生产者」是按**当前派生层实现**判定的，而派生层的字段保留由
// viewer/derived-audit.test.js 的活体守卫钉住（活体守卫走真实 captureObservation，
// 不读冻结 fixture）——契约测试本身吃的是落盘快照，看不见派生层是否丢字段。

// audit_input 的版本号定义在生产方（viewer/derive-audit-features.js，浏览器可 import），
// 这里再导出，让 tools 侧有单一引用点。viewer 不能 import tools（浏览器静态服务只服务
// viewer/），所以常量只能住在 viewer 侧；tools→viewer 引用有先例（runner.mjs→event-labels.js）。
export { AUDIT_INPUT_SCHEMA_VERSION } from '../viewer/derive-audit-features.js';

// 事件字段的公共 reads（所有按事件工作的 detector 都要的骨架字段）。
const EVENT_SKELETON = ['t', 'type', 'index'];

export const DETECTOR_FIELD_CONTRACT = {
  baseline_invariant: {
    reads: [...EVENT_SKELETON, 'x', 'y', 'x2', 'y2', 'pass_distance'],
    legacy_reads: [],
    producers: {
      t: 'engine',
      type: 'engine',
      index: 'viewer',
      x: 'engine',
      y: 'engine',
      x2: 'derive',
      y2: 'derive',
      pass_distance: 'derive',
    },
    known_gaps: [],
    notes:
      '坐标不变量对任何 bundle 成立；x2/y2 经 derive 米制化，几何越界仍会被本 detector 抓到。',
  },

  unforced_out: {
    reads: [
      ...EVENT_SKELETON,
      'result',
      'detail',
      'x2',
      'y2',
      'nearest_defender_distance',
      'pass_distance',
    ],
    // D2 兼容位：引擎从不产这些布尔键，保留只为旧合成 fixture。
    legacy_reads: ['corner', 'throw_in', 'clearance'],
    producers: {
      t: 'engine',
      type: 'engine',
      index: 'viewer',
      result: 'engine',
      detail: 'engine',
      x2: 'derive',
      y2: 'derive',
      nearest_defender_distance: 'derive',
      pass_distance: 'derive',
    },
    known_gaps: ['goal_kick_exclusion', 'clearance_out_intent'],
    notes:
      '出界证据优先 detail（out_sideline/out_goal_line），兼容 result==="out" 与几何出界（D1）。',
  },

  ignored_interception_opportunity: {
    reads: [
      ...EVENT_SKELETON,
      'corridor_distance',
      'pass_distance',
      'pass_speed',
      'defender_id',
      'defender_moved_toward_corridor',
    ],
    legacy_reads: [],
    producers: {
      t: 'engine',
      type: 'engine',
      index: 'viewer',
      corridor_distance: 'derive',
      pass_distance: 'derive',
      pass_speed: 'derive',
      defender_id: 'derive',
      defender_moved_toward_corridor: 'derive',
    },
    known_gaps: [],
    notes:
      '本轮未标定（D4）：finding 带 calibrated:false，聚合不升级 failure，标定归 #36。',
  },

  inactive_responsibility: {
    reads: [
      't',
      'x',
      'y',
      'is_gk',
      'dead_ball',
      'moved_toward_goal',
      'moved_toward_ball',
      'responsibility',
      'responsibility_source',
    ],
    legacy_reads: [],
    producers: {
      t: 'viewer',
      x: 'derive',
      y: 'derive',
      is_gk: 'derive',
      dead_ball: 'derive',
      moved_toward_goal: 'derive',
      moved_toward_ball: 'derive',
      responsibility: 'derive',
      responsibility_source: 'derive',
    },
    known_gaps: ['formation_hold', 'dead_ball_event_detection'],
    notes:
      'formation_hold 无生产者（引擎内部事实、viewer 不可观测）→ 已从 detector 删除死代码引用（K3）。',
  },

  // pass_outcomes 不是 detector，是 runAudit 的普通传球分桶统计；它和 unforced_out 共享
  // 排除位契约，所以一并登记，防止两处再漂移。
  // 注意 reads 必须精确反映实现：分桶只按 type / 排除位 / nearest_defender_distance / 出界
  // 结果，不读 t/index/pass_distance（那是 finding 与其它 detector 才需要的信息）。
  pass_outcomes: {
    reads: ['type', 'result', 'detail', 'x2', 'y2', 'nearest_defender_distance'],
    legacy_reads: ['corner', 'throw_in', 'clearance'],
    producers: {
      type: 'engine',
      result: 'engine',
      detail: 'engine',
      x2: 'derive',
      y2: 'derive',
      nearest_defender_distance: 'derive',
    },
    known_gaps: ['goal_kick_exclusion'],
    notes: '排除位与出界分类复用 unforced_out 的同一契约（D1/D2）。',
  },
};

// 已登记的 known gap 明细。key 必须与上面各 detector 的 known_gaps 条目一致。
//
// kind 决定断言方式：
//   'unproducible'  该字段被 detector 读、但生产链路产不出（最危险的一类，issue #26 的病根）。
//                   断言：该字段必须在 reads 里且确实没有生产者。
//   'semantic'      字段有生产者，但表达力不足——拿不到 detector 需要的那一层区分。
//                   断言：该字段必须有生产者（否则应改成 unproducible）。
//   'removed'       本轮把「读一个没有生产者的字段」的死代码删掉了，留档防止回潮。
//                   断言：该字段当前不在 reads 里。
export const KNOWN_GAPS = {
  goal_kick_exclusion: {
    id: 'goal_kick_exclusion',
    kind: 'semantic',
    detector_fields: { unforced_out: 'detail', pass_outcomes: 'detail' },
    reason:
      '门将开大脚（门球）pass 无 detail，无法靠 detail 排除出 ordinary pass 桶。影响是统计轻微偏差（门球计入普通传球），非漏报。',
    issue: '#25',
  },
  clearance_out_intent: {
    id: 'clearance_out_intent',
    kind: 'semantic',
    detector_fields: { unforced_out: 'detail' },
    // 严重度高于 K1（goal_kick_exclusion 只是统计轻微偏差）：这条产生的是**假阳性**——
    // 防守方有意解围出界会被报成「无压力传球失误」，直接进诊断报告误导根因分析。
    reason:
      '头球解围出界事件 detail 也是 out_*，与普通传球出界同形（source=Clearance 只在 Highlight 里、不进事件 JSON）。解围出界会被 unforced_out 当普通出界报——防守方有意解围被当失误。这是假阳性（不是统计偏差），会进诊断报告。',
    issue: '#25',
  },
  formation_hold: {
    id: 'formation_hold',
    kind: 'removed',
    detector_fields: { inactive_responsibility: 'formation_hold' },
    reason:
      '引擎内部决策事实，viewer 不可观测、derive 层不推导。detector 对该字段的引用是死代码（=== true 永远 false），本 change 已删除。',
    issue: '#28',
  },
  dead_ball_event_detection: {
    id: 'dead_ball_event_detection',
    kind: 'semantic',
    detector_fields: { inactive_responsibility: 'dead_ball' },
    reason:
      'derive 层的 dead_ball 快照位确有生产者（whistle 路径有效），但它的判定函数 isDeadBallEvent 里还有两条同类死分支：`pass && result === "out"`（当前引擎不产 result==="out"，见 #25；若 #25 之后引擎改产，该分支会复活）与 `kickoff && x2 === undefined`（真实 kickoff 带 x2）。加上取的是「最近一个事件」（通常是 beat），真实数据里出界/进球后并不会被标成死球。影响：死球期间的站桩可能被 inactive_responsibility 误报。修法要动 derive 层「最近非 beat 事件」的口径，属 P21 决定范围之外，故显式登记。',
    issue: '#26',
  },
};

// audit_input 顶层结构键：不是「事件/快照上的字段」，而是入口本身读的顶层键。
// `schema_version` 是 D6 的版本门读的；`events`/`players` 是 audit_input 的负载容器
// （数字球员 id 是 players 的动态子键，不是字段）。这些不参与「字段有无生产者」判定。
export const AUDIT_INPUT_TOP_LEVEL_KEYS = ['schema_version', 'events', 'players'];

// 某个 detector 全部允许被读取的字段（reads ∪ legacy_reads）。测试用它做漂移守卫：
// 真实运行读到的键必须落在这里面，否则契约清单落后于代码。
export function allowedReadKeys(entry) {
  return new Set([...entry.reads, ...entry.legacy_reads]);
}

// 全部 detector 允许读取的字段 ∪ audit_input 顶层结构键。漂移守卫的完整允许集：
// 真实运行读到的任何键都必须落在这里面，否则契约清单落后于实现。
export function allAllowedReadKeys() {
  const out = new Set(AUDIT_INPUT_TOP_LEVEL_KEYS);
  for (const entry of Object.values(DETECTOR_FIELD_CONTRACT)) {
    for (const f of allowedReadKeys(entry)) out.add(f);
  }
  return out;
}

// 无生产者的读取字段（reads 中不在 producers 里的）。
export function fieldsWithoutProducer(entry) {
  return entry.reads.filter((f) => !entry.producers[f]);
}
