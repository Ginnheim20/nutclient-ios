import "./mobile";   // zuerst: setzt html.mobile, bevor irgendwas gezeichnet wird
import { initIosGame } from "./iosgame";
import { icons, setIcon } from "./icons";
import {
  initPanelHost,
  openPanel,
  goHome,
  contextMenu,
  toast,
  promptDialog,
  modal,
  h,
} from "./ui";
import { applyTheme } from "./theme";
import { checkForUpdate } from "./updater";
import { applyGlassColor, applyGlassStrength } from "./glasscolor";
import { initGlass } from "./glass";
import { initTitlebar } from "./titlebar";
import { initBackground } from "./background";
import { initBgVideo } from "./bgvideo";
import { initLiquidGlass } from "./liquidgl";
import { initNowPlaying } from "./nowplaying";
import { initSlime } from "./slime";
import { initTutorial } from "./tutorial";
import { onChange, lastPlayedProfile, store } from "./state";
import { initRunning, runningGames, stopFirst } from "./running";
import { playProfile } from "./play";
import {
  active,
  addAccount,
  addOfflineAccount,
  knownAccounts,
  onAccountChange,
  refresh as refreshAccounts,
  removeAccount,
  switchTo,
} from "./account";
import { skinHeadUrl, onEvent, hasTauri } from "./launcher/api";
import { initSkinView } from "./skinview";
import { initDiscordBridge } from "./discord";
import { initDeviceSync } from "./devicesync";
import { initModpacks } from "./modpacks";
import { renderInstances } from "./panels/instances";
import { renderCosmetics } from "./panels/cosmetics";
import { renderContent } from "./panels/content";
import { renderFriends } from "./panels/friends";
import { renderSettings } from "./panels/settings";
import { renderNotifications, unreadCount } from "./panels/notifications";
import type { CrashReport, LaunchProgress } from "./launcher/types";

applyTheme();
applyGlassColor();
applyGlassStrength();
void initTitlebar();
initBackground();
void initBgVideo();
initNowPlaying();
initSlime();
initGlass();
initLiquidGlass();
initPanelHost();
initSkinView();
void initDiscordBridge();
void initDeviceSync();
initModpacks();
initIosGame();   // iPhone: Touch-Steuerung, sobald Minecraft läuft

// Scrollleisten werden beim Scrollen bunt (CSS: .is-scrolling::-webkit-scrollbar-thumb), danach wieder Glas
{
  const timers = new WeakMap<Element, number>();
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (!el.classList.contains("is-scrolling")) el.classList.add("is-scrolling");
      window.clearTimeout(timers.get(el));
      timers.set(el, window.setTimeout(() => el.classList.remove("is-scrolling"), 700));
    },
    { capture: true, passive: true },
  );
}

// ---- Icon-Leiste ---------------------------------------------------------

const railIcons: Record<string, keyof typeof icons> = {
  home: "home",
  instances: "grid",
  cosmetics: "hanger",
  content: "plus",
  friends: "friends",
  settings: "gear",
};
const railLabels: Record<string, string> = {
  home: "Home",
  instances: "Select",
  cosmetics: "Skins",
  content: "Mods",
  friends: "Freunde",
  settings: "Einstellungen",
};
// Alle Bereiche laufen als Seitenpanel (wie „Freunde").
const panelDefs: Record<string, { title: string; render: (m: HTMLElement) => void | (() => void) }> = {
  instances: { title: "Select", render: renderInstances },
  cosmetics: { title: "Skin & Cosmetics", render: renderCosmetics },
  content: { title: "Inhalte hinzufügen", render: renderContent },
  settings: { title: "Einstellungen", render: renderSettings },
  friends: { title: "Freunde", render: renderFriends },
};

function buildTile(btn: HTMLElement, icon: keyof typeof icons, label: string): HTMLElement {
  const ico = document.createElement("span");
  ico.className = "rail-ico";
  setIcon(ico, icon);
  btn.append(ico);
  if (label) {
    const txt = document.createElement("span");
    txt.className = "rail-txt";
    txt.textContent = label;
    btn.append(txt);
  }
  return ico;
}

