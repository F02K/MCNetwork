# Architecture

```
dashboard / TUI / curl
        |  HTTP + SSE
   MCNetwork daemon  (src/index.ts)
        |  Network (src/network.ts): servers, RAM sampling, planning
        |  one McliInstance per server (src/mcli/instance.ts)
        |  JSON lines over stdin/stdout  (MCLI docs/API.md)
   mcli.js --api   x N   (cwd = server folder)
        |
   java -jar paper.jar / velocity.jar
```

| Part | Files |
| --- | --- |
| Configuration and validation | `src/config.ts`, `src/types.ts` |
| MCLI connection (spawn, requests, events, respawn) | `src/mcli/` |
| RAM: system reader, planner, history | `src/ram/` |
| Network manager | `src/network.ts` |
| HTTP API, event stream, static files | `src/http/` |
| Setup job, config writers (velocity.toml, server.properties, paper-global.yml) | `src/setup/` |
| Agent plugins (Java: Paper and Velocity) and their jars | `agent/` |
| Agent protocol, order queue, plugin installation | `src/agent/` |
| Importing (copy/move/link, backups, Spigot to Paper), proxy list merging | `src/setup/importer.ts`, `src/setup/velocity.ts` |
| Ports: overview, change, firewall, UPnP, outside check | `src/ports/` |
| Autopilot: engine, leak detection | `src/autopilot/` |
| Dashboard (vanilla ES modules, no build step) | `web/` |

## Decisions

- **MCLI per server.** MCLI already installs, starts, supervises and backs up one server. MCNetwork does not duplicate that; it adds the network view and the RAM logic.
- **A JVM cannot change its heap while running.** "Automatic RAM" therefore means: plan sizes up front, track real usage, apply new sizes at the next restart, and (planned) use GC settings and idle-server shutdown to give memory back.
- **Stdin ties the lifetime.** Stopping MCNetwork stops the servers. A mode where MCLI instances outlive the daemon (local socket) is planned.
- **No runtime dependencies.** Node 22 only; the event stream uses server-sent events instead of WebSockets.

- **Servers write their own default settings.** The setup starts each server once, waits for its settings file, stops it, and patches the real file (not a template), so new Velocity/Paper config versions keep working.
- **Backends are local only.** Game servers bind to `127.0.0.1` with `online-mode=false`; the proxy authenticates players and forwards them with a shared secret.
- **The planner is conservative.** It counts heap plus JVM overhead as if the heap were full; a real Velocity with a 1 GB heap used about 200 MB, while a small Paper used 0.9-1.2 GB. Real heap data from the plugins will let it plan tighter.

- **Plugins deliver themselves.** The daemon owns the plugin jars and config; nothing is installed by hand. The plugin pushes reports to the daemon (it knows the daemon's address, not the other way round) and orders travel back in the answer, so the daemon never needs to reach into a game server.
- **Recommendations use the live set.** Heap in use right after garbage collection is what a server needs; heap in use at any moment includes garbage that simply has not been collected yet.

- **An imported server is changed as little as possible.** Only port, bind address, `online-mode` and the proxy's forwarding secret change (and the plugin is added); the originals of those files are saved first, and the default way in is a copy.
- **Software that cannot sit behind the proxy stays outside it.** `standalone` servers get RAM planning, start/stop/backup and a console, but no entry in `velocity.toml` and no forwarding.
- **Opening the internet is guided, not done behind your back.** The firewall is only inspected (the command is shown); the router mapping is made with UPnP when you ask, kept while the daemon runs and released when it stops; the outside check only happens on a click.

- **The autopilot is cautious by design.** Off and in dry run by default; it needs two independent counts of zero players before it stops anything; it never stops the join-first server because the proxy sends everybody there; it acts one server at a time and at most 12 times an hour.
- **Waking a server is done at the proxy.** Velocity cannot hold a login for a server that is down, so the plugin refuses the switch, remembers the player, reports the wish with its next report (every 3 s for the proxy) and connects the player when the daemon says the server answers.
- **A leak is a trend, not a level.** A big heap in use is normal for Java; what gives a leak away is the heap *after* garbage collection growing in a straight line for hours.

## Planned

1. More setup choices: other backend software (Fabric/Forge need a forwarding mod), more than one proxy.
2. A guided "restart server" that moves the players first (the pieces exist: `evacuate`).
3. More autopilot rules (scheduled quiet-hour restarts, per-server limits).
4. Terminal UI on top of the same API.
