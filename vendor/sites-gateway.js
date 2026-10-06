'use strict'

// Shared MeshDrop Go Sites HTTP gateway — serves live visits and hosted sites
// over a tokenized loopback URL (the "Open in Browser" surface). Phase 1b:
// extracted from electron/sites-gateway.js so ONE codebase serves both the
// Electron desktop app and the headless host (meshdrop-host).
//
// Deliberately free of Electron imports; environment specifics are injected:
//
//   createSitesGateway({
//     port:         number (default 41984)  — first bind attempt; EADDRINUSE
//                                             bumps +1 up to initialPort+20.
//     tokenProvider: () => string|null       — when set, the returned token gates
//                                             every request (host: its api-token).
//                                             When unset the gateway mints its own
//                                             24-byte hex token lazily (Electron).
//     getEngine:   () => engine|null         — the live @meshdrop-go/core MeshEngine
//                                             (readSiteFile / listSitePath /
//                                             getActiveVisit / siteServer …).
//     log:         fn                        — console-compatible logger.
//   })
//
// Returned instance: { start, stop, setEngine, getUrl, resetToken }.
// Route/token semantics are preserved verbatim from the original module,
// including the per-visit token gate (?t= on every rewritten asset, referer
// fallback) and the HTML/CSS token rewrite for self-contained sites.

const http = require('http')
const crypto = require('crypto')
const { getSiteMimeType } = require('@meshdrop-go/core/siteProtocol')

const DEFAULT_PORT = 41984

