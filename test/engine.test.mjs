/**
 * 归因与判定引擎的单元测试（纯函数，不需要 DSH）。
 *
 * 跑：`npm test`，或单独 `node test/engine.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyze, splitInstructionSections } from '../lib/engine.js'
import { charClasses, cjkInflation, cjkText, dshText, isCjkCode } from '../lib/estimate.js'

// ---------------------------------------------------------------------------
// 计价层
// ---------------------------------------------------------------------------

test('CJK 码位识别：汉字算 CJK，英文不算', () => {
  assert.equal(isCjkCode('中'.codePointAt(0)), true)
  assert.equal(isCjkCode('，'.codePointAt(0)), true)
  assert.equal(isCjkCode('a'.codePointAt(0)), false)
  assert.equal(isCjkCode(' '.codePointAt(0)), false)
})

test('字符分类：中英混排分别计数', () => {
  const { cjk, latin } = charClasses('上下文radar')
  assert.equal(cjk, 3)
  assert.equal(latin, 5)
})

test('中文内容上 CJK 口径明显大于 DSH 的 4 字符/token 口径', () => {
  const text = '本文件每次会话自动读取，开工前先看完本文件再动手。'
  // 比的是**内容密度**，所以去掉 DSH 的块结构开销（+4），否则分母被抬高、比值失真
  const dshContent = dshText(text) - 4
  const cjk = cjkText(text)
  assert.ok(cjk > dshContent, `cjk(${cjk}) 应大于 dsh 内容价(${dshContent})`)
  assert.ok(cjk / dshContent >= 3, `内容低估倍数应 >= 3，实际 ${(cjk / dshContent).toFixed(2)}`)
  // cjkInflation 的口径就是这个内容比
  assert.ok(cjkInflation(text) >= 3, `cjkInflation 应 >= 3，实际 ${cjkInflation(text).toFixed(2)}`)
})

test('纯英文内容两种口径接近（差异只在结构开销）', () => {
  const text = 'the quick brown fox jumps over the lazy dog'
  const dsh = dshText(text) - 4 // 去掉块开销
  const cjk = cjkText(text)
  assert.ok(Math.abs(cjk - dsh) <= 2, `英文两种口径应接近：cjk=${cjk} dsh=${dsh}`)
})

// ---------------------------------------------------------------------------
// 工作区指令按文件切分
// ---------------------------------------------------------------------------

test('按「Instructions from:」把工作区指令切成每文件一节', () => {
  const text = [
    '<system-reminder>',
    'Instructions from: AGENTS.md',
    '',
    '# 契约',
    '正文甲',
    '',
    'Additional instructions from: skills/db/SKILL.md',
    '',
    '正文乙',
    '</system-reminder>',
  ].join('\n')
  const parts = splitInstructionSections(text)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].path, 'AGENTS.md')
  assert.equal(parts[1].path, 'skills/db/SKILL.md')
  assert.ok(parts[0].text.includes('正文甲'))
  assert.ok(parts[1].text.includes('正文乙'))
  // 两节不重叠
  assert.ok(!parts[0].text.includes('正文乙'))
})

test('切不出分节时退回单节且 path 为 null', () => {
  const parts = splitInstructionSections('一段没有分节标记的正文')
  assert.equal(parts.length, 1)
  assert.equal(parts[0].path, null)
})

// ---------------------------------------------------------------------------
// 归因
// ---------------------------------------------------------------------------

/** 造一条注入消息事件。 */
function injectEvent(text, source) {
  return {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text }], source } },
  }
}

/** 造一对 tool-call + tool-result 事件。 */
function toolPair(turn, id, name, args, resultText) {
  return [
    {
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
        },
      },
    },
    {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'text', text: resultText }],
          source: { callId: id },
        },
      },
    },
  ]
}

