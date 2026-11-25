# MCNetwork agent plugins

Two small plugins that MCNetwork installs into your servers by itself. They give the daemon what it cannot see from outside the Java process.

| Plugin | Runs on | Reports | Orders it understands |
| --- | --- | --- | --- |
| `mcnetwork-agent-paper` | game servers (Paper 1.19+) | heap, heap still in use after garbage collection, GC, threads, CPU, TPS, MSPT, players, chunks and entities per world | `gc` |
| `mcnetwork-agent-velocity` | the proxy (Velocity 3.x/4.x) | the same JVM numbers, players per server | `gc`, `evacuate` (moves players of one server to another) |

You do not install or configure anything: the daemon copies the jar to `plugins/MCNetworkAgent.jar`, writes `plugins/<name>/config.properties` (daemon URL, secret token, server id)
and keeps both up to date whenever it starts or installs software. A server that already runs picks up a new jar at its next restart.

## How it talks to the daemon

Every few seconds (default 10) a background thread sends `POST /api/agent/report` with `Authorization: Bearer <agent token>`. The answer carries orders
(`{"commands": [{"id", "type", ...}]}`); their outcome comes back in the next report (`results`). A missing daemon never slows the game: the plugin
logs one warning, keeps trying and picks up when the daemon is back. Details of the JSON are in `src/agent/protocol.ts` and `Reporter.java`.

## Build

```
npm run build:agent      # JDK 17+ and Maven; runs the tests and copies the jars to agent/jars/
```

The jars in `agent/jars/` are committed (they are small and the build is reproducible), together with `manifest.json` (version and SHA-256).
The daemon verifies each jar against the manifest before it installs it. Rebuild and commit them whenever `agent/` changes.

The plugins are compiled against the Paper 1.19.4 and Velocity 3.4.0 APIs with Java 17 bytecode, so one jar runs on every supported version.
They use only the JDK (no shaded libraries beyond their own core module).
