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

    /* 玻璃星空：面板自带底色，不跟宿主题走。
       深空渐变打底，两层星点错开呼吸，三团低透明光晕慢慢漂，卡片浮在上面当磨砂玻璃。
       只用 react，样式全是内联对象——这个 bundle 没有构建步骤，写不了 CSS 文件。 */
    const T = {
      ink: '#F3F7FF',
      ink2: 'rgba(243,247,255,.58)',
      ink3: 'rgba(243,247,255,.34)',
      line: 'rgba(255,255,255,.10)',
      accent: '#9CBBFF',
      font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      glass: 'linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.018))',
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
    const STARS_1 = 'radial-gradient(1.6px 1.6px at 24px 38px,#fff,transparent),radial-gradient(1.2px 1.2px at 132px 96px,rgba(200,220,255,.9),transparent),radial-gradient(1px 1px at 196px 22px,#fff,transparent),radial-gradient(1.4px 1.4px at 74px 168px,rgba(255,255,255,.85),transparent),radial-gradient(1px 1px at 168px 214px,rgba(190,215,255,.8),transparent),radial-gradient(1.2px 1.2px at 244px 142px,#fff,transparent),radial-gradient(.9px .9px at 108px 258px,rgba(255,255,255,.7),transparent),radial-gradient(1.1px 1.1px at 268px 268px,rgba(210,225,255,.75),transparent)'
    const STARS_2 = 'radial-gradient(1.1px 1.1px at 60px 80px,rgba(255,255,255,.9),transparent),radial-gradient(.9px .9px at 210px 40px,rgba(180,210,255,.8),transparent),radial-gradient(1.3px 1.3px at 140px 190px,#fff,transparent),radial-gradient(1px 1px at 32px 230px,rgba(255,255,255,.7),transparent),radial-gradient(.8px .8px at 258px 168px,rgba(200,220,255,.7),transparent)'
    const SKY = 'radial-gradient(560px 460px at -8% -6%,rgba(62,99,255,.30) 0%,transparent 62%),radial-gradient(500px 420px at 112% 10%,rgba(140,92,255,.22) 0%,transparent 60%),radial-gradient(640px 520px at 38% 106%,rgba(34,211,238,.10) 0%,transparent 66%),linear-gradient(180deg,#05070F 0%,#080B1A 55%,#05070F 100%)'

    const CX = {
      drawer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 2147483000,
        width: 'min(460px, 96vw)',
        overflow: 'hidden',
        background: '#05070F',
        borderLeft: '1px solid rgba(255,255,255,.08)',
        boxShadow: '-28px 0 70px rgba(0,0,0,.55)',
        color: T.ink,
        fontFamily: T.font,
        fontSize: '13px',
        lineHeight: 1.5,
      },
      sky: { position: 'absolute', inset: 0, pointerEvents: 'none', background: SKY },
      stars1: { position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 1, backgroundImage: STARS_1, backgroundSize: '300px 300px', backgroundRepeat: 'repeat' },
      stars2: { position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.72, backgroundImage: STARS_2, backgroundSize: '430px 430px', backgroundRepeat: 'repeat' },
      inner: { position: 'relative', zIndex: 1, height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
      shell: { display: 'flex', flexDirection: 'column', padding: '20px 20px 26px', gap: '16px', boxSizing: 'border-box', minHeight: '100%' },
      head: { display: 'flex', alignItems: 'center', gap: '9px' },
      brand: { display: 'flex', alignItems: 'center', gap: '9px', fontSize: '15px', fontWeight: 600, letterSpacing: '-.01em' },
      brandDot: { width: '9px', height: '9px', borderRadius: '50%', background: 'linear-gradient(140deg,#B7CBFF,#8C6BFF)', boxShadow: '0 0 12px rgba(150,175,255,.85)', display: 'inline-block' },
      close: { appearance: 'none', border: 'none', background: 'transparent', color: T.ink3, fontSize: '11.5px', fontFamily: 'inherit', cursor: 'pointer', padding: '2px 0' },
      tabs: { display: 'flex', gap: '2px', padding: '3px', borderRadius: '999px', background: 'rgba(255,255,255,.055)', border: '1px solid rgba(255,255,255,.09)', alignSelf: 'flex-start' },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        background: active ? 'rgba(255,255,255,.15)' : 'transparent',
        color: active ? '#fff' : T.ink2,
        boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,.22)' : 'none',
        fontSize: '12.5px',
        fontFamily: 'inherit',
        padding: '6px 15px',
        borderRadius: '999px',
        cursor: 'pointer',
        transition: 'color .18s ease, background .18s ease',
      }),
      page: { display: 'flex', flexDirection: 'column', gap: '14px' },
      block: {
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
        padding: '18px 20px',
        background: T.glass,
        border: '1px solid rgba(255,255,255,.10)',
        borderRadius: '18px',
        backdropFilter: 'blur(24px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
        boxShadow: '0 12px 42px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.14)',
      },
      blockHead: { display: 'flex', alignItems: 'baseline', gap: '9px' },
      eyebrow: { fontSize: '11px', fontWeight: 600, letterSpacing: '.06em', color: T.ink2 },
      hint: { fontSize: '11px', color: T.ink3 },
      body: { margin: 0, fontSize: '14px', lineHeight: 1.8, color: 'rgba(243,247,255,.88)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text', letterSpacing: '.002em' },
      empty: { margin: 0, fontSize: '14px', lineHeight: 1.8, color: T.ink3 },
      editor: {
        display: 'block',
        width: '100%',
        margin: 0,
        padding: 0,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        resize: 'none',
        overflow: 'hidden',
        color: 'rgba(243,247,255,.95)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: 1.8,
      },
      ghost: (show) => ({
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: T.ink2,
        opacity: show ? 0.85 : 0,
        transition: 'opacity .16s ease, color .16s ease',
        fontSize: '11px',
        letterSpacing: '.06em',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: 0,
      }),
      saved: (on) => ({ marginLeft: 'auto', fontSize: '11px', letterSpacing: '.06em', color: T.ink3, opacity: on ? 0.85 : 0, transition: 'opacity .3s ease' }),
      err: { margin: 0, fontSize: '12px', color: '#FF9A9A', wordBreak: 'break-word' },
      meter: { display: 'flex', alignItems: 'center', gap: '10px' },
      meterTxt: { fontSize: '11px', color: T.ink3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      track: { flex: '1 1 auto', height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,.10)', overflow: 'hidden' },
      fill: { display: 'block', height: '100%', borderRadius: '2px', background: 'linear-gradient(90deg,#6E9BFF,#A98CFF 70%,#C7A9FF)', boxShadow: '0 0 10px rgba(140,160,255,.6)' },
      footRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      link: { appearance: 'none', border: 'none', background: 'transparent', color: 'rgba(243,247,255,.5)', fontSize: '11.5px', fontFamily: 'inherit', cursor: 'pointer', padding: 0 },
      metrics: { display: 'flex', flexDirection: 'column', gap: '10px' },
      fold: { appearance: 'none', border: 'none', background: 'transparent', color: T.ink3, fontSize: '11.5px', fontFamily: 'inherit', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' },
      metricList: { display: 'flex', flexDirection: 'column', gap: '7px', padding: '12px 16px', background: 'rgba(255,255,255,.028)', border: '1px solid rgba(255,255,255,.07)', borderRadius: '14px' },
      metricRow: { display: 'flex', alignItems: 'baseline', gap: '12px' },
      metricKey: { fontSize: '11px', letterSpacing: '.04em', color: T.ink3, minWidth: '78px' },
      metricVal: { fontSize: '11.5px', color: 'rgba(243,247,255,.72)' },
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
        color: hot ? '#fff' : T.ink2,
        opacity: hot ? 1 : 0.55,
        transition: 'opacity .16s ease, color .16s ease',
        cursor: 'pointer',
      }),
      dot: { position: 'absolute', top: '4px', right: '4px', width: '4px', height: '4px', borderRadius: '50%', background: '#8FB4FF', boxShadow: '0 0 6px rgba(143,180,255,.9)', pointerEvents: 'none' },
      scrim: { position: 'fixed', inset: 0, zIndex: 2147482999, background: 'transparent' },
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
            rows: Math.max(4, lines),
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
        h('button', { style: CX.fold, onClick: () => setOpen(!open) }, open ? '收起 ⌃' : '高级 ›'),
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
      const [tab, setTab] = React.useState('summary')
      const [proposal, setProposal] = React.useState('')
      React.useEffect(() => {
        if (!ui.data) refresh()
      }, [])
      const closable = Boolean(props && props.onClose)
      const data = st.data || {}
      /* 常驻块的真实占用：条数与字节都由 panel.ts 现算，不是估算。 */
      const core = data.core || null
      const pct = core ? Math.min(100, Math.round((core.bytes / Math.max(1, core.budget)) * 100)) : 0
      const tabBtn = (key, label) => h('button', { key: key, style: CX.tab(tab === key), onClick: () => setTab(key) }, label)
      return h(
        'div',
        { style: CX.shell },
        h(
          'div',
          { style: CX.head },
          h('div', { style: CX.brand }, h('i', { style: CX.brandDot }), '记忆'),
          h('span', { style: { flex: '1 1 auto' } }),
          closable ? h('button', { style: CX.close, onClick: props.onClose, title: '关闭' }, '关闭') : null,
        ),
        h('nav', { style: CX.tabs }, tabBtn('summary', '概括'), tabBtn('settings', '设定')),
        st.error ? h('p', { style: CX.err }, st.error) : null,
        tab === 'summary'
          ? h(
              'div',
              { style: CX.page },
              h(DocBlock, { kind: 'user', eyebrow: '记忆概括', hint: '关于你，自动维护', placeholder: '还没有关于你的记忆。' }),
              core
                ? h(
                    'div',
                    { style: CX.meter },
                    h('span', { style: CX.meterTxt }, core.count + ' 件事'),
                    h('div', { style: CX.track }, h('i', { style: Object.assign({}, CX.fill, { width: pct + '%' }) })),
                    h('span', { style: CX.meterTxt }, core.bytes + ' / ' + core.budget + ' 字节'),
                  )
                : null,
              h(
                'div',
                { style: CX.footRow },
                h('button', {
                  style: Object.assign({}, CX.link, st.saving ? { opacity: 0.5 } : null),
                  disabled: Boolean(st.saving),
                  title: '用当前记忆重新整理这份概括',
                  onClick: () => { runData({ op: 'distill' }).then((data) => { if (data && data.proposal) setProposal(data.proposal) }) },
                }, st.saving ? '整理中…' : '重新整理'),
              ),
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
            )
          : h(
              'div',
              { style: CX.page },
              h(DocBlock, { kind: 'soul', eyebrow: '人格', hint: '怎么说话，改完下一句生效' }),
              h(Metrics, { data: data }),
            ),
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
        st.open
          ? h(
              'aside',
              { style: Object.assign({}, CX.drawer, { top: chromeInset() + 'px' }) },
              h('div', { style: CX.sky }),
              h('div', { style: CX.stars1 }),
              h('div', { style: CX.stars2 }),
              h('div', { style: CX.inner }, h(Cockpit, { onClose: () => setUI({ open: false }) })),
            )
          : null,
      )
    }

    function Panel(props) {
      const embedded = props && props.embedded
      /* 嵌进设置页时没有抽屉，星星也得有底：自带一块圆角深空，别让白底透上来。 */
      const frame = embedded
        ? { position: 'relative', overflow: 'hidden', borderRadius: '16px', background: '#05070F', color: T.ink, fontFamily: T.font }
        : { position: 'relative', overflow: 'hidden', background: '#05070F', color: T.ink, fontFamily: T.font }
      return h(
        'div',
        { style: frame },
        h('div', { style: CX.sky }),
        h('div', { style: CX.stars1 }),
        h('div', { style: CX.stars2 }),
        h('div', { style: { position: 'relative', zIndex: 1 } }, h(Cockpit)),
      )
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
