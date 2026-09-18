# P12 Problem Ops — 实现记录

日期：2026-08-27（Slice 1 服务端 + Slice 2 viewer）
范围：Problem 三个日常操作闭环——删除、重跑诊断、批量导入历史任务。

## 目标

P11 的 Problem 只有创建/流转/讨论/issue 能力。本 change 补齐操作闭环：

- **删除**：误建/废弃问题可清理（幂等 404、页面 confirm 确认，文件系统删除无回收站）。
- **重跑**：同一 bundle 重新诊断（引擎修改后验证同一观察是否复现），终态新报告写回同一
  Problem（decisions 保留 rerun 轨迹，旧报告被覆盖；版本对比留待后续）。
- **批量导入**：历史 diagnosed 任务一键转 Problem（按 task_id 去重，跳过已关联）。

## 改动文件

### Slice 1 — 服务端（tasks 1.1–1.4）

- `tools/problems.mjs`（扩展）：
  - `deleteProblem(id, { tasksDir })` —— 删除 `<tasks-dir>/problems/<id>.json`；id 缺失/非法
    返回 null（服务层映射 404，幂等 404 语义）；成功返回 true。
  - `rerunProblem(id, { task_id, reason }, opts)` —— 把 `source.task_id` 指向新 runId，
    decisions 追加 `{ action: 'rerun', by, at, reason }`（reason 可空），bump updated_at。
    重跑编排（读 bundle / runDiagnosis / 终态写回）在服务层。
  - `setProblemReport(id, report, opts)` —— 终态诊断报告写回 `source.report`（保留
    task_id/observation_id 链），重跑完成后旧报告被覆盖。
  - `problemInputFromDiagnosis({ task_id, task, bundle, envKey, overrides })` —— 从诊断任务
    构造 createProblem 输入（**create-from-report 公共路径**，POST /problems 与 import 共用，
    从服务层抽出）。bundle.statement 先 redactKey 再进描述。
  - `importProblems({ tasksDir, task_ids, readTask, listTaskIds, readBundle }, opts)` —— 批量
    导入编排（纯逻辑，I/O 全部注入可测）。显式 `task_ids` 或缺省扫描 listTaskIds 中
    status=diagnosed 且带 report 的任务；已有关联 Problem（source.task_id 指向）的任务跳过；
    返回 `{ created: [ids], skipped: [task_ids], failed: [{task_id, error}] }`。
- `tools/service.mjs`（扩展）：
  - `DELETE /problems/:id` —— 200 `{ok:true}` / 404（幂等）。
  - `POST /problems/:id/rerun` —— 读 `source.task_id` 的 bundle（无 source 或 bundle 缺失 →
    400 `'no bundle for rerun'`，问题不变）；新 runId **先落 bundle 再 202 `{task_id}`**；
    problem 关联更新 + decisions rerun；后台 `runDiagnosisFn`（同 POST /observations 模式），
    终态带 report 时 `setProblemReport` 写回（旧报告覆盖）。reason 可空（用户可控文本先组合
    净化）。未知问题 404。
  - `POST /problems/import` —— body 可选 `task_ids`（TASK_ID_RE 校验，非法 400；非数组 400）；
    缺省扫描 `<tasksDir>/*.task.json` 中 diagnosed 任务；返回 `{created, skipped, failed}`。
  - `POST /problems` create-from-report 分支改用 `problemInputFromDiagnosis`（抽公共函数，
    行为与 P11 一致）。
  - 新增 `readBundle`/`listTaskIds` 两个内部辅助（import / rerun / create-from-report 复用）。
  - OPTIONS 预检 `Allow-Methods` 增加 DELETE（viewer 删除走跨域 DELETE，浏览器预检需要）。
- `tools/problems.test.mjs`（+9）：deleteProblem（删除/幂等/穿越 id/不影响其它问题）、
  rerunProblem（关联更新/decisions/reason 可空/缺 id 拒绝）、setProblemReport（写回/保留链/
  非法 report）、problemInputFromDiagnosis（构造/overrides/statement redaction/缺字段兜底）、
  importProblems（扫描去重/显式 failed/重复 id 只建一次/读与建失败计入 failed）。
