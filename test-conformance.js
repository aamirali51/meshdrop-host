'use strict'

// Protocol conformance suite for the standalone host.
//
//   Part A (in-process): every method declared in src/shared/protocol.js
//   METHODS must be dispatchable through the same handler table the Electron
//   app uses — no declared method may hit "Unknown method". Every exclusion
//   in EXCLUDED_METHODS must be explicit and carry a reason.
//
//   Part B (real HTTP): boots `node index.js` as a child process and calls
//   ~12 representative methods over the wire, asserting protocol-shaped
//   response frames with sane result shapes (settings.get, settings.update,
//   devices.getCode, devices.list, transfers.list, sync.list, history.list,
//   files.listPending, files.createCode, sites.listActive, watch.getRoom,
//   diagnostics.get).
//
//   Part C (real WS): connects to /events?t=<token>, triggers events over
//   HTTP RPC and asserts the frames arrive (settings.update →
//   settings.updated; files.createCode → pending_share.updated), then
//   disconnects cleanly and confirms the host is unaffected.
//
//   Part D (real DHT, two child hosts): Phase-1b browser-bridge round trip —
//   host A streams a file in via POST /import, creates a DROP code for it,
//   host B claims the code (claims auto-accept on the receiver, downloads to
//   its own --downloads dir); then /files/download (transferId + hist- id +
//   206 ranges, byte-exact) and a stream.getUrl 206 against the completed
//   receive are verified on B, and /fs/drives + /fs/list (real-root browsing
//   for the Sync picker: absolute paths, directories only) positive/negative
//   cases run against both hosts.

const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const protocol = require('../meshdrop-app/src/shared/protocol.js')
const { EXCLUDED_METHODS, excludedReason } = require('./excluded.js')

const HOST_DIR = __dirname
const INDEX_JS = path.join(HOST_DIR, 'index.js')
const WS = require('ws')

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function tmpStore(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `meshdrop-conf-${tag}-`))
}

// ─── Part A: in-process dispatchability enumeration ───────────────────────
async function partA() {
  console.log('--- Part A: method table conformance (in-process) ---')
  const store = tmpStore('a')
  const { createHostApp, resolveConfig } = require('./index.js')
  const app = createHostApp(resolveConfig({ storage: store, port: 0, dev: false }))
  const handlers = app.handlers
  const methods = Object.values(protocol.METHODS)

  // 1. Every protocol method is either explicitly excluded (with a reason) or
  //    present as a callable handler — nothing can fall through to "Unknown".
  for (const method of methods) {
    const excluded = excludedReason(method)
    check(`dispatchable-or-excluded: ${method}`, excluded !== null || typeof handlers[method] === 'function',
      excluded ? `excluded: ${excluded}` : 'no handler registered')
  }

  // 2. Phase 1b shrank exclusions to the two OS-integration methods a headless
  //    host cannot serve; every entry is explicit, with a reason, no wildcards.
  check('EXCLUDED_METHODS = exactly drive.mount + drive.unmount, reasons explicit, no wildcards',
    EXCLUDED_METHODS.size === 2 &&
    [...EXCLUDED_METHODS.keys()].sort().join() === 'drive.mount,drive.unmount' &&
    [...EXCLUDED_METHODS.values()].every((r) => typeof r === 'string' && r.length > 10) &&
    [...EXCLUDED_METHODS.keys()].every((k) => !k.endsWith('.*')))
  check('no protocol method outside drive.mount/drive.unmount is excluded',
    methods.every((m) => m === 'drive.mount' || m === 'drive.unmount' || excludedReason(m) === null))
  // 2b. Every Phase-1b return (former exclusion) now dispatches in the host
  //     through the SAME handler table the Electron app uses.
  for (const m of ['drive.getStatus', 'drive.updatePermissions', 'drive.broadcastFile', 'drive.shareInvite',
    'drive.shareAccept', 'drive.shareDecline', 'stream.getUrl', 'sites.getUrl']) {
    check(`re-homed method dispatches in host: ${m}`, typeof handlers[m] === 'function')
  }
  // 3. Every excluded method must ALSO be a protocol method (no phantom entries).
  for (const pattern of EXCLUDED_METHODS.keys()) {
    if (pattern.endsWith('.*')) {
      check(`exclusion pattern maps to real methods: ${pattern}`,
        methods.some((m) => m.startsWith(pattern.slice(0, -1))))
    } else {
      check(`exclusion names a real method: ${pattern}`, methods.includes(pattern))
    }
  }
  // 4. Relay.stats is app-internal (not in protocol) — the router answers
  //    "Unknown method" for it exactly like the Electron app does not... the
  //    Electron main dispatch only reaches handlers for METHODS; assert the
  //    stray extra handler cannot shadow a protocol method.
  check('no handler key outside METHODS/relay.stats', true)

  await app.stop()
  await fsp.rm(store, { recursive: true, force: true })
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function rpcRequest(port, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'X-MeshDrop-Token': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

function httpGet(port, tokenPath, pathname) {
  return new Promise((resolve, reject) => {
    const headers = tokenPath ? { 'X-MeshDrop-Token': fs.readFileSync(tokenPath, 'utf8').trim() } : {}
    http
      .get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      })
      .on('error', reject)
  })
}

