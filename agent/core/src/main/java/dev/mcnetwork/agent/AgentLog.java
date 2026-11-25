package dev.mcnetwork.agent;

/** Where the agent writes its messages: the plugin's own logger on Paper and Velocity. */
public interface AgentLog {
    void info(String message);

    void warn(String message);
}
