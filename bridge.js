'use strict'

// Browser-bridge endpoints (Phase 1b). A browser launcher talks to the host
// through the API server, but HTTP fetch from a page cannot do WebDAV verbs or
// open the IPC RPC surface usefully — these routes give it the few native
// things the page needs:
//
//   POST /import?name=<filename>&size=<bytes>
//       Streams the raw request body into <storageDir>/p2p-temp/import--<name>
//       (cap: maxImportBytes, default 500MB) and returns
//       { path, filename, fileSize } so the caller can immediately
//       files.createCode the staged file.
//   GET  /files/download?id=<transferId|historyId>
//       Streams a COMPLETED receive (resolved strictly through the transfers
//       and history bees) as an attachment, with single-range 206 support.
//   GET  /fs/drives            — drive inventory: real drive/mount roots (C:,
//                                /, /Volumes/…, /media/…, /mnt/…) plus the p2p
//                                staging root, for the Sync wizard picker.
//   GET  /fs/list?path=<abs>   — DIRECT subdirectory names of an absolute
//                                directory path (400 if a file, 404 if missing),
//                                names + absolute child paths only.
//   GET  /fs/pick[?path=<abs>] — open the OS-native folder dialog ON THE HOST
//                                MACHINE and resolve { path } (absolute) or
//                                null when cancelled. The API is loopback-only,
//                                so the chooser sits at the host. Non-Windows
//                                hosts return 501 and the renderer falls back
//                                to the /fs/drives + /fs/list browser modal.
//
// Absolute-path browsing is safe behind the existing gates: the token-gated
// API already accepts arbitrary absolute paths from any token-holder
// (transfers.start takes filePath, sync.add takes path, the stream server
// serves file contents by path). A directories-only listing grants no new
// power. Every route is mounted behind the API server's token gate
// (X-MeshDrop-Token header or ?t= query) and the loopback-only Host check,
// like all /rpc calls.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const DEFAULT_MAX_IMPORT_BYTES = 500 * 1024 * 1024
const IMPORT_PREFIX = 'import--'
// The engine's staging area — where drop-share cores and imports land.
const FS_ROOT_DIR = 'p2p-temp'

function json(res, code, obj) {
  if (res.headersSent) return
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// Filenames travel in query params: strip anything that could leave the
// staging root or wreck a path (mirrors the engine's drop-share flattening).
function sanitizeName(raw) {
  const flat = String(raw || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return flat === '' || flat === '.' || flat === '..' ? 'file' : flat
}

async function uniqueStagedPath(root, name) {
  let candidate = name
  for (let n = 1; ; n++) {
    const exists = await fsp.stat(path.join(root, candidate)).then(() => true).catch(() => false)
    if (!exists) return path.join(root, candidate)
    const dot = name.lastIndexOf('.')
    candidate = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`
  }
}

// Content-Disposition that survives arbitrary unicode filenames: ASCII
// fallback plus RFC 5987 filename* for the exact bytes.
function attachmentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const enc = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, ' ')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`
}

function parseSingleRange(header, size) {
  if (!header || typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  let start = m[1] === '' ? null : Number(m[1])
  let end = m[2] === '' ? null : Number(m[2])
  if (start === null && end === null) return null
  if (start === null) start = Math.max(0, size - end)
  if (end === null) end = size - 1
  return { start, end }
}

function fsRoot(storageDir) {
  return path.join(storageDir, FS_ROOT_DIR)
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleImport(ctx, req, res, url) {
  const root = fsRoot(ctx.storageDir)
  await fsp.mkdir(root, { recursive: true })
  const name = sanitizeName(url.searchParams.get('name'))
  const declaredSize = Number(url.searchParams.get('size'))
  const maxBytes = ctx.maxImportBytes || DEFAULT_MAX_IMPORT_BYTES
  if (Number.isFinite(declaredSize) && declaredSize > 0 && declaredSize > maxBytes) {
    req.resume()
    return json(res, 413, { error: `import exceeds ${maxBytes} byte limit` })
  }

  const finalPath = await uniqueStagedPath(root, IMPORT_PREFIX + name)
  let written = 0
  let rejected = false
  try {
    // On a limit breach we stop writing but keep draining the request body so
    // the socket stays usable for the 413 response (never destroy mid-flight).
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(finalPath, { flags: 'wx' })
      req.on('data', (chunk) => {
        written += chunk.length
        if (!rejected && written > maxBytes) {
          rejected = true
          out.destroy()
        } else if (!rejected) {
          out.write(chunk)
        }
      })
      req.on('end', () => {
        if (!rejected) out.end()
        resolve()
      })
      req.on('error', reject)
      out.on('error', reject)
    })
  } catch (err) {
    await fsp.unlink(finalPath).catch(() => {})
    if (rejected || /byte limit/.test(err.message)) {
      return json(res, 413, { error: `import exceeds ${maxBytes} byte limit` })
    }
    return json(res, 400, { error: 'import failed: ' + err.message })
  }
  if (written === 0) {
    // Keep the zero-byte guard consistent with drop shares: empty files are
    // unshareable downstream, so treat it as a client error.
    await fsp.unlink(finalPath).catch(() => {})
    return json(res, 400, { error: 'empty import' })
  }
  json(res, 201, { path: finalPath, filename: path.basename(finalPath), fileSize: written })
}

async function handleDownload(ctx, req, res, url) {
  const engine = ctx.getEngine()
  if (!engine || typeof engine.getBee !== 'function') {
    return json(res, 503, { error: 'engine not ready' })
  }
  const rawId = (url.searchParams.get('id') || '').trim()
  if (!rawId) return json(res, 400, { error: 'missing id' })

  // Resolution goes through the bees ONLY: history ids (hist-<transferId>)
  // map to the transfers bee; anything else is tried as a transfer id.
  let transferId = rawId
  if (rawId.startsWith('hist-')) {
    const historyBee = await engine.getBee('history')
    const historyEntry = await historyBee.get(rawId).catch(() => null)
    const stored = historyEntry && historyEntry.value
    if (!stored) return json(res, 404, { error: 'download not found' })
    transferId = stored.transferId || rawId.slice('hist-'.length)
  }
  const transfersBee = await engine.getBee('transfers')
  const entry = await transfersBee.get(transferId).catch(() => null)
  const record = entry && entry.value
  if (!record) return json(res, 404, { error: 'download not found' })
  if (record.status !== 'completed') {
    return json(res, 409, { error: `transfer not completed (status: ${record.status || 'unknown'})` })
  }

  const filePath = record.destPath || record.filePath || null
  if (!filePath) return json(res, 410, { error: 'completed transfer has no file path' })
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return json(res, 410, { error: 'file no longer present' })
  }
  if (!stat.isFile()) return json(res, 410, { error: 'transfer path is not a file' })

  const filename = path.basename(filePath)
  const disposition = attachmentDisposition(filename)
  const range = parseSingleRange(req.headers.range, stat.size)
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': range ? range.end - range.start + 1 : stat.size,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` } : {})
  })
  const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : {})
  stream.pipe(res)
  stream.on('error', () => res.destroy())
  return new Promise((resolve) => res.on('close', resolve))
}

