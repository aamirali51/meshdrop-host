'use strict'

// Token-authed localhost API for the headless host. One node:http server:
//
//   POST /rpc     — {method, params, id?} dispatched through the SAME handler
//                   table the Electron app uses; answers with the exact
//                   protocol response frame (createResponse).
//   GET  /version — protocol inventory enumerated from protocol.js.
//   GET  /health  — the ONLY unauthenticated route ({ok:true}).
//   GET  /events  — WebSocket upgrade: pushes protocol event frames
//                   (createEvent JSON) built from the shared engine-events
//                   translation table.
//
// Security follows the Phase 0 loopback-server patterns exactly:
//   - X-MeshDrop-Token header (or ?t= on the WS upgrade only), compared with
//     crypto.timingSafeEqual; 403 on mismatch.
//   - Host header must be 127.0.0.1/localhost — DNS-rebinding guard.
//   - No CORS by default; --dev allow-lists http://localhost:5173 only.

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const { createResponse, createEvent } = require('../meshdrop-app/src/shared/protocol.js')
const { excludedReason } = require('./excluded.js')

const API_VERSION = 1
const DEFAULT_PORT = 41990
const MAX_PORT_ATTEMPTS = 10
const MAX_BODY_BYTES = 32 * 1024 * 1024
const TOKEN_HEX_LENGTH = 48 // 24 random bytes
const DEV_ORIGIN = 'http://localhost:5173'

// ─── Token ─────────────────────────────────────────────────────────────────
// Minted on first boot, persisted with 0600 perms, reused across restarts so
// clients and launchers can hold it indefinitely.
function loadOrCreateToken(tokenPath) {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing && /^[0-9a-f]{48}$/.test(existing)) return existing
  } catch {}
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  try {
    fs.chmodSync(tokenPath, 0o600)
  } catch {}
  return token
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// DNS-rebinding guard: the API binds 127.0.0.1 and answers only for Host
// headers naming the loopback. A malicious page that makes the browser send a
// request to http://<attacker-domain>:41990 gets a 403 instead of a response.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false
  const host = String(hostHeader).toLowerCase().split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

// Event broadcaster: protocol events → JSON frames on every connected WS.
// The shared handler table and the shared engine-event translation both push
// through here, exactly like Electron's sendToAll pushes to renderer windows.
class Broadcaster {
  constructor() {
    this.clients = new Set()
  }

