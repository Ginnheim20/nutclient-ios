// Automatische Updates: beim Start (und über Einstellungen → Hilfe) auf GitHub nach einer neueren Version suchen.
// Installiert wird direkt im laufenden Launcher – der Startet danach neu. Profile, Skins und Einstellungen liegen
// im Datenordner (nicht im Programmordner) und bleiben dabei erhalten.
import { hasTauri } from "./launcher/api";
import { isMobileDevice } from "./mobile";
import { h, modal, toast } from "./ui";

type Update = {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};

let pending: Update | null = null;

/** Sucht nach einer neueren Version. Gibt die Version zurück oder null (auch bei Fehlern – still). */
export async function checkForUpdate(silent = true): Promise<string | null> {
  if (!hasTauri || isMobileDevice) return null;   // iPhone: Updates kommen über SideStore
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (!silent) toast("Du hast die neueste Version.");
      return null;
    }
    pending = update as Update;
    if (silent) {
      // Beim Start: ganz automatisch laden, installieren und neu starten – ohne Nachfrage
      toast(`Update ${pending.version} wird installiert …`);
      await installSilently(pending);
    } else {
      showPrompt(pending);
    }
    return pending.version;
  } catch (e) {
    console.warn("Update-Prüfung fehlgeschlagen", e);
    if (!silent) toast("Update-Prüfung fehlgeschlagen – keine Verbindung zu GitHub?", "error");
    return null;
  }
}

function showPrompt(u: Update): void {
  modal("Update verfügbar", (body, close) => {
    body.append(
      h("p", { textContent: `NUTclient Launcher ${u.version} ist verfügbar.` }),
      ...(u.body ? [h("p", { class: "hint", textContent: u.body })] : []),
      h("div", { class: "modal-actions" }, [
        h("button", { class: "btn ghost", onclick: () => close(), textContent: "Später" }),
        h("button", { class: "btn", onclick: () => void install(u, body, close), textContent: "Jetzt aktualisieren" }),
      ]),
    );
  });
}

async function install(u: Update, body: HTMLElement, close: () => void): Promise<void> {
  const status = h("p", { textContent: `Lade ${u.version} herunter …` });
  body.replaceChildren(status);
  let total = 0;
  let got = 0;
  try {
    await u.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data?.contentLength ?? 0;
      if (e.event === "Progress") {
        got += e.data?.chunkLength ?? 0;
        if (total > 0) status.textContent = `Lade ${u.version} herunter … ${Math.round((got / total) * 100)} %`;
      }
      if (e.event === "Finished") status.textContent = "Installiere …";
    });
  } catch (e) {
    close();
    toast(`Update fehlgeschlagen: ${String(e)}`, "error");
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Ohne Nachfrage: herunterladen, installieren, neu starten. */
async function installSilently(u: Update): Promise<void> {
  try {
    await u.downloadAndInstall();
  } catch (e) {
    toast(`Update fehlgeschlagen: ${String(e)}`, "error");
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Für den Knopf in den Einstellungen. */
export function checkForUpdateNow(): void {
  void checkForUpdate(false);
}
