//! Daten zwischen zwei Geräten im selben WLAN übertragen.
//!
//! Läuft der Launcher auf zwei Geräten im selben Netz, finden sie sich per UDP-Rundruf (Port 47821, nur im
//! lokalen Netz). Danach baut das Gerät mit der kleineren Kennung eine TCP-Verbindung auf; beide tauschen
//! X25519-Schlüssel aus, alles Weitere ist mit ChaCha20-Poly1305 verschlüsselt (Konten mit Anmeldedaten gehen
//! über die Leitung). Aus dem gemeinsamen Schlüssel entsteht ein vierstelliger Code, den beide Geräte zeigen –
//! stimmt er überein, spricht niemand dazwischen.
//!
//! Beide Seiten fragen „Daten übertragen?“. Nur wenn beide Ja sagen, schickt jede Seite ihre Daten: die
//! Launcher-Daten des Frontends (localStorage, wird dort zusammengeführt) und eine ZIP mit Konto-Datei und den
//! Instanz-Ordnern (Mods, Ressourcen-/Shaderpakete, Einstellungen, Serverliste – keine Welten, keine Logs).
//! Beim Entpacken wird nichts Vorhandenes überschrieben.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PORT: u16 = 47821;
const MAGIC: &str = "nutclient-sync-1";
/// Größer wird nichts übertragen (Schutz vor Unfug).
const MAX_BUNDLE: u64 = 4 * 1024 * 1024 * 1024;

/// Dieses Gerät.
#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub os: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
struct Ask {
    peer_id: String,
    name: String,
    os: String,
    kind: String,
    code: String,
}

#[derive(Clone, Serialize)]
struct Status {
    peer_id: String,
    state: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct Data {
    peer_id: String,
    storage: String,
}

/// Antwort des Nutzers für eine Gegenstelle.
pub struct Answer {
    pub yes: bool,
    pub storage: String,
}

struct Shared {
    root: PathBuf,
    me: Device,
    tcp_port: u16,
    /// Gegenstellen, die nicht (mehr) gefragt werden: ausgeblendet oder schon in dieser Sitzung gefragt.
    hidden: HashSet<String>,
    asked: HashSet<String>,
    /// Laufende Sitzungen: hier landen die Antworten des Nutzers.
    sessions: HashMap<String, Sender<Answer>>,
    peers: HashMap<String, (SocketAddr, Instant)>,
    running: bool,
}

#[derive(Clone)]
pub struct Sync {
    inner: Arc<Mutex<Shared>>,
}

impl Sync {
    pub fn new(root: PathBuf) -> Self {
        let me = device(&root);
        Self {
            inner: Arc::new(Mutex::new(Shared {
                root,
                me,
                tcp_port: 0,
                hidden: HashSet::new(),
                asked: HashSet::new(),
                sessions: HashMap::new(),
                peers: HashMap::new(),
                running: false,
            })),
        }
    }

    pub fn device(&self) -> Device {
        self.inner.lock().unwrap().me.clone()
    }

