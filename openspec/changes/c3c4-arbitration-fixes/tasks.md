# Tasks: C3 换人惩罚身份对齐 + C4 压迫/盯人仲裁顺序修正

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/match-engine/spec.md`（delta）
- [x] 1.2 手工核对 delta 头格式（本仓 `npx openspec` 不可用；对照既有 change）

## 2. C3：换人惩罚身份对齐（一次只改这一条）

- [x] 2.1 `MatchState.mark_prev` → `mark_prev_attacker`（防守者 id → 进攻者 id），换防守方重置
- [x] 2.2 `apply_marking` 用当前 `att_ids` 构造 `prev` 下标（找不到 → None）
- [x] 2.3 保留未匹配时的上次目标；匹配成功写回进攻者 id
- [x] 2.4 `marking_prev_index_mismatches` 归零守卫 + 判别性单测（下标平移/越界/换回合）
- [x] 2.5 跑探针 + L1 60 + P38 + 轨迹；记录（见 `.scratch/notes/c3c4-arbitration-2026-10-19.md`）

## 3. C4：压迫/盯人仲裁顺序（在 C3 之上）

- [x] 3.1 拆 `pick_presser` / `apply_pressure_target`
- [x] 3.2 调用顺序改为 press-pick → 排除 presser 的 marking → press-target → repulsion
- [x] 3.2b 候选排除 `excluded`（高亮/冻结者），并加单测（2026-10-19 复审 P1）
- [x] 3.3 探针：门控通过后的实际压迫率应显著高于基线 3.5%
- [x] 3.4 同一组探针 + L1 60 + P38 + 轨迹复测；记录
- [x] 3.5 C4 的价值判定留到修复后，不提前调常数

## 4. 收尾

- [x] 4.1 L1 严格 200 场；默认 `cargo test --release --lib` + 默认 realism 测试；确定性/侧车
- [x] 4.2 代码审阅闭环（paseo 独立 agent），修复发现后再审
- [x] 4.3 把最终读数写回 #175 / 本地 notes（含 source/wasm/diff 哈希）——
      https://github.com/Xingkai98/pitchcraft/issues/175#issuecomment-6266214051
