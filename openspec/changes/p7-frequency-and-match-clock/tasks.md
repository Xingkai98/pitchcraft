# Tasks: 频率调优 + 90 分钟比赛 + 观看时长控制

## P1. 引擎：90 分钟 + 频率调优

- [ ] P1.1 `MatchConfig::default_()` 2700 → 5400（90 分钟）
- [ ] P1.2 出界率 3-5% → 8-10%；边线/底线 50/50 → 65/35（`emit_pass_highlight`）
- [ ] P1.3 saved-rebound 扑出率 30→50%、越线 30→80%（普通射门 + 头球射门）
- [ ] P1.4 goal 率 15→9%（普通射门）、10→8%（头球射门）
- [ ] P1.5 引擎测试：频率断言更新（角球 6-9、界外球 17-21、头球 8-12、进球 3-3.5）；纯正确性测试改用短 cfg 提速

## P2. viewer：时间显示 + 观看时长

- [ ] P2.1 `config.playback`：`watchMinutes: 5`、`watchChoices: [5,10,20,45,90]`、`speeds: [1,2,4]`
- [ ] P2.2 `game.js`：基速 = `matchEnd/(watchMinutes×60)`；`step` 用基速×档位；`cycleWatch()`
- [ ] P2.3 `app.js`：MATCH_CONFIG 5400；时间显示 `MM:SS / 90:00`（`formatMatchClock`）；观看时长按钮循环；速度按钮显示倍速
- [ ] P2.4 viewer 测试：时间格式、基速计算、观看时长循环

## P3. 验证收尾

- [ ] P3.1 版本号更新（index.html/app.js）
- [ ] P3.2 跑 verify.sh（e2e 全场 5400s）
- [ ] P3.3 代码审阅闭环
