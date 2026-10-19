# dsh-decision-workbench

DeepSeek Harness 的**决策工作台**：通过 `/decision` 打开右侧栏面板，把一份 spec 里的开放决策拆成逐题选择，随时向隔离的决策助手追问，最后把决定摘要交回主会话。

> **状态：0.2.0（M1 + M2 + M3 已实现）**
> 已在 DSH Web 0.2.1-rc.2（`desktop` profile）实测：命令链路、决策枚举、逐题解释、无选项补方案、逐题追问、选择与摘要预览、写入 `docs/decisions/`。
> 计划见 [docs/PLAN.md](docs/PLAN.md)，交互方案见 [docs/INTERACTION.md](docs/INTERACTION.md)，示例文档见 [example/](example/)。

---

## 它解决什么

一份 spec 里通常散落着若干"需要人拍板"的点：有备选方案的、只有问题没有方案的、影响开工的、可以后补的。工作台把它们收进右侧栏：

1. `/decision` 或 `/decision <文件名>` 启动；
2. 自动通读文档，列出全部决策项（必决 / 建议 / 可选）；
3. 点开某一题，才生成这一题的背景、场景、影响和引用；
4. spec 有选项就直接选；没有就让助手补 2–4 个方案并给推荐；
5. 对任意一题追问，回答只看文档与本工作台，不污染主对话；
6. 逐题标记"已决定 / 拿不准 / 稍后"，预览摘要后提交回主会话。

未决和拿不准会在摘要里显式保留，主 agent 不会被暗示去猜。

---

## 用法

```
/decision                  打开右侧栏，选择一份文档开始（若有上次工作台可直接继续）
/decision <文件名>         直接以该文件开始（相对工作区路径，可加引号）
```

示例：

```
/decision docs/payment-refactor.md
/decision "docs/spec v2.md"
/decision @spec.md
```

文件名解析规则：

- 先按相对路径找，再按 basename 在工作区里找；
- 重名会列出候选，要求写相对路径；
- 只接受 `.md .markdown .mdx .txt .rst .adoc .json .yaml .yml .html`；
- 文件必须在当前会话工作区内；
- 面板只读取文档，不修改它；只有勾选"同时写入 docs/decisions/"时才新增记录文件。

---

## 面板怎么用

| 区域 | 作用 |
|---|---|
| 文件选择器 | 搜索工作区文档；顶部会显示"继续上次的工作台" |
| 决策清单 | 按优先级分组，可筛选全部 / 必决 / 未完成 / 已决定；显示进度与必决剩余 |
| 单题详情 | 题干、出处、解释卡、选项、自定义方案、理由、三态按钮 |
| 解释卡 | 一句话结论、为什么现在决定、背景、场景、影响、假设、引用 |
| 选项 | 标记"来自 spec / 助手补充"；推荐项带理由；无选项时可让助手补 |
| 问一问 | 每题独立 thread；回答带 `文件:行` 出处；建议问法一键发送 |
| 摘要 | 预览完整摘要、复制、提交到主会话、可选写入 `docs/decisions/<日期>-<标题>.md` |

进度、选择、理由、追问线程都会自动保存；关闭 Tab、刷新页面、重启 Harness 后再次 `/decision` 可继续。

---

## 当前能力

| 能力 | 状态 |
|---|---|
| `/decision` 命令 | ✅ |
| 右侧栏决策工作台 Tab | ✅ |
| 文件选择器（搜索、工作区文档列表、继续上次） | ✅ |
| `/decision <filename>` 直接开始 | ✅ |
| 决策项枚举（优先级 / 出处 / 来自 spec 的选项） | ✅ |
| 逐题解释懒加载 | ✅ |
| 无选项时生成 2–4 个方案 + 推荐 | ✅ |
| 逐题追问（独立上下文、带引用） | ✅ |
| 已决定 / 拿不准 / 稍后 / 清除 | ✅ |
| 摘要预览、复制、提交回主会话 | ✅ |
| 可选写入 `docs/decisions/` | ✅ |
| 跨刷新 / 重启恢复 | ✅ |
| 来源 hash 变更同步、重复项合并、历史浏览 | ⬜ M4 |

---

## 设计要点

