'use strict'

// Shared WebDAV/stream server core — the HTTP server behind MeshDrop "Drive"
// (PROPFIND/GET/HEAD/PUT/MKCOL/DELETE/MOVE over /p2p/) AND the media streaming
// gateway (/stream/file, /stream/transfer with 206 range + coverage-gated
// progressive playback).
//
// Phase 1b: this module was extracted from electron/webdav.js so ONE codebase
// serves two consumers — the Electron desktop app and the headless host
// (meshdrop-host). It is deliberately free of Electron imports; everything
// environment-specific is injected as config:
//
//   createStreamServer({
//     root:        string | () => string   — the directory exposed at /p2p/ (the
//                                           DAV root). A function is re-evaluated
//                                           per request (Electron's home P2PDrive).
//     port:        number (default 41983)  — first bind attempt; EADDRINUSE bumps
//                                           +1 up to initialPort+20 (legacy behavior).
//     tokenProvider: () => string|null     — when set, the returned token gates every
//                                           request (host: its api-token). When unset
//                                           the server mints its own 24-byte hex token
//                                           lazily in memory (Electron behavior).
//     getEngine:   () => engine|null       — the live @meshdrop-go/core MeshEngine used to
//                                           resolve /stream/transfer records, coverage
//                                           gates and playhead steering.
//     log:         fn                      — console-compatible logger (default console).
//     onFileCreated: fn(item)              — called after a PUT lands (Electron uses it
//                                           to broadcast the new file to peers).
//   })
//
// Returned instance: { start, stop, getToken, port, setEngine }.
// Every security gate from the original server is preserved verbatim:
// loopback-only Host header (DNS-rebinding), token gate on every request
// (X-MeshDrop-Token header or ?t= for media elements), CORS pinned to the
// renderer origins (never *).

const http = require('http')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

// P4: container sniffing for the media gateway. The sniff helper lives in the
// shared core (meshdrop-core) so desktop and mobile agree; here we only read
// the file head and cache the result per (path, mtime).
const { sniffContainer } = require('@meshdrop-go/core/engine/transfer/integrity.js')

const DEFAULT_PORT = 41983

// Constant-time token compare (timingSafeEqual). Hex tokens have a fixed
// length, so a length mismatch is an immediate reject before the compare.
function tokensEqual(a, value) {
  if (typeof value !== 'string' || !value || typeof a !== 'string' || !a) return false
  if (a.length !== value.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(value, 'utf8'))
}

// DNS-rebinding protection: never answer a request whose Host header names
// anything but this machine's loopback. A malicious webpage can force a
// browser to call 127.0.0.1 with a hostile Host header; refusing it here (403,
// no crash) closes that class of attack.
function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.trim().toLowerCase()
  if (!host || host.includes(',')) return false // folded/duplicate Host — reject
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

// CORS is pinned to the exact origins the renderer can be served from — never
// '*' (any website could otherwise read loopback responses). Electron prod
// loads the UI from file:// (opaque origin "null" over CORS); the Vite dev
// server is fixed at localhost:5173.
const ALLOWED_RENDERER_ORIGINS = new Set([
  'null',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
])

function isAllowedRendererOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_RENDERER_ORIGINS.has(origin)
}

function pinCorsHeaders(res, origin) {
  if (origin && isAllowedRendererOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-MeshDrop-Container, Content-Range, Accept-Ranges, ETag'
    )
  }
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatDateISO(date) {
  try {
    return new Date(date).toUTCString()
  } catch {
    return new Date().toUTCString()
  }
}

function generatePropfindXml(href, isFolder, size = 0, modified = new Date()) {
  const resourceType = isFolder
    ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : '<d:resourcetype/>'
  const displayname = escapeXml(path.basename(href) || 'Root')

  return `
    <d:response>
      <d:href>${escapeXml(href)}</d:href>
      <d:propstat>
        <d:prop>
          <d:displayname>${displayname}</d:displayname>
          ${resourceType}
          <d:getcontentlength>${size}</d:getcontentlength>
          <d:getlastmodified>${formatDateISO(modified)}</d:getlastmodified>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>`
}

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m4v': 'video/mp4',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

