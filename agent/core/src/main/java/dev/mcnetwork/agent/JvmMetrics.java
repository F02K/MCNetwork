package dev.mcnetwork.agent;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.lang.management.MemoryUsage;
import java.util.LinkedHashMap;
import java.util.Map;

/** What the JVM knows about its own memory and garbage collection. */
public final class JvmMetrics {
    private static final double MB = 1024.0 * 1024.0;

    private JvmMetrics() {}

    public static Map<String, Object> collect() {
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        MemoryUsage heap = memory.getHeapMemoryUsage();
        MemoryUsage nonHeap = memory.getNonHeapMemoryUsage();

        long gcCount = 0;
        long gcTime = 0;
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (gc.getCollectionCount() > 0) gcCount += gc.getCollectionCount();
            if (gc.getCollectionTime() > 0) gcTime += gc.getCollectionTime();
        }

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("heapUsedMb", heap.getUsed() / MB);
        m.put("heapCommittedMb", heap.getCommitted() / MB);
        m.put("heapMaxMb", heap.getMax() < 0 ? null : heap.getMax() / MB);
        m.put("nonHeapUsedMb", nonHeap.getUsed() / MB);
        m.put("liveSetMb", liveSetMb());
        m.put("gcCount", gcCount);
        m.put("gcTimeMs", gcTime);
        m.put("threads", ManagementFactory.getThreadMXBean().getThreadCount());
        m.put("uptimeMs", ManagementFactory.getRuntimeMXBean().getUptime());
        m.put("processors", Runtime.getRuntime().availableProcessors());
        m.put("processCpu", processCpu());
        return m;
    }

    /**
     * Heap that was still in use right after the last garbage collection: the memory the server really
     * needs (what is above it is garbage that has not been collected yet). Null until a GC has happened.
     */
    static Double liveSetMb() {
        long total = 0;
        boolean any = false;
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() != MemoryType.HEAP) continue;
            MemoryUsage after = pool.getCollectionUsage();
            if (after == null || after.getUsed() < 0) continue;
            total += after.getUsed();
            any = true;
        }
        return any && total > 0 ? total / MB : null;
    }

    /** CPU used by this process, 0..1 of the whole machine, or null when the JVM does not tell. */
    static Double processCpu() {
        java.lang.management.OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
        if (os instanceof com.sun.management.OperatingSystemMXBean sun) {
            double load = sun.getProcessCpuLoad();
            return load < 0 ? null : load;
        }
        return null;
    }

    /** Frees what can be freed: asks for a garbage collection and returns the heap in use before and after (MB). */
    public static double[] collectGarbage() {
        Runtime rt = Runtime.getRuntime();
        double before = (rt.totalMemory() - rt.freeMemory()) / MB;
        System.gc();
        double after = (rt.totalMemory() - rt.freeMemory()) / MB;
        return new double[] {before, after};
    }
}
