/**
 * 接线测试：用**假的 cordis ctx** 跑一遍 `apply()`，确认
 * ① 四件事（工具 / 命令 / 提示词段落 / 数据路由）都注册上了；
 * ② 任何服务缺失时都**不抛异常**（插件绝不能把 DSH 启动搞挂）；
 * ③ 工具与提示词段落真能产出内容。
 *
 * 跑：`node test/install.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../lib/index.js'

/** 造一份假会话。 */
function fakeSession() {
  return {
    header: { id: 'test-session', cwd: 'D:/AI测试框架', provider: 'test-provider', model: 'test-model' },
    snapshotEvents: () => [
      {
        seq: 1,
        type: 'user/message',
        data: {
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\n' + '契'.repeat(4000) }],
            source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
          },
        },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"D:/big.md"}' }] },
        },
      },
      {
        seq: 3,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'user', content: [{ type: 'text', text: '乙'.repeat(2000) }], source: { callId: 'c1' } },
        },
      },
    ],
  }
}

/** 造一个记录注册动作的假 ctx。 */
function fakeCtx(options = {}) {
  const recorded = { tools: [], commands: [], sections: [], routes: [] }
  const session = options.session ?? fakeSession()

  const services = {
    tools: { register: (tool) => recorded.tools.push(tool) },
    commands: { register: (def) => recorded.commands.push(def) },
    systemPrompt: {
      section: (section) => {
        recorded.sections.push(section)
        return () => {}
      },
      assemble: async () => ({
        sections: [
          { name: '身份', text: '你是编码代理。'.repeat(100) },
          { name: '工具说明', text: 'Tool SDK.'.repeat(200) },
        ],
        variables: {},
        tools: [{ name: 'read' }],
      }),
    },
    webServer: {
      register: (route) => {
        recorded.routes.push(route)
        return () => {}
      },
    },
    sessions: { list: () => [session] },
    llm: {
      // 🔴 真实形状（读 dsh-llm 的 normalizeModelInfo 确认）：窗口在嵌套对象里。
      // 早先这里写成 `{ context: 128000 }` —— 假的也照着我错的假设编，于是测试永远抓不到那个 bug。
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        name: model,
        context: { contextWindow: 128000 },
      }),
    },
  }

  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  return { ctx, recorded, session }
}

test('正常挂载：工具 / 命令 / 提示词段落 / 数据路由都注册上', () => {
  const { ctx, recorded } = fakeCtx()
  plugin.apply(ctx, {})
  assert.equal(recorded.tools.length, 1, '应注册 1 个工具')
  assert.equal(recorded.tools[0].name, 'context_radar')
  assert.ok(recorded.commands.some((c) => c.name === 'ctx'), '应注册 /ctx 命令')
  assert.ok(recorded.commands.some((c) => c.name === 'ctx-watch'), '应注册 /ctx-watch 命令')
  assert.equal(recorded.sections.length, 1, '应注册 1 个提示词段落')
  assert.equal(recorded.sections[0].name, 'context-radar')
  assert.ok(Number.isFinite(recorded.sections[0].order), '段落 order 必须是有限数，否则注册会抛')
  assert.equal(recorded.routes.length, 1, '应注册 1 条数据路由')
  assert.equal(recorded.routes[0].kind, 'exact')
  assert.equal(recorded.routes[0].path, '/api/dsh-context-radar/report')
})

test('工具真能出报告：带两列百分比与具体文件名', async () => {
  const { ctx, recorded, session } = fakeCtx()
  plugin.apply(ctx, {})
  const tool = recorded.tools[0]
  const out = await tool.execute({}, { agent: { session } })
  assert.equal(typeof out.text, 'string')
  assert.ok(out.text.includes('占已用'))
  assert.ok(out.text.includes('占窗口'))
  assert.ok(out.text.includes('AGENTS.md'), '报告里应出现具体文件名')
  assert.ok(['ok', 'warn', 'high', 'critical'].includes(out.level), `level 非法：${out.level}`)
  // dataJson 必须能解析
  const data = JSON.parse(out.dataJson)
  assert.ok(Array.isArray(data.items))
  assert.ok(data.window.estimatedTokens > 0)
})

test('提示词段落在健康状态下返回空串（零开销）', async () => {
  const { ctx, recorded, session } = fakeCtx()
  plugin.apply(ctx, {})
  const provider = recorded.sections[0].text
  assert.equal(typeof provider, 'function', '段落 text 应为 provider 函数')
  // 首次调用：缓存空 → 触后台刷新 → 返回空串
  const first = provider({ agent: { session } })
  assert.equal(first, '', '首次应是空串（还没算出来）')
  // 等后台刷新落定后再问一次
  await new Promise((resolve) => setTimeout(resolve, 60))
  const second = provider({ agent: { session } })
  assert.equal(typeof second, 'string')
  // 健康场景（窗口未知但占用很低）不该注入提醒
  if (second !== '') {
    assert.ok(second.includes('上下文雷达'), '注入时应有明确前缀')
    assert.ok(!/\{\{[A-Za-z0-9_.-]+\}\}/.test(second), '段落文本不能留下未中和的 {{变量}}，否则组装会抛错')
  }
})

