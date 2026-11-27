mod auth;
mod blocks;
mod config;
mod crash;
mod discord_bridge;
mod error;
mod export;
mod instance;
mod java;
#[cfg(target_os = "ios")]
mod ios_java;
mod media;
mod minecraft;
mod skin;
mod sync;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use auth::{AccountView, microsoft};
use config::LauncherConfig;
use error::Result;
use minecraft::manifest::{VersionDetail, VersionManifest};

/// Anwendungsweiter Zustand.
pub struct AppState {
    pub cfg: LauncherConfig,
    pub http: reqwest::Client,
    /// Laufende Profil-Spiele in Startreihenfolge (das erste ist das, was der große Knopf stoppt).
    pub running: std::sync::Mutex<Vec<RunningGame>>,
}

/// Ein laufendes Spiel: Profil-ID und Prozess-ID des Java-Starters.
#[derive(Clone)]
pub struct RunningGame {
    pub profile_id: String,
    pub pid: u32,
    /// Vom Benutzer gestoppt – dann keine Absturzmeldung.
    pub stopping: bool,
}

#[derive(Clone, Serialize)]
struct RunningDto {
    profile_id: String,
    pid: u32,
}

/// Liste der laufenden Spiele an die Oberfläche melden.
fn emit_running(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let list: Vec<RunningDto> = state
        .running
        .lock()
        .map(|l| l.iter().map(|g| RunningDto { profile_id: g.profile_id.clone(), pid: g.pid }).collect())
        .unwrap_or_default();
    let _ = app.emit("launch://running", list);
}

/// Beendet ein Spiel samt Kindprozessen (Java startet u. U. weitere).
fn kill_tree(pid: u32) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).status()?;
    }
    Ok(())
}

#[tauri::command]
fn running_instances(state: State<'_, AppState>) -> Vec<RunningDto> {
    state
        .running
        .lock()
        .map(|l| l.iter().map(|g| RunningDto { profile_id: g.profile_id.clone(), pid: g.pid }).collect())
        .unwrap_or_default()
}

/// Stoppt das laufende Spiel eines Profils.
#[tauri::command]
fn stop_instance(app: tauri::AppHandle, state: State<'_, AppState>, profile_id: String) -> Result<()> {
    let pid = {
        let mut list = state.running.lock().map_err(|_| error::Error::Io(std::io::Error::other("Sperre")))?;
        let Some(g) = list.iter_mut().find(|g| g.profile_id == profile_id) else {
            return Ok(());
        };
        g.stopping = true;
        g.pid
    };
    kill_tree(pid).map_err(error::Error::Io)?;
    emit_running(&app);
    Ok(())
}

