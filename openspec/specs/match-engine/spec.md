# match-engine Specification

## Purpose
TBD - created by archiving change p0-event-to-pitch. Update Purpose after archive.
## Requirements
### Requirement: 引擎纯逻辑、平台无关

Rust 引擎 SHALL 是纯逻辑库，不假设有文件系统/命令行——数据进、事件流出，可被 WASM 与 Tauri 内嵌两种方式消费。

#### Scenario: 引擎被 WASM 消费
- **WHEN** 引擎编译为 WASM 并在浏览器中调用
- **THEN** 引擎不执行任何文件系统/命令行操作，仅通过调用接口产出事件流

### Requirement: 最小 config 形状（S3 修复）

引擎的 simulate(seed, config) 接口 SHALL 定义最小 config 形状：`{ match_duration_seconds }`，使确定性契约（同 seed 同 config）可测试。config 形状 SHALL 在引擎 API 中明确，P0 不做更多配置项。

#### Scenario: config 决定比赛时长
- **WHEN** 引擎被传入 config { match_duration_seconds: 2700 }
- **THEN** 产出的事件流时间跨度约为 2700 秒（半场 45 分钟）

### Requirement: 种子确定性

引擎 SHALL 在给定相同种子与相同配置时，产出完全相同的事件流。

#### Scenario: 同种子可复现
- **WHEN** 引擎用种子 S 和配置 C 模拟一场比赛两次
- **THEN** 两次产出的事件流完全相同

#### Scenario: 不同种子结果不同
- **WHEN** 引擎用不同种子模拟同一配置
- **THEN** 两次产出的事件流（通常）不同

### Requirement: 产出最小比赛事件流

引擎 SHALL 能产出一场最小比赛的事件流：以 lineup（初始站位）+ kickoff 开始、以 whistle 结束，中间为固定 tick 的 beat 节拍流（含 main 带球 + movers 跑位）与叠加其上的高亮事件（pass/shot/tackle/foul）。非 demo 模式不产顶层 dribble/off_ball_run/interception 事件（带球由 beat.main 表达、无球跑位由 beat.movers 表达、拦截由 pass result=intercepted 表达）；demo_mode SHALL 保持 v1 事件驱动（含 dribble）。

#### Scenario: 最小比赛
- **WHEN** 引擎被要求模拟一场最小比赛
- **THEN** 输出事件流以 lineup + kickoff 开始，以 whistle 结束，中间包含 beat 节拍与 pass/shot/tackle 高亮事件

### Requirement: 事件含演绎参数

引擎 SHALL 在 pass/shot 事件与 beat.main 中输出演绎参数：pass 含球速与提前量（speed、lead），beat.main 含带球速度与触球频率（speed、touch_freq），shot 含球速（speed）。

#### Scenario: 传球带演绎参数
- **WHEN** 引擎产出一条 pass 事件
- **THEN** 事件包含 from、to、起点坐标、终点坐标、球速（speed）、提前量（lead）、结果（result）

### Requirement: 犯规与纪律牌（foul / 任意球）

引擎 SHALL 在开放持球段产生犯规：防守方有球员贴身（≤ 8m）持球者、犯规点距所攻球门 > 禁区线时，以固定概率产 `foul` 事件。犯规后球权保留给被犯规方，进入任意球重开（`pass detail=free_kick`）。纪律牌决策 SHALL 确定性（引擎 SeededRng）：犯规事件可选携带 `card`（`yellow`/`red`，缺省=无牌）；同人二黄升级红牌罚下；罚下球员不再成为持球者/追逐者/抢断者/逼抢者/传球目标/开球者/接球者，也不得出现在任何事件的并行跑位数组（`movers`）中。当某队外场球员全部被罚下时，向前传球目标选择（`emit_forward_pass_highlight`）与任意球追逐者选择（`nearest_any`）SHALL 回退门将，不返回无效 id。

#### Scenario: 罚下球员不得参与跑位
- **GIVEN** 某球员被罚下（`sent_off[id]` 已置位）
- **WHEN** 引擎生成后续 beat 事件的并行跑位（`compute_movers`）
- **THEN** 该球员不产 mover，不出现在 `movers[].id` 中

#### Scenario: 罚下球员不得被选为抢断者/逼抢者
- **GIVEN** 某球员被罚下
- **WHEN** 引擎选择抢断者/拦截者（`nearest_defender`）或 transition 逼抢者（`pick_close_down_players`）
- **THEN** 该球员不被选中

#### Scenario: 罚下球员不得被选为传球目标或开球者/接球者
- **GIVEN** 某球员被罚下
- **WHEN** 引擎选择传球/发球目标（`nearest_teammate` / 向前传球目标）或进球后开球者/接球者（`kickoff_pick`）
- **THEN** 该球员不被选中（否则会以 `to`/`carrier`/`subject` 身份重新进入比赛）

#### Scenario: 某队外场全部罚下时选择器仍为全函数
- **GIVEN** 某队 10 名外场全部被罚下（每队最多 10 张红牌；门将不产犯规故恒不被罚下）
- **WHEN** 引擎调用抢断者/传球目标/开球者/最近队友选择器
- **THEN** 选择器不 panic、不返回罚下球员，回退到恒未被罚下的门将（`nearest_in_team` 回退 home 0 / away 21，不返回无效 id -1）

#### Scenario: 向前传球目标退化态回退门将
- **GIVEN** 某队外场球员全部被罚下，且仅存球员持球需向前传球推进
- **WHEN** 引擎调用 `emit_forward_pass_highlight` 选择向前传球目标
- **THEN** 回退该队门将（`to != from`），不返回无效 id（-1），不越界

#### Scenario: 任意球追逐者退化态回退门将
- **GIVEN** 两队外场球员全部被罚下
- **WHEN** 引擎调用 `nearest_any` 选择松散球追逐者
- **THEN** 回退 home 门将 0，不返回无效 id（-1），不越界

### Requirement: 主场优势（主客进球不对称，L1）

引擎 SHALL 使主队进球系统性多于客队，主客进球不对称对齐真实方向。主场优势通过**两个落在单点判定上的微差通道**实现（均只改比较阈值、不增/减确定性 RNG 消费，同 seed 同流，且不挤压其他 L1 带的合并统计口径）：机会把握——射门/头球 result 判定中主队 goal 窗口上移（`CLINICAL_GOAL_PP_HOME`）、客队不压；二点争顶——角球 battle 攻方胜率攻方为主队时高于攻方为客队时。**#104 起**：射门体量已抬到真实量级（见「射门与抢断的体量带」requirement），故本条的**绝对量带随之重标**——原带 `[0.38, 0.75]` 的注释「体积只允许轻微浮动，防总量暴涨/崩塌」是**按压缩态标定的**。**方向语义（主队多于客队、客队不被机械压低）不变**。验证 SHALL 按三层拆分：机制测试（系数方向，纯函数断言）、短窗口 sanity（方向检查 + 重标后的绝对量带）、长期校准（ratio 点估计 + 置信区间，report-only）。

#### Scenario: 主队进球多于客队（L1 短窗口方向 sanity）
- **GIVEN** 引擎以 ≥600 个 seed × 90 分钟模拟（预注册冻结窗口）
- **THEN** 主队进球/场 SHALL ∈ **[0.85, 1.60]** 且主队进球 SHALL > 客队进球
  （方向检查，非 ratio ≥ 1.08 的精细下界——真实主客比 ~1.25，但引擎体积压缩下真实效应 ~1.11，600 场无法可靠分辨 1.08 vs 1.11，需数万场）
