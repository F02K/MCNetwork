package dev.mcnetwork.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonTest {
    @Test
    void writesNestedValuesWithEscapesAndTrimmedNumbers() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("text", "a \"quoted\"\nline\\");
        m.put("n", 5);
        m.put("d", 12.5);
        m.put("whole", 3.0);
        m.put("nan", Double.NaN);
        m.put("none", null);
        m.put("flag", true);
        m.put("list", List.of(1, "x"));
        m.put("tps", new double[] {20.0, 19.5});
        assertEquals("{\"text\":\"a \\\"quoted\\\"\\nline\\\\\",\"n\":5,\"d\":12.500,\"whole\":3,\"nan\":null,\"none\":null,\"flag\":true,\"list\":[1,\"x\"],\"tps\":[20,19.500]}", Json.write(m));
    }

    @Test
    void controlCharactersAreEscaped() {
        assertEquals("\"\\u0001\"", Json.write("\u0001"));
    }

    @Test
    void parsesWhatItWrites() {
        Map<?, ?> m = (Map<?, ?>) Json.parse("{\"ok\": true, \"commands\": [{\"id\":\"c1\",\"type\":\"gc\"},{\"id\":\"c2\",\"n\":-1.5e1,\"s\":\"\\u00e4\\n\"}], \"x\": null}");
        assertEquals(Boolean.TRUE, m.get("ok"));
        assertNull(m.get("x"));
        List<?> cmds = (List<?>) m.get("commands");
        assertEquals("gc", ((Map<?, ?>) cmds.get(0)).get("type"));
        assertEquals(-15.0, ((Map<?, ?>) cmds.get(1)).get("n"));
        assertEquals("ä\n", ((Map<?, ?>) cmds.get(1)).get("s"));
    }

    @Test
    void rejectsBrokenJson() {
        for (String bad : new String[] {"", "{", "{\"a\" 1}", "[1,", "{\"a\":1} x", "nul", "\"\\q\""}) {
            assertThrows(IllegalArgumentException.class, () -> Json.parse(bad), bad);
        }
        assertTrue(((Map<?, ?>) Json.parse(" { } ")).isEmpty());
        assertTrue(((List<?>) Json.parse("[ ]")).isEmpty());
    }
}
