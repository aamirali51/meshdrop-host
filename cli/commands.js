'use strict'

// The command surface. One place, declarative: every command names the exact
// protocol method it drives, so `mesh commands --json`, `mesh help` and the
// dispatch can never drift from each other or from the engine contract.
//
// Grammar: `mesh <verb> [noun] [subaction] [args] [flags]`.

const fs = require('fs')
const path = require('path')
const deps = require('../deps.js')
const { METHODS: M } = require(deps.protocol)
const service = require('./service.js')
const { resolveStore } = require('./backend.js')
const { writeConfig } = require('../config.js')

const WEB_LINK_BASE = 'https://aamirali51.github.io/meshdrop-app/d/'

// ─── small formatting helpers ───────────────────────────────────────────────

function short(id) {
  return typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : id || ''
}

function formatBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function expiry(expiresAt) {
  if (!expiresAt || expiresAt <= 0) return 'never'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'expired'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

function shareLink(code) {
  return WEB_LINK_BASE + encodeURIComponent(code)
}

// ─── source resolution (files vs folder) ────────────────────────────────────

function buildSource(inputs) {
  if (inputs.length === 1) {
    const abs = path.resolve(inputs[0])
    const st = fs.statSync(abs)
    if (st.isDirectory()) return { folderPath: abs, name: path.basename(abs) }
  }
  const files = inputs.map((f) => {
    const abs = path.resolve(f)
    const st = fs.statSync(abs)
    if (st.isDirectory()) throw new Error(`folders must be shared alone: ${f}`)
    return { filePath: abs, filename: path.basename(abs), fileSize: st.size }
  })
  return { files }
}

function presetFrom(flags) {
  if (flags.never) return 'never'
  if (flags.days) return `${Number(flags.days)}d`
  if (flags.hours) return `${Number(flags.hours)}h`
  if (flags.minutes) return `${Number(flags.minutes)}m`
  return '30m'
}

function statusHuman(d) {
  const id = d.identity || {}
  const c = d.connection || {}
  return [
    `device     ${id.name || '(unnamed)'}`,
    `id         ${id.deviceId || id.id || '—'}`,
    `code       ${id.pairingCode || '—'}`,
    `status     ${c.status || (c.connected ? 'online' : 'offline')}`,
    `peers      ${d.peers == null ? '—' : d.peers}`,
    `transfers  ${d.activeTransfers} active / ${d.totalTransfers} total`
  ].join('\n')
}

// Latest published version of an npm package, or null if the registry is
// unreachable (offline, air-gapped NAS) — `mesh update` degrades gracefully.
function npmLatest(name) {
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get(
      `https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`,
      { timeout: 5000 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version || null)
          } catch {
            resolve(null)
          }
        })
      }
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

const TERMINAL_STATUSES = new Set(['completed', 'complete', 'failed', 'cancelled', 'canceled'])

