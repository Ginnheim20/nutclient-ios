// Daten zwischen zwei Geräten im selben WLAN übertragen (Backend: src-tauri/src/sync.rs).
// Findet der Launcher ein zweites Gerät, fragt er „Daten übertragen?“ – übertragen wird nur, wenn auf beiden
// Geräten Ja geklickt wird. „Jetzt nicht“ fragt beim nächsten Start wieder, „Nicht mehr anzeigen“ blendet dieses
// Gerät aus (Einstellungen → Gerätesuche wiederholen zeigt es wieder).
import { h, modal, toast } from "./ui";
import { hasTauri, onEvent, syncAnswer, syncStart } from "./launcher/api";

const KEY = "mcl.devsync.v1";
/** Zeitpunkt der letzten Änderung an den Launcher-Daten (neuere Einstellungen gewinnen beim Zusammenführen). */
export const CHANGED_KEY = "mcl.changed.v1";

interface SyncPrefs {
  hidden: string[];
}

interface Ask {
  peer_id: string;
  name: string;
  os: string;
  kind: string;
  code: string;
}

interface Status {
  peer_id: string;
  state: "declined" | "sending" | "done" | "error";
  message: string;
}

function prefs(): SyncPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "") as SyncPrefs;
    return { hidden: Array.isArray(p.hidden) ? p.hidden : [] };
  } catch {
    return { hidden: [] };
  }
}

function savePrefs(p: SyncPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* egal */
  }
}

/** Offene Abfragen je Gerät (zum Schließen/Aktualisieren bei Statusmeldungen). */
const open = new Map<string, { close: () => void; status: HTMLElement }>();

export async function initDeviceSync(): Promise<void> {
  if (!hasTauri) return;
  await onEvent<Ask>("sync://ask", ask);
  await onEvent<Status>("sync://status", (s) => {
    const o = open.get(s.peer_id);
    if (o) o.status.textContent = s.message;
    if (s.state === "done" || s.state === "declined" || s.state === "error") {
      if (o) setTimeout(o.close, s.state === "done" ? 400 : 2500);
      open.delete(s.peer_id);
      toast(s.message, s.state === "error" ? "error" : "info");
    }
  });
  await onEvent<{ peer_id: string; storage: string }>("sync://data", (d) => {
    merge(d.storage);
    toast("Daten vom anderen Gerät übernommen – Launcher lädt neu …");
    setTimeout(() => location.reload(), 1600);
  });
  await syncStart(prefs().hidden, false);
}

/** Einstellungen → „Gerätesuche wiederholen“: ausgeblendete Geräte wieder zeigen, alle noch einmal fragen. */
export async function retryDeviceSearch(): Promise<void> {
  savePrefs({ hidden: [] });
  await syncStart([], true);
  toast("Gerätesuche läuft – Geräte im selben WLAN werden gleich angezeigt.");
}

function kindLabel(a: Ask): string {
  const sys = a.os.toLowerCase().startsWith("windows") ? "Windows" : a.os.split(" ")[0] || "Gerät";
  return `${sys}-${a.kind || "Gerät"}${a.os ? ", " + a.os : ""}`;
}

