# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 比赛时间显示

画面层 SHALL 显示比赛时钟（`MM:SS / 90:00`，playTime 即比赛秒直接格式化），不显示真实播放秒。

#### Scenario: 上半场结束
- **GIVEN** playTime = 2700
- **THEN** 显示 `45:00 / 90:00`

#### Scenario: 全场结束
- **GIVEN** playTime = 5400
- **THEN** 显示 `90:00 / 90:00`

### Requirement: 观看时长控制

画面层 SHALL 支持观看时长配置（默认 5 分钟）：播放基速 = 比赛总秒 /（观看时长×60），球员移动仍真实速度（引擎 tick 不变，仅播放加速）。

#### Scenario: 5 分钟看完 90 分钟
- **GIVEN** watchMinutes=5、比赛 5400s
- **THEN** 播放基速 = 18x，playTime 从 0 走到 5400 用 5 分钟真实时间

#### Scenario: 观看时长可调
- **GIVEN** 用户循环观看时长
- **THEN** 可选 5/10/20/45/90 分钟，基速随之变化

## ADDED Requirements

（本 change 无新增 viewer 演绎需求——时间显示与播放控制是 UI 逻辑，非动画演绎。）
