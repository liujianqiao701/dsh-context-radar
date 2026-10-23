/**
 * 采集层：把 DSH 现场的事实取出来，交给 `engine.js` 算。
 *
 * **这一层是唯一碰 DSH API 的地方**，所以全部按「多路探测 + 优雅降级」写：
 * 每类事实都试若干候选路径，用第一个能用的，并把「走了哪条路 / 是否失败」记进 `probes`。
 * 任何一个服务不在都不抛异常 —— 报告会少一块，但不会把宿主搞挂。
 *
 * ⚠️ 本插件常以 `link:` 安装，真实路径在 profile 之外，**Node 解析不到 profile 的
 * `node_modules\@deepseek-ai\*`**，所以全篇零静态 import（与 dsh-test-framework 同一约束）。
 */

/** 取一个 cordis 服务；拿不到返回 undefined，不抛。 */
export function serviceOf(ctx, serviceName) {
  for (const getter of [
    () => ctx?.get?.(serviceName),
    () => ctx?.[serviceName],
    () => ctx?.root?.[serviceName],
  ]) {
    try {
      const value = getter()
      if (value !== undefined && value !== null) return value
    } catch {
      /* 换下一个位置找 */
    }
  }
  return undefined
}

/** 在目标对象上按候选名找第一个可调用方法。 */
export function pickMethod(target, names) {
  if (target === undefined || target === null) return undefined
  for (const name of names) {
    try {
      const fn = target[name]
      if (typeof fn === 'function') return { fn: fn.bind(target), via: name }
    } catch {
      /* 属性访问本身可能抛（getter），跳过 */
    }
  }
  return undefined
}

/** 依次尝试若干取值器，返回第一个不是 undefined/null 的结果，并记下走了哪个。 */
function firstOf(probes) {
  for (const [name, getter] of probes) {
    try {
      const value = getter()
      if (value !== undefined && value !== null) return { value, via: name }
    } catch {
      /* 该路径不可用，继续 */
    }
  }
  return { value: undefined, via: null }
}

/** 从 exec 里取会话对象。 */
export function sessionOf(exec) {
  return firstOf([
    ['exec.agent.session', () => exec?.agent?.session],
    ['exec.session', () => exec?.session],
    ['exec.agent.root.session', () => exec?.agent?.root?.session],
  ])
}

/** 从会话对象取事件数组。 */
export function eventsOf(session) {
  const hit = firstOf([
    ['session.snapshotEvents()', () => session?.snapshotEvents?.()],
    ['session.events', () => session?.events],
    ['session.log', () => session?.log],
  ])
  return Array.isArray(hit.value) ? hit : { value: [], via: hit.via }
}

/**
 * 取「模型真正看到的那份消息」。
 *
 * 🔴 这是**首选**数据源，比事件流更准：会话压缩/剪枝之后，原始事件日志里仍然留着
 * 已被剪掉的内容，遍历日志会算出物理上不可能的占用率（实测 2751%）。
 * `session.surface.deriveMessages()` 返回的是按画布裁剪 + 投影后的冻结消息数组。
 *
 * @param {object} session
 * @returns {{value: Array<object>, via: string|null}} 取不到时 `value` 为 `null`
 */
export function messagesOf(session) {
  const hit = firstOf([
    ['session.surface.deriveMessages()', () => session?.surface?.deriveMessages?.()],
    ['session.deriveMessages()', () => session?.deriveMessages?.()],
    ['session.surface.messages', () => session?.surface?.messages],
  ])
  if (Array.isArray(hit.value)) return { value: hit.value, via: hit.via }
  return { value: null, via: hit.via }
}

/** 从事件流里取最近一次 `request/header`，拿 provider / model / 工具 schema。 */
function lastRequestHeader(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'request/header' && event?.data?.header) return event.data.header
  }
  return undefined
}

