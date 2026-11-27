import { h, clear, toast, modal, tabbed, contextMenu, isPanelExpanded, searchBar, pickBar } from "../ui";
import { isRunning, stopProfile } from "../running";
import {
  store,
  save,
  uid,
  type Profile,
  type ModLoader,
  type InstanceOrigin,
  type ClientVariant,
  CLIENT_OPTIONS,
} from "../state";
import { icons } from "../icons";
import { modpackJob, jobFraction, startModpackInstall } from "../modpacks";
import { openProfileSettings } from "./profile-settings";
import { listVersions, searchModrinth, hasTauri, NUTCLIENT_VERSIONS, type ModrinthHit } from "../launcher/api";
import { playProfile } from "../play";
import { renderInstanceDetail, resetDetail } from "./instance-detail";
import type { VersionSummary } from "../launcher/types";

let versions: VersionSummary[] = [];

const LOADERS: { key: ModLoader; label: string }[] = [
  { key: "vanilla", label: "Vanilla" },
  { key: "fabric", label: "Fabric" },
  { key: "forge", label: "Forge" },
  { key: "quilt", label: "Quilt" },
  { key: "neoforge", label: "NeoForge" },
];

// Clients, aus denen importiert werden kann. `detect` ist noch ein Stub –
// das Backend meldet später, ob/wo der Client installiert ist
// (siehe client-readme.md).
const CLIENTS: {
  id: InstanceOrigin;
  label: string;
  note: string;
  suggestions: string[];
}[] = [
  { id: "vanilla-launcher", label: "Minecraft Launcher", note: "launcher_profiles.json", suggestions: [] },
  { id: "modrinth-app", label: "Modrinth App", note: "profiles/ + profiles.json", suggestions: ["Fabulously Optimized", "Simply Optimized"] },
  { id: "curseforge", label: "CurseForge", note: "Instances/ + minecraftinstance.json", suggestions: ["All the Mods 10", "Better MC"] },
  { id: "prism", label: "Prism Launcher", note: "instances/*/mmc-pack.json", suggestions: [] },
  { id: "multimc", label: "MultiMC", note: "instances/*/instance.cfg", suggestions: [] },
  { id: "labymod", label: "LabyMod", note: "LabyMod4/…", suggestions: ["LabyMod 4 (1.21)"] },
  { id: "lunar", label: "Lunar Client", note: ".lunarclient/…", suggestions: ["Lunar 1.8.9", "Lunar 1.21"] },
  { id: "noriskclient", label: "NoRiskClient", note: "profiles.json + minecraft_skins.json", suggestions: ["NRC Stable", "NRC Experimental"] },
  { id: "fastclient", label: "FastClient", note: "config/…", suggestions: ["FastClient PvP"] },
];

// Filter-/Sortier-Zustand bleibt über Neuaufbauten (Panel breit/schmal) erhalten.
type SortKey = "recent" | "name" | "version";
let query = "";
let filter = "all";
let sort: SortKey = "recent";

/** Welche Instanz gerade in der Detailansicht offen ist (null = Liste). */
let openId: string | null = null;

// ---- Modpack-Datei ins Select-Fenster ziehen (.zip von CurseForge, .mrpack von Modrinth) ----
let packDropReady = false;
async function listenForPackDrops(): Promise<void> {
  if (packDropReady || !hasTauri) return;
  packDropReady = true;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((e) => {
    const panel = document.querySelector<HTMLElement>(".inst-panel");
    // offene Instanz-Ansicht kümmert sich selbst um hineingezogene Dateien
    if (!panel || document.querySelector(".inst-detail")) return;
    const t = e.payload.type;
    if (t === "enter" || t === "over") {
      panel.classList.add("drop");
      return;
    }
    panel.classList.remove("drop");
    if (t !== "drop") return;
    let added = 0;
    for (const path of e.payload.paths) {
      const file = path.split(/[\\/]/).pop() ?? path;
      const lower = file.toLowerCase();
      if (!lower.endsWith(".zip") && !lower.endsWith(".mrpack")) {
        toast(`„${file}“ ist kein Modpack (.zip von CurseForge oder .mrpack von Modrinth)`, "error");
        continue;
      }
      const stem = file.replace(/\.(zip|mrpack)$/i, "");
      const p = createProfile({
        name: stem,
        versionId: "…",
        loader: "fabric",
        fromModpack: stem,
        origin: lower.endsWith(".mrpack") ? "mrpack" : "curseforge",
        modpackFile: path,
        installing: true,
      });
      void startModpackInstall(p);
      added++;
    }
    if (added) window.dispatchEvent(new CustomEvent("modpack-progress", { detail: "" }));
  });
}