test('系统提示词按各段字符数等比例分摊', () => {
  const result = analyze({
    sections: [
      { name: '身份', text: 'A'.repeat(400) },
      { name: '工具说明', text: 'B'.repeat(100) },
    ],
    events: [],
  })
  const promptItems = result.items.filter((item) => item.kind === 'prompt')
  assert.equal(promptItems.length, 2)
  const total = promptItems.reduce((sum, item) => sum + item.tokens, 0)
  const identity = promptItems.find((item) => item.label === '身份')
  const tools = promptItems.find((item) => item.label === '工具说明')
  // 400 : 100 = 4 : 1
  assert.ok(Math.abs(identity.tokens / total - 0.8) < 0.02, `身份应占约 80%，实际 ${(identity.tokens / total * 100).toFixed(1)}%`)
  assert.ok(Math.abs(tools.tokens / total - 0.2) < 0.02)
})

test('工作区指令按文件归因，并能识别截断标记', () => {
  const body = [
    '<system-reminder>',
    'Workspace instruction budget 65536 bytes: truncated AGENTS.md from 90000 to 65536 bytes',
    '',
    'Instructions from: AGENTS.md',
    '',
    '甲'.repeat(2000),
    '',
    'Additional instructions from: skills/x/SKILL.md',
    '',
    '乙'.repeat(200),
    '</system-reminder>',
  ].join('\n')
  const result = analyze({
    events: [injectEvent(body, { kind: 'agent-instructions', form: 'instructions', baseline: true })],
    instructionBudget: 65536,
  })
  const mdItems = result.items.filter((item) => item.kind === 'agents-md')
  assert.equal(mdItems.length, 2)
  assert.ok(mdItems.some((item) => item.label === 'AGENTS.md'))
  assert.ok(mdItems.some((item) => item.label === 'skills/x/SKILL.md'))

  const truncAlert = result.alerts.find((alert) => alert.code === 'INSTRUCTIONS_TRUNCATED')
  assert.ok(truncAlert !== undefined, '应识别出截断告警')
  assert.equal(truncAlert.level, 'critical')
  assert.ok(truncAlert.text.includes('AGENTS.md'))
  // 90000 → 65536，丢了 27.2%
  assert.ok(truncAlert.text.includes('27.2%'), `实际文案：${truncAlert.text}`)
})

test('整体被丢弃的文件也告警', () => {
  const body = [
    '<system-reminder>',
    'Workspace instruction budget 65536 bytes: omitted docs/extra.md',
    '',
    'Instructions from: AGENTS.md',
    '甲'.repeat(500),
    '</system-reminder>',
  ].join('\n')
  const result = analyze({
    events: [injectEvent(body, { kind: 'agent-instructions', form: 'instructions', baseline: true })],
  })
  const alert = result.alerts.find((item) => item.code === 'INSTRUCTIONS_OMITTED')
  assert.ok(alert !== undefined)
  assert.ok(alert.text.includes('docs/extra.md'))
})

test('skill 目录按 entries 逐条归因到每个 skill', () => {
  const source = {
    kind: 'skill-catalog',
    form: 'catalog',
    entries: [
      { name: 'db-seeding', description: '连库与造数规范'.repeat(10) },
      { name: 'vision-read', description: '看图识图' },
    ],
  }
  const text = '<system-reminder>\n<available_skills>\n- db-seeding\n- vision-read\n</available_skills>\n</system-reminder>'
  const result = analyze({ events: [injectEvent(text, source)] })
  const catalog = result.items.filter((item) => item.kind === 'skill-catalog')
  assert.ok(catalog.some((item) => item.label === 'db-seeding'))
  assert.ok(catalog.some((item) => item.label === 'vision-read'))
  // db-seeding 描述更长 → token 更多
  const db = catalog.find((item) => item.label === 'db-seeding')
  const vision = catalog.find((item) => item.label === 'vision-read')
  assert.ok(db.tokens > vision.tokens)
})

test('已加载的 skill 正文按 name 归因', () => {
  const result = analyze({
    events: [injectEvent('很长的 skill 正文'.repeat(50), { kind: 'skill-invocation', name: 'test-framework' })],
  })
  const body = result.items.find((item) => item.kind === 'skill-body')
  assert.equal(body.label, 'test-framework')
  assert.ok(body.tokens > 0)
})

