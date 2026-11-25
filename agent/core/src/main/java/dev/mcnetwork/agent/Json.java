package dev.mcnetwork.agent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Just enough JSON for the agent protocol (objects, arrays, strings, numbers, booleans, null). */
public final class Json {
    private Json() {}

    // ------------------------------------------------------------------ writing

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String s) {
            string(sb, s);
        } else if (v instanceof Boolean || v instanceof Integer || v instanceof Long) {
            sb.append(v);
        } else if (v instanceof Number n) {
            double d = n.doubleValue();
            sb.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : trimmed(d));
        } else if (v instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                string(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object o : it) {
                if (!first) sb.append(',');
                first = false;
                write(sb, o);
            }
            sb.append(']');
        } else if (v instanceof double[] arr) {
            List<Object> list = new ArrayList<>();
            for (double d : arr) list.add(d);
            write(sb, list);
        } else {
            string(sb, v.toString());
        }
    }

    private static String trimmed(double d) {
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        return String.format(java.util.Locale.ROOT, "%.3f", d);
    }

    private static void string(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------------ parsing

    /** Parses JSON into Map, List, String, Double, Boolean or null. Throws IllegalArgumentException on bad input. */
    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != text.length()) throw new IllegalArgumentException("trailing data at " + p.i);
        return v;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        char peek() {
            if (i >= s.length()) throw new IllegalArgumentException("unexpected end");
            return s.charAt(i);
        }

        Object value() {
            char c = peek();
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return str();
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            return number();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++;
            ws();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                String k = str();
                ws();
                expect(':');
                ws();
                m.put(k, value());
                ws();
                char c = peek();
                i++;
                if (c == '}') return m;
                if (c != ',') throw new IllegalArgumentException("expected , or } at " + (i - 1));
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++;
            ws();
            if (peek() == ']') {
                i++;
                return l;
            }
            while (true) {
                ws();
                l.add(value());
                ws();
                char c = peek();
                i++;
                if (c == ']') return l;
                if (c != ',') throw new IllegalArgumentException("expected , or ] at " + (i - 1));
            }
        }

        String str() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = peek();
                i++;
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = peek();
                i++;
                switch (e) {
                    case '"', '\\', '/' -> sb.append(e);
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> {
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape at " + (i - 1));
                }
            }
        }

        Double number() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (start == i) throw new IllegalArgumentException("unexpected character at " + i);
            return Double.valueOf(s.substring(start, i));
        }

        void expect(char c) {
            if (peek() != c) throw new IllegalArgumentException("expected " + c + " at " + i);
            i++;
        }
    }
}
