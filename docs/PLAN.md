# dsh-decision-workbench · 项目计划

> 状态：**M1–M3 已完成并实测；M4 大部分完成（来源同步、重复合并、历史工作台）；M5 部分完成（键盘、无障碍、i18n 实时切换、测试补齐）**
> 宿主：DeepSeek Harness Web 0.2.x（当前 0.2.1-rc.2）
> 0.3.0 起两条硬约束：**工作台绑定「会话 + 工作区」**、**讲解与实例按需生成**。0.4.0 起：**完成即写结果文件、通知主会话、删除工作台**。自主拍板的决策见 [DECISIONS.md](DECISIONS.md)。
> 设计基线：[INTERACTION.md](INTERACTION.md) · 交互方案全文
> 实现说明：决策助手使用隔离的只读模型调用（`ctx.llm.stream`），不是带工具的子会话；见 5.4。

---

## 1. 项目定位

把一份项目 spec 里"需要人拍板"的点，变成右侧栏里一份可逐题阅读、追问、拍板的决定清单；拍完把结果写成文件并通知主会话。

一句话流程：

```
/decision [文件名]
  → 右侧栏打开决策工作台
  → 逐题看解释 / 问独立决策助手 / 选方案
  → 完成：写 docs/decisions/… 结果文件
  → 通知主会话：只确认，等待用户下一步指令
  → 用户决定是否让主 agent 按结果执行
```

**本项目不改主 agent 的对话流程。** 主会话只负责两件事：在开工前把 spec 交给用户过一遍；在收到结果文件路径后只确认、等待用户指令。决策过程本身发生在右侧栏与一个独立的决策助手会话里。

---

## 2. 启动方式（命令优先）

启动不走提示词，走斜杠命令 `/decision`。

### 2.1 两种形态

| 命令 | 行为 |
|---|---|
| `/decision` | 打开右侧栏面板，**面板首屏是文件选择器**：从当前会话工作区里选一份文档开始 |
| `/decision <filename>` | 直接把该文件作为来源，创建并打开工作台，跳过选择器 |

`<filename>` 的解析规则：

1. 去掉首尾空白；
2. 支持与 Shell 一致的成对引号：`/decision "docs/spec v2.md"`；
3. 允许一个前导 `@`：`/decision @docs/spec.md`；
4. 其余整段视为一个文件名（含空格时请加引号）；
5. 先按相对路径解析，再按 basename 在工作区内查找；
6. 重名时列出候选，要求用相对路径重试；
7. 只接受文本类文档：`.md`、`.markdown`、`.mdx`、`.txt`、`.rst`、`.adoc`、`.json`、`.yaml`、`.yml`、`.html`。

### 2.2 命令执行流程

```
用户输入 /decision ...
  → Host 命令处理器解析参数
  → 无参数：写入 pending { mode: 'pick' }，返回“工作台已打开，选择一份文档”
  → 有参数：解析文件 → 写入 pending { mode: 'file', file }
  → 浏览器半监听器每秒轮询 /pending
  → 看到请求：pick 打开选择器；file 调 /start 创建工作台后打开 Tab
  → 轮询到 ack 后清除请求
```

为什么用 pending + 轮询：命令在 Host 侧执行，而打开右侧栏 Tab 是浏览器侧动作；这条单向通知用一个短轮询完成，与现有插件（如 dsh-delete-turn）的做法一致。后续可替换为 Typert Remote 流，但接口不变。

**命令不能声明 `input` 描述符。** 宿主命令一旦带 `input`，客户端会把不带参数的 `/decision` 解析为 leading-input 阶段，只把命令名留在输入框里等参数，并不会执行 handler——表现就是“输入后没有任何反应”。去掉该字段后两种形态都会立即执行。

### 2.3 命令文案

