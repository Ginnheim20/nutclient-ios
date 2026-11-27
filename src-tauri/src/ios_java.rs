//! iPhone: Java (OpenJDK) direkt in der App starten – iOS erlaubt keine fremden Prozesse, also läuft die JVM im
//! Launcher-Prozess. Eigener Code (kein fremder Launcher-Code): libjvm.dylib laden, `JNI_CreateJavaVM` aufrufen,
//! über JNI Java-Methoden rufen.
//!
//! Die Java-Laufzeit liegt in der App unter `java/<major>/` (siehe `.github/workflows/ios.yml`, wird beim Bauen
//! mit eingepackt, weil iOS nur Bibliotheken laden darf, die mit der App signiert sind).
//!
//! Meilenstein 1: `java_selftest` startet die JVM und liest `java.version` / `os.arch` / eine kleine Rechnung aus.

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use jni::sys::{jint, JavaVM as RawVM, JavaVMInitArgs, JavaVMOption, JNI_OK, JNI_VERSION_1_8};
use jni::JavaVM;

/// Eine JVM pro Prozess (Java erlaubt keine zweite) – einmal erzeugt, danach wiederverwendet.
static VM: OnceLock<Result<JavaVM, String>> = OnceLock::new();

/// Ordner der App (…/NUTclient Launcher.app).
fn bundle_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Mitgelieferte Java-Laufzeiten, neueste zuerst (Ordnername = Hauptversion).
pub fn runtimes() -> Vec<(u32, PathBuf)> {
    let mut out: Vec<(u32, PathBuf)> = std::fs::read_dir(bundle_dir().join("java"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok().map(|v| (v, e.path())))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// libjvm.dylib in einer Laufzeit suchen (lib/server/ oder lib/zero/ …).
fn find_libjvm(home: &Path) -> Option<PathBuf> {
    for sub in ["lib/server/libjvm.dylib", "lib/zero/libjvm.dylib", "lib/client/libjvm.dylib", "jre/lib/server/libjvm.dylib"] {
        let p = home.join(sub);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Schreibbarer Ordner für Java (Protokolle, Absturzberichte, Temp).
fn work_dir() -> PathBuf {
    let d = crate::config::LauncherConfig::load().root.join("java-work");
    let _ = std::fs::create_dir_all(&d);
    d
}

type CreateVm = unsafe extern "system" fn(*mut *mut RawVM, *mut *mut c_void, *mut c_void) -> jint;

fn create_vm(home: &Path, extra: &[String]) -> Result<JavaVM, String> {
    let lib = find_libjvm(home).ok_or_else(|| format!("libjvm.dylib fehlt in {}", home.display()))?;
    let work = work_dir();
    // Bibliothek bleibt für immer geladen (die JVM lässt sich nicht entladen)
    let jvm_lib = unsafe { libloading::Library::new(&lib) }.map_err(|e| format!("libjvm laden: {e}"))?;
    let create: libloading::Symbol<CreateVm> =
        unsafe { jvm_lib.get(b"JNI_CreateJavaVM\0") }.map_err(|e| format!("JNI_CreateJavaVM fehlt: {e}"))?;
    let create = *create;
    std::mem::forget(jvm_lib);

    let mut opts: Vec<String> = vec![
        format!("-Djava.home={}", home.display()),
        format!("-Djava.io.tmpdir={}", work.display()),
        format!("-Duser.home={}", work.display()),
        format!("-Duser.dir={}", work.display()),
        format!("-XX:ErrorFile={}/hs_err_%p.log", work.display()),
        "-Xms64m".into(),
        "-Xmx256m".into(),
        "-Djava.awt.headless=true".into(),
        // iOS hat kleine Signal-/Thread-Grenzen – keine eigenen Signal-Handler nötig
        "-Xrs".into(),
    ];
    // spätere Angaben gewinnen (z. B. -Xmx, user.dir, java.library.path vom Spiel)
    opts.extend(extra.iter().cloned());
    let cstrs: Vec<CString> = opts.iter().map(|o| CString::new(o.as_str()).unwrap()).collect();
    let mut raw: Vec<JavaVMOption> = cstrs
        .iter()
        .map(|c| JavaVMOption { optionString: c.as_ptr() as *mut _, extraInfo: std::ptr::null_mut() })
        .collect();
    let mut args = JavaVMInitArgs {
        version: JNI_VERSION_1_8,
        nOptions: raw.len() as jint,
        options: raw.as_mut_ptr(),
        ignoreUnrecognized: 1,
    };
    let mut vm: *mut RawVM = std::ptr::null_mut();
    let mut env: *mut c_void = std::ptr::null_mut();
    let rc = unsafe { create(&mut vm, &mut env, &mut args as *mut _ as *mut c_void) };
    drop(cstrs);
    if rc != JNI_OK || vm.is_null() {
        return Err(format!("JNI_CreateJavaVM fehlgeschlagen (Code {rc}), siehe {}", work.display()));
    }
    unsafe { JavaVM::from_raw(vm) }.map_err(|e| e.to_string())
}

/// JVM holen (beim ersten Mal mit der neuesten mitgelieferten Laufzeit starten).
pub fn vm() -> Result<&'static JavaVM, String> {
    VM.get_or_init(|| {
        let (_, home) = runtimes().into_iter().next().ok_or_else(|| "Keine Java-Laufzeit in der App".to_string())?;
        // eigener Thread mit großem Stack – die JVM braucht beim Start viel Stack, der Hauptthread ist knapp
        std::thread::Builder::new()
            .name("nut-jvm-start".into())
            .stack_size(16 << 20)
            .spawn(move || create_vm(&home, &[]))
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "JVM-Start abgestürzt".to_string())?
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Meilenstein 1: JVM starten und ein paar Werte aus Java zurückholen.
pub fn selftest() -> Result<String, String> {
    let rts: Vec<String> = runtimes().iter().map(|(v, _)| format!("Java {v}")).collect();
    let vm = vm()?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let mut prop = |name: &str| -> Result<String, String> {
        let key = env.new_string(name).map_err(|e| e.to_string())?;
        let v = env
            .call_static_method("java/lang/System", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", &[(&key).into()])
            .and_then(|v| v.l())
            .map_err(|e| e.to_string())?;
        let js = jni::objects::JString::from(v);
        let s: String = env.get_string(&js).map_err(|e| e.to_string())?.into();
        Ok(s)
    };
    let version = prop("java.version")?;
    let vendor = prop("java.vm.name")?;
    let arch = prop("os.arch")?;
    let os = prop("os.name")?;
    // kleine Rechnung in Java: Math.multiplyExact(6, 7)
    let r = env
        .call_static_method("java/lang/Math", "multiplyExact", "(II)I", &[6.into(), 7.into()])
        .and_then(|v| v.i())
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "Java läuft im Launcher ✓\nVersion {version} ({vendor})\nSystem {os} / {arch}\nJava rechnet 6 × 7 = {r}\nMitgeliefert: {}",
        rts.join(", ")
    ))
}

/// Pfad der eigenen Bibliothek + LWJGL-Bausteine in der App.
pub fn lwjgl_dir() -> PathBuf {
    bundle_dir().join("lwjgl")
}

/// Minecraft im App-Prozess starten. `cmd` ist genau der Befehl, den der PC-Launcher ausführen würde
/// (java <JVM-Argumente> <Hauptklasse> <Spiel-Argumente>) – daraus werden JVM-Optionen und der main-Aufruf.
pub fn launch_game(cmd: &std::process::Command, game_dir: &Path, major: u32) -> Result<(), String> {
    if VM.get().is_some() {
        return Err("Java lief in dieser Sitzung schon – bitte die App einmal ganz schließen und neu öffnen".into());
    }
    let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    let mut jvm: Vec<String> = Vec::new();
    let mut i = 0;
    let mut main = None;
    while i < args.len() {
        let a = &args[i];
        if (a == "-cp" || a == "-classpath") && i + 1 < args.len() {
            // Mac-Natives-Jars (LWJGL, jtracy, netty-kqueue) raus: LWJGL würde sie entpacken und statt unserer
            // für iOS umgestempelten Bausteine laden → dlopen schlägt fehl
            // java-objc-bridge → eigener leerer Ersatz (ios-native/objc-stub)
            let stub = lwjgl_dir().join("nut-objc.jar").to_string_lossy().into_owned();
            let cp: Vec<&str> = args[i + 1]
                .split(':')
                .filter(|p| {
                    let n = p.rsplit('/').next().unwrap_or("");
                    !(n.contains("-natives-") || n.contains("-osx-"))
                })
                .map(|p| if p.rsplit('/').next().unwrap_or("").starts_with("java-objc-bridge") { stub.as_str() } else { p })
                .collect();
            jvm.push(format!("-Djava.class.path={}", cp.join(":")));
            i += 2;
            continue;
        }
        if a.starts_with('-') {
            // gibt es hier nicht bzw. ersetzen wir
            if !(a == "-XstartOnFirstThread" || a.starts_with("-Djava.library.path=") || a.starts_with("-javaagent:")) {
                jvm.push(a.clone());
            }
            i += 1;
            continue;
        }
        main = Some(a.clone());
        i += 1;
        break;
    }
    let main = main.ok_or("Keine Hauptklasse im Startbefehl")?;
    let game: Vec<String> = args[i..].to_vec();
    let lw = lwjgl_dir();
    let nutgl = lw.join("libnutgl.dylib");
    jvm.extend([
        format!("-Djava.library.path={}", lw.display()),
        format!("-Dorg.lwjgl.librarypath={}", lw.display()),
        format!("-Dorg.lwjgl.glfw.libname={}", nutgl.display()),
        format!("-Dorg.lwjgl.opengl.libname={}", nutgl.display()),
        format!("-Dorg.lwjgl.openal.libname={}", lw.join("libnutal.dylib").display()),
        "-Dorg.lwjgl.glfw.checkThread0=false".into(),
        // JNA: eigenen (umgestempelten) Baustein nehmen, nichts aus dem Jar entpacken (iOS lädt nur signierte Dateien)
        format!("-Djna.boot.library.path={}", lw.display()),
        "-Djna.nounpack=true".into(),
        "-Djna.nosys=true".into(),
        "-Dorg.lwjgl.system.allocator=system".into(),
        "-Dorg.lwjgl.util.Debug=true".into(),
        "-Dorg.lwjgl.util.DebugLoader=true".into(),
        format!("-Duser.dir={}", game_dir.display()),
        "-Dnutclient.ios=1".into(),
        "-Xss4m".into(),
    ]);
    let home = runtimes()
        .into_iter()
        .find(|(v, _)| *v >= major)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("Java {major} ist nicht in der App"))?;
    let _ = std::env::set_current_dir(game_dir);
    eprintln!("NUTIOS Start {main} mit Java aus {} ({} JVM-, {} Spiel-Argumente)", home.display(), jvm.len(), game.len());
    let log = game_dir.join("logs");
    let _ = std::fs::create_dir_all(&log);
    let _ = std::fs::write(log.join("ios-launch.txt"), format!("{main}
{}
---
{}", jvm.join("
"), game.join("
")));

    std::thread::Builder::new()
        .name("Minecraft".into())
        .stack_size(64 << 20)
        .spawn(move || {
            let vm = match create_vm(&home, &jvm) {
                Ok(vm) => vm,
                Err(e) => {
                    eprintln!("NUTIOS JVM-Fehler: {e}");
                    let _ = VM.set(Err(e));
                    return;
                }
            };
            let _ = VM.set(Ok(vm));
            let vm = VM.get().unwrap().as_ref().unwrap();
            let mut env = match vm.attach_current_thread_permanently() {
                Ok(e) => e,
                Err(e) => return eprintln!("NUTIOS attach: {e}"),
            };
            let res = (|| -> jni::errors::Result<()> {
                let class = env.find_class(main.replace('.', "/"))?;
                let string = env.find_class("java/lang/String")?;
                let empty = env.new_string("")?;
                let arr = env.new_object_array(game.len() as i32, &string, &empty)?;
                for (k, g) in game.iter().enumerate() {
                    let js = env.new_string(g)?;
                    env.set_object_array_element(&arr, k as i32, &js)?;
                }
                env.call_static_method(class, "main", "([Ljava/lang/String;)V", &[(&arr).into()])?;
                Ok(())
            })();
            if let Err(e) = res {
                eprintln!("NUTIOS Minecraft beendet mit Fehler: {e}");
                let _ = env.exception_describe();
            } else {
                eprintln!("NUTIOS Minecraft-main zurückgekehrt");
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Läuft Minecraft gerade (JVM erzeugt und Fenster offen)?
pub fn game_running() -> bool {
    matches!(VM.get(), Some(Ok(_)))
}

type InputFn = unsafe extern "C" fn(i32, f64, f64, i32, i32);
type IntFn = unsafe extern "C" fn() -> i32;

fn nutgl_sym<T: Copy>(name: &[u8]) -> Option<T> {
    // dieselbe Datei, die LWJGL geladen hat → dasselbe Abbild im Speicher
    let lib = unsafe { libloading::Library::new(lwjgl_dir().join("libnutgl.dylib")) }.ok()?;
    let f = unsafe { lib.get::<T>(name) }.ok().map(|s| *s);
    std::mem::forget(lib);
    f
}

/// Eingabe an das Spiel (Touch-Steuerung → nutgl → GLFW-Rückrufe von Minecraft).
pub fn input(kind: i32, a: f64, b: f64, c: i32, d: i32) {
    static F: OnceLock<Option<InputFn>> = OnceLock::new();
    if let Some(f) = F.get_or_init(|| nutgl_sym::<InputFn>(b"nut_input ")) {
        unsafe { f(kind, a, b, c, d) }
    }
}

/// Zustand für die Touch-Steuerung: Maus gefangen (= im Spiel) / Fenster offen.
pub fn state() -> (bool, bool) {
    static G: OnceLock<Option<(IntFn, IntFn)>> = OnceLock::new();
    match G.get_or_init(|| Some((nutgl_sym::<IntFn>(b"nut_cursor_grabbed ")?, nutgl_sym::<IntFn>(b"nut_window_open ")?))) {
        Some((g, w)) => unsafe { (g() != 0, w() != 0) },
        None => (false, false),
    }
}

/// Inhalt der Island aus dem Spiel (NUTclient setzt System-Eigenschaft „nutclient.island“ als JSON).
pub fn island() -> Option<String> {
    let vm = VM.get()?.as_ref().ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let key = env.new_string("nutclient.island").ok()?;
    let v = env
        .call_static_method("java/lang/System", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", &[(&key).into()])
        .and_then(|v| v.l())
        .ok()?;
    if v.is_null() {
        return None;
    }
    let js = jni::objects::JString::from(v);
    env.get_string(&js).ok().map(Into::into)
}

/// Test: schreibt auf, was jeder Java-Thread gerade tut (eigene Hilfsklasse nut/ios/ThreadDump in nut-objc.jar)
pub fn thread_dump(path: &std::path::Path) -> Result<(), String> {
    let vm = VM.get().ok_or("keine JVM")?.as_ref().map_err(|e| e.clone())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let p = env.new_string(path.to_string_lossy()).map_err(|e| e.to_string())?;
    let r = env.call_static_method("nut/ios/ThreadDump", "dump", "(Ljava/lang/String;)V", &[(&p).into()]);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    r.map(|_| ()).map_err(|e| e.to_string())
}
