'use strict'

// MeshDrop standalone host — boots the real MeshEngine (@meshdrop-go/core) with NO
// Electron and exposes the exact app protocol (src/shared/protocol.js) over a
// token-authed localhost HTTP + WebSocket API (api.js).
//
//   node index.js [--storage <dir>] [--port <n>] [--dev]
//
// Storage defaults to ~/.meshdrop-host (never the Electron userData store).
// Port defaults to 41990 and bumps +1 on EADDRINUSE (up to 10 attempts).
// The engine store is EXCLUSIVE: a second host pointed at the same directory
// exits with a clear error (two engines on one identity = DHT flakiness).

const fs = require('fs')
const os = require('os')
const path = require('path')

const { MeshEngine } = require('@meshdrop-go/core')
const deps = require('./deps.js')
const protocol = require(deps.protocol)
const { subscribeEngineEvents } = require(deps.engineEvents)
const { registerEngineHandlers } = require(deps.handlers)
const { createStreamServer, mintStreamUrl } = require(deps.streamServer)
const { createSitesGateway, mintSitesUrl } = require(deps.sitesGateway)
const { createApiServer, loadOrCreateToken, Broadcaster, DEFAULT_PORT } = require('./api.js')
const { createBridgeHandlers, DEFAULT_MAX_IMPORT_BYTES } = require('./bridge.js')
const { isExcluded, excludedReason } = require('./excluded.js')

const API_VERSION = 1
const ENGINE_VERSION = require('@meshdrop-go/core/package.json').version
const LOCK_FILE = 'host.lock'
const TOKEN_FILE = 'api-token'
const HOST_INFO_FILE = 'host.json'

// Phase 2: built renderer UI served by default from the app repo; `--ui` can
// point elsewhere. The page loads unauthenticated; the session rides ?t=.
const DEFAULT_UI_DIR = path.join(__dirname, '..', 'meshdrop-app', 'renderer', 'dist')

// The host re-homes the Electron local servers (Phase 1b): stream/DAV server
// and the sites gateway run in-process against THIS engine, token-gated with
// the SAME api-token the HTTP API uses. Default ports match the Electron
// defaults; both bump +1 on EADDRINUSE at start.
const STREAM_PORT = 41983
const SITES_PORT = 41984

// Desktop-equivalent network profile — byte-for-byte what the Electron app
// boots with (electron/engine.js) so headless and desktop peers negotiate the
// same transfer/sync windows.
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

// ─── CLI / env config ──────────────────────────────────────────────────────
function parseArgv(argv) {
  const flags = { storage: null, port: null, downloads: null, dev: false, legacy: null }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--storage') flags.storage = argv[++i]
    else if (arg.startsWith('--storage=')) flags.storage = arg.slice('--storage='.length)
    else if (arg === '--port') flags.port = Number(argv[++i])
    else if (arg.startsWith('--port=')) flags.port = Number(arg.slice('--port='.length))
    else if (arg === '--downloads') flags.downloads = argv[++i]
    else if (arg.startsWith('--downloads=')) flags.downloads = arg.slice('--downloads='.length)
    else if (arg === '--maxImportBytes') flags.maxImportBytes = Number(argv[++i])
    else if (arg.startsWith('--maxImportBytes=')) flags.maxImportBytes = Number(arg.slice('--maxImportBytes='.length))
    else if (arg === '--ui') {
      // Optional value: --ui [dir]; a bare --ui uses the default dist dir.
      const next = argv[i + 1]
      flags.ui = next && !next.startsWith('--') ? argv[++i] : DEFAULT_UI_DIR
    } else if (arg.startsWith('--ui=')) flags.ui = arg.slice('--ui='.length)
    else if (arg === '--legacy') {
      const next = argv[i + 1]
      flags.legacy = next && !next.startsWith('--') ? argv[++i] : null
    } else if (arg.startsWith('--legacy=')) flags.legacy = arg.slice('--legacy='.length)
    else if (arg === '--dev') flags.dev = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node index.js [--storage <dir>] [--port <n>] [--downloads <dir>] [--maxImportBytes <n>] [--ui [dir]] [--dev]\n' +
          '  --storage          engine + token store (env MESHDROP_HOST_STORAGE, default ~/.meshdrop-host)\n' +
          '  --port             API port (env MESHDROP_HOST_PORT, default 41990; +1 on EADDRINUSE)\n' +
          '  --downloads        received-file folder (env MESHDROP_HOST_DOWNLOADS, default ~/Downloads)\n' +
          '  --maxImportBytes   POST /import cap in bytes (0 or omitted = unlimited; set a\n' +
          '                     ceiling only if untrusted pages hold this host\'s token)\n' +
          '  --ui [dir]         serve the built renderer UI from this same server\n' +
          '                     (default meshdrop-app/renderer/dist; disabled if missing)\n' +
          '  --dev              allow CORS from the Vite dev server (http://localhost:5173) only'
      )
      process.exit(0)
    }
  }
  return flags
}

