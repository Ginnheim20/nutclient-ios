// System-Medienwiedergabe: was gerade auf dem PC läuft (Spotify, YouTube im
// Browser, Netflix …). Über die Rust-Commands `media_now_playing` /
// `media_control` (Windows SMTC). Ohne Tauri gibt es nichts anzuzeigen.
import { hasTauri } from "./launcher/api";

export interface MediaNowPlaying {
  active: boolean;
  title: string;
  artist: string;
  appId: string;
  playing: boolean;
  canNext: boolean;
  canPrev: boolean;
  position: number;
  duration: number;
  thumb: string | null;
}

const EMPTY: MediaNowPlaying = {
  active: false,
  title: "",
  artist: "",
  appId: "",
  playing: false,
  canNext: false,
  canPrev: false,
  position: 0,
  duration: 0,
  thumb: null,
};

export async function mediaNowPlaying(): Promise<MediaNowPlaying> {
  if (!hasTauri) return EMPTY;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<MediaNowPlaying>("media_now_playing");
  } catch {
    return EMPTY;
  }
}

export async function mediaControl(
  action: "playpause" | "play" | "pause" | "next" | "prev",
): Promise<void> {
  if (!hasTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("media_control", { action });
  } catch {
    /* Quelle reagiert nicht */
  }
}

export interface DiscordCall {
  inCall: boolean;
  /** Server-Name oder @Person (aus dem Discord-Fenstertitel). */
  context: string;
}

/** Grobe Näherung: Discord nutzt gerade das Mikrofon (= vermutlich im Call). */
export async function discordCall(): Promise<DiscordCall> {
  if (!hasTauri) return { inCall: false, context: "" };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<DiscordCall>("discord_call");
  } catch {
    return { inCall: false, context: "" };
  }
}

/** Discord in den Vordergrund holen (über das discord://-Protokoll). */
export async function focusDiscord(): Promise<void> {
  if (!hasTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("focus_discord");
  } catch {
    /* Discord nicht installiert / Protokoll nicht registriert */
  }
}
