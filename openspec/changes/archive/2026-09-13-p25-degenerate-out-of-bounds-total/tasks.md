# Tasks: 退化态选择器 total 化（#45/#46）

## P1. 修复

- [x] P1.1 `emit_forward_pass_highlight` 内联选择器退化态回退该队门将（to != from）
- [x] P1.2 `nearest_any` 退化态回退 home 门将 0（不返回 -1）

## P2. 测试

- [x] P2.1 单测：`emit_forward_pass_highlight` 退化态不 panic、to=门将
- [x] P2.2 单测：`nearest_any` 两队外场全罚下 → 返回 0 非 -1
- [x] P2.3 对照组：正常态行为不变

## P3. 收尾

- [x] P3.1 `verify.sh` 全绿 + `npx openspec validate --all --strict`
- [x] P3.2 独立 subagent 审阅闭环

## 关联

- 修复 #45、#46；从 P24（#43）拆出
