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
| HTTP API and event stream | `src/http/` |

## Decisions

- **MCLI per server.** MCLI already installs, starts, supervises and backs up one server. MCNetwork does not duplicate that; it adds the network view and the RAM logic.
- **A JVM cannot change its heap while running.** "Automatic RAM" therefore means: plan sizes up front, track real usage, apply new sizes at the next restart, and (planned) use GC settings and idle-server shutdown to give memory back.
- **Stdin ties the lifetime.** Stopping MCNetwork stops the servers. A mode where MCLI instances outlive the daemon (local socket) is planned.
- **No runtime dependencies.** Node 22 only; the event stream uses server-sent events instead of WebSockets.

## Planned

1. Web dashboard and guided setup (proxy choice, backend servers, ports, `velocity.toml` forwarding secret, RAM budget).
2. Server plugins (Paper and Velocity) that report heap, GC, TPS and player counts, and hand players over on restarts.
3. RAM recommendations from real heap data, memory-pressure actions (GC on idle servers, restart on leak trend), on-demand start of idle servers.
4. Terminal UI on top of the same API.
