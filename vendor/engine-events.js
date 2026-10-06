'use strict'

// Engine → protocol event translation, shared by every process that owns a
// MeshEngine so the client-facing event vocabulary can never drift:
//   - Electron main (electron/engine.js) streams these to the renderer over
//     the legacy 'pear:worker:ipc:' channel;
//   - the standalone host (meshdrop-host) streams the same frames over its
//     WebSocket /events endpoint.
//
// The translation table lives here; each consumer supplies only the final
// framing (its event sink). The sync-origin suppression gate that engine.js
// and handlers.js each used to duplicate also lives here, once.

const { EVENTS } = require('./protocol.js')

// A sync-origin transfer lifecycle frame must never surface the incoming-
// offer dialog. Sync transfers are started by the engine itself, so an
// "offer" for one is an implementation detail, not a user-facing event.
const SYNC_SUPPRESSED_EVENTS = new Set([
  EVENTS.TRANSFER_OFFER_RECEIVED,
  EVENTS.TRANSFER_QUEUED,
  EVENTS.TRANSFER_STARTED,
  EVENTS.TRANSFER_COMPLETED
])

function isSyncPayload(data) {
  return !!(data && (data.isSync || data.source === 'sync'))
}

// Whether a protocol event frame should reach clients at all.
function shouldForwardProtocolEvent(event, data) {
  return !(SYNC_SUPPRESSED_EVENTS.has(event) && isSyncPayload(data))
}

// One row per MeshEngine event:
//   on     — the @meshdrop-go/core event name
//   to     — protocol EVENTS forwarded with the engine payload (post-shape)
//   shape  — optional payload transform (payload, engine) => data
//   also   — optional extra pushes computed from (payload, engine), e.g. a
//            status snapshot that must always accompany the row
const EVENT_ROWS = [
  {
    on: 'peer:connected',
    to: [EVENTS.DEVICE_PAIRED, EVENTS.PEER_CONNECTED, EVENTS.DEVICE_ONLINE, EVENTS.DEVICE_UPDATED],
    also: (payload, engine) => [[EVENTS.CONNECTION_CHANGED, engine.getStatus()]]
  },
  {
    on: 'peer:disconnected',
    // Only the id travels on — the renderer keys rows by id and a stale full
    // device object could resurrect UI state for a device that left.
    shape: ({ id }) => ({ id }),
    to: [EVENTS.PEER_DISCONNECTED, EVENTS.DEVICE_OFFLINE, EVENTS.DEVICE_UPDATED],
    also: (payload, engine) => [[EVENTS.CONNECTION_CHANGED, engine.getStatus()]]
  },
  { on: 'trust:paired', shape: ({ peer }) => peer, to: [EVENTS.DEVICE_PAIRED, EVENTS.DEVICE_UPDATED] },
  // Two-tier trust: a LAN peer recognized at the 'lan' level. Surfaces the
  // one-tap "pair?" prompt (the lan-level identity row is display-only).
  { on: 'device:detected:lan', to: [EVENTS.DEVICE_DISCOVERED, EVENTS.DEVICE_UPDATED] },
  { on: 'trust:revoked', to: [EVENTS.DEVICE_REMOVED] },
  { on: 'device:removed', to: [EVENTS.DEVICE_REMOVED] },
  { on: 'device:updated', to: [EVENTS.DEVICE_UPDATED] },
  { on: 'transfer:offer', to: [EVENTS.TRANSFER_OFFER_RECEIVED] },
  { on: 'transfer:queued', to: [EVENTS.TRANSFER_QUEUED] },
  { on: 'transfer:started', to: [EVENTS.TRANSFER_STARTED] },
  { on: 'transfer:progress', to: [EVENTS.TRANSFER_PROGRESS] },
  { on: 'transfer:paused', to: [EVENTS.TRANSFER_PAUSED] },
  { on: 'transfer:resumed', to: [EVENTS.TRANSFER_RESUMED] },
  { on: 'transfer:cancelled', to: [EVENTS.TRANSFER_CANCELLED] },
  { on: 'transfer:completed', to: [EVENTS.TRANSFER_COMPLETED] },
  { on: 'transfer:failed', to: [EVENTS.TRANSFER_FAILED] },
  { on: 'sync:library:added', to: [EVENTS.SYNC_LIBRARY_ADDED] },
  { on: 'sync:library:removed', to: [EVENTS.SYNC_LIBRARY_REMOVED] },
  { on: 'sync:scan', to: [EVENTS.SYNC_SCAN] },
  { on: 'sync:up_to_date', to: [EVENTS.SYNC_UP_TO_DATE] },
  { on: 'sync:completed', to: [EVENTS.SYNC_COMPLETED] },
  { on: 'sync:deleted', to: [EVENTS.SYNC_DELETED] },
  { on: 'sync:conflict', to: [EVENTS.SYNC_CONFLICT] },
  { on: 'sync:error', to: [EVENTS.SYNC_ERROR] },
  { on: 'sync:denied', to: [EVENTS.SYNC_DENIED] },
  { on: 'sync:invite:received', to: [EVENTS.SYNC_INVITE_RECEIVED] },
  { on: 'sync:phase', to: [EVENTS.SYNC_PHASE] },
  { on: 'claim:preview', to: [EVENTS.CLAIM_PREVIEW_RECEIVED] },
  // Host-side drop-share lifecycle: an expiry sweep or a first claim flipped
  // a pending share — clients refresh their share grid on these.
  { on: 'pending:share:expired', to: [EVENTS.PENDING_SHARE_EXPIRED] },
  { on: 'pending:share:claimed', to: [EVENTS.PENDING_SHARE_CLAIMED] },
  { on: 'watch:state:updated', to: [EVENTS.WATCH_STATE_CHANGED] },
  { on: 'party:room:created', to: [EVENTS.WATCH_ROOM_CREATED] },
  { on: 'party:room:joined', to: [EVENTS.WATCH_ROOM_JOINED] },
  { on: 'party:room:updated', to: [EVENTS.WATCH_ROOM_UPDATED] },
  { on: 'party:room:left', to: [EVENTS.WATCH_ROOM_LEFT] },
  { on: 'party:room:closed', to: [EVENTS.WATCH_ROOM_CLOSED] },
  { on: 'party:peer:joined', to: [EVENTS.WATCH_PEER_JOINED] },
  { on: 'party:peer:left', to: [EVENTS.WATCH_PEER_LEFT] },
  { on: 'party:peer:status', to: [EVENTS.WATCH_PEER_STATUS] },
  { on: 'party:state:sync', to: [EVENTS.WATCH_STATE_SYNC] },
  { on: 'party:reaction', to: [EVENTS.WATCH_REACTION] },
  { on: 'party:rooms:discovered', to: [EVENTS.WATCH_ROOMS_DISCOVERED] },
  { on: 'party:media:offer', to: [EVENTS.WATCH_MEDIA_OFFER] },
  { on: 'party:media:ready', to: [EVENTS.WATCH_MEDIA_READY] },
  { on: 'party:media:error', to: [EVENTS.WATCH_MEDIA_ERROR] },
  { on: 'party:chat', to: [EVENTS.WATCH_CHAT_MESSAGE] },
  { on: 'party:chat:history', to: [EVENTS.WATCH_CHAT_HISTORY] },
  { on: 'party:voice', to: [EVENTS.WATCH_VOICE_CHUNK] },
  { on: 'party:moderated', to: [EVENTS.WATCH_MODERATED] },
  { on: 'site:visitor:added', to: [EVENTS.SITE_VISITOR_ADDED] },
  { on: 'site:invite:received', to: [EVENTS.SITE_INVITE_RECEIVED] },
  { on: 'site:visitor:removed', to: [EVENTS.SITE_VISITOR_REMOVED] },
  { on: 'site:visitor:failed', to: [EVENTS.SITE_VISITOR_FAILED] },
  { on: 'site:visit:started', to: [EVENTS.SITE_VISIT_STARTED] },
  { on: 'site:visit:stopped', to: [EVENTS.SITE_VISIT_STOPPED] },
  { on: 'notification:received', to: [EVENTS.NOTIFICATION_RECEIVED] },
  { on: 'tunnel:offer', to: [EVENTS.TUNNEL_OFFER] },
  { on: 'tunnel:opened', to: [EVENTS.TUNNEL_OPENED] },
  { on: 'tunnel:closed', to: [EVENTS.TUNNEL_CLOSED] },
  { on: 'tunnel:error', to: [EVENTS.TUNNEL_ERROR] }
]

