# Design: GitHub Actions CI（verify.sh 自动跑）

## Context

`verify.sh` 是唯一验证入口，四步：Rust cargo test → viewer node --test（含 app.test.js jsdom）→ WASM e2e（依赖 `viewer/engine.wasm`）→ realism L1（`--release -- --ignored`）。本 change 把它搬进 GitHub Actions，无代码改动。

## Goals / Non-Goals

**Goals:**
- push（含 feature 分支）与 PR 都触发，合入前即可看到分支是否绿。
- 单 job 顺序跑 verify.sh 四步，简单可维护。
- CI 与本地 `./verify.sh` 结果一致。

**Non-Goals:**
- 不引入矩阵 / 多平台 / 分步并行（当前单 Linux runner 足够）。
- 不重构 verify.sh、不改任何测试。

## Decisions

### D1: 单 job，`on: [push, pull_request]`

- `push` 让 feature 分支 push 即触发（迭代 CI 时不用先开 PR）；`pull_request` 让 PR 合入前也跑。
- `runs-on: ubuntu-latest`。
- `concurrency`（`group: <workflow>-<ref>` + `cancel-in-progress`）：同一 ref 连续 push 时取消未跑完的旧 run，避免并行占 runner（审阅建议，非并行矩阵）。

### D2: Rust 前置编译 WASM

- `viewer/engine.wasm` 被 gitignore（`.gitignore` 明示「WASM 产物（由 cargo build 生成）」），CI 必须自行编译。
- 用 `dtolnay/rust-toolchain@stable` + `targets: wasm32-unknown-unknown`，再 `cargo build --target wasm32-unknown-unknown --release`，拷贝到 `viewer/engine.wasm`。
- `swatinem/rust-cache@v2`（workspaces: engine）缓存 target，避免每次重编 release。

### D3: Node 22 + npm ci

- 项目顶层 `app.test.js` 的 loader 用 `module.registerHooks`（Node ≥ 22.15）。用 `actions/setup-node@v7` + `node-version: '22'`（取当前 major：v4 系列的 action 运行时 Node 20 已被 GitHub 标记弃用；checkout 同理用 `@v7`）。
- 有 `package-lock.json` → `npm ci`（确定性强于 `npm install`）。

### D4: 直接跑 `./verify.sh`

- verify.sh 内含 `export PATH="$HOME/.cargo/bin:$PATH"`——GitHub runner 上 dtolnay 已装 cargo，此 export 无害。
- 给足 timeout（wasm release 编译 + realism L1 可能数分钟）：`timeout-minutes: 30`。

## Risks / Trade-offs

- **[首次触发需迭代]**：CI 环境与本地差异（rust target 下载、npm registry、编译时长）可能让首跑红，需 push 分支 → `gh run view` → 修 → 再 push 迭代到绿。这是本 change 真正的工作量，yaml 本身很小。
- **[realism L1 耗时]**：`--release -- --ignored` 本地 14s，CI 含 release 编译可能更长；靠 rust-cache + 30min timeout 兜底。
- **[Actions 是否启用]**：仓库首次加 `.github/workflows`，若 org/repo 未启用 Actions，push 不触发——agent 用 `gh run list` 确认，未触发则回报。

## Migration Plan

1. 写 `.github/workflows/ci.yml`。
2. 本地 `verify.sh` 全绿 + yaml 语法检查。
3. 提交 → push 分支 → `gh run view` 盯 CI 到绿（迭代修复）。
4. 审阅闭环（独立 paseo agent）。