export function renderInstances(mount: HTMLElement): () => void {
  void listenForPackDrops();
  let tools: HTMLElement;
  let grid: HTMLElement;

  const paint = () => {
    clear(grid);
    const list = visibleProfiles();
    if (list.length === 0) {
      grid.append(
        h("div", {
          class: "empty",
          textContent: store.profiles.length
            ? "Nichts gefunden."
            : "Noch keine Instanzen – oben auf Erstellen.",
        }),
      );
      return;
    }
    for (const p of list) grid.append(instanceCard(p, rebuild));
  };

  const rebuild = () => {
    const open = openId ? store.profiles.find((x) => x.id === openId) : undefined;
    if (open) {
      clear(mount);
      mount.classList.remove("inst-panel", "inst-wide");
      mount.append(
        renderInstanceDetail(open, {
          back: () => {
            openId = null;
            resetDetail();
            rebuild();
          },
          edit: () => openProfileSettings(open, rebuild),
          refresh: rebuild,
        }),
      );
      return;
    }
    clear(mount);
    mount.classList.add("inst-panel");
    tools = h("div", { class: "inst-tools" });
    grid = h("div", { class: "inst-grid" });
    mount.append(tools, grid);
    const wide = isPanelExpanded();
    mount.classList.toggle("inst-wide", wide);
    buildTools(tools, wide, rebuild, paint);
    paint();
  };

  rebuild();
  const onResize = () => rebuild();
  mount.addEventListener("panelresize", onResize);
  // Laufstatus geändert (Start/Ende/Stopp) → Karten neu zeichnen
  const onRunning = () => rebuild();
  document.addEventListener("running-change", onRunning);
  const onPack = (e: Event) => {
    const id = (e as CustomEvent<string>).detail;
    const card = mount.querySelector<HTMLElement>(`.inst-card[data-pid="${CSS.escape(id)}"]`);
    const p = store.profiles.find((x) => x.id === id);
    if (!card || !p || !p.installing || !modpackJob(id)) return void rebuild();
    paintProgress(card, id);
  };
  window.addEventListener("modpack-progress", onPack);

  if (versions.length === 0) {
    listVersions()
      .then((v) => {
        versions = v;
      })
      .catch(() => {});
  }

  return () => {
    mount.removeEventListener("panelresize", onResize);
    document.removeEventListener("running-change", onRunning);
    window.removeEventListener("modpack-progress", onPack);
  };
}

// ---- Werkzeugleiste ------------------------------------------------

function buildTools(
  tools: HTMLElement,
  wide: boolean,
  rebuild: () => void,
  paint: () => void,
): void {
  const search = h("input", {
    placeholder: "Instanzen suchen…",
    value: query,
  }) as HTMLInputElement;
  const sb = searchBar(search);
  const count = () => sb.setCount(query.trim() ? visibleProfiles().length : null);
  search.addEventListener("input", () => {
    query = search.value;
    paint();
    count();
  });
  count();

  const createBtn = h("button", {
    class: "btn sm",
    onclick: () => openCreateModal(rebuild),
    html: `<i class="bi">${icons.plus}</i><span>${wide ? "Erstellen" : ""}</span>`,
    title: "Instanz erstellen",
  });

  const topRow = h("div", { class: "inst-tools-row" }, [
    sb.el,
  ]);

  if (wide) {
    const importBtn = h("button", {
      class: "btn ghost sm",
      onclick: () => openCreateModal(rebuild, "import"),
      html: `<i class="bi">${icons.upload}</i><span>Import</span>`,
      title: "Aus Datei / anderem Client importieren",
    });
    const sortBtn = h("button", {
      class: "btn ghost sm inst-sort",
      html: `<i class="bi">${icons.sort}</i><span>${SORT_LABEL[sort]}</span>`,
      title: "Sortierung wechseln",
      onclick: (e: Event) => {
        contextMenu(e.currentTarget as HTMLElement, [
          sortItem("recent", paint),
          sortItem("name", paint),
          sortItem("version", paint),
        ]);
      },
    });
    topRow.append(sortBtn, importBtn, createBtn);
    tools.append(topRow, chipRow(paint));
  } else {
    topRow.append(createBtn);
    tools.append(topRow);
  }
}