test('工具结果通过 callId 回连到工具名与文件路径', () => {
  const result = analyze({
    events: toolPair(1, 'c1', 'read', { path: 'D:\\AI测试框架\\AGENTS.md' }, '文件内容'.repeat(300)),
  })
  const tool = result.items.find((item) => item.kind === 'tool')
  assert.ok(tool !== undefined, '应有工具结果项')
  assert.ok(tool.label.startsWith('read → '), `实际标签：${tool.label}`)
  assert.ok(tool.label.includes('AGENTS.md'))
  assert.ok(tool.tokens > 100)
})

test('重复读取同一文件被算作死重', () => {
  const events = [
    ...toolPair(1, 'c1', 'read', { path: 'D:\\a\\big.md' }, '内容'.repeat(500)),
    ...toolPair(2, 'c2', 'read', { path: 'D:\\a\\big.md' }, '内容'.repeat(500)),
  ]
  const result = analyze({ events })
  const factor = result.scoring.factors.find((item) => item.key === 'deadweight')
  assert.ok(factor.normalized > 0, '重复读取应让死重因子大于 0')
  assert.ok(result.suggestions.some((s) => s.includes('重复读')), `建议里应有去重提示：${result.suggestions.join(' | ')}`)
})

test('两个百分比都对：占已用之和为 1，占窗口按窗口算', () => {
  const result = analyze({
    sections: [{ name: '身份', text: 'A'.repeat(800) }],
    events: [
      ...toolPair(1, 'c1', 'read', { path: 'D:/b.md' }, '乙'.repeat(400)),
    ],
    modelContext: 100000,
  })
  const sum = result.items.reduce((acc, item) => acc + item.pctOfUsed, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `占已用之和应为 1，实际 ${sum}`)
  for (const item of result.items) {
    assert.equal(typeof item.pctOfWindow, 'number')
    assert.ok(Math.abs(item.pctOfWindow - item.tokens / 100000) < 1e-9)
  }
})

test('窗口未知时不给占用率，并明确说明原因', () => {
  const result = analyze({ events: [injectEvent('正文'.repeat(50), { kind: 'skill-invocation', name: 'x' })] })
  assert.equal(result.window.contextTokens, null)
  assert.equal(result.window.ratio, null)
  assert.ok(result.dataQuality.some((note) => note.includes('拿不到模型上下文窗口')))
  // 构成仍然给
  assert.ok(result.items.length > 0)
})

test('占用率越高，判定越危险', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '内'.repeat(4000))]
  const low = analyze({ events, modelContext: 100000 })
  const high = analyze({ events, modelContext: 6000 })
  const order = { ok: 0, warn: 1, high: 2, critical: 3 }
  assert.ok(order[high.scoring.level] > order[low.scoring.level],
    `高占用应为更危险级别：低=${low.scoring.level}(${low.scoring.score}) 高=${high.scoring.level}(${high.scoring.score})`)
})

test('提供方压力明显更大时以它为准，并给出说明', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '内'.repeat(100))]
  const result = analyze({ events, modelContext: 10000, pressureTokens: 9000 })
  assert.equal(result.window.source, 'provider')
  assert.equal(result.window.pressureTokens, 9000)
  assert.ok(result.dataQuality.some((note) => note.includes('提供方报告的真实用量')))
  // 占用率按 9000/10000 算，而不是本地归因的几百 token
  assert.ok(result.window.ratio > 0.8, `实际占用率 ${result.window.ratio}`)
})

// ---------------------------------------------------------------------------
// 真实事件形状的回归（这些坑都是拿真实会话跑出来的，别再退化）
// ---------------------------------------------------------------------------

