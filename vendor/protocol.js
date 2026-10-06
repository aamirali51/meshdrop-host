'use strict'

// Single source of truth for the MeshDrop IPC protocol.
// Consumed by: Electron main (electron/main.js), which serves it from the
// in-process @meshdrop-go/core engine, and the renderer (via renderer/src/types/protocol.ts).

const PROTOCOL_VERSION = '1.0'

const METHODS = {
  DEVICES_LIST: 'devices.list',
  DEVICES_PAIR: 'devices.pair',
  DEVICES_PAIR_CODE: 'devices.pairCode',
  DEVICES_GET_CODE: 'devices.getCode',
  DEVICES_RENAME: 'devices.rename',
  DEVICES_REMOVE: 'devices.remove',
  DEVICES_FAVORITE: 'devices.favorite',
  DEVICES_TRUST: 'devices.trust',
  DEVICES_CONFIRM_LAN: 'devices.confirmLanPair',
  DEVICES_GET_IDENTITY: 'devices.getIdentity',
  DIAGNOSTICS_GET: 'diagnostics.get',
  NOTIFICATIONS_LIST: 'notifications.list',
  NOTIFICATIONS_CLEAR: 'notifications.clear',
  NOTIFICATIONS_MARK_READ: 'notifications.markRead',
  HISTORY_LIST: 'history.list',
  HISTORY_CLEAR: 'history.clear',
  CONNECTION_STATUS: 'connection.status',
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  STORAGE_CLEAR: 'storage.clear',
  FILES_CREATE_CODE: 'files.createCode',
  FILES_CLAIM_CODE: 'files.claimCode',
  FILES_CONFIRM_CLAIM: 'files.confirmClaim',
  FILES_CANCEL_CLAIM: 'files.cancelClaim',
  FILES_LIST_PENDING: 'files.listPending',
  FILES_EXTEND_EXPIRATION: 'files.extendExpiration',
  FILES_CANCEL_CODE: 'files.cancelCode',
  FILES_DELETE_PENDING: 'files.deletePending',
  TRANSFERS_START: 'transfers.start',
  TRANSFERS_ACCEPT: 'transfers.accept',
  TRANSFERS_DECLINE: 'transfers.decline',
  TRANSFERS_PAUSE: 'transfers.pause',
  TRANSFERS_RESUME: 'transfers.resume',
  TRANSFERS_CANCEL: 'transfers.cancel',
  TRANSFERS_RETRY: 'transfers.retry',
  TRANSFERS_LIST: 'transfers.list',
  TRANSFERS_CLEAR: 'transfers.clear',
  TRANSFERS_DELETE: 'transfers.delete',
  TRANSFERS_BROADCAST: 'transfers.broadcast',
  SYNC_ADD: 'sync.add',
  SYNC_REMOVE: 'sync.remove',
  SYNC_LIST: 'sync.list',
  SYNC_TRIGGER: 'sync.trigger',
  SYNC_PAUSE: 'sync.pause',
  SYNC_RESUME: 'sync.resume',
  SYNC_ACCEPT_INVITE: 'sync.acceptInvite',
  SYNC_DECLINE_INVITE: 'sync.declineInvite',
  SYNC_LIST_INVITES: 'sync.listInvites',
  SHARED_LIST: 'shared.list',
  SHARED_REMOVE: 'shared.remove',
  SHARED_FAVORITE: 'shared.favorite',
  DRIVE_GET_STATUS: 'drive.getStatus',
  DRIVE_MOUNT: 'drive.mount',
  DRIVE_UNMOUNT: 'drive.unmount',
  DRIVE_UPDATE_PERMISSIONS: 'drive.updatePermissions',
  DRIVE_BROADCAST_FILE: 'drive.broadcastFile',
  DRIVE_SHARE_INVITE: 'drive.shareInvite',
  DRIVE_SHARE_ACCEPT: 'drive.shareAccept',
  DRIVE_SHARE_DECLINE: 'drive.shareDecline',
  WATCH_STATE_BROADCAST: 'watch.stateBroadcast',
  WATCH_PARTY_CREATE: 'watch.createRoom',
  WATCH_PARTY_JOIN: 'watch.joinRoom',
  WATCH_PARTY_LEAVE: 'watch.leaveRoom',
  WATCH_PARTY_GET_ROOM: 'watch.getRoom',
  WATCH_PARTY_LIST_ROOMS: 'watch.listRooms',
  WATCH_PARTY_REACTION: 'watch.reaction',
  WATCH_PARTY_STATUS: 'watch.status',
  WATCH_PARTY_CHAT: 'watch.chat',
  WATCH_PARTY_CHAT_HISTORY: 'watch.chatHistory',
  WATCH_PARTY_MODERATE: 'watch.moderate',
  WATCH_PARTY_QUEUE_ADD: 'watch.queueAdd',
  WATCH_PARTY_QUEUE_REMOVE: 'watch.queueRemove',
  WATCH_PARTY_QUEUE_NEXT: 'watch.queueNext',
  WATCH_PARTY_SUBTITLE_SET: 'watch.subtitleSet',
  WATCH_PARTY_SUBTITLE_GET: 'watch.subtitleGet',
  WATCH_PARTY_REWIND_SET: 'watch.rewindSet',
  WATCH_PARTY_VOICE: 'watch.voice',
  TRANSFERS_EXTENT: 'transfers.extent',
  SET_PLAYHEAD_BYTE: 'setPlayheadByte',
  STREAM_URL_GET: 'stream.getUrl',
  SITES_LIST: 'sites.list',
  SITES_LIST_ACTIVE: 'sites.listActive',
  SITES_LIST_RECEIVED: 'sites.listReceived',
  SITES_REMOVE_RECEIVED: 'sites.removeReceived',
  SITES_PUBLISH: 'sites.publish',
  SITES_UNPUBLISH: 'sites.unpublish',
  SITES_UPDATE: 'sites.update',
  SITES_ADD_VISITOR: 'sites.addVisitor',
  SITES_UPDATE_VISITOR_ROLE: 'sites.updateVisitorRole',
  SITES_REMOVE_VISITOR: 'sites.removeVisitor',
  SITES_VISIT: 'sites.visit',
  SITES_LEAVE: 'sites.leave',
  SITES_GET_ACTIVE: 'sites.getActive',
  // siteId-scoped file ops: address a specific concurrent visit (a device may
  // browse several hosts' shared folders at once). `path` is always required;
  // the siteId selects which visit.
  SITES_LIST_FILES: 'sites.listFiles',
  SITES_WRITE_FILE: 'sites.writeFile',
  SITES_MKDIR: 'sites.mkdir',
  SITES_DELETE: 'sites.delete',
  SITES_GET_URL: 'sites.getUrl',
  SITES_LIST_PATH: 'sites.listPath',
  SITES_GET_STATS: 'sites.getStats',
  TUNNEL_CREATE: 'tunnel.create',
  TUNNEL_ACCEPT: 'tunnel.accept',
  TUNNEL_REJECT: 'tunnel.reject',
  TUNNEL_CLOSE: 'tunnel.close',
  TUNNEL_LIST: 'tunnel.list',
  TUNNEL_CREATE_CODE: 'tunnel.createCode',
  TUNNEL_JOIN_CODE: 'tunnel.joinCode',
  TUNNEL_CANCEL_CODE: 'tunnel.cancelCode',
  TUNNEL_LIST_CODES: 'tunnel.listCodes'
}

