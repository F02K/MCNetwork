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
5. Add another game server with `POST /api/setup` (no `proxy`): Velocity must reload by itself and the new server must be reachable with `/server`.

Last run (Velocity 3.5.1, Paper 1.21.8): all of the above passed. It found, and led to fixes for: Velocity's default port (25565), Java 25 for Velocity 4.x,
the recommended Velocity build, player counting with colored Paper log lines, and the JVM overhead used by the RAM planner.
