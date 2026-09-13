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

引擎 SHALL 能产出一场最小比赛的事件流，至少包含 kickoff、pass、dribble、shot、whistle 五类事件。

#### Scenario: 最小比赛
- **WHEN** 引擎被要求模拟一场最小比赛
- **THEN** 输出事件流从 kickoff 开始，以 whistle 结束，中间包含传球、带球、射门事件

### Requirement: 事件含演绎参数

引擎 SHALL 在 pass/dribble/shot 事件中输出演绎参数：pass 含球速与提前量（speed、lead），dribble 含带球速度与触球频率（speed、touch_freq），shot 含球速（speed）。

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

引擎 SHALL 使主队进球系统性多于客队，主客进球不对称对齐真实方向。主场优势通过**两个落在单点判定上的微差通道**实现（均只改比较阈值、不增/减确定性 RNG 消费，同 seed 同流，且不挤压其他 L1 带的合并统计口径）：机会把握——射门/头球 result 判定中主队 goal 窗口上移（`CLINICAL_GOAL_PP_HOME`）、客队不压；二点争顶——角球 battle 攻方胜率攻方为主队时高于攻方为客队时。引擎当前总进球 ~0.9-1.1/场（B 档体积扩展前），本机制只调**主客比例**不做体积扩展。

#### Scenario: 主队进球多于客队（L1）
- **GIVEN** 引擎以 ≥200 个 seed × 90 分钟模拟
- **THEN** 主队进球/场 SHALL ∈ [0.38, 0.75] 且主队进球 SHALL > 客队进球 × 1.08（真实：主 1.53 / 客 1.22、主客比 ~1.25，Kopacak；引擎体积压缩下用方向性 + 比率下界断言）
- **AND** 客队进球/场 SHALL ≥ 0.30（主队优势不得机械压低客队——客队进球不被宏观系数压缩）

#### Scenario: 机会把握主客平移
- **GIVEN** 一次射门/头球判定且射门方为主队
- **THEN** result goal 判定阈值 = 分桶声明概率 + `CLINICAL_GOAL_PP_HOME`（主队把握略高）；saved 窗口宽 SHALL 不变（门将扑救表现不随主客变化）
- **AND** 射门方为客队时阈值 = 分桶声明概率（客队不被压低）

#### Scenario: 角球二点争顶主客不对称
- **GIVEN** 一次角球 battle 争抢（攻方 chaser 到落点）
- **THEN** 攻方为主队时胜率 = `BATTLE_ATTACK_WIN_HOME`%、攻方为客队时 = `BATTLE_ATTACK_WIN_AWAY`%（攻/防基线 55/45；home 攻 58、home 守 100−52=48，各 +3pp）且主队方向不弱于客队

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

引擎 SHALL 不固定概率必抢，而是由防守者基于情境自行判断是否抢断：存在距持球者 ≤ 阈值的对方球员时，以低概率（抢断积极性）决定是否真的去抢；超阈值或无积极性则不产 tackle。参数为引擎内常量 + `should_tackle()` 决策函数。

#### Scenario: 就近防守
- **GIVEN** 一个事件点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（约 10m）时不产 tackle

#### Scenario: 超阈值落回进攻
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle，该次机会重掷落回 pass/dribble/shot（当作普通进攻事件处理）

#### Scenario: 抢断积极性
- **GIVEN** 最近防守者距离 ≤ 阈值
- **THEN** 以低概率（抢断积极性，标定约 0.09，目标每场 8-15 次）决定是否真的去抢；概率不中则继续进攻

#### Scenario: 抢断频率目标
- **WHEN** 一整场比赛（2700s）模拟
- **THEN** tackle 事件总数落在约 8-15 次（用户确认目标）

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）

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

### Requirement: 射门槽频率（L1）

引擎 SHALL 使射门槽位占比为 35%（shot 槽 roll 30%→35%），保证对齐转化率后集锦仍有进球。

#### Scenario: 射门槽占比
- **GIVEN** 引擎以多 seed 模拟
- **THEN** 普通射门事件总数 / tackle 事件总数 SHALL ∈ [1.0, 1.8]（声明 shot 35% / tackle 22% ≈ 1.59）

### Requirement: 射门比率对齐真实（L3 参考带，射门相关）

引擎 SHALL 使射门相关的聚合比率对齐真实联赛参考带（多 seed ≥200 聚合）。

#### Scenario: 射正率
- **THEN**（goal+saved）/ 射门 SHALL ∈ [28%, 39%]（真实 ~33%；实测 38.3%）

#### Scenario: 射门转化率
- **THEN** goal / 射门 SHALL ∈ [8%, 14%]（真实 ~10%；实测 13.1%）

#### Scenario: 禁区内进球占比
- **THEN** 禁区内进球 / 总进球 SHALL ∈ [72%, 92%]（真实 ~85%；实测 86.9%）