const EVENTS = {
  WATCH_ROOM_CREATED: 'watch.room_created',
  WATCH_ROOM_JOINED: 'watch.room_joined',
  WATCH_ROOM_UPDATED: 'watch.room_updated',
  WATCH_ROOM_LEFT: 'watch.room_left',
  WATCH_ROOM_CLOSED: 'watch.room_closed',
  WATCH_PEER_JOINED: 'watch.peer_joined',
  WATCH_PEER_LEFT: 'watch.peer_left',
  WATCH_PEER_STATUS: 'watch.peer_status',
  WATCH_STATE_SYNC: 'watch.state_sync',
  WATCH_REACTION: 'watch.reaction',
  WATCH_ROOMS_DISCOVERED: 'watch.rooms_discovered',
  WATCH_MEDIA_OFFER: 'watch.media_offer',
  WATCH_MEDIA_READY: 'watch.media_ready',
  WATCH_MEDIA_ERROR: 'watch.media_error',
  WATCH_CHAT_MESSAGE: 'watch.chat_message',
  WATCH_CHAT_HISTORY: 'watch.chat_history',
  WATCH_VOICE_CHUNK: 'watch.voice_chunk',
  WATCH_MODERATED: 'watch.moderated',
  DEVICE_ONLINE: 'device.online',
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_DISCOVERED: 'device.discovered',
  DEVICE_PAIRED: 'device.paired',
  DEVICE_UPDATED: 'device.updated',
  DEVICE_REMOVED: 'device.removed',
  PEER_CONNECTED: 'peer.connected',
  PEER_DISCONNECTED: 'peer.disconnected',
  WORKER_READY: 'worker.ready',
  CONNECTION_CHANGED: 'connection.changed',
  NOTIFICATION_RECEIVED: 'notification.received',
  TRANSFER_OFFER_RECEIVED: 'transfer.offer_received',
  TRANSFER_STARTED: 'transfer.started',
  TRANSFER_PROGRESS: 'transfer.progress',
  TRANSFER_COMPLETED: 'transfer.completed',
  TRANSFER_FAILED: 'transfer.failed',
  TRANSFER_PAUSED: 'transfer.paused',
  TRANSFER_RESUMED: 'transfer.resumed',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  TRANSFER_QUEUED: 'transfer.queued',
  PENDING_SHARE_UPDATED: 'pending_share.updated',
  PENDING_SHARE_EXPIRED: 'pending_share.expired',
  PENDING_SHARE_CLAIMED: 'pending_share.claimed',
  PENDING_SHARE_CLAIM_FAILED: 'pending_share.claimFailed',
  CLAIM_PREVIEW_RECEIVED: 'claim.preview_received',
  SYNC_LIBRARY_ADDED: 'sync.library_added',
  SYNC_LIBRARY_REMOVED: 'sync.library_removed',
  SYNC_SCAN: 'sync.scan',
  SYNC_UP_TO_DATE: 'sync.up_to_date',
  SYNC_COMPLETED: 'sync.completed',
  SYNC_DELETED: 'sync.deleted',
  SYNC_CONFLICT: 'sync.conflict',
  SYNC_ERROR: 'sync.error',
  SYNC_DENIED: 'sync.denied',
  SYNC_INVITE_RECEIVED: 'sync.invite_received',
  SYNC_PHASE: 'sync.phase',
  SETTINGS_UPDATED: 'settings.updated',
  WATCH_STATE_CHANGED: 'watch.stateChanged',
  SITE_VISITOR_ADDED: 'site.visitor_added',
  SITE_VISITOR_REMOVED: 'site.visitor_removed',
  SITE_VISITOR_FAILED: 'site.visitor_failed',
  SITE_VISIT_STARTED: 'site.visit_started',
  SITE_VISIT_STOPPED: 'site.visit_stopped',
  SITE_INVITE_RECEIVED: 'site.invite_received',
  SITE_UPDATED: 'site.updated',
  TUNNEL_OFFER: 'tunnel.offer',
  TUNNEL_OPENED: 'tunnel.opened',
  TUNNEL_CLOSED: 'tunnel.closed',
  TUNNEL_ERROR: 'tunnel.error'
}

// A message is compatible when it is unversioned (legacy v1) or exactly matches
// the current protocol version. Unknown future versions are rejected.
function isProtocolCompatible(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (msg.v === undefined || msg.v === null) return true // legacy unversioned
  return msg.v === PROTOCOL_VERSION
}

let nextId = 1
function generateId() {
  return (nextId++).toString(36)
}

function createRequest(method, params) {
  return JSON.stringify({
    type: 'request',
    v: PROTOCOL_VERSION,
    id: generateId(),
    method,
    params
  })
}

function createResponse(id, result, error) {
  return JSON.stringify({
    type: 'response',
    v: PROTOCOL_VERSION,
    id,
    result,
    error
  })
}

function createEvent(event, data) {
  return JSON.stringify({
    type: 'event',
    v: PROTOCOL_VERSION,
    event,
    data
  })
}

function parseMessage(buffer) {
  try {
    return JSON.parse(buffer.toString())
  } catch {
    return null
  }
}

module.exports = {
  PROTOCOL_VERSION,
  METHODS,
  EVENTS,
  isProtocolCompatible,
  generateId,
  createRequest,
  createResponse,
  createEvent,
  parseMessage
}