function ask(a: Ask): void {
  if (open.has(a.peer_id)) return;
  let answered = false;
  const status = h("p", { class: "hint", textContent: "" });
  const reply = (yes: boolean, never = false) => {
    if (answered) return;
    answered = true;
    if (never) {
      const p = prefs();
      if (!p.hidden.includes(a.peer_id)) p.hidden.push(a.peer_id);
      savePrefs(p);
    }
    void syncAnswer(a.peer_id, yes, yes ? exportStorage() : "");
    if (yes) {
      status.textContent = "Warte auf das andere Gerät …";
      buttons.remove();
    } else {
      open.delete(a.peer_id);
      close();
    }
  };
  const buttons = h("div", { class: "row", style: "gap:8px;flex-wrap:wrap;margin-top:12px" }, [
    h("button", { class: "btn", textContent: "Ja, übertragen", onclick: () => reply(true) }),
    h("button", { class: "btn ghost", textContent: "Jetzt nicht", onclick: () => reply(false) }),
    h("button", { class: "btn ghost", textContent: "Nicht mehr anzeigen", onclick: () => reply(false, true) }),
  ]);
  const close = modal("Daten übertragen?", (body) => {
    body.append(
      h("p", { textContent: "Im selben WLAN läuft der NUTclient Launcher auch auf:" }),
      h("div", { class: "sync-device" }, [
        h("strong", { textContent: a.name }),
        h("span", { class: "hint", textContent: kindLabel(a) }),
      ]),
      h("p", {
        class: "hint",
        textContent:
          "Übertragen werden Profile, Modpacks, Einstellungen, gespeicherte Minecraft-Konten und Server – " +
          "in beide Richtungen, nur wenn auf beiden Geräten Ja geklickt wird. Vorhandenes wird nicht überschrieben.",
      }),
      h("div", { class: "sync-code" }, [
        h("span", { textContent: "Code zum Vergleichen" }),
        h("b", { textContent: a.code }),
      ]),
      h("p", { class: "hint", textContent: "Zeigt das andere Gerät denselben Code? Sonst nicht übertragen." }),
      buttons,
      status,
    );
  });
  open.set(a.peer_id, { close, status });
  // Fenster über ✕/Esc geschlossen = „Jetzt nicht“
  const back = document.querySelector(".dialog-back:last-of-type");
  if (back) {
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!answered) {
          answered = true;
          open.delete(a.peer_id);
          void syncAnswer(a.peer_id, false, "");
        }
      }
    }).observe(document.body, { childList: true });
  }
}

/** Launcher-Daten dieses Geräts (alle „mcl.“-Einträge außer den gerätebezogenen). */
function exportStorage(): string {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("mcl.") && k !== KEY && k !== "mcl.panel.wide") out[k] = localStorage.getItem(k) ?? "";
  }
  return JSON.stringify(out);
}

type Rec = Record<string, unknown>;

function parse(s: string | null | undefined): Rec | null {
  try {
    const v = JSON.parse(s ?? "");
    return v && typeof v === "object" ? (v as Rec) : null;
  } catch {
    return null;
  }
}

/** Listen nach Schlüssel vereinen (lokale Einträge bleiben, fehlende kommen dazu). */
function union(local: unknown, remote: unknown, key: string): unknown[] {
  const a = Array.isArray(local) ? [...local] : [];
  const seen = new Set(a.map((x) => (x as Rec)?.[key]));
  for (const x of Array.isArray(remote) ? remote : []) {
    const k = (x as Rec)?.[key];
    if (k !== undefined && !seen.has(k)) {
      a.push(x);
      seen.add(k);
    }
  }
  return a;
}

/** Empfangene Launcher-Daten mit den eigenen zusammenführen. */
function merge(storage: string): void {
  const remote = parse(storage);
  if (!remote) return;
  const remoteNewer = Number(remote[CHANGED_KEY] ?? 0) > Number(localStorage.getItem(CHANGED_KEY) ?? 0);
  for (const [k, v] of Object.entries(remote)) {
    if (typeof v !== "string" || !k.startsWith("mcl.") || k === KEY || k === CHANGED_KEY) continue;
    const mine = localStorage.getItem(k);
    if (k === "mcl.store.v1") {
      const a = parse(mine);
      const b = parse(v);
      if (!a || !b) {
        if (!a && b) localStorage.setItem(k, v);
        continue;
      }
      a.profiles = union(a.profiles, b.profiles, "id");
      a.skins = union(a.skins, b.skins, "id");
      a.friends = union(a.friends, b.friends, "name");
      // Einstellungen: die zuletzt geänderten gewinnen, fehlende kommen dazu
      const sa = (a.settings as Rec) ?? {};
      const sb = (b.settings as Rec) ?? {};
      a.settings = remoteNewer ? { ...sa, ...sb } : { ...sb, ...sa };
      if (!a.activeProfileId) a.activeProfileId = b.activeProfileId ?? null;
      localStorage.setItem(k, JSON.stringify(a));
    } else if (k === "mcl.accounts.v1") {
      const a = parse(mine) ?? { known: [], activeUuid: null };
      const b = parse(v) ?? {};
      a.known = union(a.known, b.known, "uuid");
      if (!a.activeUuid) a.activeUuid = b.activeUuid ?? null;
      localStorage.setItem(k, JSON.stringify(a));
    } else if (mine === null || remoteNewer) {
      localStorage.setItem(k, v);
    }
  }
}
