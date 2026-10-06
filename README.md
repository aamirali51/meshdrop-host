# @meshdrop-go/host

Headless MeshDrop node + the `mesh` command-line client. Boots the real engine
([`@meshdrop-go/core`](https://www.npmjs.com/package/@meshdrop-go/core)) with **no
Electron** and exposes the exact app protocol over a token-authed localhost
HTTP + WebSocket API. Built for servers, NAS boxes and scripts.

## Install

**npm (Linux / macOS / any Node 18+ host):**
```sh
npm install -g @meshdrop-go/host
mesh status
```

**Docker (NAS / servers):** see `docker-compose.yml`. Host networking is
**required** — Docker's default bridge hides the real LAN address and breaks
peer discovery.
```sh
docker compose up -d
```

## Quick start

```sh
mesh host                 # run the headless node (foreground)
mesh status               # peers, connection, active transfers
mesh whoami               # this device + its pairing code
mesh drop ./folder --never            # share a link that never expires
mesh get DROP-XXXX-XXXX               # receive someone's code
mesh peek DROP-XXXX-XXXX              # is that code online? (no download)
mesh send ./file.pdf --to nas         # send straight to a paired device
mesh pair MD-XXXX-XXXX-XXXX-XXXX      # pair with a device by code
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
{ "name": "nas", "port": 41990, "downloads": "/downloads" }
```
Env equivalents: `MESHDROP_HOST_STORAGE`, `MESHDROP_HOST_DOWNLOADS`,
`MESHDROP_HOST_PORT`, `MESHDROP_HOST_NAME`.

## Logs

The daemon appends to `<store>/host.log` (and stdout):

```sh
mesh logs --lines 100
mesh logs --follow
```

## Commands

`status` `whoami` `doctor` `ls <devices|peers|drops|transfers|sync|sites|tunnels|rooms|invites>`
`send` `drop` `get` `peek` `revoke` `extend` `pair` `unpair`
`sync add|rm|pause|resume|run|accept|decline` `site publish|rm`
`tunnel open|close|join` `party create|join|leave` `relay status|on|off`
`config get|set` `events` `logs` `service install|status|uninstall`
`host` `help` `version` `commands`

## Notes

- The engine store is **exclusive**: one host per directory. A stale lock (dead
  or reused PID) is reclaimed automatically; a live host is detected and the CLI
  talks to it instead of booting a second engine.
- Nothing leaves your devices — connections are end-to-end encrypted; the relay
  never sees file contents.
- **Back up the store** (`/data` in Docker) — it holds your identity.