// Poll TRANSFERS_LIST until a transfer reaches a terminal state. Used by the
// opt-in `--wait` on send/get so a script can block on completion (with an
// optional --timeout in seconds; 0/omitted = wait indefinitely).
async function waitForTransfer(call, id, timeoutSec) {
  if (!id) return null
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity
  for (;;) {
    const list = (await call(M.TRANSFERS_LIST, {})) || []
    const t = list.find((x) => x && (x.id === id || x.transferId === id))
    if (t && TERMINAL_STATUSES.has(String(t.status))) return t
    if (Date.now() >= deadline) return t || null
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// Resolve on the next matching backend event, or null after timeoutMs. Uses the
// backend's event stream so it works in both client and embedded modes.
function waitForEvent(backend, eventName, predicate, timeoutMs) {
  return new Promise((resolve) => {
    if (!backend || typeof backend.subscribe !== 'function') return resolve(null)
    let settled = false
    const finish = (val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        unsubscribe()
      } catch {}
      resolve(val)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const unsubscribe = backend.subscribe((event, data) => {
      if (event === eventName && (!predicate || predicate(data))) finish(data)
    })
  })
}

function eqCode(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
}

// ─── cross-command lookups (use the same methods, so both backends work) ────

async function resolveDevice(call, ref) {
  const devices = (await call(M.DEVICES_LIST, {})) || []
  const needle = String(ref).toLowerCase()
  const hit =
    devices.find((d) => d.id === ref || d.publicKey === ref) ||
    devices.find((d) => String(d.name || '').toLowerCase() === needle) ||
    devices.find((d) => String(d.id || '').toLowerCase().startsWith(needle))
  if (!hit) throw new Error(`no device matches '${ref}' (see 'mesh ls devices')`)
  return hit
}

async function resolvePending(call, code) {
  const shares = (await call(M.FILES_LIST_PENDING, {})) || []
  const needle = String(code).toLowerCase()
  const hit = shares.find((s) => String(s.code || '').toLowerCase() === needle) ||
    shares.find((s) => String(s.code || '').toLowerCase().startsWith(needle))
  if (!hit) throw new Error(`no active drop matches '${code}' (see 'mesh ls drops')`)
  return hit
}

// ─── command definitions ────────────────────────────────────────────────────

const COMMANDS = [
  // ── status / identity ─────────────────────────────────────────────────────
  {
    path: ['status'],
    summary: 'Show peers, connection and transfers',
    usage: 'mesh status [--watch [--interval N]] [--json]',
    isDefault: true,
    run: async ({ call, flags }) => {
      const collect = async () => {
        const [identity, connection, transfers] = await Promise.all([
          call(M.DEVICES_GET_IDENTITY, {}).catch(() => null),
          call(M.CONNECTION_STATUS, {}).catch(() => null),
          call(M.TRANSFERS_LIST, {}).catch(() => [])
        ])
        const list = Array.isArray(transfers) ? transfers : []
        const active = list.filter(
          (t) => t && !['completed', 'complete', 'failed', 'cancelled', 'canceled'].includes(t.status)
        )
        return {
          identity: identity || null,
          connection: connection || null,
          peers:
            connection && typeof connection.peerCount === 'number'
              ? connection.peerCount
              : connection && typeof connection.connectedPeersCount === 'number'
                ? connection.connectedPeersCount
                : null,
          activeTransfers: active.length,
          totalTransfers: list.length
        }
      }
      if (!flags.watch) return collect()
      const intervalMs = (flags.interval ? Number(flags.interval) : 2) * 1000
      const emit = (d) => {
        if (flags.json) process.stdout.write(JSON.stringify({ ok: true, data: d }) + '\n')
        else process.stdout.write(statusHuman(d) + '\n\n')
      }
      emit(await collect())
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity
      return new Promise((resolve) => {
        const timer = setInterval(async () => {
          try {
            emit(await collect())
          } catch {}
          if (Date.now() >= deadline) {
            clearInterval(timer)
            resolve()
          }
        }, intervalMs)
      })
    },
    human: statusHuman
  },
  {
    path: ['whoami'],
    summary: 'Show this node identity',
    usage: 'mesh whoami [--json]',
    method: M.DEVICES_GET_IDENTITY
  },
  {
    path: ['doctor'],
    summary: 'Run a diagnostics self-check',
    usage: 'mesh doctor [--json]',
    method: M.DIAGNOSTICS_GET
  },

  // ── lists ────────────────────────────────────────────────────────────────
  {
    path: ['ls', 'devices'],
    summary: 'List paired devices',
    usage: 'mesh ls devices [--online|--all] [--json]',
    method: M.DEVICES_LIST,
    items: (d) => (Array.isArray(d) ? d : []),
    filter: (items, f) => (f.online || f.active ? items.filter((x) => x.isOnline) : items),
    columns: [
      { label: 'NAME', get: (d) => d.name || '(unnamed)' },
      { label: 'OS', get: (d) => d.os || '' },
      { label: 'ONLINE', get: (d) => (d.isOnline ? 'yes' : 'no') },
      { label: 'ID', get: (d) => short(d.id) }
    ]
  },
  {
    path: ['ls', 'peers'],
    summary: 'List currently online peers',
    usage: 'mesh ls peers [--json]',
    method: M.DEVICES_LIST,
    items: (d) => (Array.isArray(d) ? d : []),
    filter: (items) => items.filter((x) => x.isOnline),
    columns: [
      { label: 'NAME', get: (d) => d.name || '(unnamed)' },
      { label: 'OS', get: (d) => d.os || '' },
      { label: 'ID', get: (d) => short(d.id) }
    ]
  },
  {
    path: ['ls', 'drops'],
    summary: 'List active drop codes',
    usage: 'mesh ls drops [--json]',
    method: M.FILES_LIST_PENDING,
    items: (d) => (Array.isArray(d) ? d : []),
    columns: [
      { label: 'CODE', get: (d) => d.code || '' },
      { label: 'FILES', get: (d) => String((d.files && d.files.length) || 1) },
      { label: 'SIZE', get: (d) => formatBytes(d.fileSize) },
      { label: 'EXPIRES', get: (d) => d.expiresAt ? expiry(d.expiresAt) : 'never' },
      { label: 'STATUS', get: (d) => d.status || '' }
    ]
  },
  {
    path: ['ls', 'transfers'],
    summary: 'List transfers',
    usage: 'mesh ls transfers [--active] [--json]',
    method: M.TRANSFERS_LIST,
    items: (d) => (Array.isArray(d) ? d : []),
    filter: (items, f) =>
      f.active ? items.filter((t) => !['completed', 'complete', 'failed', 'cancelled', 'canceled'].includes(t.status)) : items,
    columns: [
      { label: 'NAME', get: (t) => t.filename || t.name || '' },
      { label: 'DIR', get: (t) => t.direction || '' },
      { label: 'PEER', get: (t) => t.peerName || '' },
      { label: 'STATUS', get: (t) => t.status || '' },
      { label: 'SIZE', get: (t) => formatBytes(t.fileSize || t.size) }
    ]
  },
  {
    path: ['ls', 'sync'],
    summary: 'List sync folders',
    usage: 'mesh ls sync [--json]',
    method: M.SYNC_LIST,
    items: (d) => (Array.isArray(d) ? d : []),
    columns: [
      { label: 'NAME', get: (s) => s.name || '' },
      { label: 'PATH', get: (s) => s.path || s.localPath || '' },
      { label: 'PEER', get: (s) => short(s.peerId) },
      { label: 'FILES', get: (s) => String(s.fileCount == null ? '' : s.fileCount) },
      { label: 'STATUS', get: (s) => s.status || (s.paused ? 'paused' : '') }
    ]
  },
  {
    path: ['ls', 'sites'],
    summary: 'List published shared folders',
    usage: 'mesh ls sites [--json]',
    method: M.SITES_LIST,
    items: (d) => (Array.isArray(d) ? d : []),
    columns: [
      { label: 'NAME', get: (s) => s.name || '' },
      { label: 'CODE', get: (s) => s.code || '' },
      { label: 'EXPIRES', get: (s) => (s.expiresAt ? expiry(s.expiresAt) : 'never') },
      { label: 'VISITORS', get: (s) => String(s.visitorCount == null ? '' : s.visitorCount) },
      { label: 'FOLDER', get: (s) => s.folderPath || '' }
    ]
  },
  {
    path: ['ls', 'tunnels'],
    summary: 'List tunnel codes',
    usage: 'mesh ls tunnels [--json]',
    method: M.TUNNEL_LIST_CODES,
    items: (d) => (Array.isArray(d) ? d : []),
    columns: [
      { label: 'CODE', get: (t) => t.code || '' },
      { label: 'PORT', get: (t) => String(t.port == null ? '' : t.port) },
      { label: 'UDP', get: (t) => (t.udp ? 'yes' : 'no') },
      { label: 'USES', get: (t) => `${t.uses || 0}${t.maxUses ? '/' + t.maxUses : ''}` },
      { label: 'EXPIRES', get: (t) => (t.expiresAt ? expiry(t.expiresAt) : 'never') }
    ]
  },
  {
    path: ['ls', 'rooms'],
    summary: 'List watch-party rooms',
    usage: 'mesh ls rooms [--json]',
    method: M.WATCH_PARTY_LIST_ROOMS,
    items: (d) => (Array.isArray(d) ? d : d ? [d] : []),
    columns: [
      { label: 'TITLE', get: (r) => r.title || r.roomTitle || '' },
      { label: 'CODE', get: (r) => r.roomCode || r.code || '' },
      { label: 'HOST', get: (r) => r.hostName || '' },
      { label: 'PEERS', get: (r) => String(r.participantCount == null ? '' : r.participantCount) }
    ]
  },
  {
    path: ['ls', 'invites'],
    summary: 'List pending sync invites',
    usage: 'mesh ls invites [--json]',
    method: M.SYNC_LIST_INVITES,
    items: (d) => (Array.isArray(d) ? d : []),
    columns: [
      { label: 'NAME', get: (i) => i.name || '' },
      { label: 'FROM', get: (i) => i.peerName || i.peerId || '' },
      { label: 'ID', get: (i) => short(i.id) }
    ]
  },

  // ── send / share / receive ────────────────────────────────────────────────
  {
    path: ['send'],
    summary: 'Send files to a paired device',
    usage: 'mesh send <path…> --to <peer> [--wait [--timeout N]] [--json]',
    write: true,
    method: M.TRANSFERS_START,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error("send needs at least one file: mesh send <path…> --to <peer>")
      if (!flags.to) throw new Error('--to <peer> is required (see "mesh ls peers")')
      const device = await resolveDevice(call, flags.to)
      const peerId = device.id || device.publicKey
      const timeout = flags.timeout ? Number(flags.timeout) : 0
      const out = []
      for (const file of positionals) {
        const abs = path.resolve(file)
        const st = fs.statSync(abs)
        if (!st.isFile()) throw new Error(`not a file: ${file}`)
        const res = await call(M.TRANSFERS_START, {
          peerId,
          filePath: abs,
          filename: path.basename(abs),
          fileSize: st.size
        })
        const entry = { file: abs, transfer: res }
        if (flags.wait) entry.final = await waitForTransfer(call, res && res.id, timeout)
        out.push(entry)
      }
      return out
    },
    human: (rows) =>
      rows
        .map((r) => {
          const id = (r.transfer && r.transfer.id) || 'transfer'
          const status = r.final && r.final.status ? ` — ${r.final.status}` : ''
          return `queued ${path.basename(r.file)} → ${id}${status}`
        })
        .join('\n')
  },
  {
    path: ['drop'],
    summary: 'Create a drop code (share link) for files or a folder',
    usage: 'mesh drop <path…> [--never|--days N|--hours N] [--max N] [--name <title>] [--json]',
    write: true,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error('drop needs a file or folder: mesh drop <path…>')
      const source = buildSource(positionals)
      return call(M.FILES_CREATE_CODE, {
        ...source,
        expirationPreset: presetFrom(flags),
        maxDownloads: flags.max ? Number(flags.max) : 0,
        roomTitle: flags.name
      })
    },
    dry: (p, f) => ({
      dryRun: true,
      command: 'mesh drop',
      method: M.FILES_CREATE_CODE,
      args: p,
      params: { folders: p, expirationPreset: presetFrom(f), maxDownloads: f.max ? Number(f.max) : 0 }
    }),
    human: (s) =>
      `code     ${s.code}\nurl      ${shareLink(s.code)}\nexpires  ${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'never'}\nfiles    ${(s.files && s.files.length) || 1} (${formatBytes(s.fileSize)})`
  },
  {
    path: ['get'],
    summary: 'Receive a drop code — claim it, then download the files',
    usage: 'mesh get <code> [--timeout N] [--json]',
    write: true,
    method: M.FILES_CLAIM_CODE,
    run: async ({ call, backend, positionals, flags }) => {
      if (!positionals.length) throw new Error('get needs a code: mesh get DROP-XXXX-XXXX')
      const code = positionals[0]
      const waitMs = flags.timeout ? Number(flags.timeout) * 1000 : 20000
      // Claiming only advertises interest; the sender's reply arrives as a
      // `claim.preview_received` event carrying the shareId. Subscribe FIRST so
      // it cannot be missed, then confirm to actually pull the files.
      const previewPromise = waitForEvent(
        backend,
        'claim.preview_received',
        (d) => !d || !d.code || eqCode(d.code, code),
        waitMs
      )
      await call(M.FILES_CLAIM_CODE, { code })
      const preview = await previewPromise
      if (!preview) {
        throw new Error(
          `no sender is online for ${code} (no reply in ${Math.round(waitMs / 1000)}s) — the code may be expired or the sender offline`
        )
      }
      const selectedIndices = Array.isArray(preview.files) ? preview.files.map((f) => f.index) : undefined
      const started = await call(M.FILES_CONFIRM_CLAIM, { shareId: preview.shareId, selectedIndices })
      const id = started && (started.id || started.transferId)
      const download = id ? (await waitForTransfer(call, id, 0)) || started : started
      return { code, files: preview.files, download }
    }
  },
  {
    path: ['peek'],
    summary: 'Check whether a drop code is online and list its files (no download)',
    usage: 'mesh peek <code> [--timeout N] [--json]',
    run: async ({ call, backend, positionals, flags }) => {
      if (!positionals.length) throw new Error('peek needs a code: mesh peek DROP-XXXX-XXXX')
      const code = positionals[0]
      const waitMs = flags.timeout ? Number(flags.timeout) * 1000 : 20000
      const previewPromise = waitForEvent(
        backend,
        'claim.preview_received',
        (d) => !d || !d.code || eqCode(d.code, code),
        waitMs
      )
      await call(M.FILES_CLAIM_CODE, { code })
      const preview = await previewPromise
      if (!preview) return { online: false, code }
      // Do not download — withdraw the claim we just made.
      try {
        await call(M.FILES_CANCEL_CLAIM, { shareId: preview.shareId, code })
      } catch {}
      return { online: true, code, shareId: preview.shareId, expiresAt: preview.expiresAt || 0, files: preview.files }
    },
    human: (d) =>
      d.online
        ? `online    yes\ncode      ${d.code}\nfiles     ${(d.files || []).length}\nexpires   ${d.expiresAt ? new Date(d.expiresAt).toLocaleString() : 'never'}`
        : `online    no — nobody answered for ${d.code} (expired, or the sender is offline)`
  },
  {
    path: ['revoke'],
    summary: 'Revoke an active drop code',
    usage: 'mesh revoke <code> [--yes] [--json]',
    write: true,
    method: M.FILES_CANCEL_CODE,
    run: async ({ call, positionals }) => {
      const share = await resolvePending(call, positionals[0])
      return call(M.FILES_CANCEL_CODE, { id: share.id })
    }
  },
  {
    path: ['extend'],
    summary: 'Extend an active drop code',
    usage: 'mesh extend <code> [--minutes N] [--json]',
    write: true,
    method: M.FILES_EXTEND_EXPIRATION,
    run: async ({ call, positionals, flags }) => {
      const share = await resolvePending(call, positionals[0])
      return call(M.FILES_EXTEND_EXPIRATION, { id: share.id, addMinutes: flags.minutes ? Number(flags.minutes) : 30 })
    }
  },

  // ── pairing ───────────────────────────────────────────────────────────────
  {
    path: ['pair'],
    summary: 'Pair with a device by code',
    usage: 'mesh pair <MD-XXXX-…|DROP-…> [--json]',
    write: true,
    method: M.DEVICES_PAIR_CODE,
    run: async ({ call, positionals }) => {
      if (!positionals.length) throw new Error('pair needs a code: mesh pair MD-XXXX-XXXX')
      return call(M.DEVICES_PAIR_CODE, { code: positionals[0] })
    }
  },
  {
    path: ['unpair'],
    summary: 'Remove a paired device',
    usage: 'mesh unpair <peer> [--yes] [--json]',
    write: true,
    method: M.DEVICES_REMOVE,
    run: async ({ call, positionals }) => {
      if (!positionals.length) throw new Error('unpair needs a device: mesh unpair <name|id>')
      const device = await resolveDevice(call, positionals[0])
      return call(M.DEVICES_REMOVE, { id: device.id })
    }
  },

  // ── sync ──────────────────────────────────────────────────────────────────
  {
    path: ['sync', 'add'],
    summary: 'Sync a local folder to a device',
    usage: 'mesh sync add <path> --to <peer> [--name <label>] [--json]',
    write: true,
    method: M.SYNC_ADD,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error('sync add needs a path: mesh sync add <path> --to <peer>')
      if (!flags.to) throw new Error('--to <peer> is required (see "mesh ls devices")')
      const device = await resolveDevice(call, flags.to)
      return call(M.SYNC_ADD, {
        path: path.resolve(positionals[0]),
        peerId: device.id || device.publicKey,
        name: flags.name
      })
    }
  },
  {
    path: ['sync', 'rm'],
    summary: 'Remove a sync folder',
    usage: 'mesh sync rm <id> [--json]',
    write: true,
    method: M.SYNC_REMOVE,
    params: (p) => ({ id: p[0] })
  },
  {
    path: ['sync', 'pause'],
    summary: 'Pause a sync folder',
    usage: 'mesh sync pause <id> [--json]',
    write: true,
    method: M.SYNC_PAUSE,
    params: (p) => ({ id: p[0] })
  },
  {
    path: ['sync', 'resume'],
    summary: 'Resume a sync folder',
    usage: 'mesh sync resume <id> [--json]',
    write: true,
    method: M.SYNC_RESUME,
    params: (p) => ({ id: p[0] })
  },
  {
    path: ['sync', 'run'],
    summary: 'Trigger a sync pass now',
    usage: 'mesh sync run <id> [--json]',
    write: true,
    method: M.SYNC_TRIGGER,
    params: (p) => ({ id: p[0] })
  },
  {
    path: ['sync', 'accept'],
    summary: 'Accept a sync invite',
    usage: 'mesh sync accept <id> [--json]',
    write: true,
    method: M.SYNC_ACCEPT_INVITE,
    params: (p) => ({ id: p[0] })
  },
  {
    path: ['sync', 'decline'],
    summary: 'Decline a sync invite',
    usage: 'mesh sync decline <id> [--json]',
    write: true,
    method: M.SYNC_DECLINE_INVITE,
    params: (p) => ({ id: p[0] })
  },

  // ── sites (shared folders) ────────────────────────────────────────────────
  {
    path: ['site', 'publish'],
    summary: 'Publish a folder as a shared folder',
    usage: 'mesh site publish <path> [--name <n>] [--never|--days N] [--write] [--spa] [--json]',
    write: true,
    method: M.SITES_PUBLISH,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error('site publish needs a folder: mesh site publish <path>')
      return call(M.SITES_PUBLISH, {
        folderPath: path.resolve(positionals[0]),
        name: flags.name,
        writeMode: flags.write ? 'read-write' : 'read-only',
        spa: !!flags.spa,
        expirationPreset: presetFrom(flags)
      })
    }
  },
  {
    path: ['site', 'rm'],
    summary: 'Unpublish a shared folder',
    usage: 'mesh site rm <siteId> [--json]',
    write: true,
    method: M.SITES_UNPUBLISH,
    params: (p) => ({ siteId: p[0] })
  },

  // ── tunnels ───────────────────────────────────────────────────────────────
  {
    path: ['tunnel', 'open'],
    summary: 'Expose a local port behind a tunnel code',
    usage: 'mesh tunnel open --port <n> [--name <n>] [--udp] [--never|--days N] [--max N] [--json]',
    write: true,
    method: M.TUNNEL_CREATE_CODE,
    run: async ({ call, flags }) => {
      if (!flags.port) throw new Error('--port <n> is required')
      return call(M.TUNNEL_CREATE_CODE, {
        port: Number(flags.port),
        host: '127.0.0.1',
        name: flags.name,
        udp: !!flags.udp,
        expirationPreset: presetFrom(flags),
        maxUses: flags.max ? Number(flags.max) : 0
      })
    }
  },
  {
    path: ['tunnel', 'close'],
    summary: 'Close a tunnel code',
    usage: 'mesh tunnel close <code> [--json]',
    write: true,
    method: M.TUNNEL_CANCEL_CODE,
    params: (p) => ({ code: p[0] })
  },
  {
    path: ['tunnel', 'join'],
    summary: 'Join a tunnel code (expose it locally)',
    usage: 'mesh tunnel join <code> [--json]',
    write: true,
    method: M.TUNNEL_JOIN_CODE,
    params: (p) => ({ code: p[0] })
  },

  // ── watch party ───────────────────────────────────────────────────────────
  {
    path: ['party', 'create'],
    summary: 'Create a watch-party room for a video file',
    usage: 'mesh party create <file> [--name <title>] [--json]',
    write: true,
    method: M.WATCH_PARTY_CREATE,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error('party create needs a video file: mesh party create <file>')
      return call(M.WATCH_PARTY_CREATE, { filePath: path.resolve(positionals[0]), title: flags.name })
    }
  },
  {
    path: ['party', 'join'],
    summary: 'Join a watch-party room',
    usage: 'mesh party join <code> [--json]',
    write: true,
    method: M.WATCH_PARTY_JOIN,
    params: (p) => ({ roomCode: p[0] })
  },
  {
    path: ['party', 'leave'],
    summary: 'Leave the current watch-party room',
    usage: 'mesh party leave [--json]',
    method: M.WATCH_PARTY_LEAVE
  },

  // ── relay & config ────────────────────────────────────────────────────────
  {
    path: ['relay', 'status'],
    summary: 'Show relay sessions',
    usage: 'mesh relay status [--json]',
    method: 'relay.stats'
  },
  {
    path: ['relay', 'on'],
    summary: 'Relay for paired devices (helps NAT-restricted peers)',
    usage: 'mesh relay on [--json]',
    write: true,
    method: M.SETTINGS_UPDATE,
    params: () => ({ relayForPairedDevices: true })
  },
  {
    path: ['relay', 'off'],
    summary: 'Stop relaying for paired devices',
    usage: 'mesh relay off [--json]',
    write: true,
    method: M.SETTINGS_UPDATE,
    params: () => ({ relayForPairedDevices: false })
  },
  {
    path: ['config', 'get'],
    summary: 'Show settings (or one key)',
    usage: 'mesh config get [<key>] [--json]',
    method: M.SETTINGS_GET,
    run: async ({ call, positionals }) => {
      const settings = await call(M.SETTINGS_GET, {})
      if (positionals[0]) return { [positionals[0]]: settings ? settings[positionals[0]] : undefined }
      return settings
    }
  },
  {
    path: ['config', 'set'],
    summary: 'Set a setting',
    usage: 'mesh config set <key> <value> [--json]',
    write: true,
    method: M.SETTINGS_UPDATE,
    run: async ({ call, positionals }) => {
      const [key, value] = positionals
      if (!key || value === undefined) throw new Error('usage: mesh config set <key> <value>')
      let coerced = value
      if (value === 'true') coerced = true
      else if (value === 'false') coerced = false
      else if (/^-?\d+$/.test(value)) coerced = Number(value)
      return call(M.SETTINGS_UPDATE, { [key]: coerced })
    }
  },

  // ── observe ───────────────────────────────────────────────────────────────
  {
    path: ['events'],
    summary: 'Stream live engine events until interrupted',
    usage: 'mesh events [<filter>] [--timeout N] [--json]',
    stream: true,
    run: ({ backend, flags, positionals }) => {
      const filter = (positionals[0] || '').toLowerCase()
      const onEvent = (event, data) => {
        if (filter && !String(event).toLowerCase().includes(filter)) return
        if (flags.json) process.stdout.write(JSON.stringify({ event, data, at: Date.now() }) + '\n')
        else process.stdout.write(`${event}  ${JSON.stringify(data)}\n`)
      }
      if (typeof backend.subscribe !== 'function') {
        throw new Error('this backend cannot stream events')
      }
      const unsubscribe = backend.subscribe(onEvent)
      const secs = flags.timeout ? Number(flags.timeout) : 0
      // --timeout bounds the stream (handy in tests/CI): tear the subscription
      // down or the open socket/engine would keep the process alive forever.
      if (secs > 0) {
        return new Promise((resolve) =>
          setTimeout(() => {
            try {
              unsubscribe()
            } catch {}
            resolve()
          }, secs * 1000)
        )
      }
      return new Promise(() => {})
    }
  },

  // ── daemon ops (config file, logs, service) ───────────────────────────────
  {
    path: ['logs'],
    summary: 'Show the host log (<store>/host.log)',
    usage: 'mesh logs [--lines N] [--follow] [--json]',
    local: true,
    run: async ({ flags }) => {
      const file = path.join(resolveStore(flags), 'host.log')
      const n = flags.lines ? Number(flags.lines) : 50
      const all = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
      const initial = all.slice(-n)
      if (!flags.follow) return { file, lines: initial }
      for (const line of initial) {
        process.stdout.write(flags.json ? JSON.stringify({ line }) + '\n' : line + '\n')
      }
      let size = fs.existsSync(file) ? fs.statSync(file).size : 0
      return new Promise(() => {
        setInterval(() => {
          try {
            const st = fs.statSync(file)
            if (st.size < size) size = st.size
            if (st.size > size) {
              const fd = fs.openSync(file, 'r')
              const buf = Buffer.alloc(st.size - size)
              fs.readSync(fd, buf, 0, buf.length, size)
              fs.closeSync(fd)
              size = st.size
              for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
                process.stdout.write(flags.json ? JSON.stringify({ line }) + '\n' : line + '\n')
              }
            }
          } catch {}
        }, 500)
      })
    },
    human: (d) => (d.lines.length ? d.lines.join('\n') : `(no log yet at ${d.file})`)
  },
  {
    path: ['service', 'install'],
    summary: 'Install the host as a start-on-boot service (systemd / launchd / Windows task)',
    usage: 'mesh service install [--system] [--name <n>] [--port <n>] [--downloads <dir>] [--dry-run] [--json]',
    write: true,
    local: true,
    dry: (p, flags) => {
      const store = resolveStore(flags)
      return { dryRun: true, platform: process.platform, storage: store, unit: service.renderUnit(store) }
    },
    run: async ({ flags }) => {
      const store = resolveStore(flags)
      const patch = {}
      if (flags.name) patch.name = flags.name
      if (flags.port) patch.port = Number(flags.port)
      if (flags.downloads) patch.downloads = flags.downloads
      if (Object.keys(patch).length) writeConfig(store, patch)
      return service.install({ storage: store, system: !!flags.system })
    },
    human: (d) =>
      d.dryRun
        ? `dry run — would install on ${d.platform} (store ${d.storage}):\n\n${d.unit}`
        : `service installed${d.file ? ` (${d.file})` : ''}${d.hint ? ` — ${d.hint}` : ''}`
  },
  {
    path: ['service', 'uninstall'],
    summary: 'Stop and remove the host service',
    usage: 'mesh service uninstall [--system] [--yes] [--json]',
    write: true,
    local: true,
    run: async ({ flags }) => service.uninstall({ system: !!flags.system })
  },
  {
    path: ['service', 'status'],
    summary: 'Show whether the host service is installed and running',
    usage: 'mesh service status [--system] [--json]',
    local: true,
    run: async ({ flags }) => service.status({ system: !!flags.system })
  },
  {
    path: ['update'],
    summary: 'Check npm for a newer mesh release',
    usage: 'mesh update [--json]',
    local: true,
    run: async () => {
      const current = require('../package.json').version
      const latest = await npmLatest('@meshdrop-go/host')
      const newer = !!latest && compareVersions(latest, current) > 0
      return { current, latest: latest || null, upToDate: !newer, install: 'npm install -g @meshdrop-go/host' }
    },
    human: (d) =>
      !d.latest
        ? `could not reach the npm registry (installed ${d.current})`
        : d.upToDate
          ? `up to date (${d.current})`
          : `update available: ${d.current} → ${d.latest}\n  ${d.install}`
  },

  // ── folder automation ─────────────────────────────────────────────────────
  {
    path: ['watch'],
    summary: 'Watch a folder: auto-send new files to a peer, or publish it as a shared folder',
    usage: 'mesh watch <dir> [--to <peer>] [--as site] [--name <n>] [--once] [--interval N] [--json]',
    write: true,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error('watch needs a folder: mesh watch <dir> [--to <peer>] [--as site]')
      const dir = path.resolve(positionals[0])
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${positionals[0]}`)

      let peerId = null
      if (flags.to) {
        const device = await resolveDevice(call, flags.to)
        peerId = device.id || device.publicKey
      }
      const emit = (event, data) => {
        if (flags.json) process.stdout.write(JSON.stringify({ event, data }) + '\n')
        else process.stdout.write(`${event}  ${data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data)}\n`)
      }
      if (flags.as === 'site') {
        const published = await call(M.SITES_PUBLISH, {
          folderPath: dir,
          name: flags.name,
          writeMode: flags.write ? 'read-write' : 'read-only',
          spa: !!flags.spa,
          expirationPreset: presetFrom(flags)
        })
        emit('published', published)
      }

      const listFiles = () => {
        const out = []
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else if (e.isFile()) out.push(p)
          }
        }
        walk(dir)
        return out
      }

      const seen = new Set(listFiles())
      emit('watching', { dir, to: flags.to || null, files: seen.size })

      const scan = async () => {
        for (const file of listFiles()) {
          if (seen.has(file)) continue
          seen.add(file)
          if (peerId) {
            const st = fs.statSync(file)
            const res = await call(M.TRANSFERS_START, {
              peerId,
              filePath: file,
              filename: path.basename(file),
              fileSize: st.size
            })
            emit('sent', { file, transfer: res && res.id })
          } else {
            emit('new', file)
          }
        }
      }

      if (flags.once) {
        await scan()
        return { dir, files: seen.size }
      }

      const intervalMs = (flags.interval ? Number(flags.interval) : 3) * 1000
      return new Promise(() => {
        setInterval(() => {
          scan().catch(() => {})
        }, intervalMs)
      })
    }
  }
]

module.exports = { COMMANDS, short, formatBytes, expiry, shareLink, resolveDevice, resolvePending, buildSource, presetFrom }
