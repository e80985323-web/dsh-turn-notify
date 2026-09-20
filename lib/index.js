/**
 * dsh-turn-notify —— 宿主半边
 *
 * 目标：agent 每轮回复结束后，在屏幕右下角给一个通知。
 * 两条通道，互不依赖：
 *
 *   1. 窗口内卡片（浏览器半边，注入脚本渲染）
 *      `/dsh-turn-notify/last.json` 暴露「最近一轮」的序号与摘要，
 *      注入的 notify.js 轮询它，发现新 seq 就渲染右下角卡片。
 *
 *   2. 系统通知（宿主进程调 Windows）
 *      宿主在 turn/end 当场判断窗口是否失焦（浏览器通过
 *      `/dsh-turn-notify/focus` 上报），失焦就 spawn powershell 弹
 *      WinRT toast —— 这条路不依赖浏览器定时器，窗口最小化被
 *      Chromium 降频也不会延迟。
 *
 * 设计约束：
 *   - 不改 DSH Desktop 的打包产物，纯 profile 插件（与 dsh-whale-widget 同套路）。
 *   - 任何异常都吞掉并记日志，绝不把错误抛回 harness 事件总线。
 *   - 回复正文可能包含引号/换行/emoji/命令注入字符：一律走 JSON 文件传递，
 *     不做任何 shell 字符串拼接。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SCRIPT = join(PACKAGE_ROOT, 'lib', 'notify.js')
const TOAST_SCRIPT = join(PACKAGE_ROOT, 'lib', 'toast.ps1')
const FOCUS_SCRIPT = join(PACKAGE_ROOT, 'lib', 'focus.ps1')

const ROUTE_LAST = '/dsh-turn-notify/last.json'
const ROUTE_FOCUS = '/dsh-turn-notify/focus'
const ROUTE_CONFIG = '/dsh-turn-notify/config.json'
const ROUTE_SCRIPT = '/dsh-turn-notify/notify.js'
const ROUTE_LOGOUT = '/dsh-turn-notify/log.json'
const ROUTE_TEST = '/dsh-turn-notify/test'
const ROUTE_FOCUS_NOW = '/dsh-turn-notify/focus-desktop'

/**
 * 点通知跳回 DSH 用的用户级 URI scheme。
 * 注册在 HKCU\Software\Classes\<scheme>，命令指向 DSH Desktop.exe。
 * 改这个名字会让已注册的旧项失效（旧项需自行删除）。
 */
const FOCUS_SCHEME = 'dsh-turn-notify'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** 缺省设置。文件里只写要覆盖的键，读取时与这里合并。 */
const DEFAULT_CONFIG = {
  /** 总开关。 */
  enabled: true,
  /** 窗口内右下角卡片。 */
  inWindow: true,
  /** 系统通知（Windows 右下角 toast）。 */
  osToast: true,
  /** true = 只在窗口失焦/不可见时才发系统通知；false = 每轮都发。 */
  onlyWhenUnfocused: true,
  /** 屏蔽子代理（spawn/fork 出来的会话）的轮次，只提醒主会话。 */
  suppressSubagents: true,
  /** 系统通知最小间隔，防止多个会话同时收尾时刷屏。 */
  minIntervalMs: 3000,
  /** 窗口内卡片自动消失时间。 */
  durationMs: 6000,
  /** 卡片正文最大字符数。 */
  maxPreviewChars: 140,
  /** 右下角最多同时堆几张卡。 */
  maxCards: 3,
  /** 只在有助手文本时才提醒；false = 纯工具轮/报错轮也提醒。 */
  onlyWithText: false,
  /**
   * 点系统通知能跳回 DSH Desktop。
   *
   * 开 = 注册一个用户级 URI scheme（HKCU\Software\Classes\dsh-turn-notify）指向
   * DSH Desktop.exe，并让 toast 用 activationType="protocol" 激活。点击时 Windows
   * 启动该 exe，exe 撞上单实例锁 → 已有窗口 restore+show+focus。
   *
   * 为什么必须绕这一圈：toast 的 AUMID 只决定「这条通知算谁发的」，不决定「点了
   * 启动谁」。DSH Desktop 的快捷方式带了 AUMID io.dsh.desktop，却没注册
   * ToastActivatorCLSID（COM 激活器），所以普通 toast 点下去什么都不会发生
   * —— 实测：无新进程、窗口不动。
   *
   * 关 = 发普通 toast（点击无反应）。注册表项可用 README 里的一行命令删除。
   */
  clickToFocus: true,
}

