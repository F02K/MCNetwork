package dev.mcnetwork.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class WakeTrackerTest {
    @Test
    void knowsWhichServersSleep() {
        WakeTracker<String> t = new WakeTracker<>();
        assertFalse(t.isSleeping("survival"));
        t.update(List.of("survival", "creative"), List.of());
        assertTrue(t.isSleeping("survival"));
        assertTrue(t.isSleeping("creative"));
        t.update(List.of("creative"), List.of());
        assertFalse(t.isSleeping("survival"), "the list is replaced, not added to");
    }

    @Test
    void holdsPlayersOnceAndAsksForTheirServers() {
        WakeTracker<String> t = new WakeTracker<>();
        t.hold("survival", "alex", 0);
        t.hold("survival", "alex", 5);
        t.hold("survival", "steve", 5);
        t.hold("creative", "alex", 6);
        assertEquals(List.of("survival", "creative"), t.wakeRequests());
        Map<String, List<String>> ready = t.update(List.of("creative"), List.of("survival"));
        assertEquals(Map.of("survival", List.of("alex", "steve")), ready, "alex is only listed once");
        assertEquals(List.of("creative"), t.wakeRequests(), "survival is no longer waited for");
    }

    @Test
    void anAwakeServerNobodyWaitsForGivesNothing() {
        WakeTracker<String> t = new WakeTracker<>();
        assertTrue(t.update(List.of(), List.of("survival")).isEmpty());
    }

    @Test
    void forgetsPlayersWhoLeft() {
        WakeTracker<String> t = new WakeTracker<>();
        t.hold("survival", "alex", 0);
        t.hold("survival", "steve", 0);
        t.forget("alex");
        assertEquals(Map.of("survival", List.of("steve")), t.update(List.of(), List.of("survival")));
        t.hold("creative", "alex", 0);
        t.forget("alex");
        assertTrue(t.wakeRequests().isEmpty(), "an empty list is dropped");
    }

    @Test
    void givesUpOnPlayersWhoWaitedTooLong() {
        WakeTracker<String> t = new WakeTracker<>();
        t.hold("survival", "alex", 0);
        t.hold("survival", "steve", 200_000);
        assertEquals(List.of("alex"), t.expire(300_001, 300_000));
        assertEquals(List.of("survival"), t.wakeRequests());
        assertEquals(List.of("steve"), t.expire(600_000, 300_000));
        assertTrue(t.wakeRequests().isEmpty());
        assertTrue(t.expire(1_000_000, 300_000).isEmpty());
    }
}
