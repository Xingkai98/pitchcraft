# 判据镜进度（y 轴 / `FORM_SPREAD_Y` 候选复核）· 2026-10-14

里程碑（每完成一项一行）：

- [材料] BRIEF / PREDICTION / REPORT / READINGS / `L1-*.txt` / logs / png / probe-src 全读；`like-football.mjs` / `spacing-sweep-core.mjs` / `detectors.mjs` / `match-metrics.js` / `realism.rs` / `p16_spatial_features.rs` 关键段全读。
- [环境] `/tmp/judge-y-axis` = main `3db023f`，tracked pristine（`git status` 只剩本 notes 目录）。
- [指纹] 自写 `patch.py`（**不抄候选**）逐点复现候选 `lib16`；**Q 用候选 mk.py 的替换文本复现 `92ca7cc2cf05e1e7`**；我自己写法的 Q 产出的 **wasm 与候选逐位相同**（`cafcc6d2d7b7c8fc`）⇒ Q 语义确认。
- [基线] 自建 wasm16 = `b0bc479678af53aa`（= 候选）；`like-football` 距离 **0.520**，9 行逐位一致；`realism --ignored`（pristine）**9 passed / 0 failed / 215 s**。
- [预注册时序] `PREDICTION.md` 16:12:15 < 第一个扰动点 patch 16:12:23 / 读数 16:12:45 ⇒ **先写再跑** ✅。
- [复现·读数] `lf-{base,p110,p090,p085,q077}` 五份与候选 `diff` 为空；`sp-{p110,p090,p085,q077}` 四处 `findings=0` 且逐行相同。
- [复现·L1] 自写 `judge-bands.rs` 逐点复跑：**base 0 破 / 1.1 破 3 / 0.85 破 3 / 0.6 破 3**，逐带值与红测试名**逐位/逐名吻合**。
- [重点核 5 · 地雷带] **pristine main** 上 7 个不相交 200 场块：`0.7211 / 0.7382 / 0.7143 / 0.7273 / 0.7184 / 0.7297 / 0.7102` ⇒ **3/7 破**（候选 0.7143 逐位复现）✅；**另发现 `角球单场max` 也是地雷**（块 1601–1800 = 16 > 15）。
- [重点核 2 · spacing] 自写 `myspacing.mjs` 五点全复现：`2.1372 / 2.1383 / 2.1365 / 2.1393 / 2.0616`，**最紧 pair 每点换人**（18,15 → 2,4 → 15,12 → 1,4 → 14,13）⇒ 「坪」实锤；**机制查明 = `SAME_TEAM_MIN_DIST_M = 2.2` 分离机械**。
- [证伪 4 · 球位] 逐帧全样本（n≈27000）球位 **单调下降 11.48→9.50**，候选的 20.25→18.32 是**事件 `ball` 字段子样本（n=348）**；且**引擎球位本来就比真实更靠中路（0.72×）**。
- [证伪 8 · iy] 新建 `iy=0` wasm：`width` **49.69→48.75（−0.94 m）** ⇒ 候选「iy 一阶贡献为 0」错；残差 = 实现压缩(−0.6) + 抖动扩张(+0.9) 的净额。
- [证伪 9 · Q vs P] 推得 **`P(S) ≡ Q(c) ⟺ S = (1.21c − 0.3)/0.7`**；建 `P@0.90243` 实测：距离 **0.499 < Q 0.502**、**L1 破带 2 vs 2**（红测试名相同）⇒ 候选「Q 略优」两条支柱全塌。
- [证伪 10 · 真门破] 另起两棵树复跑：`p32_interception_self_consistency` 与 `goal_kick_amplifier_matches_the_pinned_share` 在 **0.85 FAILED / 0.60 ok**（与候选日志一致但**分类相反**）；且读 `lib.rs:1613` 记账点证明 **p32 结构上测不到「拦截概率漂移」**。
- [口径审查] 门禁未改 ✅；L1 交付文件干净（我的独立重跑背书）✅；真实锚 = committed 基线 ✅；`width` 是 max−min（逐窗 sd：引擎 0.2 vs 真实 9 m，见报告 §5.4）；`strip-*.png` = 6 面板轨迹条带，口径无误 ✅。
- [报告] `REPORT-judge.md` 落盘：逐条判决 + 并排数字 + 10 条错误清单 + 带余量表 + 5 条新机制 + 7 条「未能证伪」。
- [结束态] `git checkout` 后 `engine/src/lib.rs` sha16 = **75190e51f5b28876**，`viewer/engine.wasm` 还原为基线构建；`git status` 只剩本 notes 目录。**未 push / 未 merge / 未开 PR。**
