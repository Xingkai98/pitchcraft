# Issue 81 漂移清单（delta 逐条对照现行代码/主 spec）

核实方式：`git archive HEAD` 到 /tmp 逐个跑 `npx openspec archive --yes` + 逐条 grep
`engine/src/lib.rs` / `viewer/*.js` / `openspec/specs/*/spec.md`。

## 归档后果实测（2026-09-18，base = 8b94cc2）

| change | 归档机制 | 后果 |
|---|---|---|
| p1-tackle-drama | MODIFIED pitch-viewer ×2 | ❌ 主 spec 掉回四段式 |
| p5-team-shape-and-transition | ADDED match-engine ×3 / pitch-viewer ×2 | ❌ 注入 0.02 归一化 repulsion + 0.5m dead-zone |
| p6-goal-kick-and-restart | ADDED esp ×1 / me ×2 / pv ×2 | ⚠️ 文本旧但无矛盾（见 D6） |
| p6-out-of-play-restarts | ADDED esp ×5 / me ×4 / pv ×4 | ❌ 注入错误底线规则 + 3-5% roll + 概率错 |

**注意**：p6×2 是 ADDED-only，不改已有需求（不像 p1 会回退）——但它们会把**过时甚至错误**
的新需求**追加**进主 spec，与 P31 归档的现行需求并存。三种失效模式里这种最隐蔽：
diff 里全是 `+`，看不见"回退"。

### 首轮独立审阅（2026-09-18）追加的 3 个发现

初版修复漏了三处"delta 与**代码**不符"，均已按代码订正（详见各节 D1b / D5b / D6b）：

1. **p1 `抢断失败演绎`** 描述 v1 fallback，对引擎事件不可达（D1b）。
2. **p5 `全队随球侧平移`** 的"防守时收窄 / 进攻保宽度"未实现（D5b）。
3. **p6-goal-kick pitch-viewer** 球终态坐标写反（D6b）——goal 与 off_target 的 x 互换。

**教训**：「ADDED-only 所以安全」是错误推断——它只保证不回退已有需求，不保证新增内容**对**。
核对积压 delta 必须比对**代码**（实现是真相源），不能只查"有没有覆盖同名 requirement"。

### 二轮独立审阅（2026-09-18）追加的 3 个 major

首轮修复本身又留下/漏掉三处 spec↔代码不符，均已订正：

1. **p1 `抢断失败演绎`** 仍写"前**四**段（含弹开）同成功"——v2 fail 分支不产 loose 锚点
   （`interpretation.js:215-220`），**没有弹开段**。改为"前两段同成功；球不弹开、停在接触点"。
2. **p1 `调整抢断演绎节奏`** 声称 `deflectDistance`/`collectDelay` 影响抢断演绎——二者
   只在引擎未给 `loose_x/y` 的 v1 路径生效，引擎事件（v2）不读。已补"参数适用面"。
3. **p6-out-of-play `角球站位`** 写"nearest 几名 / formation_target 覆盖"——`corner_prep`
   分支下**全队外场**目标取自 `corner_setup_target`（`lib.rs:2823-2826`），`formation_target`
   被完全覆盖、`nearest` 型逻辑不存在。已按代码改写。

同轮 minor：micro-motion 补 y 分量（cos）、protocol detail 白名单补 `throw_in`/`free_kick`、
门球起点改"门将当前位置"、重开准备期 beat 口径与 L2 不变量区分"判定 tick vs 准备 tick"、
p1 保留通用 `调整演绎节奏` scenario 以免 dribble/pass/shot 的 config 覆盖收窄。

### 三轮独立审阅（2026-09-18）追加的 1 个 major