- **AND** 客队进球/场 SHALL ≥ 0.30（主队优势不得机械压低客队——客队进球不被宏观系数压缩）
- **AND** 新带的容差 SHALL 与原带保持同一**相对**比例（原带中心 0.565、半宽 0.185，两翼各 ±32.74%；
  套到**引擎实测新中心 1.188**（600 seed 401..1000）→ `[0.80, 1.58]`，取整沿用拍板值 `[0.85, 1.60]`）。
  ⚠️ 本带用**「原带相对容差保留法」**，SHALL NOT 被说成 §D5 三条带那种「真实侧分布推导」——
  两者方法不同，必须分开陈述（1.22 是**真实侧客队**锚点，与本带无关）

#### Scenario: 机会把握主客平移
- **GIVEN** 一次射门/头球判定且射门方为主队
- **THEN** result goal 判定阈值 = 分桶声明概率 + `CLINICAL_GOAL_PP_HOME`（主队把握略高）；saved 窗口宽 SHALL 不变（门将扑救表现不随主客变化）
- **AND** 射门方为客队时阈值 = 分桶声明概率（客队不被压低）

#### Scenario: 角球二点争顶主客不对称
- **GIVEN** 一次角球 battle 争抢（攻方 chaser 到落点）
- **THEN** 攻方为主队时胜率 = `BATTLE_ATTACK_WIN_HOME`%、攻方为客队时 = `BATTLE_ATTACK_WIN_AWAY`%（攻/防基线 55/45；home 攻 58、home 守 100−52=48，各 +3pp）且主队方向不弱于客队

#### Scenario: 长期校准报告
- **GIVEN** 长期校准测试（report-only）
- **THEN** 输出主客进球 H/A 点估计 + log(H/A) 95% 置信区间，SHALL 不设 ratio 硬门（精确校准需数万场，600 场仅作可重复的观察报告）

### Requirement: 传球可失败（拦截 / 传失）

引擎 SHALL 使有向传球存在失败分支，整体传球成功率对齐真实带。普通传球（槽位 + 过渡传球）判定顺序：出界（仅槽位传球）→ 拦截 → 传失 → 成功，全部用引擎确定性 RNG。`result` SHALL 为：`success`（成功）、`intercepted`（对方断下，事件带 `interceptor`）、`lost`（失准，球到落点变松散球）。

#### Scenario: 拦截
- **GIVEN** 一条传球落点附近有对方球员（压力分档：贴防 ≤6m / 中距 ≤12m / 更远）
- **THEN** 该传球以分档概率被拦截，事件 `result=intercepted` 且携带 `interceptor`；球权切到拦截方（拦截点松散球）

#### Scenario: 传失
- **GIVEN** 一条有向传球未被拦截
- **THEN** 该传球以固定概率失准，事件 `result=lost`，落点进入松散球（双方可争，不直接丢球权）

#### Scenario: 传球成功率带（L1）
- **GIVEN** 引擎以 ≥200 个 seed × 90 分钟模拟
- **THEN** 整体传球成功率（成功传球 / 全部 pass 事件，含发球重开分母）SHALL ∈ [82%, 90%]（真实队级 78.7-90.6%，FotMob 2024/25；目标中心 ~87%）

### Requirement: 事件坐标归一化

引擎 SHALL 用球场归一化坐标（0-1，x 左门线→右门线，y 下边线→上边线）表示事件位置。

#### Scenario: 坐标在 0-1 范围
- **WHEN** 引擎产出一条带位置的事件
- **THEN** 事件坐标 x、y（及 x2、y2）均在 0-1 范围内

### Requirement: 抢断触发决策（距离感知 + 抢断积极性）

引擎 SHALL 不固定概率必抢，而是由防守者基于情境（几何 + 冷却）自行判断是否抢断：每个防守机会点对候选防守者按统一防守动作打分选中抢断时才产 `tackle`。抢断的**资格与倾向**完全由打分阶段判定（`select_defensive_action`），取代旧的「贴身阈值 + 抢断积极性低概率掷定」二元判定：超出就近阈值（约 12m）的防守者无任何防守动作资格（不产 tackle/contain/jockey）；距离越近（`closeness`）、越正面（`approach`）→ 抢断分越高；身后回追（`bad_angle`）→ 抢断分被压低（犯规由此接管）。判据为引擎内常量 + 几何/冷却量，`SHALL NOT` 消耗 RNG 决定「是否去抢」。

#### Scenario: 就近防守
- **GIVEN** 一个防守机会点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（约 12m）时无防守动作（不产 tackle，也不产 contain/jockey）

#### Scenario: 超阈值落回进攻
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle，该次机会落回 pass/dribble/shot（当作普通进攻事件处理）

#### Scenario: 抢断积极性
- **GIVEN** 最近防守者距离 ≤ 阈值
- **THEN** 由 `select_defensive_action` 对 tackle/foul/contain/jockey 四类 score 取最高决定是否抢断——贴身（closeness）且正面（approach）时抢断分最高而胜出，中距时 contain/jockey 胜出，近身但失位（bad_angle）时犯规胜出；**不再消耗 RNG 掷定「是否去抢」**（旧「抢断积极性低概率掷定」已被打分取代）

#### Scenario: 抢断频率目标
- **WHEN** 一整场比赛（2700s / 5400s）模拟
- **THEN** tackle 事件总数由开放比赛的防守机会点数量与几何分布**涌现**（不再由槽位数量或固定积极性概率决定），且与比赛时长同向缩放（长比赛机会点多 → 抢断多）；90min 场均落在经验体量带 [2,15]

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）；只有这两态，不再有 `same_pair`/`far` 的第三种成功率档

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者（防守者随后争抢弹开的松散球 `loose_x/loose_y`）；抢断者与被抢者结算到分离终点 `(subject_end, carrier_end)`——两球员间距 ≥ 最小间隔（约 0.03，观感不重合），下一事件不 snap

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，被抢者留接触点继续持球；抢断者停在被抢者外侧 `(subject_end)`——两球员间距 ≥ 最小间隔（约 0.03，不贴身），下一事件不 snap

### Requirement: 抢断事件携带完整坐标语义

tackle 事件 SHALL 携带：防守者起点 `x/y`、被铲者带球起点 `carrier_from_x/carrier_from_y`、接触点 `x2/y2`、弹开点 `loose_x/loose_y`、抢断结算终点 `subject_end_x/subject_end_y` 与 `carrier_end_x/carrier_end_y`。

