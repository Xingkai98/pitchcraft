## ADDED Requirements

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
