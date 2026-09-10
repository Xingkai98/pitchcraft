# Tasks: 固定比赛时长（时长保留为参数，UI 不暴露切换）

## P1. 配置

- [x] P1.1 `viewer/config.js`：`playback` 收敛为单一 `matchDuration: 5`（删 `matchDurations` 数组与旧 `matchDuration` 冗余），注释注明「比赛内容时长参数，改这里即改比赛时长」

## P2. 页面

- [x] P2.1 `viewer/app.js`：删 `btnDuration` 引用、`durationIndex`、`rebuildGame`、`btnDuration` 监听
- [x] P2.2 `viewer/app.js`：`init` 时长固定读 `config.playback.matchDuration`
- [x] P2.3 `viewer/index.html`：删 `#btn-duration` 按钮 + `?v=` bump

## P3. 验证收尾

- [x] P3.1 `verify.sh` 全绿（引擎 + viewer 单测 + WASM e2e + realism L1）
- [x] P3.2 `npx openspec validate --all --strict` 通过
- [x] P3.3 代码审阅闭环（独立 paseo agent 审阅 → 修复 → 再审阅，直到无遗留问题）