#### Scenario: 带球起点
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` 等于被铲者（持球者）上一位置，`x2/y2` 等于被铲者当前位置（接触点）

#### Scenario: 弹开点（success/fail 都发）
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `loose_x/loose_y` 为确定性弹开点：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化——与画面层 `deflectPoint` 同规则；success 与 fail 均携带

#### Scenario: 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** tackle 事件的选择、结果、弹开点全部一致

### Requirement: 引擎统计分布符合声明概率（L1 规格一致性）

引擎 SHALL 把硬编码概率实现为事件流的统计分布；多 seed（≥200）聚合后，观测比例 SHALL 落在声明的容忍带内。射门结果概率 SHALL 按起脚位置三桶（禁区内 / 禁区弧 / 远射）。

#### Scenario: 禁区内射门结果分布
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟，且起脚点在禁区内（≤ 16.5m）
- **THEN** 禁区内普通射门（无 `detail` 字段）的 result 比例 SHALL 落在：goal ∈ [10%, 20%]、saved ∈ [24%, 36%]、off_target ∈ [48%, 60%]（声明 15/30/55，校准带）

#### Scenario: 禁区弧射门结果分布
- **GIVEN** 引擎以 200 个 seed 模拟，且起脚点在禁区弧（16.5-25m）
- **THEN** 禁区弧普通射门的 result 比例 SHALL 落在：goal ∈ [3%, 12%]、saved ∈ [14%, 30%]、off_target ∈ [61%, 75%]（声明 7/22/71，对齐真实禁区弧 xG 5-10%）

#### Scenario: 远射结果分布
- **GIVEN** 引擎以 200 个 seed 模拟，且起脚点在 25m 外
- **THEN** 远射普通射门的 result 比例 SHALL 落在：goal ∈ [0%, 8%]、saved ∈ [4%, 18%]、off_target ∈ [78%, 92%]（声明 4/11/85，对齐真实禁区外转化 ~4.2%）

#### Scenario: 头球射门结果分布
- **GIVEN** 引擎以多 seed 模拟且聚合到足够头球射门（`detail:"header"`，全部在禁区）
- **THEN** 头球射门 result 分布 SHALL 通过 chi-square 拟合优度（声明 15/30/55，df=2，chi-sq < 13.82 即 α=0.001）——头球全在禁区，对齐禁区内桶

### Requirement: 事件流过程真实性不变量（L2）

引擎 SHALL 使事件流满足以下跨事件不变量，任意 seed 都成立。

#### Scenario: 比分与进球计数一致
- **WHEN** 引擎产出一场完整比赛
- **THEN** whistle 事件 score（`"{home}-{away}"`）SHALL 精确等于事件流中 shot[result="goal"] 的计数

#### Scenario: 射门落点在球门矩形内
- **WHEN** 引擎产出一条 shot 事件
- **THEN** goal/saved 的 y2 SHALL ∈ [0.455, 0.545]，x2 SHALL = 攻方门线（home 射 0.98 / away 射 0.02）；off_target 的 y2 SHALL ∈ [0.40, 0.445] ∪ [0.555, 0.60]（贴柱偏出）

#### Scenario: beat 节拍固定
- **WHEN** 引擎产出 beat 事件序列
- **THEN** 相邻 beat 的 t 差 SHALL ∈ {1.0, 2.0} ± 0.001（1.0 = 每 tick 一拍；2.0 出现在重开准备 tick——角球/界外球判定 tick 与进球后 kickoff 发球 tick 均不产 beat），且任意相邻 beat 间隙 ≤ 2.0

#### Scenario: 速度不超物理量
- **WHEN** 引擎产出带 speed 的事件
- **THEN** 普通射门 speed ∈ [22, 30)；头球射门 speed ∈ [15, 20)；pass 事件 speed ∈ [10, 25)；beat main.speed ≤ 5.1；beat mover.speed ≤ 8.1（重开走位 8 m/s 例外上限）

#### Scenario: 门将贴门线
- **WHEN** 引擎产出 shot 事件
- **THEN** keeper_x SHALL < 0.15 或 > 0.85（门将不离开门线区域）

#### Scenario: 事件时间范围
- **WHEN** 引擎产出一场时长 dur 的比赛
- **THEN** 全部事件 t SHALL ∈ [-0.001, dur+0.001]

#### Scenario: 罚下球员零参与
- **WHEN** 从事件流中 `foul[card=red]` 重建罚下集合并扫描其后所有事件
- **THEN** 罚下球员不得出现在任何事件的 `subject` / `movers[].id` / `carrier` / `interceptor` / `to` 中，违例计为零

#### Scenario: L2 门覆盖红牌派生路径
- **GIVEN** 罚下球员参与的违例只在少数 seed 出现（红牌约 1/6 场）
- **WHEN** 用窄 seed 窗口（如 15）运行 L2
- **THEN** 门可能在实际被违反时仍全绿（假绿）；故 seed 覆盖 SHALL ≥ 300（实测最早出现该路径的 seed 为 260），且开球者与接球者 SHALL 不同一人（自传退化）

### Requirement: 确定性 golden master 防漂移

引擎 SHALL 使 10 个 canary seed（1..=10）的整场事件流可复现为提交的 golden 基线；任何改动导致的流差异 SHALL 使测试失败。统计层未覆盖的概率（扑出 caught/rebound 40/60、槽位 corner/throw_in/pass 比例、出界率等）SHALL 由 golden master 全流哈希守护。

#### Scenario: canary seed 全流比对
- **WHEN** 测试对 seed 1..=10 各模拟一场并计算统计摘要 + 事件流哈希
- **THEN** 结果 SHALL 与 `engine/tests/golden/seed-<n>.json` 完全一致

#### Scenario: 显式重基线
- **WHEN** 设置环境变量 `ACCEPT_GOLDEN=1` 运行 golden 测试
- **THEN** 测试 SHALL 覆盖写当前结果为新基线（打印待审查提示，供人工审查 git diff 后提交），而非失败

### Requirement: 射门起脚位置分布（L1）

引擎 SHALL 使射门起脚位置对齐真实分布：禁区内（≤ 16.5m）射门占比 SHALL ∈ [45%, 65%]，且无距对方球门 > 45m 的射门（消除自家半场/中圈远射）。

#### Scenario: 禁区内射门占比
- **GIVEN** 引擎以 200 个 seed 模拟
- **THEN** 禁区内起脚射门数 / 总射门数 SHALL ∈ [45%, 65%]（真实 ~55-58%）

#### Scenario: 无自家半场射门
- **GIVEN** 引擎产出一条 shot 事件
- **THEN** 起脚点距对方球门 SHALL ≤ 45m（归一化：home 攻 x ≥ 0.571 / away 攻 x ≤ 0.429）

### Requirement: 射门与抢断的体量带（L1 体积，真实量级）

引擎 SHALL 使普通射门与抢断的**绝对体量**对齐真实联赛量级（多 seed ≥200 聚合）。
本 requirement 取代先前隐含在 `l1_shot_result_distributions` / `l1_tackle_dilution_and_slot_mix`
里的**压缩态体量带**（原射门带 `[6,11]`、原单场角球上界 `12`）——那些带的语义是
「引擎无二次进攻链，射门设计上低于真实」，该前提已被 #104 证伪（射门体量只是一个可调常量）。

**带的推导 SHALL 来自真实侧分布，SHALL NOT 照引擎现状配**（「按现状标定」是本 requirement 要消除的对象）。
推导口径：真实侧样本按 90 分钟归一、**逐场算再平均**，带 = `mean ± 1.5·sd`。

体量 SHALL 由**既有常量**产生（射门频率 `OPEN_PLAY_SHOT_ENGAGE_SHIFT`、抢断倾向
`BASE_DEF_TACKLE`、犯规倾向 `BASE_DEF_FOUL`），SHALL NOT 依赖任何事件类型配额或固定节拍；
抢断的抬升 SHALL 与射门一起做（`volume-compensation.md` §2.4：体积是一组缺口，
只抬射门会让 shot/tackle 越界）。

#### Scenario: 普通射门体量
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟（seeds 401..600）
- **THEN** 普通射门（非头球）`shot` 事件 / 场 SHALL ∈ **[14, 29]**
  （推导：StatsBomb Open Data 大五联赛子集 n=170，mean **21.64** / sd **5.03**，`mean ± 1.5·sd` = [14.09, 29.18]）
- **AND** 引擎当前读数 **17.10** 落在带**下沿**（距下界 3.1）——这是**如实结果**，
  SHALL NOT 为让它居中而下压带的界

#### Scenario: 抢断体量
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟
- **THEN** `tackle` 事件 / 场 SHALL ∈ **[24, 50]**
  （推导：同上的大五子集 n=170，`Duel` 中 `type=="Tackle"`，mean **36.90** / sd **8.87**，`mean ± 1.5·sd` = [23.60, 50.21]）
- **AND** 口径对齐：StatsBomb `Duel/Tackle` 含**成功与失败两态**（`Success In Play`/`Success Out`/`Lost In Play`/`Lost Out`），
  与引擎 `tackle` 事件（`TACKLE_SUCCESS_RATE=0.5`，两态）**同口径**；
  WhoScored 的「~30（15-17/队）」是**成功抢断**口径，SHALL NOT 作为本带的依据

#### Scenario: 单场角球上界（数量级护栏）
- **GIVEN** 引擎以 **200** 个 seed × 90 分钟模拟（seeds 401..600，与 `l1_tackle_dilution_and_slot_mix`
  的 L1 窗口一致——这是**运行时门的口径**）
- **THEN** 单场 `detail="corner"` 的 pass 计数 SHALL ≤ **15**
  （实测 max：干净 main **9** / 本 change **13**）
- **AND** 上界值 15 由 **3000** 个 seed 的极值分析定（上界是**极值统计量**，200 场的 max 系统性低估：
  干净 main 200 场 max=9 但 3000 场 max=**12**）；运行时门因 L1 窗口固定为 200 seed 而按 200 seed 评估，
  两口径实测 max 均 ≤15（本 change 3000 场 max = 13）
- **AND** 本上界的语义 SHALL 是「不塌缩 / 不爆炸」的**数量级护栏**，SHALL NOT 被当作真实拟合
  （真实角球均值 ~10/场，引擎 3.44 仍远低于真实）
- ⚠️ **余量很薄，如实记录**：干净 main 自己就已 max=12（对原界 `≤12` 余量 0），
  故任何抬高事件量的方案都会顶到这条界

#### Scenario: 体积抬升不引入崩溃
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟
- **THEN** `crashedSeeds` SHALL = 0

### Requirement: 防守动作体量的机制守卫（默认测试套件）

引擎 SHALL 使**抢断频率**与**犯规的打分选出条件**在默认 `cargo test` 套件里被守卫，
且守卫的断言口径 SHALL 与当前引擎机制一致（SHALL NOT 保留已被删除机制的遗留配额带）。

#### Scenario: 抢断频率体量
- **GIVEN** 引擎以多 seed × 90 分钟模拟
- **THEN** 场均 `tackle` SHALL 落在按当前机制（防守接触竞争涌现，非槽位配额）标定的体量带内。
  ⚠️ **原断言 `[3,14]` 是 P7 槽位时代的遗留**（其注释自写「应 ~7 槽/场」，而槽位层 P31 已删），
  在抢断涌现到 ~30/场后**语义已死**；本 change SHALL 以**机制正确的体量/方向断言**取代它，
  SHALL NOT 仅放宽上界以让其通过

#### Scenario: 犯规取消射门机制的几何前提
- **GIVEN** 引擎构造一个「防守者贴身且在持球者身后」的起脚窗口几何
- **THEN** 该几何 SHALL 由 `select_defensive_action` 选出 `Foul`（测试的前置断言），
  且被犯规的窗口 tick SHALL NOT 产 `Shot`。防守打分基线变更后 SHALL 重构造几何使前提重新成立，
  SHALL NOT 删除前置断言或放宽结算断言

### Requirement: 射门槽频率（L1）

引擎 SHALL 使普通射门与抢断两类核心事件的数量级相当（防某一类塌缩/爆炸）。**P30 起语义更新**：射门由 hazard 涌现（2B，非槽强制）、抢断由防守接触竞争涌现（2C，非槽强制），两者的比值不再由槽位配额决定。**P31（D6）起**：删槽位后防守竞争在每个自然 deadline 机会点评估（~994 机会点/场）且 liveness 出球档使 pass 候选近乎翻倍 → 抢断实测 9.29/场（P30 基线 5.60）；射门实测 7.95/场 → 比值重新标定为 [0.5, 1.5]。**#104 起**：射门与抢断**一起**抬到真实量级（17.10 / 30.38），比值 0.563 —— **本带不因 #104 改变**（只抬射门会让比值到 1.925，正是本带挡住的那类改动）。此带为「两类涌现事件量级相当」的经验体量带，SHALL NOT 退化为配额断言。

#### Scenario: 射门槽占比
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** 普通射门事件总数 / tackle 事件总数 SHALL ∈ [0.5, 1.5]（P31 实测 0.855；**#104 实测 0.563**；真实比赛射门 ~13/场、抢断 ~25/场 → ~0.52。旧带 [1.0,1.8] 是槽位配额 35%/22%≈1.59 的产物，偏虚高）

### Requirement: 射门比率对齐真实（L3 参考带，射门相关）

引擎 SHALL 使射门相关的聚合比率对齐真实联赛参考带（多 seed ≥200 聚合）。

#### Scenario: 射正率
- **THEN**（goal+saved）/ 射门 SHALL ∈ [28%, 39%]（真实 ~33%；实测 38.3%）

#### Scenario: 射门转化率
- **THEN** goal / 射门 SHALL ∈ [8%, 14%]（真实 ~10%；实测 13.1%）

#### Scenario: 禁区内进球占比
- **THEN** 禁区内进球 / 总进球 SHALL ∈ [72%, 92%]（真实 ~85%；实测 86.9%）

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级（防守中断 > 持球终结 > 持球普通 > 无事件防守 > beat）决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick），并 SHALL 受 liveness guard 的 `deadline_pressure` 缩短。机会 SHALL 在球权改变 / 死球 / 犯规 / 重开 / 持球段被打断时失效。引擎 SHALL 无任何事件类型配额或固定评估节拍——事件频率完全由状态涌现（P31：槽位时钟 / 固定评估节拍 / 事件类型配额已全删）。出界 SHALL 由**受 `pass_risk` 调制的出界通道**涌现：开放比赛普通传球按 `open_play_out_probability(pass_risk)` 判定是否出界（`pass_risk` 含传球距离 / 压迫 / liveness 加成），命中后由 `out_side_for_intended` 定方向（含「己方/对方底线」）与越界点，并按 `out_side` + 越过的是哪条底线 + 最后触球方判重开（`out_restart_for`：NormalPass+对方底线→门球、NormalPass+己方底线→角球、任一 sideline→界外球、Clearance+底线→角球）。纯函数 `sample_pass_landing`（落点 = 意图 + 确定性误差）SHALL 保留并参与落点采样。发球重开（角球/界外球/任意球/门球/头球 battle）SHALL NOT 走出界通道。

射门 SHALL 由 hazard 五因子打分**涌现**（非槽强制、非「到射程即射」）：`score = base_tendency + gain * (distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty)`（`gain` 是标定常数，把因子和映射到 hazard 的 log 尺度；见 design/`.p29-progress.md`），`hazard = exp(score)`，`p_shot = 1 - exp(-hazard * window)`。距离因子 SHALL 分段复用射门分桶边界（6-16.5m→0.9-1.0、16.5-25m→0.45-0.9、25-35m→0.05-0.45、>35m→0-0.05）；`angle_quality = clamp01(cos(angle_to_goal_center).max(0))`，背向球门（`cos ≤ 0`）SHALL 禁止 Shoot 候选；`space_available = 0.65*nearest + 0.35*second`（≤2m→0、2-8m 线性、≥8m→1）；`cooldown_penalty` SHALL 源自**局部**冷却倒计时（射门后重置、每 tick 衰减），SHALL NOT 读「本场已射多少次」。

`shot_setup` SHALL 为两相状态机：**推进相**向球门带球（最后一步精确落到 `target_dist`），到达射程或步数耗尽 → **起脚窗口**（`committed=false`），窗口内每 tick 由 hazard 判定射 / 转（放弃射门继续带球）/ 被抢断。`committed=true`（hazard 判定射门）后 SHALL 立即产 Shot 事件且**不可回溯**（防守者不再把已提交的射门改写为 tackle）。射门 SHALL 有**唯一生产者**：普通 `shot` 事件只由起脚窗口的 hazard 提交产生。

防守侧 SHALL 由**统一防守动作竞争**选择（P30/#25 阶段 2C）：在每个防守机会点，对候选防守者按 `score_tackle = base + closeness + approach - cooldown - bad_angle`、`score_foul = base + danger + closeness - yellow_penalty - foul_cooldown`（仅禁区外 + 贴身 + 全局犯规冷却已过）、`score_contain = base + pressure_without_contact`、`score_jockey = base + distance_fit` 算出四个 score，取最高分对应**一个** `DefensiveAction`（抢断 / 犯规 / 封堵 / 跟防 / 无），每个机会点**只选一个**（不既抢又犯）。防守动作打分 SHALL 为纯函数（几何 + 局部冷却进、score 出，零 RNG）。抢断/犯规 SHALL 用**三层 cooldown**（defender 级 `tackle_cooldown` / pair 级 `last_contact_pair` + 接触年龄 / 全局 `foul_cooldown_ticks`）取代补丁式成功率修正（`same_pair` / `far`），cooldown 只降低对应 score、SHALL NOT 直接禁止事件。抢断结果 SHALL 只有 `success` / `fail` 两态（`TACKLE_SUCCESS_RATE` 掷定）。犯规 SHALL 并入同一竞争（与抢断同窗口选择，取代独立的 `maybe_open_foul` 判定）。封堵 / 跟防 SHALL 不产事件，只更新持球者压力状态（供射门 hazard 的 `defensive_pressure` 因子读）。

liveness guard SHALL 为**三层递进**的非事件型护栏：以 `ticks_since_meaningful_action` 为唯一输入，停滞 8/12/16s 逐档调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，**且 SHALL 在停滞达二档且持球者无压时使持球决策选择「出球」候选**。guard 本身 SHALL NOT 直接生成事件——事件仍由既有传球 / 射门生产者产出。meaningful action = 射门 / 传球（含发球重开、拦截、传失）/ 抢断 / 犯规 / 球权变化 / 出界重开 / 松散球拾取；普通带球 beat、contain/jockey、单纯跑位 SHALL NOT 重置计时。

#### Scenario: deadline 到期开启行动机会
- **GIVEN** 开放比赛中一个持球段，`deadline_ticks` 到期
- **WHEN** 引擎 tick 推进
- **THEN** 开启一次行动机会（`OpportunityTrigger::NaturalDeadline`），评估持球者/防守者行动

#### Scenario: 无事件类型配额
- **GIVEN** 引擎模拟一场比赛
- **THEN** 不存在 `HIGHLIGHTS_PER_MATCH` / `roll_fallback_situation` / `FallbackSituation` 按固定比例决定事件类型；射门/抢断/犯规/传球频率由状态涌现

#### Scenario: deadline 按几何量计算
- **GIVEN** 持球者接近对方球门且受压
- **WHEN** 计算 `deadline_ticks`
- **THEN** deadline 短于后场无压持球（危险度/压迫降低 deadline，出球空间提高 deadline），且在 [3,12] 内

#### Scenario: 机会在持球段边界失效
- **GIVEN** 一个存活的行动机会，随后球权改变 / 进入死球 / 犯规 / 重开 / 持球段被打断
- **WHEN** 引擎 tick 推进
- **THEN** 该机会失效，不在新的持球段里被沿用

#### Scenario: 射门由 hazard 涌现
- **GIVEN** 持球者推进到射程、进入起脚窗口
- **WHEN** 计算 hazard 打分
- **THEN** 近门/正对球门/无压时 `p_shot` 高；远射/边路/贴身时低；射门不再由槽位强制产生，也不再「到射程即射」

#### Scenario: 起脚窗口内可被抢断
- **GIVEN** 持球者进入起脚窗口（`committed=false`）
- **WHEN** 防守者抢断
- **THEN** 射门序列取消（`shot_setup` 清空，内部 canceled），产 tackle 事件，**不产 Shot 事件**；抢断成功时球进入松散球（`TackleSuccess`），抢断失败时球留在原持球者（`TackleFail`）——成败都取消射门序列

#### Scenario: committed 后不可回溯
- **GIVEN** 持球者 hazard 判定射门（`committed=true`）
- **WHEN** 产 Shot 事件
- **THEN** 该 Shot 不可被抢断回溯（防守者不再把它改成 tackle）

#### Scenario: 到射程不立即射
- **GIVEN** 持球者推进到 `target_dist` 之内
- **WHEN** 引擎 tick 推进
- **THEN** 进入起脚窗口（本 tick 只带球一拍、不产 Shot），射门与否由窗口内 hazard 判定

#### Scenario: 防守动作打分选一
- **GIVEN** 一个防守机会点，贴身防守者
- **WHEN** 计算 tackle / foul / contain / jockey 四类 score
- **THEN** 取最高分对应防守动作，每个机会点只选一个（不既抢又犯）；打分为纯函数、零 RNG

#### Scenario: 三层 cooldown 取代 same_pair/far
- **GIVEN** 同一防守者（defender 级冷却内）或同一接触对（pair 级冷却内）
- **WHEN** 计算防守动作 score
- **THEN** 对应 score 降低（冷却到期后恢复），不再用「连续同对强制失败」的补丁；抢断结果只有 success/fail 两态

#### Scenario: 犯规并入防守竞争
- **GIVEN** 一个防守机会点，禁区外、贴身、全局犯规冷却已过
- **WHEN** 计算防守动作 score
- **THEN** 犯规与抢断在同一竞争里被选出（每个机会点至多一个防守中断事件，不会既抢又犯）；吃黄球员的犯规 score 被折扣

#### Scenario: contain/jockey 只调状态
- **GIVEN** 防守动作结算为 contain 或 jockey
- **WHEN** 更新引擎状态
- **THEN** 不产事件，只更新持球者压力状态（供射门 hazard 的 `defensive_pressure` 因子读）

#### Scenario: 出界由 pass_risk 调制通道涌现
- **GIVEN** 一条开放比赛普通传球
- **WHEN** 引擎判定出界
- **THEN** 由 `open_play_out_probability(pass_risk)` 通道决定是否出界、`out_side_for_intended` 定方向与「己方/对方底线」，且按 `out_side` + `own_goal_line` + 最后触球方判重开（NormalPass+对方底线→门球、NormalPass+己方底线→角球、任意 sideline→界外球、Clearance+底线→角球）；`out_pos` 记真实越界值、`x2/y2` 记场内投影；发球重开不走出界通道

#### Scenario: 落点误差纯函数保留
- **GIVEN** 一次传球落点采样
- **WHEN** 计算 `sample_pass_landing(from, intended, pass_risk, rng)`
- **THEN** 返回 `raw`（意图 + 确定性误差，可越界）、`projected`（钳回 [0,1]²）与 `out_side`；同 seed 同结果

#### Scenario: liveness guard 非事件型
- **GIVEN** 比赛停滞（无 meaningful action）达 8/12/16s
- **WHEN** liveness guard 逐档生效
- **THEN** 只调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，不直接调用事件生成函数

#### Scenario: 无压久持由持球决策出球
- **GIVEN** 持球者在无压迫下停滞达 `LIVENESS_STAGE_2_TICKS`
- **WHEN** 引擎评估开放比赛持球行动
- **THEN** 持球决策选择「出球」候选（普通传球），事件仍由既有 `emit_pass_highlight_inner` 产出；guard 本身不 emit

#### Scenario: 5 分钟统计方向性
- **GIVEN** 引擎以 ≥1000 场 5 分钟（300s）比赛聚合
- **THEN** 累计射门 > 0、重开（角球+界外球+门球）> 0、犯规在宽带内、进球 ≥ 0；不存在「5分钟事件量 ≥ 90分钟的固定比例」断言

### Requirement: 涌现频率带的经验体量守卫

删槽位后事件频率由状态涌现，各类事件的经验体量带 SHALL 按**涌现实测值**重新标定并记录依据（原槽位配额是虚高来源，SHALL NOT 作为频率目标）；带 SHALL 只守「某类事件塌缩/爆炸」，SHALL NOT 退化为配额断言。方向性（而非固定数量）的断言 SHALL 优先。

#### Scenario: 出界通道承重守卫
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** 场均界外球（`detail="out_sideline"`，由 pass_risk 出界通道产出的界外球重开）SHALL 落在声明带内——该带是出界通道的**承重守卫**（通道失效时界外球由 8.74/场 崩至 ~0.06/场）

#### Scenario: 角球派生带按涌现重标定
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** `detail="corner"` 的 pass 场均 SHALL 落在按涌现实测值重标定后的带内（原 12% 角球槽来源已删，实测 3.71 → 1.98，不作为频率目标）

### Requirement: 拦截概率自洽硬门（L1 规格一致性的拦截分支）

引擎 SHALL 在开放比赛拦截判定点记账进入拦截 roll 的传球样本数、逐距离桶的预期拦截数与实际拦截数，并由引擎原生测试断言「实际拦截数落在预期拦截数的统计置信区间内」。预期拦截数 SHALL 按整数 roll 命中宽度累加（`ceil(interception_p)`，例如 `interception_p=7.5` → 记 8，不是 7.5），不得拿浮点概率常量直接除以 100。该记账 SHALL NOT 消耗额外 RNG、SHALL NOT 改变事件流（`golden-v5` 不变）。

#### Scenario: 记账点精确覆盖开放比赛拦截分母
- **GIVEN** 引擎产出一场完整比赛
- **THEN** 拦截记账样本数 > 0、实际拦截数 > 0；向前推进传球（`emit_forward_pass_highlight`）与重开传球（角球/界外球/任意球/门球）不进入记账分母（它们不走该判定点）

#### Scenario: 逐桶自洽
- **GIVEN** 引擎以多 seed 模拟，拦截样本按落点距离分桶（≤6m / 6-12m / >12m）
- **THEN** 每个主要桶的实际拦截数落在预期拦截数的 95% 置信区间内；样本不足（< 200）的桶记 `insufficient_sample` 而非失败

#### Scenario: 长传加成接线
- **GIVEN** 拦截样本按传球距离分层（>22m、>35m）
- **THEN** 同距离桶内长传层预期拦截宽度高于非长传层，且实际拦截数与预期自洽（守护 `LONG_PASS_INTERCEPT_BONUS` / `VERY_LONG_PASS_INTERCEPT_BONUS` 不被误删——逐常量杀死，防互相遮蔽）

#### Scenario: 拦截概率 cap 的整数 roll 量化
- **GIVEN** 合成概率输入 `interception_p = 60.0`（cap 值；真实开放比赛传球的档位上界是 22.5 = 贴防 7.5 + 长传 7 + 超长 8，`cap` 是防御性上限、生产上不可达）
- **THEN** 预期拦截数记 60（整数 roll 命中宽度 `ceil`），不因浮点漂移破坏自洽

#### Scenario: 事件流不变
- **WHEN** 加入拦截记账后运行 golden canary seed
- **THEN** 事件流哈希与 `engine/tests/golden-v5` 完全一致（记账只写内部 tally，不进事件流、不调 RNG）

### Requirement: 同队球员间距（≥2m）

引擎 SHALL 使同队两球员在引擎发射的任意位置采样点（lineup 初始站位、mover 终点 `to_x/to_y`、main 终点 `x2/y2`、以及模拟状态位置 `st.pos`）上的**米制**间距 ≥ 2m（阈值常量 `SAME_TEAM_MIN_DIST_M` = 2.2m，含 JSON 4 位小数序列化与 0.5s 采样插值的安全余量）。间距 SHALL 用真实米制几何计算（x 方向 × 105、y 方向 × 68），SHALL NOT 用归一化欧氏距离（归一化圆在 105×68 球场上 x 方向 2.1m、y 方向仅 1.36m）。分离 SHALL 覆盖 carrier、门将、特殊站位（角球包抄 / close_down / chase / anticipate）与 dead_zone 停者；由事件直接指定的终点（传球接球点 / 门将扑救点 / 抢断结算点 / 开球落点 / 松散球拾取点）SHALL 在写入状态前经同一分离。分离 SHALL 为纯函数：零额外 RNG、固定遍历顺序、不改变事件类型/频率的判定逻辑。拍内插值中点 SHALL 由 viewer 侧 `player_overlap` detector 观测（不在引擎预计算每段中点推开）。

#### Scenario: 整场无同队重叠
- **GIVEN** 引擎以多 seed 模拟整场比赛
- **THEN** 每个 tick 的同队两两米制距离 SHALL ≥ `SAME_TEAM_MIN_DIST_M - ε`（ε 为浮点容差）；lineup 初始站位、mover 终点、main 终点均满足

#### Scenario: 米制口径
- **GIVEN** 两个归一化坐标点，其归一化欧氏距离相同但轴向不同
- **THEN** 引擎按 x×105 / y×68 的真实米制距离判定是否 < 2m，而非归一化欧氏距离（y 方向 0.02 归一化 = 1.36m < 2m，须被分离；x 方向 0.02 归一化 = 2.1m ≥ 2m，不强制分离）

#### Scenario: carrier 参与分离
- **GIVEN** carrier 带球推进逼近同队队友至 <2m
- **THEN** 分离后 carrier 与队友米制间距 ≥ 2m，且 `main.x2/y2`、`st.pos[carrier]`、`ball_pos`、`carrier_from`、`last_emitted[carrier]` 全部与分离后终点一致（`main.x/y` 保留起点）

#### Scenario: 特殊站位兜底
- **GIVEN** 角球包抄 / close_down / chase / anticipate 目标使同队球员 <2m
- **THEN** 最终分离仍使同队间距 ≥ 2m，且不重选目标、不重抽 RNG、保留 action 标签

#### Scenario: 拍内扫掠（viewer 插值口径）
- **GIVEN** 两名同队球员某一拍的线性轨迹（`from`→`to`，viewer 在锚点间线性插值）在中途 <2m
- **THEN** 引擎 SHALL 对整条轨迹施加约束（侧向推移终点），使中点间距亦 ≥ 2m − 舍入余量；推移量 SHALL 有界（≤ 该球员本拍步长），超限时留给下一拍而非横甩

#### Scenario: 分离位移有界
- **GIVEN** 引擎产出的任一 beat
- **THEN** 每个 mover 的单拍位移 SHALL ≤ 其 `speed × 1s` + `SAME_TEAM_MIN_DIST_M`（多轮扫掠的累积有界，不得横穿球场）

#### Scenario: 零 RNG 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** 事件流（含分离后的坐标）完全一致（由 golden master 全流哈希守护）

#### Scenario: 跨队不适用
- **GIVEN** 抢断瞬间防守者与被抢者（跨队）结算到 `subject_end/carrier_end`
- **THEN** 该跨队分离 SHALL NOT 受同队 2m 约束（同队间距只作用于同队 pair）

#### Scenario: 状态与事件一致
- **GIVEN** 任一 tick 结束
- **THEN** 每名未罚下球员的 `st.pos` SHALL 等于其最近一次发射位置（`last_emitted`），不得出现状态与 viewer 所见错位

### Requirement: 射门打偏走门球（goal kick）

引擎 SHALL 在射门打偏（off_target）后走门球重开：球到对方守门员脚下（瞬移），对方门将开大脚到中场，落点进入松散球（双方可争），拾取后恢复开放比赛。

#### Scenario: 打偏后球到对方门将
- **GIVEN** 一次射门 result=off_target
- **THEN** 球位置 = 对方门将位置（瞬移，不做滚动动画）；possession 切到对方（门将 = 对方门将 id）

#### Scenario: 门将开大脚到中场
- **GIVEN** 门球阶段开始
- **THEN** 对方门将从**其当前位置**（门线附近，球已瞬移过去、门将不动）开大脚：高亮事件（起点 = 门将当前位置，终点 = 中场落点，高速长球 ~16-20 m/s，带球高度 h 0.5-0.8），无明确接球者（落点是争抢点）

#### Scenario: 中场松散球双方可争
- **GIVEN** 门将开大脚球到达中场落点
- **THEN** 落点进入松散球（`nearest_any` 双方外场都可争）→ 最近者拾取 → 恢复 main → 开放比赛。**落地当 tick 若最近者已在拾取半径内则直接拾取（不产 `loose:true` 的 beat）**；否则先产 `beat.ball loose:true` 再拾取。另：门球飞行期双方各 1 名最近外场会预判跑向落点（`action=chase`）

#### Scenario: 门球不触发 transition
- **WHEN** 门球发生（球权易主）
- **THEN** 不触发 transition 窗口（首批保持简单；开大脚的高球权转换后续再定）

### Requirement: 进球后球直接回中圈

引擎 SHALL 在进球确认后让球直接回中圈（不做"从门内滚回中圈"过渡），随后按现有死球流程开球。

#### Scenario: 进球球直接回中圈
- **GIVEN** 一次射门 result=goal（球越过门线进网）
- **THEN** 进球确认后球位置直接设为中圈（死球→kickoff 瞬移例外）；开球者（被进球方前锋）走向中圈开球（现有流程保留）

### Requirement: 出界判定与重开类型

引擎 SHALL 判定球出界并按类型触发重开：**射门打偏 → 门球**（由 `p6-goal-kick-and-restart` 建立）；传球出边线 → 界外球（对方）；传球出底线 → 门球（对方门将）或角球（对方），按**越过的是哪条底线**区分；**防方头球解围出底线/出边线 → 角球/界外球（进攻方）**；射门被扑出底线 → 角球（进攻方）。出界走新高亮结局（PassOutOfPlay/CornerAward），事件的**场内投影坐标 `x2/y2` 钳制在 [0,1]**（真实越界值另存 `out_pos`，可越界），事件带 detail 表达出界类型。**出界触发由受 `pass_risk` 调制的涌现通道决定（P31：`open_play_out_probability(pass_risk)`，非固定百分比）**——重开球（角球发球/界外球掷球/门球开大脚）落点恒在界内、不走出界通道。

#### Scenario: 传球出边线 → 界外球
- **GIVEN** 一次普通传球（source=NormalPass）的落点出边线（y<0 或 y>1，由 `open_play_out_probability(pass_risk)` 通道判定）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None（无接球者），坐标钳制 [0,1]；对方掷界外球

#### Scenario: 传球出底线 → 按底线归属重开
- **GIVEN** 一次普通传球（source=NormalPass）的落点出底线（x<0 或 x>1）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；重开按 `out_restart_for` 判定——**传球方越的是对方底线 → 门球（对方门将）；越的是己方底线 → 角球（对方）**（`own_goal_line` 区分；简化不做触碰归属）

#### Scenario: 解围出底线 → 角球
- **GIVEN** 防方头球解围（pass detail=clearance）落点出底线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；**角球重开（进攻方发角球）**——解围最后触碰方明确是防守方，不走门球

#### Scenario: 解围出边线 → 界外球
- **GIVEN** 防方头球解围落点出边线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None；**界外球（进攻方掷）**

#### Scenario: 射门被扑出底线 → 角球
- **GIVEN** 一次射门被扑出（save-rebound）且**越线（`corner_roll < 90`，即 ~90% 触发；越线点 = 原射门终点 `x2/y2` 的门线前一点，场内 x≈0.02/0.98）**（home 攻 x>1 / away 攻 x<0）
- **THEN** 高亮结局 CornerAward → 角球重开（进攻方从角旗区开球）；**角旗侧由该越线点所在半场确定（仅引擎内部），事件字段坐标一律钳制 [0,1]**

### Requirement: 角球机制

引擎 SHALL 支持角球：从角旗区开长角球到禁区（pass 高亮 + 高度 h）→ 落点松散球 + 攻防双追逐 → 争抢结果（攻方基线 55/45，P33 起叠加**主场偏移**——攻方为主队 58 / 客队 52，围绕 55/45 对称）→ 攻方头球射门（55%）/摆渡（30%）/拿球（15%）、防方头球解围（70%）/解围出底线（20%，再角球）/解围出边线（10%，界外球）。

#### Scenario: 长角球发球
- **GIVEN** 一次角球
- **THEN** 从角旗区（**按出底线点 x/y 就近取角**：x>0.5 → 右角 x=1，x≤0.5 → 左角 x=0；y≥0.5 → y=1，y<0.5 → y=0）开长角球，pass 事件 detail=`corner`、to=None、h>0，落点禁区附近（**落点在发球高亮时刻选定**，pass 高亮）；**发球准备期发球者（攻方离角旗最近外场球员）走向角旗（RestartPrep，球停在角旗），到角旗后发球**

#### Scenario: 角球站位
- **GIVEN** 角球发球准备期（RestartPrep，球在角旗）
- **THEN** **全队**外场球员的目标位置改由 `corner_setup_target` 决定（角球准备期 `formation_target` 被覆盖，不参与）：攻方全队压入禁区**贴门线一侧**、防方全队退入本方禁区**前沿一侧**（同函数；两者 y 均按 id 确定性分散在 0.2-0.8）；发球者单独走向角旗区

#### Scenario: 禁区双追逐争抢
- **GIVEN** 角球落点松散球（battle 标记）
- **THEN** 攻防各 1 名追逐（攻方 chaser=LooseBall.chaser、防方 chaser=battle 元组，**loose 启动时固定**）向落点追逐；**攻方 chaser 达到落点拾取半径时掷胜者**（攻方得球概率 55/45）；败者就地停；**防方胜时防方 chaser 移动到位（到落点）**

#### Scenario: 攻方头球射门
- **GIVEN** 攻方赢得角球争抢
- **THEN** 以概率分支（55/30/15）：头球射门（subject=攻方 chaser，shot 高亮 detail=header、h=0，起点=争抢点、方向=球门，result=goal 15%/saved 30%/off_target 55%，对齐禁区内桶）/ 头球摆渡（subject=攻方 chaser，pass 给队友，无 detail、h=0）/ 拿球组织（main 恢复，carrier=攻方 chaser）

#### Scenario: 防方头球解围
- **GIVEN** 防方赢得角球争抢（防方 chaser 已移动到位）
- **THEN** 防方 chaser（carrier）就地以概率分支（70/20/10）：头球解围（subject=防方 chaser，pass 顶出禁区 detail=clearance、h=0 → 松散球**重新争（普通松散球，非 battle）**）/ 解围出底线（PassOutOfPlay source=Clearance → 再角球）/ 解围出边线（PassOutOfPlay source=Clearance → 界外球，进攻方掷）

### Requirement: 界外球机制

引擎 SHALL 支持界外球：传球出边线后**对方**（防方解围出边线后**进攻方**）从边线掷向附近队友（pass 高亮，短传无高度 h=0）。掷球者 = 接球方离出界点最近的**外场球员（非门将）**。

#### Scenario: 界外球掷球
- **GIVEN** 一次界外球
- **THEN** 接球方离出界点最近**非门将外场球员**（掷球者）**先走向出界点（边线，RestartPrep 准备期，球停在出界点）**，到点后从边线出界点掷向附近队友（pass 高亮，短传无高度 h=0，to=附近队友，receiver_x/y=接球队友当前位置）

### Requirement: 头球复用高亮

头球 SHALL 复用 shot/pass 高亮，不新增事件类型：头球射门 = shot 带 detail=`header`；头球解围/摆渡 = pass。

#### Scenario: 头球射门带 header
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`（viewer 据此演绎头球）

