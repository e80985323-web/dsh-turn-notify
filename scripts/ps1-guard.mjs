#!/usr/bin/env node
/**
 * ps1-guard.mjs -- structural guard for the PowerShell half of dsh-turn-notify.
 *
 * WHY THIS EXISTS (a real bug this project already shipped once)
 * -------------------------------------------------------------
 * lib/*.ps1 are executed by Windows PowerShell 5.1, which decodes a BOM-less
 * .ps1 using the system ANSI code page. Two Chinese comment lines were once
 * added to toast.ps1; the multi-byte sequences swallowed the newline that
 * followed them, so the next statement was folded into the comment. The script
 * STILL PARSED. It just silently stopped calling
 * SetAttribute('activationType', 'protocol'), so click-to-focus died while
 * every other check -- sends fine, looks fine, window healthy -- stayed green.
 *
 * So this guard asserts the things that failure mode violates:
 *
 *   1. UTF-8 BOM present      (without it, PS 5.1 uses the ANSI code page)
 *   2. body is pure ASCII     (no multi-byte text to mangle)
 *   3. the real PS 5.1 parser accepts the file
 *   4. the XML the toast is built from really carries protocol activation
 *   5. the host spawns powershell.exe, never pwsh 7 (which cannot load WinRT)
 *
 * Check 4 is the one that actually closes the loop: it reads back the XML
 * instead of trusting that the code set the attribute, so "the code thinks it
 * set it" and "the toast really has it" cannot silently diverge again.
 *
 * USAGE
 *   node scripts/ps1-guard.mjs             # check lib/ (nothing is shown)
 *   node scripts/ps1-guard.mjs <dir>       # check .ps1 files in <dir>
 *   node scripts/ps1-guard.mjs --live      # use -Diagnose: shows a REAL toast
 *
 * Exit code 0 = every check passed or skipped; 1 = at least one FAIL.
 *
 * The parser and XML checks need Windows + PowerShell 5.1. Elsewhere they are
 * reported as SKIP and the byte checks still run, so this stays usable on a
 * non-Windows checkout.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/* ------------------------------------------------------------------ cli -- */

const argv = process.argv.slice(2)
const LIVE = argv.includes('--live')
const positional = argv.filter((a) => !a.startsWith('--'))
const TARGET = resolve(positional[0] || join(ROOT, 'lib'))

/* -------------------------------------------------------------- results -- */

const results = []
const record = (level, name, detail) => results.push({ level, name, detail })

/* ---------------------------------------------------------- powershell -- */

/** The 5.1 binary. Deliberately NOT pwsh: see check 5. */
const PS_EXE =
  [
    process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : null,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
    .filter(Boolean)
    .find((p) => existsSync(p)) || null

/** Quote a value as a PowerShell single-quoted literal. */
const psLit = (s) => "'" + String(s).replace(/'/g, "''") + "'"

function psRun(script, timeout = 60000) {
  return spawnSync(
    PS_EXE,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true },
  )
}

/** 1-based line number of a byte offset, for pointing at the offending byte. */
function lineOf(buf, index) {
  let line = 1
  for (let i = 0; i < index && i < buf.length; i++) if (buf[i] === 0x0a) line++
  return line
}

/* ------------------------------------------------------- check 1,2 (+info) */

function checkBytes(file) {
  const name = basename(file)
  const buf = readFileSync(file)

  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  if (hasBom) {
    record('PASS', `${name} BOM`, 'UTF-8 BOM present (EF BB BF)')
  } else {
    record(
      'FAIL',
      `${name} BOM`,
      'no UTF-8 BOM -- PowerShell 5.1 will decode this file with the system ANSI ' +
        'code page, which is exactly how a non-ASCII comment once swallowed a newline ' +
        'and silently disabled protocol activation. Re-save as "UTF-8 with BOM".',
    )
  }

  const start = hasBom ? 3 : 0
  let bad = -1
  for (let i = start; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      bad = i
      break
    }
  }
  if (bad === -1) {
    record('PASS', `${name} ascii`, `body is pure ASCII (${buf.length} bytes)`)
  } else {
    const near = buf.slice(bad, bad + 4).toString('latin1')
    record(
      'FAIL',
      `${name} ascii`,
      `non-ASCII byte 0x${buf[bad].toString(16).padStart(2, '0')} at line ` +
        `${lineOf(buf, bad)} (offset ${bad}, near ${JSON.stringify(near)}). ` +
        'Keep these scripts ASCII-only; multi-byte text is what triggers the code-page failure mode.',
    )
  }

  let crlf = 0
  let lf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lf++
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
    }
  }
  record(
    'PASS',
    `${name} endings`,
    `${lf} LF total, ${crlf} CRLF (informational: PowerShell 5.1 parses both)`,
  )
}

/* ------------------------------------------------------------- check 3 -- */

