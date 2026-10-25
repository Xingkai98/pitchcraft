# Tasks: p-subtick-motion-emission

## 1. 设计确认（阻塞实现）

- [x] 证据：两轮盲测 + 10 Hz tick 原型（report §12–§15）
- [x] 机制：拍内确定性运动采样、决策零变化（design D2）
- [x] 协议草案：`move` 事件（design D3）
- [ ] **用户确认 design**（尤其是"判据默认不消费 move"与事件量 ×N）

## 2. 隔离原型（确认后）

- [ ] 在独立 worktree 实现 `MOTION_SAMPLES_PER_TICK` 采样发射 `move`（不改 st.pos/判据输入）
- [ ] 运动模型参数（加速度/转角/降速）先验 + 扫描；保留 2–3 个可行点
- [ ] 零变化守卫：L1/P38/P18/ratchet 与改动前逐值一致
- [ ] 三裁判盲测（A 层基线 / 真实 / 本 change）：通过后进入协议实现

## 3. 协议与 viewer

- [ ] `event-stream-protocol` 新增 `move` 事件（枚举/字段/序列化/顺序）
- [ ] viewer 动画消费 `move`；无 `move` 回退；`?v=` 版本更新
- [ ] match-metrics 默认不使用 `move`（保持判据口径）；视觉工具显式启用
- [ ] 事件量/性能/体积读数；`MODEL_VERSION` 与协议版本 bump

## 4. 落地与验收

- [ ] 默认套件/golden 重基线（新增事件类型属预期变化）
- [ ] `./verify.sh` 全绿；全量 `--ignored`；P18 canary（干净树 + source_commit）
- [ ] 三裁判盲测记录（判定标准预注册）；轨迹连续性数值报告
- [ ] 独立审阅闭环（代码 + 协议 + 数字出处）
