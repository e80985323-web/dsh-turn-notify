/**
 * dsh-turn-notify —— 宿主半边回归测试
 *
 * 测的是**真正要跑的那份代码**：直接 import lib/index.js，调它的 apply()，
 * 喂真实形状的 session 事件，再断言 /last.json 暴露出来的内容。
 * 刻意不复制一份逻辑来测 —— 复制品通过了，线上那份未必。
 *
 * 事件形状取自真实会话记录（sessions/**.jsonl.zstd），不是凭空编的：
 *   tool/call      { turn, step, callId, name, arguments }   arguments 是 JSON 字符串
 *   approval/asked { id, toolName, callId, reason }
 *   turn/end       { turn, reason: { kind } }
 *   assistant/message { turn, message: { content: [{ type: 'text', text }] } }
 *
 * 用法：node scripts/host-test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'lib', 'index.js')

// 用临时 DSH_HOME，免得测试覆盖掉用户真实的配置与日志。
const home = mkdtempSync(join(tmpdir(), 'dsh-tn-test-'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(ENTRY).href)

const routes = new Map()
const listeners = new Map()
const ctx = {
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {}
  },
  effect: (fn) => {
    try {
      fn()
    } catch {
      /* 测试里不需要真的挂资源 */
    }
  },
}

mod.apply(ctx)

/** 读一次 /last.json，模拟宿主调用。 */
function lastJson() {
  let body = null
  routes.get('/dsh-turn-notify/last.json').handler({ headers: {} }, {
    writeHead() {},
    end(s) {
      body = JSON.parse(s)
    },
  })
  return body
}

/** 往 /config.json 写一条设置。 */
function setConfig(patch) {
  const payload = JSON.stringify(patch)
  const req = {
    method: 'POST',
    headers: {},
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(payload, 'utf8'))
      if (event === 'end') fn()
    },
  }
  // 路由处理器是 async 的（readBody 返回 Promise），必须等它落地，
  // 否则下一行就断言会读到还没改的旧配置 —— 那是测试自己的竞态。
  return routes.get('/dsh-turn-notify/config.json').handler(req, { writeHead() {}, end() {} })
}

function emit(session, event) {
  for (const fn of listeners.get('session/event') || []) fn(session, event)
}

/** 模拟浏览器上报焦点与当前会话（notify.js 的 POST /focus）。 */
function reportFocus(patch) {
  const payload = JSON.stringify(patch)
  const req = {
    method: 'POST',
    headers: {},
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(payload, 'utf8'))
      if (event === 'end') fn()
    },
  }
  return routes.get('/dsh-turn-notify/focus').handler(req, { writeHead() {}, end() {} })
}

const session = { id: 'sess-1', header: { delegationDepth: 0 } }
const subagent = { id: 'sub-1', header: { delegationDepth: 1 } }

// 关掉聚合窗口，让通知立刻落地。
// 不关的话 turn/end 会进 digestBuffer 等 2.5 秒，断言就得依赖真实时间 ——
// 那样的测试会时快时慢、偶发失败，而聚合本身不是这里要测的东西。
await setConfig({ digestWindowMs: 0 })

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

/** 真实形状：arguments 是 JSON 字符串，问题与选项都在里面。 */
const QUESTION_ARGS = JSON.stringify({
  questions: [
    {
      id: 'repo_state',
      header: '仓库状态',
      question: 'https://github.com/e80985323-web/dsh-turn-notify 这个仓库现在是空的吗？',
      options: [{ label: '已存在，是空仓库' }, { label: '已存在，有内容' }],
    },
  ],
})

console.log('host-test: dsh-turn-notify 宿主半边')

