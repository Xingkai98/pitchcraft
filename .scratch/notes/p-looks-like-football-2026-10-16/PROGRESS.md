# PROGRESS — PANEL-CALIBER.md 起草过程（每步一行）

1. 列全 6 份判词 + 4 个 judge 工作目录 + 刺激集 KEY/audit + 仓内 3 个既有量文件的存在与大小。
2. 读 J1–J3（48 张轮）判词：确认其为 **24 个场面 ×2 拷贝**（KEY `pairChecksSummary`：引擎 12 对逐字节相同、真实 7/12 相同），四组 6/6 不构成独立验证。
3. 读 J4–J6（clean 24 张轮）判词：三轮各自给出 12/12，且三份判词的主判据收敛到同一批（门位点钉死 / 两队横向 y 跨度 / 逐比特冻结 / 贴身对）。
4. 读裁判脚本：`judge-discrim-2/{feat,analyze,static,motion,shape,gk,final}.py`、`judge-clean-2/{blobs,motion,motion2,rigid,structstat,template,lateral,frozen,gk,final}.py`。
5. 读刺激集口径：`discrim-clean/KEY.json`（修复规则、死球规则、seed 阶梯、独立性检验）、`audit-clean.json`、`gen-clean.log`、`DESIGN.md` / `DESIGN-CLEAN.md`。
6. 读仓内既有量：`viewer/match-metrics.js`（口径 1–8 与 q10–q90）、`tools/visual-review/motion-metrics.mjs`（disp/dir/still/lat/mix）、`tools/visual-review/like-football.mjs`（9 行表 + width 降级为报告行的理由）、`viewer/data/benchmark-baseline.json`（committed 锚）。
7. **复算 1（P1）**：从裁判自己的 `blobs.json` 逐面板算两队 y 跨度 → 「两队双双 ≥45 m」引擎 42/42、真实 0/42；剔 `|x|>44` 门位点后**同值**（⇒ P1 不是门将的导出量）。
8. **复算 2（N 类）**：全局 sd_x 含门将 22.1–23.9 vs 14.9–20.3（完全分离）；剔 `|x|>44` 后 16.8–18.9 vs 11.0–19.9（**重叠**）⇒ sd_x 与「全队 x 跨度 100.3 m 恒定」都是 P4 的导出量。
9. **复算 3（P3）**：逐栏相邻 2.4 s 的「逐比特不动」球员数 → 引擎 6 张接触表 30 步里 206 人次不动（单步最多 19/21），真实 30 步里仅 1 人次；阈值 0.01 m 与 0.05 m **同值**（207/1282）。
10. **复算 4（P5）**：面板级「异队最近距离 <2 m」真实 18/42、引擎 0/42；「跨队 8 m 内配对数 ≥5」真实 41/42、引擎 0/42（唯一例外 XS 第 3 格 = 4 对）。
11. **复算 5（R3 反证）**：现有 `mixing`（最近邻是异队占比）剔门位点后引擎 0.739 vs 真实 0.739 ⇒ **该行在 24 张上零分辨力**，裁判的「贴人」信号在距离分布尾部而非典型最近邻。
12. **复算 6（R2/N1）**：球 12 m 内人数 引擎 1.67 vs 真实 3.50（区间重叠）；「离球 40 m 内占比」引擎 0.52–0.89 vs 真实 0.43–0.96（**不分**）。
13. **探针（真实侧门将可识别性）**：读 `viewer/data/real-game-{1,2}.json` 六个静帧时刻，**id 0 / id 21 恰是各队最深球员（6/6 例）**，距门线 2.9–22.5 m ⇒ 解掉 J5 §4「真实侧 NB/OX/SZ 门前没人」的疑问（不是没人，是门将没贴线）。
14. 核对裁判自表的一处自相矛盾：`judge-clean-1/_single_feats.json` 里 `stim-VB` 的 `near8=0` 与自报最近跨队 5.22 m 冲突（该字段疑为「球周人数」而非跨队对数）；已在文档中标为「引用前须复算」。
15. 核对引擎指纹：刺激集用的引擎（wasm `9ea317b2…`）**不是** committed 基线里的引擎（wasm `574b653f…`）⇒ 任何「引擎基线」列必须重算。
16. 落盘 `PANEL-CALIBER.md`（v1 草稿）。

---

# PROGRESS — 真实侧扩容 2 场 → 22 场（SkillCorner opendata）

