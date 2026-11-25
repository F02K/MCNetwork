# Test with a real network

The automated tests use a stand-in for MCLI. Before a release the whole thing is also run against real servers:

1. Start MCNetwork with a fresh data folder, `mcliPath` pointing to a built `mcli.js`, and a small `ram.totalMb` (for example 6144).
2. `POST /api/setup` with a proxy, two game servers (Paper 1.21.x) and `"acceptEula": true` (this is you accepting the [Minecraft EULA](https://aka.ms/MinecraftEULA)).
3. Wait for the job to finish (`GET /api/setup`), then check that
   - all servers are `running` and answer the status ping,
   - `forwarding.secret` of Velocity and `secret` in each `config/paper-global.yml` are identical,
   - the Paper log says it uses compression from Velocity (modern forwarding is active).
4. Join with a bot through the proxy. For the test only, set `online-mode = false` in `velocity.toml` and restart the proxy; then, for example with `mineflayer` (version `1.21.8`, `auth: 'offline'`), connect to the proxy port, type `/server <other server>` and check
   - the player lands on the first server, then on the other one,
   - the player's UUID is the same on both servers,
   - MCNetwork shows the player on the proxy and on the current game server.
4a. **Import:** create a standalone Paper server (any folder; run it once, `setworldspawn 100 80 100`, stop it) and run `POST /api/setup` with `backends: [{id: "survival", import: {path, mode: "copy"}}]`. Check that
   - the original folder is unchanged (port, `online-mode`),
   - the copy has the new local port, `online-mode=false`, its own MOTD, a `.mcnetwork-backup` with the originals and the agent plugin,
   - `forwarding.secret` of the proxy equals the secret in the copy's `config/paper-global.yml`,
   - the bot lands near (100, 80, 100) when it runs `/server survival` (the world came along).
4b. **Ports:** `GET /api/ports` shows every port; changing a running server's port is refused, a stopped one works (`server.properties`, `velocity.toml`, live `velocity reload`) and the bot reaches it on the new port; `GET /api/ports/access` shows the firewall command; UPnP needs a real router and is covered by tests against a fake one.
4c. **Autopilot:** enable it (`dryRun: false`, `stopIdle`, `idleMinutes: 1`, `wakeOnDemand`, `intervalSeconds: 5`). After about two minutes the empty non-entry server is stopped (`GET /api/autopilot`). Join with the bot and type `/server <that server>`: it says "starting up", and about 30 seconds later "ready. Connecting you now." and the proxy log shows the bot on that server. Pressure and leak rules are covered by tests with a controlled clock; they need a machine that is really short of memory, or hours of data.
5. The agent plugins (installed by the setup, nothing to do by hand): check that
   - `GET /api/servers` shows `agent.connected: true` with heap, `liveSetMb`, TPS and worlds for the game servers and the players per server for the proxy,
   - `POST /api/servers/<id>/gc` returns an order whose result (`heap in use X MB -> Y MB`) appears in `agent.commands`,
   - with the bot on a game server, `POST /api/servers/<id>/evacuate` moves it to the join-first server (it receives the message; the proxy log shows the switch),
   - after about 10 minutes `GET /api/ram/recommendations` has advice; clicking *Use …* in the RAM page pins the heap, and after a restart the plugin reports exactly that heap limit.
6. Add another game server with `POST /api/setup` (no `proxy`): Velocity must reload by itself and the new server must be reachable with `/server`.

Last run (Velocity 3.5.1, Paper 1.21.8, agent 0.1.0): all of the above passed. It found, and led to fixes for: Velocity's default port (25565), Java 25 for Velocity 4.x,
the recommended Velocity build, player counting with colored Paper log lines, and the JVM overhead used by the RAM planner.
