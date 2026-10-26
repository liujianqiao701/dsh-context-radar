# dsh-context-radar

**Context bloat detector and per-document attribution for DeepSeek Harness.**

DSH already tells you *how full* the context window is. It does **not** tell you *what filled it*.
This plugin answers both:

| Question | Answer |
| --- | --- |
| Is my context bloated? | Multi-factor score (occupancy / growth rate / single-item dominance / dead weight) → 🟢 🟡 🟠 🔴 + concrete actions |
| Which document eats the most? | Ranked table of every system-prompt section, every `AGENTS.md`-style file, every skill, every tool result — with **% of used** and **% of window** |
| Why was my instructions file truncated? | It reads DSH's own budget marker and reports exactly how many bytes were dropped, and from which file |

**Zero hard dependencies.** Every DSH service is optional and probed at runtime — if something is missing, the
report loses a section instead of throwing.

---

## 中文说明

### 它解决什么问题

DSH 自带的 `tokenUsage` / `contextPressure` / `contextBreakdown` 三个投影只给出**三路聚合**
（system / tools / message）。你看到「消息占 82%」，但**不知道是哪五个文件、哪几条工具结果填出来的**。
本插件把这一层补上，并且额外回答一个 DSH 不回答的问题：**现在是不是该压缩了。**

### 三件事

1. **归因**——把上下文逐项列出来，每项给 token 数与两个百分比：
   - **占已用**：在已经吃掉的空间里占多少 → 回答「谁最该砍」
   - **占窗口**：在总窗口里占多少 → 回答「还剩多少余量」
   两个分母不同，答案也不同，所以两列都给。

2. **判定**——用四因子加权打分，不是拍脑袋阈值：

   | 因子 | 权重 | 含义 |
   | --- | --- | --- |
   | 上下文占用率 | 45% | 已用 / 模型窗口（有提供方报告的压力时以它为准） |
   | 增长速率 | 20% | 最近 3 轮平均新增，折算「还能撑几轮」 |
   | 单点垄断度 | 20% | 最大单项占已用比例，>25% 说明有「一个怪物」 |
   | 冗余 / 死重 | 15% | 同一文件被重复读取累计的 token |

3. **告警**——几条**不看分数、命中即报**的硬事实：
   - 🔴 工作区指令被**截断**（`AGENTS.md` 超字节预算）→ 精确报出丢了哪个文件、丢了多少字节、丢了几成
   - 🔴 有指令文件被**整体丢弃**
   - 🟡 单个工具结果 ≥ 已用 15%
   - 🟡 某个 skill 正文 ≥ 已用 8%

### 一个必须说明的口径问题

DSH 官方计价是「**4 个字符 = 1 token**」，这是**英文密度**。中文实测约 1 字符 ≈ 0.6~1 token，
所以官方数字对中文内容**低估 3~4 倍**（DSH 自己的文档也承认 CJK 与 JSON schema 被严重低估）。

本插件因此提供两套口径：

- `cjk*`（默认）—— 中文按 1 字符 1 token（保守），英文按 4 字符 1 token，**用于判膨胀**
- `dsh*` —— 与 DSH 官方逐字节一致，仅用于对照

为什么不能只用官方口径：占比是等比缩放的，低估无所谓；但**判膨胀时低估是致命的** ——
明明已经 90%，按 4 字符/token 算出来只有 25%，于是永远不告警。

报告里会明确标出「数字约为 DSH 官方口径的 N 倍」，所以不会和 DSH 面板对不上时产生困惑。

### 三个入口

| 入口 | 用途 |
| --- | --- |
| 工具 `context_radar` | 模型按需查（`limit` 控制行数，`probes` 附带采集诊断） |
| `/ctx` · `/ctx-watch` | 你自己看，**不消耗模型回合**；`/ctx --all` 看全量 |
| 系统提示词段落 | **只在超阈值时**注入一行提醒；健康时返回空串，零开销 |
| `GET /api/dsh-context-radar/report` | GUI 面板的数据接口（JSON） |

### 数据从哪来（不猜，全有出处）

⚠️ 先记一条**实测坑**：DSH 的事件有两种形状 —— `user/message` 的 `data` **本身就是消息**
（`data.source` / `data.content`），`assistant` / `tool/result` / `system` 才是 `data.message`。
只认一种会静默丢掉全部按文档归因。