const SORT_LABEL: Record<SortKey, string> = {
  recent: "Zuletzt",
  name: "Name",
  version: "Version",
};
function sortItem(k: SortKey, paint: () => void) {
  return {
    label: SORT_LABEL[k] + (sort === k ? "  ✓" : ""),
    iconHtml: icons.sort,
    onClick: () => {
      sort = k;
      paint();
    },
  };
}

function chipRow(paint: () => void): HTMLElement {
  const chips: { key: string; label: string }[] = [
    { key: "all", label: "Alle" },
    { key: "modpack", label: "Modpacks" },
    { key: "vanilla", label: "Vanilla" },
    { key: "fabric", label: "Fabric" },
    { key: "forge", label: "Forge" },
    { key: "neoforge", label: "NeoForge" },
    { key: "quilt", label: "Quilt" },
  ];
  const row = h("div", { class: "inst-chips" });
  for (const c of chips) {
    if (c.key !== "all" && !store.profiles.some((p) => matchesFilter(p, c.key))) continue;
    row.append(
      h("button", {
        class: `inst-chip ${filter === c.key ? "on" : ""}`,
        textContent: c.label,
        onclick: () => {
          filter = c.key;
          row.querySelectorAll(".inst-chip").forEach((b) =>
            b.classList.toggle("on", (b as HTMLElement).textContent === c.label),
          );
          paint();
        },
      }),
    );
  }
  return row;
}

// ---- Filter / Sortierung ------------------------------------------

function matchesFilter(p: Profile, f: string): boolean {
  if (f === "all") return true;
  if (f === "modpack") return !!p.fromModpack;
  return p.loader === f;
}

function visibleProfiles(): Profile[] {
  const q = query.trim().toLowerCase();
  let list = store.profiles.filter(
    (p) =>
      matchesFilter(p, filter) &&
      (!q || p.name.toLowerCase().includes(q) || p.versionId.toLowerCase().includes(q)),
  );
  list = [...list].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "version") return b.versionId.localeCompare(a.versionId, undefined, { numeric: true });
    // recent: aktive/zuletzt gespielt zuerst, dann nach createdAt
    const rank = (p: Profile) =>
      p.id === store.activeProfileId ? 2 : p.id === store.lastPlayedProfileId ? 1 : 0;
    return rank(b) - rank(a) || b.createdAt - a.createdAt;
  });
  return list;
}

// ---- Karte -------------------------------------------------------

const LOADER_TINT: Record<string, string> = {
  vanilla: "#8a9a5b",
  fabric: "#5a7bd4",
  forge: "#9a6b3a",
  neoforge: "#c26b2e",
  quilt: "#b45ad0",
};

function loaderLabel(l: ModLoader): string {
  return LOADERS.find((x) => x.key === l)?.label ?? l;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0 || !ts) return "neu";
  const m = 60_000;
  if (d < 45 * m) return "gerade";
  if (d < 22 * 60 * m) return `vor ${Math.round(d / (60 * m))} h`;
  if (d < 12 * 24 * 60 * m) return `vor ${Math.round(d / (24 * 60 * m))} T`;
  if (d < 8 * 7 * 24 * 60 * m) return `vor ${Math.round(d / (7 * 24 * 60 * m))} Wo`;
  return `vor ${Math.round(d / (30 * 24 * 60 * m))} Mon`;
}

