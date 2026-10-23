/**
 * 归因与膨胀判定引擎（**纯函数，不依赖 DSH**）。
 *
 * 设计原则：**只做归因和打分，不碰 IO**。所有输入由 `collect.js` 从 DSH 现场采集，
 * 这样这一层可以脱离 DSH 完整单测，也可以在别的宿主里复用。
 *
 * 归因分三块，覆盖上下文里「谁在吃 token」的全部来源：
 *
 * ① **系统提示词**：`ctx.systemPrompt.assemble()` 已经给了逐段的名字与正文，
 *    按各段字符数**等比例分摊**总价（总价由整段系统提示词算一次，避免逐段各加一次角色开销而虚高）。
 * ② **注入类消息**：DSH 给每条注入消息都打了 `source`，`source.kind` 就是来源类型 ——
 *    `agent-instructions`（AGENTS.md）/ `skill-catalog`（skill 目录）/ `skill-invocation`（skill 正文）/
 *    `session-reference`（跨会话召回）。**这是按文档归因的关键，不用猜。**
 * ③ **工具结果**：`tool/result` 通过 `message.source.callId` 回连 `assistant/message` 里的 `tool-call` 块，
 *    拿到工具名与参数，于是能归到「read 读了哪个文件」这一级。
 */

import {
  cjkMessage,
  cjkText,
  cjkTools,
  dshMessage,
  dshTools,
} from './estimate.js'

/** 单项展示名上限，防止一个超长路径把表格撑爆。 */
const MAX_LABEL = 72

/** 从工具参数里挑一个最能代表「这次调用的目标」的字段。 */
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'pattern', 'glob', 'query', 'url', 'command', 'name', 'text', 'description']

/** 读文件类工具名（用于统计重复读取）。 */
const READ_TOOLS = new Set(['read', 'read_image'])

/** 截断展示名。 */
function clip(value, max = MAX_LABEL) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 取工具调用的目标标识。 */
function targetOf(args) {
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (parsed === null || typeof parsed !== 'object') return ''
  for (const key of TARGET_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 规范化路径，用于识别「同一个文件被读了多次」。 */
function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
}

/** 把一条消息的纯文本拼出来（只用于识别格式，不用于计价）。 */
function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 取消息本体。
 *
 * 真实事件有**两种形状**（实测，别凭想象）：
 * - `user/message` 的 `data` **本身就是消息**（`data.source` / `data.content` / `data.role`）；
 * - `assistant/message` / `tool/result` / `system/message` / `developer/message` 是 `data.message`。
 *
 * 早先只认 `data.message`，于是所有 `user/message` 都被当成空消息 ——
 * 按文档归因（AGENTS.md / skill）全部落空，而报告里看不出来。
 */
function messageOf(data) {
  const inner = data?.message
  if (inner !== undefined && inner !== null) return inner
  return data ?? {}
}

/** 依据 source.kind 把一条 surface 消息映射成事件类型。 */
function typeOfMessage(message) {
  const kind = typeof message?.source?.kind === 'string' ? message.source.kind : ''
  if (kind === 'tool') return 'tool/result'
  if (kind === 'system-prompt') return 'system/message'
  if (kind === 'tool-registry') return 'developer/message'
  if (message?.role === 'assistant') return 'assistant/message'
  if (message?.role === 'system') return 'system/message'
  return 'user/message'
}

/**
 * 按 DSH 的画布语义重建「模型看到的那份」节点序列。
 *
 * DSH 是事件溯源的：压缩**不会删日志**，而是在新事件上打 `surfaceOp`
 * —— `append` 表示追加，`{op:'replace', startSeq, endSeq}` 表示「用我替换这段」。
 * 另有 `compaction/prune` 用 `shadowedSeqs` 说明哪些 seq 被剪掉。
 *
 * 不按这套语义折叠就会把被压缩掉的历史也算进去 —— 真数据实测算出过 2751%。
 *
 * @param {Array<object>} events 原始事件流（按 seq 升序）
 * @returns {Array<object>} 折叠后的画布节点
 */
function foldSurface(events) {
  const shadowed = new Set()
  for (const event of events) {
    if (event?.type !== 'compaction/prune') continue
    for (const seq of event?.data?.shadowedSeqs ?? []) shadowed.add(seq)
  }

  const nodes = []
  for (const event of events) {
    const op = event?.surfaceOp
    // 没有 surfaceOp 的事件不进画布（tool/call、request/header、turn/* 等）
    if (op === undefined || op === null) continue
    if (typeof op === 'object' && op.op === 'replace') {
      const start = Number(op.startSeq)
      const end = Number(op.endSeq)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const seq = nodes[i]?.seq
          if (typeof seq === 'number' && seq >= start && seq <= end) nodes.splice(i, 1)
        }
      }
    }
    if (shadowed.has(event.seq)) continue
    nodes.push(event)
  }
  return nodes
}

