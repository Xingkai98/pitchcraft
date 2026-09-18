# match-observation Specification

## Purpose
TBD - created by archiving change p14-observation-queue-only. Update Purpose after archive.
## Requirements
### Requirement: 页面提交到 queue-only 服务时正确展示入队状态

当页面 POST bundle 到 queue-only 模式的本地诊断服务时，页面 SHALL 将任务显示为「已入队、等待处理」（状态 `captured`），SHALL 轮询 `GET /tasks/:id` 并在任务转为终态前保持该展示，SHALL 不将 `captured` 误报为「诊断失败」或「回退 CLI」。

#### Scenario: queue-only 任务显示已入队
- **GIVEN** 本地诊断服务以 queue-only 运行，页面提交一个观察
- **THEN** 页面显示该任务状态为「已入队，等待处理」，轮询不报错、不触发回退 CLI

#### Scenario: queue-only 任务刷新后不被误报
- **GIVEN** 一个 queue-only 入队的 `captured` 任务，页面刷新恢复观察列表
- **WHEN** 本地诊断服务不可达，或任务长时间无人手动取
- **THEN** 页面 SHALL 保持「已入队，等待处理」展示，SHALL 不将其误报为「本地诊断端点不可用/回退 CLI」或「等待诊断超时」

#### Scenario: 任务被手动处理后终态回填
- **GIVEN** 一个 queue-only 入队的任务已被用户以 `--run-id` 手动跑完（终态）
- **WHEN** 页面继续轮询
- **THEN** 页面自动渲染诊断报告与 finding 标记（与 P10 终态行为一致）

### Requirement: 观察描述在提交时最终确定

页面 SHALL 在「采集」时以当前输入框内容冻结描述作为初值，并在「提交诊断」时重读输入框：若提交时输入框非空，SHALL 以提交时内容（经凭证形片段抹除）覆盖 bundle 与列表条目的 statement；若提交时输入框为空，SHALL 保留采集时冻结的描述。采集完成后 SHALL 清空描述输入框；提交诊断完成后 SHALL 同样清空描述输入框——两处缺一不可，否则旧描述会泄漏给下一条观察。

#### Scenario: 采集后输入描述，提交时覆盖
- **GIVEN** 用户采集一条观察（采集时描述输入框为空，冻结 statement 为空）
- **WHEN** 用户随后在描述输入框输入「球员射门偏出太多了」并点击「提交诊断」
- **THEN** 提交的 bundle 的 statement 为「球员射门偏出太多了」，列表条目同步显示该描述

#### Scenario: 采集前已输入描述，提交时未改
- **GIVEN** 用户先输入描述「传球时防守队员完全不干扰」再采集观察（冻结该描述），采集后输入框被清空
- **WHEN** 用户直接点击「提交诊断」（不重新输入）
- **THEN** 提交的 bundle 的 statement 保留「传球时防守队员完全不干扰」（不因清空而丢失）

#### Scenario: 采集后清空输入框
- **GIVEN** 用户输入描述并采集观察
- **WHEN** 采集完成
- **THEN** 描述输入框内容被清空，下一条观察不会继承上一条的描述

#### Scenario: 提交后清空输入框
- **GIVEN** 用户采集观察后在描述输入框输入描述并点击「提交诊断」
- **WHEN** 提交完成
- **THEN** 描述输入框内容被清空，下一条观察不会继承刚提交的描述

#### Scenario: 提交时的描述仍抹除凭证形片段
- **GIVEN** 用户采集观察后在描述输入框输入含 `sk-ant-...` 凭证形文本
- **WHEN** 点击「提交诊断」
- **THEN** 提交 bundle 的 statement 中凭证形片段被替换为 `[REDACTED]`

### Requirement: 观察采集/提交的 DOM 行为有自动化测试覆盖

观察采集与提交的清空/覆盖行为（P15 引入）SHALL 有驱动真实 `viewer/app.js` DOM 接线的自动化测试，且随 `verify.sh` / CI 运行——误删或改坏这些接线（采集后清空、提交时覆盖、提交后清空）时测试 SHALL 失败。

#### Scenario: 采集后清空输入框被测试断言
- **GIVEN** 观察采集测试用例
- **WHEN** 驱动真实「采集」按钮监听器
- **THEN** 断言描述输入框内容被清空

