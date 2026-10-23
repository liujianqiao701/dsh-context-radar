/**
 * Token 计价层。
 *
 * 本文件给两套口径，**都保留**，因为它们回答不同的问题：
 *
 * | 口径 | 用途 | 依据 |
 * | --- | --- | --- |
 * | `dsh*` | 与 DSH 自己的 `dsh-token-meter` **逐字节一致**，用于「我说 30% 而 DSH 面板说 30%」时对得上 | `@deepseek-ai/dsh-token-meter` 的 `estimate.js`（4 字符/token + 块开销 4 + 角色开销 4） |
 * | `cjk*` | **判断膨胀**用，默认口径 | 与 DSH 口径的差异见下方 ⚠️ |
 *
 * ⚠️ **为什么必须有第二套**：DSH 的固定启发式是「4 个字符 = 1 token」，这是**英文**密度。
 * 中文实测约 **1 字符 ≈ 0.6~1 token**（取决于分词器），也就是说 DSH 的官方数字对中文内容
 * **低估 3~4 倍**。DSH 自己的 README 也承认这一点：
 * 「CJK 文本与 JSON schema 在每 token 四字符下严重低估」。
 *
 * 对「查询显示占用」来说低估无所谓（占比是等比缩放的）；
 * 但**对「是否膨胀」来说低估是致命的** —— 明明已经 90% 了，按 4 字符/token 算出来才 25%，
 * 于是永远不告警。所以膨胀判定一律用 `cjk*`，DSH 口径只作对照展示。
 */

/** DSH 官方口径：每 token 多少字符。 */
const CHARS_PER_TOKEN = 4
/** DSH 官方口径：每个内容块的 JSON 结构开销。 */
const BLOCK_OVERHEAD = 4
/** DSH 官方口径：每条消息的角色字段开销。 */
export const ROLE_OVERHEAD = 4

// ---------------------------------------------------------------------------
// ① DSH 兼容口径（与 dsh-token-meter 完全一致）
// ---------------------------------------------------------------------------

/**
 * DSH 口径：一块纯文本的计价。
 * @param {string} text 文本
 * @returns {number} token 数（含块结构开销）
 */
export function dshText(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * DSH 口径：内容块数组计价（`estimateContent` 的等价实现）。
 * @param {Array<object>} blocks 内容块
 * @returns {number} token 数
 */
export function dshContent(blocks) {
  let tokens = 0
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        // 未知块（含图片引用）按保守的结构化 JSON 计价，与 DSH 一致
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block ?? {}).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * DSH 口径：整条消息计价。
 * @param {{role?: string, content?: Array<object>}} message 消息
 * @returns {number} token 数
 */
export function dshMessage(message) {
  const content = message?.content ?? []
  if (message?.role === 'system') {
    if (content.length === 0) return 0
    let characters = 0
    for (const block of content) {
      characters += block?.type === 'text' ? String(block.text ?? '').length : JSON.stringify(block ?? {}).length
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  return dshContent(content) + ROLE_OVERHEAD
}

/**
 * DSH 口径：工具 schema 计价。
 * @param {Array<object>|undefined} tools 工具 schema 数组
 * @returns {number} token 数
 */
export function dshTools(tools) {
  if (tools === undefined || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// ---------------------------------------------------------------------------
// ② CJK 感知口径（默认，用于判膨胀）
// ---------------------------------------------------------------------------

/**
 * 每字符的 token 权重（CJK 感知）。
 *
 * 取值依据：中文常见分词器约 **1 字符 ≈ 0.6~1 token**。这里取 `1.0`（**偏保守、宁可早报**），
 * 因为本插件的用途是"及时提醒"，**漏报比误报代价大**：漏报会让上下文直接撞墙，
 * 误报只是多看一眼。拉丁字母/数字/标点沿用 4 字符/token。
 *
 * 想调成更贴近实测的密度，改这里即可（`cjk: 0.6` 更接近 DeepSeek 分词器的中文实测值）。
 */
export const DENSITY = {
  /** 中日韩文字与全角标点：1 字符 1 token（保守） */
  cjk: 1,
  /** 其余（ASCII、空白、半角标点）：4 字符 1 token */
  latin: 1 / CHARS_PER_TOKEN,
}

/** CJK 相关码位区间：汉字、假名、全角标点、CJK 标点、兼容表意、圈号数字等。 */
const CJK_RANGES = [
  [0x1100, 0x11ff], // 韩文字母
  [0x2e80, 0x2eff], // CJK 部首补充
  [0x3000, 0x303f], // CJK 符号与标点（、。「」等）
  [0x3040, 0x30ff], // 平假名 + 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区（绝大多数汉字）
  [0xa960, 0xa97f], // 韩文字母扩展 A
  [0xac00, 0xd7ff], // 韩文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xffef], // 半角及全角形式
  [0x20000, 0x3ffff], // CJK 扩展 B 及以后
]

/**
 * 判断一个码位是否属于 CJK 区。
 * @param {number} code 码位
 * @returns {boolean} 是否 CJK
 */
export function isCjkCode(code) {
  for (const [start, end] of CJK_RANGES) {
    if (code >= start && code <= end) return true
  }
  return false
}

/**
 * 把文本拆成「CJK 字符数」与「其余字符数」。
 * @param {string} text 文本
 * @returns {{cjk: number, latin: number}} 两类字符计数
 */
export function charClasses(text) {
  let cjk = 0
  let latin = 0
  for (const ch of String(text ?? '')) {
    if (isCjkCode(ch.codePointAt(0))) cjk += 1
    else latin += 1
  }
  return { cjk, latin }
}

/**
 * CJK 感知口径：纯文本计价（不含结构开销）。
 *
 * 只给纯文本用；消息级计价见 {@link cjkMessage}。
 * @param {string} text 文本
 * @returns {number} token 数（向上取整）
 */
export function cjkText(text) {
  const { cjk, latin } = charClasses(text)
  return Math.ceil(cjk * DENSITY.cjk + latin * DENSITY.latin)
}

/**
 * CJK 感知口径：内容块数组计价。
 * @param {Array<object>} blocks 内容块
 * @returns {number} token 数
 */
export function cjkContent(blocks) {
  let tokens = 0
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += cjkText(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += cjkText(block.name) + cjkText(block.arguments) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + cjkText(JSON.stringify(block ?? {}))
    }
  }
  return tokens
}

/**
 * CJK 感知口径：整条消息计价。
 * @param {{role?: string, content?: Array<object>}} message 消息
 * @returns {number} token 数
 */
export function cjkMessage(message) {
  const content = message?.content ?? []
  if (message?.role === 'system') {
    if (content.length === 0) return 0
    let characters = 0
    for (const block of content) {
      characters += block?.type === 'text' ? cjkText(block.text) : cjkText(JSON.stringify(block ?? {}))
    }
    return characters + ROLE_OVERHEAD
  }
  return cjkContent(content) + ROLE_OVERHEAD
}

/**
 * CJK 感知口径：工具 schema 计价。
 * @param {Array<object>|undefined} tools 工具 schema 数组
 * @returns {number} token 数
 */
export function cjkTools(tools) {
  if (tools === undefined || tools.length === 0) return 0
  return cjkText(JSON.stringify(tools)) + BLOCK_OVERHEAD
}

/**
 * 中文内容的低估倍数（用于在报告里说明「DSH 面板为什么比这个小」）。
 * @param {string} text 文本
 * @returns {number} cjk 口径 / dsh 口径，≥1
 */
export function cjkInflation(text) {
  const dsh = Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN)
  const cjk = cjkText(text)
  return dsh === 0 ? 1 : Math.max(1, cjk / dsh)
}