#[derive(Clone, Serialize)]
struct LaunchProgress {
    stage: String,
    completed: usize,
    total: usize,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionSummaryDto {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    release_time: String,
}

#[tauri::command]
async fn list_versions(state: State<'_, AppState>) -> Result<Vec<VersionSummaryDto>> {
    let manifest = VersionManifest::fetch(&state.http).await?;
    Ok(manifest
        .versions
        .into_iter()
        .map(|v| VersionSummaryDto {
            id: v.id,
            type_: v.type_,
            release_time: v.release_time,
        })
        .collect())
}

#[tauri::command]
async fn get_skin(state: State<'_, AppState>, uuid: String) -> Result<String> {
    skin::skin_data_url(&state.http, &uuid).await
}

#[tauri::command]
fn local_time() -> String {
    media::local_hm()
}

#[tauri::command]
async fn media_now_playing() -> media::NowPlaying {
    tauri::async_runtime::spawn_blocking(media::now_playing)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn media_control(action: String) -> std::result::Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn discord_call() -> media::DiscordCall {
    tauri::async_runtime::spawn_blocking(media::discord_call)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn focus_discord() {
    media::focus_discord();
}

#[tauri::command]
fn offline_login(state: State<'_, AppState>, username: String) -> Result<AccountView> {
    let acc = auth::offline_account(&state.cfg, &username)?;
    Ok(AccountView::from(&acc))
}

#[tauri::command]
fn current_account(state: State<'_, AppState>) -> Result<Option<AccountView>> {
    Ok(auth::load_account(&state.cfg)?.as_ref().map(AccountView::from))
}

#[tauri::command]
async fn login(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<AccountView> {
    let account = microsoft::login(&state.http, |dc| {
        let _ = app.emit(
            "auth://prompt",
            serde_json::json!({
                "userCode": dc.user_code,
                "verificationUri": dc.verification_uri,
            }),
        );
    })
    .await?;

    auth::save_account(&state.cfg, &account)?;
    Ok(AccountView::from(&account))
}

#[tauri::command]
async fn launch(app: tauri::AppHandle, state: State<'_, AppState>, version_id: String) -> Result<()> {
    let account = auth::require_account(&state.cfg)?;

    let emit = |stage: &str, completed: usize, total: usize, message: &str| {
        let _ = app.emit(
            "launch://progress",
            LaunchProgress {
                stage: stage.to_string(),
                completed,
                total,
                message: message.to_string(),
            },
        );
    };

    emit("manifest", 0, 1, "Manifest laden");
    let manifest = VersionManifest::fetch(&state.http).await?;
    let summary = manifest.find(&version_id)?.clone();
    let detail = VersionDetail::fetch(&state.http, &summary).await?;
    emit("manifest", 1, 1, "Manifest geladen");

    minecraft::install::install_version(&state.http, &state.cfg, &detail, |stage, c, t| {
        emit(stage, c, t, "Herunterladen");
    })
    .await?;

    let major = java::required_major(detail.java_version.as_ref().map(|j| j.major_version));
    let java_bin = java::ensure_java(&state.http, &state.cfg, major, |msg| {
        emit("java", 0, 1, msg);
    })
    .await?;

    emit("launching", 0, 1, "JVM starten");
    let mut cmd = minecraft::launch::build_command(&state.cfg, &detail, &account, java_bin)?;
    let child = cmd.spawn().map_err(error::Error::Io)?;
    emit("running", 1, 1, &format!("Minecraft läuft (PID {})", child.id()));

    Ok(())
}


/// Profil aus dem Frontend: mit NUTclient → Fabric, Mods (NUTclient, Fabric API, Account Switcher) und eigener
/// Spielordner unter `instances/<id>`; die Launcher-Farbe wird für den Client hinterlegt.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProfileLaunch {
    profile_id: String,
    version_id: String,
    nutclient: bool,
    /** Mod-Loader der Instanz („fabric“, „neoforge“, …); fehlt er, gilt Fabric. */
    #[serde(default)]
    loader: Option<String>,
    accent: Option<String>,
    max_ram_mb: Option<u32>,
    /** Client-Fassung: „classic“ = NUTclient Classic, sonst der normale NUTclient (nur wenn `nutclient`). */
    #[serde(default)]
    client_variant: Option<String>,
    /** Gewünschte Loader-Version (leer = neueste stabile). */
    #[serde(default)]
    loader_version: Option<String>,
    /** Eigene Java-Argumente des Profils (durch Leerzeichen getrennt). */
    #[serde(default)]
    jvm_args: Option<String>,
    /** Fenstergröße beim Start (beide gesetzt) und Vollbild. */
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    fullscreen: bool,
    /** Mods der Instanz (Inhalte mit Art „mod“); abgeschaltete bleiben ohne Datei. */
    #[serde(default)]
    mods: Vec<ProfileMod>,
    /** Ressourcenpakete und Shader der Instanz (Modrinth); abgeschaltete bleiben ohne Datei. */
    #[serde(default)]
    packs: Vec<ProfilePack>,
    /** Zusätzliche Spiel-Argumente (Schnell-Neustart aus dem Spiel: --quickPlaySingleplayer &lt;Welt&gt; …). */
    #[serde(default)]
    extra_game: Vec<String>,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProfilePack {
    project_id: String,
    /** „resourcepack“ oder „shader“ */
    kind: String,
    enabled: bool,
}

#[tauri::command]
fn open_instance_folder(state: State<'_, AppState>, profile_id: String, folder: Option<String>) -> Result<()> {
    instance::open(&instance_dir(&state.cfg, &profile_id), folder.as_deref().unwrap_or(""))
}

#[tauri::command]
fn list_instance_files(state: State<'_, AppState>, profile_id: String, folder: String) -> Result<Vec<String>> {
    instance::list(&instance_dir(&state.cfg, &profile_id), &folder)
}

/// Ergebnis von „Datei hineinziehen“: Unterordner, oder – bei einer NeoForge/Forge-Mod – die Fabric-Fassung von
/// Modrinth, die statt der Datei als Inhalt dazukommt (die fremde Datei würde Fabric still ignorieren).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    folder: String,
    replaced_by: Option<ImportTwin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportTwin {
    project_id: String,
    title: String,
    loader: String,
}

#[tauri::command]
async fn import_instance_file(
    state: State<'_, AppState>,
    profile_id: String,
    version_id: Option<String>,
    loader: Option<String>,
    path: String,
) -> Result<ImportResult> {
    let loader = if loader.as_deref() == Some("neoforge") { "neoforge" } else { "fabric" };
    let src = std::path::Path::new(&path);
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.to_lowercase().ends_with(".jar") {
        if let Some(found) = instance::foreign_loader(src, loader) {
            let mc = version_id.unwrap_or_default();
            let want = instance::loader_name(loader);
            if let Some((project_id, title)) = minecraft::profile::loader_twin(&state.http, src, &mc, loader).await {
                return Ok(ImportResult {
                    folder: instance::MODS.into(),
                    replaced_by: Some(ImportTwin { project_id, title, loader: found.into() }),
                });
            }
            return Err(error::Error::Other(format!(
                "„{name}“ ist eine {found}-Mod und läuft nicht mit {want} – eine {want}-Fassung für {mc} gibt es auf Modrinth nicht"
            )));
        }
    }
    let folder = instance::import(&instance_dir(&state.cfg, &profile_id), src)?;
    Ok(ImportResult { folder, replaced_by: None })
}

/// Loader-Versionen für eine Minecraft-Version (neueste zuerst; Fabric: [Version, stabil]).
#[tauri::command]
async fn loader_versions(state: State<'_, AppState>, mc: String, loader: String) -> Result<Vec<(String, bool)>> {
    if loader == "neoforge" {
        let all = minecraft::neoforge::versions(&state.http, &mc).await?;
        return Ok(all.into_iter().map(|v| { let s = !v.contains('-'); (v, s) }).collect());
    }
    minecraft::profile::fabric_versions(&state.http, &mc).await
}

/// Instanz als Modrinth-Modpack (.mrpack) in den Downloads-Ordner exportieren; gibt den Pfad zurück.
#[tauri::command]
async fn export_mrpack(
    state: State<'_, AppState>,
    profile_id: String,
    name: String,
    mc: String,
    loader: String,
    loader_version: Option<String>,
) -> Result<String> {
    let dir = instance_dir(&state.cfg, &profile_id);
    let path = export::mrpack(&state.http, &dir, &name, &mc, &loader, loader_version.as_deref()).await?;
    Ok(path.display().to_string())
}

/// Geteilte Ordner einer Instanz (saves, screenshots, …): welche gerade mit anderen Profilen geteilt sind.
#[tauri::command]
fn shared_folders(state: State<'_, AppState>, profile_id: String) -> Vec<String> {
    instance::shared(&instance_dir(&state.cfg, &profile_id))
}

/// Ordner mit anderen Profilen teilen (Verknüpfung auf <daten>/shared/<ordner>) oder wieder eigen machen.
#[tauri::command]
fn set_shared_folder(state: State<'_, AppState>, profile_id: String, folder: String, share: bool) -> Result<()> {
    instance::set_shared(&state.cfg.root.join("shared"), &instance_dir(&state.cfg, &profile_id), &folder, share)
}

/// Eigene Mods der Instanz (z. B. aus einem Modpack) mit Name/Version aus der Jar, an/aus und Loader-Prüfung.
#[tauri::command]
async fn list_instance_mods(state: State<'_, AppState>, profile_id: String, loader: Option<String>) -> Result<Vec<instance::ModInfo>> {
    let loader = if loader.as_deref() == Some("neoforge") { "neoforge" } else { "fabric" };
    let dir = instance_dir(&state.cfg, &profile_id);
    tokio::task::spawn_blocking(move || instance::mod_infos(&dir, loader))
        .await
        .map_err(|e| error::Error::Other(e.to_string()))
}

/// Eigene Datei an-/ausschalten (`.disabled`); gibt den neuen Dateinamen zurück.
#[tauri::command]
fn set_instance_file_enabled(state: State<'_, AppState>, profile_id: String, folder: String, name: String, enabled: bool) -> Result<String> {
    instance::set_enabled(&instance_dir(&state.cfg, &profile_id), &folder, &name, enabled)
}

/// Eigene Mods der Instanz, die nicht für Fabric gebaut sind (Dateiname, Loader) – laufen im Spiel nicht.
#[tauri::command]
fn foreign_instance_mods(state: State<'_, AppState>, profile_id: String, loader: Option<String>) -> Vec<(String, String)> {
    let loader = if loader.as_deref() == Some("neoforge") { "neoforge" } else { "fabric" };
    instance::foreign_mods(&instance_dir(&state.cfg, &profile_id), loader)
}

/// Inhalt sofort beim Hinzufügen laden (nicht erst beim Start): Shader/Ressourcenpakete erscheinen so gleich in der
/// Auswahl im Spiel (auch wenn es schon läuft), Mods samt Pflicht-Abhängigkeiten liegen bereit.
#[tauri::command]
async fn install_content(
    state: State<'_, AppState>,
    profile_id: String,
    version_id: String,
    project_id: String,
    kind: String,
    loader: Option<String>,
) -> Result<()> {
    let loader = if loader.as_deref() == Some("neoforge") { "neoforge" } else { "fabric" };
    use minecraft::profile;
    let game_dir = instance_dir(&state.cfg, &profile_id);
    match kind.as_str() {
        "resourcepack" | "shader" => {
            let folder = if kind == "shader" { instance::SHADERPACKS } else { instance::RESOURCEPACKS };
            profile::install_modrinth_pack(&state.http, &project_id, &version_id, &game_dir.join(folder)).await?;
        }
        "mod" => {
            let mods = game_dir.join(instance::MODS);
            let mut queue = vec![project_id];
            let mut done: Vec<String> = Vec::new();
            let mut first = true;
            while let Some(id) = queue.pop() {
                if done.contains(&id) || done.len() > 40 {
                    continue;
                }
                match profile::install_modrinth_mod(&state.http, &id, &version_id, loader, &mods, &done).await {
                    Ok((pid, deps)) => {
                        done.push(pid);
                        queue.extend(deps);
                    }
                    // nur die Mod selbst muss klappen; Abhängigkeiten holt sonst der Start nach
                    Err(e) if first => return Err(e),
                    Err(_) => {}
                }
                first = false;
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
fn remove_instance_file(state: State<'_, AppState>, profile_id: String, folder: String, name: String) -> Result<()> {
    instance::remove(&instance_dir(&state.cfg, &profile_id), &folder, &name)
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProfileMod {
    project_id: String,
    enabled: bool,
}

/// Block-Texturen (16×16) aus der installierten Minecraft-Jar – für Profilbilder.
#[tauri::command]
async fn block_textures(state: State<'_, AppState>) -> Result<Vec<blocks::BlockTexture>> {
    blocks::list(&state.cfg)
}

#[tauri::command]
async fn launch_profile(app: tauri::AppHandle, state: State<'_, AppState>, profile: ProfileLaunch) -> Result<()> {
    let emit = |stage: &str, completed: usize, total: usize, message: &str| {
        let _ = app.emit(
            "launch://progress",
            LaunchProgress {
                stage: stage.to_string(),
                completed,
                total,
                message: message.to_string(),
            },
        );
    };
    let game_dir = instance_dir(&state.cfg, &profile.profile_id);
    // iPhone: Minecraft läuft im App-Prozess (keine fremden Prozesse erlaubt)
    #[cfg(target_os = "ios")]
    {
        let (cmd, major) = prepare_profile(&state.cfg, &state.http, app.path().resource_dir().ok(), profile.clone(), &emit).await?;
        ios_java::launch_game(&cmd, &game_dir, major).map_err(error::Error::Other)?;
        emit("running", 1, 1, "Minecraft startet");
        let _ = app.emit("ios://game", true);
        return Ok(());
    }
    #[allow(unreachable_code)]
    let started = std::time::SystemTime::now();
    let profile_id = profile.profile_id.clone();
    let again = profile.clone();                  // für den Schnell-Neustart aus dem Spiel
    let child = run_profile(&state.cfg, &state.http, app.path().resource_dir().ok(), profile, emit).await?;
    let pid = child.id();
    if let Ok(mut list) = state.running.lock() {
        list.retain(|g| g.profile_id != profile_id);
        list.push(RunningGame { profile_id, pid, stopping: false });
    }
    emit_running(&app);
    // Ladefehler der Mods erkennen, solange das Spiel startet (NeoForge bleibt dann im Fehlerbildschirm stehen)
    {
        let app = app.clone();
        let game_dir = game_dir.clone();
        std::thread::spawn(move || {
            for _ in 0..120 {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let alive = app.state::<AppState>().running.lock().map(|l| l.iter().any(|g| g.pid == pid)).unwrap_or(false);
                if !alive {
                    return;
                }
                if let Some(report) = crash::loading_error(&game_dir, started) {
                    let _ = app.emit("launch://crash", report);
                    return;
                }
                let log = game_dir.join("logs").join("latest.log");
                let menu = std::fs::read_to_string(&log)
                    .map(|t| t.contains("Sound engine started") && !t.contains("Failed to wait for future"))
                    .unwrap_or(false);
                let fresh = std::fs::metadata(&log).and_then(|m| m.modified()).map(|m| m >= started).unwrap_or(false);
                if menu && fresh {
                    // erst nach dem Laden der Ressourcen ist sicher, dass nichts mehr kommt
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if let Some(report) = crash::loading_error(&game_dir, started) {
                        let _ = app.emit("launch://crash", report);
                    }
                    return;
                }
            }
        });
    }
    // Auf das Spielende warten: Eintrag entfernen; bei einem Absturz die Ursache erkennen und melden
    let app = app.clone();
    std::thread::spawn(move || {
        let mut child = child;
        let mut pid = pid;
        let mut started = started;
        loop {
            let status = child.wait();
            let code = status.as_ref().ok().and_then(|s| s.code());
            let ok = status.map(|s| s.success()).unwrap_or(false);
            let stopped = {
                let state = app.state::<AppState>();
                let mut list = state.running.lock().unwrap_or_else(|e| e.into_inner());
                let stopped = list.iter().find(|g| g.pid == pid).map(|g| g.stopping).unwrap_or(false);
                list.retain(|g| g.pid != pid);
                stopped
            };
            emit_running(&app);
            if stopped {
                return;
            }
            // Schnell-Neustart aus dem Mod-Browser: Rückgabewert 77 + nutclient-restart.txt (wohin es danach geht)
            let restart = game_dir.join("nutclient-restart.txt");
            if code == Some(77) && restart.exists() {
                let args: Vec<String> = std::fs::read_to_string(&restart)
                    .unwrap_or_default()
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                let _ = std::fs::remove_file(&restart);
                let mut p = again.clone();
                p.extra_game = args;
                let state = app.state::<AppState>();
                let res = tauri::async_runtime::block_on(run_profile(
                    &state.cfg,
                    &state.http,
                    app.path().resource_dir().ok(),
                    p,
                    |_: &str, _: usize, _: usize, _: &str| {},
                ));
                match res {
                    Ok(c) => {
                        pid = c.id();
                        child = c;
                        started = std::time::SystemTime::now();
                        if let Ok(mut list) = state.running.lock() {
                            list.push(RunningGame { profile_id: again.profile_id.clone(), pid, stopping: false });
                        }
                        emit_running(&app);
                        continue;
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "launch://progress",
                            LaunchProgress {
                                stage: "error".into(),
                                completed: 0,
                                total: 1,
                                message: format!("Neustart fehlgeschlagen: {e}"),
                            },
                        );
                        return;
                    }
                }
            }
            if let Some(report) = crash::check(&game_dir, ok, started) {
                let _ = app.emit("launch://crash", report);
            }
            return;
        }
    });
    Ok(())
}

/// Modrinth-Modpack in die Instanz installieren; Fortschritt als Ereignis „modpack://progress“.
#[tauri::command]
async fn install_modpack(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    project_id: String,
) -> Result<minecraft::modpack::Installed> {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Progress<'a> {
        profile_id: &'a str,
        done: usize,
        total: usize,
        message: &'a str,
    }
    let dir = instance_dir(&state.cfg, &profile_id);
    std::fs::create_dir_all(&dir)?;
    minecraft::modpack::install(&state.http, &project_id, &dir, |done, total, message| {
        let _ = app.emit("modpack://progress", Progress { profile_id: &profile_id, done, total, message });
    })
    .await
}

/// Modpack aus einer Datei (.mrpack oder CurseForge-.zip) in die Instanz installieren; Fortschritt wie oben.
#[tauri::command]
async fn install_modpack_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    path: String,
) -> Result<minecraft::modpack::Installed> {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Progress<'a> {
        profile_id: &'a str,
        done: usize,
        total: usize,
        message: &'a str,
    }
    let dir = instance_dir(&state.cfg, &profile_id);
    std::fs::create_dir_all(&dir)?;
    minecraft::modpack::install_file(&state.http, std::path::Path::new(&path), &dir, |done, total, message| {
        let _ = app.emit("modpack://progress", Progress { profile_id: &profile_id, done, total, message });
    })
    .await
}

/// Spielordner eines Profils: `instances/<id>` (Sonderzeichen werden zu `_`).
/// Dieses Gerät (Name, System) für die Übertragung zwischen Geräten.
#[tauri::command]
fn sync_device(sync: State<'_, sync::Sync>) -> sync::Device {
    sync.device()
}

/// Gerätesuche im WLAN starten bzw. ausgeblendete Geräte setzen; `retry` fragt schon gefragte noch einmal.
#[tauri::command]
fn sync_start(app: tauri::AppHandle, sync: State<'_, sync::Sync>, hidden: Vec<String>, retry: bool) {
    sync.start(app, hidden, retry);
}

/// Antwort auf „Daten übertragen?“ (mit den Launcher-Daten dieses Geräts).
#[tauri::command]
fn sync_answer(sync: State<'_, sync::Sync>, peer_id: String, yes: bool, storage: String) {
    sync.answer(&peer_id, sync::Answer { yes, storage });
}

fn instance_dir(cfg: &LauncherConfig, profile_id: &str) -> std::path::PathBuf {
    let safe_id: String = profile_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    cfg.root.join("instances").join(safe_id)
}

/// Ein Profil installieren und starten (vom Play-Knopf und vom Selbsttest). Gibt die Prozess-ID zurück.
async fn run_profile(
    cfg: &LauncherConfig,
    http: &reqwest::Client,
    resource_dir: Option<std::path::PathBuf>,
    profile: ProfileLaunch,
    emit: impl Fn(&str, usize, usize, &str),
) -> Result<std::process::Child> {
    let (mut cmd, _) = prepare_profile(cfg, http, resource_dir, profile, &emit).await?;
    let child = cmd.spawn().map_err(error::Error::Io)?;
    emit("running", 1, 1, &format!("Minecraft läuft (PID {})", child.id()));
    Ok(child)
}

/// Alles vorbereiten (Downloads, Mods, Java) und den Startbefehl bauen – ohne ihn auszuführen.
/// Gibt den Befehl und die nötige Java-Hauptversion zurück (iPhone: der Befehl wird in der App ausgeführt).
async fn prepare_profile<E: Fn(&str, usize, usize, &str)>(
    cfg: &LauncherConfig,
    http: &reqwest::Client,
    resource_dir: Option<std::path::PathBuf>,
    profile: ProfileLaunch,
    emit: &E,
) -> Result<(std::process::Command, u32)> {
    use minecraft::launch::{build_command_with, LaunchExtras};
    use minecraft::profile;

    let account = auth::require_account(cfg)?;

    emit("manifest", 0, 1, "Manifest laden");
    let manifest = VersionManifest::fetch(http).await?;
    let summary = manifest.find(&profile.version_id)?.clone();
    let detail = VersionDetail::fetch(http, &summary).await?;
    emit("manifest", 1, 1, "Manifest geladen");

    minecraft::install::install_version(http, cfg, &detail, |stage, c, t| {
        emit(stage, c, t, "Herunterladen");
    })
    .await?;

    let major = java::required_major(detail.java_version.as_ref().map(|j| j.major_version));
    // iPhone: Java steckt in der App (ios_java.rs), es wird nichts heruntergeladen
    #[cfg(target_os = "ios")]
    let java_bin = std::path::PathBuf::from("java");
    #[cfg(not(target_os = "ios"))]
    let java_bin = java::ensure_java(http, cfg, major, |msg| {
        emit("java", 0, 1, msg);
    })
    .await?;

    // NeoForge-Instanzen starten mit NeoForge (Mods in der NeoForge-Fassung), alles andere mit Fabric
    let neo = profile.loader.as_deref() == Some("neoforge");
    if profile.loader.as_deref() == Some("forge") {
        return Err(error::Error::Other(
            "Forge wird nicht unterstützt – in den Instanz-Einstellungen NeoForge oder Fabric wählen".into(),
        ));
    }
    let loader = if neo { "neoforge" } else { "fabric" };
    let loader_name = if neo { "NeoForge" } else { "Fabric" };
    let nutclient = profile.nutclient && !neo;
    if profile.nutclient && neo {
        emit("warn", 0, 1, "NUTclient gibt es nur mit Fabric – diese Instanz startet ohne NUTclient");
    }

    let game_dir = instance_dir(cfg, &profile.profile_id);
    let mut extras = LaunchExtras {
        game_dir: Some(game_dir.clone()),
        ..Default::default()
    };

    let mut wanted: Vec<String> = profile.mods.iter().filter(|m| m.enabled).map(|m| m.project_id.clone()).collect();
    // Shader brauchen Iris (und Sodium) – sonst bleiben sie im Spiel unsichtbar
    let shaders = profile.packs.iter().any(|p| p.enabled && p.kind == "shader");
    if shaders {
        for m in ["iris", "sodium"] {
            if !wanted.iter().any(|w| w == m) {
                wanted.push(m.to_string());
            }
        }
    }
    // auch hineingezogene .jar-Mods brauchen den Loader – sonst startet Vanilla und sie liegen ungenutzt da
    let loader_needed = neo || nutclient || !wanted.is_empty() || instance::has_own_mods(&game_dir);
    if loader_needed && neo {
        emit("fabric", 0, 1, "NeoForge vorbereiten");
        let n = minecraft::neoforge::prepare(http, cfg, &detail.id, &java_bin, profile.loader_version.as_deref(), |m| emit("fabric", 0, 1, m)).await?;
        extras.classpath_front = n.classpath;
        extras.classpath_skip = n.replaces;
        extras.main_class = Some(n.main_class);
        extras.jvm = n.jvm;
        extras.game = n.game;
        emit("fabric", 1, 1, "NeoForge bereit");
    } else if loader_needed {
        emit("fabric", 0, 1, "Fabric installieren");
        let fabric = profile::fabric_profile(http, &detail.id, profile.loader_version.as_deref()).await?;
        extras.classpath_front = profile::install_fabric(http, cfg, &fabric).await?;
        extras.main_class = Some(fabric.main_class.clone());
        if let Some(args) = &fabric.arguments {
            extras.jvm = args.jvm.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            extras.game = args.game.iter().filter_map(|v| v.as_str().map(String::from)).collect();
        }
        emit("fabric", 1, 1, "Fabric bereit");
    }
    if loader_needed {
        let mods = game_dir.join("mods");
        if nutclient {
            let classic = profile.client_variant.as_deref() == Some("classic");
            let jar = if classic {
                profile::find_classic_jar(resource_dir.clone(), &detail.id).ok_or_else(|| {
                    error::Error::Other(format!(
                        "NUTclient Classic gibt es für Minecraft {} noch nicht – in den Profil-Einstellungen „NUTclient“ wählen",
                        detail.id
                    ))
                })?
            } else {
                profile::find_nutclient_jar(resource_dir.clone(), &detail.id).ok_or_else(|| {
                    error::Error::Other(format!("NUTclient für Minecraft {} ist nicht im Launcher enthalten", detail.id))
                })?
            };
            profile::install_nutclient(&jar, &mods)?;
            emit("mods", 1, 1, if classic { "NUTclient Classic installiert" } else { "NUTclient installiert" });
        }
        // Mods der Instanz plus Pflicht-Abhängigkeiten (Abhängigkeiten in einer zur Mod passenden Fassung)
        let mut top: Vec<String> = Vec::new();
        if nutclient {
            top.extend(profile::AUTO_MODS.iter().map(|s| s.to_string()));
        }
        top.extend(wanted.iter().cloned());
        // Mods, die die Instanz schon selbst mitbringt (Modpack), nicht noch einmal dazulegen
        let doppelt_file = game_dir.join(".nutclient-doppelt");
        let mut doppelt: Vec<String> = std::fs::read_to_string(&doppelt_file)
            .map(|t| t.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
            .unwrap_or_default();
        top.retain(|t| !doppelt.contains(t));
        emit("mods", 0, 1, "Mods auflösen");
        let res = profile::resolve_mods(http, &top, &detail.id, loader).await;
        let total = res.picks.len();
        let mut keep: Vec<String> = Vec::new();
        for (i, pick) in res.picks.iter().enumerate() {
            match profile::download_pick(http, pick, &mods).await {
                Ok(()) => keep.push(pick.project_id.clone()),
                Err(e) => {
                    // vorhandene Datei bleibt, wenn der Download gerade nicht klappt
                    emit("mods", i + 1, total, &format!("{}: {e}", pick.project_id));
                    keep.push(pick.project_id.clone());
                }
            }
            emit("mods", i + 1, total, &pick.project_id);
        }
        // Netzwerkfehler: alte Datei behalten; gibt es keine Fassung für diesen Loader, fliegt die alte (falsche) raus
        keep.extend(res.errors.iter().cloned());
        // zwei Fassungen derselben Mod (eigene aus dem Modpack + vom Launcher) → Fabric startet nicht: Launcher-Fassung weg
        let own = instance::own_mod_ids(&game_dir);
        if !own.is_empty() {
            let mut found = Vec::new();
            for pid in &keep {
                let prefix = format!("{pid}--");
                let file = std::fs::read_dir(&mods).ok().and_then(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .find(|p| p.file_name().map(|n| n.to_string_lossy().starts_with(&prefix)).unwrap_or(false))
                });
                if let Some(id) = file.as_deref().and_then(instance::mod_id) {
                    if own.contains(&id) {
                        found.push(pid.clone());
                    }
                }
            }
            if !found.is_empty() {
                keep.retain(|k| !found.contains(k));
                doppelt.extend(found);
                doppelt.sort();
                doppelt.dedup();
                let _ = std::fs::write(&doppelt_file, doppelt.join("\n"));
            }
        }
        let failed = res.missing.clone();
        profile::remove_unwanted(&mods, &keep)?;
        if neo {
            // Korrekturen für Fehler anderer Mods (z. B. Weather2 im LAN), nur wenn eine betroffene Mod drin ist
            profile::sync_neo_fixes(resource_dir.clone(), &mods, &detail.id);
        }
        if !failed.is_empty() {
            emit("warn", 0, 1, &format!("Nicht geladen (keine {loader_name}-Fassung für {}): {}", detail.id, failed.join(", ")));
        }
        // hineingezogene Mods für einen anderen Loader werden still übergangen – sagen, statt dass sie einfach fehlen
        let foreign = instance::foreign_mods(&game_dir, loader);
        if !foreign.is_empty() {
            let list: Vec<String> = foreign.iter().map(|(n, l)| format!("{n} ({l})")).collect();
            emit("warn", 0, 1, &format!("Läuft nicht mit {loader_name}: {}", list.join(", ")));
        }
        if let Some(accent) = &profile.accent {
            profile::write_launcher_color(&game_dir, accent)?;
        }
    }

    // Ressourcenpakete und Shader der Instanz (je Ordner; nicht mehr gewünschte verwaltete Dateien fliegen raus)
    for (kind, folder) in [("resourcepack", instance::RESOURCEPACKS), ("shader", instance::SHADERPACKS)] {
        let dir = game_dir.join(folder);
        let mut keep: Vec<String> = Vec::new();
        for p in profile.packs.iter().filter(|p| p.kind == kind && p.enabled) {
            match profile::install_modrinth_pack(http, &p.project_id, &detail.id, &dir).await {
                Ok(pid) => keep.push(pid),
                Err(e) => {
                    emit("mods", 0, 1, &format!("{}: {e}", p.project_id));
                    keep.push(p.project_id.clone());
                }
            }
        }
        // geteilter Ordner: dort liegen auch Downloads anderer Profile – nichts wegräumen
        if !instance::is_link(&dir) {
            profile::remove_unwanted(&dir, &keep)?;
        }
    }

    // RAM-Einstellung aus dem Launcher: ohne -Xmx nimmt die JVM ihren Standard (ein Viertel des RAMs).
    if let Some(ram) = profile.max_ram_mb {
        extras.jvm.push(format!("-Xmx{ram}M"));
    }
    // Profil-Einstellungen: eigene Java-Argumente, Fenstergröße, Vollbild
    if let Some(args) = profile.jvm_args.as_deref() {
        extras.jvm.extend(args.split_whitespace().filter(|a| a.starts_with('-')).map(String::from));
    }
    if let (Some(w), Some(h)) = (profile.width, profile.height) {
        if w >= 320 && h >= 240 {
            extras.game.extend(["--width".into(), w.to_string(), "--height".into(), h.to_string()]);
        }
    }
    // Schnell-Neustart (Mod-Browser): direkt zurück in die Welt bzw. auf den Server
    extras.game.extend(profile.extra_game.iter().cloned());
    // Kennung für den Client: der Launcher kann ihn neu starten (Rückgabewert 77)
    extras.jvm.push("-Dnutclient.launcher=1".into());
    // Mod-Browser: Mods live einhängen braucht die JetBrains Runtime (erweiterte Klassen-Neudefinition) und den Agenten;
    // klappt der Download nicht, bleibt das normale JRE (Mods dann per Schnell-Neustart)
    let mut java_bin = java_bin;
    #[cfg(not(target_os = "ios"))]
    if nutclient && major == 25 {
        if let Some(agent) = resource_dir.as_ref().map(|d| d.join("nutagent.jar")).filter(|p| p.exists()) {
            if let Some(jbr) = java::ensure_jbr(http, cfg, major, |m| emit("java", 0, 1, m)).await {
                java_bin = jbr;
                extras.jvm.push("-XX:+AllowEnhancedClassRedefinition".into());
                // Tauri liefert den Ressourcen-Ordner unter Windows als „\\?\C:\…“; damit kann die JVM den Agenten nicht in
                // den Klassenpfad hängen und bricht sofort ab („appending to system class path failed“) → normale Schreibweise
                let shown = agent.display().to_string();
                let plain = shown.strip_prefix(r"\\?\").unwrap_or(&shown);
                extras.jvm.push(format!("-javaagent:{plain}"));
            }
        }
    }
    if profile.fullscreen {
        extras.game.push("--fullscreen".into());
    }

    emit("launching", 0, 1, "JVM starten");
    let cmd = build_command_with(cfg, &detail, &account, java_bin, extras)?;
    Ok((cmd, major))
}


/// Selbsttest ohne Fenster: `nutclient-launcher.exe --selftest <version>` installiert ein NUTclient-Profil
/// („selftest-<version>“) genau wie der Play-Knopf, startet Minecraft und schreibt den Verlauf nach
/// `<daten>/logs/selftest.log`. Ohne Konto wird ein Offline-Konto „NutTester“ angelegt.
/// Mit „modpack <modrinth-id>“ (statt Version egal): Modpack in „selftest-modpack“ installieren und starten.
/// Mit zweitem Argument „neoforge“ ein NeoForge-Profil ohne NUTclient („selftest-<version>-neoforge“).
/// Drittes Argument: Modrinth-IDs der Mods, durch Komma getrennt.
fn selftest(version: &str, loader: Option<&str>, mods: Option<&str>) {
    let neo = loader == Some("neoforge");
    let cfg = LauncherConfig::load();
    cfg.ensure_dirs().ok();
    let log_dir = cfg.root.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let log = std::sync::Mutex::new(std::fs::File::create(log_dir.join("selftest.log")).ok());
    let write = |line: String| {
        use std::io::Write;
        if let Ok(mut f) = log.lock() {
            if let Some(f) = f.as_mut() {
                let _ = writeln!(f, "{line}");
            }
        }
    };
    if auth::require_account(&cfg).is_err() {
        if let Ok(acc) = auth::offline_account(&cfg, "NutTester") {
            let _ = auth::save_account(&cfg, &acc);
        }
    }
    let http = reqwest::Client::builder().user_agent("nutclient-launcher/0.1").build().expect("HTTP-Client");
    let resource_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if loader == Some("share") {
        // Test: Ordner <version> der Instanz <mods> teilen und wieder lösen
        let dir = instance_dir(&cfg, mods.unwrap_or("selftest-modpack"));
        let root = cfg.root.join("shared-test");
        let a = instance::set_shared(&root, &dir, version, true);
        write(format!("SHARE an: {a:?} geteilt={:?}", instance::shared(&dir)));
        let b = instance::set_shared(&root, &dir, version, false);
        write(format!("SHARE aus: {b:?} geteilt={:?}", instance::shared(&dir)));
        return;
    }
    if loader == Some("export") {
        // Test: Instanz <mods> als .mrpack exportieren (Ordner per NUT_EXPORT_DIR)
        let id = mods.unwrap_or("selftest-modpack");
        let rt = tokio::runtime::Runtime::new().expect("Tokio");
        let r = rt.block_on(export::mrpack(&http, &instance_dir(&cfg, id), "Export-Test", version, "fabric", None));
        write(format!("EXPORT: {r:?}"));
        return;
    }
    if loader == Some("modpack") {
        let id = mods.unwrap_or("fabulously-optimized");
        let dir = instance_dir(&cfg, "selftest-modpack");
        let rt = tokio::runtime::Runtime::new().expect("Tokio");
        let last = std::sync::Mutex::new(0usize);
        let log_step = |d: usize, t: usize, m: &str| {
            let mut l = last.lock().unwrap();
            if d == t || d >= *l + 10 || d == 0 {
                *l = d;
                write(format!("[modpack] {d}/{t} {m}"));
            }
        };
        // Datei (.mrpack/.zip) oder Modrinth-Projekt
        let res = if id.ends_with(".zip") || id.ends_with(".mrpack") {
            rt.block_on(minecraft::modpack::install_file(&http, std::path::Path::new(id), &dir, log_step))
        } else {
            rt.block_on(minecraft::modpack::install(&http, id, &dir, log_step))
        };
        let res = match res {
            Ok(r) => r,
            Err(e) => return write(format!("FEHLER Modpack: {e}")),
        };
        write(format!("Modpack installiert: {res:?}"));
        if std::env::var_os("NUT_NO_LAUNCH").is_some() {
            return;
        }
        let nut = res.loader == "fabric" && ["26.3", "26.2", "1.21.11"].contains(&res.mc.as_str());
        let profile = ProfileLaunch {
            profile_id: "selftest-modpack".into(),
            version_id: res.mc.clone(),
            nutclient: nut,
            loader: Some(res.loader.clone()),
            accent: Some("#f2882f".into()),
            max_ram_mb: Some(4096),
            client_variant: None,
            loader_version: None,
            jvm_args: None,
            width: None,
            height: None,
            fullscreen: false,
            mods: Vec::new(),
            packs: Vec::new(),
            extra_game: Vec::new(),
        };
        let result = rt.block_on(run_profile(&cfg, &http, resource_dir, profile, |stage, c, t, msg| {
            write(format!("[{stage}] {c}/{t} {msg}"));
        }));
        match result {
            Ok(mut child) => {
                write(format!("OK – Minecraft gestartet (PID {})", child.id()));
                let status = child.wait();
                write(format!("Minecraft beendet: {status:?}"));
            }
            Err(e) => write(format!("FEHLER: {e}")),
        }
        return;
    }
    let profile = ProfileLaunch {
        profile_id: if neo { format!("selftest-{version}-neoforge") } else { format!("selftest-{version}") },
        version_id: version.to_string(),
        nutclient: !neo,
        loader: loader.map(String::from),
        accent: Some("#f2882f".into()),
        max_ram_mb: Some(4096),
        client_variant: None,
            loader_version: None,
            jvm_args: None,
        width: None,
        height: None,
        fullscreen: false,
        mods: mods
            .unwrap_or("")
            .split(',')
            .filter(|m| !m.is_empty())
            .map(|m| ProfileMod { project_id: m.to_string(), enabled: true })
            .collect(),
        packs: Vec::new(),
        extra_game: Vec::new(),
    };
    let rt = tokio::runtime::Runtime::new().expect("Tokio");
    let result = rt.block_on(run_profile(&cfg, &http, resource_dir, profile, |stage, c, t, msg| {
        write(format!("[{stage}] {c}/{t} {msg}"));
    }));
    match result {
        Ok(mut child) => {
            write(format!("OK – Minecraft gestartet (PID {})", child.id()));
            let status = child.wait();
            write(format!("Minecraft beendet: {status:?}"));
        }
        Err(e) => write(format!("FEHLER: {e}")),
    }
}

/// iPhone: Eingabe der Touch-Steuerung ans Spiel (Art, a, b, c, d – siehe ios-native/nutgl/glfw.m nut_input).
#[tauri::command]
fn ios_input(kind: i32, a: f64, b: f64, c: i32, d: i32) {
    #[cfg(target_os = "ios")]
    ios_java::input(kind, a, b, c, d);
    #[cfg(not(target_os = "ios"))]
    let _ = (kind, a, b, c, d);
}

#[derive(Serialize)]
struct IosGameState {
    running: bool,
    window: bool,
    grabbed: bool,
    island: Option<String>,
}

/// iPhone: Spielzustand für die Touch-Steuerung und die Dynamic Island.
#[tauri::command]
fn ios_game_state() -> IosGameState {
    #[cfg(target_os = "ios")]
    {
        let (grabbed, window) = ios_java::state();
        return IosGameState { running: ios_java::game_running(), window, grabbed, island: ios_java::island() };
    }
    #[allow(unreachable_code)]
    IosGameState { running: false, window: false, grabbed: false, island: None }
}

/// iPhone: Java in der App starten und Werte zurückgeben (Meilenstein 1). Am PC gibt es das nicht.
#[tauri::command]
async fn java_selftest() -> std::result::Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        return tauri::async_runtime::spawn_blocking(ios_java::selftest).await.map_err(|e| e.to_string())?;
    }
    #[allow(unreachable_code)]
    Err("Nur in der iPhone-App".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // iPhone: Absturzmeldung in eine Datei (Library/Caches/nutclient-panic.txt) – dort gibt es keine Konsole
    #[cfg(target_os = "ios")]
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}
{}", std::backtrace::Backtrace::force_capture());
        if let Some(home) = dirs::home_dir() {
            use std::io::Write;
            // anhängen: die erste Meldung ist die wichtige (danach folgt oft „panic in a function that cannot unwind“)
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true)
                .open(home.join("Library/Caches/nutclient-panic.txt"))
            {
                let _ = writeln!(f, "==== {msg}");
            }
        }
        eprintln!("{msg}");
    }));
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        selftest(
            args.get(i + 1).map(String::as_str).unwrap_or("1.21.11"),
            args.get(i + 2).map(String::as_str),
            args.get(i + 3).map(String::as_str),
        );
        return;
    }
    let builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    // Auto-Update + Neustart nur am PC (auf dem iPhone kommt die App über SideStore)
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .setup(|app| {
            // Eigene Titelleiste im Frontend -> native Fensterdekoration aus.
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
                // Windows 11 zeichnet um randlose Fenster sonst einen Rand in der
                // System-Akzentfarbe – hier eine ruhige, dünne helle Linie.
                #[cfg(windows)]
                if let Ok(hwnd) = win.hwnd() {
                    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
                    let color: u32 = 0x00E6_E6E6; // COLORREF 0x00BBGGRR – helles Grau ≈ weiße Linie
                    let hwnd = windows::Win32::Foundation::HWND(hwnd.0 as *mut _);
                    unsafe {
                        let _ = DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_BORDER_COLOR,
                            &color as *const u32 as *const _,
                            4,
                        );
                    }
                }
            }
            #[cfg(target_os = "ios")]
            if let Some(i) = std::env::args().position(|a| a == "--mc-test") {
                let nut = std::env::args().nth(i + 1).as_deref() == Some("nutclient");
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Oberfläche kurz laden lassen
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    let state = handle.state::<AppState>();
                    if auth::require_account(&state.cfg).is_err() {
                        if let Ok(acc) = auth::offline_account(&state.cfg, "NutTester") {
                            let _ = auth::save_account(&state.cfg, &acc);
                        }
                    }
                    let profile = ProfileLaunch {
                        profile_id: if nut { "ios-test-nut".into() } else { "ios-test".into() },
                        version_id: "1.21.11".into(),
                        nutclient: nut,
                        loader: Some("fabric".into()),
                        accent: Some("#f2882f".into()),
                        max_ram_mb: Some(2048),
                        client_variant: None,
                        loader_version: None,
                        jvm_args: None,
                        width: None,
                        height: None,
                        fullscreen: false,
                        mods: Vec::new(),
                        packs: Vec::new(),
                        extra_game: Vec::new(),
                    };
                    // Test: Willkommens-/Sprecher-Frage beim ersten Start überspringen → direkt ins Hauptmenü
                    {
                        let dir = instance_dir(&state.cfg, &profile.profile_id);
                        let opts = dir.join("options.txt");
                        if !opts.exists() {
                            let _ = std::fs::create_dir_all(&dir);
                            let _ = std::fs::write(&opts, "onboardAccessibility:false\nnarrator:0\n");
                        }
                    }
                    let h2 = handle.clone();
                    // Test: nutgl speichert einige Bilder direkt aus dem Grafikspeicher (Library/Caches/gl-frame-N.ppm)
                    std::env::set_var("NUT_FRAME_DUMPS", "1");
                    // Test: alle 40 s festhalten, was die Java-Threads tun (zeigt, wo das Spiel hängt)
                    std::thread::spawn(|| {
                        let Some(home) = dirs::home_dir() else { return };
                        for n in 1..=12 {
                            std::thread::sleep(std::time::Duration::from_secs(40));
                            if ios_java::game_running() {
                                let path = home.join(format!("Library/Caches/java-threads-{n}.txt"));
                                if let Err(e) = ios_java::thread_dump(&path) {
                                    let _ = std::fs::write(path, format!("Fehler: {e}"));
                                }
                            }
                        }
                    });
                    let r = launch_profile(h2, handle.state::<AppState>(), profile).await;
                    eprintln!("NUTIOS mc-test: {r:?}");
                    if let Some(home) = dirs::home_dir() {
                        let _ = std::fs::write(home.join("Library/Caches/mc-test.txt"), format!("{r:?}"));
                    }
                });
            }
            #[cfg(target_os = "ios")]
            if std::env::args().any(|a| a == "--java-selftest") {
                std::thread::spawn(|| {
                    let text = match ios_java::selftest() {
                        Ok(s) => s,
                        Err(e) => format!("FEHLER: {e}"),
                    };
                    eprintln!("JAVATEST {text}");
                    if let Some(home) = dirs::home_dir() {
                        let _ = std::fs::write(home.join("Library/Caches/java-selftest.txt"), &text);
                    }
                });
            }
            media::ensure_mta();
            discord_bridge::start(app.handle().clone());
            let cfg = LauncherConfig::load();
            cfg.ensure_dirs().ok();
            let http = reqwest::Client::builder()
                .user_agent("nutclient-launcher/0.1")
                .build()
                .expect("HTTP-Client");
            app.manage(sync::Sync::new(cfg.root.clone()));
            app.manage(AppState { cfg, http, running: std::sync::Mutex::new(Vec::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_versions,
            current_account,
            get_skin,
            login,
            offline_login,
            launch,
            launch_profile,
            install_modpack,
            loader_versions,
            export_mrpack,
            shared_folders,
            set_shared_folder,
            list_instance_mods,
            set_instance_file_enabled,
            install_modpack_file,
            running_instances,
            stop_instance,
            block_textures,
            local_time,
            media_now_playing,
            media_control,
            discord_call,
            focus_discord,
            open_instance_folder,
            list_instance_files,
            import_instance_file,
            foreign_instance_mods,
            install_content,
            remove_instance_file,
            sync_device,
            sync_start,
            sync_answer,
            java_selftest,
            ios_input,
            ios_game_state
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Start der Tauri-Anwendung");
}
