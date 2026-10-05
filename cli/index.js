#!/usr/bin/env node
'use strict'

// `mesh` — the MeshDrop command line.
//
// Grammar: mesh <verb> [noun] [subaction] [args] [flags]
// Non-interactive by design: never prompts, `--json` on every command, stable
// exit codes, and `mesh commands --json` so an agent can introspect the surface.

const path = require('path')
const util = require('util')
const { spawn } = require('child_process')
const { parse } = require('./args')
const { COMMANDS } = require('./commands')
const { openBackend, resolveStore } = require('./backend')

const HOST_DIR = path.join(__dirname, '..')

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 3, CONFLICT: 4 }

class CliError extends Error {
  constructor(message, code = EXIT.ERROR) {
    super(message)
    this.code = code
  }
}

const usage = (msg) => new CliError(msg, EXIT.USAGE)

// Commands that mutate/remove state and therefore require an explicit --yes
// when not a --dry-run (never destructive by default).
const DESTRUCTIVE = new Set(['revoke', 'unpair', 'sync rm', 'site rm', 'tunnel close'])

// ─── output ─────────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

// The engine logs to stdout via console.*. That would interleave with our
// result and break `mesh … --json | jq`, so during a command run every console
// call is routed to stderr. stdout then carries ONLY the command's output.
function routeConsoleToStderr() {
  const keep = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  }
  const toErr = (...args) => process.stderr.write(util.format(...args) + '\n')
  console.log = toErr
  console.info = toErr
  console.warn = toErr
  console.error = toErr
  console.debug = toErr
  return () => {
    Object.assign(console, keep)
  }
}

function renderTable(columns, rows) {
  const header = columns.map((c) => c.label)
  const body = rows.map((r) => columns.map((c) => String(c.get(r) == null ? '' : c.get(r))))
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length), 0))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').replace(/\s+$/, '')
  const out = [line(header), widths.map((w) => '─'.repeat(w)).join('  ')]
  for (const r of body) out.push(line(r))
  return out.join('\n')
}

function render(command, data, flags) {
  if (flags.json) return printJson({ ok: true, data })
  if (flags.quiet) return
  const text =
    typeof command.human === 'function'
      ? command.human(data)
      : command.columns
        ? renderTable(command.columns, command.items(data))
        : JSON.stringify(data, null, 2)
  process.stdout.write((text == null ? '' : String(text)) + '\n')
}

// ─── meta commands ──────────────────────────────────────────────────────────

function commandList() {
  return COMMANDS
}

function helpText(topic) {
  if (topic) {
    const cmd = COMMANDS.find((c) => c.path.join(' ') === topic)
    if (!cmd) return `mesh: unknown command '${topic}'`
    return [`usage: ${cmd.usage}`, `  ${cmd.summary}`].join('\n')
  }
  const rows = COMMANDS.map((c) => `  mesh ${c.path.join(' ').padEnd(24)} ${c.summary}`)
  return [
    'mesh — MeshDrop command line',
    '',
    'usage: mesh <verb> [noun] [subaction] [args] [flags]',
    '',
    'commands:',
    ...rows,
    '  mesh host                Run the headless MeshDrop host (daemon)',
    '',
    "('list' is accepted as an alias for 'ls')",
    '',
    'global flags: --json  --yes  --dry-run  --host <url>  --token <t>  --store <dir>  --quiet',
    'env:          MESH_HOST  MESH_TOKEN  MESH_STORE  MESH_DOWNLOADS',
    '',
    "run 'mesh <verb> --help' for a command's usage"
  ].join('\n')
}

function manifest() {
  return COMMANDS.map((c) => ({
    command: `mesh ${c.path.join(' ')}`,
    path: c.path,
    summary: c.summary,
    usage: c.usage,
    write: !!c.write,
    destructive: DESTRUCTIVE.has(c.path.join(' '))
  }))
}

