# `far==0` 断言是脆弱重复：删掉或加 ε（真守卫已在 `lib.rs:9845`）

- Type: task
- Status: open（2026-10-01 立；#19 遗留）
- Created: 2026-10-01
- GitHub issue: https://github.com/Xingkai98/pitchcraft/issues/139（`wayfinder:task`）
- 关联：#19（本票从其出处核查中析出）

## 问题

`engine/tests/realism.rs:790` 的 `assert_eq!(far, 0)`（「事件内 dist>12m 抢断应恒为 0」）
是**已知脆弱**断言，却挡着任何抬高事件量的方案（#19 实测 **pristine 自己就破 5/9 窗**）。

## 已确认（#19 出处核查，`.scratch/notes/19-band-provenance-2026-10-01.md` §5）

- 真守卫**已在**：`engine/src/lib.rs:9845` `p30_tackle_score_directions`：
  `assert_eq!(score_tackle(DefensiveFeatures{dist_m:13.0, ..}), f64::NEG_INFINITY)`
  ——在**未序列化的内部几何**上严格断言。**「真守卫已在」属实。**
- 本行的 `far` 是**从序列化后 4-小数事件字段**重新求距离 ⇒ 测的是**舍入后的另一个量**
  （实测越界最大仅 **12.0076 m**）⇒ **冗余且脆弱的重复断言**，不是唯一守护。
- 代码注释（`realism.rs:781-789`）**自己认领**：称它「冗余且脆弱」「是运气」，
  处置方向「**删掉它或加 ε 容差**（真守卫已在，ε 低风险）」。
- #19 区分实验实测：**pristine 自己**在窗口 1001/1201/1401/1601/1801 破（5/9）；
  press（standoff 5.5）反而**全过**（抬高事件量抑制了它）。

## 处置方向

**删掉它**，或**加 ε 容差**。真守卫已在 ⇒ ε 低风险。**独立于 #19**（pristine 自破 ⇒ 非 #19 引入）。

## 为什么是独立票据

**既存技术债**。应在任何「抬高事件量」的后续 change **之前**修，否则该断言持续误报。

## 边界

只动 `realism.rs` 的这一条断言；**不动**真守卫 `lib.rs:9845`；不改任何统计带。