/**
 * 把输入归一化成「事件流」。
 *
 * 🔴 **一定要优先用 `messages`（`session.surface.deriveMessages()`）而不是 `events`。**
 * 原因（真数据实测）：会话压缩/剪枝过之后，原始事件日志里**仍然留着已被剪掉的内容**，
 * 直接遍历日志会算出一个物理上不可能的占用率（实测 2751%）。
 * 只有拿不到 surface 时，才退回去按画布语义就地折叠。
 */
function normalizeInput(input, dataQuality) {
  if (Array.isArray(input.messages)) {
    return input.messages.map((message, index) => ({
      type: typeOfMessage(message),
      seq: index,
      data: { message },
    }))
  }
  const events = Array.isArray(input.events) ? input.events : []
  if (events.length === 0) return []
  const folded = foldSurface(events)
  dataQuality.push('没拿到 surface 消息，已按事件流的画布操作（append / replace / 剪枝）就地重建；若与 DSH 面板仍有差，以面板为准。')
  return folded.length > 0 ? folded : events
}

/** 工作区指令的几个分节前缀（AGENTS.md 等 md 是按文件分节的）。 */
const FILE_SECTION_RE = /^(?:Instructions from|Additional instructions from|Updated instructions from):\s*(.+?)\s*$/gm

/**
 * 「能动」的类别 —— 这些是**配置项**，可以真的删掉 / 关掉 / 少读。
 * 反例：`assistant`（助手输出）和 `user`（用户消息）属于对话历史，删不掉，
 * 只能靠压缩历史或换新会话 —— 给「去砍它」的建议是做不到的建议。
 */
const ACTIONABLE_KINDS = new Set([
  'prompt',        // 系统提示词各段
  'tools-schema',  // 工具定义（关掉不用的 MCP / 工具）
  'agents-md',     // 工作区指令文件（AGENTS.md 等）
  'skill-catalog', // skill 目录（不上就看不见）
  'skill-body',    // skill 正文
  'tool',          // 工具结果（少读 / 带过滤）
  'inject-other',  // 其它注入（运行上下文等）
  'developer',     // developer 消息
])

/** 字节预算/截断标记。 */
const BUDGET_MARKER_RE = /Workspace instruction budget (\d+) bytes:\s*([^\n]*)/

