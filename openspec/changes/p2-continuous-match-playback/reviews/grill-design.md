# Grill Design: P2 Phase B —— 引擎 tackle 语义补全（continuous-match-playback）

> 使用 batch-grill-me skill，按轮次采访用户，敲定 Phase B 的设计细节。
> 用户在 Open Questions 全部确认前，不写实现代码。
> 上下文：P2 change = Phase B（引擎/协议 tackle 语义补全）+ Phase C（viewer 连续播放）。本 grill 只针对 **Phase B**。

## 背景（facts，已从代码确认）

- 引擎 `simulate()`（`engine/src/lib.rs:182-368`）非 demo 模式是连续事件流：`pos[]` 维护 22 人实时位置，事件从持球者出发。
- tackle 分支（`lib.rs:329-349`）：用 `random_player` 随机抽防守者（可能跨半场狂奔）；`result` 恒为 success；成功后 `pos[防守者] = victim_pos`（接触点），与 viewer 演绎的"弹到 loose 点捡球"不一致。
- `nearest_opponent`（`lib.rs:463-478`）是死代码，用静态站位 `p.x/p.y`，非 `pos[]` 实时位置。
- `Event` 结构体（`lib.rs:50-70`）字段齐全，`to_json` 手写序列化。
- viewer `interpretTackle`（`viewer/interpretation.js`）已实现四段式（持球→逼近→碰撞→弹开+捡球），fallback `deflectPoint` 自算弹开点。
- `viewer/protocol.js` 的 `validateBaseEvent` 目前不校验 tackle 必填（缺 `to/x2/y2` 不报错）。

## Round 1: Phase B 设计树 frontier

### Q1: tackle 触发——防守者选取

tackle 时防守者怎么选？

- **A（推荐）就近防守者 + 距离阈值**：选离持球者**最近的对方球员**（用 `pos[]` 实时位置，不是静态站位），若最近距离 > 阈值（约 10m），本决策不产 tackle，落回其他事件类型（pass/dribble/shot）。
- **B 只就近、无阈值**：选最近的对方球员，不管多远都产 tackle（仍会隔一段距离抢断，但至少是最近的）。
- **C 保持现状随机**：不做改动。

理由：P2 目标之一是"不 snap 的连续比赛"。随机防守者会跨半场狂奔，观感荒谬；阈值让抢断只在"防守者在附近"时发生，符合真实比赛（贴防才有抢断）。

### Q2: 超阈值落回——事件类型怎么选

当最近防守者超阈值、不产 tackle 时，引擎怎么继续？

- **A（推荐）重新随机落回 pass/dribble/shot**：把这次机会当一个普通进攻事件处理，用同一个 roll 重新决定事件类型（从 pass/dribble/shot 三选一）。
- **B 保持上次 roll 的分布重新掷**：等价于 A，只是实现细节不同（A/B 都是"当没抽到 tackle"处理）。
- **C 强制改成一个指定类型**（如只落回 dribble）。

理由：A 最自然——"防守者没贴上来，持球人继续进攻"。

### Q3: 抢断结果概率

tackle 的 success/fail 概率？

- **A（推荐）success ~70% / fail ~30%**：用一个 `rng.next_u64() % 10 < 7` 判定。
- **B 更保守**：success ~50% / fail ~50%（抢断本身是低成功动作）。
- **C 更偏成功**：success ~85% / fail ~15%。

理由：70/30 是"抢断大多能成功但偶有失败"的平衡点，画面能看到两种归属，又不至于频繁失败打断节奏。具体数值后续可用 config 暴露微调。

### Q4: fail 时状态更新

tackle `result=fail` 时，引擎内部状态怎么变？

- **A（推荐）球权保留原持球者**，持球者留在接触点附近（`pos` 微调或不动）。防守者归位到起点。
- **B 球权保留，但持球者被"弹开"**（持球者位置移到 loose 点，画面配合 fail 的"原持球人拿回"演绎）。

理由：A 语义最简——fail = 抢断没成功，球还在持球者脚下。viewer fail 演绎是"被铲者追到弹开点拿回"，与 A 一致（引擎让持球者留接触点，viewer 演完他在弹开点捡球，二者终态一致）。

### Q5: loose 点的归属——success 时防守者位置

success 时引擎把防守者 `pos` 更新到哪里？

- **A（推荐）`loose` 点**：防守者位置更新到 `(loose_x, loose_y)`（弹开点），与 viewer 演绎的"追到弹开点捡球"终态一致 → 下一事件从 loose 点出发，不 snap。
- **B 接触点**：保持现状（`pos[防守者] = victim_pos`），viewer 弹开捡球后下一事件起点是接触点 → 会 snap。

理由：这是 Phase B 的核心——让引擎坐标语义跟上 viewer 演绎终点。A 是"不 snap"的前提。

### Q6: 弹开点（loose_x/y）由谁算、规则是否与 viewer 对齐

