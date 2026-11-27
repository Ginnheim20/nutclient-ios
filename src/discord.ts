// Discord-Brücke: nimmt Ereignisse aus dem Vencord-Plugin „nutBridge" entgegen
// (Rust: src-tauri/src/discord_bridge.rs, Tauri-Event „discord://event") und zeigt sie
// als Glasleiste am rechten Rand (notify.ts). Im Browser-Preview (kein Tauri) passiert nichts.
import { hasTauri } from "./launcher/api";
import { showMessageBar } from "./notify";

interface DiscordEvent {
  kind: "dm" | "mention" | "call" | string;
  title: string;
  body: string;
  channelId?: string | null;
  guild?: string | null;
  color?: string | null;
}

// Standardfarben für Discord-Ereignisse (Discord-Blau, Anruf-Grün).
const KIND_COLOR: Record<string, string> = {
  dm: "#5865F2",
  mention: "#5865F2",
  call: "#43B581",
};

export async function initDiscordBridge(): Promise<void> {
  if (!hasTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<DiscordEvent>("discord://event", (e) => {
    const ev = e.payload;
    console.info("[discord] Ereignis im Frontend:", ev);
    // Anruf: Titel „Eingehender Anruf", Anrufer steht im Text
    showMessageBar({
      author: ev.title,
      text: ev.body || (ev.kind === "call" ? "Eingehender Anruf" : ""),
      server: ev.guild ?? null,
      color: ev.color ?? KIND_COLOR[ev.kind] ?? null,
    });
  });
}
