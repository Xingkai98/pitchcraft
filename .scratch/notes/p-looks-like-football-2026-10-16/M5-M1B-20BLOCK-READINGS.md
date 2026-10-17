# 落地树（M5 + M1b）20 块 × 200 场跨块读数（L3 三条带）

**日期**：2026-10-17 ｜ **跑的人**：审阅修复 agent（零上下文）｜ **动机**：`REVIEW-D.md` F1(ii)

**要解决的问题**：`f600cf0` 往规范正文写了一句「**落地树（M5+M1b）20 块不破**」，
但 `REVIEW-C.md` 的 **20 块扩扫只覆盖 M5-only 树**，落地树那份表**只有 10 块**（且 M5-only 恰在 `3801..4000` 破了 `sot`）。
⇒ 那是一个**没有覆盖支撑的声明**（不是数错，是**测到哪**与**没破**被混为一谈）。
本文件是**补跑**的落盘：**在落地树上真的扫了 20 块**，把读数与复现命令写死在此，供下游追溯。

---

## 0 口径（缺一不可）

| 项 | 值 |
|---|---|
| 树 | `/tmp/fix-m5m1b` @ **`f600cf0`**（PR 分支 `p-looks-like-football/m5-m1b`） |
| `engine/src/lib.rs` | sha256 前 16 = **`077c31602e7c6b5c`**（= `f600cf0` 的源码；与基线记录的 `ad9c3ca531e3ba7c` 只差**注释行**） |
| profile | `--release` |
| 时长 | `DUR = 5400.0 s`（90 min，`engine/tests/realism.rs:24`） |
| 块 | **20 块 × 200 场，起点 `1,201,…,3801`**（= seed `1..4000` 连续无洞） |
| 判据口径 | 与 `l3_shot_ratios` **逐字相同**：`rect` = Σ`n_goal_in_rect` / Σ(`n_shot_goal`+`n_header_goal`)；`sot` = (goals+saved)/shots；`conv` = goals/shots |
| 带 | `rect [0.80, 0.91]`、`sot [0.28, 0.39]`、`conv [0.08, 0.14]` |
| 探针 | `engine/tests/realism.rs` 末尾临时追加 `#[ignore] zz_fix_coverage_blocks`（**跑完已删，不入库**） |

**探针源码**（逐字；跑完即从工作树删除）：

```rust
#[test]
#[ignore = "临时探针（复核 F1 的覆盖声明），不入库"]
fn zz_fix_coverage_blocks() {
    let starts: Vec<u64> = std::env::var("FIX_STARTS").ok()
        .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .unwrap_or_else(|| (1..=4000).step_by(200).map(|x| x as u64).collect());
    for st in starts {
        let stats: Vec<MatchStats> = (st..st + 200).map(aggregate).collect();
        let regular: usize = stats.iter().map(|s| s.n_shot_goal + s.n_shot_saved + s.n_shot_off).sum();
        let header:  usize = stats.iter().map(|s| s.n_header_goal + s.n_header_saved + s.n_header_off).sum();
        let shots = regular + header;
        let goals: usize = stats.iter().map(|s| s.n_shot_goal + s.n_header_goal).sum();
        let saved: usize = stats.iter().map(|s| s.n_shot_saved + s.n_header_saved).sum();
        let rect_goals: usize = stats.iter().map(|s| s.n_goal_in_rect).sum();
        println!("[FIX-BLOCK] {st}..{}  inside_rect={:.6}  sot={:.6}  conv={:.6}  (shots={shots} goals={goals})",
            st + 199,
            rect_goals as f64 / goals.max(1) as f64,
            (goals + saved) as f64 / shots as f64,
            goals as f64 / shots as f64);
    }
}
```

