# Phase 0 性能 smoke（P1 / 2.8 & 2.13 第一刀）

日期：2026-11-23
分支：`p1-phase0/2026-11-23`（引擎 = main v11；`engine/src` 与 `main de239d1` 逐字节相同）
性质：**本机实测**（不是 CI 数据），全部数字都带命令与口径。

> **这是 v11 的分母，不是 C1 的读数。** design D7.5/D13 #12 的「活体 5× + 规划」要等 C1a
> 实现后才能测；本文件只给同配置 v11 的基线，供 C1 对照，不冒充 C1。

## 0. 本机

| 项 | 值 |
|---|---|
| CPU | Intel Celeron N5105 @ 2.00 GHz（4 vCPU，max 2.9 GHz） |
| RAM | 7 GB（测量时空闲 ~2 GB） |
| OS / kernel | Linux 6.18.15 |
| Node | v22.22.2 |
| Rust / cargo | 1.97.1 |
| wasm | `viewer/engine.wasm`，SHA256 `f6a9f9ec…0ec92f`（与 Change 0 记录逐位相同） |

⚠️ 这是**低功耗小机器**：绝对时长比 CI/开发机更保守。跨机型比较请同时看 `cargo test`
的机型代理（CLAUDE.md 记忆 `ci-runner-speed-varies`）。

## 1. 命令与结果

### 1.1 `cargo test --release --test realism`（默认套件：L2 300 场 + golden + 契约测试）

```bash
cd engine && time cargo test --release --test realism
```

| 读数 | 值 |
|---|---:|
| 测试执行 | **259.26 s** |
| 墙钟（含编译检查） | **4 m 19.72 s** |
| 结果 | 8 passed / 0 failed / 9 ignored（现树） |

### 1.2 `cargo test --release`（全 target，默认非 ignored）

```bash
cd engine && time cargo test --release
```

| 读数 | 值 |
|---|---:|
| 墙钟 | **9 m 23.33 s**（4 vCPU 机器；user/wall ≈2.0×，不是 4× 线性并行） |
| 结果 | 全部绿（含 lib 单测 + realism 8 + doc-tests 0） |

修复后复跑 `cargo test --release --tests --no-fail-fast`：**8 m 11.35 s，exit 0**（全绿）。
（两者引擎/行为相同，只差 doc-tests 与测试代码；取哪次作分母都行，本文件其余表用前者。）

### 1.3 L1 200 场 + 主客 600 场（`--ignored l1_`，release）

```bash
cd engine && time cargo test --release --test realism -- --ignored l1_ --nocapture --test-threads=1
```

| 读数 | 值 |
|---|---:|
| 测试执行 | **667.67 s** |
| 墙钟 | **11 m 10.93 s** |
| 覆盖 | `l1_stats()` 200 场（seeds 401–600）+ `ha_stats()` 600 场（401–1000） |

⇒ **C1 的 L1 硬门（design D13 #12：L1 ≤2× v11）在本机按墙钟 670.93 s 换算为 ≤ 1341.9 s（22 m 22 s）**
（若只算测试执行 667.67 s，则 ≤1335.3 s；取更保守的墙钟口径）；
design D7.5 的「目标 ≤15 min」在 v11 本机已满足（11 m 11 s），余量约 3 m 49 s。

### 1.4 wasm `simulate`（90 min / 5 min，单 seed）

脚本：`notes/probes/perf-smoke.mjs`（Node，加载现构建 wasm → `simulateStream` → JSON）。

```bash
node openspec/changes/p1-motion-integration/notes/probes/perf-smoke.mjs \
  viewer/engine.wasm --out openspec/changes/p1-motion-integration/notes/perf-smoke-v11.json
```