- `tools/service.test.mjs`（+8）：DELETE 200/404 幂等、rerun 202 + 关联更新 + 新 bundle 内容 +
  后台写回新报告（轮询）、rerun 无 bundle 400（人工问题 + bundle 删除）、rerun 404、import
  扫描/显式 failed/校验非法/重复导入去重。

### Slice 2 — viewer（tasks 2.1–2.2）

- `viewer/problem-view.js`（扩展）：
  - API 客户端新增 `rerun(id, body)` / `remove(id)` / `importProblems(body)`。
  - `summarizeImportResult(result)` —— 导入结果摘要（created/skipped 计数 + failed 明细，
    明细渲染前 redactText）。
- `viewer/problem-view.test.js`（+3）：三端点 URL/method/body、rerun 空 body、导入摘要
  redaction 与空输入兜底。
- `viewer/app.js`（扩展）：
  - 列表 toolbar「导入历史任务」按钮 → `POST /problems/import` → refreshProblemList +
    showNotice 摘要（`summarizeImportResult`）。
  - 详情动作面板加「重跑诊断」（有 source.task_id 时）→ `POST rerun` → 轮询 `GET /tasks/:id`
    至终态 → 刷新详情拿新报告；「删除」→ `window.confirm` → `DELETE` → 回到列表 + 刷新。
  - 全部展示文本 `textContent` + `redactText`。
- `viewer/index.html`：问题 toolbar 加 `#problem-import` 按钮。
- **cache-busting → `20260826-15`**：index.html script + app.js 全部顶层 import +
  `VIEWER_SOURCE_REVISION` 三处一致。

## 运行命令

```bash
node --test tools/*.test.mjs          # tools 全量
cd viewer && node --test *.test.js    # viewer 全量
openspec validate p12-problem-ops --strict
./verify.sh                            # cargo + viewer + WASM e2e
```

## 测试结果

```
tools:  # tests 216 / # pass 216 / # fail 0   （P11 基线 199 + problems 9 + service 8）
viewer: # tests 217 / # pass 217 / # fail 0   （P11 基线 214 + problem-view 3）
openspec validate --strict: valid
./verify.sh: 全部通过
rg 凭证扫描（strict 非测试）: sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
grep 20260826-15 viewer/index.html viewer/app.js   # 1 / 10（含 VIEWER_SOURCE_REVISION）
```

## 关键设计 / 约定

- **重跑语义**：problem.source.task_id 立即指向新 runId（页面轮询 `GET /tasks/:id` 看进度）；
  终态诊断报告由服务端后台写回 `source.report`（旧报告被覆盖），decisions 保留 rerun 轨迹
  （版本对比留待后续）。同一 problem 并发 rerun 允许（各自独立 task，MVP 不做互斥）。
- **导入去重**：按 task_id（problem.source.task_id）去重；同一批内重复 task_ids 只创建一次；
  二次导入已关联任务计入 skipped。
- **删除不可恢复**：文件系统删除无回收站；页面 confirm 确认，文档明示。
- **公共 create-from-report 路径**：`problemInputFromDiagnosis` 同时被 POST /problems 与
  POST /problems/import 复用；bundle.statement 先 redactKey 再进描述。
- **凭证纪律**：rerun reason 与 import failed 明细先 redact 再落盘/展示；viewer 全部
  textContent + redactText，browser 零凭证接触。

## 遗留风险 / 待办

- **rerunProblem 失败遗留孤儿 bundle**（审阅 N6，记录不修）：rerun 先落新 runId 的 bundle
  再更新 problem；若中间更新失败，会留下一个无 problem 关联的孤儿 bundle 文件。无害（扫描
  导入只认 diagnosed 任务，孤儿 bundle 不是候选），文档记录即可。