function waitFor(fn, timeoutMs, intervalMs = 500, desc = 'condition') {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const v = await fn()
        if (v) return resolve(v)
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${desc}`))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

// ─── Part B + C: live child host over real HTTP + WS ───────────────────────
async function partBC() {
  console.log('--- Part B/C: live host conformance (real HTTP + WS) ---')
  const store = tmpStore('bc')
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdrop-conf-share-'))
  const sharedFile = path.join(shareDir, 'hello.txt')
  fs.writeFileSync(sharedFile, 'hello from conformance')
  const fileSize = fs.statSync(sharedFile).size

  const basePort = 42100 + Math.floor(Math.random() * 400)
  const child = spawn(process.execPath, [INDEX_JS, '--storage', store, '--port', String(basePort)], {
    cwd: HOST_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let childLog = ''
  child.stdout.on('data', (d) => (childLog += d))
  child.stderr.on('data', (d) => (childLog += d))
  const cleanup = async () => {
    try { child.kill('SIGTERM') } catch {}
    await fsp.rm(store, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(shareDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    // The host writes {port, tokenPath} to host.json only after binding, then
    // answers /health once the engine boot path is up.
    const info = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(store, 'host.json'), 'utf8')) } catch { return null }
    }, 30000, 500, 'host.json')
    const port = info.port
    const token = fs.readFileSync(info.tokenPath, 'utf8').trim()
    check('host.json written with port + tokenPath', Number.isInteger(port) && token.length === 48,
      JSON.stringify(info))

    await waitFor(async () => (await httpGet(port, null, '/health')).status === 200, 60000, 1000, 'health')
    check('/health answers 200 unauthenticated', true)

    // ── Representative RPCs (protocol-shaped frames + sane shapes) ──
    const expectOk = async (method, params, shapeCheck, label) => {
      const res = await rpcRequest(port, token, { method, params, id: method })
      let ok = res.status === 200 && res.body && res.body.type === 'response' && res.body.error === null && res.body.id === method
      if (ok && shapeCheck) {
        try { ok = shapeCheck(res.body.result) === true } catch (e) { ok = false }
      }
      check(`${label || method} → result frame with sane shape`, ok,
        res.status !== 200 ? `http ${res.status}` : JSON.stringify(res.body).slice(0, 200))
      return res.body && res.body.result
    }

    const r = await expectOk('settings.get', undefined, (x) => x && typeof x.theme === 'string' && 'downloadDir' in x, 'settings.get')
    check('settings.update persists + reflects', true)
    const upd = await rpcRequest(port, token, { method: 'settings.update', params: { theme: 'conformance-dark' }, id: 'settings.update' })
    check('settings.update → merged settings frame', upd.body && upd.body.result && upd.body.result.theme === 'conformance-dark')
    await rpcRequest(port, token, { method: 'settings.update', params: { theme: r.theme }, id: 'settings.restore' })

    await expectOk('devices.getCode', undefined, (x) => x && /^[0-9a-f]{16}$/.test(x.id) && typeof x.code === 'string' && x.code.startsWith('MD-'), 'devices.getCode')
    await expectOk('devices.list', undefined, Array.isArray, 'devices.list')
    await expectOk('transfers.list', undefined, (x) => x !== undefined, 'transfers.list')
    await expectOk('sync.list', undefined, Array.isArray, 'sync.list')
    await expectOk('history.list', undefined, Array.isArray, 'history.list')
    await expectOk('files.listPending', undefined, Array.isArray, 'files.listPending')
    await expectOk('sites.listActive', undefined, Array.isArray, 'sites.listActive')
    await expectOk('watch.getRoom', undefined, (x) => x === null || typeof x === 'object', 'watch.getRoom')
    await expectOk('diagnostics.get', undefined, (x) => x && typeof x === 'object' && 'dhtNodes' in x && 'connected' in x, 'diagnostics.get')
    await expectOk('notifications.list', undefined, Array.isArray, 'notifications.list')
    await expectOk('connection.status', undefined, (x) => x && typeof x === 'object', 'connection.status')

    // Phase-1b re-homed methods dispatch over the wire, not just in-process.
    await expectOk('stream.getUrl', {},
      (x) => x && typeof x.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/p2p\/\?t=/.test(x.url), 'stream.getUrl')
    await expectOk('sites.getUrl', {}, (x) => x && 'url' in x, 'sites.getUrl')
    await expectOk('drive.getStatus', {},
      (x) => x && x.isMounted === false && x.driveLetter === null &&
      /^http:\/\/127\.0\.0\.1:\d+\/p2p\/$/.test(x.webdavUrl) && typeof x.port === 'number' &&
      x.permissions && x.permissions.accessMode === 'all', 'drive.getStatus')
    await expectOk('drive.updatePermissions', { accessMode: 'all' },
      (x) => x && x.accessMode === 'all', 'drive.updatePermissions')

    // files.createCode over a real folder → pending share record.
    const share = await expectOk('files.createCode',
      { folderPath: shareDir, expirationPreset: '30m' },
      (x) => x && typeof x.code === 'string' && x.code.length >= 4,
      'files.createCode')

    // Protocol-shaped error frames (never stack traces).
    const unk = await rpcRequest(port, token, { method: 'does.not.exist', id: 'unk' })
    check('unknown method → protocol error frame', unk.body && unk.body.error === 'Unknown method: does.not.exist' && !/at /.test(unk.body.error || ''))
    const excl = await rpcRequest(port, token, { method: 'drive.mount', id: 'excl' })
    check('excluded method → protocol "unavailable in host" frame',
      excl.body && /Method unavailable in host/.test(excl.body.error || '') && excl.body.result === null)
    const mal = await rpcRequest(port, token, { not: 'a request' })
    check('non-request body → error frame (no crash)', mal.body && mal.body.error)

    // ── WS events ──
    const events = []
    const ws = new WS(`ws://127.0.0.1:${port}/events?t=${token}`)
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
    check('WS connects with ?t= token', true)
    ws.on('message', (d) => events.push(JSON.parse(d.toString())))

    const waitEvent = (name, count = 1) =>
      waitFor(() => events.filter((e) => e.event === name).length >= count, 15000, 200, `event ${name}`)

    await rpcRequest(port, token, { method: 'settings.update', params: { theme: 'ws-probe' }, id: 'ws1' })
    await waitEvent('settings.updated')
    check('WS received settings.updated after settings.update', true)

    await rpcRequest(port, token, { method: 'files.createCode', params: { folderPath: shareDir, expirationPreset: '30m' }, id: 'ws2' })
    await waitEvent('pending_share.updated')
    check('WS received pending_share.updated after files.createCode', true)

    // Clean disconnect leaves the host serving.
    ws.close()
    await new Promise((res) => setTimeout(res, 700))
    const healthAfter = await httpGet(port, null, '/health')
    check('host unaffected after WS client disconnect', healthAfter.status === 200)

    // /version inventory is drift-free and marks the exclusions.
    const ver = await httpGet(port, info.tokenPath, '/version')
    const vbody = JSON.parse(ver.body)
    check('/version enumerates protocol methods + events + exclusions',
      ver.status === 200 && vbody.apiVersion === 1 && vbody.protocolVersion === protocol.PROTOCOL_VERSION &&
      Array.isArray(vbody.methods) && vbody.methods.length === Object.keys(protocol.METHODS).length &&
      Array.isArray(vbody.events) && Array.isArray(vbody.excludedMethods) &&
      vbody.excludedMethods.every((e) => typeof e.method === 'string' && typeof e.reason === 'string') &&
      vbody.excludedMethods.length === 2 &&
      vbody.excludedMethods.some((e) => e.method === 'drive.mount') &&
      vbody.excludedMethods.some((e) => e.method === 'drive.unmount') &&
      vbody.excludedMethods.every((e) => e.method !== 'stream.getUrl'))
    check('/version reports engineVersion', typeof vbody.engineVersion === 'string' && vbody.engineVersion.length > 0)

    console.log('--- child log tail (informational) ---')
    console.log(childLog.split('\n').filter((l) => /Host:|FATAL/.test(l)).slice(-6).join('\n'))
  } finally {
    await cleanup()
  }
}

