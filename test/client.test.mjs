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
function loadClient({ documentStub } = {}) {
  const source = fs.readFileSync(clientPath, 'utf8')
  const calls = []
  const fakeWindow = {
    __ModuleLoader__: {
      load: (payload) => calls.push(payload),
    },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const doc = documentStub || { addEventListener: () => {}, removeEventListener: () => {} }
  // 用 Function 求值：不经过 ESM 解析，等价于浏览器里作为脚本执行
  const run = new Function('window', 'document', 'fetch', source)
  run(fakeWindow, doc, () => {
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
    // 真实客户端 ctx 上 `slots` 是服务属性（better-sidebar 就用 ctx.slots.register）；
    // `get('slots')` 是备用路径。两条都给，确保实现走哪条都成立。
    slots: withSlots ? slots : undefined,
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
  // 槽服务由这个模块提供；不声明就可能在本模块 apply 时还没挂载
  const inject = pkg.dsh.client.inject || []
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    `dsh.client.inject 必须含 @deepseek-ai/dsh-client-ui-slots，实际 ${JSON.stringify(inject)}`,
  )
})

test('导出的 inject 必须含 "slots"（漏了 cordis 会在服务还没挂载时就调 apply → 面板静默消失）', () => {
  const calls = loadClient()
  const mod = calls[0].factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`未预期的 require: ${name}`)
  })
  assert.ok(Array.isArray(mod.inject), 'inject 应当是数组')
  assert.ok(mod.inject.includes('slots'), `inject 必须含 "slots"，实际 ${JSON.stringify(mod.inject)}`)
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

/**
 * 回归测试：面板曾经是「插槽内 position:fixed + inset:0 + zIndex:2147483000」，
 * 实机只露出卡片首行、下面整块被会话内容压住 —— 因为徽标挂在
 * `conversation.session.header.actions` 这条很窄的头部条里，祖先的
 * `overflow:hidden` 会裁掉 fixed 子元素，祖先的层叠上下文又会把超大 zIndex 关在里面。
 *
 * 正确解法是原生 `<dialog>` + `showModal()`：它进浏览器 **top layer**，
 * 不参与任何祖先的层叠上下文，也不被祖先 overflow 裁切。
 * 这条测试就是防退回：谁要是把手写 overlay 加回 fixed + 大 zIndex，这里立刻红。
 */
test('面板必须进 top layer（<dialog> + showModal），不许回到插槽内 fixed + 超大 zIndex', () => {
  const source = fs.readFileSync(clientPath, 'utf8')
  assert.match(source, /return h\(\s*'dialog',/, '面板根节点必须是 <dialog>')
  assert.match(source, /showModal\s*\(/, '必须调用 dialog.showModal() 才能进 top layer')
  assert.match(source, /::backdrop/, 'dim 背景要靠 ::backdrop（内联 style 设不了伪元素）')
  assert.doesNotMatch(
    source,
    /zIndex:\s*2147483000/,
    '不要用超大 zIndex 硬压 —— 它在祖先层叠上下文内部无效，会被会话内容盖住',
  )
})

// ---------------------------------------------------------------------------
// 行为测试：上面那条只断言源码里有字符串，删掉 onCancel 也照样能过。
// 下面这组**真的执行组件**，把 showModal / close / Esc / 无数据文案 钉死。
// ---------------------------------------------------------------------------

/**
 * 能真正「渲染」的假 React：createElement 返回可遍历的树，useEffect 把回调收进数组。
 * 第一次 useState 是 RadarBadge 的 `open`，让它为 true 才能把面板渲染出来。
 */
function fakeReactForRender() {
  const effects = []
  let stateCalls = 0
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined),
    }),
    useState: (initial) => {
      const n = stateCalls++
      const value = n === 0 ? true : typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect: (fn) => {
      effects.push(fn)
    },
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    __effects: effects,
  }
}

