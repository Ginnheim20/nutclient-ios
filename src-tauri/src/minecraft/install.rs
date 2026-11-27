use std::path::Path;

use serde::Deserialize;
use sha1::{Digest, Sha1};

use crate::config::LauncherConfig;
use crate::error::{Error, Result};
use crate::minecraft::manifest::{Artifact, VersionDetail};

/// Lädt eine Datei, falls sie noch nicht vorhanden ist. Da atomar (erst `.part`,
/// dann umbenennen) geschrieben wird, gilt: Datei da = Datei vollständig.
/// Nur beim frischen Download wird der SHA1 geprüft.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    sha1: &str,
    dest: &Path,
) -> Result<()> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // bis zu 3 Versuche – abgerissene Verbindungen (z. B. Mobilfunk) sollen nicht den ganzen Start abbrechen
    let mut tries = 0;
    let bytes = loop {
        tries += 1;
        let r = match client.get(url).send().await.and_then(|r| r.error_for_status()) {
            Ok(resp) => resp.bytes().await,
            Err(e) => Err(e),
        };
        match r {
            Ok(b) => break b,
            Err(e) if tries >= 3 => return Err(e.into()),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(800 * tries)).await,
        }
    };

    if !sha1.is_empty() {
        let got = hex::encode(Sha1::digest(&bytes));
        if got != sha1 {
            return Err(Error::HashMismatch(dest.display().to_string()));
        }
    }

    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Regelauswertung: gilt die Library auf dem aktuellen OS?
pub fn library_allowed(rules: &[crate::minecraft::manifest::Rule]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let os_name = current_os();
    let mut allowed = false;
    for rule in rules {
        let matches = rule
            .os
            .as_ref()
            .and_then(|o| o.name.as_ref())
            .map(|n| n == os_name)
            .unwrap_or(true);
        if matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

pub fn current_os() -> &'static str {
    // iPhone: Java meldet sich dort als „Mac OS X“ → Minecraft braucht die macOS-Bibliotheken (z. B. java-objc-bridge)
    match std::env::consts::OS {
        "macos" | "ios" => "osx",
        other => other,
    }
}

#[derive(Debug, Deserialize)]
struct AssetIndexFile {
    objects: std::collections::HashMap<String, AssetObject>,
}

#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
    #[allow(dead_code)]
    size: u64,
}

/// Installiert Client-Jar, Libraries und Assets. Fortschritt wird über `on_progress` gemeldet.
pub async fn install_version<F>(
    client: &reqwest::Client,
    cfg: &LauncherConfig,
    detail: &VersionDetail,
    mut on_progress: F,
) -> Result<()>
where
    F: FnMut(&str, usize, usize),
{
    cfg.ensure_dirs()?;

    // 1) Client-Jar
    let client_jar = cfg.version_dir(&detail.id).join(format!("{}.jar", detail.id));
    on_progress("client", 0, 1);
    download_verified(
        client,
        &detail.downloads.client.url,
        &detail.downloads.client.sha1,
        &client_jar,
    )
    .await?;
    on_progress("client", 1, 1);

    // 2) Libraries – parallel
    let libs: Vec<&Artifact> = detail
        .libraries
        .iter()
        .filter(|l| library_allowed(&l.rules))
        .filter_map(|l| l.downloads.as_ref().and_then(|d| d.artifact.as_ref()))
        .collect();
    let jobs = libs.iter().map(|art| {
        let dest = cfg.libraries_dir().join(&art.path);
        (art.url.clone(), art.sha1.clone(), dest)
    });
    run_parallel(client, jobs.collect(), 16, "libraries", &mut on_progress).await?;

    // 3) Asset-Index + Objekte – parallel
    let index_path = cfg
        .assets_dir()
        .join("indexes")
        .join(format!("{}.json", detail.asset_index.id));
    download_verified(
        client,
        &detail.asset_index.url,
        &detail.asset_index.sha1,
        &index_path,
    )
    .await?;

    let index: AssetIndexFile = serde_json::from_slice(&std::fs::read(&index_path)?)?;
    let objects_dir = cfg.assets_dir().join("objects");
    let jobs: Vec<(String, String, std::path::PathBuf)> = index
        .objects
        .values()
        .map(|obj| {
            let sub = obj.hash[0..2].to_string();
            let url = format!("https://resources.download.minecraft.net/{sub}/{}", obj.hash);
            let dest = objects_dir.join(&sub).join(&obj.hash);
            (url, obj.hash.clone(), dest)
        })
        .collect();
    run_parallel(client, jobs, 48, "assets", &mut on_progress).await?;

    Ok(())
}

/// Lädt viele Dateien mit begrenzter Nebenläufigkeit und meldet den Fortschritt.
async fn run_parallel<F>(
    client: &reqwest::Client,
    jobs: Vec<(String, String, std::path::PathBuf)>,
    concurrency: usize,
    stage: &str,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(&str, usize, usize),
{
    use futures_util::stream::{self, StreamExt};

    let total = jobs.len();
    on_progress(stage, 0, total);
    if total == 0 {
        return Ok(());
    }

    let mut done = 0usize;
    let mut first_err: Option<Error> = None;

    let mut stream = stream::iter(jobs.into_iter().map(|(url, sha, dest)| async move {
        download_verified(client, &url, &sha, &dest).await
    }))
    .buffer_unordered(concurrency);

    while let Some(res) = stream.next().await {
        done += 1;
        if let Err(e) = res {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
        if done % 20 == 0 || done == total {
            on_progress(stage, done, total);
        }
    }

    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
