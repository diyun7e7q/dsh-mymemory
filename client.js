/**
 * MyMemory —— 浏览器半侧（手写 bundle）
 *
 * 格式与外壳的模块加载器一致：window.__ModuleLoader__.load({ id, factory })。
 * 基座外无依赖：只用平台 seed 里的 react 与 ctx.slots。
 *
 * 只给使用者看两件事：这是谁（设定），它记住了什么（记忆）。
 * 预算、档位之类的工程参数不进界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mymemory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    /* 顶层声明 inject 会让宿主把 apply 一直挂着等依赖：装配 ctx 的时机早于 slots 就绪，
       实测就是 file-executed 与 factory 都到了、apply 一行没跑。服务一律在 apply 里动态取。 */
    const inject = []
    const API = '/mymemory/api'

    let ui = { open: false, loading: false, saving: false, error: '', notice: '', data: null, cwd: '', skillSeed: null }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try {
          f(snap)
        } catch {
          /* 订阅者自己的错误不该拖垮其它渲染 */
        }
      }
    }
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => {
          subs.delete(f)
        }
      }, [])
      return st
    }

    let capability = ''
    let bootstrap = null
    async function requestAPI(body, token) {
      /* 模型侧卡住时界面必须自己放手：一直转圈比报错更糟。 */
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined
      const res = await fetch(API, {method:'POST',headers:{'content-type':'application/json','x-mymemory-client':'1',...(token ? {'x-mymemory-token':token} : {})},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body),signal})
      let json
      try { json = await res.json() } catch { throw new Error('记忆接口响应无效，请刷新重试') }
      if (!json || json.ok !== true) throw new Error((json && json.error) || 'HTTP '+res.status)
      return json.data
    }
    async function call(body) {
      if (!capability) {
        if (!bootstrap) bootstrap = requestAPI({op:'bootstrap'}).then(data => capability=data.token).finally(()=>bootstrap=null)
        await bootstrap
      }
      try { return await requestAPI(Object.assign({cwd:ui.cwd || ''},body),capability) }
      catch (error) { if(error.message==='SESSION_REQUIRED') capability=''; throw error }
    }

    /** 所有写操作共用：失败把 message 摊到界面上，不静默。 */
    async function run(body, okNotice) {
      setUI({ saving: true, error: '', notice: '' })
      try {
        const data = await call(body)
        setUI({ data, saving: false, notice: okNotice || '' })
        return true
      } catch (error) {
        setUI({ error: String((error && error.message) || error), saving: false })
        return false
      }
    }

    /* 需要读返回值时用这个：run 只报成败，提案要拿到正文才能给人看。 */
    async function runData(body) {
      setUI({ saving: true, error: '', notice: '' })
      try {
        const data = await call(body)
        setUI({ data, saving: false })
        return data
      } catch (error) {
        setUI({ error: String((error && error.message) || error), saving: false })
        return null
      }
    }

    async function refresh() {
      setUI({ loading: true, error: '' })
      try {
        setUI({ data: await call({ op: 'read' }), loading: false })
      } catch (error) {
        setUI({ error: String((error && error.message) || error), loading: false })
      }
    }

    /* 跟随主题的语义色：宿主换明暗，面板跟着变。 */
    const V = {
      fg: 'var(--dsw-alias-label-primary, #1f2328)',
      fg2: 'var(--dsw-alias-label-secondary, #6b7280)',
      line: 'var(--dsw-alias-border-l1, #e5e7eb)',
      line2: 'var(--dsw-alias-border-l2, #d1d5db)',
      bg1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      bg2: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      brand: 'var(--dsw-alias-brand-primary, #2b6cf6)',
    }

    const S = {
      page: {
        maxWidth: '760px',
        color: V.fg,
        fontSize: '13px',
        lineHeight: 1.65,
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      title: { fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' },
      sub: { color: V.fg2, fontSize: '12px' },
      tabs: { display: 'flex', gap: '2px', borderBottom: '1px solid ' + V.line },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: active ? V.fg : V.fg2,
        fontSize: '13px',
        fontFamily: 'inherit',
        padding: '6px 12px',
        cursor: 'pointer',
        borderBottom: '2px solid ' + (active ? V.brand : 'transparent'),
        marginBottom: '-1px',
      }),
      area: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '20px',
        background: V.bg1,
        color: V.fg,
        border: '1px solid ' + V.line2,
        borderRadius: '8px',
        padding: '10px 12px',
        fontSize: '13px',
        lineHeight: 1.7,
        fontFamily: 'ui-monospace, Consolas, monospace',
        resize: 'vertical',
      },
      meta: { display: 'flex', alignItems: 'center', gap: '10px', color: V.fg2, fontSize: '12px' },
      foot: { display: 'flex', alignItems: 'center', gap: '8px' },
      btn: {
        background: V.brand,
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        padding: '5px 14px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      btnGhost: {
        background: 'transparent',
        color: V.fg,
        border: '1px solid ' + V.line2,
        borderRadius: '6px',
        padding: '5px 12px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      btnDanger: {
        background: 'transparent',
        color: '#c0392b',
        border: '1px solid ' + V.line2,
        borderRadius: '6px',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      err: { color: '#c0392b', fontSize: '12px', wordBreak: 'break-word' },
      ok: { color: '#1f7a45', fontSize: '12px' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: {
        border: '1px solid ' + V.line,
        borderRadius: '8px',
        padding: '10px 12px',
        background: V.bg1,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      itemText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      tagRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      tag: {
        fontSize: '11px',
        lineHeight: 1.4,
        padding: '1px 7px',
        borderRadius: '999px',
        background: V.bg2,
        border: '1px solid ' + V.line,
        color: V.fg2,
      },
      chip: (active) => ({
        appearance: 'none',
        border: '1px solid ' + (active ? V.brand : V.line),
        background: active ? V.brand : 'transparent',
        color: active ? '#fff' : V.fg2,
        borderRadius: '999px',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }),
      mask: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.45)',
      },
      card: {
        width: '760px',
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: '86vh',
        overflow: 'auto',
        background: V.bg1,
        color: V.fg,
        border: '1px solid ' + V.line,
        borderRadius: '10px',
        boxShadow: '0 14px 48px rgba(0,0,0,.28)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontSize: '13px',
        lineHeight: 1.65,
        fontFamily: 'inherit',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '13px',
        fontFamily: 'inherit',
        padding: '4px 6px',
        borderRadius: '6px',
      },
    }

    const CATEGORY_LABEL = {
      profile: '画像',
      preference: '偏好',
      constraint: '约束',
      project: '项目',
      episode: '事件',
      experience: '经验',
      recent: '近期',
    }

    /* ——— 展示层 ———
       只留两块用户真正会改的文本：角色设定是我的，记忆概括是你的。
       其余（去重、仲裁、快照、账本）都是引擎的账，收进最底部一个默认收起的折叠里。 */

    const MEMORY_ID = 'dsh-mymemory/panel'
    const MEMORY_KIND = 'mymemory'
    let openCockpit = () => setUI({ open: true })

    /* 单色层次：文字靠主题色 + 透明度分层，边框用中性灰。
       宿主会在明暗两套主题间切，写死 rgba(255,255,255,…) 在浅色主题下会白字白底。 */
    const CX = {
      shell: {
        padding: '24px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: '32px',
        color: V.fg,
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: 1.75,
        boxSizing: 'border-box',
      },
      head: { display: 'flex', alignItems: 'center', gap: '10px' },
      brand: { display: 'flex', alignItems: 'center', gap: '8px', color: V.fg2 },
      brandText: { fontSize: '11px', fontWeight: 500, letterSpacing: '.08em', textTransform: 'uppercase' },
      close: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: V.fg2,
        opacity: 0.55,
        fontSize: '11px',
        letterSpacing: '.06em',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: '2px 0',
      },
      block: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '20px 22px',
        background: 'rgba(127,127,127,.035)',
        border: '1px solid rgba(127,127,127,.12)',
        borderRadius: '2px',
      },
      blockHead: { display: 'flex', alignItems: 'baseline', gap: '10px' },
      eyebrow: { fontSize: '11px', fontWeight: 500, letterSpacing: '.08em', color: V.fg2, opacity: 0.85 },
      hint: { fontSize: '11px', color: V.fg2, opacity: 0.45 },
      body: {
        margin: 0,
        maxWidth: '65ch',
        fontSize: '14px',
        lineHeight: 1.75,
        color: V.fg,
        opacity: 0.88,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        cursor: 'text',
      },
      empty: { margin: 0, maxWidth: '65ch', fontSize: '14px', lineHeight: 1.75, color: V.fg2, opacity: 0.45 },
      editor: {
        display: 'block',
        width: '100%',
        maxWidth: '65ch',
        margin: 0,
        padding: 0,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        resize: 'none',
        overflow: 'hidden',
        color: V.fg,
        opacity: 0.92,
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: 1.75,
      },
      ghost: (show) => ({
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: V.fg2,
        opacity: show ? 0.6 : 0,
        transition: 'opacity .16s ease',
        fontSize: '11px',
        letterSpacing: '.06em',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: 0,
      }),
      saved: (on) => ({
        marginLeft: 'auto',
        fontSize: '11px',
        letterSpacing: '.06em',
        color: V.fg2,
        opacity: on ? 0.7 : 0,
        transition: 'opacity .3s ease',
      }),
      err: { margin: 0, fontSize: '12px', color: '#c0392b', wordBreak: 'break-word' },
      metrics: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' },
      fold: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: V.fg2,
        opacity: 0.45,
        fontSize: '12px',
        letterSpacing: '.06em',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: 0,
        alignSelf: 'flex-start',
      },
      metricList: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 0 0' },
      metricRow: { display: 'flex', alignItems: 'baseline', gap: '12px' },
      metricKey: { fontSize: '11px', letterSpacing: '.06em', color: V.fg2, opacity: 0.55, minWidth: '86px' },
      metricVal: { fontSize: '12px', color: V.fg, opacity: 0.7 },
      badgeWrap: { position: 'relative', display: 'inline-flex' },
      badge: (hot) => ({
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: hot ? V.fg : V.fg2,
        opacity: hot ? 1 : 0.55,
        transition: 'opacity .16s ease, color .16s ease',
        cursor: 'pointer',
      }),
      dot: {
        position: 'absolute',
        top: '4px',
        right: '4px',
        width: '4px',
        height: '4px',
        borderRadius: '50%',
        background: V.fg2,
        opacity: 0.7,
        pointerEvents: 'none',
      },
      scrim: { position: 'fixed', inset: 0, zIndex: 2147482999, background: 'transparent' },
      drawer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 2147483000,
        width: 'min(460px, 96vw)',
        overflow: 'auto',
        background: V.bg1,
        borderLeft: '1px solid rgba(127,127,127,.14)',
        boxShadow: '-24px 0 60px rgba(0,0,0,.18)',
      },
    }

    /* 浮层从窗口最顶端开始就会被系统标题栏压住：Windows 下那一块被最小化与关闭按钮占着，
       结果是面板自己的头部按钮全被盖住，用户只看到一条边。 */
    function chromeInset() {
      try {
        const wco = typeof navigator === 'undefined' ? null : navigator.windowControlsOverlay
        if (wco && wco.visible) {
          const rect = wco.getTitlebarAreaRect()
          if (rect && rect.height > 0) return rect.height
        }
      } catch {
        /* 非 Electron 环境没有这个 API */
      }
      try {
        if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-windows-titlebar')) return 40
      } catch {
        /* 无 document 时当作没有标题栏 */
      }
      return 0
    }

    /** 16px 线性几何图标：无填充、1.5px 描边，跟文字同色。 */
    function Icon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 5.5 }),
        h('path', { d: 'M8 4.9v3.3l2.1 1.4' }),
      )
    }

    /** 一块可以直接在原文上改的设定：默认是段落，点编辑才变成没有边框的文本域。 */
    function DocBlock(props) {
      const st = useUI()
      /* SOUL 走 soul 通道，USER 走 docs：来源不同，取值与保存都要分开。 */
      const data = st.data || {}
      const doc = props.kind === 'soul'
        ? (data.soul ? { text: data.soul.text || '' } : null)
        : (data.docs ? data.docs[props.kind] : null)
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saved, setSaved] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const text = (doc && doc.text) || ''
      if (!doc) return null
      const begin = () => {
        setDraft(text)
        setEditing(true)
      }
      /* 自动保存：失焦或 Cmd/Ctrl+Enter 都走这里；没改动就不发请求。 */
      const commit = async () => {
        if (!editing) return
        const next = draft
        setEditing(false)
        if (next.trim() === text.trim()) return
        const ok = props.kind === 'soul' ? await run({ op: 'soul', text: next }) : await run({ op: 'doc', kind: props.kind, text: next })
        if (!ok) { setEditing(true); return }
        setSaved(true)
        if (typeof setTimeout === 'function') setTimeout(() => setSaved(false), 1500)
      }
      const onKeyDown = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); return }
        if (event.key === 'Escape') setEditing(false)
      }
      const lines = draft ? draft.split('\n').length : 1
      const body = editing
        ? h('textarea', {
            style: CX.editor,
            value: draft,
            rows: Math.max(3, lines),
            spellCheck: false,
            autoFocus: true,
            onKeyDown,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
          })
        : text
          ? h('p', { style: CX.body, onClick: begin }, text)
          : h('p', { style: CX.empty, onClick: begin }, props.placeholder || '还没有内容，点这里开始写。')
      return h(
        'div',
        {
          style: CX.block,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          'div',
          { style: CX.blockHead },
          h('span', { style: CX.eyebrow }, props.eyebrow),
          h('span', { style: CX.hint }, props.hint),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: CX.saved(saved) }, '已保存'),
          h('button', { style: CX.ghost(hover && !editing), onClick: begin, title: '编辑' }, '编辑'),
        ),
        body,
      )
    }

    /** 引擎的账本，默认收着：用户不需要看见去重和快照在跑。 */
    function Metrics(props) {
      const [open, setOpen] = React.useState(false)
      const data = props.data || {}
      const grades = (data.ledger && data.ledger.grades) || {}
      const conflicts = data.conflicts || []
      const skills = data.skillCards || []
      const candidates = skills.filter((c) => c && c.stage === 'candidate').length
      const snapshots = data.snapshots || []
      const rows = [
        ['核心画像', (grades.A || 0) + ' 条'],
        ['常规记忆', (grades.B || 0) + ' 条'],
        ['待确认', (grades.C || 0) + ' 条'],
        ['已失效', (grades.D || 0) + ' 条'],
        ['网关拦截', ((data.ledger && data.ledger.gateInterceptions) || 0) + ' 次'],
        ['冲突待裁', conflicts.length + ' 条'],
        ['技能待审', candidates + ' 张'],
        ['快照', snapshots.length + ' 份'],
      ]
      return h(
        'div',
        { style: CX.metrics },
        h('button', { style: CX.fold, onClick: () => setOpen(!open) }, open ? '收起指标' : '底层指标'),
        open
          ? h(
              'div',
              { style: CX.metricList },
              rows.map((row) =>
                h('div', { key: row[0], style: CX.metricRow }, h('span', { style: CX.metricKey }, row[0]), h('span', { style: CX.metricVal }, row[1])),
              ),
            )
          : null,
      )
    }

    function Cockpit(props) {
      const st = useUI()
      const docs = (st.data && st.data.docs) || {}
      const [proposal, setProposal] = React.useState('')
      React.useEffect(() => {
        if (!ui.data) refresh()
      }, [])
      const closable = Boolean(props && props.onClose)
      return h(
        'div',
        { style: CX.shell },
        h(
          'div',
          { style: CX.head },
          h('div', { style: CX.brand }, h(Icon), h('span', { style: CX.brandText }, '记忆')),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            style: { appearance: 'none', border: '1px solid rgba(127,127,127,.24)', background: 'transparent', color: V.fg2, fontSize: '12px', padding: '3px 10px', borderRadius: '6px', marginRight: '6px', cursor: st.saving ? 'default' : 'pointer', opacity: st.saving ? 0.55 : 1 },
            disabled: Boolean(st.saving),
            title: '用当前记忆重新整理这份概括',
            onClick: () => { runData({ op: 'distill' }).then((data) => { if (data && data.proposal) setProposal(data.proposal) }) },
          }, st.saving ? '整理中…' : '更新'),
          closable ? h('button', { style: CX.close, onClick: props.onClose, title: '关闭' }, '关闭') : null,
        ),
        st.error ? h('p', { style: CX.err }, st.error) : null,
        h(DocBlock, { kind: 'soul', eyebrow: '角色设定', hint: '我的人格，随时可改' }),
        h(DocBlock, { kind: 'user', eyebrow: '记忆概括', hint: '关于你，自动维护', placeholder: '还没有关于你的记忆。' }),
        proposal
          ? h(
              'div',
              { style: CX.block },
              h(
                'div',
                { style: CX.blockHead },
                h('span', { style: CX.eyebrow }, '整理后的样子'),
                h('span', { style: CX.hint }, '点了采用才写进文件'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { style: CX.ghost(true), onClick: () => setProposal('') }, '丢弃'),
                h('button', {
                  style: CX.ghost(true),
                  onClick: () => { runData({ op: 'distill_apply', text: proposal }).then((data) => { if (data) setProposal('') }) },
                }, '采用'),
              ),
              h('p', { style: CX.body }, proposal),
            )
          : null,
        h(Metrics, { data: st.data || {} }),
      )
    }

    /** 顶栏图标：点一下从右侧滑出面板，再点收起。 */
    function MemoryBadge() {
      const st = useUI()
      const [hover, setHover] = React.useState(false)
      const data = st.data || {}
      const conflicts = data.conflicts || []
      const skills = data.skillCards || []
      const pending = conflicts.length + skills.filter((c) => c && c.stage === 'candidate').length
      const toggle = () => setUI({ open: !st.open })
      return h(
        'span',
        { style: CX.badgeWrap },
        h(
          'button',
          {
            style: CX.badge(hover || st.open),
            title: '记忆',
            onClick: toggle,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
          },
          h(Icon),
          pending ? h('span', { style: CX.dot }) : null,
        ),
        st.open ? h('div', { style: CX.scrim, onClick: () => setUI({ open: false }) }) : null,
        st.open ? h('aside', { style: Object.assign({}, CX.drawer, { top: chromeInset() + 'px' }) }, h(Cockpit, { onClose: () => setUI({ open: false }) })) : null,
      )
    }

    function Panel(props) {
      const embedded = props && props.embedded
      return h('div', { style: embedded ? null : { padding: '8px 0' } }, h(Cockpit))
    }

    function apply(ctx) {
      /* 槽名不存在时 register 会抛，逐个兜住：一个失败不该拖垮另外两个。 */
      const guard = (what, fn) => {
        try {
          fn()
        } catch (error) {
          try {
            console.warn('[mymemory] ' + what + ' 注册失败', error)
          } catch {
            /* 控制台不可用时静默 */
          }
        }
      }

      /* 右栏服务缺失时整块跳过：主面板不能因为右栏不在就连带消失。 */
      const mountSidebar = (sub) => {
        /* 主入口是顶栏抽屉：右栏在有些布局里根本不可见，塞进 tab 等于什么都没发生。 */
        openCockpit = () => setUI({ open: true })
        guard('sidebarRightTabs', () =>
          sub.effect(() =>
            sub.sidebarRightTabs.register({
              id: MEMORY_ID,
              kind: MEMORY_KIND,
              priority: 'extension',
              title: () => '记忆',
              guide: [{ id: 'mymemory', order: 60, title: () => '记忆驾驶舱', description: () => '核心画像、待审收件箱、快照与账本' }],
            }),
          ),
        )
        guard('sidebar.right.pane.tab', () =>
          sub.slots.inject('sidebar.right.pane.tab', () =>
            sub.slots.register({ name: 'sidebar.right.pane.tab', key: MEMORY_ID }, Cockpit),
          ),
        )
        guard('conversation.session.header.actions', () =>
          sub.slots.inject('conversation.session.header.actions', () =>
            sub.slots.register({ name: 'conversation.session.header.actions', id: 'mymemory', order: 90 }, MemoryBadge),
          ),
        )
      }
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['slots', 'sidebarRightTabs'], mountSidebar)
      } catch (error) {
        try { console.warn('[mymemory] 右侧栏挂载失败', error) } catch {}
      }

      guard('settings.section', () =>
        ctx.inject(['slots'], (sub) =>
          sub.slots.inject('settings.section', () =>
            sub.slots.register({ name: 'settings.section', id: 'mymemory', order: 60, label: () => 'MyMemory' }, () => h(Panel, { embedded: true })),
          ),
        ),
      )

    }

    exports.name = 'mymemory'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
