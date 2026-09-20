/**
 * dsh-turn-notify —— 浏览器半边（notify.js）的 DOM 行为测试
 *
 * 为什么要有这个文件：卡片「会不会自己消失」是这个插件最容易出错的地方，
 * 而它只在浏览器里才成立 —— 宿主半边的测试完全看不到。
 * 具体到这个 bug：普通通知 6 秒后消失是对的，「模型在等你回答」6 秒后消失
 * 就等于没提醒，人回来只剩一个还在转的窗口。
 *
 * 做法：用 jsdom 建一个真窗口，把 **lib/notify.js 原文件** eval 进去，
 * 桩掉 fetch / 定时器 / localStorage，然后推进虚拟时间看 DOM。
 * 测的是真代码真分支，不是复制一份逻辑来测。
 *
 * 关于验证强度（不夸大）：jsdom 不做排版和绘制，所以这里验证的是
 * **DOM 结构与行为**（卡片是否存在、带什么属性、什么时候被移除），
 * 不是像素级外观。外观仍需人在真浏览器里看一眼。
 *
 * 依赖 jsdom（devDependency，插件运行时不需要）。装法：
 *   npm i -D jsdom
 * 或指向任意已装 jsdom 的目录：
 *   JSDOM_HOME=/path/to/dir node scripts/client-test.mjs
 *
 * 找不到 jsdom 时打印 SKIP 并以 0 退出 —— 「这台机器没装 jsdom」
 * 不该被谎报成「代码有问题」。
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, '..', 'lib', 'notify.js')

// ── 找 jsdom ────────────────────────────────────────────────────────────────
async function loadJsdom() {
  // 候选：裸包名（沿脚本所在目录向上找 node_modules，即 npm i -D jsdom 的效果）、
  // JSDOM_HOME 指向的目录、以及从 CWD 解析。
  const tries = ['jsdom']
  if (process.env.JSDOM_HOME) {
    tries.push(join(process.env.JSDOM_HOME, 'node_modules', 'jsdom', 'lib', 'api.js'))
  }
  for (const t of tries) {
    try {
      // Windows 绝对路径必须先转成 file:// URL，否则 import 直接报
      // ERR_UNSUPPORTED_ESM_URL_SCHEME（裸包名不受影响）。
      const spec = /^[a-zA-Z]:[\\/]/.test(t) ? pathToFileURL(t).href : t
      const mod = await import(spec)
      if (mod && mod.JSDOM) return mod.JSDOM
      if (mod && mod.default && mod.default.JSDOM) return mod.default.JSDOM
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const JSDOM = await loadJsdom()
if (!JSDOM) {
  console.log('client-test: SKIP -- 找不到 jsdom，无法做 DOM 行为验证')
  console.log('  装法：npm i -D jsdom')
  console.log('  或：  JSDOM_HOME=<装了 jsdom 的目录> node scripts/client-test.mjs')
  console.log('  （这不是测试失败）')
  process.exit(0)
}

const notifySource = readFileSync(SCRIPT_PATH, 'utf8')

// ── 一个可控的浏览器环境 ────────────────────────────────────────────────────
/**
 * 建环境：真 jsdom 窗口 + 假时钟 + fetch 桩。
 *
 * 假时钟是必需的：真等 7 秒一次、还要跑好几个场景，测试会慢到没人愿意跑。
 * 这里把 window.setTimeout/setInterval 换掉，由 advance() 手动推进。
 */
function createEnv() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:43129/',
    pretendToBeVisual: true,
    // outside-only：给出 window.eval 等脚本能力，但不执行页面里的 <script>。
    // 没有它，window.eval 会在 node 上下文里跑，`window` 直接 ReferenceError。
    runScripts: 'outside-only',
  })
  const { window } = dom

  // 下一次 /last.json 要返回什么（由测试控制）。
  let nextLast = { ok: true, seq: 0, kind: null, headline: null, preview: null, failed: false, turn: null, title: null, sessionId: null, ts: 0 }

  const calls = { last: 0, config: 0, focus: 0 }

  window.fetch = (url) => {
    const u = String(url)
    if (u.includes('last.json')) {
      calls.last++
      return Promise.resolve({ ok: true, json: () => Promise.resolve(nextLast) })
    }
    if (u.includes('config.json')) {
      calls.config++
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, config: {} }) })
    }
    if (u.includes('focus')) {
      calls.focus++
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }

  // 假时钟
  const timers = []
  let tid = 0
  let now = 0
  window.setTimeout = (fn, delay) => {
    const t = { id: ++tid, fn, at: now + (Number(delay) || 0), interval: 0 }
    timers.push(t)
    return t.id
  }
  window.setInterval = (fn, delay) => {
    const t = { id: ++tid, fn, at: now + (Number(delay) || 1), interval: Number(delay) || 1 }
    timers.push(t)
    return t.id
  }
  window.clearTimeout = window.clearInterval = (id) => {
    const i = timers.findIndex((t) => t.id === id)
    if (i >= 0) timers.splice(i, 1)
  }

  window.eval(notifySource)

  return {
    window,
    dom,
    calls,
    /** 下一次 poll 会看到的通知。 */
    setLast(item) {
      nextLast = { ok: true, failed: false, ts: now, ...item }
    },
    /** 推进虚拟时间，逐个触发到期定时器（每个之后放行微任务，让 fetch 的 then 链跑完）。 */
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        if (due.interval) due.at = now + due.interval
        else timers.splice(timers.indexOf(due), 1)
        due.fn()
        await flush()
      }
      now = target
      await flush()
    },
    cards() {
      return Array.from(window.document.querySelectorAll('.dshtn-card'))
    },
  }
}