async function probeWindowsDrives() {
  // stat every drive letter A–Z with a per-letter timeout so a dead CD or
  // offline network drive cannot hang the probe.
  const letters = []
  await Promise.all(
    Array.from({ length: 26 }, (_, i) => {
      const letter = String.fromCharCode(65 + i)
      const probe = fsp.stat(`${letter}:\\`).then(() => { letters.push(letter) }).catch(() => {})
      const guard = new Promise((resolve) => setTimeout(resolve, 1500)).then(() => {})
      return Promise.race([probe, guard])
    })
  )
  // Volume labels are best-effort: one short PowerShell call, graceful
  // fallback to "Local Disk" on any failure (locale-neutral).
  let labels = {}
  await new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName | ConvertTo-Json -Compress'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          try {
            const parsed = JSON.parse(stdout)
            for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
              if (d && d.DeviceID && d.VolumeName) labels[d.DeviceID] = d.VolumeName
            }
          } catch {}
        }
        resolve()
      })
  })
  return { letters: letters.sort(), labels }
}

async function handleFsDrives(ctx, req, res, url) {
  const drives = []
  if (process.platform === 'win32') {
    const { letters, labels } = await probeWindowsDrives()
    for (const letter of letters) {
      const driveId = `${letter}:`
      drives.push({ id: driveId, name: `${labels[driveId] || 'Local Disk'} (${driveId})`, path: `${driveId}\\` })
    }
  } else {
    // "/" plus whatever is mounted under the conventional mount dirs.
    drives.push({ id: '/', name: 'Filesystem root', path: '/' })
    for (const base of ['/Volumes', '/media', '/mnt']) {
      let names
      try { names = await fsp.readdir(base) } catch { continue }
      for (const name of names) {
        const p = path.join(base, name)
        const st = await fsp.stat(p).catch(() => null)
        if (st && st.isDirectory()) drives.push({ id: p, name, path: p })
      }
    }
  }
  // The p2p staging drive stays in the list (absolute path) so imports remain
  // browsable; it materializes lazily on first /fs/list of a fresh store.
  drives.push({ id: 'p2p', name: `${ctx.label} (host)`, kind: 'staging', path: fsRoot(ctx.storageDir) })
  json(res, 200, { drives })
}