function checkParse(file) {
  const name = basename(file)
  if (!PS_EXE) {
    record('SKIP', `${name} parse`, 'no Windows PowerShell on this host (non-Windows checkout?)')
    return
  }

  const script = [
    '$tokens = $null',
    '$errors = $null',
    `[void][System.Management.Automation.Language.Parser]::ParseFile(${psLit(file)}, [ref]$tokens, [ref]$errors)`,
    'if ($errors.Count -eq 0) {',
    "  Write-Output 'PARSE_OK'",
    '} else {',
    '  foreach ($e in $errors) {',
    "    Write-Output ('PARSE_ERR line ' + $e.Extent.StartLineNumber + ': ' + $e.Message)",
    '  }',
    '}',
  ].join('\n')

  const r = psRun(script)
  const out = (r.stdout || '').trim()

  if (out.includes('PARSE_OK')) {
    record('PASS', `${name} parse`, 'PowerShell 5.1 parser reported 0 errors')
    return
  }

  const errs = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('PARSE_ERR'))
    .slice(0, 5)
  const detail = errs.length
    ? errs.join(' | ')
    : `PowerShell exited ${r.status}: ${(r.stderr || out || 'no output').trim().slice(0, 300)}`
  record('FAIL', `${name} parse`, detail)
}

/* ------------------------------------------------------------- check 4 -- */

function checkToastProtocolActivation() {
  const label = LIVE ? 'toast protocol activation (live)' : 'toast protocol activation'
  const toast = join(TARGET, 'toast.ps1')

  if (!existsSync(toast)) {
    record('SKIP', label, 'toast.ps1 not found in target')
    return
  }
  if (!PS_EXE) {
    record('SKIP', label, 'no Windows PowerShell on this host')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'ps1-guard-'))
  const payload = join(dir, 'payload.json')
  writeFileSync(
    payload,
    JSON.stringify({ title: 'ps1-guard', body: 'protocol activation self-check' }),
    'utf8',
  )

  const r = spawnSync(
    PS_EXE,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      toast,
      '-PayloadFile',
      payload,
      LIVE ? '-Diagnose' : '-XmlOnly',
    ],
    { encoding: 'utf8', timeout: 60000, windowsHide: true },
  )
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* temp cleanup is best-effort */
  }

  const out = (r.stdout || '').trim()
  let parsed = null
  try {
    parsed = JSON.parse(out)
  } catch {
    /* handled below */
  }

  if (!parsed || typeof parsed !== 'object') {
    const err = (r.stderr || '').trim()
    const hint = /XmlOnly/i.test(err)
      ? ' toast.ps1 has no -XmlOnly switch (this guard needs it; pass --live to use -Diagnose instead).'
      : ''
    record(
      'FAIL',
      label,
      `could not parse toast.ps1 result JSON: ${(out || err || 'no output').slice(0, 200)}.${hint}`,
    )
    return
  }

  if (!parsed.xml) {
    record(
      'SKIP',
      label,
      `toast.ps1 returned no XML, so WinRT is unavailable on this host: ${parsed.error || 'unknown'}`,
    )
    return
  }

  const xml = String(parsed.xml)
  const hasActivation = /activationType\s*=\s*["']protocol["']/i.test(xml)
  const hasLaunch = /launch\s*=\s*["']dsh-turn-notify:["']/i.test(xml)

  if (parsed.clickToFocus && hasActivation && hasLaunch) {
    record(
      'PASS',
      label,
      'the XML the toast is built from carries activationType="protocol" and launch="dsh-turn-notify:"',
    )
    return
  }

  if (!parsed.clickToFocus) {
    const why = parsed.error || (Array.isArray(parsed.attempts) ? parsed.attempts.join('; ') : '') || 'no detail'
    record(
      'SKIP',
      label,
      `the URI scheme is not registered on this host, so the XML legitimately omits ` +
        `activation (${why}). Environment limit, not a code regression.`,
    )
    return
  }

  record(
    'FAIL',
    label,
    `clickToFocus=true but the XML lacks protocol activation ` +
      `(activationType=${hasActivation}, launch=${hasLaunch}). This is the silent failure ` +
      'mode: the toast would show and the click would do nothing.',
  )
}

/* ------------------------------------------------------------- check 5 -- */

function checkHostUsesPowershell51() {
  const label = 'host uses powershell.exe'
  const idx = join(TARGET, 'index.js')
  if (!existsSync(idx)) {
    record('SKIP', label, 'index.js not found in target')
    return
  }

  const src = readFileSync(idx, 'utf8')
  const mentionsPowershell = /powershell\.exe/i.test(src)
  const spawnsPwsh = /['"`]\s*pwsh(\.exe)?\s*['"`]/i.test(src)

  if (spawnsPwsh) {
    record(
      'FAIL',
      label,
      'index.js spawns a literal "pwsh". pwsh 7 cannot load the ' +
        '[Windows.UI.Notifications.*] WinRT types, so the toast path would fail.',
    )
  } else if (!mentionsPowershell) {
    record('FAIL', label, 'index.js never references powershell.exe')
  } else {
    record('PASS', label, 'spawns powershell.exe (5.1) and never a literal pwsh')
  }
}

/* ------------------------------------------------------------ selftest -- */

/**
 * Mutation test: prove this guard is not vacuous.
 *
 * A guard that always passes is worse than no guard, because it buys false
 * confidence -- and the original bug survived for exactly that reason: every
 * other check stayed green. So each check is exercised against a deliberately
 * broken copy of toast.ps1, and an unmodified copy runs as a control. If the
 * control ever fails, the harness is wrong and the other results mean nothing.
 */
function selftest() {
  const src = join(ROOT, 'lib', 'toast.ps1')
  const buf = readFileSync(src)
  const hadBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const original = buf.slice(hadBom ? 3 : 0).toString('utf8')
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])

  const cases = [
    { name: 'control: unmodified copy', mutate: (t) => t, bom: true, expectFail: false },
    { name: 'mutation: BOM stripped', mutate: (t) => t, bom: false, expectFail: true, expect: /BOM/ },
    {
      name: 'mutation: non-ASCII comment added',
      mutate: (t) => t.replace(/^# dsh-turn-notify/, '# \u4e2d\u6587\u6ce8\u91ca\n# dsh-turn-notify'),
      bom: true,
      expectFail: true,
      expect: /ascii/,
    },
    {
      name: 'mutation: syntax broken (unclosed brace)',
      mutate: (t) => t + '\nfunction BrokenNoClose {\n',
      bom: true,
      expectFail: true,
      expect: /parse/,
    },
    {
      // This is the historical bug: the script still parses and still sends a
      // toast, it just quietly stops declaring how the click should activate.
      name: 'mutation: protocol activation removed',
      mutate: (t) =>
        t
          .replace(/^.*SetAttribute\('activationType'.*$\n?/m, '')
          .replace(/^.*SetAttribute\('launch'.*$\n?/m, ''),
      bom: true,
      expectFail: true,
      expect: /protocol activation/,
    },
  ]

  console.log('ps1-guard selftest: does the guard actually catch anything?')
  console.log('')

  let bad = 0
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'ps1-guard-selftest-'))
    const body = Buffer.from(c.mutate(original), 'utf8')
    writeFileSync(join(dir, 'toast.ps1'), c.bom ? Buffer.concat([BOM, body]) : body)

    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir], {
      encoding: 'utf8',
      timeout: 120000,
    })
    const exited1 = r.status === 1
    const matched = c.expectFail ? c.expect.test(r.stdout || '') : true
    const ok = c.expectFail ? exited1 && matched : r.status === 0

    const verdict = c.expectFail
      ? `expected FAIL${matched ? '' : ' (message did not match)'}`
      : 'expected PASS'
    console.log(
      `${ok ? '[OK]  ' : '[BAD] '} ${c.name.padEnd(42)} exit=${r.status} ${verdict}`,
    )
    if (!ok) {
      bad++
      const shown = (r.stdout || '')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('[FAIL]'))
        .map((l) => `        ${l}`)
        .join('\n')
      if (shown) console.log(shown)
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  console.log('')
  console.log(`${cases.length - bad}/${cases.length} mutation cases behaved as expected`)
  if (bad > 0) {
    console.log('ps1-guard selftest: FAIL')
    process.exit(1)
  }
  console.log('ps1-guard selftest: OK -- the guard is not vacuous')
}