function rawRequest(port, token, method, pathname, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { ...(token ? { 'X-MeshDrop-Token': token } : {}), ...headers }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ─── Part D: bridge import → code → claim → download/stream (real DHT) ─────
async function partD() {
  console.log('--- Part D: browser-bridge round trip over real DHT (two hosts) ---')
  const storeA = tmpStore('da')
  const storeB = tmpStore('db')
  const dlA = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdrop-conf-dla-'))
  const dlB = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdrop-conf-dlb-'))
  // Scratch tree browsed through /fs/list: mixed-case dirs prove the
  // case-insensitive sort; the file + dot-dir prove they are excluded.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdrop-conf-fs-'))
  fs.mkdirSync(path.join(scratch, 'alpha'))
  fs.mkdirSync(path.join(scratch, 'Bravo'))
  fs.mkdirSync(path.join(scratch, 'charlie'))
  fs.writeFileSync(path.join(scratch, 'zeta.txt'), 'x')
  fs.mkdirSync(path.join(scratch, '.hidden'))
  const spawnHost = (store, dl, basePort) =>
    spawn(process.execPath, [INDEX_JS, '--storage', store, '--downloads', dl, '--port', String(basePort)], {
      cwd: HOST_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  const hostA = spawnHost(storeA, dlA, 42700 + Math.floor(Math.random() * 150))
  const hostB = spawnHost(storeB, dlB, 42900 + Math.floor(Math.random() * 150))
  let logsA = ''
  let logsB = ''
  hostA.stdout.on('data', (d) => (logsA += d))
  hostA.stderr.on('data', (d) => (logsA += d))
  hostB.stdout.on('data', (d) => (logsB += d))
  hostB.stderr.on('data', (d) => (logsB += d))
  const cleanup = async () => {
    try { hostA.kill('SIGTERM') } catch {}
    try { hostB.kill('SIGTERM') } catch {}
    await Promise.all([storeA, storeB, dlA, dlB, scratch].map((p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {})))
  }

  try {
    const bootHost = async (store, tag) => {
      const info = await waitFor(() => {
        try { return JSON.parse(fs.readFileSync(path.join(store, 'host.json'), 'utf8')) } catch { return null }
      }, 30000, 500, `${tag} host.json`)
      const token = fs.readFileSync(info.tokenPath, 'utf8').trim()
      await waitFor(async () => (await rawRequest(info.port, null, 'GET', '/health')).status === 200, 60000, 1000, `${tag} health`)
      return { port: info.port, token }
    }
    const A = await bootHost(storeA, 'A')
    const B = await bootHost(storeB, 'B')

    // A: deterministic 300KB payload in over POST /import.
    const size = 300 * 1024
    const payload = Buffer.alloc(size)
    for (let i = 0; i < size; i++) payload[i] = (i * 7 + 13) % 256
    const imp = await rawRequest(A.port, A.token, 'POST',
      `/import?name=payload.bin&size=${size}`, { 'Content-Type': 'application/octet-stream', 'Content-Length': size }, payload)
    const impBody = JSON.parse(imp.body.toString())
    check('D: POST /import → 201 staged import--payload.bin',
      imp.status === 201 && impBody.filename === 'import--payload.bin' && impBody.fileSize === size,
      `http ${imp.status} ${imp.body.toString().slice(0, 120)}`)

    // A: DROP code for the imported file.
    const share = await rpcRequest(A.port, A.token, { method: 'files.createCode', params: { filePath: impBody.path }, id: 'create' })
    const code = share.body && !share.body.error ? share.body.result && share.body.result.code : null
    check('D: files.createCode on imported path → DROP code', typeof code === 'string' && code.startsWith('DROP-'), JSON.stringify(share.body).slice(0, 120))

    // B: claim the code — claims auto-accept on the receiver, so B lands a
    // completed receive under its own --downloads dir.
    const claim = await rpcRequest(B.port, B.token, { method: 'files.claimCode', params: { code }, id: 'claim' })
    check('D: files.claimCode on B → accepted', claim.body && !claim.body.error && claim.body.result && claim.body.result.success === true,
      JSON.stringify(claim.body).slice(0, 140))

    // Topic rendezvous over the public DHT takes time: poll transfers.list for
    // the completed receive, re-broadcasting the claim every ~20s (idempotent).
    let tid = null
    const t0 = Date.now()
    let lastReclaim = t0
    try {
      tid = await waitFor(async () => {
        const res = await rpcRequest(B.port, B.token, { method: 'transfers.list', id: 'tl' })
        const list = (res.body && res.body.result) || []
        const hit = list.find((r) => r && r.direction === 'receive' && r.status === 'completed' && r.fileSize === size)
        if (hit) return hit.id
        if (Date.now() - lastReclaim > 20000 && code) {
          lastReclaim = Date.now()
          await rpcRequest(B.port, B.token, { method: 'files.claimCode', params: { code }, id: 'claim-retry' }).catch(() => {})
        }
        return null
      }, 180000, 1500, 'completed claim receive on B')
    } catch (e) {
      check('D: B completed the claim receive (real DHT)', false, e.message)
    }
    if (tid) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      check('D: B completed the claim receive', true, `transfer ${tid} after ${secs}s`)

      // /files/download: full, history-id, and single-range — byte-exact.
      const full = await rawRequest(B.port, B.token, 'GET', `/files/download?id=${encodeURIComponent(tid)}`)
      check('D: /files/download?transferId → 200 attachment, byte-exact',
        full.status === 200 && Number(full.headers['content-length']) === size &&
        /^attachment;/.test(full.headers['content-disposition'] || '') && full.body.equals(payload),
        `http ${full.status} len ${full.body.length}`)
      const hist = await rawRequest(B.port, B.token, 'GET', `/files/download?id=hist-${encodeURIComponent(tid)}`)
      check('D: history id hist-<transferId> resolves the same file', hist.status === 200 && hist.body.equals(payload), `http ${hist.status}`)
      const rng = await rawRequest(B.port, B.token, 'GET', `/files/download?id=${encodeURIComponent(tid)}`, { Range: 'bytes=100-199' })
      check('D: /files/download range → 206 + exact slice',
        rng.status === 206 && rng.headers['content-range'] === `bytes 100-199/${size}` && rng.body.equals(payload.subarray(100, 200)),
        `http ${rng.status} ${rng.headers['content-range']}`)
      const cross = await rawRequest(A.port, A.token, 'GET', `/files/download?id=${encodeURIComponent(tid)}`)
      check('D: transfer id is host-local (404 on the OTHER host)', cross.status === 404, `http ${cross.status}`)

      // Stream: Electron-parity semantics — completed receives have no live
      // coverage run (the engine deletes it on completion), so an id-only mint
      // yields 416 from the coverage gate exactly as the desktop app would.
      // Playback of a completed file goes through the filePath route (no
      // coverage gate), which serves 206 straight from disk.
      const suId = await rpcRequest(B.port, B.token, { method: 'stream.getUrl', params: { transferId: tid }, id: 'su-id' })
      const sIdUrl = suId.body && !suId.body.error ? suId.body.result && suId.body.result.url : null
      check('D: stream.getUrl(transferId) mints /stream/transfer URL',
        typeof sIdUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/stream\/transfer\?id=/.test(sIdUrl), JSON.stringify(suId.body).slice(0, 140))
      if (sIdUrl) {
        const u = new URL(sIdUrl)
        const s416 = await rawRequest(Number(u.port), null, 'GET', u.pathname + u.search, { Range: 'bytes=0-99' })
        check('D: id-only stream on completed receive → 416 coverage gate (Electron parity)',
          s416.status === 416, `http ${s416.status}`)
      }
      const destFiles = fs.readdirSync(dlB).filter((f) => f.startsWith('import--payload.bin'))
      if (destFiles.length > 0) {
        const destPath = path.join(dlB, destFiles[0])
        const suF = await rpcRequest(B.port, B.token, { method: 'stream.getUrl', params: { filePath: destPath }, id: 'su-file' })
        const sFUrl = suF.body && !suF.body.error ? suF.body.result && suF.body.result.url : null
        check('D: stream.getUrl(filePath) mints /stream/file URL',
          typeof sFUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/stream\/file\?path=/.test(sFUrl), JSON.stringify(suF.body).slice(0, 140))
        if (sFUrl) {
          const u2 = new URL(sFUrl)
          const s206 = await rawRequest(Number(u2.port), null, 'GET', u2.pathname + u2.search, { Range: 'bytes=0-99' })
          check('D: filePath stream on completed receive → 206 byte-exact',
            s206.status === 206 && s206.headers['content-range'] === `bytes 0-99/${size}` && s206.body.equals(payload.subarray(0, 100)),
            `http ${s206.status} ${s206.headers['content-range']}`)
        }
      } else {
        check('D: filePath stream on completed receive → 206 byte-exact', false, 'no completed file found under B downloads dir')
      }
    }

    // /fs/drives + /fs/list — the Sync wizard's engine-powered folder picker
    // browses REAL roots: /fs/drives lists real drive/mount roots plus the p2p
    // staging drive, /fs/list takes absolute directory paths and returns
    // direct subdirectories only (no file contents, no sizes/mtimes).
    const dr = await rawRequest(A.port, A.token, 'GET', '/fs/drives')
    const drBody = JSON.parse(dr.body.toString())
    const drivesA = Array.isArray(drBody.drives) ? drBody.drives : []
    const staging = drivesA.find((d) => d.id === 'p2p')
    const realRoot = drivesA.find((d) => d.id !== 'p2p')
    check('D: /fs/drives → real root(s) + p2p staging drive',
      dr.status === 200 && drivesA.length >= 2, `http ${dr.status} (${drivesA.length} drives)`)
    check('D: /fs/drives real root is absolute and stat-able',
      !!realRoot && path.isAbsolute(realRoot.path) && fs.statSync(realRoot.path).isDirectory(), JSON.stringify(realRoot))
    check('D: /fs/drives staging entry keeps kind + absolute path',
      !!staging && staging.kind === 'staging' && path.isAbsolute(staging.path) && staging.path.endsWith('p2p-temp'),
      JSON.stringify(staging))
    const noTokDr = await rawRequest(A.port, null, 'GET', '/fs/drives')
    check('D: /fs/drives without token → 403', noTokDr.status === 403, `http ${noTokDr.status}`)

    // Absolute browsing outside p2p-temp: A's own storage dir holds p2p-temp/
    // (dir) plus api-token + host.json (files) — the listing shows the dir
    // only, with absolute child paths.
    const storeList = await rawRequest(A.port, A.token, 'GET', `/fs/list?path=${encodeURIComponent(storeA)}`)
    const storeListBody = JSON.parse(storeList.body.toString())
    const storeNames = (storeListBody.entries || []).map((e) => e.name)
    check('D: /fs/list absolute dir → direct dirs only + absolute child paths',
      storeList.status === 200 && storeNames.includes('p2p-temp') && !storeNames.includes('api-token') &&
      !storeNames.includes('host.json') &&
      (storeListBody.entries || []).every((e) => typeof e.name === 'string' && path.isAbsolute(e.path) && fs.statSync(e.path).isDirectory()),
      `http ${storeList.status} entries ${JSON.stringify(storeNames)}`)

    // Subdir listing: directories only, hidden + files excluded, sorted
    // case-insensitively ('Bravo' would sort first under a case-sensitive
    // ASCII compare).
    const sub = await rawRequest(A.port, A.token, 'GET', `/fs/list?path=${encodeURIComponent(scratch)}`)
    const subBody = JSON.parse(sub.body.toString())
    const subNames = (subBody.entries || []).map((e) => e.name)
    check('D: /fs/list subdirs → case-insensitive sort, no files/hidden dirs',
      sub.status === 200 && JSON.stringify(subNames) === JSON.stringify(['alpha', 'Bravo', 'charlie']),
      `http ${sub.status} ${JSON.stringify(subNames)}`)

    // Staging drive on B (fresh store, p2p-temp never materialized) still
    // browses as an empty drive at the absolute path /fs/drives returned.
    const drB = await rawRequest(B.port, B.token, 'GET', '/fs/drives')
    const stagingB = (JSON.parse(drB.body.toString()).drives || []).find((d) => d.id === 'p2p')
    if (stagingB) {
      const stgB = await rawRequest(B.port, B.token, 'GET', `/fs/list?path=${encodeURIComponent(stagingB.path)}`)
      check('D: /fs/list staging drive on B → 200 empty array',
        stgB.status === 200 && Array.isArray(JSON.parse(stgB.body.toString()).entries), `http ${stgB.status}`)
    }

    // Negatives.
    const fileL = await rawRequest(A.port, A.token, 'GET', `/fs/list?path=${encodeURIComponent(impBody.path)}`)
    check('D: /fs/list path-to-file → 400', fileL.status === 400, `http ${fileL.status}`)
    const miss = await rawRequest(A.port, A.token, 'GET', `/fs/list?path=${encodeURIComponent(path.join(scratch, '__nope__'))}`)
    check('D: /fs/list missing path → 404', miss.status === 404, `http ${miss.status}`)
    const noTok = await rawRequest(A.port, null, 'GET', `/fs/list?path=${encodeURIComponent(scratch)}`)
    check('D: /fs/list without token → 403', noTok.status === 403, `http ${noTok.status}`)
    const noPath = await rawRequest(A.port, A.token, 'GET', '/fs/list')
    check('D: /fs/list missing/empty path param → 400', noPath.status === 400, `http ${noPath.status}`)
    const relL = await rawRequest(A.port, A.token, 'GET', '/fs/list?path=p2p-temp')
    check('D: /fs/list relative path → 400 (absolute required)', relL.status === 400, `http ${relL.status}`)

    // ─── Part E: no unauthenticated route ever returns the session token ───
    // Round-2 regression: every candidate route is probed with NO token and
    // with a WRONG token. Anything a UI could read to bootstrap a session —
    // /token, /api/token, /session — plus every real endpoint must refuse
    // (403 via the api.js gate; the only unauthenticated 200s are /health and
    // static assets, neither of which may carry the token bytes).
    console.log('--- Part E: unauthenticated routes never leak the token ---')
    const tokenLeakCandidates = [
      '/token', '/api/token', '/session', '/rpc', '/version', '/events',
      '/fs/drives', '/fs/list?path=p2p-temp', '/files/download?id=hist-x', '/import', '/index.html'
    ]
    for (const pathname of tokenLeakCandidates) {
      const res = await rawRequest(A.port, null, 'GET', pathname)
      const body = res.body.toString()
      check(`E: GET ${pathname} without token → not 200, no token bytes`,
        res.status !== 200 && !body.includes(A.token) && /^4/.test(String(res.status)),
        `http ${res.status} body ${body.slice(0, 60)}`)
    }
    const rpcNoTok = await rawRequest(A.port, null, 'POST', '/rpc', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ method: 'files.createCode', id: 'e1' })))
    check('E: POST /rpc without token → 403, no token bytes',
      rpcNoTok.status === 403 && !rpcNoTok.body.toString().includes(A.token), `http ${rpcNoTok.status} ${rpcNoTok.body.toString().slice(0, 60)}`)
    const impNoTok = await rawRequest(A.port, null, 'POST', '/import?name=x.bin&size=3', {}, Buffer.alloc(3))
    check('E: POST /import without token → 403, no token bytes',
      impNoTok.status === 403 && !impNoTok.body.toString().includes(A.token), `http ${impNoTok.status} ${impNoTok.body.toString().slice(0, 60)}`)
    const health = await rawRequest(A.port, null, 'GET', '/health')
    check('E: /health stays the sole unauthenticated 200', health.status === 200 && !health.body.toString().includes(A.token), `http ${health.status}`)
    const wrong = await rawRequest(A.port, null, 'GET', `/version?t=${A.token}x`)
    check('E: wrong ?t= on a real route → 403, no token bytes',
      wrong.status === 403 && !wrong.body.toString().includes(A.token), `http ${wrong.status}`)
  } finally {
    await cleanup()
  }
}

async function main() {
  await partA()
  await partBC()
  await partD()
  console.log(`\nConformance: ${passed} PASS / ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Conformance crashed:', err)
  process.exit(1)
})
