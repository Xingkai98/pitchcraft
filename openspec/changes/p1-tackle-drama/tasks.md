# Tasks: 抢断四段式演绎（tackle-drama）

## 1. 演绎逻辑（interpretation.js）

- [x] 1.1 新增 `config.interpretation.tackle` 参数块：`deflectDistance`（弹开距离，归一化）、`deflectSpeed`（弹开球速 m/s）、`collectDelay`（捡球反应停顿 s）
- [x] 1.2 重写 `interpretTackle` 为四段式：持球（球到被铲者脚下）→ 逼近（防守者到接触点）→ 碰撞捅开（球弹向垂线方向）→ 捡球（success=防守者 / fail=被铲者 反应一拍后以跑速追到弹开点拾取）
- [x] 1.3 弹开方向：垂线候选确定性选择，优先场内，越界钳制；零距离退化为垂直弹开
- [x] 1.4 缺被铲者位置（x2/y2/to 缺失）时退化为最小演绎，不伪造球/人位置

## 2. 测试（interpretation.test.js）

- [x] 2.1 success：球锚点 ≥3（脚下→接触→弹开），防守者终点与球终点重合，且从接触点移动到弹开点
- [x] 2.2 fail：被铲者终点与球终点重合（原持球人拿回），防守者停在接触点
- [x] 2.3 弹开方向与逼近方向垂直（典型场内用例，点积 ≈ 0）
- [x] 2.4 确定性：同输入 → 同锚点序列
- [x] 2.5 边界：弹开点坐标在 [0,1] 内
- [x] 2.6 锚点时间严格递增 t0<tContact<tLoose<tPickup
- [x] 2.7 零距离、贴角球钳制、缺被铲者位置退化三个分支各有用例

## 3. Mock 与样例

- [x] 3.1 `mock-event-stream.js`：tackle 补全 `to/x2/y2`，加一条 `result=fail` 样例（原持球人拿回）；事件间距保证片段不重叠

## 4. 插值路径修复（game.js）

- [x] 4.1 `_interpolateAnchors` 排除后续事件锚点（evt > currentIndex），避免片段时间窗口重叠时泄漏
- [x] 4.2 game 级测试：终态（防守者拿球）、中间态（球先到弹开点、捡球人在路上）、fail 变体（原持球人拿回）

## 5. 验证与收尾

- [x] 5.1 跑 `node --test`（viewer 全量，52 用例）+ `verify.sh`（引擎 + viewer + WASM 端到端）
- [x] 5.2 更新 `index.html` 与 `app.js` 的 `?v=` 版本号（JS 修改后强制浏览器刷新）
- [x] 5.3 代码审阅闭环：起 subagent 审阅 → 修复 → 复审直到通过（多维度审阅 11 条发现全部修复，复审通过）