function versionText() {
  const host = require(path.join(HOST_DIR, 'package.json')).version
  let core = '?'
  try {
    core = require('@mesh/core/package.json').version
  } catch {}
  return `mesh (meshdrop-host ${host}, @mesh/core ${core})`
}

// ─── dispatch ───────────────────────────────────────────────────────────────

function matchCommand(positionals) {
  let best = null
  for (const c of COMMANDS) {
    if (c.path.length > positionals.length) continue
    if (c.path.every((seg, i) => positionals[i] === seg)) {
      if (!best || c.path.length > best.path.length) best = c
    }
  }
  return best
}

async function runCommand(command, positionalArgs, flags) {
  const label = command.path.join(' ')

  if (command.write && DESTRUCTIVE.has(label) && !flags.yes && !flags['dry-run']) {
    throw usage(`'mesh ${label}' changes state — re-run with --yes (or --dry-run)`)
  }

  if (flags['dry-run']) {
    if (typeof command.dry === 'function') return command.dry(positionalArgs, flags)
    const params = command.params ? command.params(positionalArgs, flags) : {}
    return { dryRun: true, command: `mesh ${label}`, method: command.method || null, args: positionalArgs, params }
  }

  const backend = await openBackend(flags)
  try {
    if (typeof command.run === 'function') {
      return await command.run({ call: backend.call, positionals: positionalArgs, flags, backend })
    }
    if (command.method) {
      const params = command.params ? command.params(positionalArgs, flags) : {}
      return await backend.call(command.method, params)
    }
    throw new CliError(`command '${label}' has no implementation`, EXIT.ERROR)
  } finally {
    await backend.stop().catch(() => {})
  }
}

async function main() {
  const argv = process.argv.slice(2)

  // `host` forwards straight to the headless host, which has its own flags.
  if (argv[0] === 'host') {
    const child = spawn(process.execPath, [path.join(HOST_DIR, 'index.js'), ...argv.slice(1)], {
      stdio: 'inherit'
    })
    child.on('exit', (code) => process.exit(code == null ? EXIT.OK : code))
    return
  }

  const { positionals, flags, errors } = parse(argv)

  if (flags.version || positionals[0] === 'version') return printJsonSafe(versionText(), flags)
  if (errors.length) throw usage(errors.join('\n'))

  // `list` is accepted as an alias for `ls`; `ls` stays the canonical spelling.
  if (positionals[0] === 'list') positionals[0] = 'ls'

  if (positionals[0] === 'help') return printJsonSafe(helpText(positionals[1]), flags)
  if (positionals[0] === 'commands') {
    if (flags.json) return printJson({ ok: true, data: manifest() })
    return process.stdout.write(manifest().map((m) => `${m.command}  —  ${m.summary}`).join('\n') + '\n')
  }

  let command = matchCommand(positionals)
  if (!command && positionals.length === 0) command = COMMANDS.find((c) => c.isDefault)
  if (!command) {
    throw usage(`unknown command '${positionals.join(' ')}' — run 'mesh help'`)
  }
  if (flags.help) return printJsonSafe(helpText(command.path.join(' ')), flags)

  const rest = positionals.slice(command.path.length)
  const restoreLogs = routeConsoleToStderr()
  let data
  try {
    data = await runCommand(command, rest, flags)
  } finally {
    restoreLogs()
  }
  if (command.stream) return // streaming commands print their own frames
  render(command, data, flags)
  process.exitCode = EXIT.OK
}

function printJsonSafe(text, flags) {
  if (flags.json) return printJson({ ok: true, data: text })
  process.stdout.write(text + '\n')
}

main().catch((err) => {
  const code = typeof err.code === 'number' ? err.code : EXIT.ERROR
  const message = err && err.message ? err.message : String(err)
  if (process.argv.includes('--json')) {
    printJson({ ok: false, code, message })
  } else {
    process.stderr.write(`mesh: ${message}\n`)
  }
  process.exit(code)
})

module.exports = { EXIT }