/**
 * turn/end 的 reason.kind → 通知标题。
 * 五种 kind 全都在 `dsh-agent-loop` 的 turnEnds 里出现，逐一给出真实说法，
 * 绝不把非 completed 的轮次说成「完成」。
 */
const HEADLINES = {
  completed: '回复完成',
  blocked: '回复被阻塞',
  'max-tokens': '回复达到长度上限',
  aborted: '回复已中止',
  interrupted: '回复被打断',
  error: '回复中断（出错）',
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configPath() {
  return join(dshHome(), '.dsh-turn-notify.json')
}
function logPath() {
  return join(dshHome(), '.dsh-turn-notify.log')
}

/** 折叠空白 + 截断，给通知用的一行摘要。 */
function condense(text, maxChars) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const limit = Math.max(20, Number(maxChars) || DEFAULT_CONFIG.maxPreviewChars)
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/** 从 assistant/message 的内容块里取纯文本。 */
function messageText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 会话是不是子代理（委派深度 > 0，或带父会话）。 */
function isSubagentSession(session) {
  try {
    const header = session && session.header
    if (!header) return false
    if (header.parentSession !== undefined && header.parentSession !== null) return true
    return Number(header.delegationDepth) > 0
  } catch {
    return false
  }
}

const name = 'turn-notify'
const inject = ['webServer']

function apply(ctx) {
  const logLines = []
  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    logLines.push(line)
    if (logLines.length > 200) logLines.shift()
    try {
      writeFileSync(logPath(), `${logLines.join('\n')}\n`, 'utf8')
    } catch { /* 日志写不了就算了，绝不能因此打断 */ }
  }

  // ── 设置 ──────────────────────────────────────────────────────────────────
  let config = { ...DEFAULT_CONFIG }
  try {
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
      if (parsed && typeof parsed === 'object') config = { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch (err) {
    log(`配置读取失败，回落默认值：${err && err.message}`)
  }
  function persistConfig() {
    try {
      mkdirSync(dshHome(), { recursive: true })
      writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      return { ok: true }
    } catch (err) {
      log(`配置写入失败：${err && err.message}`)
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  // ── 运行态 ────────────────────────────────────────────────────────────────
  /** 最近一轮：浏览器轮询 seq 判断「有新的一轮」。 */
  let lastNotify = null
  let notifySeq = 0
  /** 每会话的本轮聚合：turn -> 最后一条助手文本。 */
  const turnAggs = new Map()
  /** 每会话标题（session/title 事件）。 */
  const titles = new Map()
  /** 浏览器上报的窗口焦点/可见性。默认按「聚焦」处理：宁可少发系统通知，也不刷屏。 */
  let clientFocus = { focused: true, visible: true, reportedAt: 0 }
  /** 系统通知限流。 */
  let lastOsToastAt = 0
  /** 记住哪条通道可用，避免每次都白试一遍。 */
  let osToastChannel = null
  /** 最近一次发出的系统通知能不能点击跳回 DSH（逐次事实，不是「通道可用」）。 */
  let osToastClickable = null
  /** 见过的 User-Agent（去重后记日志，用来分辨请求来自哪个外壳）。 */
  let seenUserAgents = new Set()
  /** 「浏览器脚本没在跑」只提醒一次，免得每轮刷屏。 */
  let warnedNoClient = false

  // ── 系统通知 ──────────────────────────────────────────────────────────────
  function fireOsToast(title, body) {
    try {
      const payloadFile = join(tmpdir(), 'dsh-turn-notify-payload.json')
      // PowerShell 5.1 的 ConvertFrom-Json 对无 BOM 的 UTF-8 会按 ANSI 解，
      // 中文会乱码 —— 必须写 BOM。
      writeFileSync(payloadFile, `\uFEFF${JSON.stringify({ title, body })}`, 'utf8')

      const psExe = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'

      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', TOAST_SCRIPT,
        '-PayloadFile', payloadFile,
        '-Scheme', FOCUS_SCHEME,
      ]
      if (config.clickToFocus === false) args.push('-NoProtocol')

      // detached:true 在本机实测会让子进程的 stdout 捕获为空（Node 在 Windows
      // 上把 detached 子进程的管道读端交给了新进程组），于是结果 JSON 拿不到，
      // 日志只会写「结果无法解析」——看着像失败，其实通知已经发出去了。
      // 因此不 detached，只靠 windowsHide + unref 保持不阻塞宿主。
      const child = spawn(psExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })

      let out = ''
      child.stdout.on('data', (chunk) => { out += String(chunk) })
      child.on('error', (err) => log(`系统通知进程启动失败：${err && err.message}`))
      child.on('close', (code) => {
        try {
          const result = JSON.parse(out.trim())
          if (result && result.ok) {
            if (osToastChannel !== result.via) {
              osToastChannel = result.via
              log(`系统通知通道可用：${result.via}`)
            }
            // 「能点击跳回」要单独记：它取决于协议注册是否成功，
            // 跟「哪条 toast 通道可用」是两件事，混为一谈会让人误判。
            const clickable = result.clickToFocus === true
            if (osToastClickable !== clickable) {
              osToastClickable = clickable
              log(clickable
                ? `系统通知可点击跳回（${FOCUS_SCHEME}: → ${result.focusExe || 'DSH Desktop.exe'}）`
                : '系统通知不可点击：协议未注册')
            }
          } else {
            log(`系统通知未送达：${(result && result.error) || out.trim() || '无输出'}`)
          }
        } catch {
          // 区分「进程没输出」和「输出不是 JSON」：前者多半是进程根本没跑起来，
          // 后者才是解析问题。混为一谈会让排障时看不见真因。
          log(`系统通知结果无法解析（exit=${code}）：${out.trim().slice(0, 200) || '<无输出>'}`)
        }
      })
      child.unref()
      return true
    } catch (err) {
      log(`系统通知派发异常：${err && err.message}`)
      return false
    }
  }

  /**
   * 把 DSH Desktop 窗口提到前台（最小化则还原）。
   *
   * 走的是单实例锁：启动 DSH Desktop.exe，新进程发现已有实例便把请求转交过去
   * 然后退出，已有实例 restore+show+focus 自己的窗口。实测约 0.4s 生效，
   * 且不会重载页面（shell 只在 origin 不同时才重载）。
   *
   * 不直接改打包产物、不注册全局热键：纯外部拉起，DSH 升级后依然可用。
   */
  function raiseDesktop(cb) {
    try {
      const psExe = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'

      const child = spawn(
        psExe,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-File', FOCUS_SCRIPT,
          '-Scheme', FOCUS_SCHEME,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )

      let out = ''
      child.stdout.on('data', (chunk) => { out += String(chunk) })
      child.on('error', (err) => {
        log(`跳转进程启动失败：${err && err.message}`)
        if (cb) cb({ ok: false, error: String((err && err.message) || err) })
      })
      child.on('close', () => {
        let parsed = null
        try { parsed = JSON.parse(out.trim()) } catch { /* 无输出或非 JSON */ }
        if (parsed && parsed.ok) log(`已请求跳转 DSH Desktop（${parsed.exe}）`)
        else log(`跳转未生效：${(parsed && parsed.error) || out.trim() || '无输出'}`)
        if (cb) cb(parsed || { ok: false, error: out.trim() || '无输出' })
      })
      child.unref()
      return true
    } catch (err) {
      log(`跳转派发异常：${err && err.message}`)
      if (cb) cb({ ok: false, error: String((err && err.message) || err) })
      return false
    }
  }

  // ── 会话事件 ──────────────────────────────────────────────────────────────
  function handleSessionEvent(session, event) {
    try {
      if (!event || typeof event !== 'object') return
      const sessionId = (session && session.id) || 'default'

      if (event.type === 'session/title') {
        const title = event.data && event.data.title
        if (typeof title === 'string' && title.trim() !== '') titles.set(sessionId, title.trim())
        return
      }

      if (event.type === 'assistant/message') {
        const data = event.data || {}
        const text = messageText(data.message)
        if (text === '') return
        const turn = Number(data.turn)
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          agg = { turn, text }
          turnAggs.set(sessionId, agg)
        } else {
          agg.text = text // 同一轮里后一条助手消息覆盖前一条
        }
        return
      }

      if (event.type !== 'turn/end') return

      const data = event.data || {}
      const turn = Number(data.turn)
      const reason = data.reason || {}
      const kind = typeof reason.kind === 'string' ? reason.kind : 'completed'
      const agg = turnAggs.get(sessionId)
      turnAggs.delete(sessionId)
      const text = agg && agg.turn === turn ? agg.text : ''

      if (!config.enabled) return
      if (config.suppressSubagents && isSubagentSession(session)) return

      const preview = condense(text, config.maxPreviewChars)
      if (config.onlyWithText && preview === '') return

      const title = titles.get(sessionId) || 'DSH Desktop'
      // turn/end 的 reason.kind 有五种（completed/blocked/max-tokens/aborted/error），
      // 除 completed 外都不该说成「完成」—— 那是对状态的谎报。
      const headline = HEADLINES[kind] || HEADLINES.completed
      const abnormal = kind !== 'completed'
      const failed = kind === 'error'
      const body = preview !== ''
        ? preview
        : (abnormal ? '本轮没有输出文本' : '本轮没有文本输出（仅工具调用）')

      notifySeq += 1
      lastNotify = {
        seq: notifySeq,
        turn: Number.isFinite(turn) ? turn : null,
        sessionId,
        title,
        headline,
        preview: body,
        kind,
        failed,
        ts: Date.now(),
        // 这一轮到底有没有发系统通知，逐轮如实记录。
        // 不能复用全局的 osToastChannel（那是「历史上哪条通道成功过」的残留值）——
        // 混在一起会让人把「通道可用」误读成「这一轮发了」。
        osToast: false,
        osToastSkip: null,
      }
      log(`第 ${notifySeq} 条：${headline} / ${title} / ${body.slice(0, 60)}`)

      // 系统通知：宿主自己决定，不依赖浏览器定时器。
      if (!config.osToast) {
        lastNotify.osToastSkip = 'osToast 已关闭'
      } else {
        // 「从没上报过」要单独当成失焦处理。
        //
        // 为什么：notify.js 只在页面里跑；页面若是插件装上之前加载的（没刷新），
        // 注入的 script 根本不存在，于是 reportedAt 永远是 0。此时窗口内卡片
        // 必然也不会出现 —— 也就是说系统通知是**唯一**还能通知到人的通道。
        // 若按「默认聚焦」把它也压掉，整个功能就彻底静默了：没卡片、也没通知，
        // 而日志里只看得到一句「窗口处于聚焦状态」，像是用户自己没切走。
        // 实测本机就是这个状态（reportedAt 连续 45 秒为 0），所以这不是假想。
        //
        // 代价只是页面刚加载、还没上报的那一两秒里可能多发一条冗余通知 ——
        // 比「功能悄悄死掉」划算得多。
        const neverReported = !clientFocus.reportedAt
        const unfocused = neverReported || !clientFocus.focused || !clientFocus.visible
        const shouldFire = config.onlyWhenUnfocused ? unfocused : true
        const now = Date.now()
        if (!shouldFire) {
          lastNotify.osToastSkip = '窗口处于聚焦状态（onlyWhenUnfocused）'
        } else if (now - lastOsToastAt < Math.max(0, Number(config.minIntervalMs) || 0)) {
          lastNotify.osToastSkip = `限流中（minIntervalMs=${config.minIntervalMs}）`
        } else {
          lastOsToastAt = now
          lastNotify.osToast = fireOsToast(`${title} · ${headline}`, body)
          if (neverReported) lastNotify.osToastReason = '浏览器脚本未上报过焦点（页面可能未刷新），按失焦处理'
        }
      }
    } catch (err) {
      log(`会话事件处理异常：${err && err.message}`)
    }
  }

  const disposers = []
  try {
    disposers.push(ctx.on('session/event', (session, event) => handleSessionEvent(session, event)))
    disposers.push(ctx.on('session/disposed', (session) => {
      try {
        if (session && session.id) {
          turnAggs.delete(session.id)
          titles.delete(session.id)
        }
      } catch { /* ignore */ }
    }))
  } catch (err) {
    log(`事件订阅失败：${err && err.message}`)
  }

  // ── HTTP 路由 ─────────────────────────────────────────────────────────────
  function readBody(req, limit = 16384) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function json(res, payload, status = 200) {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  /**
   * 记下见过的 User-Agent（每种只记一次）。
   *
   * 为什么需要：窗口内卡片要知道「我现在是不是就跑在 DSH Desktop 里」，
   * 因为「点击跳转到桌面版」这句话只有在浏览器里打开时才成立。
   *
   * 最初用 URL 上的 dsh-desktop-mode 参数判断，实测不可靠：harness 的 token
   * 鉴权会 303 跳到不带 query 的裸路径，参数到不了页面。UA 不经过这条路。
   */
  function noteUserAgent(req) {
    try {
      const ua = (req && req.headers && req.headers['user-agent']) || ''
      if (!ua || seenUserAgents.has(ua)) return
      seenUserAgents.add(ua)
      const shell = /Electron/i.test(ua) ? 'Electron（DSH Desktop 外壳）' : '浏览器'
      log(`首次见到的 User-Agent（判定为${shell}）：${ua}`)
    } catch { /* ignore */ }
  }

  try {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_LAST,
      handler: (req, res) => {
        try {
          noteUserAgent(req)
          // osToastChannel = 历史上哪条通道成功过（全局事实）；
          // lastNotify.osToast / osToastSkip = 这一轮到底发没发（逐轮事实）；
          // osToastClickable = 最近一次的系统通知能不能点击跳回（逐次事实）。
          // 三者名字必须不同：混用会让人把「通道可用」误读成「这一轮发了」，
          // 或把「能在通知中心看到」误读成「点了会跳回」。
          json(res, lastNotify
            ? { ok: true, ...lastNotify, osToastChannel, osToastClickable, focusScheme: FOCUS_SCHEME }
            : { ok: true, seq: 0, turn: null, sessionId: null, title: null, headline: null, preview: null, kind: null, failed: false, ts: null, osToast: false, osToastSkip: null, osToastChannel, osToastClickable, focusScheme: FOCUS_SCHEME })
        } catch (err) {
          json(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_FOCUS,
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const parsed = JSON.parse(await readBody(req) || '{}')
            clientFocus = {
              focused: parsed.focused !== false,
              visible: parsed.visible !== false,
              reportedAt: Date.now(),
            }
          }
          json(res, { ok: true, ...clientFocus })
          // 页面从没上报过焦点 = 注入脚本没在跑（通常是页面在插件装上之前就加载了）。
          // 这会让窗口内卡片完全不出现，属于「功能看着没了」，所以主动记一条，
          // 别让用户对着空白的右下角猜。
          if (!clientFocus.reportedAt && !warnedNoClient) {
            warnedNoClient = true
            log('注意：浏览器脚本从未上报焦点（页面可能是在插件安装前加载的）。'
              + '窗口内卡片不会出现；系统通知已改为按失焦处理。刷新页面即可恢复两条通道。')
          }
        } catch (err) {
          json(res, { ok: false, error: String((err && err.message) || err) }, 400)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_CONFIG,
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const parsed = JSON.parse(await readBody(req) || '{}')
            if (parsed && typeof parsed === 'object') {
              for (const [key, value] of Object.entries(parsed)) {
                if (Object.hasOwn(DEFAULT_CONFIG, key)) config[key] = value
              }
              const result = persistConfig()
              json(res, { ok: result.ok, config, error: result.error })
              return
            }
          }
          json(res, { ok: true, config, defaults: DEFAULT_CONFIG })
        } catch (err) {
          json(res, { ok: false, error: String((err && err.message) || err) }, 400)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_LOGOUT,
      handler: (req, res) => {
        json(res, { ok: true, lines: logLines.slice(-60) })
      },
    }))

    // 自检入口：POST /dsh-turn-notify/test 立刻走一遍真实派发路径。
    // 存在的理由：系统通知这条路依赖 OS 设置（专注助手/通知开关/AUMID 注册），
    // 失败时是静默的；没有这个入口，用户只能靠「怎么没弹」来猜。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_TEST,
      handler: async (req, res) => {
        try {
          let mode = 'os'
          if (req.method === 'PUT' || req.method === 'POST') {
            const parsed = JSON.parse(await readBody(req) || '{}')
            if (parsed && typeof parsed.mode === 'string') mode = parsed.mode
          }
          const fired = []
          if (mode === 'os' || mode === 'both') {
            // 绕过 onlyWhenUnfocused/限流：这是显式自检，用户就是要现在看到。
            fired.push({ channel: 'os', dispatched: fireOsToast('DSH Desktop · 测试通知', '看到这条说明系统通知通道正常，点它可跳回 DSH 🐳') })
          }
          if (mode === 'inWindow' || mode === 'both') {
            notifySeq += 1
            lastNotify = {
              seq: notifySeq,
              turn: null,
              sessionId: null,
              title: 'DSH Desktop',
              headline: '测试通知',
              preview: '看到这张卡片说明窗口内通知正常',
              kind: 'completed',
              failed: false,
              ts: Date.now(),
            }
            fired.push({ channel: 'inWindow', dispatched: true, seq: notifySeq })
          }
          log(`自检 mode=${mode}`)
          // clickToFocus 是「配置想不想」，osToastClickable 是「上一次实际成没成」。
          // 自检刚派发完，结果还在子进程里，所以这里给的是上一次的事实。
          json(res, { ok: true, mode, fired, osToastChannel, osToastClickable, focusScheme: FOCUS_SCHEME, clickToFocus: config.clickToFocus !== false })
        } catch (err) {
          json(res, { ok: false, error: String((err && err.message) || err) }, 400)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_FOCUS_NOW,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST' && req.method !== 'PUT') {
            json(res, { ok: false, error: 'use POST' }, 405)
            return
          }
          // 异步等结果：调用方（卡片）想知道到底成没成，而不是「已受理」。
          raiseDesktop((result) => {
            try { json(res, { ok: result.ok === true, ...result }) }
            catch { /* 连接可能已断，忽略 */ }
          })
        } catch (err) {
          json(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_SCRIPT,
      handler: (req, res) => {
        try {
          // 每次请求都从磁盘读：改完刷新页面即可生效，不用重启 harness。
          const body = readFileSync(CLIENT_SCRIPT, 'utf8')
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(body)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`notify.js unavailable: ${String((err && err.message) || err)}`)
        }
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string') return html
      if (html.includes(ROUTE_SCRIPT)) return html
      const tag = `<script defer src="${ROUTE_SCRIPT}"></script>`
      if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
      return html + tag
    }))
  } catch (err) {
    log(`路由注册失败：${err && err.message}`)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  })

  log(`已挂载（${Object.keys(config).length} 项设置，toast 脚本 ${existsSync(TOAST_SCRIPT) ? '就绪' : '缺失'}）`)
}

export { name, inject, apply }