**命令**：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /tmp/fix-m5m1b/engine
cargo test --release --test realism -- --ignored --exact zz_fix_coverage_blocks --nocapture
# 日志：/tmp/fix-blocks20.log   （EXIT=0，20 块全部打印）
```

---

## 1 方法有区分度的自证（**先证探针与别人同口径**）

我的探针在**落地树**上给出的 `rect` 与 `REVIEW-C.md §1` 那 20 块**逐位相同**
（该表是在独立对抗镜自己的树上跑的；两条独立路径给出同一串六位小数 ⇒ 口径一致）：

| 块 | 我（落地树） | `REVIEW-C §1`（M5+M1b 列） |
|---|---|---|
| 1..200 | 0.826923 | 0.826923 ✓ |
| 201..400 | 0.848958 | 0.848958 ✓ |
| 401..600 | 0.838998 | 0.838998 ✓ |
| 601..800 | 0.832117 | 0.832117 ✓ |
| 801..1000 | 0.815157 | 0.815157 ✓ |
| 1001..1200 | 0.852941 | 0.852941 ✓ |
| 1201..1400 | 0.840580 | 0.840580 ✓ |
| 1401..1600 | 0.839623 | 0.839623 ✓ |
| 1601..1800 | 0.835466 | 0.835466 ✓ |
| 1801..2000 | 0.840336 | 0.840336 ✓ |
| 2001..2200 | 0.844710 | 0.844710 ✓ |
| 2201..2400 | 0.850091 | 0.850091 ✓ |
| 2401..2600 | 0.861759 | 0.861759 ✓ |
| 2601..2800 | 0.854779 | 0.854779 ✓ |
| 2801..3000 | 0.884892 | 0.884892 ✓ |
| 3001..3200 | 0.836466 | 0.836466 ✓ |
| 3201..3400 | 0.850829 | 0.850829 ✓ |
| 3401..3600 | 0.862944 | 0.862944 ✓ |
| 3601..3800 | 0.830537 | 0.830537 ✓ |
| 3801..4000 | 0.832155 | 0.832155 ✓ |

**20/20 逐位相同** ⇒ 探针不是空转、口径不是自造。另外门禁窗 `401..600 = 0.838998` 也与
`REVIEW-B §2.1` 的 L1 读数 `0.8390` 吻合。

---

## 2 原始读数（落地树，20 块；本文件是唯一落盘处）

```
[FIX-BLOCK] 1..200     inside_rect=0.826923  sot=0.380991  conv=0.116166  (shots=4924 goals=572)
[FIX-BLOCK] 201..400   inside_rect=0.848958  sot=0.383291  conv=0.120907  (shots=4764 goals=576)
[FIX-BLOCK] 401..600   inside_rect=0.838998  sot=0.383706  conv=0.117982  (shots=4738 goals=559)
[FIX-BLOCK] 601..800   inside_rect=0.832117  sot=0.373948  conv=0.115320  (shots=4752 goals=548)
[FIX-BLOCK] 801..1000  inside_rect=0.815157  sot=0.387131  conv=0.114886  (shots=4709 goals=541)
[FIX-BLOCK] 1001..1200 inside_rect=0.852941  sot=0.378333  conv=0.114214  (shots=4763 goals=544)
[FIX-BLOCK] 1201..1400 inside_rect=0.840580  sot=0.375371  conv=0.116999  (shots=4718 goals=552)
[FIX-BLOCK] 1401..1600 inside_rect=0.839623  sot=0.382201  conv=0.113929  (shots=4652 goals=530)
[FIX-BLOCK] 1601..1800 inside_rect=0.835466  sot=0.368189  conv=0.114627  (shots=4772 goals=547)
[FIX-BLOCK] 1801..2000 inside_rect=0.840336  sot=0.380396  conv=0.124088  (shots=4795 goals=595)
[FIX-BLOCK] 2001..2200 inside_rect=0.844710  sot=0.382580  conv=0.122109  (shots=4799 goals=586)
[FIX-BLOCK] 2201..2400 inside_rect=0.850091  sot=0.381867  conv=0.112970  (shots=4842 goals=547)
[FIX-BLOCK] 2401..2600 inside_rect=0.861759  sot=0.376268  conv=0.115345  (shots=4829 goals=557)
[FIX-BLOCK] 2601..2800 inside_rect=0.854779  sot=0.371525  conv=0.114575  (shots=4748 goals=544)
[FIX-BLOCK] 2801..3000 inside_rect=0.884892  sot=0.377736  conv=0.117003  (shots=4752 goals=556)
[FIX-BLOCK] 3001..3200 inside_rect=0.836466  sot=0.374739  conv=0.111065  (shots=4790 goals=532)
[FIX-BLOCK] 3201..3400 inside_rect=0.850829  sot=0.374659  conv=0.113908  (shots=4767 goals=543)
[FIX-BLOCK] 3401..3600 inside_rect=0.862944  sot=0.382762  conv=0.122741  (shots=4815 goals=591)
[FIX-BLOCK] 3601..3800 inside_rect=0.830537  sot=0.376217  conv=0.123472  (shots=4827 goals=596)
[FIX-BLOCK] 3801..4000 inside_rect=0.832155  sot=0.375416  conv=0.117720  (shots=4808 goals=566)
```

**派生（余量一律取「到最近沿」，与 `sot` / `rect` 同口径）**：

| 带 | 最坏块 | 值 | **到最近沿的余量** | 20 块内破沿？ |
|---|---|---|---|---|
| `rect [0.80, 0.91]` | `801..1000` | **0.815157** | **+0.015157** | 否（20/20 带内） |
| `sot [0.28, 0.39]` | `801..1000` | **0.387131** | **+0.002869** | 否（20/20 带内） |
| `conv [0.08, 0.14]` | `1801..2000` | **0.124088** | **+0.015912**（上沿） | 否（20/20 带内） |

（`conv` 的另一侧：最小 `0.111065 @ 3001..3200` ⇒ 到下沿 +0.031065 ⇒ **最近沿是上沿**的那 +0.0159。）

---

## 3 与 M5-only 的对照（**两棵树的覆盖不同、结论也不同**）

| 树 | `sot` 扫到哪 | 破沿块 | 出处 |
|---|---|---|---|
| **M5 单独** | **seed 1..4000（20 块）** | **2 块**：`201..400`（`0.392080`，+0.0021）与 `3801..4000`（`0.394586`，+0.0046） | `REVIEW-C.md §1.1④ / §4`；**我另在 `/tmp/fix-m5only`（`--detach 5ccc4cb`）上用同一探针只跑这两块复核，逐位命中**（见下） |
| **M5+M1b（落地树）** | **seed 1..4000（20 块）** | **0 块**（最坏 `0.387131 @ 801..1000`，余量 +0.0029） | **本文件 §2**（我自己跑） |

**M5-only 两块破沿的独立复核**（`/tmp/fix-m5only` = `--detach 5ccc4cb`，同一探针，只跑两块）：

```bash
git -C /tmp/tackle-el worktree add -f --detach /tmp/fix-m5only 5ccc4cb   # 再追加同一探针
cd /tmp/fix-m5only/engine && FIX_STARTS=201,3801 \
  cargo test --release --test realism -- --ignored --exact zz_fix_coverage_blocks --nocapture
