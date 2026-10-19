# Changelog

## 0.1.0 — 2026-10-19

- 初始化项目：bundle patch、locale meta、icon、README、LICENSE。
- 写入项目计划（`docs/PLAN.md`）与交互方案（`docs/INTERACTION.md`）。
- 实现 M1 启动链路脚手架：
  - `/decision` 命令（无参数打开选择器，带文件名直接开始）；
  - Host 侧 pending 队列与 loopback JSON 路由；
  - 浏览器侧右侧栏 Tab 类型、open request 监听、文件选择器；
  - `src/shared.js` 参数解析 / 扩展名 / 路径校验 + 6 项单测。
- 决策枚举、解释、逐题问答、摘要回写留待 M2/M3。
