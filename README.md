# dsh-decision-workbench

DeepSeek Harness 的**决策工作台**：通过 `/decision` 打开右侧栏面板，把一份 spec 里的开放决策拆成逐题选择，随时向隔离的决策助手追问，最后把决定摘要交回主会话。

> **状态：0.3.0（M1 + M2 + M3 完整；M4/M5 部分完成）**
> 已在 DSH Web 0.2.1-rc.2（`desktop` profile）实测：命令链路、决策枚举、按需讲解与实例、无选项补方案、逐题追问、选择与摘要预览、写入 `docs/decisions/`、来源变更检测与重同步、历史工作台只读浏览、跨会话/跨工作区拒绝。
> **工作台绑定「会话 + 工作区」**：切换工作目录后看不到、也改不了原来的工作台；另一个会话同样看不到。
> **讲解与实例都按需生成**：打开某一项不会产生任何模型调用，点按钮才生成。
> 计划见 [docs/PLAN.md](docs/PLAN.md)，交互方案见 [docs/INTERACTION.md](docs/INTERACTION.md)，本轮自主拍板的开发决策见 [docs/DECISIONS.md](docs/DECISIONS.md)，示例文档见 [example/](example/)。

---

## 它解决什么

一份 spec 里通常散落着若干"需要人拍板"的点：有备选方案的、只有问题没有方案的、影响开工的、可以后补的。工作台把它们收进右侧栏：

1. `/decision` 或 `/decision <文件名>` 启动；
2. 自动通读文档，列出全部决策项（必决 / 建议 / 可选）；
3. **只在点按钮时**才生成这一题的讲解（结论、为什么现在、背景、影响、假设、引用）；
4. 想要具体场景时，再点「举 2–3 个具体例子」，生成「如果…就…」；
5. spec 有选项就直接选；没有就让助手补 2–4 个方案并给推荐；
6. 对任意一题追问，回答只看文档与本工作台，不污染主对话；
7. 逐题标记"已决定 / 拿不准 / 稍后"，预览摘要后提交回主会话。

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

布局：面板宽度 ≥520px 时是双栏——左侧决策清单（固定约 180–250px），右侧是当前题的解释、选项、决定区和问一问，底部是提交条；更窄时点开一题进入详情、左上角“返回清单”。

| 区域 | 作用 |
|---|---|
| 文件选择器 | 搜索工作区文档；顶部显示"继续上次的工作台"，下方列出**历史工作台**（只读查看 / 继续编辑） |
| 决策清单 | 按优先级分组，可筛选全部 / 必决 / 未完成 / 已决定；显示进度与必决剩余；相似决策显示"已合并 N 项" |
| 单题详情 | 题干、出处、讲解卡、实例卡、选项、自定义方案、理由、三态按钮 |
| 讲解卡 | 默认不生成；点「让助手讲解这一项」才生成结论/为什么现在/背景/影响/假设/引用 |
| 实例卡 | 默认不生成；点「举 2–3 个具体例子」才生成「如果…就…」场景 |
| 选项 | 标记"来自 spec / 助手补充"；推荐项带理由；无选项时可让助手补 |
| 问一问 | 每题独立 thread；回答带 `文件:行` 出处；建议问法一键发送 |
| 摘要 | 预览完整摘要、复制、提交到主会话、可选写入 `docs/decisions/<日期>-<标题>.md` |

进度、选择、理由、追问线程、已生成的讲解与实例都会自动保存；关闭 Tab、刷新页面、重启 Harness 后再次 `/decision` 可继续。

来源文档被外部修改时，顶部提示「来源文档已更新」，可点「重新同步」重算出处；失效的项标「出处可能失效」，已做的决定不会被自动改动。

历史工作台默认只读：可以查看已缓存的讲解、实例与决定；点「继续这个工作台」才能修改（服务端也会拒绝在非活跃工作台上写入）。

---

## 当前能力

