'use strict'

// Copies the app files the host/CLI borrow into ./vendor so the package is
// self-contained when installed away from the sibling meshdrop-app repo
// (npm publish, a standalone download, or bundled inside the desktop app).
// Runs automatically via the `prepack` script. The meshdrop-app checkout is
// the single source of truth, so nothing is hand-maintained here.

const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..', '..', 'meshdrop-app')
const OUT = path.join(__dirname, '..', 'vendor')

const FILES = [
  { from: 'src/shared/protocol.js', to: 'protocol.js' },
  { from: 'src/shared/engine-events.js', to: 'engine-events.js' },
  {
    from: 'electron/handlers.js',
    to: 'handlers.js',
    rewrites: [
      ["'../src/shared/protocol.js'", "'./protocol.js'"],
      ["'../src/shared/engine-events.js'", "'./engine-events.js'"]
    ]
  },
  { from: 'src/shared/localservers/stream-server.js', to: 'stream-server.js' },
  { from: 'src/shared/localservers/sites-gateway.js', to: 'sites-gateway.js' }
]

fs.mkdirSync(OUT, { recursive: true })
for (const f of FILES) {
  let src = fs.readFileSync(path.join(APP, f.from), 'utf8')
  for (const [a, b] of f.rewrites || []) src = src.split(a).join(b)
  fs.writeFileSync(path.join(OUT, f.to), src)
  process.stdout.write(`vendored vendor/${f.to}\n`)
}