**日期**：2026-10-16 · 交付见 `REAL-CORPUS.md` · 逐场表在该文件 §2

1. 读背景：`PLAN.md`（扩样本是本层最重要一步）、`PANEL-v1-FROZEN.md`（§6 第 1 条即本任务）、
   两个转换器（289 + 613 行）、`match-metrics.js` 的采样/切窗口径。
2. 探网：codeload tar.gz 200（25.7 MB / 5.1 s）；media 通道对 tracking 实体 206（LFS 指针报 90 729 279 B）。
3. **异常 A**：`fetch-tracking-data.mjs` 第 1 步竞态（`curl()` 是 async 但未 `await`，紧跟的 `sh('tar')` 读到不存在的文件）⇒ 裸跑必失败。
   该文件禁改（指纹哨兵）⇒ 用**同一 URL** 手工铺骨架到脚本期望路径。
4. 骨架落位：`opendata-master/`（105 MB），`matches.json` 20 场。
5. 启动下载（`nohup … > /tmp/fetch-skillcorner.log`），`18:16:25` 起，6 路并发。
6. `+20 s`：12/20 已完整；`+84 s`（`18:17:49`）：**20/20 完整、0 场失败、0 次续传重试**，1.7 GB。
7. 首场转换 `1874553`：5.2 s，22122 帧 / 21.42 MB / 方向自检通过 ⇒ 配方成立。
8. 其余 19 场批量转换：95 s，全 OK（合计转换耗时 ~100 s）。
9. 写探针 `/tmp/probe-skillcorner.mjs`：逐场 `fromTrackingFrame`（全量，不只抽样）。
10. **探针自纠 1**：`windowMetrics` 抛 `object is not iterable` —— 是我传参错（传了 `meta.pitchMeters`
    对象，生产路径 `benchmark-baseline.mjs:120-122` 折成 `[L, W]` 数组）⇒ 改成与生产同口径后 0 错。
11. **探针自纠 2**：我最初把「t 不在 0.2 s 绝对栅格上」（55% 帧）判成缺陷——**是错的**：
    SkillCorner 的 t 是比赛时钟、相位任意且无害；真正要验的是「按下标每 12 帧的跨度 = 2.4 s」。
    改成量跨度后确认：偏差只出现在转播缺口处。
12. 探针全跑：**20/20 无问题**（0 抛错、0 非有限坐标、0 方向自检失败）；
    实测间隔异常处数与转换器自报缺口数**逐场精确相等**（62/62 … 73/73）。
13. 探针 2（全 139 个 300 s 窗真跑 `windowMetrics`）：139/139 消费成功；
    发现 **primary 口径可用帧均值 466 / nominal 1500（Métrica 侧是 1500/1500）**。
14. **独立复核**：`node tools/benchmark-baseline.mjs --out /tmp/baseline-regen.json` ⇒
    `datasets.skillcorner` 与 `datasets.metrica` 两段**逐字节相同**（vs 已入库基线）。
15. 核对未动任何 tracked 文件：`git diff --stat` 只有进任务前就存在的 `M engine/src/lib.rs`；
    新增产物全在 gitignore 路径内。基线 `engineFingerprint` 差异（`9ea317b2…` vs `574b653f…`）
    是那棵脏树的既有后果，与本次扩容无关。
16. **落盘 `REAL-CORPUS.md`**（逐场表 + 配方 + 耗时占用 + 异常清单 + 面板影响 + 复现证据）。
17. 探针留在 `/tmp`（**仓外**，不入库、不进 git status）；**仓内新建文件 0 个**。

---

# PROGRESS — 面板 v1 实现与重标定（22 场真实 × 现构建 main 引擎）

**日期**：2026-10-16 · 交付见 `PANEL-CALIBRATION.md` · 工具 `tools/visual-review/panel.mjs`

1. 读三份定稿口径（FROZEN v1 / PANEL-CALIBER / REAL-CORPUS）+ PLAN；核仓内既有量
   （`match-metrics.js` / `motion-metrics.mjs` / `like-football.mjs` / `benchmark-baseline.json`）。
2. **现构建干净树 wasm**：`git worktree add /tmp/panel-clean origin/main`（detached `50b2c8a`，
   工作树干净）→ `cargo build --target wasm32-unknown-unknown --release`。
   ⚠️ `cargo` 不在默认 PATH，须 `export PATH="$HOME/.cargo/bin:$PATH"`（`verify.sh:11` 同做法）。
   指纹：`lib.rs 75190e51f5b28876` / `wasm b0bc479678af53aa`。
