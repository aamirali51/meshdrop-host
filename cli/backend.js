'use strict'

// Two ways to reach an engine, behind one interface { kind, call(method, params) }:
//
//   client   — POST { method, params } to a running meshdrop-host over its
//              token-authed loopback /rpc. Fast, and the only safe option when a
//              daemon already owns the store.
//   embedded — boot @meshdrop-go/core in-process with the exact same handler table the
//              desktop app and host use, run, then stop. For one-shot commands
//              with no daemon running. Takes the same exclusive store lock the
//              host does, so two engines never share one identity.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const deps = require('../deps.js')
const DEFAULT_STORE = path.join(os.homedir(), '.meshdrop-host')
const HOST_INFO_FILE = 'host.json'
const TOKEN_FILE = 'api-token'
const LOCK_FILE = 'host.lock'

function resolveStore(flags) {
  return path.resolve(flags.store || process.env.MESH_STORE || DEFAULT_STORE)
}

function resolveDownloads(flags) {
  return path.resolve(flags.downloads || process.env.MESH_DOWNLOADS || path.join(os.homedir(), 'Downloads'))
}

// ─── client backend ─────────────────────────────────────────────────────────

function readHostInfo(store) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(store, HOST_INFO_FILE), 'utf8'))
    if (!info || !info.port) return null
    const token = fs.readFileSync(path.join(store, TOKEN_FILE), 'utf8').trim()
    if (!token) return null
    return { url: `http://127.0.0.1:${info.port}`, token }
  } catch {
    return null
  }
}

function rpc(url, token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params: params || {} })
    let u
    try {
      u = new URL('/rpc', url)
    } catch {
      return reject(new Error(`bad --host url: ${url}`))
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-MeshDrop-Token': token
        }
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          let msg
          try {
            msg = JSON.parse(data)
          } catch {
            return reject(new Error(`host returned a non-JSON response (HTTP ${res.statusCode})`))
          }
          if (msg && msg.error) {
            const e = msg.error
            return reject(new Error(typeof e === 'string' ? e : e.message || JSON.stringify(e)))
          }
          resolve(msg ? msg.result : null)
        })
      }
    )
    req.on('error', (err) => reject(new Error(`cannot reach host at ${url}: ${err.message}`)))
    req.write(body)
    req.end()
  })
}

// Subscribe to the host's /events WebSocket. Returns an unsubscribe fn.
function makeClientSubscribe(url, token) {
  return (onEvent) => {
    const { WebSocket } = require('ws')
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/events?t=' + encodeURIComponent(token))
    ws.on('message', (buf) => {
      let m
      try {
        m = JSON.parse(buf.toString())
      } catch {
        return
      }
      if (m && m.type === 'event') onEvent(m.event, m.data)
    })
    ws.on('error', (err) => onEvent('__error', { message: err.message }))
    return () => {
      try {
        ws.close()
      } catch {}
    }
  }
}

function clientBackend(url, token) {
  return {
    kind: 'client',
    target: url,
    call: (method, params) => rpc(url, token, method, params),
    subscribe: makeClientSubscribe(url, token),
    stop: async () => {}
  }
}

async function createClient(flags) {
  const explicit = flags.host || process.env.MESH_HOST
  if (explicit) {
    const token = flags.token || process.env.MESH_TOKEN
    if (!token) throw new Error('--token (or MESH_TOKEN) is required with an explicit --host')
    return clientBackend(explicit, token)
  }
  const store = resolveStore(flags)
  const info = readHostInfo(store)
  if (!info) {
    throw new Error(
      `no running MeshDrop host found for store ${store}.\n` +
        `Start one with 'mesh host' (or point at a remote one with --host <url> --token <token>), ` +
        `or run this command embedded with --embedded.`
    )
  }
  return clientBackend(info.url, info.token)
}

// ─── embedded backend ───────────────────────────────────────────────────────

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function acquireStoreLock(store) {
  fs.mkdirSync(store, { recursive: true })
  const lockPath = path.join(store, LOCK_FILE)
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, JSON.stringify({ app: 'mesh-cli', pid: process.pid, startedAt: new Date().toISOString() }))
    fs.closeSync(fd)
    return lockPath
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    let holder = null
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    } catch {}
    if (holder && typeof holder.pid === 'number' && pidAlive(holder.pid)) {
      throw new Error(
        `store ${store} is already owned by pid ${holder.pid} (a running host or another mesh command).\n` +
          `Use the running host instead (mesh --host <url> --token <token>) or pick another --store.`
      )
    }
    // Stale lock — reclaim.
    try {
      fs.unlinkSync(lockPath)
    } catch {}
    return acquireStoreLock(store)
  }
}

// Byte-for-byte the desktop/headless profile so embedded peers negotiate the
// same transfer/sync windows (mirrors meshdrop-host/index.js).
function desktopNetworkProfile() {
  return {
    kind: 'desktop',
    headBytes: 4 * 1024 * 1024,
    tailBytes: 2 * 1024 * 1024,
    lookaheadBlocks: 256,
    syncWindowBytes: 8 * 1024 * 1024,
    requestTimeoutMs: 500,
    maxConcurrentPeers: Infinity,
    lruBytes: 64 * 1024 * 1024
  }
}

async function createEmbedded(flags) {
  const { MeshEngine } = require('@meshdrop-go/core')
  const { registerEngineHandlers } = require(deps.handlers)

  const store = resolveStore(flags)
  const downloadsDir = resolveDownloads(flags)
  const lockPath = acquireStoreLock(store)
  fs.mkdirSync(downloadsDir, { recursive: true })

  const engine = new MeshEngine({
    storageDir: store,
    downloadsDir,
    deviceName: os.hostname(),
    autoAcceptOffers: false,
    networkProfile: desktopNetworkProfile()
  })

  const handlers = registerEngineHandlers({
    engine,
    eventSink: { send() {} },
    getLabel: () => 'cli',
    updateAutoStart: null,
    getStreamUrl: async () => {
      throw new Error('stream.getUrl is not available in embedded CLI mode')
    },
    getSitesUrl: async () => {
      throw new Error('sites.getUrl is not available in embedded CLI mode')
    }
  })

  await engine.start()

  const { subscribeEngineEvents } = require(deps.engineEvents)

  return {
    kind: 'embedded',
    target: store,
    engine,
    call: (method, params) => {
      const h = handlers[method]
      if (typeof h !== 'function') throw new Error(`method not supported: ${method}`)
      return h(params)
    },
    subscribe: (onEvent) => {
      subscribeEngineEvents({ engine, sink: { send: (event, data) => onEvent(event, data) } })
      return () => {}
    },
    stop: async () => {
      try {
        await engine.stop()
      } catch {}
      try {
        fs.unlinkSync(lockPath)
      } catch {}
    }
  }
}

// Resolve the backend for this invocation. Explicit --host/MESH_HOST always
// wins (client). Otherwise: use a daemon if one owns the store, else boot
// embedded (unless --client was asked for).
async function openBackend(flags) {
  if (flags.host || process.env.MESH_HOST) return createClient(flags)
  const store = resolveStore(flags)
  if (readHostInfo(store) && !flags.embedded) return createClient(flags)
  return createEmbedded(flags)
}

module.exports = {
  openBackend,
  createClient,
  createEmbedded,
  resolveStore,
  resolveDownloads,
  readHostInfo,
  DEFAULT_STORE
}
