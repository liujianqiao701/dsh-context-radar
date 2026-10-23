/**
 * dsh-context-radar —— cordis 宿主侧入口。
 *
 * 本插件回答两个问题：
 *   ① **当前上下文膨胀了吗？** —— 用真实窗口 + 真实压力 + 多因子打分，给出分级与可执行建议；
 *   ② **谁在吃我的上下文？** —— 把系统提示词各段、AGENTS.md 各文件、每个 skill、
 *      每条工具结果逐项列出来，给出「占已用 %」与「占窗口 %」两列百分比。
 *
 * 提供四件事：
 *   - **1 个工具** `context_radar`：按需出一份完整排行榜；
 *   - **1 个斜杠命令** `/ctx`：人自己看，不消耗模型回合；
 *   - **1 段系统提示词**：只在**超过阈值**时才注入一行提醒（健康时零开销）；
 *   - **1 条 HTTP 路由**：给 GUI 面板供数据（`/api/dsh-context-radar/report`）。
 *
 * ⚠️ 全篇零静态 `@deepseek-ai/*` import：本插件常以 `link:` 安装，真实路径在 profile 之外，
 *    Node 解析不到 profile 的 `node_modules\@deepseek-ai\*`。因此一律走 `serviceOf` 可选取服务 +
 *    `pickMethod` 探测方法名，并在每段注册外面包 try/catch —— **插件绝不能把 DSH 启动搞挂**。
 */

import { collectFacts, pickMethod, serviceOf } from './collect.js'
import { analyze } from './engine.js'
import { renderOneLine, renderReport } from './render.js'

export const name = 'dsh-context-radar'
/** 硬依赖为空：拿不到任何服务时静默降级，不影响 DSH 启动。 */
export const inject = []

const PROMPT_SECTION = 'context-radar'
/** 提示词段落顺序：950 = 很靠后，不插进别的段落中间。 */
const PROMPT_ORDER = 950
/** 分析结果缓存时长。提示词段落每次组装都会求值，不能每次都走全量归因。 */
const CACHE_TTL_MS = 4000
/** 缓存条数上限，防止会话种类无限增长。 */
const CACHE_MAX = 32

const TOOL_REGISTER_METHODS = ['register', 'defineTool', 'define', 'add']

/** 统一的降级日志：只在 stderr 上说一句。 */
function warn(message) {
  try {
    process.stderr.write(`dsh-context-radar: ${message}\n`)
  } catch {
    /* stderr 都写不了就算了 */
  }
}

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 渲染时要防的一件事：`renderPrompt` 对 `{{...}}` 是**严格模式**，未知变量会抛错，
 * 而我们的正文里会带用户的项目名/文档名，所以先把 `{{` 打断。
 */
