/**
 * 客户端半身的接线测试。
 *
 * 这类前端模块最阴的地方是**错了也不报错** —— 注册不进插槽、或者 id 不匹配，
 * 页面就是安安静静什么都不多一个。所以这里把 ABI 的每一步都钉死：
 *   ① `window.__ModuleLoader__.load({ id, factory })` 被调用，且 id === 包名；
 *   ② factory(require) 返回 `{ apply, inject }`；
 *   ③ apply(ctx) 往 `conversation.session.header.actions` 注册了组件；
 *   ④ 拿不到 slots 服务时**不抛异常**（面板是可选能力，不能把前端搞挂）。
 *
 * 跑：`node test/client.test.mjs`
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const clientPath = path.join(root, 'lib', 'client.js')
const pkgPath = path.join(root, 'package.json')

/** 假的 React —— 组件不会被真正渲染，只要有这几个钩子即可。 */
function fakeReact() {
  const noop = () => null
  return {
    createElement: noop,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
}

/** 加载 client.js（它是经典脚本，靠 window 全局），返回捕获到的 load 调用。 */
function loadClient() {
  const source = fs.readFileSync(clientPath, 'utf8')
  const calls = []
  const fakeWindow = {
    __ModuleLoader__: {
      load: (payload) => calls.push(payload),
    },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  // 用 Function 求值：不经过 ESM 解析，等价于浏览器里作为脚本执行
  const run = new Function('window', 'document', 'fetch', source)
  run(fakeWindow, { addEventListener: () => {}, removeEventListener: () => {} }, () => {
    throw new Error('测试里不该真的发请求')
  })
  return calls
}

/** 造一个记录注册动作的假 ctx。 */
function fakeCtx({ withSlots = true } = {}) {
  const recorded = { registered: [], effects: 0, injected: [] }
  const slots = {
    register: (options, component) => {
      recorded.registered.push({ options, component })
      return () => {}
    },
    inject: (name, factory) => {
      recorded.injected.push(name)
      return factory()
    },
  }
  const ctx = {
    get: (name) => (name === 'slots' && withSlots ? slots : undefined),
    effect: (fn) => {
      recorded.effects += 1
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
      return () => {}
    },
  }
  return { ctx, recorded }
}

test('包声明：dsh.client 与 exports["./client"] 都在（缺一个加载器就报错）', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.ok(pkg.dsh.client !== undefined, '必须声明 dsh.client，否则宿主不会扫描这个包')
  assert.equal(pkg.dsh.client.platform, 'web', 'platform 必须是字符串 web')
  // 加载器原话：`declares dsh.client but exports no "./client" bundle`
  assert.equal(pkg.exports['./client'], './lib/client.js', 'exports["./client"] 必须指向真实文件')
  assert.ok(fs.existsSync(path.join(root, 'lib', 'client.js')), '客户端文件必须存在')
})

test('ABI：window.__ModuleLoader__.load 被调用一次，且 id 等于包名', () => {
  const calls = loadClient()
  assert.equal(calls.length, 1, '应当只 load 一次')
  assert.equal(calls[0].id, 'dsh-context-radar', 'id 必须等于包名，否则加载器报 loaded without registering')
  assert.equal(typeof calls[0].factory, 'function', 'factory 必须是函数')
})

test('factory 返回 { apply, inject }，且 apply 是函数', () => {
  const calls = loadClient()
  const mod = calls[0].factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`未预期的 require: ${name}`)
  })
  assert.equal(typeof mod.apply, 'function', '客户端插件就是 cordis 插件：必须有 apply')
  assert.ok(Array.isArray(mod.inject), 'inject 应当是数组')
})

test('apply 往会话头部插槽注册了徽标组件', () => {
  const calls = loadClient()
  const mod = calls[0].factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`未预期的 require: ${name}`)
  })
  const { ctx, recorded } = fakeCtx()
  mod.apply(ctx)
  assert.equal(recorded.registered.length, 1, `应当注册 1 个组件，实际 ${recorded.registered.length}`)
  const entry = recorded.registered[0]
  assert.equal(entry.options.name, 'conversation.session.header.actions', '槽名写错就挂不到会话头部')
  assert.equal(typeof entry.component, 'function', '组件必须是函数')
  assert.equal(typeof entry.options.id, 'string')
  assert.ok(entry.options.id.length > 0, '插槽条目必须有唯一 id')
})

test('拿不到 slots 服务时安静退出，不抛异常（面板是可选能力）', () => {
  const calls = loadClient()
  const mod = calls[0].factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`未预期的 require: ${name}`)
  })
  const { ctx, recorded } = fakeCtx({ withSlots: false })
  assert.doesNotThrow(() => mod.apply(ctx), '插槽服务缺失时绝不能抛 —— 会把整个前端搞挂')
  assert.equal(recorded.registered.length, 0)
})

test('客户端只依赖 react（不多要任何 @deepseek-ai 包，link 安装才不会解析失败）', () => {
  const source = fs.readFileSync(clientPath, 'utf8')
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const unique = [...new Set(required)]
  assert.deepEqual(unique, ['react'], `客户端只应 require react，实际 ${unique.join(', ')}`)
})
