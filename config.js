'use strict'

// Per-store daemon config, read by `mesh host` for defaults and written by
// `mesh service install`. Precedence: CLI flags > environment > this file.
// Lives inside the store so the identity and its config travel together.

const fs = require('fs')
const path = require('path')

const CONFIG_FILE = 'config.json'

function configPath(storageDir) {
  return path.join(storageDir, CONFIG_FILE)
}

function readConfig(storageDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(storageDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(storageDir, patch) {
  fs.mkdirSync(storageDir, { recursive: true })
  const merged = { ...readConfig(storageDir), ...patch }
  fs.writeFileSync(configPath(storageDir), JSON.stringify(merged, null, 2) + '\n')
  return merged
}

module.exports = { CONFIG_FILE, configPath, readConfig, writeConfig }