// ── 1. 模型提问时必须提醒 ────────────────────────────────────────────────────
//
// 这就是本次修的 bug：ask_user_question 阻塞在轮次中间，turn/end 要等用户
// 答完才来，所以只监听 turn/end 的实现，在整个等待期间一声不响。
console.log('\n--- 模型在等你回答 ---')
emit(session, {
  type: 'tool/call',
  data: { turn: 2, step: 5, callId: 'c1', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
let n = lastJson()
console.log(`  headline: ${JSON.stringify(n.headline)}  kind: ${JSON.stringify(n.kind)}`)
console.log(`  preview:  ${JSON.stringify(n.preview)}`)
check('提问触发了通知', typeof n.seq === 'number' && n.seq > 0, `seq=${n.seq}`)
// seq 的起点必须是时间戳量级。从 0 开始数的话，插件热重载后计数归零，
// 而页面记着重载前的大 seq —— 新通知会被客户端当「旧的」全部丢掉，
// 右下角彻底静默，日志却一切正常。实测踩过。
check('seq 起点是时间戳量级（跨重载仍单调）', n.seq > 1e12, String(n.seq))
check('headline = 等待你的选择', n.headline === '等待你的选择', n.headline)
check('kind = question', n.kind === 'question', n.kind)
check('正文含问题原文', n.preview.includes('这个仓库现在是空的吗'), n.preview)
check('正文含选项', n.preview.includes('已存在，是空仓库') && n.preview.includes('已存在，有内容'), n.preview)
check('不谎报为失败', n.failed === false)

// ── 2. 不该提醒的别乱提醒 ────────────────────────────────────────────────────
console.log('\n--- 不该触发的场景 ---')
const beforeOther = lastJson().seq
emit(session, { type: 'tool/call', data: { turn: 2, step: 6, name: 'bash', arguments: '{}' } })
check('普通工具调用不触发', lastJson().seq === beforeOther, `seq=${lastJson().seq}`)

emit(subagent, {
  type: 'tool/call',
  data: { turn: 1, callId: 'c2', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('子代理提问被屏蔽', lastJson().seq === beforeOther, `seq=${lastJson().seq}`)

// ── 3. 等你批准（同类阻塞） ──────────────────────────────────────────────────
console.log('\n--- 模型在等你批准 ---')
emit(session, {
  type: 'approval/asked',
  data: {
    id: 'ap-1',
    toolName: 'edit',
    callId: 'c9',
    reason: 'escalate sandbox to danger-full-access: 需要写工作区外的文件',
  },
})
n = lastJson()
console.log(`  headline: ${JSON.stringify(n.headline)}  kind: ${JSON.stringify(n.kind)}`)
console.log(`  preview:  ${JSON.stringify(n.preview)}`)
check('批准请求触发通知', n.headline === '等待你的批准', n.headline)
check('kind = approval', n.kind === 'approval', n.kind)
check('正文含工具名', n.preview.includes('edit'), n.preview)
check('正文含理由', n.preview.includes('需要写工作区外的文件'), n.preview)

const beforeQ2 = lastJson().seq
emit(session, {
  type: 'tool/call',
  data: { turn: 9, callId: 'c3', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('两种等待可连续各自成条', lastJson().seq === beforeQ2 + 1, `seq=${lastJson().seq}`)

// ── 4. 老功能没被改坏 ────────────────────────────────────────────────────────
console.log('\n--- 答完之后轮次正常结束 ---')
emit(session, {
  type: 'assistant/message',
  data: { turn: 3, message: { content: [{ type: 'text', text: '已经答完了，继续干。' }] } },
})
emit(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
n = lastJson()
console.log(`  headline: ${JSON.stringify(n.headline)}  kind: ${JSON.stringify(n.kind)}`)
check('turn/end 仍然通知', n.headline === '回复完成', n.headline)
check('kind 是 completed', n.kind === 'completed', n.kind)
check('正文是助手原文', n.preview.includes('已经答完了'), n.preview)

emit(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } })
n = lastJson()
check('报错轮仍然如实说“出错”', n.headline === '回复中断（出错）', n.headline)
check('报错轮 failed=true', n.failed === true)

// ── 5. 开关真的能关掉 ────────────────────────────────────────────────────────
console.log('\n--- 设置开关 ---')
await setConfig({ notifyOnQuestion: false })
const beforeOff = lastJson().seq
emit(session, {
  type: 'tool/call',
  data: { turn: 11, callId: 'c4', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('notifyOnQuestion=false 后不再提醒', lastJson().seq === beforeOff, `seq=${lastJson().seq}`)
await setConfig({ notifyOnQuestion: true })
emit(session, {
  type: 'tool/call',
  data: { turn: 12, callId: 'c5', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('改回 true 后恢复提醒', lastJson().seq === beforeOff + 1, `seq=${lastJson().seq}`)

await setConfig({ notifyOnApproval: false })
const beforeOff2 = lastJson().seq
emit(session, { type: 'approval/asked', data: { id: 'ap-2', toolName: 'edit', reason: 'x' } })
check('notifyOnApproval=false 后不再提醒', lastJson().seq === beforeOff2, `seq=${lastJson().seq}`)

await setConfig({ enabled: false })
const beforeOff3 = lastJson().seq
emit(session, {
  type: 'tool/call',
  data: { turn: 13, callId: 'c6', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('总开关 enabled=false 全部静默', lastJson().seq === beforeOff3, `seq=${lastJson().seq}`)

// ── 6. 畸形输入绝不能把插件搞崩 ──────────────────────────────────────────────
console.log('\n--- 畸形输入 ---')
await setConfig({ enabled: true })
const beforeJunk = lastJson().seq
const junk = [
  { type: 'tool/call', data: { name: 'ask_user_question' } },
  { type: 'tool/call', data: { name: 'ask_user_question', arguments: 'not json' } },
  { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[]}' } },
  { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{}]}' } },
  { type: 'approval/asked', data: {} },
  { type: 'turn/end', data: {} },
  { type: 'tool/call', data: null },
  { type: null, data: null },
  {},
]
let threw = null
try {
  for (const ev of junk) emit(session, ev)
} catch (err) {
  threw = err
}
check('畸形事件不抛异常', threw === null, threw && threw.message)
check('畸形事件后插件仍能正常发通知', (() => {
  emit(session, {
    type: 'tool/call',
    data: { turn: 20, callId: 'c7', name: 'ask_user_question', arguments: QUESTION_ARGS },
  })
  return lastJson().seq > beforeJunk
})())

// ── 7. 「人正看着这个会话，模型问他」—— 用户报的就是这个场景 ─────────────────
//
// suppressCurrentSession 会把「当前正在看的会话」的通知压掉。
// 对 turn/end（播报）这是对的：内容就在屏幕上。
// 对 question/approval（待办、卡着整个轮次等人动手）是错的：
// 压掉的结果就是用户盯着屏幕也看不到「轮到你了」，然后一直干等。
console.log('\n--- 人正在看这个会话时 ---')
// 先把开关恢复干净：上一节把 notifyOnApproval 关掉了，
// 不清就会把「测试残留」误读成「代码不提醒」。
await setConfig({ enabled: true, notifyOnQuestion: true, notifyOnApproval: true })
await reportFocus({ focused: true, visible: true, sessionId: 'sess-1' })

const beforeSeen = lastJson().seq
emit(session, {
  type: 'assistant/message',
  data: { turn: 30, message: { content: [{ type: 'text', text: '做完了。' }] } },
})
emit(session, { type: 'turn/end', data: { turn: 30, reason: { kind: 'completed' } } })
check('当前会话的「回复完成」被压掉（这是对的）', lastJson().seq === beforeSeen, `seq=${lastJson().seq}`)

emit(session, {
  type: 'tool/call',
  data: { turn: 31, callId: 'c8', name: 'ask_user_question', arguments: QUESTION_ARGS },
})
check('当前会话的「等你回答」照弹', lastJson().seq === beforeSeen + 1, `seq=${lastJson().seq}`)
check('弹出来的确实是问题', lastJson().headline === '等待你的选择', lastJson().headline)
check('通知带上了 sessionId（客户端靠它决定答完收哪张卡）', lastJson().sessionId === 'sess-1', JSON.stringify(lastJson().sessionId))

emit(session, { type: 'approval/asked', data: { id: 'ap-9', toolName: 'edit', reason: '需要写工作区外的文件' } })
check('当前会话的「等你批准」照弹', lastJson().headline === '等待你的批准', lastJson().headline)

// 别的会话的 turn/end 仍要照常提醒 —— 别为了修上面那条把这条压坏。
const beforeOtherSession = lastJson().seq
const other = { id: 'sess-2', header: { delegationDepth: 0 } }
emit(other, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '另一个会话做完了。' }] } },
})
emit(other, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
check('别的会话的「回复完成」照常提醒', lastJson().seq === beforeOtherSession + 1, `seq=${lastJson().seq}`)

console.log('')
console.log(`共 ${pass + fail} 项：${pass} 通过, ${fail} 失败`)

rmSync(home, { recursive: true, force: true })
if (fail > 0) {
  console.log('host-test: FAIL')
  process.exit(1)
}
console.log('host-test: OK')