#### Scenario: 头球解围为 pass
- **GIVEN** 一次头球解围
- **THEN** pass 事件顶出禁区（无高度 h=0），落点松散球重新争

#### Scenario: 头球摆渡为 pass
- **GIVEN** 攻方赢得角球争抢后头球摆渡给队友
- **THEN** pass 事件无 detail、h=0（低空头球，球不放大）

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守方后卫线（防线 = 每队离己方门线最近的 4 名外场球员，**按 default_lineup 基准站位定静态身份，非逐 tick 动态重选**，不含门将）目标位置随球前压（push up）：目标 = `clamp01(clamp(base + shift + press + push, base, ball)).clamp(0.04, 0.9)`（末段为 P7 的"不顶门线/不进小禁区"钳制）沿己方进攻方向——home 攻左→右取 `min(球位, …)`、away 攻右→左取 `max(球位, …)`，**且不下穿角色基准 `base`**；球回撤时防线回收（drop back）；门将不参与防线前压（仅回位到门线）。**注意**：球位于该防线基准之后（球 x < base.x）时以 `base` 为准，此时目标可在球之前（地板优先于"不得越过球"）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 外场球员目标位置向左偏移（ball-side shift，连续映射 shift ∝ ball_x−0.5，非二分切换），保持球侧紧凑；纵向同向随球压缩（y 偏移 = (ball_y−0.5)×`SIDE_SHIFT_FACTOR`×0.6）；门将除外（不参与球侧平移，仅回位到门线）

