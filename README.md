# dsh-decision-workbench

DeepSeek Harness 的**决策工作台**：通过 `/decision` 打开右侧栏面板，把一份 spec 里的开放决策拆成逐题选择，随时向独立的决策助手追问，最后把决定摘要交回主会话。

> **状态：脚手架（M1）**
> `/decision` 命令、右侧栏 Tab、文件选择器、open request 链路已落盘；
> 决策枚举、解释、逐题问答、提交回写尚未实现（M2/M3）。
> 计划见 [docs/PLAN.md](docs/PLAN.md)，交互方案见 [docs/INTERACTION.md](docs/INTERACTION.md)。

---

## 用法

```
/decision                  打开右侧栏，选择一份文档开始
/decision <文件名>         直接以该文件开始（相对工作区路径，可加引号）
```

示例：

```
/decision docs/payment-refactor.md
/decision "docs/spec v2.md"
/decision @spec.md
```

文件解析规则：

- 先按相对路径找，再按 basename 在工作区里找；
- 重名会列出候选，要求写相对路径；
- 只接受 `.md .markdown .mdx .txt .rst .adoc .json .yaml .yml .html`；
- 文件必须在当前会话工作区内。

---

## 当前能力

| 能力 | 状态 |
|---|---|
| `/decision` 命令 | ✅ |
| 右侧栏决策工作台 Tab | ✅ |
| 文件选择器（搜索、工作区文档列表） | ✅ |
| `/decision <filename>` 直接开始 | ✅ |
| 决策项枚举 | ⬜ M2 |
| 逐题解释 / 选项生成 / 问答 | ⬜ M2 |
| 决定与摘要回写 | ⬜ M3 |

---

## 安装

按本机约定（源码 clone + link）：

```powershell
git clone <repo> F:\dsh-plugin\dsh-decision-workbench
# 在目标 profile 目录：
pnpm add link:F:\dsh-plugin\dsh-decision-workbench
```

或使用 DSH 插件管理器安装本地目录（会写入 bundle 选择）：

```sh
dsh plugin --profile web add link:F:/dsh-plugin/dsh-decision-workbench
```

安装后重启 `dsh web` 并刷新页面。

要求：DSH Web 0.2.x（当前验证目标 0.2.1-rc.2），Node.js ≥ 22。零运行时依赖、无构建步骤。

---

## 结构

```
src/index.js     Host：/decision 命令、pending 队列、files/start/workbench 路由
src/client.js    Client：右侧栏 Tab 类型、open request 监听、文件选择器
src/shared.js    纯函数：参数解析、扩展名、路径包含
docs/PLAN.md     项目计划（里程碑、任务、验收）
docs/INTERACTION.md  交互方案（命令启动、界面、状态机、文案）
test/            node --test 单测
```

---

## 开发

```sh
npm run check   # node --check 三个 JS 文件
npm test        # node --test "test/*.test.js"
```

无构建步骤；修改源码后刷新页面即可（Host 改动需重启 `dsh web`）。

---

## 设计要点

- **命令优先**：启动不依赖提示词；`/decision` 确定性地打开面板。
- **右侧栏 + 独立助手**：决策过程不进入主会话上下文。
- **列表先到、解释按需**：打开即看到全部决策项，点开某题才生成解释。
- **未决不猜**：提交摘要显式保留"拿不准/未决"，主 agent 不得自行补答。
- **默认不动文件**：只有勾选"写入项目"才落 `docs/decisions/*.md`。

---

## License

MIT