#### Scenario: 提交时覆盖描述被测试断言
- **GIVEN** 观察提交测试用例（采集时描述为空，随后输入描述）
- **WHEN** 驱动真实「提交」按钮监听器
- **THEN** 断言提交的 statement 为输入值（经凭证抹除）

#### Scenario: 提交后清空输入框被测试断言
- **GIVEN** 观察提交测试用例（采集后输入描述并提交）
- **WHEN** 提交完成
- **THEN** 断言描述输入框内容被清空

### Requirement: 已提交观察的描述以服务端为权威并自动回填

对于已提交（有 task_id）的观察条目，页面 SHALL 以服务端 bundle 的 statement 为权威：在刷新恢复与任务轮询时 SHALL 用服务端返回的 statement 覆盖本地条目；服务端返回空字符串时 SHALL 覆盖为空；服务端未返回该字段时 SHALL 保持本地值。采集未提交（无 task_id）的条目 SHALL 保持本地值。

#### Scenario: 刷新后从服务端回填描述
- **GIVEN** 一个已提交观察，服务端 bundle statement 为「球员射门偏出太多了」，本地 localStorage 里是 P15 错位修复前的旧描述「传球太慢」
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 显示为「球员射门偏出太多了」

#### Scenario: 服务端空描述覆盖本地脏值
- **GIVEN** 一个已提交观察，服务端 bundle statement 为空字符串，本地存有旧描述
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 被清空（不残留旧描述）

#### Scenario: 服务端未返回 statement 时保持本地值
- **GIVEN** 一个任务响应不含 statement 字段（bundle 缺失或旧服务）
- **WHEN** 页面轮询该任务
- **THEN** 条目 statement 保持不变

#### Scenario: 未提交观察不参与回填
- **GIVEN** 一个采集未提交（无 task_id）的观察条目
- **WHEN** 页面刷新
- **THEN** 该条目 statement 保持本地值（服务端无此任务）

### Requirement: 观察诊断前需确认事件锚点

已提交的观察 SHALL 能被「事件锚定确认」：页面/CLI/对话 SHALL 能将观察描述锚定到窗口内的事件 index 集合，确认产物 SHALL 持久化到任务。在 queue-only 模式下，未确认前诊断 SHALL 不启动（任务停在 captured/awaiting_confirmation，等待确认后由人取任务跑）；非 queue-only 模式下确认步为可选增强，诊断随提交自动启动，captured/awaiting_confirmation 任务仍可被确认（跳过提案直接确认亦走同一 confirm 端点）。

#### Scenario: 提案后等待确认
- **GIVEN** 一个已入队的观察任务
- **WHEN** 提案运行（模型选出候选事件，或无可选时回退为空）
- **THEN** 任务状态转为 `awaiting_confirmation`，展示候选事件与锚点漂移提示

#### Scenario: 确认锚定后进入诊断
- **GIVEN** 任务处于 `awaiting_confirmation`
- **WHEN** 用户通过页面/CLI/对话确认事件 index 集合
- **THEN** 任务状态转为 `confirmed`，诊断以确认的 index 集合为锚点运行

#### Scenario: 无模型时用户从全量列表选
- **GIVEN** 提案运行但无可用模型
- **WHEN** 任务进入 `awaiting_confirmation`
- **THEN** 展示窗口全量高亮事件列表供用户勾选，无需模型

### Requirement: 页面可以提交比赛观察

系统 SHALL 允许用户在一个具体比赛时刻提交自然语言描述，并记录该时刻前后可配置时间窗口、seed、比赛配置、当前事件索引、选中实体和 viewer 快照。

#### Scenario: 提交一个观察

- **WHEN** 用户在比赛播放页面暂停并提交描述“传球时防守队员完全不干扰”
- **THEN** 系统保存一个包含描述、seed、config、match_time、window、事件窗口和 viewer 快照的 observation bundle

### Requirement: 观察包可以脱离页面重放

