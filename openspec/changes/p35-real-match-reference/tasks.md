# Tasks: 真实比赛对照

> 本 change 的实现先于 OpenSpec 文档完成（先做出可跑的原型再立项），
> 故本文件按**实际完成的工作**回填，并在每项标注验收证据。

## P1. 数据获取与格式转换

- [x] P1.1 `tools/fetch-tracking-data.mjs`：拉公开数据集（`DATASETS` 表为接入点），落 `.scratch/tracking-data/`，不入库
      —— Metrica Sports sample-data，3 场 25Hz；浅克隆 + 稀疏检出仅取 `data/`、`documentation/`。
- [x] P1.2 `tools/convert-tracking-to-frames.mjs`：tracking CSV → 帧序列 JSON（schema 见 design D7）
      —— 输出 `{ meta, frames: [{ t, players[22], ball }] }`；支持 `--keyframe-hz`（默认 5）、
      `--from/--to` 时间窗裁剪、`--ball-fill nearest|hold|none`。
- [x] P1.3 朝向归一：从数据检测半场方向，**在全量帧上判定**（不用裁剪窗口）
      —— `detectHomeAttackDirection()` + `makeNormalizer()`；结果写入 `meta.orientationDetected`。
      实测两场起始方向相反（game1 `[false,true]` / game2 `[true,false]`），转换后两场门将恒在 x≈0.1 / 0.9。
- [x] P1.4 身份映射到事件协议 id（0-10 / 11-21，门将占 0/21），含替补顶槽位
      —— 按折算到「该队攻向 x=1」坐标系的 depth 排槽位；替换规则保证每关键帧恒定 22 人（填充率 100%）。
- [x] P1.5 表头容错：容忍 `Player 26`（带空格）写法；疑似球员列解析失败**报错**而非静默丢人
      —— 实测该 bug 曾造成 game2 有 37.7% 的帧只有 21 人。
- [x] P1.6 数据质量如实统计进 `meta.coverage`（球缺失 / 坐标重叠 / 人数不足），不去重、不补假人
      —— 实测：球缺失 39.13% / 41.01%，坐标重叠 4.86% / 4.03%，人数不足 0%。

## P2. 播放层

- [x] P2.1 `viewer/tracking-player.js`：帧序列 → 每帧 `{ players, ball }`，含插值、播放控制、seek
      —— 与 `Game.step` 的 dt 钳制逐字一致（0.1s 上限且丢弃超出部分），保证并排对照不受播放器差异干扰。
- [x] P2.2 画面只由帧号决定：预计算 `lastKnownAt` / `lastKnownBallAt`，倒带不残留未来状态
      —— 球员、球位置与可见性三者都只由帧号推导；当前帧缺观测时用**过去**而非下一帧。
- [x] P2.3 缺球的可见性语义：首次观测前不渲染球（`ballVisible`），不给默认位置

## P3. viewer 接线

- [x] P3.1 数据源切换 UI（`#data-source` / `#tracking-select` / `#tracking-meta`）+ 数据质量信息条
- [x] P3.2 UI 三态（数据源选择 / 场次可见性 / 事件导航）从 `activeSource` 单一推导（`syncSourceUI()`）
      —— 此前三态各自命令式就地写，是同一族竞态反复出现的根因（见 P5.3）。
- [x] P3.3 异步加载作废：`loadSeq` 请求序号 + 调用方检查返回值；**每个改变数据源的路径都 bump**
      —— 含"已经是这一场"的早退分支（该分支曾是唯一 return 早于 bump 的路径）。
- [x] P3.4 按 key 缓存原始 JSON 文本，避免来回切换重复加载 18MB；
      **先解析成功再入缓存**（坏数据不留缓存，否则只能刷新页面恢复）。
- [x] P3.5 tracking 模式下拒绝观察采集（采集链路读引擎 `game`，会采到"引擎冻结的那一刻"）
- [x] P3.6 切到 tracking 时同步事件指示器（否则残留引擎的"事件 N/M"）

