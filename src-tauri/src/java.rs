//! JRE bereitstellen. Fehlt eine passende Java-Version, wird ein Temurin-JRE
//! von Adoptium heruntergeladen und unter `<root>/runtime/jre-<major>` entpackt.

use std::path::{Path, PathBuf};

use crate::config::LauncherConfig;
use crate::error::{Error, Result};

/// Major-Version, die eine MC-Version braucht (Fallback für sehr alte Versionen: 8).
pub fn required_major(detail_major: Option<u32>) -> u32 {
    detail_major.unwrap_or(8)
}

pub async fn ensure_java<F>(
    client: &reqwest::Client,
    cfg: &LauncherConfig,
    major: u32,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(&str),
{
    let dir = cfg.root.join("runtime").join(format!("jre-{major}"));
    if let Some(java) = find_java_exe(&dir) {
        return Ok(java);
    }

    std::fs::create_dir_all(&dir)?;
    on_progress(&format!("Java {major} herunterladen…"));

    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    let url = format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
    );

    let bytes = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    on_progress("Java entpacken…");
    if bytes.starts_with(&[0x1f, 0x8b]) {
        // Linux/macOS: Adoptium liefert .tar.gz (mit Ausführrechten, die bleiben erhalten)
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
        tar::Archive::new(gz)
            .unpack(&dir)
            .map_err(|e| Error::Other(format!("JRE-Archiv: {e}")))?;
    } else {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| Error::Other(format!("JRE-Archiv: {e}")))?;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| Error::Other(e.to_string()))?;
            let Some(rel) = file.enclosed_name() else { continue };
            let out = dir.join(rel);
            if file.is_dir() {
                std::fs::create_dir_all(&out)?;
            } else {
                if let Some(p) = out.parent() {
                    std::fs::create_dir_all(p)?;
                }
                let mut o = std::fs::File::create(&out)?;
                std::io::copy(&mut file, &mut o)?;
            }
        }
    }

    find_java_exe(&dir).ok_or_else(|| Error::Other("java nach dem Entpacken nicht gefunden".into()))
}

/// JetBrains Runtime 25 für NUTclient-Profile (Mod-Browser: Mods live einhängen braucht die erweiterte
/// Klassen-Neudefinition, `-XX:+AllowEnhancedClassRedefinition`). Unter `<root>/runtime/jbr-25`. None = nicht verfügbar
/// (anderes Java, Download fehlgeschlagen) – dann startet das Spiel mit dem normalen JRE.
pub async fn ensure_jbr<F>(client: &reqwest::Client, cfg: &LauncherConfig, major: u32, mut on_progress: F) -> Option<PathBuf>
where
    F: FnMut(&str),
{
    if major != 25 {
        return None;
    }
    const BUILD: &str = "25.0.4.1";
    const B: &str = "b635.79";
    let dir = cfg.root.join("runtime").join("jbr-25");
    if let Some(java) = find_java_exe(&dir) {
        return Some(java);
    }
    let (os, ext) = if cfg!(target_os = "windows") {
        ("windows", "zip")
    } else if cfg!(target_os = "macos") {
        ("osx", "tar.gz")
    } else {
        ("linux", "tar.gz")
    };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    let url = format!("https://cache-redirector.jetbrains.com/intellij-jbr/jbr-{BUILD}-{os}-{arch}-{B}.{ext}");
    on_progress("Java für Live-Mods herunterladen…");
    let bytes = match client.get(&url).send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r.bytes().await.ok()?,
        Err(_) => return None,
    };
    on_progress("Java entpacken…");
    let tmp = cfg.root.join("runtime").join("jbr-25.part");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).ok()?;
    unpack(&bytes, &tmp).ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir).ok()?;
    find_java_exe(&dir)
}

/// ZIP oder .tar.gz in einen Ordner entpacken.
fn unpack(bytes: &[u8], dir: &Path) -> Result<()> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
        tar::Archive::new(gz)
            .unpack(dir)
            .map_err(|e| Error::Other(format!("Java-Archiv: {e}")))?;
        return Ok(());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| Error::Other(format!("Java-Archiv: {e}")))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| Error::Other(e.to_string()))?;
        let Some(rel) = file.enclosed_name() else { continue };
        let out = dir.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut o = std::fs::File::create(&out)?;
            std::io::copy(&mut file, &mut o)?;
        }
    }
    Ok(())
}

fn java_bin_name() -> &'static str {
    // java.exe (mit Konsole) statt javaw.exe – so landen Fehler im Log.
    if cfg!(target_os = "windows") {
        "java.exe"
    } else {
        "java"
    }
}

fn find_java_exe(root: &Path) -> Option<PathBuf> {
    let name = java_bin_name();
    let direct = root.join("bin").join(name);
    if direct.exists() {
        return Some(direct);
    }
    // Adoptium entpackt als `jdk-17.0.x+y-jre/bin/javaw.exe`
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let p = entry.path().join("bin").join(name);
        if p.exists() {
            return Some(p);
        }
        // macOS: Contents/Home/bin
        let mac = entry.path().join("Contents").join("Home").join("bin").join(name);
        if mac.exists() {
            return Some(mac);
        }
    }
    None
}
