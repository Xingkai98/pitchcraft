# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: 验证套件可在远端 CI 自动运行

仓库 SHALL 提供远端 CI 配置（GitHub Actions），使 `verify.sh` 的分层验证（引擎单测、viewer 单测含 DOM 测试、WASM e2e、真实性统计套件）在 push 与 pull request 时自动执行；CI SHALL 自行编译 WASM 引擎产物（`viewer/engine.wasm` 不入库）并安装 Node 依赖后再运行验证。

#### Scenario: push 触发完整验证
- **GIVEN** 仓库含 `.github/workflows/ci.yml`
- **WHEN** 任意分支 push
- **THEN** CI 检出代码、编译 WASM、`npm ci` 安装 devDependency、运行 `./verify.sh` 全套并全绿

#### Scenario: pull request 触发完整验证
- **GIVEN** 一个 pull request
- **WHEN** PR 创建或更新
- **THEN** 同一套 CI 验证在合入前执行，失败即标记 PR 未通过
