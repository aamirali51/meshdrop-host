'use strict'

// Deliberately dumb, predictable argument parser. The whole point of the CLI is
// that a human or an AI can guess a command and have it work: one grammar, long
// flags only, no aliases, no positional magic. Unknown flags are an error so a
// typo surfaces instead of silently doing nothing.

// Flags that consume the next argument as their value.
const VALUE_FLAGS = new Set([
  'host', 'token', 'store', 'days', 'hours', 'minutes', 'max', 'port',
  'name', 'to', 'out', 'timeout', 'downloads', 'lines', 'as', 'interval'
])
// Flags that are presence-only booleans.
const BOOL_FLAGS = new Set([
  'json', 'yes', 'quiet', 'help', 'version', 'dry-run',
  'online', 'active', 'all', 'never', 'write', 'udp', 'spa', 'wait',
  'system', 'follow', 'watch', 'once'
])

function parse(argv, extra = {}) {
  const values = new Set([...VALUE_FLAGS, ...(extra.valueFlags || [])])
  const bools = new Set([...BOOL_FLAGS, ...(extra.boolFlags || [])])
  const flags = {}
  const positionals = []
  const errors = []

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1)
        i++
        continue
      }
      if (values.has(name)) {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          errors.push(`--${name} needs a value`)
          i++
          continue
        }
        flags[name] = next
        i += 2
        continue
      }
      if (bools.has(name)) {
        flags[name] = true
        i++
        continue
      }
      errors.push(`unknown flag --${name}`)
      i++
      continue
    }
    if (arg === '-h') {
      flags.help = true
      i++
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      errors.push(`unknown flag ${arg}`)
      i++
      continue
    }
    positionals.push(arg)
    i++
  }

  return { positionals, flags, errors }
}

module.exports = { parse, VALUE_FLAGS, BOOL_FLAGS }
