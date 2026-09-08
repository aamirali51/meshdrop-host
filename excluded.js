'use strict'

// Methods the host cannot serve. Each key is an exact method name or a
// 'prefix.*' wildcard; every entry carries the reason it is unavailable so
// /version and the conformance suite can report drift-free, explicit lists.
//
// Phase 1b re-homed the Electron-backed servers into the host process, so the
// former exclusions are gone: drive.getStatus / drive.updatePermissions /
// drive.broadcastFile / drive.shareInvite / drive.shareAccept /
// drive.shareDecline, stream.getUrl and sites.getUrl all dispatch in the host
// now. What remains is the one thing a headless host cannot do: mounting a
// drive letter for the desktop OS.

const EXCLUDED_METHODS = new Map([
  [
    'drive.mount',
    'Full-only OS integration: Windows drive-letter mount + Explorer network shortcut'
  ],
  [
    'drive.unmount',
    'Full-only OS integration: Windows drive-letter unmount + Explorer network shortcut'
  ]
])

function excludedReason(method) {
  if (typeof method !== 'string' || !method) return null
  if (EXCLUDED_METHODS.has(method)) return EXCLUDED_METHODS.get(method)
  for (const [pattern, reason] of EXCLUDED_METHODS) {
    if (pattern.endsWith('.*') && method.startsWith(pattern.slice(0, -1))) return reason
  }
  return null
}

function isExcluded(method) {
  return excludedReason(method) !== null
}

module.exports = { EXCLUDED_METHODS, excludedReason, isExcluded }