/** 从截断标记里解析出 omitted / truncated 明细。 */
function parseBudgetMarker(text) {
  const match = BUDGET_MARKER_RE.exec(String(text ?? ''))
  if (match === null) return null
  const budgetBytes = Number(match[1])
  const detail = match[2] ?? ''
  const omitted = [...detail.matchAll(/omitted ([^;]+)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter(Boolean)
  const truncated = [...detail.matchAll(/truncated ([^;]+?) from (\d+) to (\d+) bytes/g)].map((m) => ({
    path: m[1].trim(),
    originalBytes: Number(m[2]),
    includedBytes: Number(m[3]),
  }))
  return { budgetBytes, omitted, truncated }
}

/**
 * 把工作区指令正文按「每个 md 文件一节」切开。
 *
 * 为什么要切：用户问的是「**哪个 md 文档占得最多**」，而 AGENTS.md 那类注入是把
 * 若干文件的正文拼成**一条消息**发进来的，不切开就只能看到「工作区指令 12%」这种没用的话。
 *
 * @param {string} text 注入消息正文
 * @returns {Array<{path: string|null, text: string}>} 分节结果；无法切分时返回单节（path 为 null）
 */
export function splitInstructionSections(text) {
  const source = String(text ?? '')
  const matches = [...source.matchAll(FILE_SECTION_RE)]
  if (matches.length === 0) return [{ path: null, text: source }]
  const out = []
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length
    out.push({ path: matches[i][1].trim(), text: source.slice(start, end) })
  }
  return out
}

/**
 * 主入口：把采集到的现场事实算成「谁占多少 + 是否膨胀 + 怎么处置」。
 *
 * @param {object} input 输入事实
 * @param {Array<{name: string, text: string}>} [input.sections] 系统提示词逐段（来自 `systemPrompt.assemble()`）
 * @param {string|null} [input.systemText] 渲染后的系统提示词全文（`sections` 缺失时的兜底）
 * @param {Array<object>} [input.events] 会话事件（来自 `session.snapshotEvents()`）
 * @param {Array<object>|null} [input.toolsSchema] 工具 schema
 * @param {number|null} [input.modelContext] 模型上下文窗口（来自 `llm.resolveModelInfo().context`）
 * @param {number|null} [input.pressureTokens] 提供方报告的真实压力（来自 `contextPressure.projectedTokens`）
 * @param {number|null} [input.instructionBudget] 工作区指令字节预算
 * @returns {object} 分析结果
 */
export function analyze(input = {}) {
  const sections = Array.isArray(input.sections) ? input.sections : []
  const dataQuality = []
  const events = normalizeInput(input, dataQuality)

  /** 归因桶：key → 累加器 */
  const buckets = new Map()
  const bump = (kind, label, tokens, extra = {}) => {
    const key = `${kind}::${label}`
    const hit = buckets.get(key)
    if (hit === undefined) {
      buckets.set(key, { kind, label, tokens, count: 1, dshTokens: extra.dshTokens ?? 0, meta: { ...extra } })
    } else {
      hit.tokens += tokens
      hit.dshTokens += extra.dshTokens ?? 0
      hit.count += 1
    }
    return buckets.get(key)
  }

  // -------------------------------------------------------------------------
  // ① 系统提示词：用 system/message 的**实际**总量，各段只负责分摊
  // -------------------------------------------------------------------------
  // 为什么按实际消息而不是按 assemble() 各段相加：各项相加必须等于真实上下文，
  // 否则排行榜会自相矛盾（各段和 ≠ 总占用）。分段只用来回答「哪一段更大」。
  let systemMessageTokens = 0
  let systemMessageDshTokens = 0
  for (const event of events) {
    if (event?.type !== 'system/message') continue
    const message = messageOf(event.data)
    systemMessageTokens += cjkMessage(message)
    systemMessageDshTokens += dshMessage(message)
  }

  let promptTotal = 0
  let promptDshTotal = 0
  const sectionWeights = []
  for (const section of sections) {
    const text = String(section?.text ?? '')
    if (text.length === 0) continue
    sectionWeights.push({ name: String(section?.name ?? '(未命名段)'), chars: text.length, raw: text })
  }
  const sectionChars = sectionWeights.reduce((sum, s) => sum + s.chars, 0)

  if (systemMessageTokens > 0) {
    // 实际消息在：用它做总量，按各段字符占比分摊
    promptTotal = systemMessageTokens
    promptDshTotal = systemMessageDshTokens
    if (sectionWeights.length > 0 && sectionChars > 0) {
      for (const section of sectionWeights) {
        const share = section.chars / sectionChars
        bump('prompt', section.name, Math.round(promptTotal * share), {
          dshTokens: Math.round(promptDshTotal * share),
          chars: section.chars,
        })
      }
    } else {
      bump('prompt', '系统提示词（未分段）', promptTotal, { dshTokens: promptDshTotal, chars: 0 })
      dataQuality.push('拿不到 systemPrompt.assemble() 的分段结果，系统提示词只能整块计价 —— 看不到逐段明细。')
    }
  } else if (sectionWeights.length > 0 && sectionChars > 0) {
    // 没有 system 消息（例如只给了 assemble 结果）：按各段自己算
    const joined = sectionWeights.map((s) => s.raw).join('\n\n')
    promptTotal = cjkText(joined) + 4
    promptDshTotal = Math.ceil(joined.length / 4) + 4
    for (const section of sectionWeights) {
      const share = section.chars / sectionChars
      bump('prompt', section.name, Math.round(promptTotal * share), {
        dshTokens: Math.round(promptDshTotal * share),
        chars: section.chars,
      })
    }
  } else if (typeof input.systemText === 'string' && input.systemText.length > 0) {
    promptTotal = cjkText(input.systemText) + 4
    promptDshTotal = Math.ceil(input.systemText.length / 4) + 4
    bump('prompt', '系统提示词（未分段）', promptTotal, { dshTokens: promptDshTotal, chars: input.systemText.length })
    dataQuality.push('拿不到 systemPrompt.assemble() 的分段结果，系统提示词只能整块计价 —— 看不到逐段明细。')
  } else {
    dataQuality.push('拿不到系统提示词 —— 可能当前没有挂 systemPrompt 服务。')
  }

  // -------------------------------------------------------------------------
  // ② 工具 schema
  // -------------------------------------------------------------------------
  if (Array.isArray(input.toolsSchema) && input.toolsSchema.length > 0) {
    bump('tools-schema', `工具定义（${input.toolsSchema.length} 个）`, cjkTools(input.toolsSchema), {
      dshTokens: dshTools(input.toolsSchema),
      count: input.toolsSchema.length,
    })
  }

  // -------------------------------------------------------------------------
  // ③ 事件流：注入消息 / 工具结果 / 对话本体
  // -------------------------------------------------------------------------
  /** callId → { name, target } */
  const callIndex = new Map()
  /** 归一化路径 → 读取次数 */
  const readCounts = new Map()
  /** 每个 turn 的新增 token（用于增速） */
  const turnTokens = new Map()
  /** 被后续同 path 读取取代的旧读取 token 数（死重） */
  let supersededTokens = 0
  /** 工作区指令的预算/截断信息 */
  let instructionBudgetInfo = null
  let instructionTotalTokens = 0

  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? {}

    if (type === 'assistant/message') {
      const message = messageOf(data)
      const tokens = cjkMessage(message)
      const dshTokens = dshMessage(message)
      bump('assistant', '助手输出', tokens, { dshTokens })
      for (const block of message?.content ?? []) {
        if (block?.type === 'tool-call' && typeof block.id === 'string') {
          callIndex.set(block.id, { name: String(block.name ?? '?'), target: targetOf(block.arguments) })
        }
      }
      if (typeof data.turn === 'number') {
        turnTokens.set(data.turn, (turnTokens.get(data.turn) ?? 0) + tokens)
      }
      continue
    }

    if (type === 'tool/result') {
      const message = messageOf(data)
      const callId = message?.source?.callId
      const call = callId === undefined ? undefined : callIndex.get(callId)
      const toolName = call?.name ?? String(message?.source?.toolName ?? '未知工具')
      const target = call?.target ?? ''
      const tokens = cjkMessage(message)
      const dshTokens = dshMessage(message)
      const label = target === '' ? toolName : `${toolName} → ${clip(target, MAX_LABEL - toolName.length - 4)}`
      bump('tool', label, tokens, { dshTokens, tool: toolName, target })

      if (READ_TOOLS.has(toolName) && target !== '') {
        const key = normalizePath(target)
        const times = (readCounts.get(key) ?? 0) + 1
        readCounts.set(key, times)
        // 重复读取同一文件：第 2 次及以后算死重（内容通常已经在上文里了）
        if (times > 1) supersededTokens += tokens
      }
      if (typeof data.turn === 'number') {
        turnTokens.set(data.turn, (turnTokens.get(data.turn) ?? 0) + tokens)
      }
      continue
    }

    if (type === 'system/message') {
      // 系统提示词已在 ① 的预扫描里计价，这里跳过，避免重复计数
      continue
    }

    if (type === 'user/message') {
      const message = messageOf(data)
      const source = message?.source
      const tokens = cjkMessage(message)
      const dshTokens = dshMessage(message)
      const kind = typeof source?.kind === 'string' ? source.kind : null

      if (kind === 'agent-instructions') {
        instructionTotalTokens += tokens
        const body = messageText(message)
        const budget = parseBudgetMarker(body)
        if (budget !== null) instructionBudgetInfo = budget
        const parts = splitInstructionSections(body)
        const totalChars = parts.reduce((sum, p) => sum + p.text.length, 0)
        for (const part of parts) {
          const share = totalChars === 0 ? 0 : part.text.length / totalChars
          bump('agents-md', part.path ?? '（工作区指令）', Math.round(tokens * share), {
            dshTokens: Math.round(dshTokens * share),
            chars: part.text.length,
          })
        }
        continue
      }

      if (kind === 'skill-catalog') {
        // 目录消息的 source 带逐条 entries（name + 已截断的 description），据此按 skill 归因
        const entries = Array.isArray(source?.entries) ? source.entries : []
        if (entries.length > 0) {
          const lines = entries.map((entry) => `- \`${entry?.name ?? '?'}\`: ${entry?.description ?? ''}`)
          const body = lines.join('\n')
          const entryTotal = cjkText(body)
          const frame = Math.max(0, tokens - entryTotal)
          const bodyChars = body.length
          for (let i = 0; i < entries.length; i += 1) {
            const share = bodyChars === 0 ? 1 / entries.length : lines[i].length / bodyChars
            bump('skill-catalog', String(entries[i]?.name ?? '?'), Math.round(entryTotal * share), {
              dshTokens: Math.round(Math.ceil(body.length / 4) * share),
              chars: lines[i].length,
            })
          }
          if (frame > 0) bump('skill-catalog', '（目录框架）', frame, { dshTokens: 16 })
        } else {
          bump('skill-catalog', '（skill 目录）', tokens, { dshTokens })
        }
        continue
      }

      if (kind === 'skill-invocation') {
        const skillName = typeof source?.name === 'string' ? source.name : '（未知 skill）'
        bump('skill-body', skillName, tokens, { dshTokens })
        continue
      }

      if (kind === 'runtime-context') {
        // 运行时上下文（沙箱策略、环境事实等）自带逐段 sections —— 按段归因，别糊成一块
        const ctxSections = Array.isArray(source?.sections) ? source.sections : []
        const parts = ctxSections.filter((part) => typeof part?.text === 'string' && part.text.length > 0)
        if (parts.length > 0) {
          const totalPartChars = parts.reduce((sum, part) => sum + part.text.length, 0)
          for (const part of parts) {
            const share = totalPartChars === 0 ? 0 : part.text.length / totalPartChars
            bump('inject-other', `运行上下文 · ${String(part?.name ?? '(未命名段)')}`, Math.round(tokens * share), {
              dshTokens: Math.round(dshTokens * share),
              chars: part.text.length,
            })
          }
        } else {
          bump('inject-other', `运行上下文（${String(source?.form ?? 'snapshot')}）`, tokens, { dshTokens })
        }
        continue
      }

      if (kind === 'session-reference') {
        const labels = Array.isArray(source?.references) ? source.references.map((r) => r?.label).filter(Boolean) : []
        bump('session-ref', labels.length > 0 ? labels.join(', ') : '（跨会话召回）', tokens, { dshTokens })
        continue
      }

      if (kind !== null) {
        bump('inject-other', kind, tokens, { dshTokens })
        continue
      }

      bump('user', '用户输入', tokens, { dshTokens })
      if (typeof data.turn === 'number') {
        turnTokens.set(data.turn, (turnTokens.get(data.turn) ?? 0) + tokens)
      }
      continue
    }

    if (type === 'developer/message') {
      bump('developer', 'developer 消息', cjkMessage(data.message ?? {}), { dshTokens: dshMessage(data.message ?? {}) })
      continue
    }

    if (type === 'compaction/summary') {
      bump('compaction', '历史压缩摘要', cjkMessage(data.message ?? {}), { dshTokens: dshMessage(data.message ?? {}) })
      continue
    }
  }

  // -------------------------------------------------------------------------
  // ④ 汇总与百分比
  // -------------------------------------------------------------------------
  const items = [...buckets.values()]
    .filter((item) => item.tokens > 0)
    .map((item) => ({ ...item }))
  items.sort((a, b) => b.tokens - a.tokens)

  const usedLocal = items.reduce((sum, item) => sum + item.tokens, 0)
  const dshUsed = items.reduce((sum, item) => sum + item.dshTokens, 0)
  // 窗口：模型真实上限；绝对用量：优先提供方账单
  const window = typeof input.modelContext === 'number' && input.modelContext > 0 ? input.modelContext : null
  const usageTokens = typeof input.providerTokens === 'number' && input.providerTokens > 0 ? input.providerTokens : null
  const projection = typeof input.pressureTokens === 'number' && input.pressureTokens > 0 ? input.pressureTokens : null
  // 优先级：账单 usage.totalTokens > contextPressure 投影 > 本地归因
  const pressure = usageTokens !== null ? usageTokens : projection
  const pressureLabel = usageTokens !== null ? 'usage.totalTokens' : 'contextPressure.projectedTokens'
  const usedForRatio = pressure !== null ? pressure : usedLocal

  // 「未归因」补账：提供方账单总是略大于本地能逐条归因的部分（适配器开销、压缩摘要等）。
  // 不补这一行的话，表头写的是账单总数、而「占已用」的分母是本地总数 ——
  // 用户拿某一行去除以表头的数，算出来跟表里的百分比对不上（实测被这个坑过）。
  // 补上之后：所有项加起来 = 账单总数，两个百分比列口径一致、自洽。
  if (pressure !== null && pressure > usedLocal) {
    items.push({
      kind: 'unattributed',
      label: '未归因（适配器开销 / 压缩摘要）',
      tokens: pressure - usedLocal,
      dshTokens: 0,
    })
    items.sort((a, b) => b.tokens - a.tokens)
  }
  const used = items.reduce((sum, item) => sum + item.tokens, 0)

  if (pressure !== null && pressure > usedLocal * 1.2) {
    dataQuality.push(`提供方报告的真实用量（${pressure} token，来自 ${pressureLabel}）大于本地归因总量（${usedLocal} token）—— 差额已单列为「未归因」，占用率与各项占比都以提供方为准。`)
  }
  if (pressure !== null && usedLocal > pressure * 1.5) {
    dataQuality.push(`本地归因总量（${usedLocal} token）明显大于提供方真实用量（${pressure} token）—— 归因口径偏大（常见于把压缩前的历史重复计入）；各项占比仅供参考，绝对占用以提供方 ${pressureLabel} 为准。`)
  }
  if (window === null) dataQuality.push('拿不到模型上下文窗口（`llm.resolveModelInfo().context.contextWindow`），占用率无法判定 —— 只给构成，不给膨胀结论。')

  for (const item of items) {
    item.pctOfUsed = used === 0 ? 0 : item.tokens / used
    item.pctOfWindow = window === null ? null : item.tokens / window
  }

  // 分组
  const groupMap = new Map()
  for (const item of items) {
    const hit = groupMap.get(item.kind) ?? { kind: item.kind, tokens: 0, count: 0 }
    hit.tokens += item.tokens
    hit.count += 1
    groupMap.set(item.kind, hit)
  }
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, pctOfUsed: used === 0 ? 0 : g.tokens / used, pctOfWindow: window === null ? null : g.tokens / window }))
    .sort((a, b) => b.tokens - a.tokens)

  // -------------------------------------------------------------------------
  // ⑤ 膨胀打分
  // -------------------------------------------------------------------------
  const occupancy = window === null ? null : usedForRatio / window
  const remaining = window === null ? null : Math.max(0, window - usedForRatio)

  // 增速：最近 3 个 turn 的平均新增
  const turnKeys = [...turnTokens.keys()].sort((a, b) => a - b)
  const recentTurns = turnKeys.slice(-3)
  const avgPerTurn = recentTurns.length === 0 ? 0 : recentTurns.reduce((sum, k) => sum + turnTokens.get(k), 0) / recentTurns.length
  const turnsLeft = window === null || avgPerTurn <= 0 ? null : Math.floor(remaining / avgPerTurn)

  const largest = items.length > 0 ? items[0] : null
  const dominance = largest === null || used === 0 ? 0 : largest.tokens / used
  const deadweight = used === 0 ? 0 : supersededTokens / used

  const factors = []
  let score = 0
  const addFactor = (key, label, weight, value, note) => {
    const normalized = Math.max(0, Math.min(1, value))
    score += weight * normalized
    factors.push({ key, label, weight, value, normalized, note })
  }

  if (occupancy !== null) {
    addFactor('occupancy', '上下文占用率', 0.45, occupancy, `已用 ${Math.round(usedForRatio)} / ${window} token`)
  } else {
    addFactor('occupancy', '上下文占用率', 0.45, 0, '窗口大小未知，按 0 计（此项不计入风险）')
  }
  // 增速：按当前速度 <8 轮撞墙 → 接近 1
  if (window !== null && avgPerTurn > 0) {
    const expectedTurns = remaining / avgPerTurn
    addFactor('growth', '增长速率', 0.2, expectedTurns >= 8 ? 8 / Math.max(expectedTurns, 8) * 0.3 : 1 - expectedTurns / 8, `最近平均每轮 +${Math.round(avgPerTurn)} token，按此速度约 ${expectedTurns.toFixed(1)} 轮后占满`)
  } else {
    addFactor('growth', '增长速率', 0.2, 0, '轮次用量不足，暂不评估')
  }
  addFactor('dominance', '单点垄断度', 0.2, dominance <= 0.15 ? dominance / 0.15 * 0.2 : Math.min(1, (dominance - 0.15) / 0.35 + 0.2), largest === null ? '无数据' : `最大单项「${clip(largest.label, 40)}」占已用 ${(dominance * 100).toFixed(1)}%`)
  addFactor('deadweight', '冗余 / 死重', 0.15, deadweight <= 0.03 ? 0 : Math.min(1, deadweight / 0.25), deadweight === 0 ? '没有重复读取' : `重复读取同一文件累计 ${Math.round(supersededTokens)} token`)

  const score100 = Math.round(score * 100)
  const level = score100 >= 80 ? 'critical' : score100 >= 60 ? 'high' : score100 >= 35 ? 'warn' : 'ok'
  const LEVEL_LABEL = {
    ok: '🟢 健康',
    warn: '🟡 注意',
    high: '🟠 偏高',
    critical: '🔴 高危',
  }

  // -------------------------------------------------------------------------
  // ⑥ 硬告警（不看分数，命中即报 —— 这些是确定的事实，不是估计）
  // -------------------------------------------------------------------------
  const alerts = []
  if (instructionBudgetInfo !== null) {
    const { budgetBytes, omitted, truncated } = instructionBudgetInfo
    if (truncated.length > 0) {
      for (const t of truncated) {
        alerts.push({
          level: 'critical',
          code: 'INSTRUCTIONS_TRUNCATED',
          text: `工作区指令「${t.path}」被截断：${t.originalBytes} 字节只进了 ${t.includedBytes} 字节，**丢了 ${((1 - t.includedBytes / t.originalBytes) * 100).toFixed(1)}%**。`,
          action: '把该文件里「历史沿革 / 一次性清单 / 逐条明细」剪到归档目录，正文只留一行指针。被截断的内容模型**根本看不到**，等于白写。',
        })
      }
    }
    if (omitted.length > 0) {
      alerts.push({
        level: 'critical',
        code: 'INSTRUCTIONS_OMITTED',
        text: `工作区指令有 ${omitted.length} 个文件被整体丢弃（预算 ${budgetBytes} 字节）：${omitted.join(', ')}。`,
        action: '这些文件的约束当前**完全没生效**。要么合并进主文件，要么删掉冗余内容腾预算。',
      })
    }
  }
  if (typeof input.instructionBudget === 'number' && instructionTotalTokens > 0) {
    const ratio = instructionTotalTokens / input.instructionBudget
    if (ratio >= 0.9 && instructionBudgetInfo === null) {
      alerts.push({
        level: 'warn',
        code: 'INSTRUCTIONS_NEAR_BUDGET',
        text: `工作区指令已占用预算的 ${(ratio * 100).toFixed(0)}%（${instructionTotalTokens}/${input.instructionBudget}），再涨就会静默截断。`,
        action: '提前剪枝，不要等它被砍。',
      })
    }
  }
  const bigTools = items.filter((item) => item.kind === 'tool' && item.pctOfUsed >= 0.15)
  for (const item of bigTools.slice(0, 3)) {
    alerts.push({
      level: 'warn',
      code: 'TOOL_RESULT_HEAVY',
      text: `单个工具结果「${clip(item.label, 50)}」占已用 ${(item.pctOfUsed * 100).toFixed(1)}%（${item.tokens} token）。`,
      action: '这类结果通常可以只取需要的那一段（用 grep/offset 限定范围），而不是整份读进来。',
    })
  }
  for (const item of items.filter((i) => i.kind === 'skill-body')) {
    if (item.pctOfUsed >= 0.08) {
      alerts.push({
        level: 'warn',
        code: 'SKILL_BODY_HEAVY',
        text: `skill「${item.label}」正文占已用 ${(item.pctOfUsed * 100).toFixed(1)}%（${item.tokens} token）。`,
        action: 'skill 正文是**一次性全量加载**的。若只用到其中一小节，考虑把该 skill 拆成多个更小的 skill。',
      })
    }
  }

  // -------------------------------------------------------------------------
  // ⑦ 建议（按因子与告警生成，只给能立刻做的动作）
  // -------------------------------------------------------------------------
  const suggestions = []
  const f = Object.fromEntries(factors.map((x) => [x.key, x]))
  if (alerts.some((a) => a.code === 'INSTRUCTIONS_TRUNCATED' || a.code === 'INSTRUCTIONS_OMITTED')) {
    suggestions.push('**先修截断**：工作区指令被砍说明它已经超预算，这是唯一「写着但模型看不见」的情况，优先级最高。')
  }
  if (largest !== null && dominance >= 0.25) {
    // 「最大项」和「能动的项」经常不是同一个：助手输出 / 用户消息属于对话历史，
    // 砍不掉（只能靠压缩历史或换新会话）。所以最大项不可动时，要把人指向真正能动的那一项，
    // 否则会给出「去砍助手输出」这种根本做不到的建议（实测踩过）。
    const largestActionable = items.find((item) => ACTIONABLE_KINDS.has(item.kind)) ?? null
    if (ACTIONABLE_KINDS.has(largest.kind)) {
      suggestions.push(`**先砍最大项**：「${clip(largest.label, 44)}」一项就占了已用的 ${(dominance * 100).toFixed(0)}%，动它收益最高。`)
    } else if (largestActionable !== null) {
      suggestions.push(`**最大项动不了，改砍第二目标**：「${clip(largest.label, 44)}」占已用 ${(dominance * 100).toFixed(0)}%，`
        + '但它是对话历史，删不掉 —— 只能靠压缩历史或换新会话。'
        + `能马上动的是「${clip(largestActionable.label, 44)}」（占已用 ${(largestActionable.pctOfUsed * 100).toFixed(0)}%）。`)
    } else {
      suggestions.push(`**上下文主要是对话历史**：「${clip(largest.label, 44)}」占已用 ${(dominance * 100).toFixed(0)}%，`
        + '没有可以「删掉」的配置项 —— 该做的是让 DSH 压缩历史，或把长任务拆成新会话。')
    }
  }
  if (deadweight >= 0.05) {
    suggestions.push(`**去重复读**：同一批文件被反复读取，累计浪费约 ${Math.round(supersededTokens)} token（占已用 ${(deadweight * 100).toFixed(0)}%）。重复读之前先看上文有没有。`)
  }
  if (f.growth !== undefined && f.growth.normalized >= 0.6) {
    suggestions.push(`**放慢攒上下文**：按最近节奏约 ${turnsLeft ?? '?'} 轮就会占满，建议在下一个自然断点主动收尾或让 DSH 做一次压缩。`)
  }
  if (occupancy !== null && occupancy >= 0.7) {
    suggestions.push(`**占用已到 ${(occupancy * 100).toFixed(0)}%**：长任务建议拆成多个会话，或先让 DSH 压缩历史再继续。`)
  }
  if (groups.some((g) => g.kind === 'tool' && g.pctOfUsed >= 0.4)) {
    suggestions.push('**工具结果是主因**：占比超过 40%。读文件时用行号范围/关键词过滤，别整份读；命令行输出加 `| Select-Object -Last N` 之类截断。')
  }
  if (suggestions.length === 0) {
    suggestions.push('当前没有明显问题，保持现状即可。')
  }

  // -------------------------------------------------------------------------
  // ⑧ 返回
  // -------------------------------------------------------------------------
  return {
    window: {
      contextTokens: window,
      pressureTokens: pressure,
      /** 提供方账单口径的真实已用量（`usage.totalTokens`），拿不到为 null */
      providerTokens: usageTokens,
      /** 本地逐项归因加起来的总量 */
      estimatedTokens: used,
      dshEstimatedTokens: dshUsed,
      /** 中文内容相对 DSH 官方口径的放大倍数（用来解释「为什么和 DSH 面板不一致」） */
      cjkInflation: dshUsed === 0 ? 1 : used / dshUsed,
      ratio: window === null ? null : usedForRatio / window,
      remaining,
      avgPerTurn: Math.round(avgPerTurn),
      turnsLeft,
      source: pressure !== null ? 'provider' : 'estimate',
      pressureSource: pressure === null ? null : pressureLabel,
    },
    items,
    groups,
    scoring: {
      score: score100,
      level,
      label: LEVEL_LABEL[level],
      factors,
    },
    alerts,
    suggestions,
    dataQuality,
    /** 供调用方核对：逐段与汇总是否自洽 */
    checks: {
      systemMessageTokens,
      promptTokens: promptTotal,
      promptDshTokens: promptDshTotal,
      instructionTokens: instructionTotalTokens,
      instructionBudget: instructionBudgetInfo,
      eventCount: events.length,
    },
  }
}

/** 供渲染层复用的等级排序。 */
export const LEVEL_ORDER = ['ok', 'warn', 'high', 'critical']