#### Scenario: 控球阶段压上
- **GIVEN** 己方处于 attack phase
- **THEN** 全队目标位置前压（不含门将）；己方处于 defend phase 时回收（压上由 phase 驱动，不绑定瞬时持球状态——松散球期间 attack 方仍前压）

#### Scenario: 防橡皮筋
- **WHEN** 每 tick 更新目标
- **THEN** 移动受速度上限约束；位移小于静区阈值时不移动（静区绑定单一常量 `DEAD_ZONE_METERS`——P4 起的同一个门、非新引入；P7 由 0.5m 放大到 **2.0m**，到位后目标微变不追，避免球门旁来回小幅摆动）；目标点间距约束（repulsion，作用域 = 同队内部，在队形/close_down 目标后施加最小间距修正；**最小间距 = `SAME_TEAM_MIN_DIST_M` = 2.2m，米制**——P34（#53）起判定与推开都走米制（`same_team_dist_m` + `separate_pair_m`），与 detector `player_overlap` 口径一致；旧归一化欧氏口径在 105×68 球场上 y 方向只保证 1.36m。间距 < 阈值的同队球员对沿连线推开至阈值，确定性迭代 ≤3 次；carrier 不参与 repulsion——其位置由 main 带球轨迹决定），避免两圆点重叠；运算顺序：先 dead-zone 判定，后 approach-rate cap 限幅

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队**基础 phase（attack/defend）+ transition 叠加窗口（transition_active 布尔）**；球权易主（抢断成功 / 射门被扑住（save-caught）——`TransitionSource` 的仅有两个来源）时触发固定 `TRANSITION_TICKS = 4` 的 transition 窗口：**窗口内该 tick 只产 main + movers、不走机会评估（因此不掷新高亮）**；新进攻方全队前压（经 `formation_target` 的 `press` 在窗口内放大 2× 经 movers 表达），新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition（固定 `TRANSITION_TICKS = 4`）：tackle 高亮起点 tick 即武装 transition（tackle 高亮时长 1 tick 覆盖 [T, T+1)）；松散球自 t_end=T+1 产生，窗口内该 tick 只产 `beat.ball` + movers、不走机会评估；**实测拾取恒发生在 T+4**（`LOOSE_MAX_TICKS = 2` 只封顶球的滚动、不封顶追逐，追逐者每 tick 走 `RUN_SPEED_MS`；拾取 tick 顶部窗口已被清除）——故 tackle 路径下**不存在"新持球者在窗口内前插"这一可见行为**（`carrier_move` 的反击前插分支只对窗口内持球者生效，而该路径下窗口内无持球者）；新进攻方队形前压（`formation_target` 的 `press` 窗口内放大 2×，经 movers 表达），新防守方整体回撤并**就近 2 名外场防守者收缩（close_down，执行者 = 距目标最近且非 carrier 的 2 名，确定性平局按 id 小者；目标 = 球位——tackle 源恒取 `st.ball_pos`，即松散球位置；收缩不进入拾取半径；原持球方"回位" = 不参与拾取竞争（不追球抢球），但按 close_down 向目标侧收缩/压迫，非静止不动）**

