# Tasks: 出界重开体系——角球 + 界外球 + 头球（out-of-play-restarts）

> P6 批次1，聚焦出界判定 + 角球（双追逐争抢 + 头球）+ 界外球 + 协议 h 字段。
> 复用 GoalKick 开球高亮先例 + 松散球，不扩展 DeadBall。

## O1. 引擎：出界判定（新高亮结局）

- [ ] O1.1 新增 HighlightOutcome::PassOutOfPlay（带 source 区分）：普通传球落点低概率（3-5%）出界，pass 事件 to=None + detail=out_sideline/out_goal_line，坐标钳制 [0,1]；finalize 据 detail+source 触发重开：NormalPass 出边线→界外球（对方）/出底线→门球（对方门将）、Clearance（防方解围）出边线→界外球（进攻方）/出底线→角球（进攻方），不设 carrier；**finalize 直接接线**：出边线 → 创建 RestartPrep(kind=ThrowIn)、出底线（门球）→ 走现有 GoalKick 门将开大脚、出底线（角球）→ 创建 RestartPrep(kind=Corner)
- [ ] O1.2 新增 HighlightOutcome::CornerAward：saved-rebound 越线（概率 ~30% 触发，弹开点 = 门线外一点 home 攻 x>1 / away 攻 x<0）→ 角球；否则维持现有松散球。**越线弹开点仅引擎内部确定角旗侧，事件字段坐标一律钳制 [0,1]**
- [ ] O1.3 引擎测试：传球出边线→界外球（对方）、传球出底线→门球（对方门将）、解围出底线→角球（攻方）、解围出边线→界外球（攻方）、扑出越线→角球、未越线→松散球、**射门打偏→门球且不加 detail（负向断言）**

## O2. 引擎：角球 + 双追逐争抢 + 头球

- [ ] O2.1 角球发球：角旗区（按出底线点 x/y 就近取角）开长角球，pass 高亮带 h + detail=corner + to=None → 落点禁区松散球；**落点在发球高亮时刻选定**
- [ ] O2.1b 角球站位：finalize（CornerAward/解围出底线 PassOutOfPlay source=Clearance）创建 RestartPrep 状态（player=攻方离角旗最近外场球员、target=角旗、kind=Corner、**possession=攻方**）挂 tick 主分支（dead_ball 之后、highlight 之前）；**准备期 ball_pos=角旗**，发球者 mover 走向角旗（<1m 触发发球高亮）；攻方禁区包抄（nearest 几名向禁区预判）、防方回防
- [ ] O2.2 松散球双追逐：LooseBall 加 battle 元组（攻方 chaser=nearest、防方 chaser=nearest，**loose 启动时固定**，防胜不漂移）；compute_movers 让两个 chaser 都 chase 落点（复用 GoalKick 预判模式）
- [ ] O2.3 争抢结果：攻方 chaser 达到落点拾取半径时按 55/45 掷胜者；败者就地停；**攻方胜 carrier=攻方 chaser、防方胜防方 chaser 移动到位（到落点）carrier=防方 chaser**，以落点为起点产分支动作（非拾取→main）
- [ ] O2.4 攻方胜（55/30/15）：头球射门（subject=攻方 chaser，shot detail=header、h=0，goal 10%/saved 40%/off 50%）/ 摆渡（subject=攻方 chaser，pass 无 detail、h=0）/ 拿球组织（main）
- [ ] O2.5 防方胜（70/20/10）：头球解围（subject=防方 chaser，pass detail=clearance、h=0 → 松散球**重新争（普通松散球，非 battle）**）/ 解围出底线（PassOutOfPlay source=Clearance → 角球）/ 解围出边线（PassOutOfPlay source=Clearance → 界外球）
- [ ] O2.6 引擎测试：**长角球发球（角旗区就近取角规则、detail=corner、to=None、h>0）**、角球双追逐（双 chaser 固定）、争抢结果（**败者就地停、防方胜防方 chaser 移动到位显式断言**）、头球射门三结果、头球摆渡、拿球组织、头球解围、解围出底线再角球、解围出边线界外球、角球站位、发球准备期走位（**ball_pos=角旗、产出的 beat.ball 静止锚点**）

## O3. 引擎：界外球

- [ ] O3.1 界外球：对方离出界点最近**非门将**外场球员（掷球者）从边线掷向附近队友（pass 高亮，h=0，receiver_x/y=接球队友当前位置）；防方解围出边线 → 进攻方掷
- [ ] O3.1b 界外球掷球者准备期：finalize（PassOutOfPlay source=NormalPass/Clearance 出边线）创建 RestartPrep 状态（player=掷球者、target=出界点、kind=ThrowIn、**possession=掷球方**）；**准备期 ball_pos=出界点**，掷球者走向出界点（边线），到点再掷球（避免 viewer 瞬移）
- [ ] O3.2 引擎测试：界外球掷球流程、掷球者定位（非门将）、准备期走位（**ball_pos=出界点、产出的 beat.ball 静止锚点**）

## O4. 引擎：协议 h 字段

- [ ] O4.1 Event 加 h 字段 + to_json 输出；pass/shot 高亮带 h（角球发球/门球开大脚 h>0 0.5-0.8；普通中长传 >20m h>0 0.2-0.4；界外球/头球解围/头球摆渡/头球射门/普通短传 ≤20m h=0——**明确 h=0 不省略**，h 缺失=旧事件流向后兼容）
- [ ] O4.2 引擎测试：h 字段序列化、角球发球 h>0、界外球 h=0、门球开大脚 h>0、普通长传 h>0、普通短传 h=0、头球类 h=0

## O5. viewer：角球/界外球/头球/出界

- [ ] O5.1 角球发球高亮（detail=corner，角旗区→禁区，h 大小表示高度）
- [ ] O5.1b 角球站位演绎：发球准备期发球者走位到角旗（movers），攻方包抄/防方回防站位呈现
- [ ] O5.2 禁区双追逐（松散球双方追逐，攻防各 1 名 chase）
- [ ] O5.3 头球射门（shot detail=header）、头球解围（pass detail=clearance 顶出禁区）、头球摆渡（pass h=0 普通演绎）
- [ ] O5.4 界外球掷球（边线短传 h=0）；O5.4b 掷球者准备期走位（走向出界点，球停出界点）
- [ ] O5.5 出界视觉（球飞向边界钳制到边缘）；协议 h 字段支持（**interpretation.js 读取事件 h**：pass/shot 带 h 用事件值、h 缺失→按飞行时长/距离默认插值；h 大小表示：h=0→基础半径、h>0→放大）
- [ ] O5.5b protocol.js 校验 h（0-1 数字）+ detail 枚举（**按事件类型限定**：pass 校验 out_sideline/out_goal_line/corner/clearance、shot 校验 header，不破坏 whistle 等既有 detail）
- [ ] O5.6 viewer 测试：角球（含站位准备期走位）/头球/界外球（含准备期走位）/出界视觉/h 大小（**含 h 缺失向后兼容**）/**protocol.js h+detail 校验（合法通过、非法抛错）**

## O6. 验证与收尾

- [ ] O6.1 版本号更新（index.html/app.js）
- [ ] O6.2 跑 verify.sh
- [ ] O6.3 代码审阅闭环