/** 放行微任务，让 fetch().then().then() 跑完。 */
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`  [OK]   ${label}`)
    pass++
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? '' : `  -> ${detail}`}`)
    fail++
  }
}

/** 起环境 → 对齐基线 → 投递一条通知 → 返回环境。 */
async function deliver(item) {
  const env = createEnv()
  env.setLast({ seq: 0 })
  await env.advance(1200) // 第一次 poll：只对齐基线
  env.setLast({ seq: 1, turn: 3, title: 'DSH Desktop', ...item })
  await env.advance(1200) // 第二次 poll：真正投递
  return env
}

// 两个会话：dismissWaiting 只收同一会话的待办卡片，所以要能区分开。
const S1 = 'session-aaaa-1111'
const S2 = 'session-bbbb-2222'

const QUESTION = {
  kind: 'question',
  headline: '等待你的选择',
  preview: '选哪个方案？ [方案甲 / 方案乙]',
  sessionId: S1,
}
const COMPLETED = {
  kind: 'completed',
  headline: '回复完成',
  preview: '本轮已经做完了',
  sessionId: S1,
}

console.log('client-test: dsh-turn-notify 浏览器半边（jsdom + 虚拟时钟）')
console.log(`  被测脚本: ${SCRIPT_PATH}`)
console.log('  说明：验证 DOM 结构与行为，不含像素级外观')
console.log('')

// ── 1. 「等你回答」卡片该出现，且内容对 ──────────────────────────────────────
console.log('--- 模型在等你回答 ---')
let env = await deliver(QUESTION)
let cards = env.cards()
check('卡片渲染出来了', cards.length === 1, `找到 ${cards.length} 张`)
check('headline = 等待你的选择', cards[0] && cards[0].textContent.includes('等待你的选择'), cards[0] && cards[0].textContent.slice(0, 40))
check('正文含问题摘要', cards[0] && cards[0].textContent.includes('选哪个方案'), cards[0] && cards[0].textContent.slice(0, 60))
check('data-kind="question"', cards[0] && cards[0].getAttribute('data-kind') === 'question', cards[0] && cards[0].getAttribute('data-kind'))
check('挂在右下角容器里', !!env.window.document.querySelector('.dshtn-root .dshtn-card'))
check('带关闭按钮', !!env.window.document.querySelector('.dshtn-card .dshtn-close'))

// ── 2. 核心：过了 durationMs 它必须还在 ─────────────────────────────────────
console.log('\n--- 同一张卡片，推进到 7 秒（durationMs 默认 6000） ---')
await env.advance(7000)
cards = env.cards()
check('「等你回答」卡片不自动消失', cards.length === 1, `找到 ${cards.length} 张（应当是 1）`)

console.log('\n--- 再推进到 60 秒，它仍该在 ---')
await env.advance(53000)
check('等一分钟也还在（不会被别的定时器顺手收掉）', env.cards().length === 1, `找到 ${env.cards().length} 张`)

// ── 3. 对照：普通通知到点就该消失 ───────────────────────────────────────────
//
// 没有这个对照，上面那条「还在」可能只是因为卡片压根没渲染过 —— 假阳性。
console.log('\n--- 对照：普通「回复完成」通知 ---')
env = await deliver(COMPLETED)
check('普通卡片先出现', env.cards().length === 1, `找到 ${env.cards().length} 张`)
check('普通卡片 headline 正确', env.cards()[0].textContent.includes('回复完成'))
check('普通卡片不带 question 标记', env.cards()[0].getAttribute('data-kind') === 'completed', env.cards()[0].getAttribute('data-kind'))
await env.advance(7000)
check('普通卡片到点自动消失', env.cards().length === 0, `找到 ${env.cards().length} 张（应当是 0）`)

// ── 4. 答完之后，那张「等你回答」卡片要被收掉 ───────────────────────────────
//
// 不收掉就是在说谎：人已经答完了，右下角还挂着「等你回答」。
// 但只能收**同一个会话**的 —— 见下面第 5 节的跨会话场景。
console.log('\n--- 同一会话答完之后 ---')
env = await deliver(QUESTION)
check('问题卡片在', env.cards().length === 1, `找到 ${env.cards().length} 张`)
check('卡片记住了自己属于哪个会话', env.cards()[0].getAttribute('data-session') === S1, env.cards()[0].getAttribute('data-session'))
env.setLast({ seq: 2, turn: 3, title: 'DSH Desktop', ...COMPLETED })
await env.advance(1200)
check('问题卡片被收掉', env.cards().length === 1, `找到 ${env.cards().length} 张（应当是 1）`)
check('剩下的是那条普通通知', env.cards()[0] && env.cards()[0].textContent.includes('回复完成'), env.cards()[0] && env.cards()[0].textContent.slice(0, 30))

// ── 5. 跨会话：别的会话收尾，不许顶掉这个会话的待办 ─────────────────────────
//
// 这是这个设计真正要防的事故：A 会话在等用户回答，B 会话同时跑完了。
// 如果 B 的收尾把 A 的卡片顶掉，而人正好在这时看屏幕，就再也看不到 A 在等他了。
console.log('\n--- 别的会话结束时（不该动这张卡片） ---')
env = await deliver(QUESTION)
check('问题卡片在', env.cards().length === 1, `找到 ${env.cards().length} 张`)
env.setLast({ seq: 2, turn: 9, title: 'DSH Desktop', ...COMPLETED, sessionId: S2 })
await env.advance(1200)
const stillThere = env.cards().filter((c) => c.getAttribute('data-kind') === 'question')
check('A 会话的问题卡片仍在', stillThere.length === 1, `找到 ${stillThere.length} 张`)
check('B 会话的完成卡片也照常出现', env.cards().length === 2, `共 ${env.cards().length} 张`)

// sessionId 缺失（聚合条目）时一张都不收：不知道是谁的，就别动。
console.log('\n--- 通知不带 sessionId 时（聚合条目） ---')
env.setLast({ seq: 3, turn: null, title: 'DSH Desktop', kind: 'completed', headline: '回复完成', preview: 'x', sessionId: '' })
await env.advance(1200)
check('不带 sessionId 时问题卡片仍未被收掉', env.cards().filter((c) => c.getAttribute('data-kind') === 'question').length === 1)

// ── 6. 等你批准：同一类「等你动手」，同样不该消失 ───────────────────────────
console.log('\n--- 模型在等你批准 ---')
env = await deliver({ kind: 'approval', headline: '等待你的批准', preview: 'edit：需要写工作区外的文件', sessionId: S1 })
check('批准卡片渲染出来', env.cards().length === 1, `找到 ${env.cards().length} 张`)
check('data-kind="approval"', env.cards()[0] && env.cards()[0].getAttribute('data-kind') === 'approval')
await env.advance(7000)
check('「等你批准」卡片不自动消失', env.cards().length === 1, `找到 ${env.cards().length} 张`)

// ── 7. 窗口不可见时先存着，回到窗口要补上（且问题不过期） ───────────────────
console.log('\n--- 窗口不可见期间来的通知 ---')
env = createEnv()
env.setLast({ seq: 0 })
await env.advance(1200)
// 切成 hidden，投递一条问题
Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, get: () => 'hidden' })
env.setLast({ seq: 1, turn: 3, title: 'DSH Desktop', ...QUESTION })
await env.advance(1200)
check('不可见时不直接渲染', env.cards().length === 0, `找到 ${env.cards().length} 张`)
// 很久之后才回到窗口（远超 PENDING_TTL_MS=5 分钟）
await env.advance(20 * 60 * 1000)
Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, get: () => 'visible' })
env.window.document.dispatchEvent(new env.window.Event('visibilitychange'))
await flush()
check('隔了 20 分钟回窗口仍补上问题卡片', env.cards().length === 1, `找到 ${env.cards().length} 张`)

console.log('')
console.log(`共 ${pass + fail} 项：${pass} 通过, ${fail} 失败`)

if (fail > 0) {
  console.log('client-test: FAIL')
  process.exit(1)
}
console.log('client-test: OK')