#### Scenario: 射门被扑救触发反击
- **GIVEN** 一次射门被门将扑住（save-caught，球权易主）
- **THEN** save 高亮终点 tick 后的**首个整数 tick 边界**武装 transition（门将扑住时刻可非整数，取整到下一整数 tick）：门将持球 → main 恢复（P4 D12）；**门将 carrier 不参与"前插"**（前插只作用于外场球员，门将持球在门线零位移/短带，**transition 窗口结束后回到正常开放比赛的机会评估（自然 deadline，钳制 [3,12] tick，门将另有 `GK_DEADLINE_BONUS_TICKS` 放宽）；门将持球走出球档，直接掷 pass 高亮出球**）；新防守方整体回撤 + **就近 2 名外场防守者 close_down（执行者 = 距目标最近的 2 名外场球员，排除门将 / carrier / 罚下者，确定性平局按 id 小者；save-caught 源的目标 = `attacking_forward`——新进攻方中最靠其进攻方向球门的球员，即门前/禁区前沿的对方球员；收缩不进入拾取半径）**，transition 窗口从武装 tick 起算

#### Scenario: 射门扑出反弹不触发 transition
- **GIVEN** 一次射门被门将扑出（save-rebound）
- **THEN** 不触发 transition——进入普通松散球（P4 D11，**双方可争**，追逐者 = 距球最近者），拾取后 phase 按球权刷新（原进攻方补射拾取 → 继续 attack；防守方拾取 → 回 defend）