document
  .querySelectorAll<HTMLButtonElement>(".rail-btn[data-nav], .rail-btn[data-panel]")
  .forEach((btn) => {
    const nav = btn.dataset.nav;
    const panel = btn.dataset.panel;
    const key = nav ?? panel!;
    buildTile(btn, railIcons[key], railLabels[key]);

    btn.addEventListener("click", () => {
      if (nav === "home") return goHome();
      const def = panelDefs[panel!];
      if (def) openPanel(panel!, def.title, def.render);
    });
  });

// ---- Bühne: Play-Button + Aufklapp-Pfeil ----------------------------

const playBtn = document.getElementById("btn-play")!;
const playMore = document.getElementById("btn-play-more")!;
const playLabel = document.getElementById("play-label")!;
setIcon(playBtn.querySelector(".play-ico"), "play");
setIcon(playMore, "chevronDown");

function openInstances(): void {
  openPanel("instances", panelDefs.instances.title, panelDefs.instances.render);
}

function renderPlayBar(): void {
  const first = runningGames()[0];
  if (first) {
    // Im Lauf wird der große Knopf zum Stopp-Knopf (stoppt das zuerst gestartete Spiel)
    const name = store.profiles.find((x) => x.id === first.profileId)?.name ?? "Spiel";
    playBtn.classList.add("stopping");
    setIcon(playBtn.querySelector(".play-ico"), "stop");
    playLabel.textContent = "Stoppen";
    playBtn.title = `„${name}" stoppen`;
    return;
  }
  playBtn.classList.remove("stopping");
  setIcon(playBtn.querySelector(".play-ico"), "play");
  const p = lastPlayedProfile();
  playLabel.textContent = p ? p.name : "Spielen";
  playBtn.title = p ? `„${p.name}" starten (${p.versionId})` : "Erst eine Instanz anlegen";
}

playBtn.addEventListener("click", () => {
  if (runningGames().length) {
    void stopFirst();
    return;
  }
  const p = lastPlayedProfile();
  if (!p) {
    openInstances();
    toast("Noch keine Instanz – hier eine anlegen.");
    return;
  }
  void playProfile(p);
});
playMore.addEventListener("click", openInstances);
document.addEventListener("running-change", renderPlayBar);
void initRunning();
renderPlayBar();

// ---- Glocke (Topbar) -------------------------------------------------

const bell = document.getElementById("btn-notifications")!;
const bellIco = buildTile(bell, "bell", "Neuigkeiten");
bell.addEventListener("click", () =>
  openPanel("notifications", "Neuigkeiten", renderNotifications),
);
function refreshBellDot(): void {
  document.getElementById("notif-dot")?.remove();
  if (unreadCount() > 0) {
    const d = document.createElement("span");
    d.className = "dot";
    d.id = "notif-dot";
    bellIco.append(d);
  }
}
refreshBellDot();

// Die Uhr sitzt jetzt in der „Dynamic Island" (src/nowplaying.ts) und wird
// immer angezeigt, wenn nichts läuft – auch bei sichtbarer Taskleiste.

// ---- Konto-Chip ------------------------------------------------------

const chip = document.getElementById("account-chip")!;
const chipHead = document.getElementById("account-head") as HTMLImageElement;
const chipHeadWrap = document.getElementById("account-head-wrap")!;
const chipName = document.getElementById("account-chip-name")!;

function renderChip(): void {
  const acc = active();
  // Ohne Konto: kein Platzhalter-Kopf, nur „Anmelden" mittig.
  // Mit Konto: Kopf + „Switch Account".
  chip.classList.toggle("no-account", !acc);
  chipHeadWrap.hidden = !acc;
  chipName.textContent = acc ? "Switch Account" : "Anmelden";
  chip.title = acc ? "Konto wechseln" : "Anmelden";
  if (acc) chipHead.src = skinHeadUrl(acc.uuid);
}

