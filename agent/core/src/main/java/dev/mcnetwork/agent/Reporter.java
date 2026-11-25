package dev.mcnetwork.agent;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Sends a report to the MCNetwork daemon every few seconds and carries out the orders in its answer.
 * It runs on its own thread, so a slow or missing daemon never slows the game down.
 */
public final class Reporter {
    /** What the plugin adds to the report besides the JVM data, e.g. {"game": {...}} or {"proxy": {...}}. */
    public interface Stats extends Supplier<Map<String, Object>> {}

    private final AgentConfig config;
    private final String kind;
    private final String version;
    private final Stats stats;
    private final CommandHandler handler;
    private final AgentLog log;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private ScheduledExecutorService executor;
    private boolean connected = true; // starts true so that the first failure is reported
    private boolean unauthorized;
    private final List<Map<String, Object>> results = new ArrayList<>();

    public Reporter(AgentConfig config, String kind, String version, Stats stats, CommandHandler handler, AgentLog log) {
        this.config = config;
        this.kind = kind;
        this.version = version;
        this.stats = stats;
        this.handler = handler;
        this.log = log;
    }

    public void start() {
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "MCNetworkAgent");
            t.setDaemon(true);
            return t;
        });
        executor.scheduleWithFixedDelay(this::tick, 1, config.intervalSeconds, TimeUnit.SECONDS);
    }

    public void stop() {
        if (executor != null) executor.shutdownNow();
    }

    /** One round: report, then run the orders. Public so that tests can drive it. */
    public void tick() {
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("serverId", config.serverId);
            body.put("kind", kind);
            body.put("agentVersion", version);
            body.put("time", System.currentTimeMillis());
            body.put("jvm", JvmMetrics.collect());
            body.putAll(stats.get());
            List<Map<String, Object>> sent;
            synchronized (results) {
                sent = new ArrayList<>(results);
                results.clear();
            }
            body.put("results", sent);

            HttpRequest request = HttpRequest.newBuilder(URI.create(config.url + "/api/agent/report"))
                    .timeout(Duration.ofSeconds(5))
                    .header("authorization", "Bearer " + config.token)
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(Json.write(body), StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                synchronized (results) {
                    results.addAll(sent); // not delivered
                }
                if (!unauthorized) log.warn("The MCNetwork daemon rejected the agent token. Reinstall the agent from the dashboard.");
                unauthorized = true;
                return;
            }
            if (response.statusCode() != 200) throw new IOException("HTTP " + response.statusCode());
            unauthorized = false;
            if (!connected) log.info("Connected to the MCNetwork daemon again.");
            connected = true;
            runCommands(response.body());
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
                return;
            }
            if (connected) log.warn("Cannot reach the MCNetwork daemon at " + config.url + " (" + e.getMessage() + "). Will keep trying.");
            connected = false;
        }
    }

    private void runCommands(String responseBody) {
        Object parsed;
        try {
            parsed = Json.parse(responseBody);
        } catch (IllegalArgumentException e) {
            log.warn("Unreadable answer from the daemon: " + e.getMessage());
            return;
        }
        if (!(parsed instanceof Map<?, ?> map) || !(map.get("commands") instanceof List<?> commands)) return;
        for (Object raw : commands) {
            if (!(raw instanceof Map<?, ?> c)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> args = (Map<String, Object>) c;
            String id = String.valueOf(c.get("id"));
            String type = String.valueOf(c.get("type"));
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            try {
                String message = handler.handle(new AgentCommand(id, type, args));
                result.put("ok", true);
                result.put("message", message == null ? "" : message);
            } catch (Exception e) {
                result.put("ok", false);
                result.put("message", String.valueOf(e.getMessage()));
                log.warn("Command " + type + " failed: " + e.getMessage());
            }
            synchronized (results) {
                results.add(result);
            }
        }
    }
}