- **p5 `控球阶段与攻防转换` 断言了 P31 已删除的 "hold 门控 8-15 tick" 机制**。
  `HOLD_MIN_TICKS`/`POSSESSION_HOLD_MIN` 等常量在代码中**已无读取**（仅定义 + 一条
  `p31_slot_layer_is_gone` 的符号名断言），`MatchState` 也无 hold 计数字段；
  同文件 P31 需求（`:282`）明写"槽位时钟 / 固定评估节拍 / 事件类型配额已全删"——
  与新增的 hold 门控描述**在同一份主 spec 内直接冲突**。这是"过时 delta 追加进主 spec"
  的又一实例，且是本 issue 上轮 major-2 的同类（同 requirement 里已修三处、唯漏此条）。
  已按代码改写为"transition 期间不开启行动机会（该 tick 只产 main+movers）；
  窗口结束恢复自然 deadline 驱动的机会评估；门将走出球档直接掷 pass 高亮"。

### 四轮独立审阅（2026-09-18）追加的 1 个 major

- **p5 `抢断成功触发反击` 的"拾取 ≤ T+3 / 新持球者前插落在窗口 [T,T+4) 内"与引擎实测不符**。
  **实测**（临时探针，300 seed / 1418 次 tackle-success）：拾取偏移直方图 `{4: 1418}`——
  **恒为 T+4**；窗口 [T,T+4) 内外场持球者出现次数 = **0**；close_down mover 偏移只有 1/2/3。
  原因：`LOOSE_MAX_TICKS` 只封顶**球的滚动**、不封顶**追逐**（追逐者每 tick 走 `RUN_SPEED_MS`，
  恒 3 拍），且窗口在拾取 tick 顶部已清除 → `carrier_move` 的反击前插分支对 tackle 路径永不进入。
  已按实测改写该 scenario（并修正 close_down 目标：tackle 源恒取 `st.ball_pos`）。
  同轮 minor：esp 门球起点统一"门将当前位置"、角球越线点措辞（非"门线外一点"）、
  p1 `deflectSpeed` 适用面限定"带弹开段的 tackle"、出界坐标钳制澄清（`x2/y2` vs `out_pos`）。

### 穷举核验（2026-09-18）—— 发现并修复 1 个真实 viewer bug

对本次纳入主 spec 的 25 条新 requirement 逐条穷举核验（两条并行独立核验者）。
绝大多数一致，但抓到一类**新问题：spec 描述的机制在代码里存在、却因此前的接线 bug 不生效**：

- **micro-motion 抑制失效（已修）**：`viewer/game.js` 的 `currentHighlightParticipants()` 直接取
  `currentEventIndex()` 指向的事件；但引擎**同一 tick 先发高亮事件、再发 beat**
  （实测 415/429 个高亮事件后紧跟同 t beat），故该索引恒为 beat → 参与者集合恒为空，
  「高亮参与者不微动」从不生效（实测 16736 个高亮窗口帧中 99% 未抑制；传球者/射手在做微动）。
  该语义此前**零测试覆盖**。修法：新增 `_activeHighlightIndex()`（按事件窗口回溯），
  `app.js` 无需改；并补 2 条守护单测（变异验证：还原旧实现 → 2 条红；修复 → 绿）。
  spec 同步补 `高亮参与者回溯识别` scenario。
- 另核实一致：p6 门球/角球/界外球/头球各分支、出界四类重开映射、`corner_roll<90`、
  争顶 58/52、头球 15/30/55、h 取值区间、`protocol.js` detail 白名单、五段式 v1/v2 分支等。

**仍未在上游修复的已知遗留**（记入 issue，不在本次归档范围）：
① `isHighlightEvent` 不认门球 pass（无 detail）→ 默认 `skipMode` 下门将开大脚会被快进/跳过
（已另开 **issue #84** 跟踪）。

### 五轮独立审阅（2026-09-18/19）—— micro-motion 修复的补正

第五轮发现并修复了**修复本身的两处问题**：

1. **`高亮参与者回溯识别` scenario 的前提不实**：原写"引擎在同一 tick 先发高亮事件（pass/shot/tackle/foul）
   再发 beat"——实测只有 **pass/shot** 的 beat 在同 tick 之后；**tackle 的 beat 在同 tick 之前**、
   **foul 同 tick 不产 beat**。已按实测改写 GIVEN。
