'use strict'

// Renderer protocol handlers, ported from the old Bare worker
// (workers/handlers.js) to operate directly on the in-process MeshEngine.
//
// Every method in src/shared/protocol.js METHODS maps to either a MeshEngine
// method or a thin Hyperbee-backed store operation (engine.getBee). Events
// are re-emitted with the worker-protocol names the renderer subscribes to.
//
// This module is deliberately free of Electron imports so the SAME dispatch
// table drives the desktop app (electron/main.js) and the headless host
// (meshdrop-host): anything transport- or platform-specific (event framing,
// WebDAV/sites-gateway URL servers) is injected at registration time.

const fs = require('fs')
const path = require('path')
const fsp = require('fs/promises')
const { METHODS, EVENTS } = require('./protocol.js')
const { shouldForwardProtocolEvent } = require('./engine-events.js')
const { normalizePairingCode, deriveDeviceId } = require('@meshdrop-go/core/crypto.js')

// ─── Pure helpers (ported from workers/helpers.js) ──────────────────────────

const DEFAULT_SETTINGS = {
  theme: 'dark',
  deviceName: '',
  // Security default: devices must pair via the key/code handshake. LAN
  // discovery connects peers, it does NOT grant trust.
  autoTrustLAN: false,
  // When a relayed/internet peer is heard on the local network, reconnect it
  // over direct LAN automatically (faster transfers + playback).
  autoLanSwitch: true,
  // When false the engine holds incoming transfers at "pending approval"
  // until the user explicitly accepts (Require Manual File Acceptance).
  autoAcceptOffers: true,
  preferOwnRelay: true,
  // Relay connections for my paired devices (desktop only, default ON, hidden on mobile).
  relayForPairedDevices: true,
  noiseEncryption: true,
  autoUpdate: true,
  releaseChannel: 'stable',
  notifications: { transfer: true, device: true, sound: false },
  downloadDir: null,
  launchAtStartup: false,
  startMinimized: true
}

function mergeSettings(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) }
}

// A device's stable identity key. identityKey (the peer's identity core key,
// persisted across restarts) is the canonical dedup key; legacy rows without
// it fall back to their id.
function canonicalDeviceKey(dev) {
  if (!dev || typeof dev !== 'object') return null
  return typeof dev.identityKey === 'string' && dev.identityKey
    ? dev.identityKey
    : typeof dev.id === 'string'
      ? dev.id
      : null
}

// One-time startup migration. Legacy records were keyed by ids derived from
// ephemeral noise keys (regenerated on every boot), so each restart created a
// new row for the same physical device. Re-key every record to its stable
// identity-derived id and delete the superseded duplicates.
async function cleanupDuplicateDevices(engine) {
  try {
    const bee = await engine.getBee('devices')
    const groups = new Map() // groupKey -> { rows: [{ key, value }], canonicalId }
    for await (const node of bee.createReadStream()) {
      const value = node.value
      if (!value || typeof value !== 'object' || !value.id) continue
      if (
        engine.deviceIdentity &&
        (value.id === engine.deviceIdentity.id ||
          value.publicKey === engine.deviceIdentity.publicKey)
      ) {
        continue // never touch the local node's own records
      }
      const identityKey =
        typeof value.identityKey === 'string' && value.identityKey ? value.identityKey : null
      const groupKey = identityKey || `id:${value.id}`
      const canonicalId = identityKey ? deriveDeviceId(identityKey) : value.id
      if (!groups.has(groupKey)) groups.set(groupKey, { rows: [], canonicalId })
      groups.get(groupKey).rows.push({ key: node.key, value })
    }
    let merged = 0
    let removed = 0
    for (const { rows, canonicalId } of groups.values()) {
      if (rows.length === 0) continue
      // Winner: the row with the most recent lastSeen (ISO strings compare
      // lexicographically).
      let winner = rows[0]
      for (const r of rows) {
        if ((r.value.lastSeen || '') > (winner.value.lastSeen || '')) winner = r
      }
      if (winner.key !== canonicalId || winner.value.id !== canonicalId) {
        await bee.put(canonicalId, { ...winner.value, id: canonicalId })
        merged++
        if (winner.key !== canonicalId) {
          await bee.del(winner.key)
          removed++
        }
      }
      for (const r of rows) {
        if (r === winner) continue
        await bee.del(r.key)
        removed++
      }
    }
    if (merged > 0 || removed > 0) {
      console.log(
        `[Main] Device store cleanup: re-keyed ${merged} record(s), removed ${removed} stale duplicate(s)`
      )
    }
  } catch (err) {
    console.warn('[Main] Device store cleanup failed:', err.message)
  }
}

