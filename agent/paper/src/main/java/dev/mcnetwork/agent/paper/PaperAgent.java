package dev.mcnetwork.agent.paper;

import dev.mcnetwork.agent.AgentCommand;
import dev.mcnetwork.agent.AgentConfig;
import dev.mcnetwork.agent.AgentLog;
import dev.mcnetwork.agent.JvmMetrics;
import dev.mcnetwork.agent.Reporter;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * Game server side of MCNetwork: reports heap, GC, TPS, MSPT, players and world sizes, and runs the
 * daemon's orders (free memory). Configured by MCNetwork itself (plugins/MCNetworkAgent/config.properties).
 */
public final class PaperAgent extends JavaPlugin {
    private Reporter reporter;
    private BukkitTask sampler;
    /** Game numbers gathered on the main thread; the reporter thread only reads this. */
    private volatile Map<String, Object> game = new LinkedHashMap<>();

    @Override
    public void onEnable() {
        AgentConfig config;
        try {
            config = AgentConfig.load(Path.of(getDataFolder().getPath(), "config.properties"));
        } catch (IOException e) {
            getLogger().warning("MCNetwork agent is idle: " + e.getMessage());
            return;
        }
        AgentLog log = new AgentLog() {
            @Override
            public void info(String message) {
                getLogger().info(message);
            }

            @Override
            public void warn(String message) {
                getLogger().warning(message);
            }
        };
        reporter = new Reporter(config, "paper", getDescription().getVersion(), () -> Map.of("game", game), this::run, log);
        long ticks = config.intervalSeconds * 20L;
        sampler = Bukkit.getScheduler().runTaskTimer(this, this::sample, 20L, ticks);
        reporter.start();
        getLogger().info("Reporting to " + config.url + " as \"" + config.serverId + "\" every " + config.intervalSeconds + " s.");
    }

    @Override
    public void onDisable() {
        if (sampler != null) sampler.cancel();
        if (reporter != null) reporter.stop();
    }

    /** Runs on the main thread: the only place where worlds and players may be read safely. */
    private void sample() {
        Map<String, Object> g = new LinkedHashMap<>();
        double[] tps = Bukkit.getTPS(); // 1, 5 and 15 minute averages (Paper)
        g.put("tps", new double[] {Math.min(20.0, tps[0]), Math.min(20.0, tps[1]), Math.min(20.0, tps[2])});
        g.put("mspt", Bukkit.getAverageTickTime());
        g.put("players", Bukkit.getOnlinePlayers().size());
        g.put("maxPlayers", Bukkit.getMaxPlayers());
        g.put("version", Bukkit.getMinecraftVersion());
        List<Map<String, Object>> worlds = new ArrayList<>();
        for (World w : Bukkit.getWorlds()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", w.getName());
            m.put("chunks", w.getChunkCount());
            m.put("entities", w.getEntityCount());
            m.put("players", w.getPlayerCount());
            worlds.add(m);
        }
        g.put("worlds", worlds);
        game = g;
    }

    private String run(AgentCommand command) {
        if (command.type.equals("gc")) {
            double[] r = JvmMetrics.collectGarbage();
            return String.format(java.util.Locale.ROOT, "heap in use %.0f MB -> %.0f MB", r[0], r[1]);
        }
        throw new IllegalArgumentException("unknown command " + command.type);
    }
}