- 命令名：`decision`
- 描述：`打开决策工作台：/decision 选择文件，/decision <文件名> 直接开始`
- 输入提示：`[文件名]`
- 错误文案（三件事：发生了什么 / 为什么 / 怎么办）：
  - 无工作区：`当前会话还没有工作区。先打开一个工作区，再运行 /decision。`
  - 找不到：`没找到“x”。可以运行 /decision 打开面板选择，或检查文件名。`
  - 重名：`找到多个同名文件：a、b。请写相对路径再试一次。`
  - 越界：`这个文件不在当前工作区内。`
  - 不支持：`暂不支持 .pdf 格式，先试试 .md / .txt / .json / .yaml。`

### 2.4 文件选择器

- 位置：右侧栏 Tab 首屏。
- 数据：`GET /dsh-decision-workbench/files?sessionId=&query=`，按查询返回文本文档。空 query 返回空，不扫描项目；带 `/` 的查询只扫描对应子树；纯名称查询使用 30 秒缓存索引（最多 4000 个文档）。
- 跳过 `node_modules`、`.git`、`dist`、`build`、`target`、`vendor`、`.venv` 等生成/依赖目录；单次扫描有时间预算，最多返回 60 条。
- 排序：路径/文件名匹配度优先，同名更短路径优先；不再为每个文件做 `stat` 排序。
- 交互：输入相对路径或文件名（150ms 防抖）；输入框保持焦点，`↑/↓` 移动候选高亮、`Enter` 打开；点击也可选中；选中即调用 `/start` 并进入工作台。
- 候选刷新：路径序列变化（含顺序）→ 清除高亮；序列不变 → 保留高亮。
- 空态：
  - 空输入：`输入相对路径或文件名开始搜索，例如 docs/spec.md。`
  - 搜索无结果：`没有匹配的文件。`
- 选择器不是必须的：直接 `/decision <文件名>` 跳过它。

---

## 3. 用户旅程

### 3.1 有备选方案的 spec

1. `/decision docs/payment-refactor.md`
2. 右侧栏打开，列表出现 8 项（3 必决 / 3 建议 / 2 可选）。
3. 打开 Q1：选项标"来自 spec"，推荐项带一句理由。
4. 对 Q1 点"举个例子"或输入追问，助手回答带 `文件:行`。
5. 选择、写理由、标记已决定；对拿不准的题标"拿不准"。
6. 预览决定摘要 → 完成 → 写入结果文件并通知主会话（只要求确认）。

### 3.2 没有备选方案的 spec

1. `/decision` → 选择器选中 `spec.md`。
2. 打开"缓存方案"一题：显示"spec 没有给出备选"。
3. 点"让助手给 2–3 个方案" → 方案卡 + 推荐项 + 代价。
4. 追问"业界通常怎么做" → 带来源的回答。
5. 选自定义方案，标记已决定，完成并生成结果文件。

### 3.3 只想知道有哪些决策

1. `/decision spec.md`
2. 列表扫一遍，不逐题展开。
3. 关闭 Tab；进度与未决清单保留，下次打开继续。

---

## 4. 交互方案（摘要）

完整版见 [INTERACTION.md](INTERACTION.md)。核心约定：

- 承载面：右侧栏原生 Tab（`sidebar.right.pane.tab`，类型 id `dsh-decision-workbench/workbench`，kind `decision-workbench`）。
- 布局：左侧决策列表（必决 / 建议 / 可选）+ 右侧详情（解释 / 选项 / 问一问 / 决定区）+ 底部完成条。
- 列表先到；讲解与实例都是按钮触发的按需生成（打开条目不产生调用）；缺失选项按需补。
- 每题独立的"问一问"thread，不进入主会话上下文。
- 每题三态出口：已决定 / 拿不准 / 稍后。
- 完成前预览摘要；未决与拿不准不被主 agent 猜成已决。
- 关闭、刷新、重启不丢进度。

---

## 5. 架构

### 5.1 两半

| 半边 | 职责 |
|---|---|
| Host（`src/index.js`） | 注册 `/decision`；解析/校验文件；维护 open request 与工作台记录；提供 loopback JSON 路由；M2 创建决策助手子会话；M3 写结果文件、通知主会话、删除工作台 |
| Client（`src/client.js`） | 注册右侧栏 Tab 类型与主体；监听 `/decision` 的 open request 并打开 Tab；文件选择器；M2 决策列表/详情/问答；M3 完成流程与 Tab 关闭 |