function neutralizeBraces(text) {
  return String(text).replace(/\{\{/g, '{ {')
}

// ---------------------------------------------------------------------------
// 分析缓存：key = 会话 + 事件进度
// ---------------------------------------------------------------------------

const cache = new Map()
const pending = new Set()

/** 算缓存键：会话 id + 事件条数 + 末条 seq —— 日志变长就重算，没变就复用。 */
function cacheKeyOf(session, events) {
  const id = session?.header?.id ?? session?.id ?? 'anonymous'
  const last = events.length > 0 ? (events[events.length - 1]?.seq ?? '') : ''
  return `${id}::${events.length}::${last}`
}

/** 取该会话的快照（同步，只读 `snapshotEvents()`）。 */
function snapshotOf(session) {
  if (session === null || session === undefined) return []
  try {
    const events = session.snapshotEvents?.()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * 异步刷新一份分析结果。
 * @param {object} ctx cordis 上下文
 * @param {object} exec 工具/段落上下文（要能取到 `agent`）
 * @param {string} key 缓存键
 * @returns {Promise<object|null>} 分析结果
 */
async function refresh(ctx, exec, key) {
  if (pending.has(key)) return null
  pending.add(key)
  try {
    const facts = await collectFacts(ctx, exec)
    const analysis = analyze(facts)
    analysis.probes = facts.probes
    analysis.provider = facts.provider
    analysis.model = facts.model
    if (cache.size > CACHE_MAX) cache.clear()
    cache.set(key, { at: Date.now(), analysis, line: renderOneLine(analysis) })
    return analysis
  } catch (error) {
    warn(`分析失败（已降级为空报告）—— ${msgOf(error)}`)
    return null
  } finally {
    pending.delete(key)
  }
}

/** 拿一份最新的分析结果（工具与命令用；这里是 async，可以等）。 */
export async function analyzeNow(ctx, exec) {
  const session = exec?.agent?.session
  const events = snapshotOf(session)
  const key = cacheKeyOf(session, events)
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.analysis
  const fresh = await refresh(ctx, exec, key)
  if (fresh !== null) return fresh
  return hit?.analysis ?? null
}

// ---------------------------------------------------------------------------
// ① 工具
// ---------------------------------------------------------------------------

/** 工具定义。 */
const TOOL = {
  name: 'context_radar',
  description:
    '列出当前上下文里「谁在吃 token」：系统提示词各段、AGENTS.md 等每个 md 文件、每个 skill 的目录开销与正文、'
    + '每条工具结果，逐项给出 token 数与「占已用 %」「占窗口 %」两列百分比，并判定上下文是否膨胀、该砍哪一块。'
    + '用户问「上下文占了多少」「哪个文档最占地方」「是不是该压缩了」「为什么提示词被截断」时用它。',
  // ⚠️ parameters 必须是完整 JSON Schema（type: 'object' + properties），
  // 不能把属性平铺 —— 否则 DSH 透传给模型网关时 schema.type 为 null，
  // 严格校验的网关会报 400：`schema must be a JSON Schema of 'type: "object"', got 'type: null'`。
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: {
        type: 'number',
        description: '排行榜最多显示多少行，默认 20；传 0 表示全量。',
      },
      probes: {
        type: 'boolean',
        description: '是否附上「采集诊断」——每个数据来源实际走了哪条 API 路径，排查「数据不对」时用。',
      },
    },
    required: [],
  },
  output: {
    // ⚠️ `required` 必须放在**对象层**（数组），不能写在每个属性里 ——
    // 写成 `text: { type: 'string', required: true }` 会被 DSH 的 schema 校验直接拒收，
    // 报 `unsupported JSON schema: ... required is not supported on type "string"`，
    // 工具就永远注册不上（实测踩过）。
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'dataJson', 'level', 'score'],
      properties: {
        text: { type: 'string' },
        dataJson: { type: 'string' },
        level: { type: 'string' },
        score: { type: 'number' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    // 注意：工具的 exec 里没有插件 ctx，用 apply 时存下的那个（不要 spread exec，会丢 getter）
    const analysis = await analyzeNow(TOOL_CTX, exec)
    if (analysis === null) {
      return {
        text: '拿不到会话上下文 —— 可能当前没有可用的会话，或 tokenMeter/systemPrompt 服务都没挂上。',
        dataJson: '{}',
        level: 'unknown',
        score: 0,
      }
    }
    const limit = typeof args?.limit === 'number' && args.limit > 0 ? args.limit : 20
    const text = renderReport(analysis, {
      limit: limit === 0 ? Number.MAX_SAFE_INTEGER : limit,
      showProbes: args?.probes === true,
      probes: { ...analysis.probes, provider: analysis.provider, model: analysis.model },
    })
    return {
      text,
      dataJson: JSON.stringify({
        scoring: analysis.scoring,
        window: analysis.window,
        items: analysis.items.map((item) => ({
          kind: item.kind,
          label: item.label,
          tokens: item.tokens,
          pctOfUsed: Number(item.pctOfUsed.toFixed(4)),
          pctOfWindow: item.pctOfWindow === null ? null : Number(item.pctOfWindow.toFixed(4)),
        })),
        alerts: analysis.alerts,
        suggestions: analysis.suggestions,
      }),
      level: analysis.scoring.level,
      score: analysis.scoring.score,
    }
  },
}

/** 工具 execute 里取插件 ctx 的兜底（见 apply 里的赋值）。 */
let TOOL_CTX = undefined

// ---------------------------------------------------------------------------
// ② 斜杠命令
// ---------------------------------------------------------------------------

/**
 * 命令定义。
 *
 * ⚠️ **实测的 DSH 命令契约**（读 asar 里的 commands 服务确认，别再猜）：
 *   - 字段名是 **`handler`**，不是 `run`；
 *   - `handler` 收到**一个对象** `{ commandId, agent, rawInput, attachments, signal }`，不是位置参数；
 *   - `handler` **必须返回** `{ kind: 'success', text }` 或 `{ kind: 'error', text }`，返回字符串会被拒收；
 *   - `name` 必须匹配 `/^[a-z][a-z0-9_-]*$/u`，`description` 非空。
 * 三处任一不符，注册时直接抛错、命令静默消失（这坑实机踩过）。
 */
function commandsOf(ctx) {
  /** 命令里取会话：优先用命令上下文给的 agent，其次从 sessions 服务挑。 */
  const sessionFor = (invocation) => invocation?.agent?.session ?? currentSession(ctx)

  /** 统一把「文本或 {kind,text}」收成合法命令结果。 */
  const ok = (text) => ({ kind: 'success', text: String(text ?? '') })
  const fail = (text) => ({ kind: 'error', text: String(text ?? '') })

  const reportOf = async (invocation) => {
    const session = sessionFor(invocation)
    if (session === undefined || session === null) {
      return fail('`/ctx` 拿不到当前会话（命令上下文里没有 agent，sessions 服务也没给出会话）。\n'
        + '请改用工具 `context_radar` —— 它在会话内执行，一定拿得到。')
    }
    const analysis = await analyzeNow(ctx, { agent: { session } })
    if (analysis === null) return fail('分析失败：拿不到会话事件。详见 DSH 日志里的 `dsh-context-radar:` 行。')
    const full = String(invocation?.rawInput ?? '').includes('--all')
    return ok(renderReport(analysis, { limit: full ? Number.MAX_SAFE_INTEGER : 20 }))
  }

  const watchOf = async (invocation) => {
    const session = sessionFor(invocation)
    if (session === undefined || session === null) return fail('拿不到当前会话。请改用工具 `context_radar`。')
    const analysis = await analyzeNow(ctx, { agent: { session } })
    if (analysis === null) return fail('分析失败：拿不到会话事件。')
    return ok(renderOneLine(analysis))
  }

  return [
    {
      name: 'ctx',
      description: '看上下文构成排行榜与膨胀判定（等价于 context_radar 工具，但不消耗模型回合）',
      input: { hint: '可选：--all 列出全部条目（默认前 20 项）' },
      handler: (invocation) => reportOf(invocation),
    },
    {
      name: 'ctx-watch',
      description: '只看一行摘要：当前占用率、最大项、还能撑几轮',
      handler: (invocation) => watchOf(invocation),
    },
  ]
}

/**
 * 取「当前会话」。命令上下文里没有 `agent`，只能从 sessions 服务里挑最近活跃的那个。
 * 多路探测，全失败就返回 undefined（上层给友好提示）。
 */
function currentSession(ctx) {
  const sessions = serviceOf(ctx, 'sessions')
  for (const [label, getter] of [
    ['sessions.current', () => sessions?.current],
    ['sessions.active', () => sessions?.active],
    ['sessions.list()', () => {
      const list = sessions?.list?.()
      return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : undefined
    }],
    ['sessions.all()', () => {
      const all = sessions?.all?.()
      const list = Array.isArray(all) ? all : []
      return list.length > 0 ? list[list.length - 1] : undefined
    }],
  ]) {
    try {
      const value = getter()
      if (value !== undefined && value !== null) return value
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// ③ 系统提示词：只在超阈值时注入一行
// ---------------------------------------------------------------------------

/**
 * 提示词段落的 provider 是**同步**的，而分析是异步的，所以这里用「缓存 + 后台刷新」：
 * 本次先返回上一条结果（首次为空），同时把刷新挂到后台。日志没变就不重算。
 */
function promptLine(ctx) {
  return (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined || session === null) return ''
      const events = snapshotOf(session)
      const key = cacheKeyOf(session, events)
      const hit = cache.get(key)
      if (hit === undefined) {
        refresh(ctx, { agent: context.agent }, key).catch(() => {})
        // 本次没有该键的缓存 —— 用「最新的一份」顶上，让提醒不至于完全迟到
        let latest = null
        for (const entry of cache.values()) {
          if (latest === null || entry.at > latest.at) latest = entry
        }
        return latest === null ? '' : gate(latest)
      }
      if (Date.now() - hit.at > CACHE_TTL_MS * 15) refresh(ctx, { agent: context.agent }, key).catch(() => {})
      return gate(hit)
    } catch (error) {
      // 提示词段落绝不能因为算不动而中断组装
      warn(`组装提示词段落失败（本次不注入）—— ${msgOf(error)}`)
      return ''
    }
  }
}

/** 只在需要提醒时才返回文本；健康时返回空串（零开销）。 */
function gate(entry) {
  const { analysis } = entry
  const level = analysis?.scoring?.level
  if (level === undefined) return ''
  const critical = analysis.alerts.some((alert) => alert.level === 'critical')
  if (level === 'ok' && !critical) return ''
  if (level === 'warn' && !critical && analysis.scoring.score < 40) return ''
  const reason = critical ? analysis.alerts.find((a) => a.level === 'critical').text : ''
  const action = critical ? analysis.alerts.find((a) => a.level === 'critical').action : analysis.suggestions[0] ?? ''
  const head = `[上下文雷达] ${entry.line}`
  const lines = [head]
  if (reason !== '') lines.push(`硬告警：${reason}`)
  if (action !== '') lines.push(`建议：${action}`)
  lines.push('要看完整排行榜就调 `context_radar`；给人看用 `/ctx`。')
  return neutralizeBraces(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// ④ HTTP 路由：给 GUI 面板供数据
// ---------------------------------------------------------------------------

const ROUTE_PATH = '/api/dsh-context-radar/report'

function registerHttpRoute(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  const register = pickMethod(webServer, ['register'])
  if (register === undefined) {
    // GUI 面板是可选能力：没有 webserver（比如纯 CLI 宿主）就跳过。
    // 返回 false 交给上层重试 —— `webServer` 实测也晚于 `apply()` 挂载。
    return false
  }
  const handler = async (req, res) => {
    try {
      const session = currentSession(ctx)
      const analysis = await analyzeNow(ctx, { agent: { session } })
      const body = JSON.stringify(analysis === null
        ? { ok: false, error: '没有可用会话' }
        : {
            ok: true,
            generatedAt: new Date().toISOString(),
            scoring: analysis.scoring,
            window: analysis.window,
            groups: analysis.groups,
            items: analysis.items,
            alerts: analysis.alerts,
            suggestions: analysis.suggestions,
            dataQuality: analysis.dataQuality,
            provider: analysis.provider,
            model: analysis.model,
          })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: msgOf(error) }))
    }
  }
  register.fn({ kind: 'exact', path: ROUTE_PATH, handler })
  process.stderr.write(`dsh-context-radar: 已注册数据路由 ${ROUTE_PATH}（供 GUI 面板读取）。\n`)
  return true
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * 注册的重试退避（毫秒）。总共约 7 秒，足够等到服务挂载。
 *
 * 🔴 实测坑：`apply()` 执行时 **`tools` 和 `webServer` 还没挂载**（`commands` / `systemPrompt` 已就绪）。
 * 直接取会拿到空 → 注册静默不发生，插件看起来"装了但没反应"。
 * 对照：`dsh-test-framework` 恰好排在服务就绪之后，所以从没暴露这个问题。
 * 因此每段注册都返回布尔值，false 就异步重试 —— 不阻塞 DSH 启动，也不赌服务名。
 */
const RETRY_DELAYS_MS = [150, 300, 600, 1200, 2000, 3000]

/**
 * 带重试地跑一段注册。
 * `step()` 返回 `false` = 服务还没就绪，稍后重试；返回其它值 = 已完成（含明确失败），不再重试。
 */
function withRetry(label, step, attempt = 0) {
  let done = true
  try {
    done = step() !== false
  } catch (error) {
    // 任何一步炸了都不能影响 DSH 启动
    warn(`注册${label}时发生异常（已忽略）—— ${msgOf(error)}`)
  }
  if (done) return
  if (attempt >= RETRY_DELAYS_MS.length) {
    warn(`${label}：服务始终没就绪，放弃注册（其余功能不受影响）。`)
    return
  }
  const timer = setTimeout(() => withRetry(label, step, attempt + 1), RETRY_DELAYS_MS[attempt])
  // 别让重试计时器拖住进程退出
  if (typeof timer?.unref === 'function') timer.unref()
}

/** ① 工具。服务没就绪返回 false。 */
function registerToolStep(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const register = pickMethod(tools, TOOL_REGISTER_METHODS)
  if (register === undefined) return false
  // 不再包一层 execute：spread exec 会丢掉原型上的 getter，ctx 直接走模块级变量
  register.fn(TOOL)
  warn(`已注册工具 ${TOOL.name}。`)
  return true
}

/** ② 命令。服务没就绪返回 false。 */
function registerCommandsStep(ctx) {
  const commands = serviceOf(ctx, 'commands')
  const register = pickMethod(commands, ['register'])
  if (register === undefined) return false
  const defs = commandsOf(ctx)
  let ok = 0
  for (const def of defs) {
    try {
      register.fn(def)
      ok += 1
    } catch (error) {
      warn(`注册命令 /${def.name} 失败（已跳过）—— ${msgOf(error)}`)
    }
  }
  if (ok > 0) warn(`已注册命令 ${defs.slice(0, ok).map((d) => '/' + d.name).join(' ')}。`)
  return true
}

/** ③ 提示词段落。服务没就绪返回 false。 */
function registerSectionStep(ctx) {
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  const section = pickMethod(systemPrompt, ['section'])
  if (section === undefined) return false
  section.fn({
    name: PROMPT_SECTION,
    order: PROMPT_ORDER,
    text: promptLine(ctx),
  })
  warn('已注册提示词段落（超阈值时才注入提醒）。')
  return true
}

export function apply(ctx, config = {}) {
  TOOL_CTX = ctx

  // 四段各自独立重试：一段失败不影响另外三段。
  withRetry('工具', () => registerToolStep(ctx))
  withRetry('命令', () => registerCommandsStep(ctx))
  withRetry('提示词段落', () => registerSectionStep(ctx))
  withRetry('数据路由', () => registerHttpRoute(ctx))
}

export { analyze, renderOneLine, renderReport }