`loose_x/y` 的生成规则？

- **A（推荐）引擎确定性规则，与 viewer `deflectPoint` 同规则**：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化。viewer 优先采用引擎值，缺失时 fallback 自算。
- **B 引擎简单偏移**（如固定向球门一侧偏移），viewer 收到后仍用自算。

理由：两端同规则最一致（design D2 已定）。弹开距离用 config 里现有的 `deflectDistance`（归一化 0.05 ≈ 5m）还是引擎另有值，见 Q7。

### Q7: 弹开距离/速度放哪

弹开距离（loose 点离接触点多远）和"被铲者带球速度"放哪？

- **A（推荐）引擎给距离（新增 config 字段或事件字段），viewer 保留演绎**：引擎发 `loose_x/y` 时已隐含距离；`carrier_from_x/y` 隐含带球路线。viewer 的 `config.interpretation.tackle.deflectDistance` 降级为 fallback（引擎没给时用）。
- **B viewer 全权决定**：引擎只发语义，距离/速度全在 viewer config。

理由：P1 的约定是"引擎给数据、画面给戏"——弹开点是**语义结果**（影响下一事件连续性），应由引擎定；画面只负责"怎么演出来"。

### Q8: `carrier_from` 的起点从哪来

`carrier_from_x/y`（被铲者带球起点）怎么确定？

- **A（推荐）持球者上一事件位置**：引擎跟踪持球者每个事件的起点，tackle 的 `carrier_from` = 持球者上一个位置（若持球者是刚接球/刚带球，则是其接球/带球起点）。需要引擎多维护一个"持球者上一位置"。
- **B 取当前与上一起点的中点**（或按带球方向回退一段）：模拟"带球逼近中"的中间态。

理由：A 用真实引擎数据（持球者上次位置），viewer 演绎"从上一位置带球到接触点"，是引擎语义的真实呈现。B 是 viewer 侧简化，破坏"引擎给数据"原则。

### Q9: `carrier_from` 缺失时的 viewer fallback

viewer 收到没有 `carrier_from_x/y` 的 tackle（旧数据/兼容），怎么演？

- **A（推荐）被铲者原地带球**（保持 P1 行为）：球直接出现在被铲者脚下，防守者逼近。不做额外移动。
- **B 按带球方向自动回退一段距离**：viewer 自造一个带球起点。

理由：A 保持向后兼容 + 最简；B 让 viewer 猜引擎数据，违背"画面不推断参数"。

### Q10: config 是否需要暴露阈值/概率（wasm 解析扩展）

距离阈值、fail 概率要不要做成 config 字段（通过 wasm `parse_config` 传入）？

- **A（推荐）先硬编码常量，不进 config**：阈值 10m、fail 率 30% 作为引擎内常量（`const`），未来要调再暴露。理由：P2 最小改动，避免扩展 wasm config 解析（现在是手写极简解析）。
- **B 进 config**：wasm `parse_config` 扩展解析 `tackle_distance_threshold` / `tackle_fail_rate`。

理由：A 最省且够用；B 是"未来调参"的提前投资，P2 不需要。

### Q11: 协议必填校验与测试范围

tackle 的 `to`/`x2/y2` 转必填，校验与测试范围？

- **A（推荐）protocol.js 加必填校验 + 引擎测试 + 协议测试**：`validateBaseEvent` 对 tackle 要求 `to`/`x2/y2`；引擎 `cargo test` 覆盖新字段/就近/概率/确定性；viewer 测试覆盖五段式 + fallback。
- **B 只加引擎测试，protocol.js 校验后置**。

理由：A 对齐 P2 spec（协议定稿含必填校验），一次做全。

### Q12: `loose` 与 fail 的弹开——fail 时引擎发不发 `loose_x/y`

fail 的 tackle 事件要不要也发 `loose_x/y`？

- **A（推荐）发**：fail 也发 `loose_x/y`（球被捅开、但持球人拿回），viewer fail 演绎需要弹开点。success/fail 的 loose 点可以不同（同规则算出，但球最终归属不同）。
- **B 只 success 发**：fail 不发，viewer fail 用自算。

理由：A 让两端一致（引擎给了所有位置数据，viewer 不猜）。fail 的 loose 点按同规则算，viewer 演"原持球人追到 loose 拿回"。

## Round 1b（用户补充 2026-08-06）：tackle 触发决策模型

> 用户补充：**不是所有时候都去 tackle，防守球员自行判断，只有少量机会防守球员会去真的 tackle；后续这个要能根据战术、球员属性调节概率。**
> 背景 fact：当前引擎 `roll < 88`（固定 12%）进 tackle 分支，进入即必抢。用户要求把"抢不抢"变成一个**低概率 + 情境判断**的决策，并预留参数化（战术/属性）。

### Q13: tackle 触发决策模型

防守者"要不要真的去抢"怎么判定？