2. **foul 抑制回归（已修）**：foul 无锚点 → `_eventEnds` 回落 `e.t` → 窗口零长度，新回溯逻辑在
   `t > foul.t` 时返回 -1，**把修前本来生效的 foul 抑制弄丢了**（实测 55 帧中 44→22）。
   修法：`_highlightEnd(i)` 对 foul 显式延长到纪律牌显示时长；并补第 3 条守护测试
   （变异验证：去掉该延长 → 红）。
   回溯上限由魔数 8s 改为按理论上限推导的 12.5s（最长传球 125m ÷ 最低速 10m/s）。

同轮 minor：防线公式补全末尾 `clamp01(...).clamp(0.04, 0.9)`、准备期 beat 注明
"movers 可为空（dead-zone 吞位移）"、`config.js` 陈旧注释（"踢-追周期"）订正。

## 逐条漂移

### p1-tackle-drama — pitch-viewer

- **D1** `事件演绎遵循剧本` 描述为四段式（无 `carrier_from`），主 spec 现行是 **五段式**
  （`carrier_from_x/y` 带球起点 + `loose_x/y` 弹开点）。代码 `viewer/interpretation.js`
  用 `carrier_from`（`interpretation.test.js:229` 五段式用例），主 spec 对。
  → delta 改写为五段式，并保留 delta 多出的 4 个 scenario（失败分支/垂直/界内/确定性），
  已逐条核实于 `viewer/interpretation.js`（`deflectPoint` 垂线 + 钳制 + 确定性选边）。
- `演绎节奏配置化` delta 是主 spec 的**严格超集**（多"抢断弹开参数"），
  对应 `viewer/config.js` `interpretation.tackle.{deflectDistance,deflectSpeed,collectDelay}` ✓

### p5-team-shape-and-transition — match-engine

- **D2** `防橡皮筋`：repulsion「最小间距 = 球员半径 ×2 约 **0.02 归一化**」→ 现行
  `SAME_TEAM_MIN_DIST_M = 2.2`（米制，P34，`lib.rs:606`）。
- **D3** 同 scenario：「dead-zone 绑定 P4 单门 **0.5m**」→ 现行 `DEAD_ZONE_METERS = 2.0`
  （`lib.rs:492`，c39ec58「P7 观感修复」改为 2m）。
- **D4** `控球阶段与攻防转换` 触发源写「抢断成功 / 射门被扑住（save-caught）；**拦截标注"后续加入"**」
  → 代码 `enum TransitionSource`（`lib.rs:2232`）只有 `Tackle` / `SaveCaught`，无拦截。
  删掉该 TODO 占位（规范里不该留未定项）。
- **D5** 新增需求名 `确定性` 与主 spec 的 `种子确定性`、`确定性 golden master 防漂移`
  三名混用 → 改名 `队形与阶段转换确定性`（内容不变）。
- **D5b**（首轮审阅抓到）`全队随球侧平移` 原写「防守时收窄，进攻时保持宽度」——
  `formation_target`（`lib.rs:2631-2660`）**没有任何随 phase 变化的宽度因子**，
  test `p5_formation_and_transition` 与 `tasks.md` S1.3 也未覆盖"收窄"。
  改为代码实有的「纵向同向随球压缩（y 偏移 = (ball_y−0.5)×`SIDE_SHIFT_FACTOR`×0.6）」。

### p1-tackle-drama（首轮审阅补记）

- **D1b**（**首轮审阅抓到**）新增的 `抢断失败演绎` scenario 描述的是 **v1 fallback 路径**
  （"被铲者追到弹开点重新拿回"），**对引擎事件不可达**——引擎 tackle 恒带 `carrier`
  （`lib.rs:3471`），走 v2 分支；v2 fail 时球**停在接触点、不产生松散球**
  （`viewer/interpretation.js:215-219` + `lib.rs:3629 TackleFail`：`ball_pos = contact`、
  `carrier = victim`）。且原 GIVEN 写"其余字段同上"（上文是含 `carrier_from` 的五段式），
  自相矛盾。已拆成 "抢断成功演绎" + "抢断失败演绎（v2 语义）" 两个 scenario。
