# Tasks: 出界重开体系——角球 + 界外球 + 头球（out-of-play-restarts）

> P6 批次1，聚焦出界判定 + 角球（双追逐争抢 + 头球）+ 界外球 + 协议 h 字段。
> 复用 GoalKick 开球高亮先例 + 松散球，不扩展 DeadBall。

## O1. 引擎：出界判定（新高亮结局）

- [ ] O1.1 新增 HighlightOutcome::PassOutOfPlay（带 source 区分）：普通传球落点低概率（3-5%）出界，pass 事件 to=None + detail=out_sideline/out_goal_line，坐标钳制 [0,1]；finalize 据 detail+source 触发重开：NormalPass 出边线→界外球（对方）/出底线→门球（对方门将）、Clearance（防方解围）出边线→界外球（进攻方）/出底线→角球（进攻方），不设 carrier
- [ ] O1.2 新增 HighlightOutcome::CornerAward：saved-rebound 越线（概率 ~30% 触发，弹开点 = 门线外一点 home 攻 x>1 / away 攻 x<0）→ 角球；否则维持现有松散球。**越线弹开点仅引擎内部确定角旗侧，事件字段坐标一律钳制 [0,1]**
- [ ] O1.3 引擎测试：传球出边线→界外球（对方）、传球出底线→门球（对方门将）、解围出底线→角球（攻方）、解围出边线→界外球（攻方）、扑出越线→角球、未越线→松散球

## O2. 引擎：角球 + 双追逐争抢 + 头球

- [ ] O2.1 角球发球：角旗区（按出底线点 x/y 就近取角）开长角球，pass 高亮带 h + detail=corner + to=None → 落点禁区松散球
- [ ] O2.1b 角球站位：RestartPrep 准备期发球者（攻方离角旗最近外场球员）走向角旗；攻方禁区包抄（nearest 几名预判）、防方回防
- [ ] O2.2 松散球双追逐：LooseBall 单 chaser=攻方 nearest（现有机制）+ LooseBall 加 battle_team 标记；compute_movers 让防方 nearest 也 chase 落点（复用 GoalKick 预判模式）
- [ ] O2.3 争抢结果：攻方 chaser 达到落点拾取半径时按 55/45 掷胜者；败者就地停；胜者就地争抢结果分支（非拾取→main）
- [ ] O2.4 攻方胜（55/30/15）：头球射门（shot detail=header、h=0，goal 10%/saved 40%/off 50%）/ 摆渡（pass 无 detail）/ 拿球组织（main）
- [ ] O2.5 防方胜（70/20/10）：头球解围（pass detail=clearance、h=0 → 松散球重新争）/ 解围出底线（PassOutOfPlay source=Clearance → 角球）/ 解围出边线（PassOutOfPlay source=Clearance → 界外球）
- [ ] O2.6 引擎测试：角球双追逐、头球射门三结果、头球摆渡、拿球组织、头球解围、解围出底线再角球、解围出边线界外球、角球站位、发球准备期走位

## O3. 引擎：界外球

- [ ] O3.1 界外球：对方离出界点最近**非门将**外场球员（掷球者）从边线掷向附近队友（pass 高亮，h=0，receiver_x/y=接球队友当前位置）；防方解围出边线 → 进攻方掷
- [ ] O3.1b 界外球掷球者准备期：RestartPrep 掷球者走向出界点（边线），到点再掷球（避免 viewer 瞬移）
- [ ] O3.2 引擎测试：界外球掷球流程、掷球者定位（非门将）、准备期走位

## O4. 引擎：协议 h 字段

- [ ] O4.1 Event 加 h 字段 + to_json 输出；pass/shot 高亮带 h（角球/门球开大脚/普通长传 h>0；界外球/头球解围/头球射门/短传 h=0——**明确 h=0 不省略**，h 缺失=旧事件流向后兼容）
- [ ] O4.2 引擎测试：h 字段序列化、角球发球 h>0、界外球 h=0

## O5. viewer：角球/界外球/头球/出界

- [ ] O5.1 角球发球高亮（detail=corner，角旗区→禁区，h 大小表示高度）
- [ ] O5.1b 角球站位演绎：发球准备期发球者走位到角旗（movers），攻方包抄/防方回防站位呈现
- [ ] O5.2 禁区双追逐（松散球双方追逐，防方 nearest chase）
- [ ] O5.3 头球射门（shot detail=header）、头球解围（pass detail=clearance 顶出禁区）
- [ ] O5.4 界外球掷球（边线短传 h=0）；O5.4b 掷球者准备期走位（走向出界点）
- [ ] O5.5 出界视觉（球飞向边界钳制到边缘）；协议 h 字段支持（h 大小表示：h 缺失→按飞行时长/距离默认插值、h=0→基础半径、h>0→放大）
- [ ] O5.5b protocol.js 校验 h（0-1 数字）+ detail 枚举（out_sideline/out_goal_line/header/clearance/corner）
- [ ] O5.6 viewer 测试：角球（含站位准备期走位）/头球/界外球（含准备期走位）/出界视觉/h 大小

## O6. 验证与收尾

- [ ] O6.1 版本号更新（index.html/app.js）
- [ ] O6.2 跑 verify.sh
- [ ] O6.3 代码审阅闭环