```

```
[FIX-BLOCK] 201..400   inside_rect=0.832770  sot=0.392080  conv=0.122745  (shots=4823 goals=592)
[FIX-BLOCK] 3801..4000 inside_rect=0.858657  sot=0.394586  conv=0.116079  (shots=4876 goals=566)
```

⇒ `sot` 两块**逐位复现 `REVIEW-C`**；`rect` 两块也与 C 的表逐位相同（C：`0.832770` / `0.858657`）——
**第二次方法自证**。⇒ 规范正文里 `0.392080` / `0.394586` 两个数现在是**本仓可自证**的。

⇒ **`sot` 仍是三条 L3 带里最脆的一条**（余量 +0.0029，对比 `rect` +0.0152、`conv` +0.0159），
**但「落地树 20 块不破」这句话现在是**有覆盖支撑的**（此前它只是从 10 块 + 另一棵树的外推得到，
属 `REVIEW-D` F1(ii) 点名的「覆盖声明与实测面不符」）。

**域外（seed > 4000）两棵树都未证** —— 这条限制不因本文件而改变。

---

## 4 第三轮补齐的读数（`REVIEW-E` E1/E3/E4 的溯源）

上面 §1–§3 只覆盖**落地树的 20 块**与 **M5-only 的两块**。审阅指出：规范正文与 `lib.rs` 注释里
还有几个数**在本仓内没有出处**（唯一来源是未入库的审阅文件）。本节把它们**补测并落盘**，
使这些数**在本仓内可自证**。所有读数都用**与 §2 同一支探针的扩展版**（多打一列 `box_share`）跑出，
`--release`、`DUR = 5400 s`、每块 200 场。

### 4.1 M5-only（`/tmp/fix-m5only` = `--detach 5ccc4cb`）

```bash
cd /tmp/fix-m5only/engine && FIX_STARTS=401,801,2401 \
  cargo test --release --test realism -- --ignored --exact zz_fix3_blocks --nocapture
