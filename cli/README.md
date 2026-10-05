# `mesh` — the MeshDrop command line

A thin, machine-friendly client over MeshDrop's engine. Same protocol as the
desktop app and the headless host — no second implementation of anything.

```sh
mesh status
mesh drop ./recipes --never
mesh get DROP-5SEG-6QAD --out ~/Downloads
mesh send ~/report.pdf --to nas
mesh ls peers
mesh pair MD-1234-5678
mesh sync add ~/Projects --to laptop
```

## Design rules

- **One grammar:** `mesh <verb> [noun] [subaction] [args] [flags]`. No abbreviations, no aliases.
- **Non-interactive:** never prompts. A missing argument is a usage error naming the flag you need.
- **`--json` everywhere:** stdout is *only* the result (`{"ok":true,"data":…}` or `{"ok":false,"code","message"}`); engine logs go to stderr, so `mesh … --json | jq` always works.
- **Introspection:** `mesh commands --json` prints the whole surface so an agent can discover it.
- **Exit codes:** `0` ok · `1` error · `2` usage · `3` not-found · `4` conflict.
- **Safe by default:** destructive commands (`revoke`, `unpair`, `sync rm`, `site rm`, `tunnel close`) refuse without `--yes`; every mutating command supports `--dry-run`.

## Global flags / env

| Flag | Meaning |
|---|---|
| `--json` | machine-readable output on stdout |
| `--yes` | allow a destructive command |
| `--dry-run` | report what would happen, change nothing |
| `--host <url>` `--token <t>` | talk to a running host (overrides the store) |
| `--store <dir>` | engine store (default `~/.meshdrop-host`) |
| `--quiet` | suppress human output |

Env: `MESH_HOST`, `MESH_TOKEN`, `MESH_STORE`, `MESH_DOWNLOADS`.

## Backends

- **client** — if `--host`/`MESH_HOST` is set, or a host is already running on the store, commands go over the host's token-authed loopback `/rpc`. Fast; safe to run alongside the desktop app.
- **embedded** — otherwise the engine boots in-process for one command and stops, taking the same exclusive store lock the host does. Use `mesh host` to run the daemon for many commands.

## Commands

```
mesh status | whoami | doctor
mesh ls devices|peers|drops|transfers|sync|sites|tunnels|rooms
mesh send <path…> --to <peer>
mesh drop <path…> [--never|--days N|--hours N] [--max N] [--name <title>]
mesh get <code> [--out <dir>]
mesh revoke|extend <code>
mesh pair <code> · unpair <peer>
mesh sync add|rm|pause|resume|run|accept|decline
mesh site publish|rm · tunnel open|close · party create|join|leave
mesh relay status · config get|set
mesh host
mesh help | version | commands --json
```

Run `mesh help` or `mesh <verb> --help` for usage.
