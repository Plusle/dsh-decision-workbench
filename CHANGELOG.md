# Changelog

## 0.2.0 — 2026-10-19

实现 M1 + M2 + M3：

- **启动链路**：`/decision` 打开文件选择器；`/decision <文件名>` 直接开始；Host 解析文件、pending 队列、loopback + 同源 JSON 路由。
- **决策枚举**：读取文档、调用默认模型、把输出归一化为决策项（标题 / 问题 / 章节 / 优先级 / 出处行号与引用 / 来自 spec 的选项与推荐）；失败自动重试一次 JSON 修复。
- **逐题能力**：懒加载解释（结论、为什么现在、背景、场景、影响、假设、引用）；无选项时生成 2–4 个方案与推荐；每题独立追问 thread，回答带 `文件:行` 出处。
- **决定与回写**：已决定 / 拿不准 / 稍后 / 清除；自定义方案与理由；摘要预览、复制、提交回主会话；可选写入 `docs/decisions/<日期>-<slug>.md`。
- **面板**：右侧栏 Tab、进度与必决剩余、优先级分组与筛选、master-detail（窄栏下单栏切换）、提交摘要弹层、继续上次工作台。
- **持久化**：工作台 / 决策 / 解释 / 追问 / 选择写入 `$DSH_HOME/storages/dsh-decision-workbench/workbenches.json`，刷新和重启后可恢复最近 16 个。
- **测试**：`test/shared.test.js` 扩展到 19 项，覆盖解析、截断、JSON 提取、归一化、摘要与 slug。
- **实测**：DSH Web 0.2.1-rc.2 下验证 8 项枚举、解释、追问、无选项补方案、决定、摘要预览与写文件。

## 0.1.0 — 2026-10-19

- 初始化项目：bundle patch、locale meta、icon、README、LICENSE。
- 写入项目计划（`docs/PLAN.md`）与交互方案（`docs/INTERACTION.md`）。
- 实现 M1 启动链路脚手架：
  - `/decision` 命令（无参数打开选择器，带文件名直接开始）；
  - Host 侧 pending 队列与 loopback JSON 路由；
  - 浏览器侧右侧栏 Tab 类型、open request 监听、文件选择器；
  - `src/shared.js` 参数解析 / 扩展名 / 路径校验 + 6 项单测。
- 决策枚举、解释、逐题问答、摘要回写留待 M2/M3。
