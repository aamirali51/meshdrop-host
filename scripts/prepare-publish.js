'use strict'

// Turns the dev workspace into a publishable package:
//   1. swaps the dev-only `file:../meshdrop-core` engine dependency for the
//      published semver (read from the sibling checkout), and drops `private`;
//   2. vendors the app files the CLI borrows (self-contained tarball).
// Run by .github/workflows/release.yml before `npm publish`. Never run it in
// the dev tree — it edits package.json in place.

const fs = require('fs')
const path = require('path')

const pkgPath = path.join(__dirname, '..', 'package.json')
const corePkgPath = path.join(__dirname, '..', '..', 'meshdrop-core', 'package.json')

const coreVersion = JSON.parse(fs.readFileSync(corePkgPath, 'utf8')).version
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

delete pkg.private
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['@meshdrop-go/core'] = '^' + coreVersion

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
process.stdout.write(`@meshdrop-go/core -> ^${coreVersion}; private removed\n`)

// vendor/ is committed so the package builds without the meshdrop-app sibling.
// Refresh it with `node scripts/sync-vendor.js` whenever those app files change.
