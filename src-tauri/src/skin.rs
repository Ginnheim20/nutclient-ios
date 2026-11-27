//! Skin-Textur zu einer UUID holen und als data-URL zurückgeben
//! (damit die WebView sie ohne CORS-Probleme anzeigen kann).

use base64::Engine;
use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Deserialize)]
struct Profile {
    properties: Vec<Property>,
}

#[derive(Deserialize)]
struct Property {
    value: String,
}

#[derive(Deserialize)]
struct TexturesPayload {
    textures: Textures,
}

#[derive(Deserialize)]
struct Textures {
    #[serde(rename = "SKIN")]
    skin: Option<TextureRef>,
}

#[derive(Deserialize)]
struct TextureRef {
    url: String,
}

pub async fn skin_data_url(client: &reqwest::Client, uuid: &str) -> Result<String> {
    let profile: Profile = client
        .get(format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{uuid}"
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let b64 = &profile
        .properties
        .first()
        .ok_or_else(|| Error::Other("Profil ohne Texturen".into()))?
        .value;

    let json = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| Error::Other(e.to_string()))?;
    let payload: TexturesPayload = serde_json::from_slice(&json)?;

    let skin_url = payload
        .textures
        .skin
        .ok_or_else(|| Error::Other("Kein Skin gesetzt".into()))?
        .url;

    let bytes = client.get(&skin_url).send().await?.bytes().await?;
    let b64png = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64png}"))
}
