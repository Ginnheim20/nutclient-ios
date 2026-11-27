use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::auth::Account;
use crate::config::LauncherConfig;
use crate::error::Result;
use crate::minecraft::install::{current_os, library_allowed};
use crate::minecraft::manifest::VersionDetail;

/// Baut den Classpath aus allen erlaubten Libraries plus der Client-Jar.
fn classpath(cfg: &LauncherConfig, detail: &VersionDetail, skip: &[String]) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = detail
        .libraries
        .iter()
        .filter(|l| library_allowed(&l.rules))
        // vom Loader ersetzte Bibliotheken (gleiche „gruppe:artefakt“, andere Version) nicht doppelt laden
        .filter(|l| !skip.iter().any(|k| l.name.starts_with(&format!("{k}:"))))
        .filter_map(|l| l.downloads.as_ref().and_then(|d| d.artifact.as_ref()))
        .map(|a| cfg.libraries_dir().join(&a.path).display().to_string())
        .collect();

    parts.push(
        cfg.version_dir(&detail.id)
            .join(format!("{}.jar", detail.id))
            .display()
            .to_string(),
    );
    parts.join(sep)
}

/// Ersetzt die `${...}`-Platzhalter der Mojang-Argumentlisten.
fn substitute(arg: &str, ctx: &LaunchContext) -> String {
    // Manche MC-Versionen wollen einen nicht-leeren Token, auch offline.
    let token = if ctx.account.access_token.is_empty() {
        "0"
    } else {
        &ctx.account.access_token
    };
    arg.replace("${auth_player_name}", &ctx.account.username)
        .replace("${auth_uuid}", &ctx.account.uuid)
        .replace("${auth_access_token}", token)
        .replace("${user_type}", if ctx.account.offline { "legacy" } else { "msa" })
        .replace("${version_name}", &ctx.version_id)
        .replace("${version_type}", "release")
        .replace("${game_directory}", &ctx.game_dir.display().to_string())
        .replace("${assets_root}", &ctx.assets_dir.display().to_string())
        .replace("${assets_index_name}", &ctx.asset_index_id)
        .replace("${classpath}", &ctx.classpath)
        .replace("${natives_directory}", &ctx.natives_dir.display().to_string())
        .replace("${launcher_name}", "nutclient-launcher")
        .replace("${launcher_version}", env!("CARGO_PKG_VERSION"))
        .replace("${clientid}", "")
        .replace("${auth_xuid}", "")
}

pub struct LaunchContext {
    pub account: Account,
    pub version_id: String,
    pub asset_index_id: String,
    pub game_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub natives_dir: PathBuf,
    pub classpath: String,
    pub java_bin: PathBuf,
}

/// Nur die einfachen String-Argumente übernehmen; regelbehaftete
/// Objekt-Argumente werden für die Grundlage übersprungen.
fn plain_args(values: &[serde_json::Value], ctx: &LaunchContext) -> Vec<String> {
    values
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| substitute(s, ctx))
        .collect()
}

/// Zusätze für einen Profil-Start (Fabric): eigener Spielordner, Libraries vor dem Classpath, andere Hauptklasse,
/// zusätzliche JVM- und Spiel-Argumente.
#[derive(Default)]
pub struct LaunchExtras {
    pub game_dir: Option<PathBuf>,
    pub classpath_front: Vec<PathBuf>,
    pub main_class: Option<String>,
    pub jvm: Vec<String>,
    pub game: Vec<String>,
    /// „gruppe:artefakt“ von Minecraft-Bibliotheken, die der Loader in eigener Version mitbringt
    pub classpath_skip: Vec<String>,
}

pub fn build_command(
    cfg: &LauncherConfig,
    detail: &VersionDetail,
    account: &Account,
    java_bin: PathBuf,
) -> Result<Command> {
    build_command_with(cfg, detail, account, java_bin, LaunchExtras::default())
}

pub fn build_command_with(
    cfg: &LauncherConfig,
    detail: &VersionDetail,
    account: &Account,
    java_bin: PathBuf,
    extras: LaunchExtras,
) -> Result<Command> {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut cp: Vec<String> = extras.classpath_front.iter().map(|p| p.display().to_string()).collect();
    cp.push(classpath(cfg, detail, &extras.classpath_skip));
    let game_dir = extras.game_dir.clone().unwrap_or_else(|| cfg.root.clone());
    std::fs::create_dir_all(&game_dir)?;
    let ctx = LaunchContext {
        account: account.clone(),
        version_id: detail.id.clone(),
        asset_index_id: detail.asset_index.id.clone(),
        game_dir,
        assets_dir: cfg.assets_dir(),
        natives_dir: cfg.version_dir(&detail.id).join("natives"),
        classpath: cp.join(sep),
        java_bin,
    };

    // LWJGL 3.3+ entpackt seine Natives selbst hierhin – Verzeichnis muss existieren.
    std::fs::create_dir_all(&ctx.natives_dir)?;

    let mut cmd = Command::new(&ctx.java_bin);
    cmd.current_dir(&ctx.game_dir);

    // JVM-Argumente
    if let Some(args) = &detail.arguments {
        cmd.args(plain_args(&args.jvm, &ctx));
    } else {
        cmd.arg(format!("-Djava.library.path={}", ctx.natives_dir.display()));
        cmd.arg("-cp").arg(&ctx.classpath);
    }

    cmd.args(&extras.jvm);
    cmd.arg(extras.main_class.as_deref().unwrap_or(&detail.main_class));

    // Spiel-Argumente
    if let Some(args) = &detail.arguments {
        cmd.args(plain_args(&args.game, &ctx));
    } else if let Some(legacy) = &detail.legacy_arguments {
        let expanded: Vec<String> =
            legacy.split_whitespace().map(|s| substitute(s, &ctx)).collect();
        cmd.args(expanded);
    }
    cmd.args(&extras.game);

    // Ausgabe in eine Logdatei, damit sich Abstürze nachvollziehen lassen.
    let log_dir = cfg.root.join("logs");
    std::fs::create_dir_all(&log_dir)?;
    let log = std::fs::File::create(log_dir.join("latest-launch.log"))?;
    let log_err = log.try_clone()?;
    cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));

    // Kein schwarzes Konsolenfenster neben dem Spiel (die Ausgabe steht ja im Log).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let _ = current_os(); // Platzhalter: OS-spezifische Natives-Behandlung folgt
    Ok(cmd)
}
