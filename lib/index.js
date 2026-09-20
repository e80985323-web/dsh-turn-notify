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
  /**
   * 「你正在看的那个会话」不提醒。
   *
   * 为什么：看得到的东西不用再弹一次。同时开着多个会话时，通知的真正价值
   * 只在**别的**会话上 —— 当前会话的回复就显示在人眼前，再弹一张卡片是纯噪音。
   *
   * 判据必须同时满足三条（窗口聚焦 + 可见 + 会话 id 相同），缺一不可：
   * 只比 sessionId 不够 —— 人切到别的应用后，上报的 sessionId 仍停在最后看的
   * 那个会话，那时他并没有在看，压掉就等于漏报。
   *
   * 取不到当前会话 id 时一律**不抑制**（宁可多弹一条，也不静默吞掉）。
   */
  suppressCurrentSession: true,
  /**
   * 多个会话在这么长时间内先后收尾时，合成一条通知，而不是各弹一张。
   *
   * 为什么：每个会话每轮结束都会通知一次，同时跑 N 个会话就是 N 倍噪音 ——
   * 实测本机 35 分钟 17 条里，多数来自「另外几个会话」，用户看到的就是「一直弹」。
   * 聚合窗口把一阵子里的多条压成一条「N 个会话有新动静」，正文列出各自的
   * 标题和结果，人一眼扫完。
   *
   * 0 = 关闭聚合，恢复逐条弹。
   * 「等你回答 / 等你批准」两类**不进**聚合：它们卡着轮次，延迟等于让人干等。
   */
  digestWindowMs: 2500,
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
   * 模型在等你回答（ask_user_question）时也提醒。
   *
   * 为什么必须单独有一条：ask_user_question 是**阻塞**的 —— 它卡在轮次中间等用户，
   * 那个 turn 直到用户答完才结束，所以 turn/end 在整个等待期间根本不会触发。
   * 只监听 turn/end，就等于「模型问你话」这段时间两条通道全静默 ——
   * 而这恰恰是最该通知的时刻：人去干别的了，不提醒就一直干等着。
   */
  notifyOnQuestion: true,
  /**
   * 模型在等你批准某次操作（沙箱升级/危险工具）时也提醒。
   *
   * 和 notifyOnQuestion 是同一类缺陷：approval/asked 也是**阻塞**的 ——
   * 宿主弹出确认框后整个轮次停在那里，turn/end 不会来。
   * 不提醒的话，人走开了就永远卡在「等你点允许」，而且这类等待最容易发生在
   * 需要放宽权限的操作上（比如写工作区外的文件），本来就更容易被忽略。
   */
  notifyOnApproval: true,
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

/**
 * 从 ask_user_question 的调用参数里取一段能直接读的摘要。
 *
 * 为什么值得单独写：通知正文里最有用的是**问题本身**和**可选答案**，
 * 而不是「模型调用了工具」。人扫一眼就知道要选什么，不用先切回窗口。
 *
 * 参数可能是对象，也可能是 JSON 字符串（取决于事件来源），两种都认；
 * 全都解析不出来时返回空串，由调用方给一句兜底文案 —— 绝不抛异常。
 */