/** 补 `{{name}}` 变量（`interpolate: false` 的段不补），只用于估算长度。 */
function interpolateLight(text, variables, enabled) {
  const source = String(text ?? '')
  if (enabled === false || variables === undefined || variables === null) return source
  return source.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name) => {
    const value = variables[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * 采集全部事实。
 *
 * @param {object} ctx cordis 上下文（插件 apply 时拿到的那个）
 * @param {object} exec 工具执行上下文（`execute(args, exec)` 的第二个参数）
 * @returns {Promise<object>} 事实包 + `probes` 诊断
 */
export async function collectFacts(ctx, exec) {
  const probes = {}

  // ---- 会话与事件 ----------------------------------------------------------
  const sessionHit = sessionOf(exec)
  const session = sessionHit.value
  probes.session = sessionHit.via ?? '未取到（工具的 exec 里没有 agent.session）'

  const eventsHit = eventsOf(session)
  const events = eventsHit.value
  probes.events = `${eventsHit.via ?? '未取到'}（${events.length} 条）`

  // 归因优先用 surface 消息（模型真正看到的那份）；事件流只用来取 request/header
  const messagesHit = messagesOf(session)
  const messages = messagesHit.value
  probes.messages = messages === null
    ? `${messagesHit.via ?? '未取到'} → 退回事件流归因（压缩过的会话会偏大）`
    : `${messagesHit.via}（${messages.length} 条，已按画布裁剪）`

  // ---- 工具 schema / provider / model -------------------------------------
  const header = lastRequestHeader(events)
  probes.requestHeader = header === undefined ? '事件流里没有 request/header' : 'request/header'

  const toolsSchema = Array.isArray(header?.tools) && header.tools.length > 0 ? header.tools : null
  probes.toolsSchema = toolsSchema === null ? '无（request/header 里没有 tools）' : `${toolsSchema.length} 个工具`

  const config = header?.config ?? {}
  let provider = config.provider
  let model = config.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    const fallback = firstOf([
      ['session.header.model', () => ({ provider: session?.header?.provider, model: session?.header?.model })],
      ['agent.model', () => ({ provider: exec?.agent?.context?.provider, model: exec?.agent?.context?.model })],
    ])
    if (fallback.value !== undefined) {
      provider = provider ?? fallback.value.provider
      model = model ?? fallback.value.model
    }
  }
  probes.model = typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : '未取到'

  // ---- 上下文窗口 ----------------------------------------------------------
  let modelContext = null
  const llm = serviceOf(ctx, 'llm')
  const resolveModelInfo = pickMethod(llm, ['resolveModelInfo', 'modelInfo', 'resolveModel'])
  if (resolveModelInfo !== undefined && typeof provider === 'string' && typeof model === 'string') {
    try {
      const info = await resolveModelInfo.fn(provider, model)
      // 🔴 实测形状（读 dsh-llm 的 normalizeModelInfo 确认）：
      //   返回是 `{ provider, id, name, context: { contextWindow } }` —— 窗口在**嵌套对象**里，
      //   不是 `info.context` 本身。早先按数字取，`typeof` 判定失败后静默跳过，窗口永远是 null。
      const context = info?.context?.contextWindow
        ?? (typeof info?.context === 'number' ? info.context : undefined)
        ?? info?.contextWindow
        ?? info?.limits?.context
      if (typeof context === 'number' && context > 0) {
        modelContext = context
        probes.modelContext = `llm.${resolveModelInfo.via}(${provider}, ${model}).context.contextWindow = ${context}`
      } else {
        probes.modelContext = `llm.${resolveModelInfo.via}() 返回里没有 context.contextWindow`
      }
    } catch (error) {
      probes.modelContextError = error instanceof Error ? error.message : String(error)
      probes.modelContext = `llm.${resolveModelInfo.via}() 抛错`
    }
  } else {
    probes.modelContext = resolveModelInfo === undefined ? 'llm 服务不可用' : '不知道 provider/model，无法问窗口大小'
  }

  // ---- 提供方报告的真实压力 ------------------------------------------------
  let pressureTokens = null
  {
    const hit = firstOf([
      ['session.projection(contextPressure).projectedTokens', () => session?.projection?.('contextPressure')?.projectedTokens],
      ['session.projection(contextPressure).pressureTokens', () => session?.projection?.('contextPressure')?.pressureTokens],
      ['session.projections.contextPressure.projectedTokens', () => session?.projections?.contextPressure?.projectedTokens],
      ['session.state.contextPressure.projectedTokens', () => session?.state?.contextPressure?.projectedTokens],
      ['session.surface.projections.contextPressure.projectedTokens', () => session?.surface?.projections?.contextPressure?.projectedTokens],
    ])
    if (typeof hit.value === 'number' && hit.value > 0) {
      pressureTokens = hit.value
      probes.pressure = hit.via
    } else {
      probes.pressure = '未取到（拿不到 contextPressure 投影，占用率改由本地归因推算）'
    }
  }
  // 窗口也能从投影里兜底拿
  if (modelContext === null) {
    const hit = firstOf([
      ['session.projection(contextPressure).contextWindow', () => session?.projection?.('contextPressure')?.contextWindow],
      ['session.projections.contextPressure.contextWindow', () => session?.projections?.contextPressure?.contextWindow],
      ['session.state.contextPressure.contextWindow', () => session?.state?.contextPressure?.contextWindow],
    ])
    if (typeof hit.value === 'number' && hit.value > 0) {
      modelContext = hit.value
      probes.modelContext = hit.via
    }
  }

  // ---- 系统提示词分段 ------------------------------------------------------
  let sections = null
  let systemText = null
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  const assemble = pickMethod(systemPrompt, ['assemble'])
  if (assemble !== undefined) {
    // scope 传 agent：分段类是按 scope 链合并的，不传就只看到全局段
    for (const scope of [exec?.agent, undefined]) {
      try {
        const assembly = await assemble.fn(scope === undefined ? {} : { scope })
        if (assembly !== undefined && Array.isArray(assembly.sections)) {
          sections = assembly.sections
            .filter((section) => typeof section?.text === 'string')
            .map((section) => ({
              name: String(section.name ?? '(未命名段)'),
              text: interpolateLight(section.text, assembly.variables, section.interpolate),
            }))
          systemText = sections.map((s) => s.text).join('\n\n')
          probes.systemPrompt = `systemPrompt.assemble(${scope === undefined ? '{}' : '{scope: agent}'}) → ${sections.length} 段`
          break
        }
      } catch (error) {
        probes.systemPromptError = error instanceof Error ? error.message : String(error)
      }
    }
    if (sections === null) probes.systemPrompt = 'assemble() 没给出 sections'
  } else {
    probes.systemPrompt = 'systemPrompt 服务不可用'
  }
  if (sections === null) {
    // 兜底：会话里最后一条 system/message 就是发给模型的系统提示词
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'system/message') continue
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
      if (text !== '') {
        systemText = text
        probes.systemPrompt = 'system/message 兜底（拿不到分段明细）'
        break
      }
    }
  }

  // ---- 工作区指令字节预算 --------------------------------------------------
  let instructionBudget = null
  {
    // 从已有注入消息里反推预算，比读配置更可靠（配置可能没显式给）。
    // ⚠️ 事件形状不统一：user/message 的 `data` **本身就是消息**，其它是 `data.message`。
    const scan = (list) => {
      for (const item of list) {
        const message = item?.data?.message ?? item?.data ?? item
        if (message?.source?.kind !== 'agent-instructions') continue
        const text = (message.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
        const match = /Workspace instruction budget (\d+) bytes/.exec(text)
        if (match !== null) return Number(match[1])
      }
      return null
    }
    instructionBudget = scan(Array.isArray(messages) ? messages : events)
    if (instructionBudget === null && Array.isArray(messages)) instructionBudget = scan(events)
    if (instructionBudget !== null) probes.instructionBudget = '从截断标记反推'
  }

  // ---- 提供方汇报的真实上下文总量（最可靠的锚） ------------------------------
  // `assistant/message` 的 `data.usage` 是真金白银的账单数据：
  //   totalTokens = inputTokens + cacheReadTokens + outputTokens
  // 它比任何本地估算都准，也比 contextPressure 投影更直接。
  let providerTokens = null
  {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const usage = events[i]?.data?.usage
      const total = usage?.totalTokens ?? usage?.total
      if (typeof total === 'number' && total > 0) {
        providerTokens = total
        break
      }
    }
    probes.providerUsage = providerTokens === null
      ? '没有 usage.totalTokens'
      : `usage.totalTokens = ${providerTokens}`
  }

  return {
    session,
    events,
    messages,
    sections,
    systemText,
    toolsSchema,
    provider: typeof provider === 'string' ? provider : null,
    model: typeof model === 'string' ? model : null,
    modelContext,
    pressureTokens,
    providerTokens,
    instructionBudget,
    probes,
  }
}