⚠️ 第二条**实测坑**：不能遍历原始事件日志。DSH 是事件溯源的，**压缩不删日志** ——
被压缩掉的历史仍在日志里，直接遍历会算出物理上不可能的占用（实测 2751%）。
所以归因吃的是 `session.surface.deriveMessages()`（模型真正看到的那份）。

| 层 | DSH 事实来源 | 拿到的粒度 |
| --- | --- | --- |
| **绝对占用** | `assistant/message` 的 `data.usage.totalTokens`（= input + cacheRead + output） | **提供方账单口径的真值**，优先于一切估算 |
| 会话画布 | `session.surface.deriveMessages()` | 模型实际看到的冻结消息数组 |
| 系统提示词 | `system/message` 的实际总量 + `systemPrompt.assemble()` 各段字符占比 | **逐段**（总量用实际消息，各段只负责分摊） |
| 工作区指令 | `user/message` 的 `data.source.kind === 'agent-instructions'` | **逐文件**（按 `Instructions from: <path>` 分节） |
| 运行时上下文 | `data.source.kind === 'runtime-context'` 且 `source.sections[]` | **逐段**（沙箱策略等） |
| skill 目录 | `source.kind === 'skill-catalog'` 且 `source.entries[]` | **逐 skill** |
| skill 正文 | `source.kind === 'skill-invocation'` 且 `source.name` | **逐 skill** |
| 工具结果 | `tool/result` → `message.source.callId` → `assistant/message` 的 `tool-call` 块 | **工具名 + 目标文件/命令** |
| 真实窗口 | `ctx.llm.resolveModelInfo(provider, model).context` | 模型真实上限 |
| 投影压力 | `contextPressure` 投影的 `projectedTokens` | 账单拿不到时的次选 |
| 字节预算 | 注入正文里的 `Workspace instruction budget N bytes: …` | 预算 + 截断/丢弃明细 |

### 安装

```bash
# 已经在本机：把 <插件目录> 换成你的路径
dsh plugin --profile desktop add link:<插件目录>
```

或者手工两步（等价）：

1. profile 的 `package.json` 里加依赖与 bundle：
   ```json
   {
     "dependencies": { "dsh-context-radar": "link:D:/path/to/dsh-context-radar" },
     "dsh": { "profile": { "bundles": ["...", "dsh-context-radar"] } }
   }
   ```
2. 在 `<profile>/node_modules/` 下建到插件目录的联接（Junction / symlink）。

**改动后必须重启 DSH** 才会加载。

### GUI 面板（会话头部徽标 → 弹窗）

插件带一个客户端半身（`lib/client.js`）。它往 `conversation.session.header.actions` 插槽注册一个**占用率徽标**，
点开是完整排行榜面板：占用率进度条、前 15 项（类别 / 来源 / token / 占已用 / 占窗口 + 条形图）、硬告警与建议。
每 30 秒自动刷新，数据取自同源的 `/api/dsh-context-radar/report`。

**不需要构建步骤。** DSH 前端模块 ABI 是 `window.__ModuleLoader__.load({ id, factory })`，
`factory(require)` 返回 `{ apply, inject }`，`apply(ctx)` 里用 `ctx.get('slots')` 注册组件。
参考实现（dsh-cost-meter / dsh-better-sidebar）都是 esbuild 预打包的产物，但打包的源码本身也是这个 ABI ——
所以这里直接手写纯 JS（只用 `React.createElement`，不碰 JSX/TS），省掉一层构建依赖。

包声明要**两处同时**满足，缺一个宿主就不认：

```jsonc
{ "exports": { "./client": "./lib/client.js" },
  "dsh": { "client": { "platform": "web" } } }
```

缺 `exports["./client"]` → `declares dsh.client but exports no "./client" bundle`；
`__ModuleLoader__.load` 的 `id` 必须等于包名，否则 → `loaded without registering "<id>"`。

> 客户端模块由宿主**启动时**扫描所有声明了 `dsh.client` 的包，**改完客户端代码必须重启 DSH**。

### 已知限制

- token 数是**估算**，不是分词器实测值。中文取 1 字符 1 token 是**有意偏保守**（宁可早报，不可漏报）；
  要更贴近实测可改 `lib/estimate.js` 的 `DENSITY.cjk`（`0.6` 更接近 DeepSeek 分词器）。
