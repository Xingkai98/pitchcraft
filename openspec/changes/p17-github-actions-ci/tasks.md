# Tasks: GitHub Actions CI（verify.sh 自动跑）

## P1. CI 配置

- [ ] P1.1 写 `.github/workflows/ci.yml`：`on: [push, pull_request]`、单 job、Rust stable + wasm target、`cargo build --target wasm32-unknown-unknown --release` 并拷贝 engine.wasm、Node 22、`npm ci`、`./verify.sh`、timeout 30min、rust-cache

## P2. 本地验证

- [ ] P2.1 yaml 语法检查（如有工具；否则人工目检）
- [ ] P2.2 本地 `./verify.sh` 全绿（确认 CI 跑的同套命令本地通过）

## P3. CI 触发验证

- [ ] P3.1 push 分支 → `gh run list/view` 确认 Actions 触发
- [ ] P3.2 盯 CI 到绿（红则修 yaml 再 push 迭代）

## P4. 审阅收尾

- [ ] P4.1 代码审阅闭环（独立 paseo agent 审阅 → 修复 → 再审阅，直到无遗留问题）
- [ ] P4.2 `npx openspec validate --all --strict` 通过