### 5.2 路由（M1–M3 已实现）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-decision-workbench/pending?sessionId=` | 取该会话的待打开请求 |
| POST | `/dsh-decision-workbench/pending/ack` | 面板处理完后清除请求 |
| GET | `/dsh-decision-workbench/files?sessionId=&query=` | 列出工作区候选文档 |
| POST | `/dsh-decision-workbench/start` | `{ sessionId, path, restart? }` → 创建工作台并开始枚举 |
| POST | `/dsh-decision-workbench/start-notice` | `{ sessionId, workbenchId, locale? }` → 按当前语言发送开始通知（幂等） |
| GET | `/dsh-decision-workbench/workbench?sessionId=&workbenchId=` | 取该会话当前工作台（可指定 id 浏览历史，含来源状态） |
| GET | `/dsh-decision-workbench/workbenches?sessionId=` | 列出本会话 + 本工作区的历史工作台 |
| POST | `/dsh-decision-workbench/activate` | 把历史工作台设为活跃（之后可编辑） |
| POST | `/dsh-decision-workbench/delete` | 删除某个历史 / 活跃工作台（活跃项删除后回退到最近一个） |
| POST | `/dsh-decision-workbench/item` | 记录某题被打开（不触发生成） |
| POST | `/dsh-decision-workbench/explain` | 按需生成单题讲解（`force` 重试） |
| POST | `/dsh-decision-workbench/examples` | 按需生成 2–3 个具体例子 |
| POST | `/dsh-decision-workbench/options` | 无选项时补 2–4 个方案 |
| POST | `/dsh-decision-workbench/ask` | 针对单题追问 |
| POST | `/dsh-decision-workbench/decide` | 三态 / 清除本题决定 |
| POST | `/dsh-decision-workbench/preview` | 生成摘要文本与统计 |
| POST | `/dsh-decision-workbench/submit` | 写 `docs/decisions/<日期>-<slug>.md`、通知主会话、删除工作台（`autoRead` / `locale` 可选） |
| POST | `/dsh-decision-workbench/write` | 只写结果文件、不结束工作台（手动接口） |
| POST | `/dsh-decision-workbench/resync` | 重算来源 hash 并标记失效引用 |

所有路由 loopback + 同源校验；工作台路由再校验「会话 + 当前生效工作区」，跨区返回 404；除 `/delete` 外，变更路由仅接受活跃工作台（历史只读，`409 read-only`）。模型调用 180 秒超时。

### 5.3 存储

- M1：内存（进程重启丢失）。
- M2–M3：`$DSH_HOME/storages/dsh-decision-workbench/workbenches.json`，保留最近 16 个工作台；工作台、决策项、讲解、实例、追问 thread、决定全部落盘。
- 0.3.0：每条记录带 `workspaceRoot`，恢复时按 `(sessionId, workspaceRoot)` 重建活跃索引；没有该字段的旧记录不再恢复。
- 0.4.0：完成时写 `docs/decisions/<日期>-<slug>.md` 后删除记录；旧 `submitted` 记录保留在存储中用于审计，但不出现在活跃/历史列表。
- 来源 hash/字节数/mtime 在读取文档时记录；`GET /workbench` 只用 stat 计算 `stale/missing`，`POST /resync` 才重算 hash 并标记失效引用。

### 5.4 决策助手（0.3.0）

- 隔离的只读模型上下文：每次枚举 / 讲解 / 实例 / 补方案 / 追问都是一次独立 `ctx.llm.stream()` 调用。
- 初始上下文包：文档片段（最多 60k 字，按题目 quote/行号截取相关段落）+ 本题 + 本工作台已做决定；**不含主会话历史**。
- **按需生成**：列表只枚举（不含每项背景/解释/实例）；讲解由「让助手讲解这一项」触发；实例由「举 2–3 个具体例子」单独触发。打开某一项本身不产生任何调用。
- 只读：不写文件、不执行命令；回答中的引用由提示词要求带 `文件:行`。
- 取舍：未使用带文件工具的子会话，换来更可控的上下文、更低的启动和按需成本、更简单的失败重试；升级为子会话保留为 M4 可选项。