    /// Gerätesuche starten (einmal) bzw. die ausgeblendeten Gegenstellen setzen. {@code retry} = auch schon
    /// gefragte Geräte in dieser Sitzung noch einmal fragen („Gerätesuche wiederholen“).
    pub fn start(&self, app: AppHandle, hidden: Vec<String>, retry: bool) {
        let first = {
            let mut s = self.inner.lock().unwrap();
            s.hidden = hidden.into_iter().collect();
            if retry {
                s.asked.clear();
            }
            let first = !s.running;
            s.running = true;
            first
        };
        if !first {
            return;
        }
        let listener = match TcpListener::bind(("0.0.0.0", 0)) {
            Ok(l) => l,
            Err(_) => return,
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        self.inner.lock().unwrap().tcp_port = port;
        // eingehende Verbindungen (Gegenstelle mit kleinerer Kennung meldet sich)
        let me = self.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let me = me.clone();
                let app = app2.clone();
                std::thread::spawn(move || {
                    let _ = me.session(app, stream, None);
                });
            }
        });
        // Rundruf senden und hören
        let me = self.clone();
        std::thread::spawn(move || me.discover(app));
    }

    pub fn answer(&self, peer: &str, answer: Answer) {
        let tx = self.inner.lock().unwrap().sessions.get(peer).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(answer);
        }
    }

    fn discover(&self, app: AppHandle) {
        let sock = UdpSocket::bind(("0.0.0.0", PORT)).or_else(|_| UdpSocket::bind(("0.0.0.0", 0)));
        let sock = match sock {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = sock.set_broadcast(true);
        let _ = sock.set_read_timeout(Some(Duration::from_millis(500)));
        let mut last_send = Instant::now() - Duration::from_secs(10);
        let mut buf = [0u8; 1024];
        loop {
            if last_send.elapsed() > Duration::from_secs(3) {
                last_send = Instant::now();
                let msg = {
                    let s = self.inner.lock().unwrap();
                    serde_json::json!({"magic": MAGIC, "id": s.me.id, "port": s.tcp_port}).to_string()
                };
                let _ = sock.send_to(msg.as_bytes(), ("255.255.255.255", PORT));
            }
            let (n, from) = match sock.recv_from(&mut buf) {
                Ok(x) => x,
                Err(_) => continue,
            };
            if !local(from.ip()) {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_slice(&buf[..n]) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["magic"] != MAGIC {
                continue;
            }
            let id = v["id"].as_str().unwrap_or("").to_string();
            let port = v["port"].as_u64().unwrap_or(0) as u16;
            if id.len() != 32 || port == 0 {
                continue;
            }
            let connect = {
                let mut s = self.inner.lock().unwrap();
                if id == s.me.id {
                    continue;
                }
                s.peers.insert(id.clone(), (SocketAddr::new(from.ip(), port), Instant::now()));
                let free = !s.hidden.contains(&id) && !s.asked.contains(&id) && !s.sessions.contains_key(&id);
                free && s.me.id < id
            };
            if connect {
                let me = self.clone();
                let app = app.clone();
                let addr = SocketAddr::new(from.ip(), port);
                std::thread::spawn(move || {
                    if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(4)) {
                        let _ = me.session(app, stream, Some(id));
                    }
                });
            }
        }
    }

    /// Eine Verbindung: Schlüssel tauschen, fragen, ggf. übertragen.
    fn session(&self, app: AppHandle, stream: TcpStream, expect: Option<String>) -> std::io::Result<()> {
        let peer_addr = stream.peer_addr()?;
        if !local(peer_addr.ip()) {
            return Ok(());
        }
        stream.set_read_timeout(Some(Duration::from_secs(20)))?;
        let (me, root) = {
            let s = self.inner.lock().unwrap();
            (s.me.clone(), s.root.clone())
        };
        // Schlüssel: zufälliges Geheimnis je Verbindung
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).map_err(|e| std::io::Error::other(e.to_string()))?;
        let secret = x25519_dalek::StaticSecret::from(secret);
        let public = x25519_dalek::PublicKey::from(&secret);
        let hello = serde_json::json!({"magic": MAGIC, "id": me.id, "name": me.name, "os": me.os, "kind": me.kind,
            "key": hex::encode(public.as_bytes())});
        let mut w = stream.try_clone()?;
        writeln!(w, "{}", hello)?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let other: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| std::io::Error::other(e.to_string()))?;
        if other["magic"] != MAGIC {
            return Ok(());
        }
        let peer = other["id"].as_str().unwrap_or("").to_string();
        if peer.len() != 32 || peer == me.id || expect.as_ref().is_some_and(|e| e != &peer) {
            return Ok(());
        }
        let key_bytes: [u8; 32] = hex::decode(other["key"].as_str().unwrap_or(""))
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| std::io::Error::other("Schlüssel fehlt"))?;
        // schon gefragt, ausgeblendet oder doppelt verbunden: still beenden
        let (tx, rx) = channel::<Answer>();
        {
            let mut s = self.inner.lock().unwrap();
            if s.hidden.contains(&peer) || s.asked.contains(&peer) || s.sessions.contains_key(&peer) {
                return Ok(());
            }
            s.asked.insert(peer.clone());
            s.sessions.insert(peer.clone(), tx);
        }
        let result = self.run(&app, &root, &me, &peer, &other, secret, key_bytes, w, reader, rx);
        self.inner.lock().unwrap().sessions.remove(&peer);
        if let Err(e) = &result {
            emit_status(&app, &peer, "error", &format!("Übertragung abgebrochen: {e}"));
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        app: &AppHandle,
        root: &Path,
        me: &Device,
        peer: &str,
        other: &serde_json::Value,
        secret: x25519_dalek::StaticSecret,
        key_bytes: [u8; 32],
        w: TcpStream,
        reader: BufReader<TcpStream>,
        rx: Receiver<Answer>,
    ) -> std::io::Result<()> {
        let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(key_bytes));
        let (lo, hi) = if me.id.as_str() < peer { (me.id.as_str(), peer) } else { (peer, me.id.as_str()) };
        let hk = hkdf::Hkdf::<Sha256>::new(Some(format!("{lo}{hi}").as_bytes()), shared.as_bytes());
        let mut key = [0u8; 32];
        hk.expand(b"nutclient-sync schluessel", &mut key).map_err(|_| std::io::Error::other("hkdf"))?;
        let code = {
            let d = Sha256::digest([key.as_slice(), b"code"].concat());
            format!("{:04}", u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 10000)
        };
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        let my_dir: u8 = if me.id.as_str() < peer { 0 } else { 1 };
        let mut out = Channel { stream: w, cipher: cipher.clone(), dir: my_dir, counter: 0 };
        let mut inp = Channel { stream: reader.into_inner(), cipher, dir: 1 - my_dir, counter: 0 };

        let _ = app.emit(
            "sync://ask",
            Ask {
                peer_id: peer.to_string(),
                name: other["name"].as_str().unwrap_or("Gerät").chars().take(60).collect(),
                os: other["os"].as_str().unwrap_or("").chars().take(60).collect(),
                kind: other["kind"].as_str().unwrap_or("").chars().take(20).collect(),
                code,
            },
        );
        // Antwort des Nutzers abwarten (höchstens 10 Minuten); solange hält ein Lebenszeichen die Verbindung offen
        inp.stream.set_read_timeout(None)?;
        let answer = match rx.recv_timeout(Duration::from_secs(600)) {
            Ok(a) => a,
            Err(_) => Answer { yes: false, storage: String::new() },
        };
        out.send_json(&serde_json::json!({"t": "decision", "yes": answer.yes}))?;
        inp.stream.set_read_timeout(Some(Duration::from_secs(660)))?;
        let theirs = inp.recv()?;
        let they_yes = serde_json::from_slice::<serde_json::Value>(&theirs.1).ok().and_then(|v| v["yes"].as_bool()).unwrap_or(false);
        if !answer.yes {
            return Ok(());
        }
        if !they_yes {
            emit_status(app, peer, "declined", "Das andere Gerät hat abgelehnt.");
            return Ok(());
        }
        emit_status(app, peer, "sending", "Daten werden übertragen …");
        inp.stream.set_read_timeout(Some(Duration::from_secs(60)))?;

        // eigenes Paket bauen
        let tmp = std::env::temp_dir().join(format!("nutclient-sync-{}.zip", &me.id[..8]));
        bundle(root, &tmp)?;
        let size = std::fs::metadata(&tmp)?.len();

        // Empfangen im eigenen Thread (beide Seiten senden gleichzeitig)
        let recv_path = std::env::temp_dir().join(format!("nutclient-sync-{}-von-{}.zip", &me.id[..8], &peer[..8]));
        let recv_path2 = recv_path.clone();
        let receiver = std::thread::spawn(move || -> std::io::Result<String> {
            let (_, meta) = inp.recv()?;
            let meta: serde_json::Value = serde_json::from_slice(&meta).map_err(|e| std::io::Error::other(e.to_string()))?;
            let total = meta["size"].as_u64().unwrap_or(0);
            if total > MAX_BUNDLE {
                return Err(std::io::Error::other("zu groß"));
            }
            let storage = meta["storage"].as_str().unwrap_or("").to_string();
            let mut f = std::fs::File::create(&recv_path2)?;
            let mut got = 0u64;
            while got < total {
                let (kind, chunk) = inp.recv()?;
                if kind != 2 {
                    return Err(std::io::Error::other("unerwartete Nachricht"));
                }
                got += chunk.len() as u64;
                f.write_all(&chunk)?;
            }
            Ok(storage)
        });
        out.send_json(&serde_json::json!({"t": "bundle", "size": size, "storage": answer.storage}))?;
        let mut f = std::fs::File::open(&tmp)?;
        let mut buf = vec![0u8; 512 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.send(2, &buf[..n])?;
        }
        drop(f);
        let _ = std::fs::remove_file(&tmp);
        let storage = receiver.join().map_err(|_| std::io::Error::other("Empfang abgestürzt"))??;
        let added = unpack(root, &recv_path)?;
        let _ = std::fs::remove_file(&recv_path);
        let _ = app.emit("sync://data", Data { peer_id: peer.to_string(), storage });
        emit_status(app, peer, "done", &format!("Fertig – {added} Dateien übernommen."));
        Ok(())
    }
}