3. 实现 `panel.mjs`：11 条口径规则逐条落点写进文件头；coarse=300 s（仓内口径）/ fine=12 s×6 栏
   （下标步长 12 帧 = 2.4 s × 5 Hz）；primary/allPoints 双口径贯穿；帧有效性沿用 `match-metrics` 口径 7。
4. **最小自证**（`--selftest`，8 组断言）：剔门将（含反证条）、逐帧→比率（含"窗均值会判成 1"的反证条）、
   跨场不拼接、fine 栏距=12 帧、primary 跳外推、P3a 冻结计数、P2 双向对称。
   ⚠️ 自证**没进 verify.sh / CI**（纪律要求）。
5. **自证过程中抓到自己一个 bug**：`sampleEngineFrames` 返回的 `players` 是**普通数组**
   （实测顺序 `[0,1..10,21,20,…,11]`，客队倒序），而我按**下标**取门将 ⇒ 把客队门将读成
   x≈0.36 的中场，"门将位移 386 m"。改成 `byId()` 按 id 取后：主 8.2 / 客 4.8 m（300 s 窗）、
   距门线 2.108 / 2.055 m。**真实侧数组下标恰好 = id，故只有引擎侧会中这个坑。**
6. **独立探针复核 P5**（`/tmp/probe-p5.mjs`）：main 现构建引擎 `<2 m` **7.6% 的帧**、
   `8 m 内 ≥5 对` **12.4%**，逐帧 `d_min^cross` 最小 **0.000**。再抽帧看（`/tmp/probe-p5b.mjs`）：
   t=75.2 s 时 id 7(主)/id 14(客) 与球同在 `(0.462,0.660)` ⇒ **异队争球**（同队最近邻 <0.5 m 帧占比 0.0000）。
   ⇒ FROZEN 记的"引擎 0.00 / 0.00"已失效。
7. **独立探针复核口径**（`/tmp/probe-baseline.mjs`）：本面板的引擎侧管线与 committed 基线
   **逐位一致**（hd/ad/spread/gap/width/ballDist 最大绝对差 `0.000e+0`，5 种子 30 窗）；
   真实侧 `gap` 亦逐位一致（Metrica 8.323166302431668 / SkillCorner 5.2356922083457516）。
   ⇒ 两侧读数同源可比，且 main 现构建与基线行为等价（lib.rs sha 不同但六个量相同）。
8. 全量跑（`--dataset all`，约 60 s）：真实 22 场 / 173965 帧（窗内）/ 41288 fine 窗；
   引擎 5 种子 / 45000 帧（窗内）/ 11230 fine 窗。
9. **抓到一个口径陷阱并定量核过**（`/tmp/probe-gk.mjs`，`skillcorner-1874553`）：
   真实侧门将槽位在 SkillCorner 上**只有 3137/22122（14.2%）帧被检测到**；检测帧 x 中位
   **3.29 m**、外推帧 x 中位 **13.54 m** ⇒ primary 口径留下的是"门将恰好被检出"的偏差子样本。
   这解释了 P4 位移量在 primary 下"重叠"、allPoints 下干净分离。**不是 bug，是数据属性。**
10. 阈值重算（三条）：规则 = 近优区间（`sep ≥ max − 0.10`）中点；FROZEN 值处余量并列。
    `T=44`（合并余量 0.852，极端不相交区间 [33.75, 49.75]）、`<2 m`（0.434，[0.85, 6.60]）、
    `8 m·≥5 对`（0.769，[4, 11]）⇒ **三条都仍在可分区，维持不动**（理由含"引擎仅 5 独立种子"）。
11. 逐条分离度（两口径各一张表）⇒ **5 保留 / 3 降级 / 1 删 / 3 升格候选**（见 `PANEL-CALIBRATION.md` §5）。
12. 落盘 `PANEL-CALIBRATION.md`（复跑命令 + 指纹 + 逐条双口径分布 + 阈值与余量 + 三分类 + 与 v1 的差异 + 风险）。
13. `panel.mjs` 新增自检：`node --check` 通过；`--selftest` 通过；改后重跑 `--dataset all` 复现同值。
14. **未动**：引擎源码/带/常量/基线、`tools/*.test.mjs` 既有断言、`verify.sh`、CI；未 push/merge/PR；
    未派 subagent。工作树里 `M engine/src/lib.rs` 是进任务前就有的，本任务未碰。
