'use strict'

// Smoke test for the `mesh` CLI. Deliberately engine-free: it only exercises
// the meta surface, parsing, dispatch and the registry, so it runs fast and
// needs no DHT/store. (Embedded commands are covered by the host's own
// conformance suite, which boots the real engine.)

const path = require('path')
const { spawnSync } = require('child_process')

const CLI = path.join(__dirname, 'index.js')
let failures = 0

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

console.log('mesh CLI smoke test')

// ─── meta surface ───────────────────────────────────────────────────────────
{
  const r = run(['version'])
  check('version exits 0', r.status === 0, `status ${r.status}`)
  check('version names host + core', /@meshdrop-go\/host/.test(r.stdout) && /@meshdrop-go\/core/.test(r.stdout), r.stdout.trim())
}
{
  const r = run(['help'])
  check('help exits 0', r.status === 0)
  check('help shows grammar', /usage: mesh <verb>/.test(r.stdout))
  check('help lists drop', /mesh drop/.test(r.stdout))
}
{
  const r = run(['commands', '--json'])
  check('commands --json exits 0', r.status === 0)
  let manifest = null
  try {
    manifest = JSON.parse(r.stdout)
  } catch {}
  check('commands --json is valid JSON', !!manifest && manifest.ok === true, r.stdout.slice(0, 120))
  const list = manifest ? manifest.data : []
  check('manifest has > 15 commands', Array.isArray(list) && list.length > 15, `got ${list && list.length}`)
  const names = (list || []).map((c) => c.command)
  check('manifest has mesh drop', names.includes('mesh drop'))
  check('manifest has mesh ls devices', names.includes('mesh ls devices'))
  check('manifest has mesh events', names.includes('mesh events'))
  check('manifest has relay on/off', names.includes('mesh relay on') && names.includes('mesh relay off'))
  check('manifest has ls invites + tunnel join', names.includes('mesh ls invites') && names.includes('mesh tunnel join'))
  check('manifest flags destructive cmds', (list.find((c) => c.command === 'mesh revoke') || {}).destructive === true)
}
{
  const r = run(['list', 'devices', '--dry-run', '--json'])
  check('list alias maps to ls', r.status === 0 && /"command":"mesh ls devices"/.test(r.stdout), r.stdout.slice(0, 140))
}
{
  const r = run(['events', '--help'])
  check('events --help exits 0', r.status === 0 && /usage: mesh events/.test(r.stdout), r.stdout.trim())
}
{
  const r = run(['get', 'DROP-AAAA-BBBB', '--wait', '--dry-run', '--json'])
  check('get --wait dry-run reports claim method', r.status === 0 && /files\.claimCode/.test(r.stdout), r.stdout.slice(0, 140))
}
{
  const r = run(['drop', '--help'])
  check('drop --help exits 0', r.status === 0)
  check('drop --help shows usage', /usage: mesh drop/.test(r.stdout))
}

// ─── error handling / exit codes ────────────────────────────────────────────
{
  const r = run(['status', '--bogus'])
  check('unknown flag is exit 2', r.status === 2, `status ${r.status}`)
  check('unknown flag names the flag', /--bogus/.test(r.stderr), r.stderr.trim())
}
{
  const r = run(['frobnicate'])
  check('unknown command is exit 2', r.status === 2, `status ${r.status}`)
  check('unknown command points at help', /mesh help/.test(r.stderr), r.stderr.trim())
}
{
  const r = run(['status', '--bogus', '--json'])
  check('errors are JSON with --json', r.status === 2)
  let j = null
  try {
    j = JSON.parse(r.stdout)
  } catch {}
  check('json error envelope', !!j && j.ok === false && typeof j.message === 'string', r.stdout.slice(0, 120))
}

// ─── destructive guard (must refuse before any engine boot) ─────────────────
{
  const r = run(['revoke', 'DROP-AAAA-BBBB'])
  check('destructive without --yes is exit 2', r.status === 2, `status ${r.status}`)
  check('destructive guard mentions --yes', /--yes/.test(r.stderr), r.stderr.trim())
}

// ─── dry-run never boots the engine ─────────────────────────────────────────
{
  const r = run(['drop', './nope', '--never', '--dry-run', '--json'])
  check('dry-run exits 0', r.status === 0, `status ${r.status} ${r.stderr}`)
  let j = null
  try {
    j = JSON.parse(r.stdout)
  } catch {}
  check('dry-run reports the method', !!j && j.data && j.data.method === 'files.createCode', r.stdout.slice(0, 160))
}

// ─── registry integrity (static) ────────────────────────────────────────────
{
  const { COMMANDS } = require('./commands')
  const paths = new Set()
  let dupes = 0
  let malformed = 0
  let noImpl = 0
  for (const c of COMMANDS) {
    if (!Array.isArray(c.path) || !c.path.length || !c.summary || !c.usage) malformed++
    if (!c.method && typeof c.run !== 'function') noImpl++
    const key = c.path.join(' ')
    if (paths.has(key)) dupes++
    paths.add(key)
  }
  check('every command is well-formed', malformed === 0, `${malformed} malformed`)
  check('every command has an implementation', noImpl === 0, `${noImpl} without method/run`)
  check('command paths are unique', dupes === 0, `${dupes} duplicates`)
}

// ─── arg parser unit checks ─────────────────────────────────────────────────
{
  const { parse } = require('./args')
  const a = parse(['send', 'a.txt', '--to', 'nas', '--json'])
  check('parser: positional + value flag', a.positionals.join(',') === 'send,a.txt' && a.flags.to === 'nas' && a.flags.json === true)
  const b = parse(['drop', '--days=7', '--never'])
  check('parser: --k=v and bools', b.flags.days === '7' && b.flags.never === true)
  const c = parse(['x', '--nope'])
  check('parser: unknown flag errors', c.errors.length === 1 && /--nope/.test(c.errors[0]))
}

console.log(failures === 0 ? '\nAll CLI smoke checks passed.' : `\n${failures} CLI check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
