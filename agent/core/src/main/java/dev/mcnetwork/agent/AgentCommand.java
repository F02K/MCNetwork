package dev.mcnetwork.agent;

import java.util.Map;

/** An order from the MCNetwork daemon, delivered in the answer to a report. */
public final class AgentCommand {
    public final String id;
    public final String type;
    public final Map<String, Object> args;

    public AgentCommand(String id, String type, Map<String, Object> args) {
        this.id = id;
        this.type = type;
        this.args = args;
    }

    public String string(String key, String fallback) {
        Object v = args.get(key);
        return v instanceof String s && !s.isEmpty() ? s : fallback;
    }
}
