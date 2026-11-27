//! NeoForge-Profile: passende NeoForge-Version suchen, mit dem offiziellen Installer (ohne Fenster,
//! `--install-client <Datenordner>`) einrichten und die Start-Angaben aus `versions/neoforge-<v>/neoforge-<v>.json`
//! (Hauptklasse, Bibliotheken, JVM-/Spiel-Argumente) für den Start aufbereiten.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::config::LauncherConfig;
use crate::error::{Error, Result};
use crate::minecraft::install::download_verified;

const MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

/// Präfix der NeoForge-Versionen zu einer Minecraft-Version: „1.21.1“ → „21.1.“, „1.21“ → „21.0.“,
/// „26.3“ → „26.3.0.“, „26.1.2“ → „26.1.2.“.
fn prefix(mc: &str) -> Option<String> {
    let parts: Vec<&str> = mc.split('.').collect();
    if parts.iter().any(|p| p.parse::<u32>().is_err()) {
        return None;
    }
    if parts[0] == "1" {
        let minor = parts.get(1)?;
        let patch = parts.get(2).copied().unwrap_or("0");
        Some(format!("{minor}.{patch}."))
    } else {
        let drop = parts.get(1)?;
        let fix = parts.get(2).copied().unwrap_or("0");
        Some(format!("{}.{drop}.{fix}.", parts[0]))
    }
}

/// Neueste NeoForge-Version für diese Minecraft-Version (stabile vor Beta).
/// Alle NeoForge-Versionen für die Minecraft-Version, neueste zuerst.
pub async fn versions(http: &reqwest::Client, mc: &str) -> Result<Vec<String>> {
    let pre = prefix(mc).ok_or_else(|| Error::Other(format!("NeoForge kennt Minecraft {mc} nicht")))?;
    let xml = http.get(format!("{MAVEN}/maven-metadata.xml")).send().await?.error_for_status()?.text().await?;
    let mut all: Vec<String> = xml
        .split("<version>")
        .skip(1)
        .filter_map(|s| s.split("</version>").next())
        .filter(|v| v.starts_with(&pre))
        .map(String::from)
        .collect();
    all.reverse();
    Ok(all)
}

pub async fn latest(http: &reqwest::Client, mc: &str) -> Result<String> {
    let pre = prefix(mc).ok_or_else(|| Error::Other(format!("NeoForge kennt Minecraft {mc} nicht")))?;
    let xml = http.get(format!("{MAVEN}/maven-metadata.xml")).send().await?.error_for_status()?.text().await?;
    let all: Vec<String> = xml
        .split("<version>")
        .skip(1)
        .filter_map(|s| s.split("</version>").next())
        .filter(|v| v.starts_with(&pre))
        .map(String::from)
        .collect();
    all.iter()
        .rev()
        .find(|v| !v.contains('-'))
        .or_else(|| all.last())
        .cloned()
        .ok_or_else(|| Error::Other(format!("Für Minecraft {mc} gibt es (noch) kein NeoForge")))
}

#[derive(Debug, Deserialize)]
struct VersionJson {
    #[serde(rename = "mainClass")]
    main_class: String,
    #[serde(default)]
    libraries: Vec<Lib>,
    #[serde(default)]
    arguments: Option<Args>,
}

#[derive(Debug, Deserialize)]
struct Args {
    #[serde(default)]
    jvm: Vec<serde_json::Value>,
    #[serde(default)]
    game: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct Lib {
    name: String,
    #[serde(default)]
    downloads: Option<LibDownloads>,
}

#[derive(Debug, Deserialize)]
struct LibDownloads {
    #[serde(default)]
    artifact: Option<LibArtifact>,
}

#[derive(Debug, Deserialize)]
struct LibArtifact {
    path: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha1: String,
}

/// Fertig aufbereitete Start-Angaben.
pub struct NeoLaunch {
    pub main_class: String,
    /// Bibliotheken in der Reihenfolge der Versionsdatei (kommen vor die von Minecraft)
    pub classpath: Vec<PathBuf>,
    /// „gruppe:artefakt“ dieser Bibliotheken – gleichnamige von Minecraft fliegen aus dem Classpath
    pub replaces: Vec<String>,
    pub jvm: Vec<String>,
    pub game: Vec<String>,
}

/// NeoForge für diese Minecraft-Version einrichten (falls nötig) und die Start-Angaben liefern.
/// Die Vanilla-Version muss schon installiert sein (Client-Jar), Java ebenso.
pub async fn prepare(
    http: &reqwest::Client,
    cfg: &LauncherConfig,
    mc: &str,
    java: &Path,
    wanted: Option<&str>,
    emit: impl Fn(&str),
) -> Result<NeoLaunch> {
    let neo = match wanted.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v.to_string(),
        None => latest(http, mc).await?,
    };
    let id = format!("neoforge-{neo}");
    let json_path = cfg.version_dir(&id).join(format!("{id}.json"));
    let client = cfg.libraries_dir().join(format!("net/neoforged/neoforge/{neo}/neoforge-{neo}-client.jar"));
    if !json_path.exists() || !client.exists() {
        emit(&format!("NeoForge {neo} installieren (einmalig, dauert etwas)"));
        install(http, cfg, &neo, java).await?;
    }
    let text = std::fs::read_to_string(&json_path)
        .map_err(|_| Error::Other(format!("NeoForge {neo}: Installation unvollständig")))?;
    let v: VersionJson = serde_json::from_str(&text)?;