// path is an ABSOLUTE directory path. Only DIRECT subdirectory names are
// returned (files are addressed by id through /files/download, never by
// browsing) — the Sync wizard's folder picker can walk the real filesystem
// without exposing file contents, sizes, or mtimes.
async function handleFsList(ctx, req, res, url) {
  const given = (url.searchParams.get('path') || '').trim()
  if (!given) return json(res, 400, { error: 'missing path' })
  if (given.includes('\0')) return json(res, 400, { error: 'malformed path' })
  const absolute = process.platform === 'win32'
    ? /^[a-zA-Z]:[\\/]/.test(given) || /^\\\\/.test(given)
    : path.isAbsolute(given)
  if (!absolute) return json(res, 400, { error: 'path must be absolute' })
  const target = path.resolve(given)

  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    // The staging drive materializes on first browse so a fresh store that
    // never staged anything still opens as an empty drive (never for any
    // other path — a missing arbitrary directory is a genuine 404).
    const stagingRoot = fsRoot(ctx.storageDir)
    if (path.relative(stagingRoot, target) === '') {
      await fsp.mkdir(target, { recursive: true })
      return json(res, 200, { path: target, entries: [] })
    }
    return json(res, 404, { error: 'not found' })
  }
  if (!stat.isDirectory()) return json(res, 400, { error: 'not a directory' })

  const dirents = await fsp.readdir(target, { withFileTypes: true })
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  json(res, 200, { path: target, entries })
}

// A folder dialog can legitimately stay open for a while; anything beyond this
// is treated as cancelled (the dialog was killed/never usable).
const FS_PICK_TIMEOUT_MS = 10 * 60 * 1000

async function handleFsPick(ctx, req, res, url) {
  if (process.platform !== 'win32') {
    return json(res, 501, { error: 'native folder picker is only available on Windows hosts' })
  }
  // Optional start location (must already exist — FolderBrowserDialog cannot
  // select a directory that isn't there).
  let initial = (url.searchParams.get('path') || '').trim()
  if (initial) {
    const ok = await fsp.stat(initial).then((st) => st.isDirectory()).catch(() => false)
    if (!ok) initial = ''
  }
  // Windows PowerShell 5.1 ships with every supported Windows and is already
  // used for the /fs/drives label probe. -STA is required for WinForms; the
  // choice is written to a temp file as UTF-8 because console redirection
  // would mangle non-ASCII paths (both paths are single-quoted PS literals —
  // embedded quotes are escaped by doubling).
  const outFile = path.join(os.tmpdir(), `meshdrop-fs-pick-${process.pid}-${Date.now()}.txt`)
  const psSingle = (s) => `'${String(s).replace(/'/g, "''")}'`
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Choose a folder for MeshDrop'",
    '$d.ShowNewFolderButton = $true',
    ...(initial ? [`$d.SelectedPath = ${psSingle(initial)}`] : []),
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    `  [System.IO.File]::WriteAllText(${psSingle(outFile)}, $d.SelectedPath, [System.Text.Encoding]::UTF8)`,
    '}'
  ].join('; ')

  const err = await new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: FS_PICK_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (e) => resolve(e))
  })
  if (err && err.code !== 'ETIMEDOUT') {
    // powershell missing or died before the dialog was usable — the renderer
    // keeps its in-app browser fallback for this case.
    return json(res, 500, { error: 'could not start the native folder picker' })
  }
  let picked = null
  try {
    if (fs.existsSync(outFile)) picked = fs.readFileSync(outFile, 'utf8').trim() || null
  } catch {}
  try { fs.unlinkSync(outFile) } catch {}
  json(res, 200, { path: picked })
}

function createBridgeHandlers(opts = {}) {
  const ctx = {
    storageDir: opts.storageDir,
    getEngine: opts.getEngine || (() => null),
    label: opts.label || 'meshdrop-host',
    maxImportBytes: opts.maxImportBytes || DEFAULT_MAX_IMPORT_BYTES,
    log: opts.log || (() => {})
  }
  return [
    { path: '/import', method: 'POST', handler: (req, res, url) => handleImport(ctx, req, res, url) },
    { path: '/files/download', method: 'GET', handler: (req, res, url) => handleDownload(ctx, req, res, url) },
    { path: '/fs/drives', method: 'GET', handler: (req, res, url) => handleFsDrives(ctx, req, res, url) },
    { path: '/fs/list', method: 'GET', handler: (req, res, url) => handleFsList(ctx, req, res, url) },
    { path: '/fs/pick', method: 'GET', handler: (req, res, url) => handleFsPick(ctx, req, res, url) }
  ]
}

module.exports = {
  createBridgeHandlers,
  DEFAULT_MAX_IMPORT_BYTES,
  IMPORT_PREFIX,
  sanitizeName
}