function getMimeType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

// ─── Engine helpers (module-level: they take the engine explicitly) ─────────

// Resolve a transfer id to a locally readable media path (staging .part while
// downloading, final file once complete, or a sender's own file path).
// Returns null when nothing is (yet) resolvable — callers must not hand the
// player a URL that can only 404.
async function resolveTransferStreamPath(engine, transferId) {
  if (!engine || !transferId) return null
  try {
    const bee = await engine.getBee('transfers').catch(() => null)
    if (bee) {
      const entry = await bee.get(transferId).catch(() => null)
      const rec = entry?.value
      if (!rec) return null
      // Progressive-playback gate: do NOT hand the player a .part until the
      // transfer has verified enough of the file head to be playable (moov /
      // prefix watermark). Surfacing a near-empty .part early is what caused
      // "timeline but no video" on guests.
      const playable = rec.playable === true || rec.status === 'completed'
      if (!playable) return null
      if (rec.stagingPath && fs.existsSync(rec.stagingPath)) {
        return rec.stagingPath
      }
      if (rec.destPath && fs.existsSync(rec.destPath)) {
        return rec.destPath
      }
      if (rec.filePath && fs.existsSync(rec.filePath)) {
        return rec.filePath
      }
    }
  } catch {}
  return null
}

// Fetch the persisted transfer record (manifest fileSize, staging paths, …).
async function getTransferRecord(engine, transferId) {
  if (!engine || !transferId || typeof engine.getBee !== 'function') return null
  try {
    const bee = await engine.getBee('transfers').catch(() => null)
    if (!bee) return null
    const entry = await bee.get(transferId).catch(() => null)
    return (entry && entry.value) || null
  } catch {}
  return null
}

// ─── Server factory ─────────────────────────────────────────────────────────

