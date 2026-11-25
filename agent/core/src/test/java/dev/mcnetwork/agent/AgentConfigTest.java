package dev.mcnetwork.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AgentConfigTest {
    @TempDir
    Path dir;

    private Path write(String text) throws IOException {
        Path f = dir.resolve("config.properties");
        Files.writeString(f, text);
        return f;
    }

    @Test
    void readsAllKeysAndTrimsTheUrl() throws IOException {
        AgentConfig c = AgentConfig.load(write("url=http://127.0.0.1:8080/\ntoken=abc\nserver-id=lobby\ninterval-seconds=15\n"));
        assertEquals("http://127.0.0.1:8080", c.url);
        assertEquals("abc", c.token);
        assertEquals("lobby", c.serverId);
        assertEquals(15, c.intervalSeconds);
    }

    @Test
    void intervalDefaultsAndIsClamped() throws IOException {
        assertEquals(10, AgentConfig.load(write("url=u\ntoken=t\nserver-id=s\n")).intervalSeconds);
        assertEquals(2, AgentConfig.load(write("url=u\ntoken=t\nserver-id=s\ninterval-seconds=0\n")).intervalSeconds);
        assertEquals(300, AgentConfig.load(write("url=u\ntoken=t\nserver-id=s\ninterval-seconds=9999\n")).intervalSeconds);
    }

    @Test
    void sayswhatIsWrong() throws IOException {
        IOException missingFile = assertThrows(IOException.class, () -> AgentConfig.load(dir.resolve("nope.properties")));
        assertTrue(missingFile.getMessage().contains("not configured"));
        assertTrue(assertThrows(IOException.class, () -> AgentConfig.load(write("url=u\nserver-id=s\n"))).getMessage().contains("token"));
        assertTrue(assertThrows(IOException.class, () -> AgentConfig.load(write("url=u\ntoken=t\nserver-id=s\ninterval-seconds=x\n"))).getMessage().contains("interval-seconds"));
    }
}