  send(event, data) {
    const frame = createEvent(event, data)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame)
    }
  }

  attach(ws) {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))
  }

  closeAll() {
    for (const ws of this.clients) ws.terminate()
    this.clients.clear()
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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

function json(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

// ─── Server ────────────────────────────────────────────────────────────────
// opts: { tokenPath, storageDir, getEngine, waitEngineReady, handlers,
//         broadcaster, getExcludedInfo, bridge, basePort, dev, log }
async function createApiServer(opts) {
  const token = loadOrCreateToken(opts.tokenPath)
  const dev = !!opts.dev
  let wss = null

  const corsHeaders = (req) => {
    if (!dev) return {}
    const origin = req.headers.origin
    if (origin !== DEV_ORIGIN) return {}
    return {
      'Access-Control-Allow-Origin': DEV_ORIGIN,
      'Access-Control-Allow-Headers': 'X-MeshDrop-Token, Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    }
  }

  async function dispatchRpc(msg) {
    const method = typeof msg?.method === 'string' ? msg.method : ''
    const id = typeof msg?.id === 'string' ? msg.id : ''

    // Methods the host cannot serve yet — protocol-shaped error, never a
    // raw stack trace, never a crash.
    const reason = excludedReason(method)
    if (reason) {
      return createResponse(id, null, `Method unavailable in host: ${reason}`)
    }

    await opts.waitEngineReady()

    const handler = opts.handlers[method]
    if (!handler) throw new Error(`Unknown method: ${method}`)
    return createResponse(id, await handler(msg.params || {}), null)
  }

  const server = http.createServer(async (req, res) => {
    const label = opts.getLabel()
    try {
      if (!hostAllowed(req.headers.host)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const extra = corsHeaders(req)

      if (url.pathname === '/health') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, extra)
        return json(res, 200, { ok: true }, extra)
      }

      // Everything below is token-gated; the browser cannot attach headers to
      // a WS upgrade, so /events accepts ?t= instead.
      const queryToken = url.searchParams.get('t')
      const headerToken = req.headers['x-meshdrop-token']
      const provided = queryToken || headerToken || ''
      if (!safeEqual(provided, token)) {
        return json(res, 403, { error: 'forbidden' })
      }

      if (req.method === 'OPTIONS') {
        // Preflight (dev allowlist only). No CORS headers are ever emitted
        // when the origin is not allow-listed, so the browser blocks itself.
        if (dev && req.headers.origin === DEV_ORIGIN) {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': DEV_ORIGIN,
            'Access-Control-Allow-Headers': 'X-MeshDrop-Token, Content-Type',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
          })
          return res.end()
        }
        return json(res, 403, { error: 'forbidden' })
      }

      if (url.pathname === '/version') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, extra)
        return json(res, 200, opts.getVersionInfo(), extra)
      }

      if (url.pathname === '/rpc') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, extra)
        let body
        try {
          body = await readBody(req)
        } catch {
          return json(res, 400, { error: 'request body too large' }, extra)
        }
        let msg = null
        try {
          msg = JSON.parse(body)
        } catch {
          return json(res, 400, { error: 'invalid JSON body' }, extra)
        }
        try {
          const frame = await dispatchRpc(msg)
          json(res, 200, JSON.parse(frame), extra)
        } catch (err) {
          const id = msg && typeof msg.id === 'string' ? msg.id : ''
          json(res, 200, JSON.parse(createResponse(id, null, err?.message || String(err))), extra)
        }
        return
      }

      if (url.pathname === '/events') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        return json(res, 426, { error: 'upgrade required' })
      }

      // Browser-bridge endpoints (Phase 1b): /import, /files/download,
      // /fs/drives, /fs/list — token-gated above, loopback-host-gated by the
      // check at the top of the listener. Handlers stream their own bodies.
      if (opts.bridge) {
        for (const route of opts.bridge) {
          if (url.pathname === route.path && req.method === route.method) {
            return route.handler(req, res, url).catch((err) => {
              opts.log(`[${label}] Bridge request failed: ${err.message}`)
            })
          }
        }
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      opts.log(`[${label}] API request failed: ${err.message}`)
      try {
        json(res, 500, { error: 'internal error' })
      } catch {}
    }
  })

  // Bump +1 on EADDRINUSE up to MAX_PORT_ATTEMPTS so a leftover process on
  // the default port never wedges the host.
  async function listen() {
    let port = opts.basePort
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve()
          })
        })
        return port
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err
        port += 1
      }
    }
    throw new Error(`could not bind a free port after ${MAX_PORT_ATTEMPTS} attempts`)
  }

  // Handle upgrades manually so an unauthenticated /events request is
  // rejected with a real HTTP 403 BEFORE the socket upgrades (browsers cannot
  // set headers on a WS upgrade, so the token travels as ?t= instead).
  function attachWebSocket() {
    wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const reject = (status) => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      }
      if (!hostAllowed(req.headers.host)) return reject(403)
      let pathname = ''
      let provided = ''
      try {
        const url = new URL(req.url, 'http://localhost')
        pathname = url.pathname
        provided = url.searchParams.get('t') || ''
      } catch {}
      if (pathname !== '/events') return reject(404)
      if (!safeEqual(provided, token)) return reject(403)
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })
    wss.on('connection', (ws) => {
      opts.broadcaster.attach(ws)
    })
  }

  async function stop() {
    if (opts.broadcaster) opts.broadcaster.closeAll()
    if (wss) wss.close()
    await new Promise((resolve) => {
      if (server.listening) server.close(() => resolve())
      else resolve()
    })
  }

  return { server, listen, attachWebSocket, stop, port: () => server.address()?.port }
}

module.exports = { createApiServer, loadOrCreateToken, Broadcaster, safeEqual, DEFAULT_PORT }