### 5.5 结果文件与主会话通知（0.4.0）

- 完成时先写 `docs/decisions/<date>-<slug>.md`；摘要按 已决 / 拿不准 / 未决 三类显式标注，主 agent 不得猜测。
- 写入成功后删除工作台记录并关闭右侧工作台 Tab；结果文件是唯一持久交付物。
- 开始与完成各注入一条普通用户消息：开始消息说明「工作开始、等待结果」；完成消息带结果文件路径与统计，并明确要求只回复“收到”、不要读取/执行/制定计划。两条通知都按当前 DSH locale（`zh` / `en`）生成；开始通知由面板打开后调用 `/start-notice` 发送，完成通知由 `/submit` 携带 locale。`/decision` 的命令结果与菜单说明同样本地化。
- 完成弹层可选「完成后立即交给主 agent 执行」；默认关闭，只通知路径并等待用户下一步指令。勾选后通知要求读取结果后直接开始执行「已决定」项，不先回复确认；未决项仍需先问用户。开关保存在浏览器本地。
- 写入失败时工作台保留，可重试；通知失败不影响结果文件保存，界面会提示主会话未运行。

---

## 6. 数据模型（目标形态）

```ts
interface Workbench {
  id: string
  sessionId: string
  workspaceRoot: string          // 绑定键：与 sessionId 一起构成作用域
  status: 'generating' | 'ready' | 'failed' | 'submitted' // submitted 仅旧记录；当前完成即删除
  startNotified?: boolean      // 开始通知是否已发送（面板打开时幂等发送）
  source: {
    kind: 'file'
    path: string
    abs: string
    hash?: string
    bytes?: number
    mtimeMs?: number
    stale?: boolean              // 每次 GET 时按 stat 计算，不持久化依赖
    missing?: boolean
  }
  duplicatesMerged?: number
  sourceInvalidCount?: number
  createdAt: number
  updatedAt: number
  submittedAt?: number          // 旧版字段；当前完成记录会被删除
  items: DecisionItem[]
}

interface DecisionItem {
  id: string
  section?: string
  priority: 'blocking' | 'important' | 'optional'
  status: 'unseen' | 'decided' | 'unsure' | 'deferred'
  title: string
  question: string
  source: { path: string; line?: number; quote?: string }
  sourceStale?: boolean          // /resync 后引用失效
  optionsOrigin: 'spec' | 'generated' | 'none'
  options: Option[]
  recommendation?: { optionId: string; why: string }
  explanationState: 'idle' | 'loading' | 'ready' | 'error'
  explanation?: Explanation       // 仅按需生成
  examplesState: 'idle' | 'loading' | 'ready' | 'error'
  examples?: { if: string; then: string }[]   // 仅按需生成
  examplesNote?: string
  optionsState: 'idle' | 'loading' | 'ready' | 'error'
  optionsError?: string
  mergedFrom?: { id: string; title: string; question: string }[]
  decision?: { optionIds: string[]; custom?: string; rationale?: string; at: number }
  thread: ThreadMessage[]
}

interface Option {
  id: string
  label: string
  tradeoff: string
  bestWhen?: string
  risk?: string
  from: 'spec' | 'assistant' | 'user'
}

interface Explanation {
  gist: string
  whyNow: string
  background: string
  scenarios: { if: string; then: string }[]
  impact: string
  assumptions: string[]
  citations: { path: string; line?: number; quote?: string }[]
}
```

---

## 7. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0 初始化** | 项目骨架、bundle patch、locale、icon、README、计划与交互文档 | ✅ 完成 |
| **M1 启动链路** | `/decision` 命令、open request、右侧栏 Tab、文件选择器、`/start`、测试 | ✅ 完成并实测 |
| **M2 决策清单** | 决策枚举、列表/详情/解释懒加载、无选项补方案、逐题追问 | ✅ 完成并实测 |
| **M3 决定与结果文件** | 选项/自定义/三态、摘要预览、结果文件、主会话通知、持久化、完成后删除 | ✅ 完成；0.4.0 路由测试通过 |
| **M4 收敛** | 来源变更同步、重复项合并、历史工作台、升级为带工具的子会话 | 🟡 前三项完成；子会话升级保留为可选 |
| **M5 打磨** | 键盘/无障碍/窄屏/全屏、成本面板、性能与测试补齐 | 🟡 键盘与 listbox/aria、i18n 实时切换、37 项单测完成；全屏/成本面板未做 |

