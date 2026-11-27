package ca.weblite.objc;

/** NUTclient iOS: leerer Ersatz (siehe {@link Proxy}). */
public class Client {
    private static final Client INSTANCE = new Client();
    public static Client getInstance() { return INSTANCE; }
    public static Client getRawClient() { return INSTANCE; }

    public Proxy sendProxy(String className, String selector, Object... args) { return new Proxy(); }
    public Proxy sendProxy(Object receiver, String selector, Object... args) { return new Proxy(); }
    public Object send(String className, String selector, Object... args) { return null; }
    public Object send(Object receiver, String selector, Object... args) { return null; }
    public String sendString(Object receiver, String selector, Object... args) { return null; }
    public int sendInt(Object receiver, String selector, Object... args) { return 0; }
    public boolean sendBoolean(Object receiver, String selector, Object... args) { return false; }
}