- **rerun 报告写回的小竞态**：页面轮询到任务终态后立即刷新详情；服务端后台写回几乎同步完成，
  但极少数情况下一次刷新可能仍见旧报告（再点「刷新」即得新报告）。不阻塞 MVP。
- **真实 provider 诊断端到端**（含重跑）仍属用户带 `ANTHROPIC_API_KEY` 验收。
- **app.js 接线为 thin DOM glue，未被 node:test 直接覆盖**：数据逻辑（API 调用/摘要/轮询终态
  判定/redaction）全部下沉到 problem-view.js 并有 fake-fetch 单测；DOM 层符合既有模式
  （`node --check` 校验语法）。
- **导入是一次性操作**（无增量同步）；删除无撤销——均为 design Non-Goals。

## 审阅修复（2026-08-27，1 minor-必修 + 2 minor + 2 nit）

针对主 session 审查发现的 6 项逐项修复，全部落地为测试或契约收窄。

1. **[minor-必修] 重跑失败被误报成功**（`viewer/problem-view.js` + `viewer/app.js`）：
   `pollRerunTask` 从 app.js 下沉到 problem-view.js（可注入 endpoint/间隔/上限/状态判定/fetch），
   新增纯函数 `rerunTerminalState(status, data)`：`diagnosed` → 成功（刷新详情）；其它终态
   （failed/insufficient_evidence/provider_unavailable）→ `{ok:false,error}`，含
   status/failure_kind/错误摘要（全部 redactText），页面提示失败、**不刷新详情为成功**。
   补 viewer 测试：fake fetch 返回 failed 终态 → 提示失败（含 [REDACTED]）；network/HTTP 失败。
2. **[minor] 重跑后旧任务脱链，二次导入重建重复 Problem**（`tools/problems.mjs`）：
   `rerunProblem` 的 decisions 记录补 `prev_task_id`（被替换的旧 task_id）；`importProblems`
   existing 集合 = 所有 problem 的 source.task_id ∪ 所有 decisions 里的 task_id/prev_task_id
   （递归扫 decisions）。补测试：rerun 后再 import → 旧任务计入 skipped。
3. **[minor] 并发 rerun 写回竞态**（`tools/problems.mjs` `setProblemReport` + `tools/service.mjs`）：
   `setProblemReport` 新增 `runId` 参数：写回前校验 `run_id === problem.source.task_id`，
   不匹配（并发 rerun 已把问题指向更新的任务）→ 丢弃写回（no-op，返回未改动的 problem）。
   服务端后台写回传 `task.run_id ?? runId`。补测试：run_id 不匹配 → report 不覆盖。
4. **[nit] import 单批重复 task_ids 计入 skipped**（`tools/problems.mjs`）：`['t1','t1']` 的
   第二个 t1 由「静默消失」改为计入 skipped。更新对应测试断言。
5. **[nit] rerun 读旧 task_id 补 TASK_ID_RE 校验**（`tools/service.mjs` rerun 路径）：
   `oldTaskId` 进 `readBundle` 前校验 `TASK_ID_RE`，非法（如路径穿越 `../evil`）→ 400
   `'no bundle for rerun'`。补 service 测试（手写穿越型 source.task_id 的 problem 文件）。
6. **[nit] 删除失败提示补 redactText**（`viewer/app.js`）：`!res.ok` 分支的
   `res.data?.error` 包 `redactText`（catch 分支原本已有）。
7. **不修（记录）**：rerunProblem 失败遗留孤儿 bundle（见遗留风险）。

- cache-busting bump：`20260826-15` → `20260826-16`（index.html + app.js 全部 import +
  `VIEWER_SOURCE_REVISION` 三处一致）。

### 最终验证（审阅修复后）

```
node --test tools/*.test.mjs        # 219 pass / 0 fail（problems 38 + service 38 + 其余）
cd viewer && node --test *.test.js  # 220 pass / 0 fail
openspec validate p12-problem-ops --strict   # valid
./verify.sh                          # 全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
grep 20260826-16 viewer/index.html viewer/app.js   # 1 / 10（含 VIEWER_SOURCE_REVISION）
```
