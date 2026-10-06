# @meshdrop-go/host

Headless MeshDrop node + the `mesh` command-line client. Boots the real engine
([`@meshdrop-go/core`](https://www.npmjs.com/package/@meshdrop-go/core)) with **no
Electron** and exposes the exact app protocol over a token-authed localhost
HTTP + WebSocket API. Built for servers, NAS boxes and scripts.

- npm: <https://www.npmjs.com/package/@meshdrop-go/host>
- Container image: `ghcr.io/aamirali51/meshdrop-host` (linux/amd64 + linux/arm64)

## Install

**npm (Linux / macOS / Windows, Node 18+):**
```sh
npm install -g @meshdrop-go/host
mesh version
```
No global install? `npx @meshdrop-go/host status` runs it once.

**Docker (NAS / servers):** an image is published to GHCR; `docker-compose.yml`
is in this repo. Host networking is **required** — Docker's default bridge hides
the real LAN address and breaks peer discovery.
```sh
docker run -d --name meshdrop --network host \
  -e PUID=1000 -e PGID=1000 -e MESHDROP_HOST_NAME=nas \
  -v ./meshdrop-data:/data -v ./meshdrop-downloads:/downloads \
  --restart unless-stopped ghcr.io/aamirali51/meshdrop-host:latest
```

## Quick start

```sh
mesh host                 # run the headless node (foreground)
mesh status --watch       # live peers, connection, active transfers
mesh whoami               # this device + its pairing code
mesh drop ./folder --never            # share a link that never expires
mesh get DROP-XXXX-XXXX               # receive someone's code
mesh peek DROP-XXXX-XXXX              # is that code online? (no download)
mesh send ./file.pdf --to nas         # send straight to a paired device
mesh watch ~/inbox --to nas           # auto-send files that appear
mesh pair MD-XXXX-XXXX-XXXX-XXXX      # pair with a device by code
mesh update                           # check npm for a newer release
```

Every command takes `--json`; `mesh commands --json` prints the whole machine
-readable surface; `mesh help` is the cheat sheet.

## Run as a service

```sh
mesh service install                  # systemd (user), launchd, or a Windows logon task
mesh service install --system         # system-wide systemd unit (needs root)
mesh service status
mesh service uninstall --yes
mesh service install --dry-run        # print the unit file, change nothing
```

## Config

Defaults live in `<store>/config.json` (created by `mesh service install`, or by
hand). CLI flags and environment variables override it.

```json
{ "name": "nas", "port": 41990, "downloads": "/downloads", "bind": "127.0.0.1", "profile": "server" }
```
Env equivalents: `MESHDROP_HOST_STORAGE`, `MESHDROP_HOST_DOWNLOADS`,
`MESHDROP_HOST_PORT`, `MESHDROP_HOST_NAME`, `MESHDROP_HOST_BIND`.

`profile: "server"` (or `mesh host --profile server`) uses larger transfer/sync
windows for always-on boxes. `bind` stays `127.0.0.1` (loopback only) by default;
set it to a LAN address to expose the API — the token is then the gate.

## Logs & monitoring

The daemon appends to `<store>/host.log` (and stdout):

```sh
mesh logs --lines 100
mesh logs --follow
```

- `GET /health` — liveness (unauthenticated).
- `GET /metrics` — Prometheus gauges: `meshdrop_up`, `meshdrop_peers`,
  `meshdrop_dht_nodes`, `meshdrop_active_transfers`, `meshdrop_shares`,
  `meshdrop_sites`, `meshdrop_uptime_seconds`.

## Commands

`status` `whoami` `doctor` `ls <devices|peers|drops|transfers|sync|sites|tunnels|rooms|invites>`
`send` `drop` `get` `peek` `revoke` `extend` `pair` `unpair`
`sync add|rm|pause|resume|run|accept|decline` `site publish|rm`
`tunnel open|close|join` `party create|join|leave` `relay status|on|off`
`config get|set` `watch` `events` `logs` `service install|status|uninstall`
`update` `host` `help` `version` `commands`

## Notes

- The engine store is **exclusive**: one host per directory. A stale lock (dead
  or reused PID) is reclaimed automatically; a live host is detected and the CLI
  talks to it instead of booting a second engine.
- Nothing leaves your devices — connections are end-to-end encrypted; the relay
  never sees file contents.
- **Back up the store** (`/data` in Docker) — it holds your identity and config.

## License

MIT — see [LICENSE](LICENSE).