---

## 8. 任务拆分（可直接执行）

### M1（完成）

- [x] `package.json`（bundle patch + client web + engines.dsh）
- [x] `cordis.patch.yml` 插入行
- [x] `src/shared.js`：参数解析、扩展名、路径包含、posix 归一化
- [x] `src/index.js`：命令、pending 队列、files/start/workbench 路由、loopback 校验
- [x] `src/client.js`：Tab 类型、open request 监听、文件选择器
- [x] locale / icon / README / CHANGELOG / LICENSE / .gitignore
- [x] 安装到 `desktop` profile，右侧栏 Tab 类型注册进当前页面
- [x] `/decision <filename>` 跳过选择器直接进入工作台并开始枚举
- [x] 命令错误文案（无工作区、找不到、重名、越界、不支持格式）

### M2（完成）

- [x] Host：`/start` 读取文档、调用默认模型、注入隔离上下文
- [x] Host：决策枚举（标题/问题/章节/优先级/出处/来自 spec 的选项与推荐）与结构校验
- [x] Host：`/explain`、`/options`、`/ask` 路由与失败重试
- [x] Client：列表（优先级分组/筛选/进度）、详情（解释卡/选项/推荐/自定义/理由）
- [x] Client：问一问 thread、建议问法
- [x] 懒加载与缓存；失败重试与空态
- [x] 存储落盘与重开恢复

### M3（完成）

- [x] 决定区三态、自动保存、清除本题决定
- [x] 完成前摘要预览与未定项提示
- [x] 结果文件生成、预览、写入 `docs/decisions/<日期>-<slug>.md`
- [x] 开始 / 完成通知主会话（按当前 DSH locale，只要求确认）
- [x] 完成后删除工作台并关闭 Tab
- [x] 可选立即交给主 agent 执行（默认等待）

### M4/M5

- [x] 来源 hash 监控与重新同步（`/workbench` 只 stat 提示，`/resync` 重算并标记）
- [x] 重复决策检测与合并（同题 + 标题相似，保留别名）
- [x] 历史工作台（只读浏览 + `/activate` 继续 + `/delete` 删除）
- [ ] 决策助手升级为带文件工具的子会话（不改面板接口；与省 token 目标冲突，保留可选）
- [x] 键盘（J/K、↑/↓、Esc）与 listbox/aria
- [x] i18n 实时切换（订阅 locale）
- [ ] 全屏切换、成本面板、窄屏细节走查
- [x] 测试补齐（纯函数、客户端冒烟、Host 删除、完成/开始通知与文件搜索路由共 37 项；跨区拒绝与按需生成实测）
- [ ] Client 组件测试（需要可用的浏览器测试环境）

---

## 9. 验收标准

- `/decision` 在 1 秒内打开右侧栏，首屏是文件选择器；空输入不扫描，输入相对路径/文件名后列出匹配文档。
- **全新空会话**中 `/decision` 不可用（DSH 命令目录需首次历史加载）；先发送一条消息再运行。`/decision <文件名>` 同样需要目录就绪。
- `/decision docs/spec.md` 跳过选择器直接进入工作台，通常 10–30 秒列出全部决策项（模型枚举）。
- **打开某一项不产生模型调用**；点「让助手讲解这一项」/「举 2–3 个具体例子」后 5–20 秒出现结果（轮询更新）。
- 有选项时标"来自 spec"，无选项时可生成 2–4 个方案并给推荐。
- 关闭/刷新/重启后进度不丢（M3 起）。
- **切换工作目录后**：`/workbench` 返回空、按 id 读取与所有变更路由被拒（404），历史列表为空；切回后恢复。
- **另一个会话**（即使同一工作区）读取/修改本会话工作台被拒。
- 来源被外部修改时出现提示，重同步后失效项被标记，已做决定不变。
- 完成前工作区无任何文件被修改；完成后只新增 `docs/decisions/` 结果文件。
- 未决与拿不准在结果文件与主会话通知里显式保留，不被猜成已决。
- 完成后工作台不再出现在列表/Tab 中；主会话只收到“等待指令”的通知。
- 命令出错时文案说明"发生了什么 / 为什么 / 怎么办"。