test('数据路由返回合法 JSON', async () => {
  const { ctx, recorded } = fakeCtx()
  plugin.apply(ctx, {})
  const route = recorded.routes[0]
  let body = ''
  let headers = {}
  const res = {
    statusCode: 0,
    setHeader: (k, v) => {
      headers[k] = v
    },
    end: (chunk) => {
      body = String(chunk ?? '')
    },
  }
  await route.handler({ url: route.path, method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.ok(String(headers['content-type']).includes('application/json'))
  const data = JSON.parse(body)
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.items))
  assert.ok(data.scoring !== undefined)
})

test('无任何服务时 apply 不抛异常（降级为空插件）', () => {
  assert.doesNotThrow(() => plugin.apply({}, {}))
})

test('只有 get 没有具体服务时也不抛', () => {
  assert.doesNotThrow(() => plugin.apply({ get: () => undefined }, {}))
})

test('输出 schema 合规：required 在对象层，不在属性里', () => {
  const { ctx, recorded } = fakeCtx()
  plugin.apply(ctx, {})
  const schema = recorded.tools[0].output?.schema
  assert.ok(schema !== undefined, '工具必须有 output.schema')
  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required), '`required` 必须是对象层的数组')
  for (const name of schema.required) {
    assert.ok(Object.hasOwn(schema.properties, name), `required 里的 ${name} 必须是已声明的属性`)
  }
  // 🔴 这一条是真踩过的坑：属性里写 required 会被 DSH 校验拒收，工具静默注册不上
  for (const [name, prop] of Object.entries(schema.properties)) {
    assert.ok(!Object.hasOwn(prop, 'required'), `属性 ${name} 里不能再写 required —— DSH 会报 unsupported JSON schema`)
  }
})

test('tools 服务晚挂载时，工具会异步补注册（真实启动时序坑）', async () => {
  const recorded = []
  let toolsReady = false
  const ctx = {
    get: (name) => (name === 'tools' ? (toolsReady ? { register: (tool) => recorded.push(tool) } : undefined) : undefined),
  }
  plugin.apply(ctx, {})
  assert.equal(recorded.length, 0, '服务还没就绪时不该注册')
  toolsReady = true
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(recorded.length, 1, '服务就绪后必须补注册上（否则工具永远静默消失）')
  assert.equal(recorded[0].name, 'context_radar')
})

test('apply 里某个服务抛异常不连锁影响其它注册', () => {
  const recorded = { tools: [], commands: [] }
  const ctx = {
    get: (name) => {
      if (name === 'tools') throw new Error('boom')
      if (name === 'commands') return { register: (def) => recorded.commands.push(def) }
      return undefined
    },
  }
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  // tools 炸了，commands 仍然要注册上
  assert.equal(recorded.commands.length, 2, '命令注册不应被工具注册的异常带崩')
})

test('能取到模型窗口（嵌套 context.contextWindow）并给出「占窗口」列', async () => {
  const { ctx, recorded } = fakeCtx()
  plugin.apply(ctx, {})
  const text = await recorded.tools[0].execute({ probes: true }, { agent: { session: fakeSession() } })
  const report = typeof text === 'string' ? text : text.text
  assert.ok(!report.includes('窗口未知'), '窗口不该未知 —— resolveModelInfo 的返回形状是 { context: { contextWindow } }')
  assert.ok(!report.includes('拿不到模型上下文窗口'), '不该出现拿不到窗口的说明')
  const data = JSON.parse(typeof text === 'string' ? '{}' : (text.dataJson ?? '{}'))
  if (data.window !== undefined) {
    assert.equal(data.window.contextTokens, 128000)
    assert.ok(data.window.ratio !== null && data.window.ratio > 0)
  }
})

test('命令定义符合 DSH 真契约：字段是 handler、收到 invocation 对象、返回 {kind,text}', async () => {
  const { ctx, recorded, session } = fakeCtx()
  plugin.apply(ctx, {})
  for (const cmd of recorded.commands) {
    // name 必须匹配 /^[a-z][a-z0-9_-]*$/u
    assert.ok(/^[a-z][a-z0-9_-]*$/.test(cmd.name), `命令名不合法：${cmd.name}`)
    assert.equal(typeof cmd.description, 'string')
    assert.ok(cmd.description.trim().length > 0, '描述不能为空')
    // 🔴 真踩过的坑：写 `run` 会被 commands 服务拒收，命令静默消失
    assert.equal(typeof cmd.handler, 'function', `命令 ${cmd.name} 必须用 handler 字段`)
    assert.equal(cmd.run, undefined, '不该再出现 run 字段')
    if (cmd.input !== undefined) assert.equal(typeof cmd.input.hint, 'string')
  }
  const cmd = recorded.commands.find((c) => c.name === 'ctx')
  const result = await cmd.handler({ commandId: 'c1', agent: { session }, rawInput: '', attachments: [], signal: undefined })
  assert.equal(typeof result, 'object', '必须返回对象，不能是字符串')
  assert.equal(result.kind, 'success')
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.includes('占已用') || result.text.includes('上下文雷达'))
})

test('/ctx 拿不到会话时给可操作提示，而不是崩', async () => {
  const { ctx, recorded } = fakeCtx()
  // 现场把 sessions 摘掉，模拟命令上下文与 sessions 服务都取不到会话
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? undefined : originalGet(name))
  plugin.apply(ctx, {})
  const cmd = recorded.commands.find((c) => c.name === 'ctx')
  const result = await cmd.handler({ commandId: 'c2', agent: undefined, rawInput: '', attachments: [] })
  assert.equal(result.kind, 'error', '拿不到会话应返回 error 结果')
  assert.ok(result.text.includes('context_radar'), '应提示改用工具')
})
