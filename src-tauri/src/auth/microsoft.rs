//! Microsoft-Login über den OAuth-2.0 Device-Code-Flow.
//!
//! Kette: Microsoft-Token -> Xbox Live -> XSTS -> Minecraft-Services -> Profil.
//! Für die Grundlage sind die HTTP-Aufrufe skizziert; die Client-ID muss von
//! einer bei Azure registrierten Anwendung stammen (mit aktiviertem Device-Flow).

use serde::Deserialize;

use crate::auth::Account;
use crate::error::{Error, Result};

/// Bei Azure AD registrierte Anwendung (öffentlicher Client).
///
/// Muss ersetzt werden: Azure-Portal → „App-Registrierungen" → Neue Registrierung
/// → unterstützte Kontotypen „Nur persönliche Microsoft-Konten" → danach unter
/// „Authentifizierung" die Option **„Öffentliche Clientflows zulassen"** = Ja.
/// Die Client-ID hier eintragen oder beim Build als `MSA_CLIENT_ID` setzen.
const CLIENT_ID: &str = match option_env!("MSA_CLIENT_ID") {
    Some(id) => id,
    None => "00000000-0000-0000-0000-000000000000",
};
const SCOPE: &str = "XboxLive.signin offline_access";

fn ensure_client_id() -> Result<()> {
    if CLIENT_ID.starts_with("00000000-0000") {
        // Nutzertext: die Entwickler-Hinweise stehen oben am Konstanten-Kommentar
        return Err(Error::Other(
            "Die Microsoft-Anmeldung ist in dieser Version noch nicht eingerichtet. \
             Bitte einen Offline-Namen verwenden."
                .into(),
        ));
    }
    Ok(())
}

const DEVICE_CODE_URL: &str =
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str =
    "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

#[derive(Debug, Deserialize)]
pub struct DeviceCode {
    pub user_code: String,
    pub device_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
struct MsToken {
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct XblResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: DisplayClaims,
}

#[derive(Debug, Deserialize)]
struct DisplayClaims {
    xui: Vec<Xui>,
}

#[derive(Debug, Deserialize)]
struct Xui {
    uhs: String,
}

#[derive(Debug, Deserialize)]
struct McToken {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct McProfile {
    id: String,
    name: String,
}

/// Schritt 1: Device-Code anfordern. Der Aufrufer zeigt `user_code` +
/// `verification_uri` an und ruft danach `poll_for_token` auf.
pub async fn request_device_code(client: &reqwest::Client) -> Result<DeviceCode> {
    ensure_client_id()?;
    let resp = client
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

/// Schritt 2: Solange pollen, bis der Nutzer die Anmeldung im Browser bestätigt.
async fn poll_for_token(client: &reqwest::Client, dc: &DeviceCode) -> Result<MsToken> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(dc.expires_in);
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(dc.interval)).await;
        if std::time::Instant::now() > deadline {
            return Err(Error::Other("Anmeldung abgelaufen".into()));
        }
        let resp = client
            .post(TOKEN_URL)
            .form(&[
                ("client_id", CLIENT_ID),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &dc.device_code),
            ])
            .send()
            .await?;

        if resp.status().is_success() {
            return Ok(resp.json().await?);
        }
        // 400 mit error=authorization_pending -> weiter warten.
        let err: serde_json::Value = resp.json().await.unwrap_or_default();
        match err.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") | Some("slow_down") => continue,
            Some(other) => return Err(Error::Other(format!("MS-Login: {other}"))),
            None => return Err(Error::Other("MS-Login: unbekannte Antwort".into())),
        }
    }
}

async fn xbox_login(client: &reqwest::Client, ms_access_token: &str) -> Result<(String, String)> {
    let body = serde_json::json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={ms_access_token}")
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    let xbl: XblResponse = client.post(XBL_URL).json(&body).send().await?.json().await?;
    let uhs = xbl
        .display_claims
        .xui
        .first()
        .map(|x| x.uhs.clone())
        .ok_or_else(|| Error::Other("Kein User-Hash von Xbox Live".into()))?;
    Ok((xbl.token, uhs))
}

async fn xsts_token(client: &reqwest::Client, xbl_token: &str) -> Result<String> {
    let body = serde_json::json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    let xsts: XblResponse = client.post(XSTS_URL).json(&body).send().await?.json().await?;
    Ok(xsts.token)
}

async fn minecraft_token(
    client: &reqwest::Client,
    uhs: &str,
    xsts_token: &str,
) -> Result<String> {
    let body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={uhs};{xsts_token}")
    });
    let mc: McToken = client
        .post(MC_LOGIN_URL)
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    Ok(mc.access_token)
}

async fn minecraft_profile(client: &reqwest::Client, mc_token: &str) -> Result<McProfile> {
    Ok(client
        .get(MC_PROFILE_URL)
        .bearer_auth(mc_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// Komplette Kette. `on_prompt` wird mit (Code, URL) aufgerufen, damit die UI
/// dem Nutzer sagen kann, wohin er gehen soll.
pub async fn login<F>(client: &reqwest::Client, on_prompt: F) -> Result<Account>
where
    F: FnOnce(&DeviceCode),
{
    let dc = request_device_code(client).await?;
    on_prompt(&dc);

    let ms = poll_for_token(client, &dc).await?;
    let (xbl_token, uhs) = xbox_login(client, &ms.access_token).await?;
    let xsts = xsts_token(client, &xbl_token).await?;
    let mc_token = minecraft_token(client, &uhs, &xsts).await?;
    let profile = minecraft_profile(client, &mc_token).await?;

    Ok(Account {
        username: profile.name,
        uuid: profile.id,
        access_token: mc_token,
        refresh_token: ms.refresh_token,
        offline: false,
    })
}