    let libs = cfg.libraries_dir();
    let mut classpath = Vec::new();
    let mut replaces = Vec::new();
    for lib in &v.libraries {
        let Some(a) = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref()) else { continue };
        let dest = libs.join(&a.path);
        if !dest.exists() && !a.url.is_empty() {
            download_verified(http, &a.url, &a.sha1, &dest).await?;
        }
        if !dest.exists() {
            return Err(Error::Other(format!("NeoForge: Bibliothek fehlt ({})", lib.name)));
        }
        let mut parts = lib.name.split(':');
        if let (Some(g), Some(n)) = (parts.next(), parts.next()) {
            replaces.push(format!("{g}:{n}"));
        }
        classpath.push(dest);
    }

    let sep = if cfg!(windows) { ";" } else { ":" };
    let lib_dir = libs.display().to_string();
    // ${version_name} steht in der ignoreList: dort muss der Name der Vanilla-Jar hin, damit FML sie nicht doppelt lädt
    let fill = |s: &str| {
        s.replace("${library_directory}", &lib_dir)
            .replace("${classpath_separator}", sep)
            .replace("${version_name}", mc)
    };
    let plain = |list: &[serde_json::Value]| -> Vec<String> {
        list.iter().filter_map(|x| x.as_str()).map(fill).collect()
    };
    let (jvm, game) = v.arguments.as_ref().map(|a| (plain(&a.jvm), plain(&a.game))).unwrap_or_default();
    Ok(NeoLaunch { main_class: v.main_class, classpath, replaces, jvm, game })
}

/// Offiziellen Installer laden und ohne Fenster in den Datenordner installieren lassen. Er braucht dort eine
/// `launcher_profiles.json` (wird leer angelegt) und die Vanilla-Jar unter `versions/<mc>/<mc>.jar`.
async fn install(http: &reqwest::Client, cfg: &LauncherConfig, neo: &str, java: &Path) -> Result<()> {
    let dir = cfg.root.join("installers");
    std::fs::create_dir_all(&dir)?;
    let jar = dir.join(format!("neoforge-{neo}-installer.jar"));
    if !jar.exists() {
        download_verified(http, &format!("{MAVEN}/{neo}/neoforge-{neo}-installer.jar"), "", &jar).await?;
    }
    let profiles = cfg.root.join("launcher_profiles.json");
    if !profiles.exists() {
        std::fs::write(&profiles, "{\"profiles\":{}}")?;
    }
    let root = cfg.root.clone();
    let java = java.to_path_buf();
    let log_path = cfg.root.join("logs").join(format!("neoforge-{neo}-install.log"));
    let status = tokio::task::spawn_blocking(move || -> std::io::Result<std::process::ExitStatus> {
        std::fs::create_dir_all(log_path.parent().unwrap_or(Path::new(".")))?;
        let log = std::fs::File::create(&log_path)?;
        let mut cmd = std::process::Command::new(java);
        cmd.arg("-Djava.awt.headless=true")
            .arg("-jar")
            .arg(&jar)
            .arg("--install-client")
            .arg(&root)
            .current_dir(&root)
            .stdout(std::process::Stdio::from(log.try_clone()?))
            .stderr(std::process::Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.status()
    })
    .await
    .map_err(|e| Error::Other(format!("NeoForge-Installer: {e}")))?
    .map_err(Error::Io)?;
    if !status.success() {
        return Err(Error::Other(format!(
            "NeoForge-Installer fehlgeschlagen (Protokoll: logs/neoforge-{neo}-install.log)"
        )));
    }
    Ok(())
}