/** 取树里所有文本（用于断言文案）。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (!node || !node.children) return ''
  return node.children.map(textOf).join('')
}

/** 用给定的假 React 与假 document 加载 client.js，并拿回注册进插槽的组件。 */
function mountBadge() {
  const React = fakeReactForRender()
  const listeners = []
  const documentStub = {
    addEventListener: (type, fn, options) => listeners.push({ type, fn, options }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  const calls = loadClient({ documentStub })
  const mod = calls[0].factory((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require: ${name}`)
  })
  const { ctx, recorded } = fakeCtx()
  mod.apply(ctx)
  return { React, component: recorded.registered[0].component, listeners }
}

/** 把面板单独渲染出来，返回它的 dialog 树、effect 列表与 spy。 */
function renderPanel({ data = null, error = 'HTTP 401', loading = false } = {}) {
  const { React, component, listeners } = mountBadge()
  const badgeTree = component()
  const panelEl = badgeTree.children.find((child) => typeof child.type === 'function')
  assert.ok(panelEl, '打开状态下必须渲染出面板组件')

  const onCloseCalls = []
  const onClose = () => onCloseCalls.push(true)
  const before = React.__effects.length
  const dialogTree = panelEl.type({ state: { loading, data, error }, onClose })
  const effects = React.__effects.slice(before)

  return { dialogTree, effects, onClose, onCloseCalls, listeners }
}

/** 假 dialog 元素：记录 showModal / close 是否被调用。 */
function makeFakeDialog() {
  return {
    open: false,
    style: {},
    showModalCalls: 0,
    closeCalls: 0,
    showModal() {
      this.showModalCalls += 1
      this.open = true
    },
    close() {
      this.closeCalls += 1
      this.open = false
    },
    setAttribute() {
      this.open = true
    },
  }
}

test('行为：面板根节点是 dialog，且 style 里不许有内联 display（否则未打开就挡住整页）', () => {
  const { dialogTree } = renderPanel()
  assert.equal(dialogTree.type, 'dialog')
  assert.equal(dialogTree.props.role, 'dialog')
  assert.equal(
    dialogTree.props.style.display,
    undefined,
    '内联 display 会盖掉 UA 的 dialog:not([open]){display:none} → 未打开时以全屏透明层吃掉点击',
  )
  assert.equal(typeof dialogTree.props.onCancel, 'function', '必须处理原生 Esc(cancel)')
})

test('行为：挂载时调用 showModal()，卸载时 close()', () => {
  const { dialogTree, effects } = renderPanel()
  const fakeDialog = makeFakeDialog()
  dialogTree.props.ref.current = fakeDialog

  const cleanup = effects[0]()
  assert.equal(fakeDialog.showModalCalls, 1, '必须调用 showModal() 才能进 top layer')
  assert.equal(fakeDialog.open, true)

  assert.equal(typeof cleanup, 'function', 'showModal 成功后要返回清理函数')
  cleanup()
  assert.equal(fakeDialog.closeCalls, 1, '卸载时必须 close()')
  assert.equal(fakeDialog.open, false)
})

test('行为：onCancel 拦掉原生 Esc —— preventDefault + onClose 都要发生', () => {
  const { dialogTree, onCloseCalls } = renderPanel()
  let prevented = 0
  dialogTree.props.onCancel({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1, '不 preventDefault 的话 dialog 会被原生关掉，而 React 的 open 仍是 true → 再点徽标没反应')
  assert.equal(onCloseCalls.length, 1, '必须走 onClose 让状态和 DOM 一起收')
})

test('行为：Esc 只在面板打开时被拦截，且会 preventDefault + stopPropagation', () => {
  const { dialogTree, effects, onCloseCalls, listeners } = renderPanel()
  const fakeDialog = makeFakeDialog()
  dialogTree.props.ref.current = fakeDialog

  const dispose = effects[1]() // 第二个 effect 是 keydown 监听
  const entry = listeners.find((l) => l.type === 'keydown')
  assert.ok(entry, '必须注册 keydown')
  assert.equal(entry.options, true, '要用 capture 阶段，否则抢不过宿主的全局快捷键')

  // 面板没开：不许拦，DSH 全局 Esc 得照常工作
  fakeDialog.open = false
  let prevented = 0
  let stopped = 0
  entry.fn({ key: 'Escape', preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
  assert.equal(onCloseCalls.length, 0, '面板没开时不该关任何东西')
  assert.equal(prevented, 0)

  // 面板开着：拦下来并关掉
  fakeDialog.open = true
  entry.fn({ key: 'Escape', preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
  assert.equal(onCloseCalls.length, 1)
  assert.equal(prevented, 1)
  assert.equal(stopped, 1, '不 stopPropagation 的话宿主也会收到这次 Esc')

  if (typeof dispose === 'function') dispose()
})

test('行为：没有数据时不许显示成「健康」（接口失败不能被当成绿灯）', () => {
  const { dialogTree } = renderPanel({ data: null, error: '接口需要登录态（HTTP 401）' })
  const text = textOf(dialogTree)
  assert.match(text, /未知/, '没有判定时必须说「未知」')
  assert.doesNotMatch(text, /🟢|健康/, '没有数据时不许出现「健康」/绿灯')
  assert.match(text, /读取失败/, '错误原因要显示出来')
})

test('行为：有数据时才显示等级，且遮罩用 DSH 主题 token', () => {
  const data = {
    ok: true,
    window: { contextTokens: 100000, pressureTokens: 26000, ratio: 0.26, remaining: 74000 },
    scoring: { level: 'ok', score: 26 },
    items: [{ kind: 'tool', label: 'read', tokens: 1200, pctOfUsed: 0.1, pctOfWindow: 0.012 }],
    suggestions: [],
    alerts: [],
  }
  const { dialogTree } = renderPanel({ data, error: null })
  const text = textOf(dialogTree)
  assert.match(text, /健康/)
  assert.match(text, /风险分 26\/100/)

  const styleNode = dialogTree.children.find((child) => child.type === 'style')
  assert.ok(styleNode, '遮罩样式必须由 <style> 子节点提供（内联 style 设不了 ::backdrop）')
  const css = textOf(styleNode)
  assert.match(css, /::backdrop/)
  assert.match(css, /--dsw-alias-bg-mask-1/, '遮罩要用 DSH 的 token，别硬编码 —— 否则亮色主题比全站弹窗暗一倍')
})
