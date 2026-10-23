/**
 * 渲染层测试：确保报告「一目了然」的硬要求没退化。
 *
 * 跑：`node test/render.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyze } from '../lib/engine.js'
import { renderOneLine, renderReport } from '../lib/render.js'

/** 造一份固定的分析结果。 */
function sample(overrides = {}) {
  const events = [
    {
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\n' + '甲'.repeat(3000) }],
          source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
        },
      },
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"D:/big.md"}' }] },
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'text', text: '乙'.repeat(600) }], source: { callId: 'c1' } },
      },
    },
  ]
  return analyze({
    sections: [
      { name: '身份', text: '丙'.repeat(400) },
      { name: '工具说明', text: '丁'.repeat(200) },
    ],
    events,
    modelContext: 128000,
    ...overrides,
  })
}

test('一行摘要足够短，且带上等级、占用率、最大项', () => {
  const line = renderOneLine(sample())
  assert.ok(line.includes('已用'))
  assert.ok(line.includes('%'))
  assert.ok(line.includes('最大项'))
  // 一行摘要必须真的只有一行
  assert.ok(!line.includes('\n'), '一行摘要不能有换行')
  assert.ok(line.length < 200, `一行摘要过长：${line.length} 字符`)
})

test('完整报告给出两列百分比（占已用 + 占窗口）', () => {
  const report = renderReport(sample())
  assert.ok(report.includes('占已用'), '缺少「占已用」列')
  assert.ok(report.includes('占窗口'), '缺少「占窗口」列')
  assert.ok(report.includes('AGENTS.md'), '排行榜里应出现具体文件名')
})

test('报告里分别列出系统提示词各段与每个文件', () => {
  const report = renderReport(sample())
  assert.ok(report.includes('身份'), '应列出系统提示词分段')
  assert.ok(report.includes('工具说明'))
  assert.ok(report.includes('AGENTS.md'))
  assert.ok(report.includes('big.md'), '应列出工具读了哪个文件')
})

test('排行按 token 降序，最大项排第一', () => {
  const analysis = sample()
  const report = renderReport(analysis)
  const firstItem = analysis.items[0]
  const idx = report.indexOf(firstItem.label)
  assert.ok(idx > 0)
  // 排行第一行应该出现在第二项之前
  const secondItem = analysis.items[1]
  if (secondItem !== undefined) {
    assert.ok(idx < report.indexOf(secondItem.label), '排行榜必须按大小降序')
  }
})

test('limit 生效，并提示还有多少项没显示', () => {
  const report = renderReport(sample(), { limit: 2 })
  assert.ok(report.includes('另有'), `应提示被截断的项：${report.slice(0, 200)}`)
})

test('窗口未知时报告照样出，并说明不给占比的原因', () => {
  const report = renderReport(sample({ modelContext: undefined }))
  assert.ok(report.includes('窗口未知'))
  assert.ok(report.includes('占已用'))
})

test('附上采集诊断时能看到每个数据源走了哪条路', () => {
  const report = renderReport(sample(), {
    showProbes: true,
    probes: { session: 'exec.agent.session', events: 'session.snapshotEvents()（12 条）' },
  })
  assert.ok(report.includes('采集诊断'))
  assert.ok(report.includes('exec.agent.session'))
})

test('含中文的报告里不出现未中和的双大括号（否则提示词组装会抛错）', () => {
  const report = renderReport(sample())
  // renderReport 给的是终端文本，不直接进提示词；这里保证它本身没有 {{name}} 形态
  assert.ok(!/\{\{[A-Za-z0-9_.-]+\}\}/.test(report), '报告里不该出现未中和的变量引用')
})
