'use strict'

// The host and CLI borrow a handful of files from the meshdrop-app repo:
// protocol.js, engine-events.js, handlers.js and the two local servers.
// `scripts/sync-vendor.js` copies them into ./vendor (with rewritten requires)
// so the package is self-contained for npm / a standalone install. In the dev
// workspace we fall back to the sibling meshdrop-app checkout — one source of
// truth, no committed duplicates.

const fs = require('fs')
const path = require('path')

const VENDOR_DIR = path.join(__dirname, 'vendor')
const APP_DIR = path.join(__dirname, '..', 'meshdrop-app')

function pick(vendorFile, appFile) {
  const vendored = path.join(VENDOR_DIR, vendorFile)
  return fs.existsSync(vendored) ? vendored : path.join(APP_DIR, appFile)
}

module.exports = {
  appDir: APP_DIR,
  protocol: pick('protocol.js', 'src/shared/protocol.js'),
  engineEvents: pick('engine-events.js', 'src/shared/engine-events.js'),
  handlers: pick('handlers.js', 'electron/handlers.js'),
  streamServer: pick('stream-server.js', 'src/shared/localservers/stream-server.js'),
  sitesGateway: pick('sites-gateway.js', 'src/shared/localservers/sites-gateway.js')
}