| 能力 | 状态 |
|---|---|
| `/decision` 命令 | ✅ |
| 右侧栏决策工作台 Tab | ✅ |
| 文件选择器（搜索、工作区文档列表、继续上次、历史工作台） | ✅ |
| `/decision <filename>` 直接开始 | ✅ |
| 决策项枚举（优先级 / 出处 / 来自 spec 的选项） | ✅ |
| 重复决策合并（同题 + 标题相似） | ✅ |
| 按需讲解（打开不生成） | ✅ |
| 按需实例（如果…就…，独立请求） | ✅ |
| 无选项时生成 2–4 个方案 + 推荐 | ✅ |
| 逐题追问（独立上下文、带引用） | ✅ |
| 已决定 / 拿不准 / 稍后 / 清除 | ✅ |
| 摘要预览、复制、提交回主会话 | ✅ |
| 可选写入 `docs/decisions/` | ✅ |
| 工作台绑定会话 + 工作区，跨区拒绝 | ✅ |
| 来源变更检测与重新同步 | ✅ |
| 历史工作台只读浏览 / 继续编辑 | ✅ |
| 跨刷新 / 重启恢复 | ✅ |
| 键盘 J/K、Esc，清单 listbox | ✅（面板聚焦后生效） |
| 决策助手升级为带文件工具的子会话 | ⬜ M4 可选 |
| 全屏、成本面板、完整无障碍走查 | ⬜ M5 |

---

## 设计要点

- **命令优先**：启动不依赖提示词。命令在 Host 侧解析文件，浏览器半通过 pending 轮询打开 Tab。
- **作用域封闭**：工作台属于创建它的「会话 + 工作区」。所有路由先解析当前生效目录再比对，跨区一律 404；轮询 `/pending` 也会在目录切换后作废旧请求。
- **隔离的决策助手**：每次生成或追问都是独立、只读的模型调用，提示词只包含文档片段、本题和本工作台已做决定，不继承主会话历史。
- **列表先到、讲解与实例按需**：先出全部决策项；讲解与实例各自一个按钮、各自缓存；不点就不花 token。
- **未决不猜**：摘要把"已决定 / 拿不准 / 稍后 / 未处理"分开，并明确要求主 agent 不自行补答。
- **默认不动文件**：工作台不写 spec；`docs/decisions/` 是显式勾选的可选动作。
- **来源可核对**：来源被改过只提示、不自动改写决定；重同步才更新 hash 与失效标记。
- **可恢复**：工作台、决策项、讲解、实例、追问、选择写入 `$DSH_HOME/storages/dsh-decision-workbench/workbenches.json`（保留最近 16 个），历史可按会话+工作区浏览。

---

## 实现

```
src/index.js     Host：/decision 命令、JSON 路由、工作区作用域、模型调用、摘要、持久化
src/client.js    Client：右侧栏 Tab 类型、文件选择器、清单/详情、按需讲解与实例、问答、摘要
src/shared.js    纯函数：参数解析、JSON 提取与归一化、提示词、重复合并、失效检测、摘要、slug
docs/PLAN.md     项目计划
docs/INTERACTION.md  交互方案
docs/DECISIONS.md    本轮自主拍板的开发决策记录
example/         两份待测文档（有选项 / 无选项）
test/            node --test 单测（25 项）
```

Host 侧使用 `ctx.get('llm').stream()` 调用当前 profile 的默认模型（`agentDefaultModel`），只消费文本 delta；`ctx.get('agents')` 用于把摘要 `followup` 回主会话；`ctx.get('webServer')` 提供 loopback + 同源校验的 JSON 路由；`ctx.get('workingDirectory')` 决定当前生效工作区。