test('最大项是助手输出时，不许建议「去砍助手输出」（砍不掉的历史）', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '内'.repeat(50))]
  events.push({
    type: 'assistant/message',
    seq: 90,
    data: {
      turn: 5,
      step: 5,
      message: { role: 'assistant', content: [{ type: 'text', text: '回'.repeat(4000) }] },
    },
  })
  const result = analyze({ events })
  assert.equal(result.items[0].kind, 'assistant', `最大项应是助手输出，实际是 ${result.items[0].kind}`)
  const joined = result.suggestions.join(' | ')
  assert.ok(!/先砍最大项/.test(joined), `不该出现「先砍最大项」：${joined}`)
  assert.ok(joined.includes('对话历史'), `应说明助手输出砍不掉、只能压缩/换会话：${joined}`)
})

test('最大项是能动的（工具结果）时，仍给「先砍最大项」', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/huge.md' }, '内'.repeat(20000))]
  const result = analyze({ events })
  assert.equal(result.items[0].kind, 'tool')
  assert.ok(result.suggestions.join(' | ').includes('先砍最大项'), `应直接指向可动的项：${result.suggestions.join(' | ')}`)
})

test('真实 user/message：data 本身就是消息，source 直接在 data 上', () => {
  // 实测：`user/message` 的 data 键是 ["content","source","role","id"] —— 没有 data.message
  const result = analyze({
    events: [
      {
        type: 'user/message',
        seq: 1,
        data: {
          role: 'user',
          id: 'm1',
          content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\n' + '契'.repeat(800) }],
          source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
        },
      },
    ],
  })
  const md = result.items.filter((item) => item.kind === 'agents-md')
  assert.equal(md.length, 1, '真实形状下必须能按文件归因（早先这里会归因成 0 项）')
  assert.equal(md[0].label, 'AGENTS.md')
  assert.ok(md[0].tokens > 100)
})

test('runtime-context 按自带 sections 逐段归因', () => {
  const result = analyze({
    events: [
      {
        type: 'user/message',
        seq: 1,
        data: {
          role: 'user',
          content: [{ type: 'text', text: '沙箱策略正文'.repeat(100) }],
          source: {
            kind: 'runtime-context',
            form: 'snapshot',
            sections: [
              { name: 'sandbox:policy', text: '甲'.repeat(600) },
              { name: 'env:facts', text: '乙'.repeat(200) },
            ],
          },
        },
      },
    ],
  })
  const items = result.items.filter((item) => item.kind === 'inject-other')
  assert.equal(items.length, 2, '两段运行上下文应各成一项')
  assert.ok(items.some((item) => item.label.includes('sandbox:policy')))
  const sandbox = items.find((item) => item.label.includes('sandbox:policy'))
  const env = items.find((item) => item.label.includes('env:facts'))
  assert.ok(sandbox.tokens > env.tokens)
})

test('优先吃 surface 消息（messages），不会被原始事件流带偏', () => {
  // surface 里只有 1 条用户消息；事件流里却有 50 条已被压缩掉的历史
  const stale = []
  for (let i = 0; i < 50; i += 1) {
    stale.push({ type: 'user/message', seq: i, data: { role: 'user', content: [{ type: 'text', text: '旧'.repeat(500) }], source: { kind: 'user' } } })
  }
  const messages = [
    { role: 'system', content: [{ type: 'text', text: '系统提示词' }], source: { kind: 'system-prompt' } },
    { role: 'user', content: [{ type: 'text', text: '现在的问题' }], source: { kind: 'user' } },
  ]
  const onlyEvents = analyze({ events: stale })
  const withMessages = analyze({ events: stale, messages })
  assert.ok(withMessages.window.estimatedTokens < onlyEvents.window.estimatedTokens / 10,
    `surface 应远小于原始事件流：messages=${withMessages.window.estimatedTokens} events=${onlyEvents.window.estimatedTokens}`)
  assert.ok(withMessages.dataQuality.every((note) => !note.includes('就地重建')), '有 surface 时不该出现在地重建的提示')
})