function questionSummary(args) {
  try {
    let parsed = args
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        return parsed.trim()
      }
    }
    if (!parsed || typeof parsed !== 'object') return ''
    const questions = Array.isArray(parsed.questions) ? parsed.questions : []
    if (questions.length === 0) return ''
    const first = questions[0] || {}
    const text = typeof first.question === 'string' ? first.question.trim() : ''
    const options = Array.isArray(first.options)
      ? first.options
        .map((o) => (o && typeof o.label === 'string' ? o.label.trim() : ''))
        .filter((label) => label !== '')
      : []
    const parts = []
    if (text !== '') parts.push(text)
    if (options.length > 0) parts.push(`[${options.join(' / ')}]`)
    // 多问时明说还有几条，否则人会以为只有这一个问题。
    if (questions.length > 1) parts.push(`（共 ${questions.length} 个问题）`)
    return parts.join(' ')
  } catch {
    return ''
  }
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
  /**
   * 通知序号。浏览器端只在 seq **严格变大**时才渲染，所以它必须跨插件重载/重启
   * 保持单调递增。
   *
   * 为什么不能从 0 开始数：页面（没刷新）记着重载前的最后一个 seq。计数器一旦
   * 归零重来，新通知的 seq 全部小于页面记的值，客户端会把它们当「旧的」静默丢掉
   * —— 右下角彻底不出卡片，而宿主日志里每一条都记着「已发出」，看起来一切正常。
   * 实测：热重载插件后触发通知，日志正常、接口正常、卡片不出现。
   *
   * 用时间戳做起点（同毫秒内靠 +1 保证唯一），跨重载天然更大。
   */
  let notifySeq = Date.now()
  /** 每会话的本轮聚合：turn -> 最后一条助手文本。 */
  const turnAggs = new Map()
  /** 每会话标题（session/title 事件）。 */
  const titles = new Map()
  /**
   * 浏览器上报的窗口焦点/可见性/当前会话。
   * 默认按「聚焦」处理：宁可少发系统通知，也不刷屏。
   *
   * sessionId 是页面**当前选中**的会话（DSH 存在 localStorage['dsh.sessions.current']），
   * 用来实现「正在看的那个会话不弹」。取不到时是 null。
   */
  let clientFocus = { focused: true, visible: true, sessionId: null, reportedAt: 0 }
  /** 聚合缓冲：一小段时间内多条通知合成一条。 */
  let digestBuffer = []
  let digestTimer = null
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

  // ── 通知派发 ──────────────────────────────────────────────────────────────

  /**
   * 通知的总入口：先做「该不该发」的取舍，再决定「立刻发」还是「攒一下合成一条」。
   *
   * 三个调用点（turn/end、等你回答、等你批准）都走这里，取舍逻辑只写一遍，
   * 否则三处各写一份、迟早分家。
   *
   * @param bypassInterval 跳过 minIntervalMs 限流，并且**不进聚合缓冲**。
   *   给「等你回答 / 等你批准」用：这两类卡着轮次等人操作，延迟或吞掉的代价
   *   （人一直干等）远大于多发一条。
   */
  function emitNotification(fields) {
    const { sessionId, bypassInterval } = fields

    // 「等你动手」的两类（提问 / 请求批准）不受 suppressCurrentSession 压制。
    //
    // turn/end 是**播报**：回复内容已经显示在人眼前，跳过当前会话是对的 ——
    // 播报的东西就摆在屏幕上，再弹一张卡片是噪音。
    //
    // 但 question / approval 是**待办**，性质完全不同：
    //   1. 「看得到」不等于「注意到了」。人可能在读上面的历史、在另一个窗口，
    //      或者刚切回来还没扫到那一行 —— 而这条通知要的是他**动手**。
    //   2. 漏掉的代价不对称：多弹一张卡片只是多看一眼，漏掉就是一直干等，
    //      而这两类恰恰是唯一会**卡住整个轮次**的等待。
    // 所以即使在当前会话里，它们也照弹。
    const waiting = fields.kind === 'question' || fields.kind === 'approval'

    // 「你正在看的那个会话」不弹。
    //
    // 三条同时成立才算「正在看」：窗口聚焦、页面可见、且这条通知属于当前选中的
    // 会话。只比 sessionId 不够 —— 人切到别的应用后，上报的 sessionId 仍停在
    // 最后看的那个会话，那时他并没有在看，压掉就等于漏报。
    //
    // 页面从没上报过时 sessionId 是 null，`clientFocus.sessionId &&` 自然不成立，
    // 不会误压 —— 宁可多弹一条，也不静默吞掉。
    if (config.suppressCurrentSession
      && !waiting
      && clientFocus.focused
      && clientFocus.visible
      && clientFocus.sessionId
      && sessionId === clientFocus.sessionId) {
      log(`跳过：属于当前正在查看的会话（${sessionId}），人就在这一页上看得到`)
      return
    }

    const windowMs = Math.max(0, Number(config.digestWindowMs) || 0)
    if (bypassInterval || windowMs === 0) {
      // 不聚合：先把缓冲里攒的冲掉，保证先来后到的顺序不乱。
      flushDigest()
      dispatchNotification(fields)
      return
    }

    digestBuffer.push(fields)
    if (digestTimer) clearTimeout(digestTimer)
    digestTimer = setTimeout(flushDigest, windowMs)
  }

  /**
   * 把缓冲里的多条合成一条发出。
   *
   * 只有一条时原样发 —— 合成不该改变「单条通知长什么样」。
   * 多条时正文列成「标题 · 结果」，任何一条失败/异常就把整条标成异常色，
   * 免得一条失败夹在一堆「回复完成」里看不出来。
   */
  function flushDigest() {
    if (digestTimer) {
      clearTimeout(digestTimer)
      digestTimer = null
    }
    if (digestBuffer.length === 0) return
    const items = digestBuffer
    digestBuffer = []

    if (items.length === 1) {
      dispatchNotification(items[0])
      return
    }

    const lines = items.map((it) => `${it.title} · ${it.headline}`)
    dispatchNotification({
      kind: 'digest',
      headline: `${items.length} 个会话有新动静`,
      body: condense(lines.join('；'), Math.max(240, Number(config.maxPreviewChars) || 140)),
      failed: items.some((it) => it.failed),
      // 聚合覆盖多个会话/多个轮次，title/sessionId/turn 一律不指认具体某一个 ——
      // 指认错了比不指认更糟（点进去发现不是那一条）。
      title: `${items.length} 个会话`,
      sessionId: null,
      turn: null,
    })
  }

  /**
   * 真正把一条通知落成事实：记 seq、写日志、发系统通知。
   * 到这里不再判断「该不该发」—— 取舍在 emitNotification 里已经做完了。
   */
  function dispatchNotification(fields) {
    const { kind, headline, body, failed, title, sessionId, turn, bypassInterval } = fields
    notifySeq += 1
    lastNotify = {
      seq: notifySeq,
      turn: Number.isFinite(turn) ? turn : null,
      sessionId,
      title,
      headline,
      preview: body,
      kind,
      failed: !!failed,
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
      return
    }
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
    const throttled = !bypassInterval
      && now - lastOsToastAt < Math.max(0, Number(config.minIntervalMs) || 0)
    if (!shouldFire) {
      lastNotify.osToastSkip = '窗口处于聚焦状态（onlyWhenUnfocused）'
    } else if (throttled) {
      lastNotify.osToastSkip = `限流中（minIntervalMs=${config.minIntervalMs}）`
    } else {
      lastOsToastAt = now
      lastNotify.osToast = fireOsToast(`${title} · ${headline}`, body)
      if (neverReported) lastNotify.osToastReason = '浏览器脚本未上报过焦点（页面可能未刷新），按失焦处理'
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

      // ── 模型在等你回答 ────────────────────────────────────────────────────
      //
      // 这条分支存在的唯一理由：ask_user_question **阻塞在轮次中间**，
      // 那个 turn 要等用户答完才结束，所以整个等待期间不会有 turn/end。
      // 以前只认 turn/end，于是「模型问你话」这段时间右下角什么都不弹 ——
      // 人就去干别的了，回来才发现一直卡着。
      //
      // 用 tool/call 而不是 tool/result：要在**开始等**的那一刻提醒，
      // result 要等用户答完才来，那时候提醒已经没意义了。
      if (event.type === 'tool/call') {
        const call = event.data || {}
        if (call.name !== 'ask_user_question') return
        if (!config.enabled || !config.notifyOnQuestion) return
        if (config.suppressSubagents && isSubagentSession(session)) return
        const summary = questionSummary(call.arguments)
        emitNotification({
          kind: 'question',
          headline: '等待你的选择',
          body: summary !== '' ? condense(summary, config.maxPreviewChars) : '模型提出了一个问题',
          failed: false,
          title: titles.get(sessionId) || 'DSH Desktop',
          sessionId,
          turn: Number(call.turn),
          // 待答问题被限流吞掉 = 人一直干等，代价太大，所以跳过 minIntervalMs。
          bypassInterval: true,
        })
        return
      }

      // ── 模型在等你批准 ────────────────────────────────────────────────────
      //
      // 同「等你回答」：approval/asked 也是阻塞的，等的是用户点「允许」，
      // 期间不会有 turn/end。事件里带 toolName 和 reason，正好够说清「要批准什么」。
      if (event.type === 'approval/asked') {
        const ask = event.data || {}
        if (!config.enabled || !config.notifyOnApproval) return
        if (config.suppressSubagents && isSubagentSession(session)) return
        const tool = typeof ask.toolName === 'string' && ask.toolName !== '' ? ask.toolName : '某次操作'
        const reason = typeof ask.reason === 'string' ? ask.reason.trim() : ''
        emitNotification({
          kind: 'approval',
          headline: '等待你的批准',
          body: reason !== '' ? condense(`${tool}：${reason}`, config.maxPreviewChars) : `${tool} 需要你确认`,
          failed: false,
          title: titles.get(sessionId) || 'DSH Desktop',
          sessionId,
          turn: null,
          // 同样跳过限流：被吞掉就等于人一直干等。
          bypassInterval: true,
        })
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

      emitNotification({ kind, headline, body, failed, title, sessionId, turn })
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
              // 页面当前选中的会话。空串/缺失一律当「不知道」存 null ——
              // 「不知道」和「知道且是空」必须能区分开，否则抑制逻辑会误判。
              sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
                ? parsed.sessionId
                : null,
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
          let payload = {}
          if (req.method === 'PUT' || req.method === 'POST') {
            payload = JSON.parse(await readBody(req) || '{}')
            if (payload && typeof payload.mode === 'string') mode = payload.mode
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
          // 预览「等你回答」卡片：这类卡片不自动消失、颜色也不同，
          // 光看代码看不出来，给一个能当场看到的入口。
          if (mode === 'question') {
            notifySeq += 1
            lastNotify = {
              seq: notifySeq,
              turn: null,
              sessionId: null,
              title: 'DSH Desktop',
              headline: '等待你的选择',
              preview: '这是「模型在等你回答」的预览：它不会自动消失，答完才收起来 [选项甲 / 选项乙]',
              kind: 'question',
              failed: false,
              ts: Date.now(),
            }
            fired.push({ channel: 'inWindow', dispatched: true, seq: notifySeq, kind: 'question' })
          }
          // 自检「当前会话不弹」和「多会话合成一条」。
          //
          // 为什么这两条也要能自检：它们是两条**取舍**逻辑 —— 一条决定「不发」，
          // 一条决定「合起来发」。取舍写错了页面看起来完全正常（就是没弹），
          // 读代码看不出来，只有当场触发一次才知道。这里刻意**直接调
          // emitNotification**，而不是另写一套 mock：走的就是真实派发路径，
          // 自检通过才等于线上那条路通过。
          if (mode === 'sessions') {
            const list = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
            for (const sid of list) {
              emitNotification({
                kind: 'completed',
                headline: '自检轮次',
                body: `来自 ${sid}`,
                failed: false,
                title: sid,
                sessionId: sid,
                turn: null,
              })
            }
            // 说 queued 而不是 dispatched：聚合开着时它们只是进了缓冲，
            // 还没发出去 —— 用 dispatched 就是在谎报。
            fired.push({ channel: 'sessions', queued: list.length, sessionIds: list })
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