// Wire a started MeshEngine to a protocol sink. `sink.send(event, data)` must
// perform the final framing for its transport (Electron IPC push, WS frame).
// Optional hooks cover behaviors that are not pure translations:
//   onVisitStarted(data) / onVisitStopped(data) — transport side-effects when
//     a site visit begins/ends (Electron resets its sites-gateway token;
//     headless hosts register their own later, none for now).
//   onEngineError(err, kind) — engine 'error' events that are not a drop-claim
//     failure, for process logging; kind is 'coded' or 'plain'.
function subscribeEngineEvents({ engine, sink, hooks = {} }) {
  const { onVisitStarted, onVisitStopped, onEngineError } = hooks

  for (const row of EVENT_ROWS) {
    engine.on(row.on, (payload) => {
      const data = row.shape ? row.shape(payload, engine) : payload
      for (const event of row.to) pushToSink(sink, event, data)
      if (row.also) {
        for (const [event, extra] of row.also(payload, engine) || []) pushToSink(sink, event, extra)
      }
    })
  }

  // Registered after the table rows above so the protocol frames go out first,
  // exactly like the historical wireEvents ordering.
  if (onVisitStarted) {
    engine.on('site:visit:started', (data) => onVisitStarted(data))
  }
  if (onVisitStopped) {
    engine.on('site:visit:stopped', (data) => onVisitStopped(data))
  }
  engine.on('error', (err) => {
    const isClaimRejected = err && err.code === 'claim_rejected'
    if (err && err.code && !isClaimRejected) {
      // A coded engine error with nothing to forward to clients — log only.
      if (onEngineError) onEngineError(err, 'coded')
      return
    }
    if (isClaimRejected) {
      // The client toasts drop-claim failures (expired / already used).
      pushToSink(sink, EVENTS.PENDING_SHARE_CLAIM_FAILED, err)
      return
    }
    if (onEngineError) onEngineError(err, 'plain')
  })
}

function pushToSink(sink, event, data) {
  if (shouldForwardProtocolEvent(event, data)) sink.send(event, data)
}

module.exports = {
  EVENT_ROWS,
  subscribeEngineEvents,
  shouldForwardProtocolEvent,
  isSyncPayload
}
