package ca.weblite.objc;

import com.sun.jna.Pointer;

/**
 * NUTclient iOS: eigener, leerer Ersatz für die Mac-Brücke „java-objc-bridge“ (gleiche Klassennamen, damit Minecraft
 * und text2speech sie finden). Auf dem iPhone gibt es weder NSApplication noch NSWindow – jede Nachricht ist ein No-op,
 * Zeiger sind Platzhalter ungleich 0, Rückgaben leer.
 */
public class Proxy {
    public Proxy() {}
    public Proxy(Pointer peer) {}
    public Proxy(Client client) {}
    public Proxy(Client client, Pointer peer) {}

    // nie 0: text2speech bricht sonst mit FatalException ab (Minecraft fängt die nicht) – so ist es ein stummer Sprecher
    static final Pointer FAKE = new Pointer(1L);
    public Pointer getPeer() { return FAKE; }
    public Object send(String selector, Object... args) { return null; }
    public Object sendRaw(String selector, Object... args) { return 0L; }
    public Proxy sendProxy(String selector, Object... args) { return new Proxy(); }
    public String sendString(String selector, Object... args) { return null; }
    public int sendInt(String selector, Object... args) { return 0; }
    public boolean sendBoolean(String selector, Object... args) { return false; }
    public void dispose(boolean sendDealloc) {}
}
