package dev.mcnetwork.agent;

/** Runs the orders the daemon sends. Returns a short result text (shown in the dashboard), or throws to report a failure. */
public interface CommandHandler {
    String handle(AgentCommand command) throws Exception;
}