function resolveConfig(flags) {
  const storageDir =
    flags.storage || process.env.MESHDROP_HOST_STORAGE || path.join(os.homedir(), '.meshdrop-host')
  const downloadsDir =
    flags.downloads || process.env.MESHDROP_HOST_DOWNLOADS || path.join(os.homedir(), 'Downloads')
  const port = flags.port || Number(process.env.MESHDROP_HOST_PORT) || DEFAULT_PORT
  return {
    storageDir: path.resolve(storageDir),
    downloadsDir,
    deviceName: os.hostname(),
    port,
    maxImportBytes: Number.isFinite(flags.maxImportBytes) && flags.maxImportBytes > 0
      ? flags.maxImportBytes
      : DEFAULT_MAX_IMPORT_BYTES,
    dev: flags.dev,
    uiDir: flags.ui ? path.resolve(flags.ui) : null,
    legacyDir: flags.legacy ? path.resolve(flags.legacy) : (process.env.MESHDROP_HOST_LEGACY ? path.resolve(process.env.MESHDROP_HOST_LEGACY) : null),
    label: path.basename(path.resolve(storageDir)) || 'host'
  }
}

// ─── Single-instance lock ──────────────────────────────────────────────────
// Exclusive ownership of the engine store. Stale locks (dead pid) are
// reclaimed; a live holder — another host, or the Electron app pointed at
// the same store — aborts the boot with a clear error.
function acquireStoreLock(storageDir, label) {
  fs.mkdirSync(storageDir, { recursive: true })
  const lockPath = path.join(storageDir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(
        fd,
        JSON.stringify({ app: 'meshdrop-host', pid: process.pid, startedAt: new Date().toISOString() })
      )
      fs.closeSync(fd)
      return lockPath
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let holder = null
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      } catch {}
      const holderPid = holder && typeof holder.pid === 'number' ? holder.pid : null
      // Liveness = the pid exists AND still looks like a MeshDrop/Node process.
      // A bare pid check is not enough: pids are reused, so a dead host's pid
      // can be taken by an unrelated process (e.g. svchost), which would
      // otherwise block this store forever.
      if (!holderPid || (pidAlive(holderPid) && isMeshProcess(holderPid))) {
        console.error(
          `[Host:${label}] FATAL: storage dir ${storageDir} is already in use (pid ${holderPid || 'unknown'} — another MeshDrop host, or the Electron app sharing this store). ` +
            'Two engines on one identity corrupt the DHT state; pick a different --storage or stop the other process.'
        )
        process.exit(1)
      }
      // Holder pid is dead — stale lock, reclaim it.
      try {
        fs.unlinkSync(lockPath)
      } catch {}
    }
  }
  throw new Error(`could not acquire store lock at ${lockPath}`)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Does `pid` still belong to a MeshDrop/Node process? Guards against pid reuse.
// On any doubt it returns true, so a lock we cannot disprove is never stolen.
function isMeshProcess(pid) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }
  try {
    if (process.platform === 'win32') {
      const out = require('child_process').execFileSync(
        'tasklist',
        ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
        opts
      )
      return /node\.exe|MeshDrop\.exe|electron\.exe/i.test(out)
    }
    if (process.platform === 'linux') {
      return /node|meshdrop/i.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8'))
    }
    const out = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'comm='], opts)
    return /node|meshdrop/i.test(out)
  } catch {
    return true
  }
}