chip.addEventListener("click", () => {
  const accs = knownAccounts();
  const cur = active();
  const items: Parameters<typeof contextMenu>[1] = [];

  for (const a of accs) {
    items.push({
      label:
        a.username +
        (a.offline ? " (offline)" : "") +
        (a.uuid === cur?.uuid ? "  ✓" : ""),
      icon: skinHeadUrl(a.uuid),
      onClick: () => switchTo(a.uuid),
    });
  }
  if (accs.length) items.push("sep");
  items.push({
    label: "Microsoft-Konto hinzufügen…",
    onClick: async () => {
      toast("Microsoft-Login gestartet…");
      try {
        const a = await addAccount();
        toast(`Angemeldet als ${a.username}`);
      } catch (e) {
        toast(`Login fehlgeschlagen: ${e}`, "error");
      }
    },
  });
  items.push({
    label: "Offline-Konto hinzufügen…",
    onClick: async () => {
      const name = await promptDialog("Offline-Konto", {
        placeholder: "Spielername (1–16 Zeichen)",
        confirm: "Anlegen",
      });
      if (!name) return;
      try {
        const a = await addOfflineAccount(name);
        toast(`Offline-Konto „${a.username}" angelegt`);
      } catch (e) {
        toast(`${e}`, "error");
      }
    },
  });
  if (cur) {
    items.push({
      label: `„${cur.username}" entfernen`,
      onClick: () => removeAccount(cur.uuid),
    });
  }
  contextMenu(chip, items);
});

// ---- Reaktionen -----------------------------------------------------

onAccountChange(() => {
  renderChip();
  renderPlayBar();
});
onChange(() => {
  refreshBellDot();
  renderPlayBar();
});
renderChip();
void refreshAccounts();

// Auth-Prompt aus dem Backend (Device-Code-Flow)
void onEvent<{ userCode: string; verificationUri: string }>("auth://prompt", (p) => {
  toast(`Code ${p.userCode} auf ${p.verificationUri} eingeben`);
});

// Fortschritt beim Start – Statuszeile unten im Bühnenbereich
const launchStatus = document.getElementById("launch-status")!;
let statusHideTimer = 0;
const stageLabel: Record<LaunchProgress["stage"], string> = {
  manifest: "Version laden",
  client: "Client-JAR",
  libraries: "Bibliotheken",
  assets: "Ressourcen",
  java: "Java",
  launching: "Starten",
  running: "Läuft",
  fabric: "Mod-Loader",
  mods: "Mods",
  warn: "Hinweis",
};
void onEvent<LaunchProgress>("launch://progress", (p) => {
  const pct = p.total > 1 ? ` ${Math.round((p.completed / p.total) * 100)}%` : "";
  launchStatus.textContent = `${stageLabel[p.stage] ?? p.stage}: ${p.message}${pct}`;
  launchStatus.hidden = false;
  window.clearTimeout(statusHideTimer);
  if (p.stage === "warn") toast(p.message, "error");
  if (p.stage === "running") {
    toast(p.message);
    statusHideTimer = window.setTimeout(() => (launchStatus.hidden = true), 6000);
  }
});

// Absturzanalyse: nach einem Absturz Ursache und Lösungstipp zeigen (erkannt aus Crash-Report/Log, ohne Hochladen)
void onEvent<CrashReport>("launch://crash", (r) => {
  modal(r.title, (body, close) => {
    body.append(
      h("p", { textContent: r.cause, style: "margin:0 0 10px;font-weight:600" }),
      h("p", { textContent: "Tipp: " + r.hint, style: "margin:0 0 12px" }),
      ...(r.detail ? [h("pre", { textContent: r.detail, style: "white-space:pre-wrap;font-size:12px;opacity:.75;margin:0 0 12px;max-height:120px;overflow:auto" })] : []),
      h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
        h("button", {
          class: "btn",
          textContent: "Pfad zur Log-Datei kopieren",
          onclick: () => {
            void navigator.clipboard.writeText(r.file);
            toast("Pfad kopiert");
          },
        }),
        h("button", { class: "btn primary", textContent: "OK", onclick: close }),
      ]),
    );
  });
});

// Jeff-Tutorial beim allerersten Start (danach über Einstellungen abrufbar)
initTutorial();

// Automatische Update-Prüfung kurz nach dem Start (leise, nur wenn es etwas gibt)
setTimeout(() => void checkForUpdate(true), 4000);
