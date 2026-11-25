package dev.mcnetwork.agent.velocity;

import com.google.inject.Inject;
import com.velocitypowered.api.event.PostOrder;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.ServerPreConnectEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import dev.mcnetwork.agent.AgentCommand;
import dev.mcnetwork.agent.AgentConfig;
import dev.mcnetwork.agent.AgentLog;
import dev.mcnetwork.agent.JvmMetrics;
import dev.mcnetwork.agent.Reporter;
import dev.mcnetwork.agent.WakeTracker;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.kyori.adventure.text.Component;
import org.slf4j.Logger;

/**
 * Proxy side of MCNetwork: reports JVM memory and the players per server, and moves players to
 * another server when the daemon asks (so a game server can restart without kicking anybody).
 */
@Plugin(id = "mcnetwork-agent", name = "MCNetworkAgent", version = "0.2.0", authors = {"MCNetwork"})
public final class VelocityAgent {
    private final ProxyServer proxy;
    private final Logger logger;
    private final Path dataDirectory;
    private static final long WAIT_LIMIT_MS = 5 * 60_000L;
    private Reporter reporter;
    /** Players waiting for a server that the daemon stopped for being idle and is starting again. */
    private final WakeTracker<Player> wake = new WakeTracker<>();

    @Inject
    public VelocityAgent(ProxyServer proxy, Logger logger, @DataDirectory Path dataDirectory) {
        this.proxy = proxy;
        this.logger = logger;
        this.dataDirectory = dataDirectory;
    }

    @Subscribe
    public void onProxyInitialization(ProxyInitializeEvent event) {
        AgentConfig config;
        try {
            config = AgentConfig.load(dataDirectory.resolve("config.properties"));
        } catch (IOException e) {
            logger.warn("MCNetwork agent is idle: {}", e.getMessage());
            return;
        }
        AgentLog log = new AgentLog() {
            @Override
            public void info(String message) {
                logger.info(message);
            }

            @Override
            public void warn(String message) {
                logger.warn(message);
            }
        };
        String version = proxy.getPluginManager().getPlugin("mcnetwork-agent").flatMap(p -> p.getDescription().getVersion()).orElse("unknown");
        reporter = new Reporter(config, "velocity", version, this::stats, this::run, log);
        reporter.onResponse(this::onResponse);
        reporter.start();
        logger.info("Reporting to {} as \"{}\" every {} s.", config.url, config.serverId, config.intervalSeconds);
    }

    @Subscribe
    public void onProxyShutdown(ProxyShutdownEvent event) {
        if (reporter != null) reporter.stop();
    }

    /** A player wants a server that is asleep: hold them, the daemon starts it, and they are connected when it is ready. */
    @Subscribe(order = PostOrder.FIRST)
    public void onPreConnect(ServerPreConnectEvent event) {
        String name = event.getOriginalServer().getServerInfo().getName();
        if (!wake.isSleeping(name)) return;
        event.setResult(ServerPreConnectEvent.ServerResult.denied());
        wake.hold(name, event.getPlayer(), System.currentTimeMillis());
        event.getPlayer().sendMessage(Component.text(name + " is starting up. You will be connected as soon as it is ready."));
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        wake.forget(event.getPlayer());
    }

    private static List<String> names(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List<?> list) for (Object x : list) if (x instanceof String s) out.add(s);
        return out;
    }

    /** The daemon's answer says which servers sleep and which woke up: send the waiting players on. */
    private void onResponse(Map<?, ?> response) {
        Map<String, List<Player>> ready = wake.update(names(response.get("sleeping")), names(response.get("awake")));
        for (Map.Entry<String, List<Player>> e : ready.entrySet()) {
            proxy.getServer(e.getKey()).ifPresent(server -> {
                for (Player p : e.getValue()) {
                    if (!p.isActive()) continue;
                    p.sendMessage(Component.text(e.getKey() + " is ready. Connecting you now."));
                    p.createConnectionRequest(server).fireAndForget();
                }
            });
        }
    }

    private Map<String, Object> stats() {
        for (Player p : wake.expire(System.currentTimeMillis(), WAIT_LIMIT_MS)) p.sendMessage(Component.text("The server did not start in time. Please try again later."));
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("players", proxy.getPlayerCount());
        p.put("version", proxy.getVersion().getVersion());
        List<Map<String, Object>> servers = new ArrayList<>();
        for (RegisteredServer s : proxy.getAllServers()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", s.getServerInfo().getName());
            m.put("players", s.getPlayersConnected().size());
            servers.add(m);
        }
        p.put("servers", servers);
        p.put("wakeRequests", wake.wakeRequests());
        return Map.of("proxy", p);
    }

    private String run(AgentCommand command) {
        switch (command.type) {
            case "gc" -> {
                double[] r = JvmMetrics.collectGarbage();
                return String.format(java.util.Locale.ROOT, "heap in use %.0f MB -> %.0f MB", r[0], r[1]);
            }
            case "evacuate" -> {
                return evacuate(command.string("from", ""), command.string("to", ""), command.string("message", "The server is restarting. You are being moved."));
            }
            default -> throw new IllegalArgumentException("unknown command " + command.type);
        }
    }

    /** Sends every player of one server to another one, with a short message. */
    private String evacuate(String from, String to, String message) {
        RegisteredServer source = proxy.getServer(from).orElseThrow(() -> new IllegalArgumentException("no server named " + from));
        RegisteredServer target = proxy.getServer(to).orElseThrow(() -> new IllegalArgumentException("no server named " + to));
        if (source.equals(target)) throw new IllegalArgumentException("source and target are the same server");
        int moved = 0;
        for (Player player : new ArrayList<>(source.getPlayersConnected())) {
            player.sendMessage(Component.text(message));
            player.createConnectionRequest(target).fireAndForget();
            moved++;
        }
        return "moved " + moved + " player(s) from " + from + " to " + to;
    }
}