function createStreamServer(options = {}) {
  const log = options.log || console
  // `log` may be a console-like object or a plain function; route through the
  // channel that exists so both the Electron console and the host's prefixed
  // logger produce the same lines.
  const logInfo = (...args) => (log.log ? log.log(...args) : log(...args))
  const logWarn = (...args) => (log.warn ? log.warn(...args) : log(...args))
  const logError = (...args) => (log.error ? log.error(...args) : log(...args))
  const configRoot = options.root != null ? options.root : () => path.join(require('os').homedir(), 'P2PDrive')
  const initialPort = Number.isFinite(options.port) ? options.port : DEFAULT_PORT

  let server = null
  let activePort = initialPort
  let internalToken = null // lazily minted, only used when no tokenProvider
  let engineRef = null // last engine bound through setEngine

  const sniffCache = new Map() // `${path}:${mtimeMs}` -> containerResult
  const heldRangeWaits = new Map() // transferId -> held count
  const MAX_HELD_RANGE_WAITS = 4

  function rootDir() {
    return typeof configRoot === 'function' ? configRoot() : configRoot
  }

  function getEngine() {
    if (typeof options.getEngine === 'function') return options.getEngine()
    return engineRef
  }

  function tokenProviderToken() {
    return typeof options.tokenProvider === 'function' ? options.tokenProvider() : null
  }

  // Effective gate token: provider token (host) wins; otherwise mint our own
  // lazily, exactly like the legacy module-level getWebDAVToken().
  function effectiveToken() {
    const provided = tokenProviderToken()
    if (provided) return provided
    if (!internalToken) internalToken = crypto.randomBytes(24).toString('hex')
    return internalToken
  }

  function tokenMatches(...values) {
    const a = effectiveToken()
    for (const v of values) {
      if (typeof v !== 'string' || !v) continue
      if (tokensEqual(a, v)) return true
    }
    return false
  }

  async function sniffLocalContainer(localPath) {
    try {
      const st = await fsp.stat(localPath)
      const cacheKey = `${localPath}:${st.mtimeMs}`
      const hit = sniffCache.get(cacheKey)
      if (hit) return hit
      const fd = await fsp.open(localPath, 'r')
      try {
        const head = Buffer.alloc(Math.min(256 * 1024, st.size))
        if (head.length === 0) return null
        const { bytesRead } = await fd.read(head, 0, head.length, 0)
        const result = sniffContainer(head.subarray(0, bytesRead))
        if (result) sniffCache.set(cacheKey, result)
        // Bound the cache (a folder full of videos should not grow unbounded).
        if (sniffCache.size > 500) {
          const oldestKey = sniffCache.keys().next().value
          sniffCache.delete(oldestKey)
        }
        return result
      } finally {
        await fd.close().catch(() => {})
      }
    } catch {
      return null
    }
  }

  function resolveLocalPath(urlPath) {
    const syncRoot = rootDir()
    // Strip any ?t=<token> query (or hash) a minted URL may carry before the
    // path is mapped onto disk — the token is auth, not part of the filename.
    const cleanUrlPath = String(urlPath || '/').split('?')[0].split('#')[0]
    const decoded = decodeURIComponent(cleanUrlPath).replace(/\/+/g, '/')
    let cleanRel = decoded
    if (cleanRel.startsWith('/p2p')) {
      cleanRel = cleanRel.slice('/p2p'.length)
    }
    const safeRel = path
      .normalize(cleanRel)
      .replace(/^(\.\.[\/\\])+/, '')
      .replace(/^[/\\]+/, '')
    return path.join(syncRoot, safeRel)
  }

  async function handlePropfind(req, res, targetUrlPath) {
    res.writeHead(207, {
      'Content-Type': 'application/xml; charset="utf-8"',
      DAV: '1, 2',
      'MS-Author-Via': 'DAV'
    })

    const decoded = decodeURIComponent(targetUrlPath.split('?')[0]).replace(/\/+/g, '/')
    const localTarget = resolveLocalPath(targetUrlPath)
    let responsesXml = ''

    const reqHref = decoded.endsWith('/') ? decoded : decoded + '/'
    responsesXml += generatePropfindXml(reqHref, true)

    try {
      if (fs.existsSync(localTarget)) {
        const stat = await fsp.stat(localTarget)
        if (stat.isDirectory()) {
          const files = await fsp.readdir(localTarget, { withFileTypes: true })
          for (const f of files) {
            if (f.name === 'desktop.ini' || f.name === 'target.lnk' || f.name === 'target.url')
              continue
            const fullPath = path.join(localTarget, f.name)
            const fstat = await fsp.stat(fullPath).catch(() => null)
            if (!fstat) continue
            const isDir = fstat.isDirectory()
            const childHref = `${reqHref}${encodeURIComponent(f.name)}${isDir ? '/' : ''}`
            responsesXml += generatePropfindXml(childHref, isDir, isDir ? 0 : fstat.size, fstat.mtime)
          }
        }
      }
    } catch (err) {
      logWarn('[WebDAV] PROPFIND error:', err.message)
    }

    const xmlResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
${responsesXml}
</d:multistatus>`

    res.end(xmlResponse)
  }

  async function handleGetOrHead(req, res, targetUrlPath, isHead = false) {
    let localPath = null
    let transferId = null

    // Route: /stream/file?path=<encodedPath>
    if (targetUrlPath.startsWith('/stream/file')) {
      try {
        const u = new URL(targetUrlPath, 'http://127.0.0.1')
        const p = u.searchParams.get('path')
        if (p && fs.existsSync(p)) localPath = p
      } catch {}
    } else if (targetUrlPath.startsWith('/stream/transfer')) {
      // Route: /stream/transfer?id=<transferId>&path=<encodedPath>
      try {
        const u = new URL(targetUrlPath, 'http://127.0.0.1')
        transferId = u.searchParams.get('id')
        const fallbackPath = u.searchParams.get('path')
        if (fallbackPath && fs.existsSync(fallbackPath)) {
          localPath = fallbackPath
        }
        if (!localPath && transferId && getEngine()) {
          localPath = await resolveTransferStreamPath(getEngine(), transferId)
        }
      } catch {}
    }

    if (!localPath) {
      localPath = resolveLocalPath(targetUrlPath)
    }

    if (!fs.existsSync(localPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('File Not Found')
      return
    }

    try {
      const stat = await fsp.stat(localPath)
      if (stat.isDirectory()) {
        res.writeHead(405, { 'Content-Type': 'text/plain' })
        res.end('Cannot GET directory')
        return
      }

      // For transfer routes (.part staging files) derive MIME/container from the
      // transfer record's ORIGINAL filename (never .part), so a movie.mp4.part
      // serves as video/mp4. Falls back to localPath when no record exists.
      let transferRec = null
      if (transferId && getEngine()) {
        transferRec = await getTransferRecord(getEngine(), transferId)
      }
      const mediaPath = (transferRec && (transferRec.filename || transferRec.filePath))
        ? (transferRec.filename || transferRec.filePath)
        : localPath
      const mimeType = getMimeType(mediaPath)
      const rangeHeader = req.headers['range']

      // P4: expose the container/codec sniff so the renderer can decide native
      // vs MSE without reading the file itself. For staging paths use the
      // ORIGINAL extension (so .mp4.part gets sniffed like .mp4).
      const mediaExt = path.extname(mediaPath).toLowerCase()
      const sniff = ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.ts', '.m2ts'].includes(mediaExt)
        ? await sniffLocalContainer(localPath)
        : null
      const sniffHeader = sniff
        ? `${sniff.container}${sniff.codecs && sniff.codecs.length ? ':' + sniff.codecs.join(',') : ''}`
        : ''

      // Handle HTTP 206 Range Requests for smooth seeking in video players.
      // For transfers, `total` is the manifest fileSize, NOT the .part file's
      // current on-disk size — the staging file is written positionally, so
      // stat.size can reflect preallocation/extent growth and would make the
      // player's seek bar jitter during progressive playback.
      if (rangeHeader && stat.size > 0) {
        let total = stat.size
        if (transferId && getEngine()) {
          const rec = await getTransferRecord(getEngine(), transferId)
          if (rec && Number.isFinite(rec.fileSize) && rec.fileSize > 0) {
            total = rec.fileSize
          }
        }

        let start = 0
        let end = total - 1

        const match = /bytes=(\d*)-(\d*)/i.exec(rangeHeader)
        if (match) {
          if (match[1] && match[2]) {
            start = parseInt(match[1], 10)
            end = parseInt(match[2], 10)
          } else if (match[1]) {
            start = parseInt(match[1], 10)
            end = total - 1
          } else if (match[2]) {
            const suffix = parseInt(match[2], 10)
            start = Math.max(0, total - suffix)
            end = total - 1
          }
        }

        if (isNaN(start) || isNaN(end) || start > end || start >= total) {
          res.writeHead(416, {
            'Content-Range': `bytes */${total}`,
          })
          res.end()
          return
        }

        end = Math.min(end, total - 1)

        // Notify chunk scheduler to prioritize chunks around this playhead, and
        // mark the transfer media-active (widens the sync sender window while a
        // player is actually consuming the stream).
        const engine = getEngine()
        if (transferId && engine && typeof engine.setPlayheadByte === 'function') {
          engine.setPlayheadByte(transferId, start)
          if (typeof engine.noteMediaRead === 'function') {
            engine.noteMediaRead(transferId, start)
          }
        }

        // Coverage gate: never serve bytes from an un-downloaded region — the
        // .part has zero-filled holes there, which a player renders as black
        // frames / corruption. Coverage truth comes from the engine's
        // hypercore bitfield (survives resume), not the scheduler's LRU.
        let servedEnd = end
        if (transferId && engine) {
          // Fail safe: an engine without coverage primitives (cold init race)
          // must yield 416, never the legacy raw stream over zero-filled holes.
          if (typeof engine.coveredThrough !== 'function') {
            res.writeHead(416, {
              'Content-Range': `bytes */${total}`,
            })
            res.end()
            return
          }
          // coveredThrough is async (hypercore's has() is a Promise): a raw
          // truthy Promise would mask holes as covered.
          const coveredRaw = await engine.coveredThrough(transferId, start, end)
          const covered = Number.isFinite(coveredRaw) ? coveredRaw : null
          if (covered === null || covered < start) {
            // Uncovered: prioritize the range, then hold the response briefly
            // (an active seek should land as soon as the blocks arrive).
            if (isHead) {
              res.writeHead(416, {
                'Content-Range': `bytes */${total}`,
              })
              res.end()
              return
            }
            const held = heldRangeWaits.get(transferId) || 0
            if (held >= MAX_HELD_RANGE_WAITS) {
              res.writeHead(416, {
                'Content-Range': `bytes */${total}`,
              })
              res.end()
              return
            }
            heldRangeWaits.set(transferId, held + 1)
            try {
              if (typeof engine.prioritizeRange === 'function') {
                await engine.prioritizeRange(transferId, start, end)
              }
              const waitP = typeof engine.waitForRange === 'function'
                ? engine.waitForRange(transferId, start, 10000)
                : Promise.resolve(null)
              // Release the held slot early if the player gives up mid-wait
              // instead of pinning it for the full 10s budget.
              const closedP = new Promise((resolve) => res.on('close', resolve))
              const throughRaw = await Promise.race([waitP, closedP])
              const through = Number.isFinite(throughRaw) ? throughRaw : null
              if (through === null || through < start) {
                res.writeHead(416, {
                  'Content-Range': `bytes */${total}`,
                })
                res.end()
                return
              }
              servedEnd = Math.min(end, through)
            } finally {
              heldRangeWaits.set(transferId, Math.max(0, (heldRangeWaits.get(transferId) || 1) - 1))
            }
          } else {
            // Clamp the served range to the covered prefix. A shorter-than-
            // requested 206 is valid HTTP; players re-request the remainder.
            servedEnd = Math.min(end, covered)
          }
        }

        const chunkSize = servedEnd - start + 1
        const commonHeaders = {
          'Content-Type': mimeType,
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          DAV: '1, 2'
        }
        if (sniffHeader) commonHeaders['X-MeshDrop-Container'] = sniffHeader
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${servedEnd}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          ...commonHeaders
        })

        if (isHead) {
          res.end()
        } else {
          // Modest highWaterMark: don't pull more from disk than the player
          // consumes — the scheduler's speculative prefetch aligns with the read
          // position via setPlayheadByte above.
          const stream = fs.createReadStream(localPath, {
            start,
            end: servedEnd,
            highWaterMark: 256 * 1024
          })
          req.on('close', () => stream.destroy())
          res.on('close', () => stream.destroy())
          stream.on('error', () => stream.destroy())
          stream.pipe(res)
        }
      } else {
        const headers200 = {
          'Content-Type': mimeType,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          DAV: '1, 2'
        }
        if (sniffHeader) headers200['X-MeshDrop-Container'] = sniffHeader
        res.writeHead(200, headers200)
        if (isHead) {
          res.end()
        } else {
          const stream = fs.createReadStream(localPath, {
            highWaterMark: 1024 * 1024
          })
          req.on('close', () => stream.destroy())
          res.on('close', () => stream.destroy())
          stream.on('error', () => stream.destroy())
          stream.pipe(res)
        }
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Read Error: ${err.message}`)
    }
  }

  async function handlePut(req, res, targetUrlPath) {
    const localPath = resolveLocalPath(targetUrlPath)
    const filename = path.basename(localPath)

    if (
      !filename ||
      filename === 'desktop.ini' ||
      filename === 'target.lnk' ||
      filename === 'target.url' ||
      filename.endsWith('.tmp')
    ) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Ignored System Meta File')
      return
    }

    try {
      await fsp.mkdir(path.dirname(localPath), { recursive: true })
      const writeStream = fs.createWriteStream(localPath)
      req.pipe(writeStream)

      writeStream.on('finish', async () => {
        try {
          const stat = await fsp.stat(localPath)
          if (typeof options.onFileCreated === 'function') {
            try {
              options.onFileCreated({ filename, fileSize: stat.size, path: localPath })
            } catch {}
          }
          logInfo(`[WebDAV] File created/updated via PUT: ${filename} (${stat.size} bytes) -> ${localPath}`)
          res.writeHead(201, { 'Content-Type': 'text/plain' })
          res.end('Created')
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(`Write Error: ${err.message}`)
        }
      })

      writeStream.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(`Stream Error: ${err.message}`)
      })
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Put Init Error: ${err.message}`)
    }
  }

  async function handleMkcol(req, res, targetUrlPath) {
    const localPath = resolveLocalPath(targetUrlPath)
    try {
      await fsp.mkdir(localPath, { recursive: true })
      logInfo(`[WebDAV] Folder created via MKCOL: ${localPath}`)
      res.writeHead(201, { 'Content-Type': 'text/plain' })
      res.end('Created')
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`MKCOL Error: ${err.message}`)
    }
  }

  async function handleDelete(req, res, targetUrlPath) {
    const localPath = resolveLocalPath(targetUrlPath)
    try {
      if (fs.existsSync(localPath)) {
        await fsp.rm(localPath, { recursive: true, force: true })
        logInfo(`[WebDAV] Item deleted via DELETE: ${localPath}`)
      }
      res.writeHead(204)
      res.end()
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Delete Error: ${err.message}`)
    }
  }

  async function handleMove(req, res, targetUrlPath) {
    const srcPath = resolveLocalPath(targetUrlPath)
    const destinationHeader = req.headers['destination']
    if (!destinationHeader) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing Destination Header')
      return
    }

    try {
      const destUrl = new URL(destinationHeader, `http://127.0.0.1:${activePort}`)
      const destPath = resolveLocalPath(destUrl.pathname)
      await fsp.mkdir(path.dirname(destPath), { recursive: true })
      await fsp.rename(srcPath, destPath)
      logInfo(`[WebDAV] Item moved via MOVE: ${srcPath} -> ${destPath}`)
      res.writeHead(201, { 'Content-Type': 'text/plain' })
      res.end('Moved')
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Move Error: ${err.message}`)
    }
  }

  // One shared request handler for every route; startup port-bumping mirrors
  // the legacy electron/webdav.js behavior exactly (initial port, +1 on
  // EADDRINUSE up to initialPort + 20).
  function requestListener(p) {
    return async (req, res) => {
      // ─── Loopback lockdown (order matters) ───────────────────────────
      // 1. Host validation: this server binds 127.0.0.1 and only answers
      //    requests that name the loopback (DNS-rebinding protection).
      if (!isLoopbackHost(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      const origin = req.headers.origin
      const urlObj = new URL(req.url || '/', `http://127.0.0.1:${p}`)

      // 2. CORS preflight. A preflight can never carry the X-MeshDrop-Token
      //    header (browsers send only the CORS request headers), so OPTIONS
      //    is answered here — Host-checked, CORS pinned to the renderer's
      //    own origin (never *), and it carries no data.
      if (req.method === 'OPTIONS') {
        const preflightHeaders = {
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
          Allow: 'GET, HEAD, PROPFIND, OPTIONS, PUT, DELETE, MKCOL, MOVE',
          'Access-Control-Allow-Methods': 'GET, HEAD, PROPFIND, OPTIONS, PUT, DELETE, MKCOL, MOVE',
          'Access-Control-Allow-Headers': 'Range, If-None-Match, Content-Type, Destination, X-MeshDrop-Token'
        }
        if (origin && isAllowedRendererOrigin(origin)) {
          preflightHeaders['Access-Control-Allow-Origin'] = origin
          preflightHeaders['Vary'] = 'Origin'
        }
        res.writeHead(204, preflightHeaders)
        res.end()
        return
      }

      // 3. Token gate: header X-MeshDrop-Token or ?t= (media elements can't
      //    set headers). Constant-time compare, 403 on mismatch.
      const queryToken = urlObj.searchParams.get('t')
      const headerToken = req.headers['x-meshdrop-token']
      if (!tokenMatches(headerToken, queryToken)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden — missing or invalid token. Open media through the MeshDrop Go app.')
        return
      }

      // 4. CORS pinning for the (token-authenticated) response itself.
      pinCorsHeaders(res, origin)

      const urlPath = req.url || '/'

      if (req.method === 'PROPFIND') {
        await handlePropfind(req, res, urlPath)
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await handleGetOrHead(req, res, urlPath, req.method === 'HEAD')
        return
      }

      if (req.method === 'PUT') {
        await handlePut(req, res, urlPath)
        return
      }

      if (req.method === 'MKCOL') {
        await handleMkcol(req, res, urlPath)
        return
      }

      if (req.method === 'DELETE') {
        await handleDelete(req, res, urlPath)
        return
      }

      if (req.method === 'MOVE') {
        await handleMove(req, res, urlPath)
        return
      }

      res.writeHead(200)
      res.end()
    }
  }

  function start(startOptions = {}) {
    const firstPort = Number.isFinite(startOptions.port) ? startOptions.port : initialPort
    if (server && activePort) return Promise.resolve(activePort)

    return new Promise((resolve, reject) => {
      function tryPort(p) {
        const s = http.createServer(requestListener(p))

        s.listen(p, '127.0.0.1', () => {
          server = s
          activePort = p
          logInfo(`[WebDAV] Direct Unified Drive listening on http://127.0.0.1:${activePort}/p2p/`)
          resolve(activePort)
        })

        s.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && p < firstPort + 20) {
            logWarn(`[WebDAV] Port ${p} in use, trying port ${p + 1}...`)
            tryPort(p + 1)
          } else {
            logError('[WebDAV] Server error:', err.message)
            reject(err)
          }
        })
      }

      tryPort(firstPort)
    })
  }

  function stop() {
    // Mirrors the legacy electron/webdav.js stopWebDAVServer: close() is fired
    // without waiting for open connections to drain (will-quit must not hang
    // on a player socket), the ref drops, and the token resets so the next
    // start mints a fresh one. A provider token (host api-token) outlives the
    // instance by design.
    if (server) {
      server.close()
      server = null
    }
    if (!tokenProviderToken()) internalToken = null
    logInfo('[WebDAV] Server stopped')
  }

  function setEngine(engine) {
    engineRef = engine
    if (typeof options.setEngine === 'function') options.setEngine(engine)
  }

  return {
    start,
    stop,
    setEngine,
    // Effective gate token — media URLs embed it as ?t= (minted on demand).
    getToken: effectiveToken,
    // Last bound port while running; the configured default before/after
    // (legacy getDriveStatus reported the module default the same way).
    port: () => activePort || initialPort
  }
}