- **命令优先**：启动不依赖提示词。命令在 Host 侧解析文件，浏览器半通过 pending 轮询打开 Tab。
- **隔离的决策助手**：每次生成或追问都是独立、只读的模型调用，提示词只包含文档片段、本题和本工作台已做决定，不继承主会话历史。
- **列表先到、解释按需**：先出全部决策项；打开某题才生成解释；无选项时才按需补方案。
- **未决不猜**：摘要把"已决定 / 拿不准 / 稍后 / 未处理"分开，并明确要求主 agent 不自行补答。
- **默认不动文件**：工作台不写 spec；`docs/decisions/` 是显式勾选的可选动作。
- **可恢复**：工作台、决策项、解释、追问、选择写入 `$DSH_HOME/storages/dsh-decision-workbench/workbenches.json`（保留最近 16 个）。

---

## 实现

```
src/index.js     Host：/decision 命令、JSON 路由、模型调用、摘要、持久化
src/client.js    Client：右侧栏 Tab 类型、文件选择器、清单/详情/问答/摘要
src/shared.js    纯函数：参数解析、JSON 提取与归一化、提示词、摘要、slug
docs/PLAN.md     项目计划
docs/INTERACTION.md  交互方案
example/         两份待测文档（有选项 / 无选项）
test/            node --test 单测（19 项）
```

Host 侧使用 `ctx.get('llm').stream()` 调用当前 profile 的默认模型（`agentDefaultModel`），只消费文本 delta；`ctx.get('agents')` 用于把摘要 `followup` 回主会话；`ctx.get('webServer')` 提供 loopback + 同源校验的 JSON 路由。

### 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-decision-workbench/pending?sessionId=` | 取待打开请求（pick / workbench） |
| POST | `/dsh-decision-workbench/pending/ack` | 面板处理完后清除请求 |
| GET | `/dsh-decision-workbench/files?sessionId=&query=` | 列出工作区候选文档 |
| POST | `/dsh-decision-workbench/start` | `{ sessionId, path, restart? }` 创建并开始枚举 |
| GET | `/dsh-decision-workbench/workbench?sessionId=` | 取当前工作台（含生成状态） |
| POST | `/dsh-decision-workbench/item` | 记录某题被打开 |
| POST | `/dsh-decision-workbench/explain` | 懒生成单题解释（`force` 可重试） |
| POST | `/dsh-decision-workbench/options` | 无选项时补 2–4 个方案 |
| POST | `/dsh-decision-workbench/ask` | 针对单题追问 |
| POST | `/dsh-decision-workbench/decide` | 三态 / 清除决定 |
| POST | `/dsh-decision-workbench/preview` | 生成摘要文本 |
| POST | `/dsh-decision-workbench/submit` | 摘要回写主会话 |
| POST | `/dsh-decision-workbench/write` | 写 `docs/decisions/<日期>-<slug>.md` |

所有路由 loopback + 同源校验；模型调用 180 秒超时。

---

## 安装

本机约定（源码 clone + link）：

```powershell
git clone <repo> F:\dsh-plugin\dsh-decision-workbench
# 在目标 profile 目录：
pnpm add link:F:\dsh-plugin\dsh-decision-workbench
```

或用插件管理器安装本地目录：

```sh
dsh plugin --profile desktop add link:F:/dsh-plugin/dsh-decision-workbench
```

安装后重启 `dsh web`（或禁用/启用一次插件行）并刷新页面。要求 DSH Web 0.2.x，Node.js ≥ 22；零运行时依赖、无构建步骤。

---

## 开发

```sh
npm run check   # node --check 三个 JS 文件
npm test        # node --test "test/*.test.js"（19 项）
```

无构建步骤；Client 改动刷新页面，Host 改动需重新加载插件行。

---

## 已知限制

- 决策助手是隔离的模型上下文，不是带文件工具的独立 DSH 子会话；文档全文（最多 60k 字）以片段形式内联给模型，超长文档会截断。
- 提交回主会话是一条普通用户消息（带 `[决策工作台]` 前缀），不是结构化协议消息。
- 面板视觉与键盘细节仍需在页面里人工确认；自动化验证覆盖注册、路由和模型链路。
- 每个会话只保留一个"当前工作台"；持久化里保留最近 16 个，但面板首屏只恢复最新的一个。
- 来源文档被移动或修改后，目前不会自动提示失效（M4）。

---

## License

MIT