- 归因覆盖不了「无法逐条归因」的部分（适配器内部开销等）。这种情况会**单列一条「未归因」**，
  保证各项之和严格等于提供方账单，两个百分比列的口径一致、可以互相验算。
- 拿不到模型窗口时（`llm` 服务缺失或不知道 provider/model），只给构成、不给膨胀结论 —— 不猜。
- 「工具定义」一项按**最近一次请求**的工具清单算。会话中途工具集变了（MCP server 挂载/卸载、
  跨会话恢复），要等下一次请求才反映出来。

## 二、踩过的 DSH 契约坑（写给维护者）

这些**全部是实机才暴露**的，写完照样有过 46 项测试全绿的版本 —— 假数据照着错假设编，测试再绿也没用。
改这个插件前请先读一遍：

| 契约 | 规则 | 写错的后果 |
| --- | --- | --- |
| 工具 `parameters` | 必须是**完整** JSON Schema：`{ type: 'object', properties, required }` | 平铺属性 → 网关报 `schema must be of 'type: "object"', got 'type: null'` → **整个会话的消息都发不出去** |
| 工具 `output.schema` | `required` 放在**对象层**（数组），不能写进每个属性 | 报 `required is not supported on type "string"` → 工具**静默注册不上** |
| 命令定义 | 字段是 **`handler`**（不是 `run`）；收到一个 `invocation` 对象 `{ commandId, agent, rawInput, attachments, signal }`；**必须返回** `{ kind: 'success'\|'error', text }` | 报 `handler must be a function` / 返回值被拒收 → 命令静默消失 |
| 命令名 | 必须匹配 `/^[a-z][a-z0-9_-]*$/u`，`description` 非空 | 注册即抛错 |
| 服务挂载时序 | `apply()` 执行时 **`tools` / `webServer` 还没挂载**（`commands` / `systemPrompt` 已就绪） | 直接取到空 → 工具与路由**静默不注册**，插件"装了跟没装一样" |
| 模型窗口 | `llm.resolveModelInfo(p, m)` 返回 `{ context: { contextWindow } }` —— **嵌套** | 按 `info.context` 当数字取 → `typeof` 判定失败 → 窗口永远 `null` |
| 事件形状 | `user/message` 的 **`data` 本身就是消息**；`assistant` / `tool/result` / `system` 才是 `data.message` | 只认一种 → 按文档归因全部落空，还不报错 |
| 会话画布 | 压缩**不删日志**，必须吃 `surface.deriveMessages()` | 遍历原始事件 → 算出物理上不可能的占用（实测 2751%） |
| 绝对用量 | 锚在 `assistant/message` 的 `data.usage.totalTokens` | 纯本地估算 → 与实际账单差一个量级 |
| **客户端 `apply` 时序** | 客户端插件 factory 必须导出 **`inject: ['slots']`**，并且 `package.json` 的 `dsh.client.inject` 要声明 `@deepseek-ai/dsh-client-ui-slots` | cordis 会在 slots 服务挂载**之前**就调 `apply` → `ctx.slots` 取不到 → **没有徽标，也没有任何报错**，页面安安静静 |
| **前端取色** | 用 CSS 系统色 `Canvas` / `CanvasText`，**不要**用主题变量配硬编码回退 | `--dsw-alias-bg-primary` 实测**未定义**（回落到 `#fff` 白底），`--dsw-alias-label-primary` 在暗色主题下是 `#f9fafb` → **白底白字，面板整片看不见** |
| **插槽要等会话** | `conversation.session.header.actions` 只在**有会话打开**时渲染；空态（新建会话还没消息）不显示 | 在空页面上看不到徽标，误判成"没注册上" |
| **`slots.register` 语义** | 返回 `true` **只代表注册调用成功**，不代表渲染出来了 | 拿"注册成功"当"已生效" → 排查方向全错（本次实测：`registered: true` 而徽标已渲染，两者要分开验证） |

> 自检入口：DevTools 里看 `window.__contextRadar` —— `{ factoryRan, applyCalled, slotsType, registered, error }`，
> 一眼定位是"没加载 / 没调 apply / 拿不到 slots / 注册失败"哪一步断的。


## License

MIT