function instanceCard(p: Profile, refresh: () => void): HTMLElement {
  const isActive = p.id === store.activeProfileId;
  const running = isRunning(p.id);
  const star = isActive || p.id === store.lastPlayedProfileId;

  const ico = h("button", {
    class: "inst-ico",
    type: "button",
    title: running ? `„${p.name}" stoppen` : `„${p.name}" starten`,
    onclick: (e: Event) => {
      e.stopPropagation();
      if (p.installing) return;
      if (running) void stopProfile(p.id);
      else void playProfile(p);
    },
  }, [
    p.icon
      ? h("img", { class: `inst-ico-glyph inst-pix${p.icon.startsWith("data:") ? "" : " inst-cover"}`, src: p.icon, alt: "" })
      : h("i", { class: "inst-ico-glyph", html: p.fromModpack ? icons.grid : loaderGlyph(p.loader) }),
    h("i", { class: "inst-ico-play", html: running ? icons.stop : icons.play }),
  ]);
  ico.classList.toggle("running", running);
  ico.style.setProperty("--lc", LOADER_TINT[p.loader] ?? "#5b6b7b");

  const gear = h("button", {
    class: "inst-gear",
    type: "button",
    "aria-label": "Optionen",
    html: icons.gear,
    onclick: (e: Event) => {
      e.stopPropagation();
      openCardMenu(e.currentTarget as HTMLElement, p, refresh);
    },
  });

  const card = h("div", { class: `inst-card ${isActive ? "sel" : ""}` }, [
    ico,
    h("div", { class: "grow" }, [
      h("div", { class: "inst-name" }, [
        star ? h("span", { class: "inst-star", textContent: "★" }) : h("span"),
        h("span", { class: "inst-name-txt", textContent: p.name }),
      ]),
      h("div", { class: "inst-meta", textContent: running ? `läuft · ${p.versionId}` : `${p.versionId} · ${ago(p.createdAt)}` }),
    ]),
    gear,
  ]);
  card.dataset.pid = p.id;
  if (p.installing) {
    // Modpack lädt noch: blasser, nicht anklickbar, unten der bunte Balken
    card.classList.add("installing");
    card.append(h("div", { class: "inst-progress" }, [h("i")]));
    paintProgress(card, p.id);
    return card;
  }
  card.addEventListener("click", () => {
    store.activeProfileId = p.id;
    save();
    openId = p.id;
    refresh();
  });
  return card;
}

/** Ladebalken + Text einer Karte auf den aktuellen Stand bringen. */
function paintProgress(card: HTMLElement, id: string): void {
  const job = modpackJob(id);
  const f = jobFraction(job);
  const bar = card.querySelector<HTMLElement>(".inst-progress > i");
  if (bar) bar.style.width = `${Math.max(3, f * 100).toFixed(1)}%`;
  const meta = card.querySelector<HTMLElement>(".inst-meta");
  if (meta) {
    meta.textContent = !job
      ? "Modpack wird geladen…"
      : job.total > 1
        ? `Mods laden · ${job.done}/${job.total} · ${Math.round(f * 100)} %`
        : job.message;
  }
}

function loaderGlyph(l: ModLoader): string {
  if (l === "forge" || l === "neoforge") return icons.plus;
  if (l === "vanilla") return icons.grid;
  return icons.grid;
}

// ---- Karten-Kontextmenü -----------------------------------------

function openCardMenu(anchor: HTMLElement, p: Profile, refresh: () => void): void {
  contextMenu(anchor, [
    {
      label: "Bearbeiten",
      iconHtml: icons.pencil,
      onClick: () => openProfileSettings(p, refresh),
    },
    {
      label: "Duplizieren",
      iconHtml: icons.copy,
      onClick: () => {
        const copy: Profile = {
          ...structuredClone(p),
          id: uid(),
          name: `${p.name} (Kopie)`,
          createdAt: Date.now(),
        };
        store.profiles.push(copy);
        save();
        toast(`„${copy.name}" angelegt`);
        refresh();
      },
    },
    {
      label: "Exportieren",
      iconHtml: icons.upload,
      onClick: () => toast("Export folgt (Backend)"),
    },
    {
      label: "Ordner öffnen",
      iconHtml: icons.folder,
      onClick: () => {
        if (hasTauri) void invokeOpenFolder(p);
        else toast("Nur im Launcher-Fenster");
      },
    },
    "sep",
    {
      label: "Löschen",
      iconHtml: icons.trash,
      danger: true,
      onClick: () => {
        store.profiles = store.profiles.filter((x) => x.id !== p.id);
        if (store.activeProfileId === p.id) store.activeProfileId = store.profiles[0]?.id ?? null;
        if (store.lastPlayedProfileId === p.id) store.lastPlayedProfileId = null;
        save();
        toast(`„${p.name}" gelöscht`);
        refresh();
      },
    },
  ]);
}

async function invokeOpenFolder(p: Profile): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_profile_folder", { id: p.id });
  } catch {
    toast("Ordner öffnen: Backend fehlt noch");
  }
}

// ---- Instanz anlegen ------------------------------------------------

function createProfile(
  data: Partial<Profile> & { name: string; versionId: string; origin: InstanceOrigin },
  activate = true,
): Profile {
  const p: Profile = {
    id: uid(),
    loader: "vanilla",
    content: [],
    createdAt: Date.now(),
    ...data,
  };
  store.profiles.push(p);
  if (activate) store.activeProfileId = p.id;
  save();
  toast(`Instanz „${p.name}" angelegt`);
  return p;
}