/// Verschlüsselter Kanal in eine Richtung: Rahmen = Länge (4 Byte) + Chiffretext, Nonce = Richtung + Zähler.
struct Channel {
    stream: TcpStream,
    cipher: ChaCha20Poly1305,
    dir: u8,
    counter: u64,
}

impl Channel {
    fn nonce(&mut self) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[0] = self.dir;
        n[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter += 1;
        n
    }

    fn send(&mut self, kind: u8, data: &[u8]) -> std::io::Result<()> {
        let mut plain = Vec::with_capacity(data.len() + 1);
        plain.push(kind);
        plain.extend_from_slice(data);
        let n = self.nonce();
        let ct = self.cipher.encrypt(Nonce::from_slice(&n), plain.as_slice()).map_err(|_| std::io::Error::other("Verschlüsselung"))?;
        self.stream.write_all(&(ct.len() as u32).to_be_bytes())?;
        self.stream.write_all(&ct)?;
        Ok(())
    }

    fn send_json(&mut self, v: &serde_json::Value) -> std::io::Result<()> {
        self.send(1, v.to_string().as_bytes())
    }

    fn recv(&mut self) -> std::io::Result<(u8, Vec<u8>)> {
        let mut len = [0u8; 4];
        self.stream.read_exact(&mut len)?;
        let len = u32::from_be_bytes(len) as usize;
        if len > 2 * 1024 * 1024 {
            return Err(std::io::Error::other("Rahmen zu groß"));
        }
        let mut ct = vec![0u8; len];
        self.stream.read_exact(&mut ct)?;
        let n = self.nonce();
        let plain = self.cipher.decrypt(Nonce::from_slice(&n), ct.as_slice()).map_err(|_| std::io::Error::other("falscher Schlüssel"))?;
        if plain.is_empty() {
            return Err(std::io::Error::other("leer"));
        }
        Ok((plain[0], plain[1..].to_vec()))
    }
}

