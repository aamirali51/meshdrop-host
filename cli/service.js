'use strict'

// `mesh service` — install the host as a supervised, start-on-boot service.
//   Linux   systemd unit (user by default; --system for /etc/systemd/system)
//   macOS   launchd agent (~/Library/LaunchAgents)
//   Windows logon Scheduled Task running a hidden VBS launcher
// All three run:  node <hostIndex> --storage <store>   (config lives in the store)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const LABEL = 'com.meshdrop.host'
const WIN_TASK = 'MeshDropHost'
const HOST_INDEX = path.join(__dirname, '..', 'index.js')
const SYSTEMD_UNIT = 'meshdrop.service'

function nodePath() {
  return process.execPath
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || (res.error && res.error.message) || '').trim()
  }
}

function systemdPath(system) {
  return system
    ? `/etc/systemd/system/${SYSTEMD_UNIT}`
    : path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

function launchdPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function winVbsPath(storage) {
  return path.join(storage, 'meshdrop-host.vbs')
}

// ─── unit / task content ───────────────────────────────────────────────────

function renderUnit(storage) {
  const node = nodePath()
  if (process.platform === 'linux') {
    return `[Unit]
Description=MeshDrop host (peer-to-peer file transfer, sync, shared folders)
Documentation=https://github.com/aamirali51/meshdrop-host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${HOST_INDEX} --storage ${storage}
Restart=always
RestartSec=3
# Hardening — tighten further with ProtectHome/ProtectSystem if you wish.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`
  }
  if (process.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${HOST_INDEX}</string>
    <string>--storage</string><string>${storage}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`
  }
  if (process.platform === 'win32') {
    return `' MeshDrop host launcher — runs the node host hidden at logon.
Set sh = CreateObject("WScript.Shell")
sh.Run """${node}"" ""${HOST_INDEX}"" --storage ""${storage}""", 0, False
`
  }
  return null
}

// ─── platform actions ──────────────────────────────────────────────────────

function install({ storage, system }) {
  const content = renderUnit(storage)
  if (!content) return { ok: false, error: `unsupported platform: ${process.platform}` }

  if (process.platform === 'linux') {
    const file = systemdPath(system)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    const scope = system ? 'system' : '--user'
    const reload = run('systemctl', scope === '--user' ? ['--user', 'daemon-reload'] : ['daemon-reload'])
    const enable = run('systemctl', scope === '--user' ? ['--user', 'enable', '--now', SYSTEMD_UNIT] : ['enable', '--now', SYSTEMD_UNIT])
    return { ok: enable.ok, file, reload, enable, hint: system ? 'run with sudo' : null }
  }

  if (process.platform === 'darwin') {
    const file = launchdPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    run('launchctl', ['unload', file])
    const load = run('launchctl', ['load', '-w', file])
    return { ok: load.ok, file, enable: load }
  }

  // Windows: hidden logon Scheduled Task
  const vbs = winVbsPath(storage)
  fs.mkdirSync(path.dirname(vbs), { recursive: true })
  fs.writeFileSync(vbs, content)
  const create = run('schtasks', [
    '/Create', '/TN', WIN_TASK, '/SC', 'ONLOGON', '/F',
    '/TR', `wscript.exe "${vbs}"`
  ])
  const start = run('schtasks', ['/Run', '/TN', WIN_TASK])
  return { ok: create.ok, file: vbs, enable: create, start }
}

function uninstall({ system }) {
  if (process.platform === 'linux') {
    const file = systemdPath(system)
    const scope = system ? [] : ['--user']
    run('systemctl', [...scope, 'disable', '--now', SYSTEMD_UNIT])
    try {
      fs.unlinkSync(file)
    } catch {}
    run('systemctl', [...scope, 'daemon-reload'])
    return { ok: true, removed: file }
  }
  if (process.platform === 'darwin') {
    const file = launchdPath()
    run('launchctl', ['unload', '-w', file])
    try {
      fs.unlinkSync(file)
    } catch {}
    return { ok: true, removed: file }
  }
  if (process.platform === 'win32') {
    run('schtasks', ['/End', '/TN', WIN_TASK])
    const del = run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F'])
    return { ok: del.ok, removed: WIN_TASK }
  }
  return { ok: false, error: `unsupported platform: ${process.platform}` }
}

function status({ system }) {
  if (process.platform === 'linux') {
    const scope = system ? [] : ['--user']
    const active = run('systemctl', [...scope, 'is-active', SYSTEMD_UNIT])
    const file = systemdPath(system)
    return { ok: true, platform: 'systemd', installed: fs.existsSync(file), active: active.stdout || active.stderr, file }
  }
  if (process.platform === 'darwin') {
    const file = launchdPath()
    const list = run('launchctl', ['list'])
    return { ok: true, platform: 'launchd', installed: fs.existsSync(file), loaded: list.stdout.includes(LABEL), file }
  }
  if (process.platform === 'win32') {
    const q = run('schtasks', ['/Query', '/TN', WIN_TASK])
    return { ok: true, platform: 'windows-task', installed: q.ok, detail: q.stdout || q.stderr }
  }
  return { ok: false, error: `unsupported platform: ${process.platform}` }
}

module.exports = { install, uninstall, status, renderUnit, systemdPath, launchdPath }