```

```
[FIX3-BLOCK] 401..600   inside_rect=0.817708  sot=0.377768  conv=0.120351  box_share=0.622633  (shots=4786 goals=576 regular=4489 n_box=2795)
[FIX3-BLOCK] 801..1000  inside_rect=0.807547  sot=0.375608  conv=0.112027  box_share=0.604223  (shots=4731 goals=530 regular=4452 n_box=2690)
[FIX3-BLOCK] 2401..2600 inside_rect=0.836237  sot=0.386792  conv=0.120335  box_share=0.640997  (shots=4770 goals=574 regular=4454 n_box=2855)
```

⇒ **逐位命中**规范正文里的三个 M5-only 数：
- **`401..600 = 0.817708`** ⇒ 正文的 **`0.8177`**（M5 单独门禁窗）—— **本节之前它在仓内无出处**；
- **`801..1000 = 0.807547`** ⇒ 正文的 **`0.8075`**（M5 单独最坏块）与余量 **`+0.0075`**（`0.807547 − 0.80`）；
- 同块的 **`sot = 0.377768`** ⇒ 正文的 **`0.3778`**（M5 单独 `sot` 门禁窗）；
- **`2401..2600 box_share = 0.640997`** ⇒ `REVIEW-C §5 P2-4` 的 `box_share` 跨块最坏值（余量 `0.65 − 0.640997 = +0.009003`）。

### 4.2 落地树（`/tmp/fix-m5m1b` @ `5117226`）同两块

```
[FIX3-BLOCK] 401..600   inside_rect=0.838998  sot=0.383706  conv=0.117982  box_share=0.612098  (shots=4738 goals=559 regular=4447 n_box=2722)
[FIX3-BLOCK] 2401..2600 inside_rect=0.861759  sot=0.376268  conv=0.115345  box_share=0.633466  (shots=4829 goals=557 regular=4518 n_box=2862)
```

⇒ 落地树在**同两块**上 `box_share` = `0.612098`（门禁窗）/ `0.633466`（M5-only 的最坏块），
余量分别 `+0.0379` / **`+0.0165`** ⇒ 都宽于 M5-only。

⚠️ **覆盖限制**：落地树的 `box_share` **只测了这两块**，**没有做 20 块跨块扫**
⇒ 「落地树 `box_share` 的跨块最坏」**在本仓内未证**（域外）。M5-only 的 20 块跨块最坏
也**只有 `REVIEW-C §5 P2-4` 的读数**（本节只复现了它点名的 `2401..2600` 那一块）。

### 4.3 arc-only 的 `0.8055`（`lib.rs` 注释用）

```bash
git -C /tmp/tackle-el worktree add -f --detach /tmp/fix-arc 5ccc4cb   # 再把远射档回退 (2,11)→(4,11)
cd /tmp/fix-arc/engine && cargo test --release --test realism -- --ignored --nocapture l3_shot_ratios
```

```
[L3] shots=4768 regular=4473 header=295 goals=581 saved=1213
     box_goals_legacy=493 0.8485 | slab=487 0.8382 | rect=468 0.8055 | sot=0.3763 conv=0.1219
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 64.97s
```

⇒ `lib.rs` 注释里的 **`0.8055`**（只动弧档 `rect` 过带）与 **`+0.0055`**（`0.8055 − 0.80`）由此可自证。
（`REVIEW-D §2.1` 另在它自建的 arc-only 树上独立复现，逐位相同，含 `shots=4768 … saved=1213`。）

### 4.4 `−0.4355 / 0.2430`（`lib.rs` 注释用）—— **可自证，靠的是同段已列出的 8 个观测中位数**

`lib.rs` 的 `keeper_line_dist_m` 注释**上一段**已经逐点列出了 8 个 `(节点, 观测分箱中位)`：
`5→2.18 / 15→2.93 / 25→4.38 / 35→7.12 / 47.5→10.95 / 62.5→15.48 / 77.5→19.84 / 95→21.86`。
把**末档节点**从 `95` 换成 `95.5`（算术中点）后做最小二乘：

| 末档节点 | 斜率 | 截距 |
|---|---|---|
| `95`（现行常量） | `0.243987` | `−0.463152` |
| **`95.5`（算术中点）** | **`0.243041`** | **`−0.435487`** |

⇒ 注释里的 **`−0.4355 / 0.2430`** 就是右列取四位的结果 ⇒ **仓内可自证**（数据在同一段注释里）。

---

## 5 本文件**不**主张的

- **不**主张 seed > 4000 也安全（没测）。
- **不**主张这三条带「余量充足」——`sot` 的 +0.0029 是**贴着上沿**。
- **不**主张 `conv` 的 0.0339（只摘下沿）那个数有效——本文件与规范正文**统一用「到最近沿」**。
- **不**改任何判据：本文件是**只读探针**的落盘，带值 / `DUR` / seed 集 / detector **一字未动**。
