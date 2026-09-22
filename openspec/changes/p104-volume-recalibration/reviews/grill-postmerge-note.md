# Grill 合入后注记（post-merge）

> 审阅者 = 写 `grill-design.md` / `grill-verification-round2.md` / `grill-verification-round3.md` 的同一人。
> 本文件是**合入后**（PR #105 merged `2208ff4`）的一次抽验，**不改任何交付**，只记录一条文档不准确。
> 不阻塞、不建议回改（change 已合入、会话已归档；回改的成本 > 收益）——记在此供后续 change 参考。

---

## 一、合入状态：**全部主张经我独立验证属实**

| 主张 | 我的验证 | 判定 |
|---|---|---|
| PR #105 merged，merge commit `2208ff4` | `gh pr view 105` → `state: MERGED`，`mergeCommit.oid = 2208ff4931…` | ✅ |
| CI 双 check 绿 | `gh pr checks 105` → 两个 `verify.sh 全套` **pass**（9m28s / 11m32s） | ✅ |
| 本地 main 已快进 `6f5827f → 2208ff4` | `git rev-parse main` = `2208ff4`；`3902e61` 是其祖先 | ✅ |
| #104 已留言并 close | `gh issue view 104` → `state: CLOSED`，`closedAt` 08:27:04 | ✅ |
| 未 `openspec archive` | `openspec/changes/archive/` 无 p104 | ✅ |
| 未删远程分支 | `git ls-remote --heads origin p104-…` 仍在（`3902e61c…`） | ✅ |
| 未动 `.scratch/` | `git status` 仍 5 个未跟踪项，未入任何提交 | ✅ |
| 5 条 round3 MINOR 已修 | new-3 行号引用清零（三文件 grep `.rs:NN` = 0）、new-4 已改中性列举 + 明写「不要在这里写当前交付」、new-5 已补全为「`6f5827f` 源码 + 三条常量…」 | ✅ |

**注意**：CI 跑的就是 `verify.sh` 全套（引擎单测 + viewer 单测/DOM + tools 单测 + WASM e2e + realism L1），
所以「`./verify.sh` 9 步全绿」这一条**由 CI 独立复现**，不只依赖实施者自述。✅

---

## 二、⚠️ 一条文档不准确：§D0b 说 `engineFingerprint` 是 `#[cfg(test)]` 陷阱的哨兵——**实测不是**

`design.md` §D0b 末尾写：

> **不需要为本坑新立哨兵**：`benchmark-baseline.test.mjs` 的 `engineFingerprint`
> **已经就是**它的哨兵（靠源码哈希漂移发现）。

**实测不成立。** 我在隔离 worktree（从 `main` 建）复现了该陷阱：在生产段放一行含字面
`#[cfg(test)]` 的注释 → `cargo test` **3 条红**（与实施者报告一致）：

```
test tests::p31_landing_error_only_in_open_play_passes ... FAILED
test tests::p31_liveness_section_never_emits_events ... FAILED
test tests::p31_slot_layer_is_gone ... FAILED
test result: FAILED. 126 passed; 3 failed
```

**但同一次构建下，`engineFingerprint` 哨兵是绿的**：

```
$ node --test tools/benchmark-baseline.test.mjs
# 注：engine/src/lib.rs 已变更但引擎指标逐位一致（仅注释/重构）。
#     建议下次重生成基线以刷新指纹：node tools/benchmark-baseline.mjs
# tests 10 / # pass 10 / # fail 0
```

**原因**（读 `tools/benchmark-baseline.test.mjs` 的判定路径即可确认，与我实测一致）：
该哨兵在源码哈希变化后，会**重算引擎指标**再判断——「指标逐位一致 → 放行并打提示」。
注释里的 `#[cfg(test)]` **不改变编译行为**，引擎指标当然逐位一致 → **走放行分支**，
只是多打一行「建议重生成基线」。**它不会红。**

**结论**：§D0b 的**结论**（不需要新立哨兵）**仍然对**——因为**默认 `cargo test` 就是它的哨兵**
（三条 p31 测试会红，且它们本来就在 CI 里跑）。但**理由写错了**：
不是「`engineFingerprint` 靠源码哈希漂移发现」，而是「`cargo test` 直接抓到」。
两者对**处置**的影响不同：若后人信了 §D0b，会以为「改注释只会被指纹哨兵提示一下（无害）」，
而实际后果是**默认套件三条红**（会被 CI 拦）。

**建议**（供后续 change，不必回改本票）：
把 §D0b 那一句改为「本坑由**默认 `cargo test`** 直接抓住（三条 `p31_*` 红），
`engineFingerprint` 在此场景**不会**红（它只判行为是否变，而注释不改行为）」——
这样「改注释必须重跑默认套件」这条教训才有正确的因果支撑。

> ⚠️ 一并更正：同段说「已在 `CLAUDE.md`『比赛标尺』一节加一句文档级提示」——
> 我核对了 `CLAUDE.md`，加的那一句讲的是 **§D0 的 wasm 哈希**（改注释改哈希、读数引流哈希），
> **不含 §D0b 的 `#[cfg(test)]` 陷阱**。两坑虽同族，但提示只覆盖了前者。

---

## 三、一句话

**合入本身无问题——PR/issue/CI/main/约束执行我逐条独立验证属实**；
唯一发现的是一条**文档理由**写错（§D0b 的哨兵归属），**结论仍对、不影响交付**，
已记录供后续 change 修正。