**验证（2026-10-23，DSH Web 0.2.1-rc.2 / 插件 0.4.1）**：

- 自动化：`npm test` 37 项，覆盖纯函数、客户端冒烟、Host `/delete`、`/submit`（写文件、通知、删除）、`/start`（开始通知）与 `/files`（空查询不扫描、相对路径搜索、跳过生成目录），以及通知消息必须带 `role`、命令结果提示跟随 locale、文件选择器键盘选择的回归测试。
- 0.3.0 页面实测基线仍适用：枚举两份示例文档各 8 项；打开条目后 `explanationState` / `examplesState` 保持 `idle`；按需讲解约 11 秒（`maxTokens` 8000）、按需实例约 2 秒 3 组；三态决定、摘要统计与预览、`/write`、`/resync` 通过；跨会话与跨工作区拒绝生效；外部修改来源后 `stale=true`，`/resync` 清零。
- 0.4.x 尚未在页面手工走查：完成弹层、Tab 关闭、autoRead 开关、通知到达后的 agent 行为。
- 面板视觉、真实点击流程、键盘与 i18n 观感仍需人工确认（agent 无浏览器控制）。

---

## 10. 风险与待确认

| 风险/问题 | 处理 |
|---|---|
| 命令是 Host 侧执行，打开页签是 Client 侧动作 | M1 用 pending + 1s 轮询；若宿主提供命令事件流再替换，接口不变 |
| 右侧栏 Tab 类型注册 API 属于 0.2.x 新接口 | 已在 `sidebar-right` README 与 live Slots 中核对；安装后先验证注册不抛错 |
| 决策枚举质量不稳定 | 结构校验 + 出处强制 + 允许"漏了一项"手动补充 |
| 上下文成本 | 初始 ≤8k tokens、单题 ≤1.5k、单次追问 ≤2k、整工作台 ≤32k |
| 拿不准是否阻塞完成 | 默认不阻塞 + 完成前提示；后续可配置严格模式 |
| 写入项目的位置 | 固定 `docs/decisions/<日期>-<slug>.md`；回写 spec 决策表作为二期选项 |
| 大文档 | 决策项 > 50 时按章节分组并折叠可选组；支持分批生成 |

---

## 11. 与现有插件的关系

- `dsh-survey`：解决批量提问，但没有持久状态、逐题追问、独立 agent 与回写协议。
- `dsh-rich-questions`：选项带解释，但答题在主对话、一次性。
- `dsh-sidecard-ask`：证明了"独立子代理 + 右侧卡片"可行；本插件把"单次追问"扩展成"整份决策清单"。
- `dsh-decision-box`：右侧决策栏形态最接近，但只支持旧宿主；本插件借鉴其"栏 + 提交"的信息架构，改为命令启动 + 逐题工作台。

---

## 12. 目录

```
dsh-decision-workbench/
├── package.json          bundle / client / engines 声明
├── cordis.patch.yml      插入 profile 的插件行
├── icon.svg
├── locale/{zh,en}.json   meta 标题与描述
├── src/
│   ├── index.js          Host：命令 + 路由 + 工作台记录
│   ├── client.js         Client：Tab 类型 + 监听 + 选择器
│   └── shared.js         纯函数：参数解析 / 扩展名 / 路径
├── docs/
│   ├── PLAN.md           本文件
│   ├── INTERACTION.md    交互方案
│   └── DECISIONS.md      0.3.0–0.4.1 自主拍板的开发决策记录
├── test/shared.test.js
├── README.md
├── CHANGELOG.md
└── LICENSE
```
