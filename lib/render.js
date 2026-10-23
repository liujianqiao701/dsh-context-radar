/**
 * 渲染层：把 `engine.analyze()` 的结果变成**人一眼能看懂**的文字。
 *
 * 两种形态：
 * - `renderReport()`：完整的排行榜（工具输出、`/ctx` 命令用）
 * - `renderOneLine()`：一行摘要（塞进系统提示词做「及时提醒」，不能占地方）
 */

/** 类别显示名。 */
const KIND_LABEL = {
  prompt: '系统提示词',
  'tools-schema': '工具定义',
  'agents-md': '工作区指令',
  'skill-catalog': 'skill 目录',
  'skill-body': 'skill 正文',
  tool: '工具结果',
  user: '用户输入',
  assistant: '助手输出',
  compaction: '压缩摘要',
  'session-ref': '跨会话召回',
  'inject-other': '其他注入',
  developer: 'developer 消息',
  unattributed: '未归因',
}

/** 千分位。 */
function num(value) {
  const n = Math.round(Number(value) || 0)
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 百分比，保留一位小数。 */
function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${(value * 100).toFixed(1)}%`
}

/** 进度条。 */
function bar(ratio, width = 16) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return ' '.repeat(width)
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** 按显示宽度补齐（CJK 算 2 列），避免中文把表格挤歪。 */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    width += (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1
  }
  return width
}

/** 按显示宽度右/左补齐。 */
function pad(text, width, align = 'left') {
  const source = String(text ?? '')
  const gap = Math.max(0, width - displayWidth(source))
  return align === 'right' ? ' '.repeat(gap) + source : source + ' '.repeat(gap)
}

/** 按显示宽度截断（加省略号）。 */
function clipDisplay(text, width) {
  const source = String(text ?? '')
  if (displayWidth(source) <= width) return source
  let out = ''
  let used = 0
  for (const ch of source) {
    const w = displayWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/**
 * 一行摘要：放系统提示词里做「及时提醒」时用，必须极短。
 *
 * @param {object} analysis `engine.analyze()` 的结果
 * @returns {string} 单行文本
 */
export function renderOneLine(analysis) {
  const { window: win, scoring, items } = analysis
  const top = items[0]
  const parts = [scoring.label]
  const usedShown = typeof win.providerTokens === 'number' && win.providerTokens > 0 ? win.providerTokens : win.estimatedTokens
  if (win.contextTokens === null) {
    parts.push(`已用约 ${num(usedShown)} token（窗口未知）`)
  } else {
    parts.push(`已用 ${num(usedShown)}/${num(win.contextTokens)}（${pct(win.ratio)}）${bar(win.ratio, 10)}`)
  }
  if (top !== undefined) parts.push(`最大项 ${clipDisplay(top.label, 24)} ${pct(top.pctOfUsed)}`)
  if (win.turnsLeft !== null && win.turnsLeft !== undefined && win.turnsLeft <= 8) parts.push(`约 ${win.turnsLeft} 轮后占满`)
  return parts.join(' · ')
}

/**
 * 完整报告。
 *
 * @param {object} analysis `engine.analyze()` 的结果
 * @param {object} [options] 选项
 * @param {number} [options.limit] 排行榜最多显示多少行，默认 20
 * @param {boolean} [options.showProbes] 是否附上采集诊断
 * @param {object} [options.probes] 采集诊断（`collectFacts()` 的 probes）
 * @param {number} [options.noteWidth] 说明列宽，默认 34
 * @returns {string} 报告文本
 */
export function renderReport(analysis, options = {}) {
  const limit = options.limit ?? 20
  const { window: win, items, groups, scoring, alerts, suggestions, dataQuality } = analysis
  const lines = []

  // ---- 抬头 ---------------------------------------------------------------
  const headRatio = win.ratio
  // 头部显示**提供方口径**的真实占用（有就用它），否则显示本地归因
  const usedShown = typeof win.providerTokens === 'number' && win.providerTokens > 0 ? win.providerTokens : win.estimatedTokens
  let head = `📊 上下文雷达 · ${scoring.label}（风险分 ${scoring.score}/100）`
  lines.push(head)
  if (win.contextTokens === null) {
    lines.push(`   已用约 ${num(usedShown)} token · 模型窗口未知，只给构成不给占比`)
  } else {
    lines.push(`   已用 ${num(usedShown)} / ${num(win.contextTokens)} token（${pct(headRatio)}）${bar(headRatio, 24)}`)
    lines.push(`   余量 ${num(win.remaining)} token`
      + (win.avgPerTurn > 0 ? ` · 最近平均每轮 +${num(win.avgPerTurn)}`
        + (win.turnsLeft !== null ? ` · 按此速度约 ${win.turnsLeft} 轮后占满` : '') : ''))
  }
  if (win.source === 'provider') {
    const gap = win.pressureTokens - win.estimatedTokens
    if (gap > 0) {
      lines.push(`   （已用取自提供方 ${win.pressureSource ?? 'usage'} 的 ${num(win.pressureTokens)} token，比本地能逐条归因的 ${num(win.estimatedTokens)} 多 —— 差额是无法逐条归因的部分）`)
    } else {
      lines.push(`   （已用取自提供方 ${win.pressureSource ?? 'usage'} 的 ${num(win.pressureTokens)} token）`)
    }
  }
  lines.push('')

  // ---- 排行榜 -------------------------------------------------------------
  const labelWidth = Math.min(40, Math.max(18, ...items.slice(0, limit).map((item) => displayWidth(item.label))))
  const nameWidth = 12
  lines.push(`   #  类别         ${pad('来源', labelWidth)}  ${pad('token', 9, 'right')}  ${pad('占已用', 7, 'right')}  ${pad('占窗口', 7, 'right')}  占比条`)
  lines.push(`  ${'─'.repeat(nameWidth + labelWidth + 40)}`)
  items.slice(0, limit).forEach((item, index) => {
    const kind = KIND_LABEL[item.kind] ?? item.kind
    lines.push(
      `  ${pad(String(index + 1), 3, 'right')}  ${pad(kind, nameWidth)}  ${pad(clipDisplay(item.label, labelWidth), labelWidth)}`
      + `  ${pad(num(item.tokens), 9, 'right')}  ${pad(pct(item.pctOfUsed), 7, 'right')}  ${pad(pct(item.pctOfWindow), 7, 'right')}  ${bar(item.pctOfUsed, 20)}`,
    )
  })
  if (items.length > limit) {
    lines.push(`  … 另有 ${items.length - limit} 项（占已用 ${pct(items.slice(limit).reduce((s, i) => s + i.pctOfUsed, 0))}），用 \`/ctx --all\` 看全量`)
  }
  lines.push('')

  // ---- 分类汇总 -----------------------------------------------------------
  lines.push('  按类别汇总：')
  for (const group of groups) {
    lines.push(`    ${pad(KIND_LABEL[group.kind] ?? group.kind, 12)} ${pad(num(group.tokens), 9, 'right')}  ${pad(pct(group.pctOfUsed), 7, 'right')}  ${bar(group.pctOfUsed, 16)}  （${group.count} 项）`)
  }
  lines.push('')

  // ---- 打分因子 -----------------------------------------------------------
  lines.push('  风险拆解：')
  for (const factor of scoring.factors) {
    lines.push(`    ${pad(factor.label, 12)} 权重 ${(factor.weight * 100).toFixed(0).padStart(2)}%  命中度 ${bar(factor.normalized, 10)}  ${factor.note}`)
  }
  lines.push('')

  // ---- 告警 ---------------------------------------------------------------
  if (alerts.length > 0) {
    lines.push('  ⚠️ 硬告警（这些是确定的事实，不是估计）：')
    for (const alert of alerts) {
      lines.push(`    ${alert.level === 'critical' ? '🔴' : '🟡'} ${alert.text}`)
      lines.push(`       处置：${alert.action}`)
    }
    lines.push('')
  }

  // ---- 建议 ---------------------------------------------------------------
  lines.push('  💡 建议：')
  for (const suggestion of suggestions) lines.push(`    · ${suggestion}`)
  lines.push('')

  // ---- 数据质量 -----------------------------------------------------------
  const notes = [...dataQuality]
  if (notes.length > 0) {
    lines.push('  ℹ️ 数据说明：')
    for (const note of notes) lines.push(`    · ${note}`)
    lines.push('')
  }

  // ---- 采集诊断 -----------------------------------------------------------
  if (options.showProbes === true && options.probes !== undefined) {
    lines.push('  🔧 采集诊断（每个数据来源走了哪条路径）：')
    for (const [key, value] of Object.entries(options.probes)) {
      lines.push(`    ${pad(key, 20)} ${value}`)
    }
    lines.push('')
  }

  lines.push('  ⓘ token 数是估算：中文按 1 字符 ≈ 1 token（保守），英文按 4 字符/token。')
  lines.push('     「占已用」看谁最该砍，「占窗口」看还有多少余量 —— 两个问题的答案不一样，所以两列都给了。')
  if (win.cjkInflation > 1.3) {
    lines.push(`     中文内容多，数字约为 DSH 官方口径（4 字符/token）的 ${win.cjkInflation.toFixed(1)} 倍；`
      + '官方口径对中文低估 3~4 倍，按它判膨胀会漏报。')
  }
  return lines.join('\n')
}
