package nut.ios;

import java.io.FileWriter;
import java.io.IOException;
import java.util.Map;

/** NUTclient iOS (nur für Tests): alle Java-Threads mit Aufrufkette in eine Datei schreiben. */
public final class ThreadDump {
    private ThreadDump() {}

    public static void dump(String path) throws IOException {
        StringBuilder b = new StringBuilder();
        b.append("Zeit ").append(System.currentTimeMillis()).append('\n');
        for (Map.Entry<Thread, StackTraceElement[]> e : Thread.getAllStackTraces().entrySet()) {
            Thread t = e.getKey();
            b.append("\n\"").append(t.getName()).append("\" ").append(t.getState()).append('\n');
            for (StackTraceElement s : e.getValue()) b.append("    at ").append(s).append('\n');
        }
        try (FileWriter w = new FileWriter(path)) { w.write(b.toString()); }
    }
}