// ─── Host app ──────────────────────────────────────────────────────────────
// createHostApp is exported so the conformance suite can drive the exact boot
// + graceful-stop path in-process; `node index.js` (main) is a thin wrapper.
function createHostApp(cfg) {
  const log = (...args) => console.log(`[Host:${cfg.label}]`, ...args)
  const warn = (...args) => console.warn(`[Host:${cfg.label}]`, ...args)

  const lockPath = acquireStoreLock(cfg.storageDir, cfg.label)
  fs.mkdirSync(cfg.downloadsDir, { recursive: true })

  // api-token is the host's ONE credential: it gates /rpc, the browser-bridge
  // endpoints AND both re-homed local servers (stream/DAV + sites gateway),
  // exactly as each Electron server mints its own token for the app.
  const tokenPath = path.join(cfg.storageDir, TOKEN_FILE)
  const token = loadOrCreateToken(tokenPath)

  // Step 3: the CLI default points at meshdrop-app/renderer/dist, which may not
  // exist in dev checkouts — serve UI only when the dir really holds index.html.
  let uiDir = null
  if (cfg.uiDir) {
    if (fs.existsSync(path.join(cfg.uiDir, 'index.html'))) uiDir = cfg.uiDir
    else warn(`UI dir ${cfg.uiDir} has no index.html — serving API only`)
  }
  let legacyDir = null
  if (cfg.legacyDir) {
    if (fs.existsSync(path.join(cfg.legacyDir, 'index.html'))) legacyDir = cfg.legacyDir
    else warn(`Legacy dir ${cfg.legacyDir} has no index.html — /legacy disabled`)
  }

  const engine = new MeshEngine({
    storageDir: cfg.storageDir,
    downloadsDir: cfg.downloadsDir,
    deviceName: cfg.deviceName,
    autoAcceptOffers: false,
    networkProfile: desktopNetworkProfile()
  })

  // One broadcaster serves BOTH push sources — the shared engine-event
  // translation (engine-side) and the shared handler table's emits — so a WS
  // client sees exactly the frames the renderer sees.
  const broadcaster = new Broadcaster()

  // Local servers (shared modules, re-homed from electron/ in Phase 1b).
  // Lazily created and started on first URL mint / status probe; both bind
  // 127.0.0.1 and gate every request with the host api-token.
  let localServers = null
  function getLocalServers() {
    if (localServers) return localServers
    const driveRoot = () => {
      const dir = path.join(cfg.storageDir, 'p2p-temp')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    }
    localServers = {
      stream: createStreamServer({
        root: driveRoot,
        port: STREAM_PORT,
        tokenProvider: () => token,
        getEngine: () => engine,
        log: warn
      }),
      sites: createSitesGateway({
        port: SITES_PORT,
        tokenProvider: () => token,
        getEngine: () => engine,
        log: warn
      })
    }
    return localServers
  }

  // stream.getUrl / sites.getUrl resolvers (Phase 1b): mint tokenized URLs
  // from the host's OWN local servers — same shared helpers the Electron app
  // uses, so the two consumers can never drift.
  const getStreamUrl = async (eng, params) => {
    const { stream } = getLocalServers()
    stream.setEngine(eng || engine)
    return mintStreamUrl(stream, eng || engine, params)
  }
  const getSitesUrl = async (eng, params) => {
    const { sites } = getLocalServers()
    return mintSitesUrl(sites, eng || engine)
  }

  // Host-side Drive state (Phase 1b). The host has no Windows drive-letter
  // mount (that stays a desktop-only OS integration — drive.mount/unmount
  // remain excluded, see PHASE1B-REPORT.md), but getStatus/updatePermissions
  // are server-backed like the Electron app's.
  let drivePermissions = { accessMode: 'all', allowedDeviceIds: [] }

  const handlers = registerEngineHandlers({
    engine,
    eventSink: broadcaster,
    getLabel: () => cfg.label,
    updateAutoStart: null, // auto-start is an Electron concern (unchanged)
    getStreamUrl,
    getSitesUrl
  })
  // Host-local drive RPCs (mirror of the Electron main.js drive.* branch for
  // everything except the OS mount).
  handlers[protocol.METHODS.DRIVE_GET_STATUS] = async () => {
    const { stream } = getLocalServers()
    return {
      isMounted: false, // the host never mounts a drive letter (desktop-only)
      driveLetter: null,
      webdavUrl: `http://127.0.0.1:${stream.port()}/p2p/`,
      port: stream.port(),
      permissions: drivePermissions
    }
  }
  handlers[protocol.METHODS.DRIVE_UPDATE_PERMISSIONS] = async (params) => {
    drivePermissions = {
      accessMode: params?.accessMode || 'all',
      allowedDeviceIds: Array.isArray(params?.allowedDeviceIds)
        ? params.allowedDeviceIds
        : []
    }
    return drivePermissions
  }

  // Browser-bridge endpoints (Phase 1b): /import, /files/download, /fs/drives,
  // /fs/list — mounted on the API server behind the same api-token gate.
  const bridgeHandlers = createBridgeHandlers({
    storageDir: cfg.storageDir,
    getEngine: () => engine,
    label: cfg.label,
    maxImportBytes: cfg.maxImportBytes,
    log: warn
  })

  let startPromise = null
  let started = false
  let apiServer = null

  const getVersionInfo = () => {
    const methods = Object.values(protocol.METHODS).sort()
    const events = Object.values(protocol.EVENTS).sort()
    return {
      apiVersion: API_VERSION,
      protocolVersion: protocol.PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      methods,
      events,
      excludedMethods: methods
        .filter((m) => isExcluded(m))
        .map((m) => ({ method: m, reason: excludedReason(m) }))
    }
  }

  function sampleDiagnostics(initial = false) {
    try {
      const d = engine.getDiagnostics()
      log(
        `${initial ? 'DHT bootstrap' : 'DHT'}: dhtNodes=${d.dhtNodes} connected=${d.connected} peers=${d.connectedPeersCount} nat=${d.natType}`
      )
    } catch {}
  }

  async function start() {
    if (startPromise) return startPromise
    startPromise = (async () => {
      // API first: a port conflict fails fast, before the engine opens its
      // DHT swarm. host.json + api-token land in the store for the launcher.
      apiServer = await createApiServer({
        tokenPath,
        storageDir: cfg.storageDir,
        getLabel: () => cfg.label,
        log: warn,
        handlers,
        broadcaster,
        bridge: bridgeHandlers,
        waitEngineReady: () => start(),
        getVersionInfo,
        basePort: cfg.port,
        dev: cfg.dev,
        ui: uiDir ? { dir: uiDir } : null,
        legacy: legacyDir ? { dir: legacyDir } : null
      })
      const port = await apiServer.listen()
      apiServer.attachWebSocket()
      fs.writeFileSync(
        path.join(cfg.storageDir, HOST_INFO_FILE),
        JSON.stringify({ port, tokenPath: path.resolve(tokenPath) }, null, 2)
      )

      await engine.start()
      started = true

      // Engine events → WS frames, using the same shared translation table
      // as the Electron app (electron/engine.js).
      subscribeEngineEvents({
        engine,
        sink: broadcaster,
        hooks: {
          onEngineError: (err, kind) => {
            warn(`Engine error:`, kind === 'coded' ? err.message || err : err)
          }
        }
      })

      const identity = engine.getIdentity()
      log(`Engine ready — deviceId ${identity.deviceId}, code ${identity.pairingCode}`)
      broadcaster.send(protocol.EVENTS.WORKER_READY, {
        identity: { ...engine.deviceIdentity, pairingCode: identity.pairingCode }
      })
      log(`API listening on http://127.0.0.1:${port} (token file: ${path.resolve(tokenPath)})`)
      if (uiDir) log(`UI ready: http://127.0.0.1:${port}/?t=${token}${legacyDir ? ' (legacy at /legacy)' : ''}`)
      sampleDiagnostics(true)
      return { port }
    })().catch((err) => {
      startPromise = null
      warn(`Boot failed: ${err.message}`)
      throw err
    })
    return startPromise
  }

  async function stop() {
    started = false
    try {
      if (apiServer) await apiServer.stop()
    } catch (err) {
      warn(`API stop failed: ${err.message}`)
    }
    // Fire-and-forget like the Electron will-quit path: open media/HTTP
    // sockets must not block shutdown. Re-created lazily on next start().
    try {
      if (localServers) {
        localServers.stream.stop()
        localServers.sites.stop()
        localServers = null
      }
    } catch (err) {
      warn(`Local server stop failed: ${err.message}`)
    }
    try {
      if (engine && typeof engine.stop === 'function') await engine.stop()
    } catch (err) {
      warn(`Engine stop failed: ${err.message}`)
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {}
    log('Stopped cleanly')
  }

  return {
    engine,
    handlers,
    broadcaster,
    start,
    stop,
    isStarted: () => started,
    sampleDiagnostics,
    storageDir: cfg.storageDir,
    tokenPath,
    config: cfg
  }
}

// ─── Entry point ───────────────────────────────────────────────────────────
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error(`[Host] FATAL: Node >= 18 required (running ${process.version})`)
    process.exit(1)
  }

  const cfg = resolveConfig(parseArgv(process.argv))
  console.log(
    `[Host:${cfg.label}] MeshDrop host booting — storage ${cfg.storageDir}, downloads ${cfg.downloadsDir}, device "${cfg.deviceName}"`
  )

  const host = createHostApp(cfg)

  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[Host:${cfg.label}] ${signal} received — shutting down`)
    host
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[Host:${cfg.label}] Shutdown failed:`, err.message)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await host.start()
    // One later diagnostics sample so a live boot shows DHT convergence.
    setTimeout(() => host.sampleDiagnostics(false), 15000).unref()
  } catch (err) {
    console.error(`[Host:${cfg.label}] FATAL: ${err.message}`)
    process.exit(1)
  }
}

module.exports = { createHostApp, resolveConfig, parseArgv }

if (require.main === module) {
  main()
}