fn emit_status(app: &AppHandle, peer: &str, state: &str, message: &str) {
    let _ = app.emit("sync://status", Status { peer_id: peer.to_string(), state: state.to_string(), message: message.to_string() });
}

/// Nur private Adressen (gleiches Netz) – nichts aus dem Internet.
fn local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xffc0) == 0xfe80 || (v.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// Was aus einem Instanz-Ordner mitgeht (Ordner bzw. Dateien direkt darin).
const INSTANCE_DIRS: &[&str] = &["mods", "resourcepacks", "shaderpacks", "config"];
const INSTANCE_FILES: &[&str] = &["servers.dat", "options.txt"];

fn bundle(root: &Path, out: &Path) -> std::io::Result<()> {
    let f = std::fs::File::create(out)?;
    let mut zip = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let add = |zip: &mut zip::ZipWriter<std::fs::File>, path: &Path, name: String| -> std::io::Result<()> {
        zip.start_file(name, opts).map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut src = std::fs::File::open(path)?;
        std::io::copy(&mut src, zip)?;
        Ok(())
    };
    let account = root.join("account.json");
    if account.is_file() {
        add(&mut zip, &account, "account.json".into())?;
    }
    if let Ok(list) = std::fs::read_dir(root.join("instances")) {
        for inst in list.flatten() {
            let dir = inst.path();
            if !dir.is_dir() {
                continue;
            }
            let id = inst.file_name().to_string_lossy().to_string();
            for name in INSTANCE_FILES {
                let p = dir.join(name);
                if p.is_file() {
                    add(&mut zip, &p, format!("instances/{id}/{name}"))?;
                }
            }
            for sub in INSTANCE_DIRS {
                walk(&dir.join(sub), &mut |p| {
                    if let Ok(rel) = p.strip_prefix(&dir) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        // Launcher-eigene Downloads (Projekt-ID--Datei) holt das andere Gerät selbst
                        if !rel.contains("--") {
                            add(&mut zip, p, format!("instances/{id}/{rel}"))?;
                        }
                    }
                    Ok(())
                })?;
            }
        }
    }
    zip.finish().map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(())
}

