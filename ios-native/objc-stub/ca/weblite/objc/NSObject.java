package ca.weblite.objc;

import com.sun.jna.Pointer;

/** NUTclient iOS: leerer Ersatz (siehe {@link Proxy}). */
public class NSObject extends Proxy {
    public NSObject() {}
    public NSObject(String className) {}
    public NSObject(Pointer peer) {}
    public NSObject(Client client) {}
    public NSObject(Client client, Pointer peer) {}

    public NSObject init(Pointer peer) { return this; }
    public NSObject init(String className) { return this; }
    public NSObject dealloc() { return this; }
}