/* ----------------------------------------------------------------- main -- */

function main() {
  console.log('ps1-guard: dsh-turn-notify PowerShell structural guard')
  console.log(`target:  ${TARGET}`)
  console.log(
    `mode:    ${LIVE ? 'live -- toast.ps1 -Diagnose (a real toast IS shown)' : 'safe -- toast.ps1 -XmlOnly (nothing is shown)'}`,
  )
  console.log(`host:    ${PS_EXE || 'no Windows PowerShell found (byte checks only)'}`)
  if (PS_EXE) {
    const v = psRun('$PSVersionTable.PSVersion.ToString()', 30000)
    console.log(`ps ver:  ${(v.stdout || '').trim() || 'unknown'}`)
  }
  console.log('')

  const ps1s = existsSync(TARGET)
    ? readdirSync(TARGET)
        .filter((f) => f.toLowerCase().endsWith('.ps1'))
        .sort()
    : []

  if (ps1s.length === 0) {
    record('FAIL', 'find .ps1 files', `no .ps1 files found under ${TARGET}`)
  }

  for (const f of ps1s) {
    const full = join(TARGET, f)
    checkBytes(full)
    checkParse(full)
  }
  checkToastProtocolActivation()
  checkHostUsesPowershell51()

  const pad = Math.max(...results.map((r) => r.name.length))
  for (const r of results) {
    const mark = r.level === 'PASS' ? '[PASS]' : r.level === 'SKIP' ? '[SKIP]' : '[FAIL]'
    console.log(`${mark} ${r.name.padEnd(pad)}  ${r.detail}`)
  }

  const failed = results.filter((r) => r.level === 'FAIL').length
  const passed = results.filter((r) => r.level === 'PASS').length
  const skipped = results.filter((r) => r.level === 'SKIP').length

  console.log('')
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed > 0) {
    console.log('ps1-guard: FAIL')
    process.exit(1)
  }
  console.log('ps1-guard: OK')
}

if (argv.includes('--selftest')) {
  selftest()
} else {
  main()
}