### 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-decision-workbench/pending?sessionId=` | 取待打开请求（pick / workbench；目录切换后作废） |
| POST | `/dsh-decision-workbench/pending/ack` | 面板处理完后清除请求 |
| GET | `/dsh-decision-workbench/files?sessionId=&query=` | 列出工作区候选文档 |
| POST | `/dsh-decision-workbench/start` | `{ sessionId, path, restart? }` 创建并开始枚举 |
| GET | `/dsh-decision-workbench/workbench?sessionId=&workbenchId=` | 取当前工作台（可指定 id 浏览历史，含来源状态） |
| GET | `/dsh-decision-workbench/workbenches?sessionId=` | 列出本会话 + 本工作区的历史工作台 |
| POST | `/dsh-decision-workbench/activate` | 把某个历史工作台设为活跃（之后可编辑） |
| POST | `/dsh-decision-workbench/item` | 记录某题被打开（不触发生成） |
| POST | `/dsh-decision-workbench/explain` | 按需生成单题讲解（`force` 重试） |
| POST | `/dsh-decision-workbench/examples` | 按需生成 2–3 个具体例子 |
| POST | `/dsh-decision-workbench/options` | 无选项时补 2–4 个方案 |
| POST | `/dsh-decision-workbench/ask` | 针对单题追问（立即返回，轮询收敛） |
| POST | `/dsh-decision-workbench/decide` | 三态 / 清除决定 |
| POST | `/dsh-decision-workbench/preview` | 生成摘要文本与统计 |
| POST | `/dsh-decision-workbench/submit` | 摘要 `agent.followup` 回主会话 |
| POST | `/dsh-decision-workbench/write` | 写 `docs/decisions/<日期>-<slug>.md` |
| POST | `/dsh-decision-workbench/resync` | 重算来源 hash 并标记失效引用 |

所有路由 loopback + 同源校验；工作台路由额外校验「会话 + 当前生效工作区」，跨区返回 404。变更路由只接受当前活跃工作台（历史工作台返回 `409 read-only`）。模型调用 180 秒超时。

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
npm test        # node --test "test/*.test.js"（25 项）
```

无构建步骤；Client 改动刷新页面，Host 改动需重新加载插件行。

---

## 第一次使用

- 安装或更新插件后，先刷新一次网页，让浏览器半加载新的 client bundle；Host 半的改动需要禁用再启用插件行（或重启 `dsh web`）。
- `/decision` 执行后会立即出现一条“决策工作台已打开”的命令结果，右侧栏应同时展开并显示文件选择器。若右侧栏原本处于收起状态，也可以点会话右上角的展开按钮找回。
- 如果 `/` 菜单里没有 `decision`，到设置 → 插件确认 `dsh-decision-workbench` 已启用。

---

## 已知限制

- 决策助手是隔离的模型上下文，不是带文件工具的独立 DSH 子会话；文档全文（最多 60k 字）以片段形式内联给模型，超长文档会截断。升级为子会话仍是 M4 的可选项（见 [docs/DECISIONS.md](docs/DECISIONS.md) §9）。
- 提交回主会话是一条普通用户消息（带 `[决策工作台]` 前缀），不是结构化协议消息。
- 工作台严格绑定创建时的会话与工作区：换目录后原工作台“看不见”，切回目录才恢复；旧版（≤0.2.1）没有工作区字段的持久化记录不再恢复。
- 历史工作台默认只读，只显示已缓存的讲解/实例；要生成新内容必须先「继续这个工作台」。
- 一个会话在一个工作区内只保留一个活跃工作台；历史最多列出 12 个（存储保留 16 个）。
- 来源变更只按 `size/mtime` 提示，重同步才重算 hash；内容相同但 mtime 变化也会先提示一次。
- 键盘快捷键需要面板内有焦点（不做自动聚焦，避免抢走主会话输入焦点）。
- 面板视觉、真实点击流程与语言切换观感仍需在页面里人工确认；自动化验证覆盖纯函数与 Host 路由（含跨区拒绝）。
- 模型输出预算随题目复杂度波动；讲解/实例在推理型模型上偶发 max-tokens 失败，界面提供重试。

---

## License

MIT
