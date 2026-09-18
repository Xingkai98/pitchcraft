## Why

比赛画面中的异常通常先以一句主观描述出现，例如“传球时防守队员完全不干扰”或“球员经常原地不动”。当前项目只能依赖人工记忆、截图和散落的 debug 日志，无法把某一瞬间稳定重放、量化、定位到代码根因，也无法让 AI 在修改后验证同一现象是否消失。

本 change 建立从页面观察到确定性取证、再到本机 Claude Code 诊断的闭环；AI 负责沿证据和代码关系提出并验证根因，不负责凭截图裁判真实性。

## What Changes

- 新增页面“提交观察”能力，记录比赛 seed、配置、比赛时刻、前后时间窗口、用户自然语言描述、选中实体和当前 viewer 状态。
- 新增可复现观察包格式，包含事件窗口、状态/渲染快照、代码版本和审计输入，能够脱离浏览器重放。
- 新增确定性 `match-audit`，对观察窗口运行基础一致性和首批真实感检测器，输出带时间、事件、实体和计算证据的 findings。
- 首批真实感检测器覆盖：无压力传球出界、责任状态下连续站桩、可拦截传球但防守无反应。
- 新增本地诊断 runner，接收观察包和 audit 报告，默认以 bypass 权限模式启动 Claude Code 诊断（Agent 可执行验证/复现命令并直接修复），权限模式可配置为只读，要求返回结构化根因、代码位置、候选方案、置信度和验证命令。
- 新增 Agent/model 配置；默认 provider 为 `claude-code`，默认凭证来源为本机 `ANTHROPIC_API_KEY` 环境变量，不使用 `claude auth`。
- 新增诊断任务状态、失败重试和结果落盘；页面能查看诊断进度并跳转回原始比赛时刻。
- 新增本地诊断 HTTP 服务：页面提交观察后由服务端统一执行审计与诊断，页面轮询状态并自动回填 findings；服务不可用时保留 CLI 回退。
- 新增 `.env` 支持：runner/service 入口从仓库根 `.env` 读取 `ANTHROPIC_API_KEY`（已有环境变量优先），`.env` 加入 `.gitignore`，仅提交 `.env.example` 示例。
- 默认 bypass 模式下诊断 Agent 可执行验证命令并直接修复；`--permission read-only` 可恢复“只读诊断、修复另开”的保守模式。诊断报告始终记录实际修改，供用户审查。

## Capabilities

### New Capabilities

- `match-observation`: 页面创建、保存、读取和重放带自然语言描述的比赛观察包
- `match-audit`: 对观察窗口执行确定性事实检查和真实感检测，并输出可解释证据
- `diagnosis-runner`: 使用本机配置的 Agent/model 对观察包进行只读代码诊断并保存结构化报告

### Modified Capabilities

<!-- No existing capability requirement is changed in this MVP. -->

## Impact

- `viewer/app.js`、`viewer/index.html`、`viewer/game.js`：观察捕获、时间窗口和诊断状态展示。
- `viewer/protocol.js` 或新增 viewer 诊断模块：观察包和 audit 输入的协议校验。
- `engine/src/lib.rs` 或新增 replay/audit adapter：为审计提供稳定事件索引、状态和可追溯证据。
- 新增本地工具目录，用于接收观察提交、运行 audit、启动 Claude Code 和保存结果。
- 不新增第三方运行时依赖；Claude Code 作为本机可执行程序调用。
- API key 只从 runner 进程环境读取，禁止进入浏览器、观察包、日志和仓库配置。
