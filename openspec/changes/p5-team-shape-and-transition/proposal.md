# Proposal: 队形公式 + 阶段转换 + micro-motion（team-shape-and-transition）

## Why

P4（并行节拍核心，Change A）让"22 人同时动"，但审阅确认：要"像真实足球"，还需要三样——**阵型整体移动**（防线随球前压/回撤、全队随球侧平移）、**攻防转换/突然反击**（球权易主时的瞬变）、**静止球员 micro-motion**（避免圆点完全冻结）。三者都是引擎内可调公式/ viewer 层 polish，不改变 beat 协议或 viewer 架构，故独立为 Change B，在 p4 核心稳定后迭代。

本 change = Change B（真实感层），依赖 p4（并行节拍核心）。

## What Changes

- **球相关队形目标**：每球员目标 = 角色基准 + 队形偏移（防线随球前压/回撤、全队随球侧平移、控球阶段压上）。替代 p4 的"角色锚点 + 小幅调整"占位目标。
- **控球阶段 + 攻防转换**：每队基础 phase（attack/defend）+ transition 叠加窗口（非第三状态）；球权易主触发 transition 窗口（新进攻方前插、新防守方回撤 + 就近收缩）。
- **micro-motion**：viewer 层给静止球员小幅重心调整（不改变逻辑位置），避免圆点完全冻结。

## Capabilities

### New Capabilities

无（增强 p4 核心）。

### Modified Capabilities

- `match-engine`: 队形目标公式（ball-relative shape）+ 阶段状态机 + transition 窗口。
- `pitch-viewer`: 静止球员 micro-motion（render 层，逻辑位置不变）。

## Impact

- 引擎：per-tick 目标决策从"锚点+小幅调整"升级为"锚点+队形偏移+阶段"；增加 phase 状态 + transition。
- viewer：micro-motion 渲染（不影响逻辑位置/确定性）。
- 不改变 beat 协议、viewer 架构、接缝。

## 关联票据（wayfinder）

- `04` 球场/战术模型 → 队形公式是战术系统的雏形。
- `05` 能力值模型 → 后续属性影响跑位/逼抢强度。
