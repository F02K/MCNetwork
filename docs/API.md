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

## RAM

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/ram` | latest frame and the 24 h peak RSS per server |
| GET | `/api/ram/history?minutes=60&points=500` | frames, oldest first |
| GET | `/api/ram/plan` | planned heap (`xmxMb`, `xmsMb`) per server, budget, warnings |
| PUT | `/api/ram/config` | `reserveMb`, `totalMb` (0 = automatic) |
| POST | `/api/ram/plan/preview` | plan for a hypothetical list `{servers: [{id, role, memory}], reserveMb}` |
| POST | `/api/ram/plan/apply` | writes the plan to every connected MCLI: `{plan, applied[], failed[]}` |

A frame: `{t, system:{totalMb, availableMb, usedMb}, pressure, networkRssMb, servers:{id:{state, rssMb, maxMb, players, heapUsedMb}}}`.
`heapUsedMb` stays `null` until the server plugin reports it.

## Event stream

`GET /api/events` (server-sent events): `hello`, `server` (`{id, event, data}` for every MCLI event, e.g. log lines and state changes),
`status` (`{id, status}`), `ram` (a frame), `pressure` (`{level}`), `servers` (the list changed), `setup` (the job state).