function openCreateModal(refresh: () => void, initial: "empty" | "modpack" | "import" = "empty"): void {
  modal(
    "Instanz erstellen",
    (body, close) => {
      const finish = () => {
        close();
        refresh();
      };
      const tabs = [
        { key: "empty", label: "Leer" },
        { key: "modpack", label: "Modpack" },
        { key: "import", label: "Importieren" },
      ];
      if (initial !== "empty") tabs.sort((a) => (a.key === initial ? -1 : 0));
      body.append(
        tabbed(tabs, (key, panel) => {
          if (key === "empty") panel.append(emptyForm(finish));
          else if (key === "modpack") panel.append(modpackBrowser(finish));
          else panel.append(importPane(finish));
        }),
      );
    },
    { wide: true },
  );
}

function emptyForm(done: () => void): HTMLElement {
  const name = h("input", { type: "text", placeholder: "z. B. Fabric 1.21" }) as HTMLInputElement;
  const version = h("select") as HTMLSelectElement;
  for (const v of versions) version.append(h("option", { value: v.id, textContent: v.id }));
  if (versions.length === 0) version.append(h("option", { textContent: "lädt…" }));

  const loader = h("select") as HTMLSelectElement;
  for (const l of LOADERS) loader.append(h("option", { value: l.key, textContent: l.label }));

  // Welcher Client? NUTclient / NUTclient Classic = Fabric + Client-Mod + Standard-Mods, „Ohne Client“ = normales Profil
  let client: ClientVariant = "nutclient";
  const syncLoader = () => {
    const on = client !== "none";
    loader.disabled = on;
    if (on) loader.value = "fabric";
  };
  const clientPick = pickBar(CLIENT_OPTIONS, client, (v) => {
    client = v;
    syncLoader();
  });
  syncLoader();

  return h("div", { class: "skin-form" }, [
    h("div", { class: "field" }, [h("label", { textContent: "Name" }), name]),
    h("div", { class: "field" }, [h("label", { textContent: "Client" }), clientPick.el]),
    h("div", { class: "row", style: "gap:8px" }, [
      h("div", { class: "field", style: "flex:1;margin:0" }, [h("label", { textContent: "Version" }), version]),
      h("div", { class: "field", style: "flex:1;margin:0" }, [h("label", { textContent: "Mod-Loader" }), loader]),
    ]),
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, [
      h("button", {
        class: "btn",
        textContent: "Anlegen",
        onclick: () => {
          if (!name.value.trim()) return toast("Name fehlt", "error");
          const nutclient = client !== "none";
          if (nutclient && !NUTCLIENT_VERSIONS.includes(version.value)) {
            return toast(`NUTclient gibt es für: ${NUTCLIENT_VERSIONS.join(", ")}`, "error");
          }
          createProfile({
            name: name.value.trim(),
            versionId: version.value || "1.21.4",
            loader: nutclient ? "fabric" : (loader.value as ModLoader),
            nutclient,
            clientVariant: client,
            origin: "manual",
          });
          done();
        },
      }),
    ]),
  ]);
}

function modpackBrowser(done: () => void): HTMLElement {
  const search = h("input", { placeholder: "Modpacks suchen…" }) as HTMLInputElement;
  const sb = searchBar(search);
  const results = h("div", { class: "list", style: "max-height:46vh;overflow-y:auto" });

  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    if (results.childElementCount === 0) results.append(h("div", { class: "empty", textContent: "Suche…" }));
    sb.setBusy(true);
    try {
      const page = await searchModrinth(search.value.trim(), "modpack", 0, 20);
      if (mine !== seq) return; // weitergetippt
      sb.setBusy(false);
      sb.setCount(page.total_hits);
      clear(results);
      if (page.hits.length === 0) {
        results.append(h("div", { class: "empty", textContent: "Nichts gefunden." }));
        return;
      }
      for (const hit of page.hits) results.append(modpackCard(hit, done));
    } catch (e) {
      if (mine !== seq) return;
      sb.setBusy(false);
      clear(results);
      results.append(h("p", { class: "hint", textContent: `Modrinth-Fehler: ${e}` }));
    }
  };
  // Live-Suche wie im Mods-Panel: kurz nach dem letzten Tastendruck, Enter sofort
  let timer = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 260);
  });
  search.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      window.clearTimeout(timer);
      void run();
    }
  });

  const el = h("div", { class: "skin-form" }, [
    h("div", { class: "row", style: "gap:8px" }, [sb.el]),
    h("p", { class: "hint", style: "margin:10px 0 0", textContent: "Ein Modpack legt eine eigene Instanz an." }),
    results,
  ]);
  void run();
  return el;
}

