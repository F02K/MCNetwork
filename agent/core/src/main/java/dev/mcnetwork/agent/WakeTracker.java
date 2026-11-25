package dev.mcnetwork.agent;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Keeps players waiting for a server that was stopped for being idle (and is started again because they asked
 * for it). Knows nothing about Velocity: a player can be any object. All methods are thread safe, because the
 * proxy calls it from event threads and the reporter thread.
 */
public final class WakeTracker<P> {
    private static final class Waiting<P> {
        final P player;
        final long since;

        Waiting(P player, long since) {
            this.player = player;
            this.since = since;
        }
    }

    private Set<String> sleeping = Set.of();
    private final Map<String, List<Waiting<P>>> holding = new LinkedHashMap<>();

    /** True while the daemon says this server is asleep (or on its way up). */
    public synchronized boolean isSleeping(String server) {
        return sleeping.contains(server);
    }

    /** Puts a player on the waiting list of a server. Asking twice does not add a second entry. */
    public synchronized void hold(String server, P player, long nowMs) {
        List<Waiting<P>> list = holding.computeIfAbsent(server, k -> new ArrayList<>());
        for (Waiting<P> w : list) if (w.player.equals(player)) return;
        list.add(new Waiting<>(player, nowMs));
    }

    /** Servers somebody is waiting for: sent with every report, so a lost request is simply repeated. */
    public synchronized List<String> wakeRequests() {
        return new ArrayList<>(holding.keySet());
    }

    /**
     * Takes the daemon's latest answer: which servers sleep, and which woke up. Returns the players that can be
     * connected now (grouped by server) and removes them from the waiting lists.
     */
    public synchronized Map<String, List<P>> update(Collection<String> sleepingNow, Collection<String> awake) {
        sleeping = new HashSet<>(sleepingNow);
        Map<String, List<P>> ready = new LinkedHashMap<>();
        for (String name : awake) {
            List<Waiting<P>> list = holding.remove(name);
            if (list == null) continue;
            List<P> players = new ArrayList<>();
            for (Waiting<P> w : list) players.add(w.player);
            ready.put(name, players);
        }
        return ready;
    }

    /** A player left: stop waiting for them. */
    public synchronized void forget(P player) {
        for (List<Waiting<P>> list : holding.values()) list.removeIf(w -> w.player.equals(player));
        holding.values().removeIf(List::isEmpty);
    }

    /** Players who have waited longer than `maxMs` are dropped from the lists and returned (they are told it did not work). */
    public synchronized List<P> expire(long nowMs, long maxMs) {
        List<P> gone = new ArrayList<>();
        for (List<Waiting<P>> list : holding.values()) {
            list.removeIf(w -> {
                boolean old = nowMs - w.since > maxMs;
                if (old) gone.add(w.player);
                return old;
            });
        }
        holding.values().removeIf(List::isEmpty);
        return gone;
    }
}