- **A（推荐）距离感知 + 抢断积极性概率**：在每个事件点，若存在距持球者 ≤ 阈值的防守者，则以一个**低概率（抢断积极性，如 25-35%）**决定是否真的去抢；概率不中则不抢，继续进攻。取代"固定 12% 进分支必抢"。
- **B 只加阈值、保持固定概率**：维持现有固定概率进分支，仅用就近+阈值筛选谁去抢。
- **C 情境评估函数**：考虑距离/角度/防守人数/持球人是否被贴防等综合评估（P2 过度设计，战术/属性阶段再做）。

理由：A 实现"有机会（距离）才考虑 + 少量才真抢"，是"防守者自行判断"的最小真实表达；概率参数正是将来战术/属性的挂载点。

### Q14: "少量机会"的目标频率

期望一场（2700s）大概多少次 tackle 动作？

- **A（推荐）每场约 8-15 次**：比当前（固定 12% ≈ 18-22 次）略少，且都发生在防守者贴防时，观感"偶尔有抢断"。
- **B 更少，每场 4-8 次**：更稀，tackle 成为稀缺事件。
- **C 维持现有量级（~18 次）**：只保证不跨半场，频率不变。

理由：频率直接影响画面节奏。太少显冷清，太多显烦。A 是"偶尔有抢断"的平衡点。（具体由"距离阈值内机会数 × 积极性概率"自然得出，无需精确硬编码。）

### Q15: 未来战术/属性调节的架构预留

抢断积极性概率（以及阈值、成功率）将来要能被战术/属性调节，现在怎么留扩展？

- **A（推荐）Phase B 硬编码为引擎内常量，但组织成独立参数/函数**：如 `tackle_eagerness`（抢断积极性）、`tackle_distance_threshold`、`tackle_success_rate` 三个常量 + 一个 `should_tackle()` 决策函数，签名清晰，注释标明将来接战术（票据 04）/属性（票据 05）。
- **B 现在就进 config（wasm 解析扩展）**：扩展 `parse_config` 解析这些字段。
- **C 不做预留**：直接写死在 tackle 分支里。

理由：A 满足"设计上为将来留口"，又不引入 wasm config 解析的额外改动（P2 最小）；等战术/属性系统（票据 04/05）落地时，把常量替换为计算值即可。

## User Confirmation（2026-08-06，batch-grill-me）

- **Q1**：用户答复：**就近+阈值**（选离持球者最近的对方球员，用 pos[] 实时位置；最近距离 > 阈值约 10m 则不产 tackle）。
- **Q2**：用户答复：**重掷落回三类**（pass/dribble/shot，当作普通进攻事件处理）。
- **Q3**：用户答复：**50/50**（success/fail 各半；注意：非推荐的 70/30）。
- **Q4**：用户答复：**球权保留原持球者**（fail 时持球者留接触点附近，防守者归位）。
- **Q5**：用户答复：**loose 弹开点**（success 时防守者 pos 更新到 loose_x/y，与 viewer 演绎终态一致，不 snap）。
- **Q6**：用户答复：**引擎算，与 viewer 同规则**（逼近方向垂线×距离，确定性、场内钳制、零距离退化；viewer 优先用引擎值，缺失 fallback 自算）。
- **Q7**：用户答复：**引擎定，viewer 演绎**（引擎发 loose_x/y 时已隐含距离；viewer config 的 deflectDistance 降级为 fallback）。
- **Q8**：用户答复：**持球者上一事件位置**（引擎跟踪持球者上一位置，tackle 发 carrier_from = 该位置）。
- **Q9**：用户答复：**被铲者原地带球**（carrier_from 缺失时保持 P1 行为，viewer 不做移动，向后兼容）。
- **Q10**：用户答复：**常量不进 config**（引擎 config 仅 match_duration_seconds + demo_mode；阈值/概率做引擎内常量，不动 wasm 解析）。
- **Q11**：用户答复：**protocol.js 校验 + 全套测试**（validateBaseEvent 对 tackle 要求 to/x2/y2；引擎 + viewer + 协议测试全覆盖）。
- **Q12**：用户答复：**发**（fail 也发 loose_x/y，viewer fail 演绎需要弹开点）。
- **Q13**：用户答复：**距离感知 + 积极性概率**（有防守者距持球者 ≤ 阈值时，以低概率——抢断积极性，如 25-35%——决定是否真抢；不中则继续进攻。取代固定 12% 必抢）。
- **Q14**：用户答复：**8-15 次/场**（比当前约 18-22 次略少，且都发生在防守者贴防时，观感"偶尔有抢断"）。
- **Q15**：用户答复：**常量 + 清晰签名**（tackle_eagerness / tackle_distance_threshold / tackle_success_rate 三个常量 + should_tackle() 决策函数，注释标明将来接战术票据 04 / 属性票据 05）。

## Open Questions

无。全部决策已由用户确认（2026-08-06）。可以进入实现（openspec change 内部流程 / opsx:apply）。
