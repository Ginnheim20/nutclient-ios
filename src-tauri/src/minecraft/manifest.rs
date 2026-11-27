use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/// Eintrag aus dem globalen Versions-Manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub url: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
    #[serde(default)]
    pub sha1: String,
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    versions: Vec<VersionSummary>,
}

pub struct VersionManifest {
    pub versions: Vec<VersionSummary>,
}

impl VersionManifest {
    /// Lädt das Manifest von Mojang.
    pub async fn fetch(client: &reqwest::Client) -> Result<Self> {
        let raw: RawManifest = client.get(MANIFEST_URL).send().await?.json().await?;
        Ok(Self {
            versions: raw.versions,
        })
    }

    pub fn find(&self, id: &str) -> Result<&VersionSummary> {
        self.versions
            .iter()
            .find(|v| v.id == id)
            .ok_or_else(|| Error::VersionNotFound(id.to_string()))
    }
}

// --- Detail-Manifest einer einzelnen Version ---------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct VersionDetail {
    pub id: String,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    #[serde(rename = "assetIndex")]
    pub asset_index: AssetIndexRef,
    pub assets: String,
    pub downloads: VersionDownloads,
    pub libraries: Vec<Library>,
    /// Neuere Versionen nutzen `arguments`, ältere `minecraftArguments`.
    #[serde(default)]
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments", default)]
    pub legacy_arguments: Option<String>,
    #[serde(rename = "javaVersion", default)]
    pub java_version: Option<JavaVersion>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JavaVersion {
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndexRef {
    pub id: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionDownloads {
    pub client: Download,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Download {
    pub url: String,
    pub sha1: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<LibraryDownloads>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<Artifact>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    pub path: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<serde_json::Value>,
    #[serde(default)]
    pub jvm: Vec<serde_json::Value>,
}

impl VersionDetail {
    pub async fn fetch(client: &reqwest::Client, summary: &VersionSummary) -> Result<Self> {
        Ok(client.get(&summary.url).send().await?.json().await?)
    }
}