- pitch-viewer micro-motion ×2 核对无误：振幅 <0.002、`hash(id)` 派生并缓存、
  fade ~0.3s、移动者/持球者抑制 —— 与 `viewer/micro-motion.js` 一致 ✓

### p6-goal-kick-and-restart

- **D6** match-engine 侧核对一致：门球不触发 transition（`start_goal_kick` 无 `st.transition = Some`）✓、
  进球球回中圈（`advance_dead_ball` 前置 `st.ball_pos = (0.5,0.5)`，`lib.rs:2476`）✓、
  开大脚 `speed = 16.0 + rand%40/10` → 16-19.9 m/s（原写 ~15-20，收敛为 ~16-20）✓、
  `h = 0.5 + rand%30/100` → 0.5-0.8 ✓。
- **D6b**（**首轮审阅抓到**）pitch-viewer 侧**原稿与代码相反**：
  - 原稿 `goal 越门线进网（x=1.02/[-0.02]）` → 代码 goal 停在**网内** `x=1.005`
    （`viewer/interpretation.js:124`；1.02 是 **off_target** 的值）。
  - 原稿 `saved/off_target 停门线/边线，不越过门线` → 代码 off_target **飞过球门**到 1.02/[-0.02]，
    saved 才停 `x2`（门线）。
  - 该语义由 `a34bca2 P6 修复：进球球停在门里` 引入（base 的祖先）。已按代码改写两个 scenario。

### p6-out-of-play-restarts — match-engine

- **D7** `出界判定与重开类型` 触发写「**3-5% 概率**」→ 现行 `open_play_out_probability(pass_risk)`
  涌现通道（P31 归档，主 spec `match-engine/spec.md:282`）。
- **D8**（**实质错误**）同需求写「传球出底线 → 门球（对方门将）」一刀切 →
  现行 `out_restart_for`（`lib.rs:893`）：`NormalPass + 己方底线 → 角球`、
  `NormalPass + 对方底线 → 门球`。delta 的 `传球出底线 → 门球` scenario **是错的**，
  照抄会把错误规则写进主 spec。
- **D9** 同需求「射门被扑出底线（概率 **~30%**）」→ 代码 `corner_roll < 90`（90%，`lib.rs:3206`）。
- **D10** `角球机制` 争抢「攻方 **55/45**」→ 现行基线 55/45 + **P33 主场偏移**
  （`BATTLE_ATTACK_WIN_HOME=58` / `AWAY=52`，`lib.rs:585`）。
- **D11** `头球射门` result「goal(~10%)/saved(~40%)/off_target(~50%)」→ 代码 **15/30/55**
  （`lib.rs:3990`，对齐禁区内桶）。
- 其余核对无误：界外球掷球 `h=0` ✓、头球解围 `detail=clearance` `h=0` ✓、
  `detail=corner` ✓、RestartPrep `beat.ball` 锚点 ✓、
  `pass_h` 20m 阈值 0.2-0.4 ✓、viewer `radius*(1+h*1.5)` ✓。

## 其余积压 change 的漂移复核（issue 验收第 3 条）

`openspec/changes/` 下除本次 4 个外还有 `p35-real-match-reference` / `p36-match-benchmark`：

- 两者 delta 均 **ADDED-only**，且新增需求名与主 spec 现行 `pitch-viewer` 需求名**零重叠**
  （p35 新增 6 个、p36 新增 5 个，交集为空）。
- 二者实现已合入 main（P35/P36 已 merge，PR #76/#79），delta 是"待归档"而非"漂移"——
  与 p10–p13 同类，属安全的纯追加，不在本 issue 范围（本 issue 只处理 p1/p5/p6×2）。
- 复核命令（可复跑）：对每个积压 change 取其 delta 的 requirement 名与主 spec 同名集合求交，
  非空即需逐条比对；ADDED + 零交集 = 可安全归档。

## 归档顺序

`p6-goal-kick` 先于 `p6-out-of-play`：后者的 `出界判定与重开类型` 正文以
「射门打偏 → 门球（**由 `p6-goal-kick-and-restart` 建立**）」引用前者。
实测两个顺序都能跑通（archive 不校验引用），但按引用关系排序才是语义正确的。
