# Tasks: GitHub Actions CI（verify.sh 自动跑）

## P1. CI 配置

- [x] P1.1 写 `.github/workflows/ci.yml`：`on: [push, pull_request]`、单 job、Rust stable + wasm target、`cargo build --target wasm32-unknown-unknown --release` 并拷贝 engine.wasm、Node 22、`npm ci`、`./verify.sh`、timeout 30min、rust-cache

## P2. 本地验证

- [x] P2.1 yaml 语法检查（actionlint 1.7.7 通过；pyyaml 解析通过）
- [x] P2.2 本地 `./verify.sh` 全绿（确认 CI 跑的同套命令本地通过）

## P3. CI 触发验证

- [x] P3.1 push 分支 → `gh run list/view` 确认 Actions 触发（run 34465412179 起，三次 push 均触发）
- [x] P3.2 盯 CI 到绿（首跑即绿 1m47s；v7 复跑绿 1m20s；concurrency 后 1m2s 绿）

## P4. 审阅收尾

- [x] P4.1 代码审阅闭环（独立 paseo agent：codex/gpt-5.6-sol，两轮，均通过无遗留）
- [x] P4.2 `openspec validate --all --strict` 通过（17 passed / 0 failed）