Observation bundle SHALL 包含足以重新定位原比赛的 `schema_version`、`observation_id`、seed、config、match_time、source_revision 和事件窗口；同一 bundle 在相同代码版本下 SHALL 产生相同的事件窗口。runner 对 bundle 内已保存的事件窗口/audit_input 进行确定性审计；seed/config/source_revision 作为可追溯元数据随 bundle 保存，供未来完整重放或回归使用，不承诺本 change 内从 seed/config 重建整场比赛。

#### Scenario: 命令行审计观察

- **WHEN** audit runner 读取一个已保存的 observation bundle
- **THEN** runner 对 bundle 携带的事件窗口/audit_input 运行确定性审计，产出与页面提交时一致的 findings，并使用 bundle 中的 seed/config/source_revision 标记审计报告的可追溯性

#### Scenario: 完整重放（未来工作）

- **WHEN** 需要从 seed/config 重建整场比赛并重新定位观察窗口
- **THEN** 该能力作为 1.4/5.5 的未来工作，不在本 change 的 runner 路径中承诺

### Requirement: 观察提交不暴露凭证

浏览器提交的 observation bundle、网络响应和页面日志 MUST NOT 包含 `ANTHROPIC_API_KEY` 或其他 Agent 凭证。

#### Scenario: 检查提交内容

- **WHEN** 用户提交观察并启动诊断任务
- **THEN** 浏览器侧只能看到 provider 配置状态，不会收到 API key 明文

### Requirement: 观察任务有可追踪状态

系统 SHALL 为 observation 提供 `captured`、`auditing`、`audit_ready`、`diagnosing`、`diagnosed`、`insufficient_evidence`、`provider_unavailable` 和 `failed` 状态中的一个，并持久化状态转换和错误摘要。

#### Scenario: Agent 不可用

- **WHEN** observation audit 成功但本机 Claude Code 或 `ANTHROPIC_API_KEY` 不可用
- **THEN** 任务状态为 `provider_unavailable`，用户仍能查看 audit findings 和原始 bundle

### Requirement: 页面提交使用本地诊断服务并回填结果

页面提交 SHALL 优先 POST 到本地诊断服务，服务端点地址 SHALL 由页面来源推导：页面 hostname 为 `localhost`/`127.0.0.1` 时用 `http://127.0.0.1:8787`，否则用同一 hostname 的 8787 端口（tailscale 场景自动指向服务所在机器，无需额外配置）；轮询任务状态，终态时自动渲染 findings 并打时间轴红点；服务不可达或请求失败时 SHALL 回退为 bundle 导出 + CLI 模板。任何情况下 API key 不进入浏览器。

#### Scenario: 本地服务在线

- **WHEN** 用户点击提交且本地服务可达
- **THEN** 页面 POST bundle 并轮询 `GET /tasks/:id`，任务完成后自动导入并渲染诊断报告与 finding 标记

#### Scenario: tailscale 来源页面自动指向服务

- **WHEN** 页面从 `http://100.114.76.34:8000` 打开且该机器服务以 `--host 0.0.0.0 --allow-origin http://100.114.76.34:8000` 运行
- **THEN** 页面端点推导为 `http://100.114.76.34:8787`，提交与轮询正常完成，无需手工配置端点

#### Scenario: 本地服务离线

- **WHEN** 用户点击提交但本地服务不可达或未配置
- **THEN** 页面回退为导出 bundle + 显示 CLI 模板，用户可手动运行诊断后导入结果

### Requirement: 页面展示观察列表与实时处理进度

页面 SHALL 维护本会话的所有观察条目（每次采集/提交生成一条），每条展示用户描述、比赛时刻与当前任务状态徽章；提交到服务后的条目 SHALL 按轮询结果实时更新状态，终态 SHALL 渲染诊断反馈（根因、代码位置、方案、验证命令、置信度）与 finding 标记；列表 SHALL 在刷新后恢复（本地持久化），并可从服务重新同步任务状态。

#### Scenario: 多条观察处于不同状态

- **WHEN** 页面提交了多条观察且服务处理进度不同
- **THEN** 列表逐条显示各自状态（如一条 `diagnosing`、一条 `diagnosed`），状态变化实时更新，已完成的条目可直接查看最终反馈

#### Scenario: 刷新后恢复列表

- **WHEN** 用户刷新页面后再次打开
- **THEN** 之前的观察条目仍在列表中，页面从服务重新拉取各任务状态并显示最新进度

