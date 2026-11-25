# HTTP API

JSON over HTTP. If `http.token` is set, send `Authorization: Bearer <token>` (or `?token=` for the event stream).
Errors: `{"error": "..."}` with status 400 (invalid input or rejected by MCLI), 401, 404, 405, 413 or 500.

## Network and servers

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/network` | | servers, latest RAM frame, RAM plan |
| GET | `/api/servers` | | list of `{config, connection, error, needsRestart, status}` |
| POST | `/api/servers` | `id`, `role` (`backend`/`proxy`), `name`, `dir`, `autoStart`, `memory` | the new server (one proxy at most) |
| GET | `/api/servers/:id` | | one server |
| DELETE | `/api/servers/:id` | | removes it from the network (must be stopped; files stay) |

`status` is MCLI's status (state, pid, uptime, software, memory, players, health, problems, installer, backups).
`connection` is `online`, `connecting`, `offline` or `failed`; `needsRestart` is true when the configured heap differs from the running one.

`PUT /api/servers/:id` changes `name`, `autoStart`, `entry` (join first) and `memory` (weight, minMb, maxMb, pinnedMb); other fields are rejected.

## Setup

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/setup/defaults` | | `{paper, velocity: {default, versions[]}, ram, configured}` (preselects a recommended/stable version) |
| POST | `/api/setup` | `{proxy?: {version, port, motd}, backends: [{id, name, version, memory, entry}], ram?: {reserveMb}, acceptEula: true, start}` | the job state; `proxy` is only used when the network has no proxy yet |
| GET | `/api/setup` | | the current/last job: `{id, status: running/done/failed, steps: [{id, label, status, detail}], error}` or `null` |

`acceptEula` must be `true`. Steps: create servers, plan RAM, install each server, first start of each server (to let it write its settings), connect (forwarding secret, `velocity.toml`), start.

## Importing existing servers

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/import/inspect` | `path` (absolute) | what the folder holds: `software`, `javaMajor`, `eula`, `properties`, `worlds`, `plugins`, `sizeBytes`, `warnings`, plus `support` (`full`, `convert`, `standalone`, `proxy`, `none`), `issues` (why it cannot be imported now) and `suggestedId`. Changes nothing. |

To import, send the folder in the setup request: `backends[i].import = {path, mode: "copy"|"move"|"link", convertToPaper?, standalone?, version?}` (and `proxy.import = {path, mode}` for an existing Velocity). The setup then shows `import:<id>` steps; steps that are not needed are `skipped`.

## Ports and internet access

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/ports` | | `{publicPort, rows: [{id, port, host, exposure, listening, state, issues, canMakeLocal}]}` |
| POST | `/api/servers/:id/port` | `port` and/or `localOnly: true` | moves a stopped server to another port (files, config, proxy list) or limits a game server to this machine |
| GET | `/api/ports/access` | | `{proxyPort, proxyRunning, lan[], firewall: {tool, active, commands[], note}, upnp: {enabled, mapping, error}, address, carrierNat}` |
| POST | `/api/ports/upnp/discover` | | `{found, router, host, externalIp, carrierNat}` |
| POST | `/api/ports/upnp/open` / `close` | | forwards / releases the proxy port on the router |
| POST | `/api/ports/check` | `confirm: true` | asks mcsrvstat.us to reach the proxy from outside: `{ip, port, online, version, motd, hints[]}` (needs `confirm`, because it sends the public address and port to that service) |

## Autopilot

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/autopilot` | | `{config, events[] (newest first), sleeping: [{name, since}], waking[], wakeSupported}` |
| PUT | `/api/autopilot` | any of `enabled`, `dryRun`, `intervalSeconds`, `gcOnPressure`, `stopIdle`, `idleMinutes`, `wakeOnDemand`, `restartOnLeak` | the new settings |
| POST | `/api/autopilot/wake` | `server` | `{started}` for a server the autopilot put to sleep |
| POST | `/api/shutdown` | | `{stopping: true}`; the daemon stops all servers gracefully and exits (for service managers) |

An event: `{t, action, server, reason, dryRun, ok, error?}` with `action` one of `free-memory`, `stop-idle`, `wake`, `ready`, `restart-leak`, `evacuate`, `blocked`. For a dry run `ok` is `null`.

## Control (forwarded to the server's MCLI)

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/servers/:id/start`, `/stop`, `/restart`, `/backup` | |
| POST | `/api/servers/:id/command` | `text`: sent to the server console |
| POST | `/api/servers/:id/eula` | accepts the Minecraft EULA |
| POST | `/api/servers/:id/install` | `provider` (`paper`, `vanilla`, `fabric`, `forge`, `velocity`), `version`, `backupFirst` |
| POST | `/api/servers/:id/update` | `latest` |
| GET | `/api/servers/:id/versions?provider=paper&snapshots=false` | |
| GET | `/api/servers/:id/logs?limit=200`, `/players`, `/settings` | |

## Agent plugins

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/agent` | | `{enabled, bundledVersion}` |
| POST | `/api/servers/:id/agent/install` | | (re)installs the plugin and its config into the server folder |
| POST | `/api/servers/:id/gc` | | queues "free memory"; `{id}` of the order |
| POST | `/api/servers/:id/evacuate` | `to` (default: the join-first server), `message` | asks the proxy plugin to move the players of this server; `{id}` |
| POST | `/api/servers/:id/agent/command` | `type` (`gc`/`evacuate`), arguments | same, generic |
| POST | `/api/agent/report` | the plugins' report | used by the plugins only, authenticated with `agent.token`; answers `{ok, commands[], sleeping[], awake[]}` (the last two are for the proxy plugin: servers it holds players for, and servers that are ready now). The proxy plugin adds `proxy.wakeRequests[]` to its report. |

A server's `agent` field: `{connected, lastSeen, version, bundledVersion, outdated, error, jvm, game, proxy, commands[]}`. Orders show up in `commands` (newest first) with `done`, `ok` and `message` once the plugin reported the outcome (one or two report intervals later).

## RAM

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/ram` | latest frame and the 24 h peak RSS per server |
| GET | `/api/ram/history?minutes=60&points=500` | frames, oldest first |
| GET | `/api/ram/recommendations` | per server: `state` (`collecting`/`ok`/`too-big`/`too-small`), `recommendedMb`, `peakLiveMb`, `peakUsedMb`, `deltaMb`, `reason` (needs the plugins and about 10 minutes of data) |
| GET | `/api/ram/plan` | planned heap (`xmxMb`, `xmsMb`) per server, budget, warnings |
| PUT | `/api/ram/config` | `reserveMb`, `totalMb` (0 = automatic) |
| POST | `/api/ram/plan/preview` | plan for a hypothetical list `{servers: [{id, role, memory}], reserveMb}` |
| POST | `/api/ram/plan/apply` | writes the plan to every connected MCLI: `{plan, applied[], failed[]}` |

A frame: `{t, system:{totalMb, availableMb, usedMb}, pressure, networkRssMb, servers:{id:{state, rssMb, maxMb, players, heapUsedMb, liveSetMb, tps}}}`.
`heapUsedMb`, `liveSetMb` and `tps` are `null` for servers whose plugin does not report.

## Event stream

`GET /api/events` (server-sent events): `hello`, `server` (`{id, event, data}` for every MCLI event, e.g. log lines and state changes),
`status` (`{id, status}`), `ram` (a frame), `pressure` (`{level}`), `servers` (the list changed), `setup` (the job state), `agent` (`{id, agent}` after every plugin report), `autopilot` (every event).
