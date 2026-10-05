'use strict'

// The command surface. One place, declarative: every command names the exact
// protocol method it drives, so `mesh commands --json`, `mesh help` and the
// dispatch can never drift from each other or from the engine contract.
//
// Grammar: `mesh <verb> [noun] [subaction] [args] [flags]`.

const fs = require('fs')
const path = require('path')
const { METHODS: M } = require(path.join(__dirname, '..', '..', 'meshdrop-app', 'src', 'shared', 'protocol.js'))

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
    usage: 'mesh status [--json]',
    isDefault: true,
    run: async ({ call }) => {
      const [identity, connection, transfers] = await Promise.all([
        call(M.DEVICES_GET_IDENTITY, {}).catch(() => null),
        call(M.CONNECTION_STATUS, {}).catch(() => null),
        call(M.TRANSFERS_LIST, {}).catch(() => [])
      ])
      const list = Array.isArray(transfers) ? transfers : []
      const active = list.filter((t) => t && !['completed', 'complete', 'failed', 'cancelled', 'canceled'].includes(t.status))
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
    },
    human: (d) => {
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

  // ── send / share / receive ────────────────────────────────────────────────
  {
    path: ['send'],
    summary: 'Send files to a paired device',
    usage: 'mesh send <path…> --to <peer> [--json]',
    write: true,
    run: async ({ call, positionals, flags }) => {
      if (!positionals.length) throw new Error("send needs at least one file: mesh send <path…> --to <peer>")
      if (!flags.to) throw new Error('--to <peer> is required (see "mesh ls peers")')
      const device = await resolveDevice(call, flags.to)
      const peerId = device.id || device.publicKey
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
        out.push({ file: abs, transfer: res })
      }
      return out
    },
    human: (rows) => rows.map((r) => `queued ${path.basename(r.file)} → ${r.transfer && r.transfer.id ? r.transfer.id : 'transfer'}`).join('\n')
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
    summary: 'Claim a drop code and download it',
    usage: 'mesh get <code> [--out <dir>] [--json]',
    write: true,
    run: async ({ call, positionals }) => {
      if (!positionals.length) throw new Error('get needs a code: mesh get DROP-XXXX-XXXX')
      const claim = await call(M.FILES_CLAIM_CODE, { code: positionals[0] })
      if (claim && claim.shareId) {
        const done = await call(M.FILES_CONFIRM_CLAIM, { shareId: claim.shareId })
        return done || claim
      }
      return claim
    }
  },
  {
    path: ['revoke'],
    summary: 'Revoke an active drop code',
    usage: 'mesh revoke <code> [--yes] [--json]',
    write: true,
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

  // ── watch party ───────────────────────────────────────────────────────────
  {
    path: ['party', 'create'],
    summary: 'Create a watch-party room for a video file',
    usage: 'mesh party create <file> [--name <title>] [--json]',
    write: true,
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
    path: ['config', 'get'],
    summary: 'Show settings (or one key)',
    usage: 'mesh config get [<key>] [--json]',
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
    run: async ({ call, positionals }) => {
      const [key, value] = positionals
      if (!key || value === undefined) throw new Error('usage: mesh config set <key> <value>')
      let coerced = value
      if (value === 'true') coerced = true
      else if (value === 'false') coerced = false
      else if (/^-?\d+$/.test(value)) coerced = Number(value)
      return call(M.SETTINGS_UPDATE, { [key]: coerced })
    }
  }
]

module.exports = { COMMANDS, short, formatBytes, expiry, shareLink, resolveDevice, resolvePending, buildSource, presetFrom }