| 读数 | 5 min（seed 42） | 90 min（seed 42） |
|---|---:|---:|
| wasm `simulate` | **72.4 ms** | **909.1 ms** |
| 事件流 JSON 字节 | **904,162 B（0.90 MB 十进制）** | **16,473,143 B（16.47 MB 十进制）** |
| `JSON.parse` | 10.2 ms | 270.0 ms |
| `createGame`（viewer 建索引） | 71.6 ms | 848.9 ms |
| **viewer 加载合计**（simulate+parse+createGame） | **154.3 ms** | **2,028.0 ms** |
| wasm 实例化（5 次中位；min/max） | 1.14 ms（0.92 / 2.25） | 同左（同一 wasm） |
| seek+读帧 mean / p95 / max | 0.0846 / 0.1474 / 0.6099 ms | 0.0446 / 0.0886 / 0.9783 ms |
| Node RSS（该档后，MiB） | 96.6 MiB | 354.0 MiB |
| Node 峰值 RSS（VmHWM，全脚本，MiB） | — | **363.5 MiB** |

单次测量；重复运行有约 5–10% 波动（**本会话观察**，未落成独立产物）。RSS 单位是 **MiB**（`/1024/1024`），
JSON 字节转 MB 用十进制（`/1e6`），两者不混。

**硬门核对（design D13 #12 / D7.5）**：

| 门 | 阈值 | v11 实测 | 结论 |
|---|---|---|---|
| wasm 90 min `simulate` | **≤10 s** | **0.909 s**（11.0× 余量） | v11 通过；C1 尚待测 |
| viewer 5 min 加载 | 目标 ≤1 s | 0.154 s | v11 通过 |
| viewer 90 min 加载 | 目标 ≤10 s | 2.028 s | v11 通过 |
| seek | ≤50 ms | mean 0.0446 ms / p95 0.0886 ms | v11 通过（p95 余量 ~560×） |
| 帧耗时 | ≤16 ms（60fps） | seek+读状态 p95 0.0886 ms | v11 通过；不含 Canvas 光栅 |
| JSON 体积（90 min） | 正常 ≤3× v11、密集 ≤5× v11（design D7.5） | 分母 **16.47 MB** ⇒ 门 ≤49.4 MB / ≤82.4 MB | 分母已落盘 |
| 峰值内存（90 min viewer 链） | ≤2× v11 | 分母 **363.5 MiB** ⇒ 门 ≤727.0 MiB | 分母已落盘 |

## 2. 未覆盖 / 不达标项（如实记录）

- **C1 的「活体 5× + 规划」未测**：运动子步、22 人前视规划、候选拒绝/重试、计划缓存在 v11
  里不存在。本文件只提供分母；D7.5 前视规划表（规划次数/视野/拒绝率/缓存/复用率）全部**待 C1a**。
- **debug 套件未测**：本刀按任务书只测 release。CI 的 PR 门跑 debug（design D7.5 的
  「`cargo test` 默认（debug）」列仍未填），`p124` debug 30 seed、`spacing-sweep` 也未测。
- **帧耗时不等于 Canvas 渲染**：本读数是一次 `seekTo` + 读公开观测面的成本；真实
  `renderFrame(t)` 的光栅成本不在其中（那是 viewer 层，C1 不改渲染路径）。
- **RSS 是 Node 进程**：含 5 min 与 90 min 两档同进程的残留；90 min 的档后 RSS 是上界，
  峰值 VmHWM **363.5 MiB** 更保守。容器/CI 的内存统计口径可能不同。
- **wasm 与 native 事件流不逐位相同**（记忆 `wasm-vs-native-streams-diverge`）：本文件的
  wasm 读数用于性能，不替代 `cargo test` 的统计门。

## 3. 结论

v11 同配置基线已落盘：**L1 11 m 11 s、wasm 90 min simulate 0.909 s、viewer 90 min 加载
2.03 s、seek p95 0.0886 ms、90 min JSON 16.47 MB、峰值 RSS 363.5 MiB**。

**已测的** release / wasm / viewer 门在 v11 上都有宽余量；**未测的** debug 默认套件、`p124`、
`spacing-sweep` 以及 D13 #12 的「活体 5× + 规划」不在本结论内。C1 是否仍满足（尤其 2× L1 /
10 s simulate / 3× JSON）要等 C1a 实测，Phase 0 不提前判。
