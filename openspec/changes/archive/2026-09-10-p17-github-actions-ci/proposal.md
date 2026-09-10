# Proposal: GitHub Actions CI（verify.sh 自动跑）

## Why

仓库无 `.github/` CI 配置。P16 引入 DOM 测试后，spec 里「随 CI 运行」目前只由 `verify.sh`（人工/本地入口）兑现——合入后若无人手动跑，回归不会在远端被拦。本 change 加 GitHub Actions，让每次 push / PR 自动跑完整验证套件（引擎单测 + viewer 单测含 jsdom DOM 测试 + WASM e2e + 真实性套件）。

## What Changes

- 新增 `.github/workflows/ci.yml`：checkout → 装 Rust（含 wasm target）→ 编译 WASM 引擎 → 装 Node 22 → `npm ci` → `./verify.sh`。
- 关键前置：`viewer/engine.wasm` 被 gitignore，CI 必须自行 `cargo build --target wasm32-unknown-unknown --release` 后拷贝，verify.sh 第 3 步才跑得动。

## Capabilities

### No functional capability changes

纯基础设施（CI 配置），不改变任何引擎 / viewer / 协议行为。归档走 `--skip-specs`（无 spec delta）。

## Impact

- `.github/workflows/ci.yml`（新）：唯一改动文件。
- 无新依赖、无代码改动；`verify.sh` / `package.json` 均不变。