#### Scenario: 松散球期间 phase 按易主后归属
- **GIVEN** 球权易主后的松散球阶段（无人持球，新持球者尚未拾取）
- **THEN** 两队基础 phase 按易主后归属：新进攻方（抢断方/扑救方）为 attack、原持球方为 defend（transition_active 叠加），transition 窗口不因松散球中断；新持球者拾取后按球权刷新（save-rebound 未易主则沿用易主前归属，拾取后按实际拾取方刷新）

#### Scenario: transition 期间不掷新高亮
- **GIVEN** transition 进行中
- **THEN** transition 期间**不开启行动机会**（该 tick 只产 main + movers，不走机会评估），因此不再掷新高亮（保证反击窗口完整可见）；**窗口结束后恢复正常机会评估**（自然 deadline 驱动，无独立 hold 计数）；球权易主 → 新 carrier 的机会在其持球段起始处重新起算

#### Scenario: transition 窗口结束
- **GIVEN** transition 窗口（4 tick）结束后
- **THEN** 每队回到 attack/defend 阶段（按球位置/持球方），队形目标恢复正常

### Requirement: 队形与阶段转换确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（队形目标、阶段转换、movers 一致）。

#### Scenario: 阶段确定性
- **WHEN** 同 seed 两次模拟
- **THEN** 可观测代理一致：以**反击段 movers 方向（新进攻方前压 / 新防守方回撤 + close_down 收缩）为区分性代理**（窗口内无新高亮单独不具区分度——正常持球段也长时间无高亮），队形目标导致的位置更新完全一致（phase 本身不发射，通过可观测事件流断言）

