// Gemeinsamer Start-Pfad für Instanzen: von der Bühne (Play-Button) und aus
// der Instanzen-Seite. Merkt sich die zuletzt gestartete Instanz.
import { store, save, clientOf, type Profile } from "./state";
import { launchProfile } from "./launcher/api";
import { glassColor } from "./glasscolor";
import { toast } from "./ui";
import { isRunning } from "./running";

export async function playProfile(p: Profile): Promise<void> {
  if (p.installing) {
    toast(`„${p.name}“ lädt noch die Mods – gleich geht es los`);
    return;
  }
  if (isRunning(p.id)) {
    toast(`„${p.name}" läuft bereits`);
    return;
  }
  store.activeProfileId = p.id;
  store.lastPlayedProfileId = p.id;
  p.lastPlayedAt = Date.now();
  save();
  toast(`Starte „${p.name}" (${p.versionId})…`);
  try {
    // Die Launcher-Farbe geht mit: der NUTclient übernimmt sie als Akzentfarbe im Spiel.
    await launchProfile({
      profileId: p.id,
      versionId: p.versionId,
      nutclient: clientOf(p) !== "none",
      clientVariant: clientOf(p),
      loader: p.loader,
      accent: glassColor().accent,
      maxRamMb: p.ramMb ?? store.settings.maxRamMb,
      jvmArgs: p.jvmArgs || undefined,
      loaderVersion: p.loaderVersion || undefined,
      width: p.width,
      height: p.height,
      fullscreen: !!p.fullscreen,
      mods: p.content
        .filter((c) => c.kind === "mod")
        .map((c) => ({ projectId: c.projectId, enabled: c.enabled !== false })),
      packs: p.content
        .filter((c) => c.kind === "resourcepack" || c.kind === "shader")
        .map((c) => ({
          projectId: c.projectId,
          kind: c.kind as "resourcepack" | "shader",
          enabled: c.enabled !== false,
        })),
    });
  } catch (e) {
    toast(`Start fehlgeschlagen: ${e}`, "error");
  }
}