function createSitesGateway(options = {}) {
  const log = options.log || console
  const logInfo = (...args) => (log.log ? log.log(...args) : log(...args))
  const initialPort = Number.isFinite(options.port) ? options.port : DEFAULT_PORT

  let server = null
  let activePort = initialPort
  let internalToken = null
  let engineRef = null

  function setEngine(engine) {
    engineRef = engine
    if (typeof options.setEngine === 'function') options.setEngine(engine)
  }

  function getEngine() {
    if (typeof options.getEngine === 'function') return options.getEngine()
    return engineRef
  }

  function tokenProviderToken() {
    return typeof options.tokenProvider === 'function' ? options.tokenProvider() : null
  }

  // Effective gate token: provider token (host) wins; otherwise mint our own
  // lazily on first use (legacy behavior).
  function effectiveToken() {
    const provided = tokenProviderToken()
    if (provided) return provided
    if (!internalToken) internalToken = crypto.randomBytes(24).toString('hex')
    return internalToken
  }

  function resetToken() {
    // Only a self-minted token can be rotated; a provider token (host
    // api-token) is owned by the caller.
    if (!tokenProviderToken()) internalToken = null
  }

  function getActiveVisit() {
    const engine = getEngine()
    try { return engine && typeof engine.getActiveVisit === 'function' ? engine.getActiveVisit() : null } catch { return null }
  }

  function getSitesList() {
    const engine = getEngine()
    try {
      if (engine && engine.siteServer && typeof engine.siteServer.listActiveSites === 'function') return engine.siteServer.listActiveSites()
      if (engine && typeof engine.listSites === 'function') return []
    } catch {}
    return []
  }

  function getUrl() {
    return `http://127.0.0.1:${activePort}/?t=${effectiveToken()}`
  }

  function hasValidToken(url, headers) {
    const token = effectiveToken()
    const t = url.searchParams.get('t')
    if (t && t === token) return true
    const ref = headers.referer || headers.referrer || headers.referer || ''
    if (ref) {
      try { if (new URL(ref, `http://127.0.0.1:${activePort}`).searchParams.get('t') === token) return true } catch {}
      // Fallback: raw string search
      if (ref.includes(`t=${token}`)) return true
    }
    return false
  }

  function rewriteHtml(html, token) {
    if (!token || typeof html !== 'string') return html
    // Inject base-like token handling: rewrite relative href/src to absolute with ?t=
    let out = html.replace(/(href|src|action)\s*=\s*["']([^"']+)["']/gi, (m, attr, url) => {
      const u = String(url).trim()
      if (!u || /^(https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(u)) return m
      if (u.startsWith('?') || u.startsWith('#')) return m
      // Already has token
      if (u.includes(`t=${token}`)) return m
      // Absolute path: /assets/... -> /assets/...?t=TOKEN
      if (u.startsWith('/')) {
        const sep = u.includes('?') ? '&' : '?'
        return `${attr}="${u}${sep}t=${token}"`
      }
      // Relative: ../assets/css/... or assets/... or ./file.html -> /assets/... or /file.html
      let cleaned = u.split('?')[0].split('#')[0]
      const query = u.includes('?') ? '?' + u.split('?').slice(1).join('?').split('#')[0] : ''
      const hash = u.includes('#') ? '#' + u.split('#').slice(1).join('#') : ''
      // Strip leading ./ and ../ repeatedly
      cleaned = cleaned.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '').replace(/^\//, '')
      const abs = '/' + cleaned
      const sep = abs.includes('?') ? '&' : '?'
      // Preserve original query if any
      const finalQuery = query ? query + `&t=${token}` : `?t=${token}`
      const finalHash = hash
      return `${attr}="${abs}${finalQuery}${finalHash}"`
    })
    // Also rewrite url(...) inside style tags / inline styles in CSS files will be handled at serve time for CSS
    // Inject a tiny script to fix any remaining dynamic fetches
    const inject = `<script>(function(){try{var t="${token}";var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(u&&u.indexOf("t=")===-1&&u.indexOf("http")!==0&&u.indexOf("data:")!==0){u+=(u.indexOf("?")===-1?"?":"&")+"t="+t}return o.apply(this,arguments)};var f=window.fetch;if(f)window.fetch=function(u,o){if(typeof u==="string"&&u.indexOf("t=")===-1&&u.indexOf("http")!==0&&u.indexOf("data:")!==0){u+=(u.indexOf("?")===-1?"?":"&")+"t="+t}return f.call(this,u,o)}}catch(e){}})();</script>`
    if (out.includes('</head>')) out = out.replace('</head>', inject + '</head>')
    else if (out.includes('<head>')) out = out.replace('<head>', '<head>' + inject)
    return out
  }

  function rewriteCss(css, token) {
    if (!token || typeof css !== 'string') return css
    return css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, url) => {
      const u = String(url).trim()
      if (!u || /^(https?:|data:|blob:|#|\/\/)/i.test(u)) return m
      if (u.includes(`t=${token}`)) return m
      if (u.startsWith('/')) {
        const sep = u.includes('?') ? '&' : '?'
        return `url("${u}${sep}t=${token}")`
      }
      let cleaned = u.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '').replace(/^\//, '')
      const abs = '/' + cleaned
      return `url("${abs}?t=${token}")`
    })
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function chooserHtml(sites) {
    const items = (sites || []).map((s) => `<tr><td><a href="/?t=${effectiveToken()}&siteId=${encodeURIComponent(s.siteId)}">${escapeHtml(s.name)}</a></td><td class="muted">${escapeHtml(s.code || '')}</td></tr>`).join('')
    return `<!doctype html><html><head><meta charset="utf-8"><title>MeshDrop Go Sites</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;max-width:760px;margin:2rem auto;padding:0 1rem}h1{font-size:1.2rem;border-bottom:1px solid #ffffff1a;padding-bottom:.6rem}table{width:100%;border-collapse:collapse}td{padding:.4rem .2rem;border-bottom:1px solid #ffffff0d}a{color:#58a6ff;text-decoration:none}.muted{color:#7d8590;text-align:right;font-size:.8rem}</style></head><body><h1>MeshDrop Go Sites</h1><table>${items || '<tr><td class="muted">No sites published</td></tr>'}</table></body></html>`
  }

  function isVideo(name) { return /\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|flv|wmv|mpg|3gp)$/i.test(name) }
  function isImage(name) { return /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)$/i.test(name) }
  function fmtBytes(n) { if (!n) return '—'; const u=['B','KB','MB','GB']; let i=0; let v=n; while(v>=1024&&i<u.length-1){v/=1024;i++} return `${v.toFixed(v>=10?0:1)} ${u[i]}` }
  function indexHtml(visit, path, entries) {
    const siteParam = visit.siteId ? `&siteId=${encodeURIComponent(visit.siteId)}` : ''
    const token = effectiveToken()
    const crumbs = String(path||'/').split('/').filter(Boolean)
    let crumbHtml = `<a href="/?t=${token}${siteParam}&path=%2F">/</a>`
    let acc = ''
    crumbs.forEach((c,i) => { acc += '/' + c; crumbHtml += ` <span style="opacity:.4">/</span> <a href="/?t=${token}${siteParam}&path=${encodeURIComponent(acc)}">${escapeHtml(c)}</a>` })
    const parentLink = path && path !== '/' ? `<a class="parent" href="/?t=${token}${siteParam}&path=${encodeURIComponent(path.split('/').slice(0,-1).join('/')||'/')}">↑ Up</a>` : ''
    const dirs = entries.filter(e=>e.type==='dir')
    const files = entries.filter(e=>e.type==='file')
    const dirCards = dirs.map(e => `<a class="folder" data-path="${escapeHtml(e.path)}" href="/?t=${token}${siteParam}&path=${encodeURIComponent(e.path)}"><span class="fi">📁</span><span class="name">${escapeHtml(e.name)}</span></a>`).join('')
    const fileCards = files.map(e => {
      const vid = isVideo(e.name)
      const img = isImage(e.name)
      const raw = `/raw?t=${token}${siteParam}&path=${encodeURIComponent(e.path)}`
      const dl = `/download?t=${token}${siteParam}&path=${encodeURIComponent(e.path)}`
      const thumb = img ? `<img class="thumb" loading="lazy" src="${raw}" alt="">` : (vid ? `<video class="thumb" muted preload="metadata" src="${raw}#t=0.5"></video><span class="play">▶</span>` : `<span class="file-icon">📄</span>`)
      const kind = vid ? 'video' : (img ? 'image' : 'file')
      return `<div class="card" data-kind="${kind}" data-path="${escapeHtml(e.path)}" data-raw="${raw}" title="${escapeHtml(e.name)}"><div class="thumb-wrap">${thumb}</div><div class="meta"><span class="name">${escapeHtml(e.name)}</span><span class="size">${fmtBytes(e.size||0)}</span></div><a class="dl" href="${dl}" download onclick="event.stopPropagation()">⬇</a></div>`
    }).join('')
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visit.name||'Shared Folder')}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:#060a12;color:#e2e8f0;min-height:100vh}
.top{position:sticky;top:0;z-index:10;backdrop-filter:blur(16px);background:rgba(6,10,18,.85);border-bottom:1px solid rgba(255,255,255,.06);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-weight:900;letter-spacing:-.02em;font-size:15px;display:flex;align-items:center;gap:8px}
.brand b{color:#6366f1}
.crumbs{font-size:12px;color:#94a3b8}
.crumbs a{color:#94a3b8;text-decoration:none}.crumbs a:hover{color:#e2e8f0}
.search{flex:0 1 280px;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:9999px;padding:6px 12px}
.search input{background:transparent;border:0;outline:0;color:#e2e8f0;width:100%;font-size:12px}
.search input::placeholder{color:#64748b}
.view{padding:18px 20px;max-width:1200px;margin:0 auto}
.toolbar{display:flex;align-items:center;gap:10px;margin:6px 0 14px}
.toolbar .count{font-size:11px;color:#64748b;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.toolbar .parent{margin-left:auto;font-size:12px;color:#60a5fa;text-decoration:none;border:1px solid rgba(96,165,250,.25);padding:5px 10px;border-radius:9999px;background:rgba(96,165,250,.08)}
.folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.folder{display:flex;align-items:center;gap:10px;padding:14px 12px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);text-decoration:none;color:#e2e8f0;font-weight:700;font-size:13px}
.folder:hover{background:rgba(255,255,255,.07)}
.folder .fi{font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.card{position:relative;overflow:hidden;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);cursor:pointer;transition:transform .15s}
.card:hover{transform:translateY(-1px);border-color:rgba(99,102,241,.35)}
.thumb-wrap{position:relative;aspect-ratio:16/9;background:rgba(255,255,255,.03);display:grid;place-items:center;overflow:hidden}
.thumb{width:100%;height:100%;object-fit:cover;display:block}
.file-icon{font-size:28px;opacity:.6}
.play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);color:white;border-radius:9999px;width:36px;height:36px;display:grid;place-items:center;font-size:14px;border:1px solid rgba(255,255,255,.15)}
.meta{padding:10px 10px 8px;display:flex;flex-direction:column;gap:2px}
.meta .name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .size{font-size:11px;color:#94a3b8}
.card .dl{position:absolute;right:8px;top:8px;background:rgba(0,0,0,.55);color:#e2e8f0;border:1px solid rgba(255,255,255,.15);border-radius:9999px;width:26px;height:26px;display:grid;place-items:center;text-decoration:none;font-size:12px}
.empty{padding:40px;text-align:center;color:#94a3b8}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
.lightbox.open{display:flex}
.lightbox img,.lightbox video{max-width:min(1100px,96vw);max-height:88vh;border-radius:12px;background:#000}
.lightbox .close{position:fixed;right:16px;top:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#e2e8f0;border-radius:9999px;width:36px;height:36px;display:grid;place-items:center;cursor:pointer}
.hidden{display:none !important}
</style></head><body>
<div class="top"><div class="brand">⬢ ${escapeHtml(visit.name||'Shared Folder')} <span style="font-weight:600;color:#94a3b8;font-size:12px;margin-left:6px">${escapeHtml(visit.code||'')}</span></div><div class="crumbs">${crumbHtml}</div><label class="search"><span>⌕</span><input id="q" placeholder="Search files…" autocomplete="off"></label></div>
<div class="view">
  <div class="toolbar"><span class="count">${dirs.length} folders · ${files.length} files</span>${parentLink}</div>
  ${dirs.length?`<div class="folders">${dirCards}</div>`:''}
  ${files.length?`<div class="grid" id="grid">${fileCards}</div>`:`<div class="empty">Empty folder</div>`}
</div>
<div class="lightbox" id="lb"><button class="close" id="lbClose">✕</button><div id="lbBody"></div></div>
<script>
(function(){
  const token="${token}";
  const q=document.getElementById('q');
  const grid=document.getElementById('grid');
  if(q&&grid){ q.addEventListener('input',()=>{ const v=q.value.toLowerCase().trim(); grid.querySelectorAll('.card').forEach(c=>{ const n=c.querySelector('.name').textContent.toLowerCase(); c.classList.toggle('hidden', v && !n.includes(v)) }) }) }
  const lb=document.getElementById('lb'), lbBody=document.getElementById('lbBody'), lbClose=document.getElementById('lbClose');
  function openImage(src, name){ lbBody.innerHTML='<img src="'+src+'" alt="">'; lb.classList.add('open') }
  function openVideo(src){ lbBody.innerHTML='<video src="'+src+'" controls autoplay playsinline></video>'; lb.classList.add('open') }
  function close(){ lb.classList.remove('open'); lbBody.innerHTML='' }
  lbClose.addEventListener('click', close);
  lb.addEventListener('click', (e)=>{ if(e.target===lb) close() });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close() });
  document.getElementById('grid')?.addEventListener('click', (e)=>{
    const card=e.target.closest('.card'); if(!card) return;
    const kind=card.dataset.kind, raw=card.dataset.raw;
    if(kind==='image'){ openImage(raw) }
    else if(kind==='video'){ openVideo(raw) }
    else { window.open(raw, '_blank') }
  });
  document.getElementById('grid')?.addEventListener('dblclick', (e)=>{
    const card=e.target.closest('.card'); if(!card) return;
    const kind=card.dataset.kind, raw=card.dataset.raw;
    if(kind==='image'){ openImage(raw) }
    else if(kind==='video'){ openVideo(raw) }
  });
})();
</script></body></html>`
  }

  async function handleRaw(req, res, path, isDownload, siteId) {
    const engine = getEngine()
    const visit = getActiveVisit()
    const sites = getSitesList()
    // A siteId-scoped request (in-app player per share) can resolve even when
    // several visits are open: the engine addresses that specific visit. Without
    // a siteId we fall back to the single active visit / host-site behavior.
    if (!siteId && !visit && sites.length === 0) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Not visiting any site'); return }
    try {
      const rangeHeader = req.headers.range
      const ifNoneMatch = req.headers['if-none-match'] ? String(req.headers['if-none-match']).replace(/"/g, '') : undefined
      const result = await engine.readSiteFile(path, { range: rangeHeader || undefined, ifNoneMatch }, siteId || undefined)
      if (result && result.status === 'not-modified') {
        res.writeHead(304, { ETag: `"${result.etag}"`, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' })
        res.end(); return
      }
      if (!result || result.status !== 'ok') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return }
      const start = typeof result.start === 'number' ? result.start : 0
      const end = typeof result.end === 'number' ? result.end : (result.size || 1) - 1
      const total = result.size || 0
      let mime = result.mime || getSiteMimeType(path)
      let body = result.body
      // Rewrite CSS url(...) to include token (for self-contained sites)
      if (mime.includes('text/css')) body = Buffer.from(rewriteCss(body.toString('utf8'), effectiveToken()))
      const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Content-Length': body.length, ETag: result.etag ? `"${result.etag}"` : undefined, 'Cache-Control': 'public, max-age=60' }
      if (result.headers) Object.assign(headers, result.headers)
      for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k]
      if (isDownload) { const name = String(path || 'file').split('/').filter(Boolean).pop() || 'file'; headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name)}"` }
      if (rangeHeader) { headers['Content-Range'] = `bytes ${start}-${end}/${total}`; res.writeHead(206, headers) } else res.writeHead(200, headers)
      res.end(body)
    } catch (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Read failed: ${err.message}`) }
  }

  async function handleList(req, res, path) {
    const engine = getEngine()
    const visit = getActiveVisit()
    if (!visit) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not visiting any site' })); return }
    try {
      const entries = await engine.listSitePath(path || '/')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true, path: path || '/', entries: entries || [] }))
    } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })) }
  }

  async function handleWrite(req, res, path) {
    const engine = getEngine()
    const visit = getActiveVisit()
    if (!visit) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Not visiting'); return }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    try {
      const result = await engine.writeSiteFile(path, body)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) { const code = /read-only/i.test(err.message) ? 403 : 500; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })) }
  }

  function start(startOptions = {}) {
    const firstPort = Number.isFinite(startOptions.port) ? startOptions.port : initialPort
    if (server && activePort) return Promise.resolve(activePort)
    return new Promise((resolve, reject) => {
      function tryPort(p) {
        const s = http.createServer(async (req, res) => {
          try {
            const url = new URL(req.url || '/', `http://127.0.0.1:${p}`)
            if (!hasValidToken(url, req.headers)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden — missing token. Open via the MeshDrop Go Shared Folders → Open in Browser button.'); return }
            const engine = getEngine()
            // Universal: any GET for a file extension is a raw file serve (CSS/JS/images/fonts/etc.)
            const ext = url.pathname.split('.').pop()?.toLowerCase() || ''
            const isAssetExt = ['css','js','mjs','json','map','svg','png','jpg','jpeg','gif','webp','avif','ico','woff','woff2','ttf','otf','eot','mp4','webm','mp3','ogg','wav','pdf','txt','xml','wasm'].includes(ext)
            if (req.method === 'GET' && isAssetExt && url.pathname !== '/') {
              const assetPath = url.pathname
              try {
                const r = await engine.readSiteFile(assetPath, {})
                if (r && r.status === 'ok' && r.body) {
                  const ct = r.mime || getSiteMimeType(assetPath)
                  let body = r.body
                  if (ct.includes('text/html')) body = Buffer.from(rewriteHtml(body.toString('utf8'), effectiveToken()))
                  else if (ct.includes('text/css')) body = Buffer.from(rewriteCss(body.toString('utf8'), effectiveToken()))
                  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' })
                  res.end(body); return
                }
              } catch {}
            }
            const path = url.searchParams.get('path') || '/'
            if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Range, If-None-Match, Content-Type' }); res.end(); return }
            if (req.method === 'PUT' || req.method === 'POST') { await handleWrite(req, res, path); return }
            if (req.method === 'DELETE') {
              try { await engine.deleteSitePath(path); res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: true })) } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })) }
              return
            }
            if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.html')) {
              const visit = getActiveVisit()
              if (!visit) {
                const sites = getSitesList()
                const preview = sites[0]
                if (preview) {
                  const p = url.pathname === '/' ? '/index.html' : url.pathname
                  try {
                    const r = await engine.readSiteFile(p, {})
                    if (r && r.status === 'ok' && r.body) {
                      const html = rewriteHtml(r.body.toString('utf8'), effectiveToken())
                      res.writeHead(200, { 'Content-Type': r.mime || getSiteMimeType(p), 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' })
                      res.end(html); return
                    }
                    if (preview.spa) {
                      const fallback = await engine.readSiteFile('/index.html', {}).catch(() => null)
                      if (fallback && fallback.body) { const html2 = rewriteHtml(fallback.body.toString('utf8'), effectiveToken()); res.writeHead(200, { 'Content-Type': fallback.mime || 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html2) }); res.end(html2); return }
                    }
                  } catch {}
                }
                if (sites.length > 1) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(chooserHtml(sites)); return }
                res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Not visiting any site — visit a SITE- code first, or restart the host preview'); return
              }
              if (url.pathname !== '/' || path === '/') {
                try {
                  const tryPath = url.pathname !== '/' ? url.pathname : '/index.html'
                  const r = await engine.readSiteFile(tryPath, {})
                  if (r && r.status === 'ok' && r.body) {
                    const html = rewriteHtml(r.body.toString('utf8'), effectiveToken())
                    res.writeHead(200, { 'Content-Type': r.mime || getSiteMimeType(tryPath), 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' })
                    res.end(html); return
                  }
                } catch {}
              }
              const entries = await engine.listSitePath(path).catch(() => [])
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(indexHtml(visit, path, entries)); return
            }
            if (url.pathname === '/list') { await handleList(req, res, path); return }
            if (url.pathname === '/raw' || url.pathname === '/download') { const siteId = url.searchParams.get('siteId') || ''; await handleRaw(req, res, path, url.pathname === '/download', siteId || undefined); return }
            // Fallback: try raw serve for any other path (e.g. /assets/css/style.css without ?path=)
            if (req.method === 'GET' && url.pathname !== '/') {
              try {
                const r = await engine.readSiteFile(url.pathname, {})
                if (r && r.status === 'ok' && r.body) {
                  const ct = r.mime || getSiteMimeType(url.pathname)
                  let body = r.body
                  if (ct.includes('text/html')) body = Buffer.from(rewriteHtml(body.toString('utf8'), effectiveToken()))
                  else if (ct.includes('text/css')) body = Buffer.from(rewriteCss(body.toString('utf8'), effectiveToken()))
                  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' })
                  res.end(body); return
                }
              } catch {}
            }
            res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found')
          } catch (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Gateway error: ${err.message}`) }
        })
        s.on('error', (err) => { if (err.code === 'EADDRINUSE' && p < firstPort + 20) tryPort(p + 1); else reject(err) })
        s.listen(p, '127.0.0.1', () => { server = s; activePort = p; logInfo(`[SitesGateway] listening on http://127.0.0.1:${activePort}`); resolve(activePort) })
      }
      tryPort(firstPort)
    })
  }

  function stop() {
    // Mirrors the legacy electron/sites-gateway.js stop: close without waiting
    // for connections, drop the ref. The token intentionally survives (token
    // rotation happens through resetToken on visit start/stop).
    if (server) {
      server.close()
      server = null
    }
  }

  return {
    start,
    stop,
    setEngine,
    resetToken,
    getUrl,
    port: () => activePort || initialPort
  }
}

// Mint the gateway base URL exactly like the legacy electron/main.js
// getSitesUrl: only when something is actually visitable/hostable, otherwise
// { url: null } (the renderer must not get a URL that 503s). Ensures the
// gateway is running first.
async function mintSitesUrl(gateway, engine) {
  if (gateway.setEngine && engine) gateway.setEngine(engine)
  const visits = (engine.getActiveVisits ? engine.getActiveVisits() : []) || []
  const activeVisit = engine.getActiveVisit ? engine.getActiveVisit() : null
  const hosting = engine.siteServer && engine.siteServer._sites && engine.siteServer._sites.size > 0
  if (visits.length === 0 && !activeVisit && !hosting) return { url: null }
  await gateway.start().catch(() => {})
  return { url: gateway.getUrl() }
}

module.exports = { createSitesGateway, mintSitesUrl, DEFAULT_PORT }
