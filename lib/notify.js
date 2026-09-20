/**
 * dsh-turn-notify —— 浏览器半边（注入脚本）
 *
 * 由宿主半边的 tapIndex 注入到 index.html：
 *   <script defer src="/dsh-turn-notify/notify.js"></script>
 *
 * 职责只有两件：
 *   1. 上报窗口焦点/可见性（宿主据此决定要不要弹系统通知）
 *   2. 轮询 /dsh-turn-notify/last.json，发现新的一轮就在右下角渲染卡片
 *
 * 刻意不碰 React / 插件系统 / 全局状态：纯 DOM + fetch，插件卸载后
 * 宿主路由消失，脚本自己安静地失效。
 */
;(function () {
  'use strict'

  if (window.__dshTurnNotify) return
  window.__dshTurnNotify = true

  var BASE = '/dsh-turn-notify'
  var POLL_MS = 1000
  var CONFIG_MS = 30000
  var FOCUS_MS = 15000
  var PENDING_TTL_MS = 5 * 60 * 1000

  var config = {
    enabled: true,
    inWindow: true,
    durationMs: 6000,
    maxCards: 3,
  }

  var lastSeq = null
  var pending = null
  var cardSeq = 0

  // ── 右下角容器 ────────────────────────────────────────────────────────────
  var style = document.createElement('style')
  style.setAttribute('data-dsh-turn-notify', '')
  style.textContent = [
    '.dshtn-root{position:fixed;right:16px;bottom:16px;z-index:10050;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;max-width:min(360px,calc(100vw - 32px))}',
    '.dshtn-card{pointer-events:auto;box-sizing:border-box;width:100%;max-width:360px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#111);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:var(--dsw-shadow-lv3,0 6px 24px rgba(0,0,0,.16));font:400 13px/19px var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);cursor:pointer;animation:dshtn-in .18s ease-out}',
    '.dshtn-head{display:flex;align-items:center;gap:6px;margin-bottom:3px}',
    '.dshtn-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-static-green-500,#22c55e)}',
    '.dshtn-card[data-failed="1"] .dshtn-dot{background:var(--dsw-static-amber-600,#dd8629)}',
    '.dshtn-headline{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#111);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshtn-turn{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98);flex:none}',
    '.dshtn-title{font-size:11px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshtn-body{color:var(--dsw-alias-label-secondary,#555);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
    '.dshtn-close{position:absolute;top:6px;right:6px;width:18px;height:18px;border:none;background:transparent;color:var(--dsw-alias-label-caption,#999);cursor:pointer;font-size:13px;line-height:1;padding:0;border-radius:4px}',
    '.dshtn-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
    '@keyframes dshtn-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '@media (prefers-reduced-motion:reduce){.dshtn-card{animation:none}}',
  ].join('')
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.className = 'dshtn-root'
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  root.setAttribute('aria-label', 'DSH 回复通知')
  function mount() {
    if (!root.isConnected && document.body) document.body.appendChild(root)
  }

  /**
   * 避开右下角的鲸鱼挂件（dsh-whale-widget）。它锚定 right/bottom 且尺寸可变，
   * 所以按实测 rect 把我们的卡片堆到它上面；没有挂件就贴 16px。
   */
  function reposition() {
    var base = 16
    try {
      var whale = document.querySelector('.dshwv-img') || document.querySelector('.dshwv-root')
      if (whale) {
        var rect = whale.getBoundingClientRect()
        var viewportH = window.innerHeight || document.documentElement.clientHeight || 800
        var viewportW = window.innerWidth || document.documentElement.clientWidth || 1280
        var anchored = rect.height > 0 && rect.bottom >= viewportH - 40 && rect.right >= viewportW - 40
        if (anchored) {
          var lifted = Math.round(viewportH - rect.top + 8)
          var cap = Math.round(viewportH * 0.6)
          base = Math.max(16, Math.min(lifted, cap))
        }
      }
    } catch (err) { /* 探测失败就用默认位置 */ }
    root.style.bottom = base + 'px'
  }

  function dismiss(card) {
    if (!card || !card.parentNode) return
    card.parentNode.removeChild(card)
  }

  /**
   * 这个页面是不是就跑在 DSH Desktop 桌面版里？
   *
   * 判断的意义在于点击行为要说实话：已经在桌面版里，点卡片再「跳转到桌面版」
   * 是句空话，此时点击只该关掉卡片；只有在普通浏览器里打开这个 GUI 时，
   * 「点通知 → 打开桌面版」才是用户真正想要的动作。
   *
   * 用 User-Agent 判断，不用 URL 参数：桌面版确实会往 URL 上挂
   * dsh-desktop-mode，但 harness 的 token 鉴权会 303 跳到不带 query 的裸路径，
   * 参数到不了页面（实测 location.search 为空）。UA 不经过那条跳转。
   * Electron 外壳的 UA 里必然带 "Electron"（主进程没有覆盖过 UA）。
   */
  function insideDesktopApp() {
    try {
      return /Electron/i.test(navigator.userAgent || '')
    } catch (err) {
      return false
    }
  }

  /** 请求宿主把 DSH Desktop 窗口提到前台（最小化则还原）。 */
  function jumpToDesktop() {
    try {
      return fetch(BASE + '/focus-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
        .then(function (res) { return res.json() })
        .catch(function () { return { ok: false } })
    } catch (err) {
      return Promise.resolve({ ok: false })
    }
  }

  function render(item) {
    mount()
    reposition()
    cardSeq += 1

    var card = document.createElement('div')
    card.className = 'dshtn-card'
    card.style.position = 'relative'
    card.setAttribute('data-failed', item.failed ? '1' : '0')
    card.setAttribute('data-seq', String(item.seq))

    var head = document.createElement('div')
    head.className = 'dshtn-head'
    var dot = document.createElement('span')
    dot.className = 'dshtn-dot'
    var headline = document.createElement('span')
    headline.className = 'dshtn-headline'
    headline.textContent = item.headline || '回复完成'
    head.appendChild(dot)
    head.appendChild(headline)
    if (item.turn !== null && item.turn !== undefined) {
      var turn = document.createElement('span')
      turn.className = 'dshtn-turn'
      turn.textContent = '#' + item.turn
      head.appendChild(turn)
    }
    card.appendChild(head)

    if (item.title) {
      var title = document.createElement('div')
      title.className = 'dshtn-title'
      title.textContent = item.title
      card.appendChild(title)
    }

    var body = document.createElement('div')
    body.className = 'dshtn-body'
    body.textContent = item.preview || ''
    card.appendChild(body)

    var close = document.createElement('button')
    close.className = 'dshtn-close'
    close.type = 'button'
    close.setAttribute('aria-label', '关闭通知')
    close.textContent = '×'
    close.addEventListener('click', function (event) {
      event.stopPropagation()
      dismiss(card)
    })
    card.appendChild(close)

    // 在桌面版里点卡片 = 关闭（跳转是句空话）；在浏览器里打开这个 GUI 时
    // 点卡片 = 把桌面版叫到前台，这才是「点弹窗跳转」的真实用途。
    var canJump = !insideDesktopApp()
    card.setAttribute('data-jump', canJump ? '1' : '0')
    if (canJump) {
      card.setAttribute('title', '点击打开 DSH Desktop')
    }
    card.addEventListener('click', function () {
      if (canJump) jumpToDesktop()
      dismiss(card)
    })

    root.appendChild(card)

    var limit = Math.max(1, Number(config.maxCards) || 3)
    while (root.childNodes.length > limit) root.removeChild(root.firstChild)

    var hold = Math.max(1000, Number(config.durationMs) || 6000)
    setTimeout(function () { dismiss(card) }, hold)
  }

  // ── 上报焦点 ──────────────────────────────────────────────────────────────
  function reportFocus() {
    try {
      fetch(BASE + '/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          focused: document.hasFocus(),
          visible: document.visibilityState !== 'hidden',
        }),
        cache: 'no-store',
        keepalive: true,
      }).catch(function () {})
    } catch (err) { /* ignore */ }
  }

  window.addEventListener('focus', reportFocus)
  window.addEventListener('blur', reportFocus)
  document.addEventListener('visibilitychange', function () {
    reportFocus()
    // 回到窗口时，把「离开期间攒下的那条」补上，别让它永远看不到。
    if (document.visibilityState === 'visible' && pending) {
      if (Date.now() - pending.ts < PENDING_TTL_MS) render(pending)
      pending = null
    }
  })

  // ── 轮询 ──────────────────────────────────────────────────────────────────
  function poll() {
    try {
      fetch(BASE + '/last.json', { cache: 'no-store' })
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (!data || data.ok !== true || typeof data.seq !== 'number') return
          if (lastSeq === null) {
            // 首次拿到数据：只对齐，不重放页面加载前就结束的旧轮次。
            lastSeq = data.seq
            return
          }
          if (data.seq <= lastSeq) return
          lastSeq = data.seq
          if (!config.enabled) return
          var item = {
            seq: data.seq,
            turn: data.turn,
            title: data.title || '',
            headline: data.headline || '回复完成',
            preview: data.preview || '',
            failed: data.failed === true,
            ts: data.ts || Date.now(),
          }
          if (document.visibilityState === 'hidden') {
            // 窗口不可见：用户看的是系统通知，这里先存着，回窗口时再补。
            pending = item
            return
          }
          if (config.inWindow === false) return
          render(item)
        })
        .catch(function () {})
    } catch (err) { /* ignore */ }
  }

  function loadConfig() {
    try {
      fetch(BASE + '/config.json', { cache: 'no-store' })
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (data && data.config) {
            if (typeof data.config.enabled === 'boolean') config.enabled = data.config.enabled
            if (typeof data.config.inWindow === 'boolean') config.inWindow = data.config.inWindow
            if (typeof data.config.durationMs === 'number') config.durationMs = data.config.durationMs
            if (typeof data.config.maxCards === 'number') config.maxCards = data.config.maxCards
          }
        })
        .catch(function () {})
    } catch (err) { /* ignore */ }
  }

  function boot() {
    mount()
    reposition()
    window.addEventListener('resize', reposition)
    loadConfig()
    reportFocus()
    poll()
    setInterval(poll, POLL_MS)
    setInterval(reportFocus, FOCUS_MS)
    setInterval(loadConfig, CONFIG_MS)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
