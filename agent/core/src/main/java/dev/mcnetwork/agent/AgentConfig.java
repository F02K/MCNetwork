package dev.mcnetwork.agent;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * Settings that MCNetwork writes when it installs the agent (config.properties in the plugin folder).
 * <pre>
 * url=http://127.0.0.1:8080
 * token=...
 * server-id=lobby
 * interval-seconds=10
 * </pre>
 */
public final class AgentConfig {
    public final String url;
    public final String token;
    public final String serverId;
    public final int intervalSeconds;

    public AgentConfig(String url, String token, String serverId, int intervalSeconds) {
        this.url = url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
        this.token = token;
        this.serverId = serverId;
        this.intervalSeconds = intervalSeconds;
    }

    /** Reads the file; throws with a message that says what is missing. */
    public static AgentConfig load(Path file) throws IOException {
        if (!Files.exists(file)) throw new IOException("not configured yet (" + file.getFileName() + " is missing; MCNetwork writes it)");
        Properties p = new Properties();
        try (Reader in = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            p.load(in);
        }
        String url = require(p, "url");
        String token = require(p, "token");
        String serverId = require(p, "server-id");
        int interval = 10;
        String raw = p.getProperty("interval-seconds", "").trim();
        if (!raw.isEmpty()) {
            try {
                interval = Math.max(2, Math.min(300, Integer.parseInt(raw)));
            } catch (NumberFormatException e) {
                throw new IOException("interval-seconds must be a number");
            }
        }
        return new AgentConfig(url, token, serverId, interval);
    }

    private static String require(Properties p, String key) throws IOException {
        String v = p.getProperty(key, "").trim();
        if (v.isEmpty()) throw new IOException(key + " is missing in the configuration");
        return v;
    }
}
