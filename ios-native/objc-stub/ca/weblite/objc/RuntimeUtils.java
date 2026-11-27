package ca.weblite.objc;

import com.sun.jna.Pointer;

/** NUTclient iOS: leerer Ersatz (siehe {@link Proxy}). */
public class RuntimeUtils {
    public static Pointer sel(String name) { return Proxy.FAKE; }
    public static Pointer cls(String name) { return Proxy.FAKE; }
    public static long msg(Pointer receiver, Pointer selector, Object... args) { return 0L; }
    public static long msg(String className, String selector, Object... args) { return 0L; }
}
