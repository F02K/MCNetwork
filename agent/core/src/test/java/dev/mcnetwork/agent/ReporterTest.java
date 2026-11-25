package dev.mcnetwork.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ReporterTest {
    private HttpServer server;
    private final List<String> bodies = new CopyOnWriteArrayList<>();
    private final List<String> auths = new CopyOnWriteArrayList<>();
    private volatile int status = 200;
    private volatile String answer = "{\"ok\":true,\"commands\":[]}";
    private final List<String> warnings = new ArrayList<>();
    private final List<String> infos = new ArrayList<>();
    private final AgentLog log = new AgentLog() {
        public void info(String m) {
            infos.add(m);
        }

        public void warn(String m) {
            warnings.add(m);
        }
    };

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/agent/report", ex -> {
            bodies.add(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            auths.add(ex.getRequestHeaders().getFirst("authorization"));
            byte[] out = answer.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(status, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private Reporter reporter(CommandHandler handler) {
        AgentConfig config = new AgentConfig("http://127.0.0.1:" + server.getAddress().getPort(), "tok", "lobby", 10);
        return new Reporter(config, "paper", "1.2.3", () -> Map.of("game", Map.of("players", 3)), handler, log);
    }

    @Test
    void sendsJvmAndGameDataWithTheToken() {
        reporter(c -> "").tick();
        assertEquals(1, bodies.size());
        assertEquals("Bearer tok", auths.get(0));
        Map<?, ?> body = (Map<?, ?>) Json.parse(bodies.get(0));
        assertEquals("lobby", body.get("serverId"));
        assertEquals("paper", body.get("kind"));
        assertEquals("1.2.3", body.get("agentVersion"));
        Map<?, ?> jvm = (Map<?, ?>) body.get("jvm");
        assertTrue(((Number) jvm.get("heapUsedMb")).doubleValue() > 0);
        assertNotNull(jvm.get("gcCount"));
        assertEquals(3.0, ((Map<?, ?>) ((Map<?, ?>) body.get("game"))).get("players"));
    }

    @Test
    void runsCommandsAndReportsTheirResultNextTime() {
        answer = "{\"commands\":[{\"id\":\"c1\",\"type\":\"gc\"},{\"id\":\"c2\",\"type\":\"boom\"}]}";
        List<String> seen = new ArrayList<>();
        Reporter r = reporter(c -> {
            seen.add(c.id + ":" + c.type);
            if (c.type.equals("boom")) throw new IllegalStateException("no way");
            return "freed";
        });
        r.tick();
        assertEquals(List.of("c1:gc", "c2:boom"), seen);
        answer = "{\"commands\":[]}";
        r.tick();
        List<?> results = (List<?>) ((Map<?, ?>) Json.parse(bodies.get(1))).get("results");
        assertEquals(2, results.size());
        assertEquals(Boolean.TRUE, ((Map<?, ?>) results.get(0)).get("ok"));
        assertEquals("freed", ((Map<?, ?>) results.get(0)).get("message"));
        assertEquals(Boolean.FALSE, ((Map<?, ?>) results.get(1)).get("ok"));
        assertEquals("no way", ((Map<?, ?>) results.get(1)).get("message"));
        assertTrue(warnings.stream().anyMatch(w -> w.contains("boom")));
        r.tick();
        assertEquals(0, ((List<?>) ((Map<?, ?>) Json.parse(bodies.get(2))).get("results")).size(), "results are sent once");
    }

    @Test
    void keepsResultsWhenTheTokenIsRejectedAndSaysSoOnce() {
        answer = "{\"commands\":[{\"id\":\"c1\",\"type\":\"gc\"}]}";
        Reporter r = reporter(c -> "ok");
        r.tick();
        status = 401;
        r.tick();
        r.tick();
        assertEquals(1, warnings.stream().filter(w -> w.contains("rejected")).count());
        status = 200;
        answer = "{}";
        r.tick();
        List<?> results = (List<?>) ((Map<?, ?>) Json.parse(bodies.get(bodies.size() - 1))).get("results");
        assertEquals(1, results.size(), "the result of c1 was not lost");
    }

    @Test
    void warnsOnceWhenTheDaemonIsDown() {
        Reporter r = reporter(c -> "");
        server.stop(0);
        r.tick();
        r.tick();
        assertEquals(1, warnings.stream().filter(w -> w.contains("Cannot reach")).count(), "one warning, not one per attempt");
        assertTrue(infos.isEmpty());
    }

    @Test
    void survivesGarbageAnswers() {
        answer = "not json";
        reporter(c -> "").tick();
        assertTrue(warnings.stream().anyMatch(w -> w.contains("Unreadable")));
        status = 500;
        reporter(c -> "").tick();
        assertTrue(warnings.stream().anyMatch(w -> w.contains("HTTP 500")));
    }

    @Test
    void jvmMetricsHaveSaneValues() {
        Map<String, Object> m = JvmMetrics.collect();
        assertTrue(((Number) m.get("heapUsedMb")).doubleValue() > 0);
        assertTrue(((Number) m.get("heapCommittedMb")).doubleValue() >= ((Number) m.get("heapUsedMb")).doubleValue() * 0.5);
        double[] gc = JvmMetrics.collectGarbage();
        assertEquals(2, gc.length);
        assertTrue(gc[0] > 0 && gc[1] > 0);
    }
}