// Mint a tokenized stream URL for (transferId | filePath | bare DAV root) —
// the exact legacy electron/main.js getStreamUrl body, so the Electron app
// and the host can never drift. `params` shape: { transferId, filePath }.
async function mintStreamUrl(server, engine, params) {
  await server.start().catch(() => {})
  const port = server.port()
  const token = server.getToken()
  const withToken = (baseUrl) => {
    const sep = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${sep}t=${token}`
  }
  if (params?.transferId) {
    // With an explicit filePath the player is expected to have the file
    // locally (host side / claim playback) — keep the URL unconditional.
    if (params?.filePath) {
      return {
        url: withToken(
          `http://127.0.0.1:${port}/stream/transfer?id=${encodeURIComponent(params.transferId)}&path=${encodeURIComponent(params.filePath)}`
        )
      }
    }
    // Otherwise (e.g. watch party guest) only hand out a URL when something
    // is actually resolvable — never a guaranteed 404.
    const resolvable = await resolveTransferStreamPath(engine, params.transferId)
    if (!resolvable) return { url: null }
    return {
      url: withToken(
        `http://127.0.0.1:${port}/stream/transfer?id=${encodeURIComponent(params.transferId)}`
      )
    }
  }
  if (params?.filePath) {
    return {
      url: withToken(`http://127.0.0.1:${port}/stream/file?path=${encodeURIComponent(params.filePath)}`)
    }
  }
  return { url: withToken(`http://127.0.0.1:${port}/p2p/`) }
}

module.exports = {
  createStreamServer,
  mintStreamUrl,
  resolveTransferStreamPath,
  getTransferRecord,
  DEFAULT_PORT
}