function modpackCard(hit: ModrinthHit, done: () => void): HTMLElement {
  return h("div", { class: "card" }, [
    h("img", {
      class: "thumb",
      src:
        hit.icon_url ||
        "data:image/svg+xml;utf8," +
          encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44'><rect width='44' height='44' fill='%233a3a42'/></svg>`),
      alt: "",
    }),
    h("div", { class: "grow" }, [
      h("div", { class: "title", textContent: hit.title }),
      h("div", { class: "sub", textContent: hit.description }),
    ]),
    h("button", {
      class: "btn sm",
      textContent: "Erstellen",
      onclick: () => {
        const p = createProfile({
          name: hit.title,
          versionId: "…",
          loader: "fabric",
          fromModpack: hit.title,
          origin: "modrinth",
          modpackId: hit.project_id,
          installing: true,
          icon: hit.icon_url || undefined,
          iconName: hit.title,
        });
        void startModpackInstall(p);
        done();
      },
    }),
  ]);
}

// ---- Import ---------------------------------------------------------

function importPane(done: () => void): HTMLElement {

  const clientList = h("div", { class: "list" });
  for (const c of CLIENTS) {
    clientList.append(
      h("div", { class: "card" }, [
        h("div", { class: "grow" }, [
          h("div", { class: "title", textContent: c.label }),
          h("div", {
            class: "sub",
            textContent:
              (c.suggestions.length ? `Vorschläge: ${c.suggestions.join(", ")} · ` : "") +
              `${c.note} · Erkennung folgt`,
          }),
        ]),
        h("button", {
          class: "btn ghost sm",
          textContent: "Importieren",
          onclick: () => askImportMode(c.id, c.label, done),
        }),
      ]),
    );
  }

  return h("div", { class: "skin-form" }, [
    h("div", { class: "field" }, [
      h("label", { textContent: "Aus Datei (Modrinth .mrpack / CurseForge .zip)" }),
      h("p", {
        class: "hint",
        style: "margin:0",
        textContent:
          "Fenster schließen und die Datei einfach ins Select-Fenster ziehen – die Mods werden automatisch geladen (mit Ladebalken).",
      }),
    ]),
    h("div", { class: "divider" }),
    h("h4", { textContent: "Aus einem anderen Client", style: "margin:0 0 8px;font-size:13px" }),
    clientList,
  ]);
}

function askImportMode(origin: InstanceOrigin, label: string, done: () => void): void {
  modal(`${label} einbinden`, (body, close) => {
    body.append(
      h("p", {
        class: "hint",
        style: "margin-top:0",
        textContent: `Wie soll „${label}" in NUTclient laufen?`,
      }),
      h("div", { class: "list" }, [
        choice(
          "Nur über unseren Launcher starten",
          "Der Client bleibt unverändert – NUTclient startet ihn nur und verwaltet das Konto. Einstellungen, Mods und Skins bleiben beim Client.",
          () => {
            createProfile({
              name: `${label} (über NUTclient)`,
              versionId: "—",
              loader: "vanilla",
              origin,
              importMode: "wrapper",
            });
            close();
            done();
          },
        ),
        choice(
          "Einstellungen & Inhalte importieren",
          "NUTclient legt eine eigene Instanz an und übernimmt Version, Mod-Loader, Mods, options.txt und Tastenbelegung. Der Original-Client bleibt unangetastet.",
          () => {
            createProfile({
              name: `${label} – importiert`,
              versionId: "1.21.4",
              loader: origin === "lunar" ? "vanilla" : "fabric",
              origin,
              importMode: "merged",
            });
            close();
            done();
          },
        ),
      ]),
    );
  });
}

function choice(title: string, desc: string, onClick: () => void): HTMLElement {
  const card = h("div", { class: "card selectable", style: "flex-direction:column;align-items:stretch;gap:4px" }, [
    h("div", { class: "title", textContent: title }),
    h("div", { class: "sub", style: "white-space:normal", textContent: desc }),
  ]);
  card.addEventListener("click", onClick);
  return card;
}
