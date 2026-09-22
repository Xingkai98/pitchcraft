# Grill 复核：交付验收 + §D0 机制（第 3 轮）

> 审阅者 = 写 `grill-design.md` / `grill-verification-round2.md` 的同一人。
> 全部数字在**隔离 worktree**（`/tmp/grill-v4`，已删）从 commit `b244bab` 源码重建 wasm 实测。
> 交付 wasm = `67515c05`。

---

## 一、验收主张：**全部独立复现，无虚报**

| 实施者主张 | 我的独立实测 | 判定 |
|---|---|---|
| 交付 wasm `67515c05` 可从源码重建 | `67515c05`（逐位） | ✅ |
| `cargo test` 默认套件 **129p/0f**（硬要求） | `129 passed; 0 failed` + `4 passed; 0 failed`（realism 非 ignored） | ✅ |
| L1 九门 **9 绿 0 红** | `9 passed; 0 failed; 4 filtered out` | ✅ |
| 基线指纹一致、哨兵绿 | 基线 `wasmSha256` 前 16 位 = `67515c058ab66c72`，`sourceSha256` = `6749bc12ba03c220` = 当前 `lib.rs` | ✅ |
| §D0 行为等价（60 seed 流哈希 `44599dcead734d86`） | 加/不加注释两个 wasm **都是** `44599dcead734d86`，含 seed 1 / seed 60 逐条 | ✅ |

**「没删测试没放宽」我逐条查了**，两处修复都是**语义重写**而非放宽：

- `v2_tackle_frequency_in_target_range`：旧带 `[3,14]` 守的是 **P7 槽位机制**
  （注释原文「tackle 槽 22% × 32 ≈ 7 槽/场」），而**槽位层已在 P31 删除**——
  该带守护的机制**已不存在**。改为与 `realism.rs` 抢断体量带**同源**的
  `mean ± 1.5sd`（StatsBomb `Duel/Tackle` n=170：36.90 / 8.87 → `[24,50]`）。
  **这不是「放宽以通过」，是「换掉一条守护已删机制的断言」。** ✅
- `p30_window_foul_cancels_without_shot`：重选几何（`d ≈ 1.05m → 3.15m`），
  且**保留全部防空转守卫**（`assert_eq!(select_defensive_action(...), Foul)` 前置、
  `n_foul > 0`、`n_other > 0` 对照口径）。✅

**看图我也独立读了**（`/tmp/p104-side.png` 三方并排）：左=真实 Metrica 是满场**弯钩网**，
中=干净 main、右=候选**都是水平短轨带**。**候选确实没有引入新形态**，与实施者所述一致；
候选的线略长、略散（与 latSd / 直线度的数字方向一致）。**这条视觉结论我确认成立。**

---

## 二、§D0 的**机制描述不准确**——结论对、归因错（建议改写）

实施者写：「**rustc 会在 wasm 里嵌调试行号表**（panic 消息的 `file:line` 需要它）」。

**实测不成立。** 我解析了交付 wasm 的 section 表：

```
id=1 type / 3 func / 4 table / 5 memory / 6 global / 7 export / 9 elem /
id=10 code / id=11 data / id=0 custom:"name" / custom:"producers" / custom:"target_features"
```

**没有任何 `.debug_*` 段**，`engine/Cargo.toml` 也没有开 debuginfo。所以它不是「调试行号表」。

**真实机制（字节级定位）**：加一行注释产生 **74 处 1 字节差异**，分布：

| 位置 | 数量 | 内容 |
|---|---|---|
| `data` 段 | 64 | panic 的 `Location{line,col}` 常量——**每一处都是 `+1`**（如 `0x4A→0x4B`），即行号真的平移了 1 |
| `name` 段 | 10 | LLVM 内部符号哈希 `llvm.4657078260010199458` → `llvm.1742829092740475183` |

所以准确表述是：**rustc 把 `panic!` 的 `file:line` 作为静态数据嵌进 `data` 段，Rust 内部符号名带 LLVM 内容哈希嵌进 `name` 段；加/删注释行使行号平移 → 两处都变 → 文件哈希变，而行为不变。**

**为什么这个区别要紧**：机制描述会引导后人的**处置方向**。按「调试行号表」的说法，
自然推论是「观上 debuginfo 就好」——**我实测了两条路，都不行**：

```
-C strip=symbols : 67515c05 → 加注释后 1cec2fad（仍变）
-C panic=abort   : 67515c05 → 加注释后 4d674d64（仍变）
```

（`strip=symbols` 只切掉 `name` 段的 10 处，`data` 段的 64 处行号常量还在，所以照变。）
**即：没有便宜的构建配置能消除这个不稳定，实施者的应对（源码不引用自身哈希 + 基线
`engineFingerprint` 为准）是正确且唯一可行的路子。** 结论不必改，**只需修 §D0 的机制句**，
免得后人去试 `strip`/`debuginfo=0` 而浪费一轮。

**关于「建议为它立哨兵」**：我倾向**不必新立**。P38 #87 的
`engineFingerprint`（`tools/benchmark-baseline.test.mjs`，已验证会红）**已经**是该坑的哨兵——
它正是靠「源码哈希 vs 基线记录的源码哈希」发现漂移的。再立一条会与该哨兵重叠。
真正值得做的是在 `CLAUDE.md` 的「比赛标尺」一节加**一句**「改注释也会改 wasm 哈希，
读数请引流哈希/基线指纹，勿引构建哈希」——文档级提示即可，不需要新机制。

---

## 三、我**没有**复核的部分（本轮边界）

- **`criteria-comparison.md` 的 8 条逐项**：我只读了它的结论（`swarm` 真回归一条）。
  实施者报「`midBack` 噪音翻绿」——**未独立复算**。
- **`notes/visual-check.md` 的量化数字**（latSd 0.64→0.43、直线度 0.143→0.218）：
  我**读了图**确认形态结论，但**没有**重跑渲染探针复算这些数。
- **第 1 轮审阅报告（`reviews/review-round1.md`）的 3M/4m 修复质量**：
  我只验了其中 `v2_tackle_frequency` 与 `p30_window_foul` 两条（它们同时也是 B1 项），
  其余 5 条**未逐条复核**。
- **第 2 轮审阅（`review-round2.md`）**：实施者称进行中，我没有它的内容。

---

## 四、一句话结论

**交付验收的全部主张我都独立复现，无虚报；两处「改门」是语义重写而非放宽，我确认为正当。**
唯一需要改的是 **§D0 的机制句**（不是「调试行号表」，是 `data` 段的 panic 行号常量 +
`name` 段的 LLVM 符号哈希），**结论与应对不变**——但准确的机制能阻止后人去试
`strip`/`debuginfo=0` 这两条我已证明无效的路。