## P4. 测试（无视觉依赖）

- [x] P4.1 `tools/convert-tracking-to-frames.test.mjs`（29 用例）：解析 / 朝向检测（含两场相反朝向、
      纯 P2 样本、混合半场、出场极少者不参与、裁剪窗口不改变结论）/ 身份映射 / 替补顶槽位 /
      缺球补全三模式 / 重复坐标 / 人数不足 / 端到端
- [x] P4.2 `viewer/tracking-player.test.js`（22 用例）：插值 / 播放状态机 / dt 钳制 / 缺帧回退 /
      球不借未来帧 / 可见性只由帧号决定 / 倒带一致性
- [x] P4.3 `viewer/tracking-e2e.test.js`（5 用例）：真实数据 → `renderFrame` 像素断言
      —— 22 圆点 / 两队分色 / 两场各自的门将居本方半场（21 个时刻采样）/ coverage 如实 / 补全球位归持球者。
      数据缺失时整组跳过并打印生成方法。
- [x] P4.4 `viewer/app.test.js` 新增 13 个数据源相关用例（全文件 26–38 号）：加载 / 切回引擎 /
      数据缺失回退 / 播放推进 / 进度条逆映射（`startTime≠0`）/ 加载途中切回引擎 / 加载途中选回当前场 /
      竞态交错矩阵（7 场景）/ 导航处理器守卫 / 采集守卫 / 失败回滚下拉框 / 坏数据不进缓存 / 过期响应不覆盖
- [x] P4.5 `viewer/dom-test-harness.mjs` 增加 `driveFrame(ts)`：同步驱动一帧（rAF 仍是 no-op，
      不空转），使依赖"帧跑过"的状态可被断言

## P5. 验证与收尾

- [x] P5.1 `verify.sh` 全绿
      —— 引擎 + viewer 345 + tools 433 + WASM e2e + 间距滑窗 + 真实性套件，6/6 通过。
- [x] P5.2 真实数据端到端：两场转换产物渲染正确
      —— game1 29002 帧 / game2 28232 帧；每帧 22 人、填充 100%；门将恒在 x≈0.1 / 0.9。
- [x] P5.3 代码审阅闭环（独立 subagent，5 轮，直到通过）
      —— 审阅抓出的实质问题（均已修 + 补回归测试 + 变异验证）：
      半场方向硬编码致 game2 整场镜像 / 短窗口方向误判 / `Player 26` 解析丢人 /
      球借未来帧 / 倒带残留 / 数据源三态的 6 个竞态变体（F1 回滚空操作、F2 坏数据毒化缓存、
      F3 过期响应、X1 切引擎不丢在途、X2 早退不 bump、A/B 乐观写 UI）。
      终审：**通过，P1 归零**。
- [x] P5.4 设计说明与踩坑记录落盘：`.scratch/notes/real-match-reference.md`
- [x] P5.5 文档同步：`README.md`（怎么跑）、`CLAUDE.md`（对照数据这一节）、`.gitignore`（数据不入库）
- [x] P5.6 `openspec validate --all --strict` 通过
- [x] P5.7 从干净检出验证提交自洽（只带该提交跑测试全绿）

## 后续（下一个 change，不在本 change 范围）

- [ ] 量化指标对比：从真实数据与引擎数据**各算同一组统计量**（阵型宽度/纵深、全队重心、
      到球距离分布），把"感觉不对"变成可比的数字。本 change 已稳定其依赖的接口（帧序列 schema、
      `TrackingPlayer` 读写面）并记录实测基线（真实比赛队形宽度 ~40m、纵深 49–58m、
      宽度波动 29–52m）。该层不需看画面，可进 CI。
- [ ] 扩大样本：接入许可更清晰的公开数据集（如 SkillCorner，MIT），并处理其外推点标记
      （`is_detected`）——外推点坐标看起来正常但不可信，需标注或弱化显示。