fn walk(dir: &Path, f: &mut dyn FnMut(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    let Ok(list) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for e in list.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, f)?;
        } else if p.is_file() {
            f(&p)?;
        }
    }
    Ok(())
}

/// Empfangene ZIP entpacken – nur was es hier noch nicht gibt, und nur an erlaubte Stellen.
fn unpack(root: &Path, zip_path: &Path) -> std::io::Result<usize> {
    let f = std::fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut added = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let allowed = rel_s == "account.json" || {
            let parts: Vec<&str> = rel_s.split('/').collect();
            parts.len() >= 3
                && parts[0] == "instances"
                && (INSTANCE_FILES.contains(&parts[2]) && parts.len() == 3 || INSTANCE_DIRS.contains(&parts[2]) && parts.len() >= 4)
        };
        if !allowed || entry.is_dir() {
            continue;
        }
        let target = root.join(&rel);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
        added += 1;
    }
    Ok(added)
}

// ---------------------------------------------------------------- Gerät

/// Kennung (einmal erzeugt, in device-id.txt), Name und Art dieses Geräts.
fn device(root: &Path) -> Device {
    let file = root.join("device-id.txt");
    let id = std::fs::read_to_string(&file).ok().map(|s| s.trim().to_string()).filter(|s| s.len() == 32).unwrap_or_else(|| {
        let mut b = [0u8; 16];
        let _ = getrandom::getrandom(&mut b);
        let id = hex::encode(b);
        let _ = std::fs::create_dir_all(root);
        let _ = std::fs::write(&file, &id);
        id
    });
    Device { id, name: host_name(), os: os_name(), kind: if has_battery() { "Laptop".into() } else { "PC".into() } }
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Gerät".into())
}

#[cfg(windows)]
fn os_name() -> String {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("cmd").args(["/C", "ver"]).creation_flags(0x0800_0000).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    // „Microsoft Windows [Version 10.0.22631.4602]“: Build ab 22000 = Windows 11
    let build = text.split('.').nth(2).and_then(|b| b.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok()).unwrap_or(0);
    if build >= 22000 { "Windows 11".into() } else { "Windows 10".into() }
}

#[cfg(target_os = "linux")]
fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').to_string()))
        .unwrap_or_else(|| "Linux".into())
}

#[cfg(target_os = "macos")]
fn os_name() -> String {
    "macOS".into()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn os_name() -> String {
    std::env::consts::OS.into()
}

#[cfg(windows)]
fn has_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut st).is_ok() && st.BatteryFlag != 128 && st.BatteryFlag != 255 }
}

#[cfg(not(windows))]
fn has_battery() -> bool {
    std::fs::read_dir("/sys/class/power_supply")
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("BAT")))
        .unwrap_or(false)
}
