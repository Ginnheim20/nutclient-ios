// Modpacks installieren: Fortschritt je Profil merken und als Fenster-Ereignis „modpack-progress“ melden
// (Select-Panel zeichnet daraus den bunten Ladebalken). Profile mit `installing` laden nach einem Neustart weiter.
import { store, save, type Profile } from "./state";
import { hasTauri, installModpack, installModpackFile, onEvent, getModrinthProject, NUTCLIENT_VERSIONS, type ModpackProgress } from "./launcher/api";
import { toast } from "./ui";

export interface Job {
  done: number;
  total: number;
  message: string;
}

const jobs = new Map<string, Job>();

/** Aktueller Stand für ein Profil (oder undefined, wenn nichts lädt). */
export function modpackJob(profileId: string): Job | undefined {
  return jobs.get(profileId);
}

/** Anteil 0…1. */
export function jobFraction(j: Job | undefined): number {
  return j && j.total > 0 ? Math.min(1, j.done / j.total) : 0;
}

function changed(profileId: string): void {
  window.dispatchEvent(new CustomEvent("modpack-progress", { detail: profileId }));
}

/** Modpack des Profils laden (Version, Loader und Bild kommen aus dem Pack). */
export async function startModpackInstall(p: Profile): Promise<void> {
  if ((!p.modpackId && !p.modpackFile) || jobs.has(p.id)) return;
  jobs.set(p.id, { done: 0, total: 1, message: "Modpack suchen" });
  p.installing = true;
  save();
  changed(p.id);
  try {
    const res = !hasTauri
      ? await demoInstall(p.id)
      : p.modpackFile
        ? await installModpackFile(p.id, p.modpackFile)
        : await installModpack(p.id, p.modpackId!);
    if (p.modpackFile && res.name) {
      p.name = res.name;
      p.fromModpack = res.name;
    }
    p.missingMods = res.missing.length ? res.missing : undefined;
    p.versionId = res.mc;
    p.loader = res.loader;
    // NUTclient nur, wo es ihn gibt (Fabric + mitgelieferte Minecraft-Version)
    p.nutclient = res.loader === "fabric" && NUTCLIENT_VERSIONS.includes(res.mc);
    p.clientVariant = p.nutclient ? "nutclient" : "none";
    p.installing = false;
    save();
    if (res.missing.length) {
      const some = res.missing.slice(0, 4).join(", ");
      toast(
        `„${p.name}“: ${res.files} Mods geladen, ${res.missing.length} nur auf CurseForge (fehlen bis zum CurseForge-Zugang): ${some}${res.missing.length > 4 ? " …" : ""}`,
        "error",
      );
    } else {
      toast(`„${p.name}“ ist fertig: ${res.files} Dateien, Minecraft ${res.mc}`);
    }
  } catch (e) {
    p.installing = false;
    save();
    toast(`Modpack „${p.name}“: ${e}`, "error");
  } finally {
    jobs.delete(p.id);
    changed(p.id);
  }
}

/** Beim Start: Fortschritt mithören, abgebrochene Installationen fortsetzen. */
export function initModpacks(): void {
  void onEvent<ModpackProgress>("modpack://progress", (ev) => {
    const j = jobs.get(ev.profileId);
    if (!j) return;
    j.done = ev.done;
    j.total = ev.total;
    j.message = ev.message;
    changed(ev.profileId);
  });
  for (const p of store.profiles) {
    // ältere Modpack-Profile (vor 0.9.26 nur ein Eintrag „modpack“, nie geladen) → jetzt richtig installieren
    const old = p.content.find((c) => c.kind === "modpack");
    if (old && !p.modpackId) {
      p.modpackId = old.projectId;
      p.content = p.content.filter((c) => c !== old);
      p.installing = true;
      save();
      if (!p.icon) {
        getModrinthProject(old.projectId)
          .then((pr) => {
            if (pr.icon_url && !p.icon) {
              p.icon = pr.icon_url;
              save();
              changed(p.id);
            }
          })
          .catch(() => {});
      }
    }
    if (p.installing) void startModpackInstall(p);
  }
}

/** Browser-Vorschau: so tun, als würde geladen. */
async function demoInstall(id: string) {
  const total = 40;
  for (let i = 1; i <= total; i++) {
    await new Promise((r) => setTimeout(r, 350));
    const j = jobs.get(id);
    if (j) Object.assign(j, { done: i, total, message: `mod-${i}.jar` });
    changed(id);
  }
  return { mc: "1.21.1", loader: "fabric" as const, name: "", version: "1.0", files: total, missing: [] as string[] };
}
