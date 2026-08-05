Type: prototype
Status: resolved

## Question

**事件流的字段、事件类型枚举、坐标系统、序列化格式怎么定？**

## Answer

**协议草案 v1 经受 P0 真实链路检验，可定稿。** 见 `openspec/changes/p0-event-to-pitch/reviews/protocol-validation-notes.md`。

核心结论：
- 基础字段（t/type/subject/x/y）必填，顺。
- 双点坐标（x/y → x2/y2）消除两层坐标猜谜，顺。
- 演绎参数（speed/lead/touch_freq）引擎给、画面消费，顺。
- lineup 事件携带 22 球员初始站位（B1），viewer 纯从事件流渲染，顺。
- id 方案（0-10 home / 11-21 away）无歧义。
- 2 个真实缺口已在 P0 修复：tackle 需带 to+x2/y2（被铲者位置）；进球后需 kickoff 重置。

定稿候选：把 tackle 的 to/x2/y2 列为必填；明确"进球→whistle(kickoff_again)+kickoff"序列。

## 关联

P0 change（p0-event-to-pitch）验证产物；票据 06（确定性→坐标精度）。
