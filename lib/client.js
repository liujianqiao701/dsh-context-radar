/**
 * 客户端（浏览器）半身：在会话头部挂一个占用率徽标，点开就是「上下文雷达」面板。
 *
 * ⚠️ 这个文件是 DSH 前端模块 ABI 的产物，**不是普通 ES 模块**：
 *   `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 返回 `{ apply, inject }`，
 *   `apply(ctx)` 里用 `ctx.get('slots')` 往具名插槽注册组件。
 *   `id` 必须与包名一致 —— 加载器会校验「loaded without registering "<id>"」。
 *
 * ⚠️ 故意**不引入构建步骤**：没有 JSX、没有 TS、没有 import，只用 `React.createElement`。
 *   参考实现（dsh-cost-meter / dsh-better-sidebar）都是 esbuild 预打包的 260KB~1.3MB 产物，
 *   但它们打包的源码本身也是这个 ABI；手写纯 JS 一样能被加载，还省掉一层构建。
 *
 * 数据来源：宿主半身注册的 `/api/dsh-context-radar/report`（同源 fetch，带登录态）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-radar',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /**
     * 生命周期自检（只读探测点）。
     * 这个插件最难的故障形态是「**没徽标、也没报错**」——注册被静默跳过时无从下手，
     * 所以在 DevTools 里留一个 `window.__contextRadar` 看它走到哪一步了：
     *   factoryRan   工厂跑过没有（模块加载成功 = true）
     *   applyCalled  cordis 调过 apply 没有（false = inject 没满足）
     *   slotsType    apply 里拿到的 slots 是什么（'object' 才正常）
     *   registered   真正注册进插槽了没有
     */
    const DEBUG = (window.__contextRadar = window.__contextRadar || {
      factoryRan: false,
      applyCalled: false,
      slotsType: 'not-reached',
      registered: false,
      error: null,
    })
    DEBUG.factoryRan = true

    const ENDPOINT = '/api/dsh-context-radar/report'
    const REFRESH_MS = 30000
    // 面板根节点是原生 <dialog>，靠 showModal() 进 top layer（见 RadarPanel 里的注释）。
    const DIALOG_CLASS = 'dsh-context-radar-dialog'

    const LEVEL_COLOR = { ok: '#22c55e', warn: '#eab308', high: '#f97316', critical: '#ef4444' }
    const LEVEL_EMOJI = { ok: '🟢', warn: '🟡', high: '🟠', critical: '🔴' }
    const LEVEL_TEXT = { ok: '健康', warn: '注意', high: '偏高', critical: '高危' }
    // 没有数据时的中性色。**不能**回落到 LEVEL_COLOR.ok —— 那会让接口 401 / 没有可用会话时
    // 照样显示「🟢 健康」，比面板打不开还误导。
    const NEUTRAL_COLOR = 'rgba(128,128,128,0.75)'
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

    const num = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '—')
    const pct = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—')

    function useReport() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let cancelled = false
        const timer = window.setInterval(() => {
          if (!cancelled) setTick((n) => n + 1)
        }, REFRESH_MS)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [])
      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            if (res.status === 401 || res.status === 403) {
              throw new Error(`接口需要登录态（HTTP ${res.status}）`)
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            if (cancelled) return
            if (json && json.ok) setState({ loading: false, data: json, error: null })
            else setState({ loading: false, data: null, error: (json && json.error) || '没有可用会话' })
          } catch (error) {
            if (!cancelled) {
              setState({ loading: false, data: null, error: String((error && error.message) || error) })
            }
          }
        }
        load()
        return () => {
          cancelled = true
        }
      }, [tick])
      return state
    }

    // ---- 徽标（会话头部）----------------------------------------------------
    function RadarBadge() {
      const [open, setOpen] = React.useState(false)
      const state = useReport()
      const data = state.data
      // level 为 null = 没有可用判定（接口失败 / 没有会话 / 拿不到窗口）。别当成健康。
      const level = (data && data.scoring && data.scoring.level) || null
      const ratio = data && data.window ? data.window.ratio : null
      const color = level ? (LEVEL_COLOR[level] || LEVEL_COLOR.ok) : NEUTRAL_COLOR
      const emoji = level ? (LEVEL_EMOJI[level] || '📊') : '⚪'
      const label = ratio === null || ratio === undefined ? (state.loading ? '…' : '?') : pct(ratio)
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title: '上下文雷达 —— 点开看谁在吃 token',
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 9px',
              borderRadius: 999,
              border: `1px solid ${color}`,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.4,
              cursor: 'pointer',
              opacity: 0.9,
            },
          },
          h('span', null, emoji),
          h('span', null, label),
        ),
        open ? h(RadarPanel, { state, onClose: () => setOpen(false) }) : null,
      )
    }

    // ---- 面板（覆盖层弹窗）--------------------------------------------------
    function RadarPanel(props) {
      const { state, onClose } = props
      const data = state.data
      const win = (data && data.window) || {}
      const scoring = (data && data.scoring) || {}
      const level = scoring.level || null
      const color = level ? (LEVEL_COLOR[level] || LEVEL_COLOR.ok) : NEUTRAL_COLOR
      // ⚠️ 状态**文字**一律用 CanvasText，等级色只给圆点 / 进度条 / 边框。
      // 实测亮色主题下 Canvas = #fff，而 #22c55e / #eab308 在白底上对比度只有 2.3:1 / 1.9:1，
      // 13px 小字基本糊掉；emoji 本身已经带颜色，文字不必再上色。
      const levelSpan = level
        ? `${LEVEL_EMOJI[level] || ''} ${LEVEL_TEXT[level] || level}（风险分 ${scoring.score ?? '—'}/100）`
        : '⚪ 未知（没有可用数据）'
      const items = (data && data.items) || []
      const suggestions = (data && data.suggestions) || []
      const alerts = (data && data.alerts) || []
      const top = items.slice(0, 15)

      const dlgRef = React.useRef(null)
      /**
       * 把面板送进浏览器 **top layer**。
       *
       * ⚠️ 为什么必须这样（实测踩过）：徽标挂在 `conversation.session.header.actions`，
       * 那是会话头部里的一小条。面板原本是插槽内一个 `position: fixed; inset: 0` 的 div，
       * 于是被**两件事同时打中**：
       *   ① 祖先若有 `overflow: hidden`（头部条几乎一定有），`fixed` 子元素照样被裁；
       *   ② 祖先若构成层叠上下文（`transform` / `filter` / `contain` / `opacity<1` 都会），
       *      再大的 `zIndex` 也只在**那个上下文内部**排，照样被后面的消息区盖住。
       * 实测症状：只露出发丝般的卡片首行「📊 上下文雷达 🟢 健康（风险分 26/100）」，
       * 下面整块被会话内容压住 —— 看起来像「详情被遮住了」，其实是**被裁掉了**。
       *
       * `showModal()` 把 dialog 提升到 top layer：它**不属于任何祖先的层叠上下文**，
       * 也不受祖先 overflow 裁切。这比 portal 更稳（不用 `react-dom`，测试也钉死了只许
       * require react），也不用往 `document.body` 追加节点（DSH 规范禁止）。
       */
      React.useEffect(() => {
        const dlg = dlgRef.current
        if (!dlg || dlg.open) return undefined
        if (typeof dlg.showModal === 'function') {
          try {
            dlg.showModal()
            return () => {
              try {
                if (dlg.open) dlg.close()
              } catch (error) {
                /* 卸载途中关闭失败无所谓，节点马上就没了 */
              }
            }
          } catch (error) {
            // 别静默：showModal 失败等于退回到「被祖先裁掉」的老症状，
            // 不吭声的话下次排查又得从零开始。记到 window.__contextRadar 里。
            DEBUG.error = `showModal failed: ${String((error && error.message) || error)}`
            if (typeof console !== 'undefined' && console.warn) console.warn('[context-radar]', DEBUG.error)
          }
        }
        // 退化：老引擎没有 showModal 时至少让内容可见，别整块消失。
        try {
          dlg.setAttribute('open', '')
        } catch (error) {
          DEBUG.error = `dialog fallback failed: ${String((error && error.message) || error)}`
        }
        return undefined
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const dlg = dlgRef.current
          // 面板没开着就不要拦 Esc —— DSH 全局 Esc（停止生成 / 关菜单）得照常工作。
          if (!dlg || !dlg.open) return
          // 用 capture 阶段先拿到，并掐断冒泡：否则关面板的同时 DSH 的全局快捷键也会被触发。
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onClose])

      // dialog 本身只当「撑满视口的定位层 + 滚动容器」，底色交给 ::backdrop，
      // 卡片是它里面的一个 div，靠 margin:0 auto 居中。
      // ⚠️ 这里**绝对不能**写内联 `display` —— UA 的 `dialog:not([open]){display:none}` 是
      // 「未打开就不可见」的唯一保障；一旦内联 display 盖掉它，dialog 在 showModal() 之前
      // 就已经以全屏透明 fixed 层渲染，把下面的页面点击全吃掉（降级分支更会一直挂着）。
      const dialogStyle = {
        position: 'fixed',
        inset: 0,
        margin: 0,
        // 用 100% 而不是 100vw：vw 含滚动条宽度，且默认 content-box 会把 padding
        // 加到 width 外面 → 横向溢出、多出一条横向滚动条。border-box 一起配上才干净。
        width: '100%',
        maxWidth: '100%',
        height: '100%',
        maxHeight: '100%',
        boxSizing: 'border-box',
        padding: '4vh 16px',
        border: '0',
        background: 'transparent',
        color: 'CanvasText',
        overflow: 'auto',
      }
      // ::backdrop 只能用样式表命中，内联 style 设不了。
      // 用 DSH 自己的遮罩 token，别硬编码 —— 实测 DSH 的 modal 是 `.24`(亮)/`.5`(暗)，
      // 写死 rgba(0,0,0,.45) 会让我们在亮色主题下比全站弹窗暗近一倍。
      const backdropCss =
        `dialog.${DIALOG_CLASS}::backdrop{` +
        'background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,0.45));' +
        'backdrop-filter:var(--dsw-mask-blur,none);}'
      const card = {
        width: 'min(880px, 96vw)',
        margin: '0 auto',
        maxHeight: '92vh',
        overflow: 'auto',
        borderRadius: 14,
        border: '1px solid rgba(128,128,128,0.35)',
        // ⚠️ 别用主题 CSS 变量配硬编码回退：实测 `--dsw-alias-bg-primary` 根本没定义（回落到 #fff 白底），
        // 而 `--dsw-alias-label-primary` 在暗色主题下解析成 #f9fafb 近白色 —— 白底白字，整个面板看不见。
        // CSS 系统色 Canvas / CanvasText 由 `color-scheme` 决定，**亮暗自动成对**，永远不会错配。
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 18px 50px rgba(0,0,0,0.32)',
        padding: '18px 20px 20px',
        fontSize: 13,
        lineHeight: 1.6,
      }
      const muted = { opacity: 0.65 }

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '📊 上下文雷达'),
        h('span', { style: { color: 'CanvasText', fontWeight: 600 } }, levelSpan),
        h('div', { style: { flex: 1 } }),
        h(
          'button',
          {
            type: 'button',
            onClick: onClose,
            style: {
              border: '1px solid rgba(128,128,128,0.4)',
              background: 'transparent',
              color: 'inherit',
              borderRadius: 8,
              padding: '2px 10px',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          '关闭',
        ),
      )

      let summary = null
      if (win.contextTokens) {
        summary = h(
          'div',
          { style: { margin: '8px 0 14px' } },
          h(
            'div',
            null,
            `已用 ${num(win.pressureTokens ?? win.estimatedTokens)} / ${num(win.contextTokens)} token（${pct(win.ratio)}）`,
            h('span', { style: { ...muted, marginLeft: 8 } }, `余量 ${num(win.remaining)}`),
          ),
          h(
            'div',
            {
              style: {
                marginTop: 6,
                height: 10,
                borderRadius: 999,
                background: 'rgba(128,128,128,0.22)',
                overflow: 'hidden',
              },
            },
            h('div', {
              style: {
                width: `${Math.min(100, (win.ratio || 0) * 100)}%`,
                height: '100%',
                background: color,
                transition: 'width 0.3s ease',
              },
            }),
          ),
        )
      } else {
        summary = h('div', { style: { ...muted, margin: '8px 0 14px' } }, '拿不到模型上下文窗口，只给构成、不给占用率。')
      }

      const rows = top.map((item, index) => {
        const share = typeof item.pctOfUsed === 'number' ? item.pctOfUsed : 0
        return h(
          'div',
          { key: `${item.kind}::${item.label}::${index}`, style: { padding: '4px 0' } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { style: { ...muted, width: 22, textAlign: 'right' } }, index + 1),
            h('span', { style: { width: 92, flexShrink: 0 } }, KIND_LABEL[item.kind] || item.kind),
            h(
              'span',
              {
                style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: item.label,
              },
              item.label,
            ),
            h('span', { style: { width: 78, textAlign: 'right' } }, num(item.tokens)),
            h('span', { style: { width: 56, textAlign: 'right', fontWeight: 600 } }, pct(item.pctOfUsed)),
            h('span', { style: { ...muted, width: 56, textAlign: 'right' } }, pct(item.pctOfWindow)),
          ),
          h(
            'div',
            // 130 = #(22) + gap(8) + 类别(92) + gap(8)，条形图要正好对齐「来源」列。
            { style: { marginLeft: 130, marginTop: 2, height: 5, borderRadius: 999, background: 'rgba(128,128,128,0.18)' } },
            h('div', {
              style: {
                width: `${Math.min(100, share * 100)}%`,
                height: '100%',
                borderRadius: 999,
                background: color,
                opacity: 0.85,
              },
            }),
          ),
        )
      })

      const alertNodes = alerts.map((alert, index) =>
        h(
          'div',
          { key: `alert-${index}`, style: { color: LEVEL_COLOR.critical, marginTop: 2 } },
          `· [${alert.code || '告警'}] ${alert.text || ''}`,
        ),
      )
      const suggestionNodes = suggestions.map((text, index) =>
        h('div', { key: `sug-${index}`, style: { marginTop: 2 } }, `· ${String(text).replace(/\*\*/g, '')}`),
      )

      return h(
        'dialog',
        {
          ref: dlgRef,
          className: DIALOG_CLASS,
          style: dialogStyle,
          // role 显式写出来：① 读屏软件需要；② DSH 在 macOS 上靠
          // `[role=dialog]` 之类属性选择器把元素排除出窗口拖拽区，原生 <dialog> 不在其中。
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '上下文雷达：谁在吃上下文 token',
          onCancel: (event) => {
            // Esc 会被 dialog 原生接管并直接关掉，而 React 的 open 状态还停在 true，
            // 结果「再点徽标没反应」—— 拦下来改走 onClose，让状态和 DOM 一起收。
            event.preventDefault()
            onClose()
          },
          onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
        h('style', null, backdropCss),
        h(
          'div',
          { style: card },
          header,
          state.error
            ? h('div', { style: { color: LEVEL_COLOR.critical, margin: '10px 0' } }, `读取失败：${state.error}`)
            : null,
          summary,
          items.length === 0 && !state.error
            ? h('div', { style: muted }, state.loading ? '正在读取…' : '没有数据')
            : null,
          items.length > 0
            ? h(
                'div',
                { style: { marginBottom: 6, display: 'flex', gap: 8, ...muted, fontSize: 11 } },
                h('span', { style: { width: 22 } }, '#'),
                h('span', { style: { width: 92 } }, '类别'),
                h('span', { style: { flex: 1 } }, '来源'),
                h('span', { style: { width: 78, textAlign: 'right' } }, 'token'),
                h('span', { style: { width: 56, textAlign: 'right' } }, '占已用'),
                h('span', { style: { width: 56, textAlign: 'right' } }, '占窗口'),
              )
            : null,
          rows,
          items.length > 15
            ? h('div', { style: { ...muted, marginTop: 6 } }, `… 另有 ${items.length - 15} 项（完整列表用 /ctx --all）`)
            : null,
          alertNodes.length > 0 ? h('div', { style: { marginTop: 14, fontWeight: 600 } }, '硬告警') : null,
          alertNodes,
          suggestionNodes.length > 0 ? h('div', { style: { marginTop: 14, fontWeight: 600 } }, '建议') : null,
          suggestionNodes,
          h(
            'div',
            { style: { ...muted, marginTop: 14, fontSize: 11 } },
            'token 数为估算（中文按 1 字符 ≈ 1 token，偏保守）；「占已用」看谁最该砍，「占窗口」看还剩多少余量。',
          ),
        ),
      )
    }

    // ---- 注册 ---------------------------------------------------------------
    const SLOT = 'conversation.session.header.actions'

    function apply(ctx) {
      DEBUG.applyCalled = true
      // ⚠️ 这里必须能拿到 `slots` 服务，它由 `@deepseek-ai/dsh-client-ui-slots` 提供。
      // 两件事缺一不可（实测踩过：漏了就**既没徽标也没报错**，页面安安静静）：
      //   ① 本模块导出 `inject: ['slots']` —— cordis 才会等 slots 挂载后再调 apply；
      //   ② package.json 的 `dsh.client.inject` 声明那个 client 模块。
      // 漏 ① 的后果：apply 在服务未挂载时就跑完，`ctx.slots` 取不到 → return → 什么都不发生。
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      DEBUG.slotsType = slots === null ? 'null' : typeof slots
      if (slots === undefined || slots === null) return
      if (typeof slots.register !== 'function') return
      ctx.effect(() => {
        const options = {
          name: SLOT,
          id: 'context-radar-badge',
          order: 40,
          inject: () => ({}),
        }
        // slots.inject 等插槽声明出现后再注册（插槽可能晚于本模块）；返回的是卸载函数。
        const dispose = typeof slots.inject === 'function'
          ? slots.inject(SLOT, () => slots.register(options, RadarBadge))
          : slots.register(options, RadarBadge)
        DEBUG.registered = true
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'context-radar: header badge')
    }

    // `inject` 让 cordis 等 slots 服务挂载后再调 apply —— 这一条漏了整个面板就静默消失。
    return { apply, inject: ['slots'] }
  },
})