test('账单 usage 优先于 contextPressure 投影做锚', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '内'.repeat(50))]
  const result = analyze({ events, modelContext: 200000, providerTokens: 150000, pressureTokens: 60000 })
  assert.equal(result.window.providerTokens, 150000)
  assert.equal(result.window.pressureSource, 'usage.totalTokens')
  // 占用率按 150000/200000 算，而不是 60000
  assert.ok(Math.abs(result.window.ratio - 0.75) < 1e-9, `实际占用率 ${result.window.ratio}`)
})

test('提供方账单更大时补一条「未归因」，让「占已用」与表头口径一致', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '内'.repeat(50))]
  const result = analyze({ events, modelContext: 200000, providerTokens: 10000 })
  const unattributed = result.items.find((item) => item.kind === 'unattributed')
  assert.ok(unattributed !== undefined, '应补一条「未归因」，否则用户拿某行除以表头数会算不上')
  // 各项之和 = 提供方账单 → 表头的「已用」就是各行的分母
  const sum = result.items.reduce((acc, item) => acc + item.tokens, 0)
  assert.equal(sum, 10000, `各项之和应等于账单 ${10000}，实际 ${sum}`)
  const pctSum = result.items.reduce((acc, item) => acc + item.pctOfUsed, 0)
  assert.ok(Math.abs(pctSum - 1) < 1e-9, `「占已用」应加总为 100%，实际 ${pctSum}`)
  assert.ok(Math.abs(result.window.ratio - 0.05) < 1e-9, `占用率应是 10000/200000，实际 ${result.window.ratio}`)
})

test('本地归因远大于账单时给出「口径偏大」提示，不装作正常', () => {
  const events = [...toolPair(1, 'c1', 'read', { path: 'D:/x.md' }, '巨'.repeat(5000))]
  const result = analyze({ events, modelContext: 200000, providerTokens: 1000 })
  assert.ok(result.dataQuality.some((note) => note.includes('明显大于提供方真实用量')), `实际说明：${result.dataQuality.join(' | ')}`)
})

test('单个巨型工具结果会触发告警', () => {
  const events = [
    ...toolPair(1, 'c1', 'read', { path: 'D:/huge.md' }, '巨'.repeat(20000)),
    ...toolPair(2, 'c2', 'read', { path: 'D:/small.md' }, '小'.repeat(100)),
  ]
  const result = analyze({ events })
  const alert = result.alerts.find((item) => item.code === 'TOOL_RESULT_HEAVY')
  assert.ok(alert !== undefined, '巨型工具结果应告警')
  assert.ok(alert.text.includes('huge.md'))
})

test('健康状态下不出告警、给「保持现状」', () => {
  const result = analyze({
    sections: [{ name: '身份', text: '短提示词' }],
    events: [injectEvent('你好', null)],
    modelContext: 128000,
  })
  assert.equal(result.scoring.level, 'ok')
  assert.equal(result.alerts.length, 0)
  assert.ok(result.suggestions.length >= 1)
})

test('空输入不抛异常，返回零值报告', () => {
  const result = analyze({})
  assert.equal(result.items.length, 0)
  assert.equal(result.window.estimatedTokens, 0)
  assert.ok(Array.isArray(result.suggestions))
  assert.ok(result.suggestions.length >= 1)
})

test('分组汇总与逐项自洽', () => {
  const result = analyze({
    sections: [{ name: '身份', text: 'A'.repeat(200) }],
    events: [
      ...toolPair(1, 'c1', 'read', { path: 'D:/a.md' }, '甲'.repeat(200)),
      ...toolPair(2, 'c2', 'grep', { pattern: 'foo' }, '乙'.repeat(200)),
    ],
    toolsSchema: [{ name: 'read', description: '读文件' }],
  })
  const itemSum = result.items.reduce((sum, item) => sum + item.tokens, 0)
  const groupSum = result.groups.reduce((sum, group) => sum + group.tokens, 0)
  assert.equal(itemSum, groupSum)
  assert.equal(itemSum, result.window.estimatedTokens)
  // grep 与 read 归同一个 tool 分组
  const toolGroup = result.groups.find((group) => group.kind === 'tool')
  assert.equal(toolGroup.count, 2)
})
