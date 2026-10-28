# Blind replay judging protocol

你有两件事要判断：**这是真实比赛 tracking 的 2D 回放，还是游戏引擎生成的？**
以及**它有多像真实比赛的 2D 回放？**

## 材料

- `items/<id>/contact.png`：24 s 窗口内的 8 帧（同一场/同一段），无标签。
- `items/<id>/trajectory.png`：同一 24 s 的 22 名球员轨迹 + 球轨迹（黄）。
- 所有图由同一渲染器生成；文件名是随机的，图内没有时间/来源/编号文字。
- 请只依据画面内容判断，不要依据文件名、文件大小、目录顺序或图片元数据。

## 主项（24 项）

对每一项回答：

- **A**：`real` 或 `engine`。
- **A_confidence**：1–5（1=猜的，5=非常确定）。
- **B_score**：1–5，这段 24 s 的 2D 回放有多像真实比赛（1=完全不像/机械，5=非常像真实回放）。
- **cues**（可选）：写下暴露线索，例如：水平车道、整队同步、间距、球与人关系、静止段、折返、队形、其他。

每一项独立判断；有些项可能与其它项来自同一来源，但不要跨项合并答案。

## 负控（3 对）

对 `controls/<id>/` 下的 A/B 两侧（各有 contact 与 trajectory）：

- **same_source**：`same` 或 `different`。`same` = 两侧都是真实，或两侧都是引擎；`different` = 一侧真实、一侧引擎。
- **confidence**：1–5。
- **more_real**：若判 different，写 `A` 或 `B`（哪侧更像真实）；否则留空。
- **notes**（可选）。

## 交付

把答案填进 `score-sheet.json`（保持 id 不变），或按同样结构另存为 `judge-<name>.json`。不要修改图片。