// ─── Device store helpers ──────────────────────────────────────────────────
function registerEngineHandlers({
  engine,
  eventSink,
  getLabel,
  updateAutoStart,
  getStreamUrl,
  getSitesUrl
}) {
  const handlers = {}

  // Sink contract: { send(event, data) } — Electron wires it to
  // webContents.send with the legacy worker framing; the headless host wires
  // it to its WebSocket broadcaster. The sync-origin suppression gate lives
  // in the shared engine-events module so no caller can skip it.
  const sink = eventSink || { send() {} }

  const emit = (event, data) => {
    try {
      if (!shouldForwardProtocolEvent(event, data)) return
      sink.send(event, data)
    } catch (err) {
      console.error('[Main] Failed to emit event:', err.message)
    }
  }

  // ─── Devices ──────────────────────────────────────────────────────────────

  handlers[METHODS.DEVICES_LIST] = async () => {
    // Source of truth is the devices bee (written by the trusted-handshake
    // path) merged with live connection state. Rows are deduplicated by the
    // stable identity key so stale noise-key-derived duplicates never surface.
    // Presence is NEVER read from the bee: a relay-paired phone leaves no close
    // event, so its persisted isOnline row would stay true forever. It is
    // derived here from live connections + relay-liveness freshness.
    const bee = await engine.getBee('devices')
    const deviceMap = new Map()
    const isDeviceOnline = typeof engine.isDeviceOnline === 'function'
      ? (dev) => engine.isDeviceOnline(dev)
      : () => false

    for await (const node of bee.createReadStream()) {
      const dev = node.value
      if (dev && dev.id) {
        if (
          engine.deviceIdentity &&
          (dev.id === engine.deviceIdentity.id || dev.publicKey === engine.deviceIdentity.publicKey)
        ) {
          continue
        }
        if (dev.name && dev.name.startsWith('Device-')) {
          continue
        }
        const key = canonicalDeviceKey(dev)
        if (!key) continue
        const existing = deviceMap.get(key)
        if (existing && (existing.lastSeen || '') > (dev.lastSeen || '')) continue
        // A row's name may be a stale "MeshDrop Mobile" overwritten by a
        // reconnect before the preserve-name fix landed — customName wins and
        // old clobbers self-heal.
        const rowName = dev.customName || dev.name || ''
        deviceMap.set(key, { ...dev, isOnline: isDeviceOnline(dev), name: rowName })
      }
    }

    for (const [, peerObj] of engine.peers.entries()) {
      const dev = peerObj.device
      if (dev && dev.id && dev.name !== 'Connecting...') {
        if (
          engine.deviceIdentity &&
          (dev.id === engine.deviceIdentity.id || dev.publicKey === engine.deviceIdentity.publicKey)
        ) {
          continue
        }
        const key = canonicalDeviceKey(dev)
        if (!key) continue
        const existing = deviceMap.get(key)
        // The user's custom name outranks whatever the peer currently reports.
        const name = (existing && existing.customName) ? existing.customName : dev.name
        deviceMap.set(key, { ...dev, ...existing, name, isOnline: isDeviceOnline(dev) })
      }
    }

    return Array.from(deviceMap.values())
  }

  handlers[METHODS.DEVICES_GET_IDENTITY] = async () => {
    const identity = engine.getIdentity()
    return { ...(engine.deviceIdentity || {}), pairingCode: identity.pairingCode }
  }

  handlers[METHODS.DEVICES_GET_CODE] = async () => {
    const identity = engine.getIdentity()
    return {
      code: identity.pairingCode,
      id: identity.deviceId,
      publicKey: identity.publicKey,
      name: engine.deviceIdentity?.name || '',
      os: engine.deviceIdentity?.os || ''
    }
  }

  handlers[METHODS.DEVICES_PAIR_CODE] = async (params) => {
    // Register the code and let the engine's challenge-response complete in
    // the background; the UI is driven by the device.paired / peer.connected
    // events (PairDeviceModal) — exactly like the old worker.
    engine.pairWithCode(params?.code).catch((err) => {
      console.warn(`[Main:${getLabel()}] Pairing failed:`, err.message)
    })
    return { success: true, code: params?.code || '' }
  }

  handlers[METHODS.DEVICES_PAIR] = async (params) => {
    const bee = await engine.getBee('devices')
    const device = {
      id: params.id || `device-${Date.now().toString(36)}`,
      name: params.name || 'Unknown Device',
      os: params.os || 'Unknown',
      osVersion: params.osVersion || '',
      avatar: params.avatar || '',
      isTrusted: true,
      isEncrypted: true,
      isOnline: false,
      signalStrength: 0,
      lastSeen: new Date().toISOString(),
      ipAddress: params.ipAddress || '',
      pairedAt: Date.now()
    }
    await bee.put(device.id, device)
    emit(EVENTS.DEVICE_PAIRED, device)
    return device
  }

  handlers[METHODS.DEVICES_RENAME] = async (params) => {
    return engine.renameDevice(params?.id, params?.name)
  }

  handlers[METHODS.DEVICES_FAVORITE] = async (params) => {
    const bee = await engine.getBee('devices')
    const entry = await bee.get(params.id)
    if (!entry) throw new Error('Device not found')
    const device = { ...entry.value, isFavorite: params.isFavorite }
    await bee.put(params.id, device)
    return device
  }

  handlers[METHODS.DEVICES_REMOVE] = async (params) => {
    const bee = await engine.getBee('devices')
    const entry = await bee.get(params.id)
    const device = entry && entry.value
    await bee.del(params.id)
    // Delegate the revocation itself to the engine so the UI path and the API
    // path cannot drift: trust revoke + code rotation + sync-library revocation
    // + site-allowlist pruning + DEVICE_REMOVED delivery (audit fix F2).
    await engine.removeDevice(params.id, { cancelDropCodes: params?.cancelDropCodes === true })
    emit(EVENTS.DEVICE_UPDATED, { id: params.id, deleted: true })
    return { deleted: params.id, device: device ? { id: device.id, name: device.name } : null }
  }

  handlers[METHODS.DEVICES_TRUST] = async (params) => {
    const bee = await engine.getBee('devices')
    const entry = await bee.get(params.id)
    if (!entry) return null
    const device = {
      ...entry.value,
      isTrusted: !entry.value.isTrusted,
      trustedAt: entry.value.isTrusted ? undefined : new Date().toISOString()
    }
    await bee.put(params.id, device)
    if (device.publicKey) {
      if (device.isTrusted) engine.trustManager.addTrustedKey(device.publicKey)
      else engine.trustManager.removeTrustedKey(device.publicKey)
    }
    emit(EVENTS.DEVICE_UPDATED, device)
    return device
  }

  // One-tap confirm for the device-detected-on-lan prompt: promotes the
  // lan-level peer to full pairing in the engine (handshake + exchange
  // replication + trusted-key registration) and mirrors it into the row.
  handlers[METHODS.DEVICES_CONFIRM_LAN] = async (params) => {
    const publicKey = params?.publicKey
    if (typeof publicKey !== 'string' || publicKey.length !== 64) {
      throw new Error('A 64-character peer public key is required')
    }
    const device = await engine.confirmLanPair(publicKey)
    if (device) emit(EVENTS.DEVICE_UPDATED, device)
    return device || null
  }

  // ─── Diagnostics / notifications ──────────────────────────────────────────

  handlers[METHODS.DIAGNOSTICS_GET] = async () => {
    return engine.getDiagnostics()
  }

  handlers[METHODS.NOTIFICATIONS_LIST] = async () => {
    return engine.notificationStore ? engine.notificationStore.getNotifications() : []
  }

  handlers[METHODS.NOTIFICATIONS_MARK_READ] = async () => {
    return engine.notificationStore ? engine.notificationStore.markAllRead() : []
  }

  handlers[METHODS.NOTIFICATIONS_CLEAR] = async () => {
    return engine.notificationStore ? engine.notificationStore.clear() : []
  }

  // ─── History / connection / settings / storage ────────────────────────────

  handlers[METHODS.HISTORY_LIST] = async () => {
    const bee = await engine.getBee('history')
    const results = []
    for await (const node of bee.createReadStream()) {
      results.push(node.value)
    }
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    return results
  }

  handlers[METHODS.HISTORY_CLEAR] = async () => {
    const bee = await engine.getBee('history')
    const keys = []
    for await (const node of bee.createReadStream()) {
      keys.push(node.key)
    }
    for (const k of keys) {
      await bee.del(k)
    }
    return { success: true, count: keys.length }
  }

  handlers[METHODS.CONNECTION_STATUS] = async () => {
    return engine.getStatus()
  }

  handlers[METHODS.SETTINGS_GET] = async () => {
    const bee = await engine.getBee('settings')
    const entry = await bee.get('settings')
    // Surface the engine's live flags so the UI toggle reflects actual @meshdrop-go/core state.
    const live = (await engine.getSettings()) || {}
    return mergeSettings({
      ...(entry?.value || {}),
      autoAcceptOffers: live.autoAcceptOffers,
      autoTrustLAN: live.autoTrustLAN,
      autoLanSwitch: live.autoLanSwitch,
      preferOwnRelay: live.preferOwnRelay,
      relayForPairedDevices: live.relayForPairedDevices
    })
  }

  handlers[METHODS.SETTINGS_UPDATE] = async (params) => {
    const bee = await engine.getBee('settings')
    const entry = await bee.get('settings')
    const merged = mergeSettings({ ...(entry?.value || {}), ...(params || {}) })
    await bee.put('settings', merged)
    // Honor the persisted values live: downloads land in the chosen folder
    // and the LAN auto-trust toggle applies to new connections.
    if (typeof merged.downloadDir === 'string' && merged.downloadDir) {
      engine.downloadsDir = merged.downloadDir
    }
    if (typeof merged.autoTrustLAN === 'boolean') {
      engine.autoTrustLAN = merged.autoTrustLAN
    }
    if (typeof merged.autoLanSwitch === 'boolean') {
      await engine.setAutoLanSwitch(merged.autoLanSwitch)
    }
    if (typeof merged.autoAcceptOffers === 'boolean') {
      await engine.setAutoAcceptOffers(merged.autoAcceptOffers)
    }
    if (typeof merged.preferOwnRelay === 'boolean') {
      await engine.setPreferOwnRelay(merged.preferOwnRelay)
    }
    if (typeof merged.relayForPairedDevices === 'boolean') {
      await engine.setRelayForPairedDevices(merged.relayForPairedDevices)
    }
    if (updateAutoStart) {
      updateAutoStart(merged)
    }
    emit(EVENTS.SETTINGS_UPDATED, merged)
    return merged
  }

  // Relay stats for Settings UI aggregate: session count + "Relaying for <device name>" labels.
  handlers['relay.stats'] = async () => {
    if (engine.getRelayStats) return engine.getRelayStats()
    return { active: 0, sessions: [] }
  }

  handlers[METHODS.STORAGE_CLEAR] = async () => {
    const tempDir = path.join(engine.storageDir, 'p2p-temp')
    try {
      const files = await fsp.readdir(tempDir).catch(() => [])
      for (const f of files) {
        await fsp.unlink(path.join(tempDir, f)).catch(() => {})
      }
    } catch {}
    return { success: true }
  }

// ─── One-time shares (drop codes) ─────────────────────────────────────────
// All drop lifecycle logic lives in @meshdrop-go/core (createDropShare,
// claimDropCode, listPendingShares, extend/cancel/delete). These handlers are
// thin RPC shells that surface renderer events for the records they return.

handlers[METHODS.FILES_CREATE_CODE] = async (params) => {
  const share = await engine.createDropShare(params)
  emit(EVENTS.PENDING_SHARE_UPDATED, share)
  console.log(`[Main] Background pending code share created: ${share.code} (expires: ${share.expirationPreset})`)
  return share
}

handlers[METHODS.FILES_LIST_PENDING] = async () => {
  return engine.listPendingShares()
}

handlers[METHODS.FILES_EXTEND_EXPIRATION] = async (params) => {
  const share = await engine.extendPendingShare(params)
  emit(EVENTS.PENDING_SHARE_UPDATED, share)
  return share
}

handlers[METHODS.FILES_CANCEL_CODE] = async (params) => {
  const { id } = params
  const share = await engine.cancelPendingShare({ id })
  emit(EVENTS.PENDING_SHARE_UPDATED, share)
  return share
}

handlers[METHODS.FILES_DELETE_PENDING] = async (params) => {
  return engine.deletePendingShare({ id: params.id })
}

handlers[METHODS.FILES_CLAIM_CODE] = async (params) => {
  // MD- codes route to device pairing (random 80-bit code scheme)
  const mdCode = normalizePairingCode(params?.code)
  if (mdCode) {
    return handlers[METHODS.DEVICES_PAIR_CODE]({ code: mdCode })
  }
  return engine.claimDropCode(params?.code, { interactive: true })
}

handlers[METHODS.FILES_CONFIRM_CLAIM] = async (params) => {
  return engine.confirmClaimDownload(params)
}

handlers[METHODS.FILES_CANCEL_CLAIM] = async (params) => {
  return engine.cancelClaimDownload(params)
}

  // ─── Transfers ────────────────────────────────────────────────────────────

  handlers[METHODS.TRANSFERS_START] = async (params) => {
    console.log(
      `[Main] TRANSFERS_START: ${params.filename || 'unknown'} (${params.fileSize || 0} bytes) peer=${params.peerId || 'none'} path=${params.filePath || 'none'}`
    )
    return engine.startTransfer(params)
  }

  handlers[METHODS.TRANSFERS_ACCEPT] = async (params) => engine.acceptTransfer(params.id)
  handlers[METHODS.TRANSFERS_DECLINE] = async (params) => engine.declineTransfer(params.id)
  handlers[METHODS.TRANSFERS_PAUSE] = async (params) => engine.pauseTransfer(params.id)
  handlers[METHODS.TRANSFERS_RESUME] = async (params) => engine.resumeTransfer(params.id)
  handlers[METHODS.TRANSFERS_CANCEL] = async (params) => engine.cancelTransfer(params.id)
  handlers[METHODS.TRANSFERS_RETRY] = async (params) => engine.retryTransfer(params.id)
  handlers[METHODS.TRANSFERS_LIST] = async () => engine.listTransfers()
  handlers[METHODS.TRANSFERS_CLEAR] = async (params) => engine.clearTransfers(params)
  handlers[METHODS.TRANSFERS_DELETE] = async (params) => engine.deleteTransfer(params?.id)

  handlers[METHODS.TRANSFERS_BROADCAST] = async (params) => {
    const onlinePeers = Array.from(engine.peers.values()).filter(
      (p) => p.device && p.device.isOnline !== false
    )
    console.log(`[Main] TRANSFERS_BROADCAST to ${onlinePeers.length} online peers`)
    const results = []
    for (const p of onlinePeers) {
      try {
        const res = await engine.startTransfer({
          ...params,
          peerId: p.device.publicKey,
          peerName: p.device.name
        })
        results.push(res)
      } catch (err) {
        console.warn(`[Main] Broadcast error for peer ${p.device.id}:`, err.message)
      }
    }
    return { success: true, count: results.length, transfers: results }
  }

  // ─── Folder sync (SyncEngine) ────────────────────────────────────────────

  handlers[METHODS.SYNC_ADD] = async (params) => {
    const lib = await engine.addSyncLibrary({
      path: params?.path,
      peerId: params?.peerId,
      name: params?.name,
      mode: params?.mode
    })
    console.log(`[Main] Sync library added: ${lib.name} (${lib.fileCount} file(s)) -> ${lib.peerId ? lib.peerId.slice(0, 12) : 'unknown'}...`)
    if (updateAutoStart) updateAutoStart()
    return lib
  }

  handlers[METHODS.SYNC_REMOVE] = async (params) => {
    const res = await engine.removeSyncLibrary(params?.id)
    if (updateAutoStart) updateAutoStart()
    return res
  }

  handlers[METHODS.SYNC_LIST] = async () => engine.listSyncLibraries()

  handlers[METHODS.SYNC_TRIGGER] = async (params) => engine.syncLibrary(params?.id)

  handlers[METHODS.SYNC_PAUSE] = async (params) => {
    const res = await engine.pauseSyncLibrary(params?.id)
    if (updateAutoStart) updateAutoStart()
    return res
  }

  handlers[METHODS.SYNC_RESUME] = async (params) => {
    const res = await engine.resumeSyncLibrary(params?.id)
    if (updateAutoStart) updateAutoStart()
    return res
  }

  handlers[METHODS.SYNC_ACCEPT_INVITE] = async (params) => {
    const res = await engine.acceptSyncInvite({ id: params?.id, customPath: params?.customPath })
    if (updateAutoStart) updateAutoStart()
    return res
  }

  handlers[METHODS.SYNC_DECLINE_INVITE] = async (params) => engine.declineSyncInvite({ id: params?.id })

  handlers[METHODS.SYNC_LIST_INVITES] = async () => engine.listPendingSyncInvites()

  // ─── Shared files ─────────────────────────────────────────────────────────

  handlers[METHODS.SHARED_LIST] = async () => {
    const bee = await engine.getBee('shared')
    const results = []
    for await (const node of bee.createReadStream()) {
      results.push(node.value)
    }
    return results
  }

  handlers[METHODS.SHARED_REMOVE] = async (params) => {
    const bee = await engine.getBee('shared')
    await bee.del(params.id)
    return { deleted: params.id }
  }

  handlers[METHODS.SHARED_FAVORITE] = async (params) => {
    const bee = await engine.getBee('shared')
    const entry = await bee.get(params.id)
    if (!entry) throw new Error('File not found')
    const file = { ...entry.value, isFavorite: params.isFavorite }
    await bee.put(params.id, file)
    return file
  }

  // ─── Drive (WebDAV) peer broadcasts ───────────────────────────────────────

  handlers[METHODS.DRIVE_BROADCAST_FILE] = async (params) => {
    if (!params || !params.filename) return { success: false }
    const payload = {
      type: 'DRIVE_FILE_SYNC',
      senderIdentity: engine.deviceIdentity,
      file: {
        id: params.id || `drive-${Date.now().toString(36)}`,
        filename: params.filename,
        fileSize: params.fileSize || 0,
        fileType: params.fileType || 'application/octet-stream'
      }
    }

    let broadcastCount = 0
    for (const [, peerObj] of engine.peers.entries()) {
      if (peerObj.signaling) {
        try {
          peerObj.signaling.send(payload)
          broadcastCount++
        } catch {}
      }
    }
    console.log(`[Main] DRIVE_BROADCAST_FILE sent to ${broadcastCount} peers: ${params.filename}`)
    return { success: true, broadcastCount }
  }

  handlers[METHODS.DRIVE_SHARE_INVITE] = async (params) => {
    const { targetPeerId } = params || {}
    let sentCount = 0
    for (const [peerId, peerObj] of engine.peers.entries()) {
      if (
        (!targetPeerId || targetPeerId === peerId || peerObj.device?.id === targetPeerId) &&
        peerObj.signaling
      ) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_INVITE',
            senderIdentity: engine.deviceIdentity
          })
          sentCount++
        } catch (err) {
          console.error(`[Main] Failed to send DRIVE_SHARE_INVITE to ${peerId}:`, err.message)
        }
      }
    }
    return { success: sentCount > 0, sentCount }
  }

  handlers[METHODS.DRIVE_SHARE_ACCEPT] = async (params) => {
    const { peerId } = params || {}
    for (const [pId, peerObj] of engine.peers.entries()) {
      if ((!peerId || peerId === pId || peerObj.device?.id === peerId) && peerObj.signaling) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_ACCEPT',
            senderIdentity: engine.deviceIdentity
          })
        } catch (err) {
          console.error(`[Main] Failed to send DRIVE_SHARE_ACCEPT to ${pId}:`, err.message)
        }
      }
    }
    return { success: true }
  }

  handlers[METHODS.DRIVE_SHARE_DECLINE] = async (params) => {
    const { peerId } = params || {}
    for (const [pId, peerObj] of engine.peers.entries()) {
      if ((!peerId || peerId === pId || peerObj.device?.id === peerId) && peerObj.signaling) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_DECLINE',
            senderIdentity: engine.deviceIdentity
          })
        } catch {}
      }
    }
    return { success: true }
  }

  handlers[METHODS.WATCH_STATE_BROADCAST] = async (params) => {
    if (!engine) return { success: false }
    const res = engine.broadcastWatchState ? engine.broadcastWatchState(params) : { success: true }
    // When a party room is active, the manager's broadcast already emits the
    // authoritative party:state:sync (forwarded to watch.state_sync), and the
    // router gates foreign watch.stateChanged by room membership. Only echo the
    // legacy watch.stateChanged locally on the non-room claim path to avoid
    // double-driving the same host UI.
    if (!(engine.watchParty && engine.watchParty.activeRoom)) {
      emit(EVENTS.WATCH_STATE_CHANGED, {
        ...params,
        timestampMs: Date.now(),
        senderDevice: engine.deviceIdentity ? { id: engine.deviceIdentity.id, name: engine.deviceIdentity.name } : null
      })
    }
    return res || { success: true }
  }

  handlers[METHODS.WATCH_PARTY_CREATE] = async (params) => {
    if (!engine || !engine.createPartyRoom) throw new Error('Engine watch party unavailable')
    return engine.createPartyRoom(params)
  }

  handlers[METHODS.WATCH_PARTY_JOIN] = async (params) => {
    if (!engine || !engine.joinPartyRoom) throw new Error('Engine watch party unavailable')
    return engine.joinPartyRoom(params)
  }

  handlers[METHODS.WATCH_PARTY_LEAVE] = async () => {
    if (!engine || !engine.leavePartyRoom) return { success: true }
    return engine.leavePartyRoom()
  }

  handlers[METHODS.WATCH_PARTY_GET_ROOM] = async () => {
    if (!engine || !engine.getPartyRoom) return null
    return engine.getPartyRoom()
  }

  handlers[METHODS.WATCH_PARTY_LIST_ROOMS] = async () => {
    if (!engine || !engine.listPartyRooms) return []
    return engine.listPartyRooms()
  }

  handlers[METHODS.WATCH_PARTY_REACTION] = async (params) => {
    if (!engine || !engine.sendPartyReaction) return false
    return engine.sendPartyReaction(params || {})
  }

  handlers[METHODS.WATCH_PARTY_STATUS] = async (params) => {
    if (!engine || !engine.broadcastPartyStatus) return false
    return engine.broadcastPartyStatus(params)
  }

  handlers[METHODS.WATCH_PARTY_CHAT] = async (params) => {
    if (!engine || !engine.sendPartyChat) return false
    return engine.sendPartyChat(params || {})
  }

  handlers[METHODS.WATCH_PARTY_CHAT_HISTORY] = async () => {
    if (!engine || !engine.getPartyChatHistory) return []
    return engine.getPartyChatHistory()
  }

  handlers[METHODS.WATCH_PARTY_MODERATE] = async (params) => {
    if (!engine || !engine.moderateParty) return { success: false, error: 'no party' }
    return engine.moderateParty(params || {})
  }

  handlers[METHODS.WATCH_PARTY_QUEUE_ADD] = async (params) => {
    if (!engine || !engine.addPartyQueueItem) throw new Error('Engine watch party unavailable')
    return engine.addPartyQueueItem(params || {})
  }

  handlers[METHODS.WATCH_PARTY_QUEUE_REMOVE] = async (params) => {
    if (!engine || !engine.removePartyQueueItem) return { success: false }
    return engine.removePartyQueueItem(params || {})
  }

  handlers[METHODS.WATCH_PARTY_QUEUE_NEXT] = async () => {
    if (!engine || !engine.playNextPartyMedia) throw new Error('Engine watch party unavailable')
    return engine.playNextPartyMedia()
  }

  handlers[METHODS.WATCH_PARTY_SUBTITLE_SET] = async (params) => {
    if (!engine || !engine.setPartySubtitle) throw new Error('Engine watch party unavailable')
    return engine.setPartySubtitle(params || {})
  }

  handlers[METHODS.WATCH_PARTY_SUBTITLE_GET] = async () => {
    if (!engine || !engine.getPartySubtitle) return null
    return engine.getPartySubtitle()
  }

  handlers[METHODS.WATCH_PARTY_REWIND_SET] = async (params) => {
    if (!engine || !engine.setPartyRewindWindow) return false
    return engine.setPartyRewindWindow(params || {})
  }

  handlers[METHODS.WATCH_PARTY_VOICE] = async (params) => {
    if (!engine || !engine.sendPartyVoiceChunk) return false
    return engine.sendPartyVoiceChunk(params || {})
  }

  handlers[METHODS.TRANSFERS_EXTENT] = async (params) => {
    const id = params && params.transferId
    if (!id || !engine || !engine.transferEngine) return { fileSize: 0, coveredBytes: 0, complete: false }
    try {
      const rec = await engine.transferEngine.getBee('transfers').then(b => b.get(id).then(e => e && e.value)).catch(() => null)
      if (!rec || !Number.isFinite(rec.fileSize) || rec.fileSize <= 0) return { fileSize: 0, coveredBytes: 0, complete: false }
      if (rec.status === 'completed') return { fileSize: rec.fileSize, coveredBytes: rec.fileSize, complete: true }
      const covered = await engine.transferEngine.coveredThrough(id, 0).catch(() => null)
      const coveredBytes = Number.isFinite(covered) ? covered + 1 : 0
      return { fileSize: rec.fileSize, coveredBytes, complete: false }
    } catch { return { fileSize: 0, coveredBytes: 0, complete: false } }
  }

  // Watch Party guest seeks: steer the scheduler's range priority toward the
  // playhead byte so the jumped-to region downloads next. The renderer call
  // site is fire-and-forget (.catch(() => {})) — never throw into the UI.
  handlers[METHODS.SET_PLAYHEAD_BYTE] = async (params) => {
    const transferId = params && params.transferId
    const byteOffset = params && (Number.isFinite(params.byteOffset) ? params.byteOffset : params.byte)
    if (!transferId || !Number.isFinite(byteOffset) || !engine || typeof engine.setPlayheadByte !== 'function') {
      return { ok: false }
    }
    try {
      engine.setPlayheadByte(transferId, byteOffset)
      return { ok: true }
    } catch { return { ok: false } }
  }

  handlers[METHODS.STREAM_URL_GET] = async (params) => {
    // Backed by the Electron WebDAV stream server (electron/webdav.js). The
    // resolver is injected so this dispatch table stays host-agnostic; the
    // standalone host excludes the method until Phase 1b re-homes that server.
    if (typeof getStreamUrl !== 'function') {
      throw new Error('stream.getUrl is unavailable in this host (no stream server loaded)')
    }
    return getStreamUrl(engine, params)
  }

  // ─── MeshDrop Sites ──────────────────────────────────────────────────────
  // Thin RPC shells over the MeshEngine site methods (registry, allowlist,
  // visit + live read). The visitor-side HTTP gateway lives in sites-gateway.js
  // and is reached through sites.getUrl.

  handlers[METHODS.SITES_LIST] = async () => engine.listSites()
  handlers[METHODS.SITES_LIST_ACTIVE] = async () => engine.listActiveSites ? engine.listActiveSites() : []
  handlers[METHODS.SITES_LIST_RECEIVED] = async () => engine.listReceivedSites ? engine.listReceivedSites() : []
  handlers[METHODS.SITES_REMOVE_RECEIVED] = async (params) => engine.removeReceivedSite ? engine.removeReceivedSite(params?.siteId) : { success: true }
  handlers[METHODS.SITES_PUBLISH] = async (params) => {
    const site = await engine.publishSite({ folderPath: params?.folderPath, name: params?.name, writeMode: params?.writeMode, spa: params?.spa, expirationPreset: params?.expirationPreset })
    emit(EVENTS.SITE_UPDATED, { site, action: 'published' })
    return site
  }
  handlers[METHODS.SITES_UPDATE] = async (params) => {
    const site = await engine.updateSite(params?.siteId, params?.patch || {})
    emit(EVENTS.SITE_UPDATED, { site, action: 'updated' })
    return site
  }
  handlers[METHODS.SITES_UNPUBLISH] = async (params) => {
    await engine.unpublishSite(params?.siteId)
    emit(EVENTS.SITE_UPDATED, { siteId: params?.siteId, action: 'unpublished' })
    return { success: true }
  }
  handlers[METHODS.SITES_ADD_VISITOR] = async (params) => {
    return engine.addSiteVisitor(params?.siteId, params?.code, { timeoutMs: 60000, role: params?.role })
  }
  handlers[METHODS.SITES_UPDATE_VISITOR_ROLE] = async (params) => {
    await engine.siteManager.updateAllowlistRole(params?.siteId, params?.publicKey, params?.role)
    emit(EVENTS.SITE_UPDATED, { siteId: params?.siteId, action: 'visitor_role' })
    return { success: true }
  }
  handlers[METHODS.SITES_REMOVE_VISITOR] = async (params) => {
    await engine.removeSiteVisitor(params?.siteId, params?.publicKey)
    emit(EVENTS.SITE_UPDATED, { siteId: params?.siteId, action: 'visitor_removed' })
    return { success: true }
  }
  handlers[METHODS.SITES_VISIT] = async (params) => engine.visitSite(params?.code)
  // Leave a specific visit by siteId (or all when omitted).
  handlers[METHODS.SITES_LEAVE] = async (params) => engine.leaveSite(params?.siteId)
  handlers[METHODS.SITES_GET_ACTIVE] = async () => ({
    hosting: engine.getActiveSite ? engine.getActiveSite() : null,
    activeSites: engine.listActiveSites ? engine.listActiveSites() : [],
    visiting: engine.getActiveVisit ? engine.getActiveVisit() : null,
    // Multi-visit: every folder this device is currently browsing.
    visits: engine.getActiveVisits ? engine.getActiveVisits() : []
  })
  // Legacy single-visit file ops: keep `siteId` optional and let the engine
  // resolve the (single) active visit when omitted.
  handlers[METHODS.SITES_LIST_FILES] = async (params) => engine.listSitePath(params?.path || '/', params?.siteId)
  handlers[METHODS.SITES_LIST_PATH] = async (params) => engine.listSitePath(params?.path || '/', params?.siteId)
  handlers[METHODS.SITES_GET_STATS] = async (params) => engine.siteStats(params?.siteId)
  handlers[METHODS.SITES_WRITE_FILE] = async (params) => {
    const data = params?.dataBase64 ? Buffer.from(params.dataBase64, 'base64') : Buffer.from(String(params?.data || ''), 'utf8')
    return engine.writeSiteFile(params?.path, data, params?.siteId)
  }
  handlers[METHODS.SITES_MKDIR] = async (params) => engine.mkdirSitePath(params?.path, params?.siteId)
  handlers[METHODS.SITES_DELETE] = async (params) => engine.deleteSitePath(params?.path, params?.siteId)
  // ─── Tunnel (Holesail-style: paired + ephemeral TUNNEL-XXXX) ──────────
  handlers[METHODS.TUNNEL_CREATE] = async (params) => engine.createTunnel({ peerId: params?.peerId, port: params?.port, host: params?.host || '127.0.0.1', name: params?.name || '', udp: !!params?.udp })
  handlers[METHODS.TUNNEL_ACCEPT] = async (params) => engine.acceptTunnel(params?.tunnelId, { localPort: params?.localPort, localHost: params?.localHost || '127.0.0.1' })
  handlers[METHODS.TUNNEL_REJECT] = async (params) => engine.rejectTunnel(params?.tunnelId, params?.reason || 'rejected')
  handlers[METHODS.TUNNEL_CLOSE] = async (params) => engine.closeTunnel(params?.tunnelId, params?.reason || 'closed-by-user')
  handlers[METHODS.TUNNEL_LIST] = async () => engine.listTunnels()
  handlers[METHODS.TUNNEL_CREATE_CODE] = async (params) => engine.createTunnelCode({ port: params?.port, host: params?.host || '127.0.0.1', name: params?.name || '', udp: !!params?.udp, expirationPreset: params?.expirationPreset || '30m', maxUses: params?.maxUses || 0 })
  handlers[METHODS.TUNNEL_JOIN_CODE] = async (params) => engine.joinTunnelCode(params?.code)
  handlers[METHODS.TUNNEL_CANCEL_CODE] = async (params) => engine.cancelTunnelCode(params?.code || params?.id)
  handlers[METHODS.TUNNEL_LIST_CODES] = async () => engine.listTunnelCodes()

  handlers[METHODS.SITES_GET_URL] = async (params) => {
    // Backed by the Electron sites gateway (electron/sites-gateway.js), which
    // serves live visits/hosted sites over HTTP. Injected resolver — same
    // rationale as stream.getUrl above.
    if (typeof getSitesUrl !== 'function') {
      throw new Error('sites.getUrl is unavailable in this host (no sites gateway loaded)')
    }
    return getSitesUrl(engine, params)
  }

  return handlers
}

module.exports = { registerEngineHandlers, cleanupDuplicateDevices }
