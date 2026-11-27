// Detailansicht einer Instanz (Klick auf eine Karte in „Select“): Kopf mit Spielen-Knopf, Kennzahlen,
// links die Inhalte mit Schaltern, rechts die Bereiche (Mods, Pakete, Welten …). Dateien (.jar/.zip) lassen sich in die
// offene Instanz ziehen; eigene Dateien stehen mit in der Liste und lassen sich wie Modrinth-Inhalte entfernen.
import { h, clear, modal, toast, searchBar } from "../ui";
import { save, type Profile, type ContentEntry, type ContentKind, type ModLoader } from "../state";
import { icons } from "../icons";
import { active as activeAccount } from "../account";
import { playProfile } from "../play";
import {
  blockTextures,
  searchModrinth,
  hasTauri,
  openInstanceFolder,
  listInstanceFiles,
  importInstanceFile,
  removeInstanceFile,
  listInstanceMods,
  setInstanceFileEnabled,
  installContent,
  launchLoader,
  type InstanceFolder,
  type ModrinthHit,
} from "../launcher/api";

export interface DetailActions {
  /** Zurück zur Liste. */
  back: () => void;
  /** Instanz-Einstellungen öffnen. */
  edit: () => void;
  /** Ansicht neu zeichnen (nach Bereichswechsel, Schaltern, …). */
  refresh: () => void;
}

type TabKey = ContentKind | "screenshots" | "logs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "mod", label: "Mods" },
  { key: "resourcepack", label: "Ressourcenpakete" },
  { key: "shader", label: "Shader" },
  { key: "datapack", label: "Datenpakete" },
  { key: "world", label: "Welten" },
  { key: "screenshots", label: "Screenshots" },
  { key: "logs", label: "Logs" },
];

const EMPTY_HINT: Record<TabKey, string> = {
  mod: "Noch keine Mods. Über „Mods hinzufügen“ kommst du zur Suche – oder zieh eine .jar-Datei hierher.",
  resourcepack: "Keine Ressourcenpakete in dieser Instanz. Eine .zip-Datei hierher ziehen fügt eins hinzu.",
  shader: "Keine Shader in dieser Instanz. Eine Shader-.zip hierher ziehen fügt einen hinzu (Iris kommt beim Start mit).",
  datapack: "Keine Datenpakete in dieser Instanz.",
  world: "Keine Welten in dieser Instanz.",
  screenshots: "Screenshots aus dem Spiel erscheinen hier.",
  logs: "Die Logs dieser Instanz liegen im Spielordner unter „logs“.",
  modpack: "Keine Modpacks in dieser Instanz.",
};

const LOADER_TINT: Record<ModLoader, string> = {
  vanilla: "#8a9a5b",
  fabric: "#5a7bd4",
  forge: "#9a6b3a",
  neoforge: "#c26b2e",
  quilt: "#b45ad0",
};

const LOADER_NAME: Record<ModLoader, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  forge: "Forge",
  quilt: "Quilt",
  neoforge: "NeoForge",
};

/** Aktiver Bereich und Suchtext bleiben über Neuzeichnungen erhalten. */
let tab: TabKey = "mod";
let search = "";

export function resetDetail(): void {
  tab = "mod";
  search = "";
  adding = false;
  addQuery = "";
}

/** Unterordner für eigene Dateien je Bereich. */
const FOLDER: Partial<Record<TabKey, InstanceFolder>> = {
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
};

const FOLDER_TAB: Record<string, TabKey> = { mods: "mod", resourcepacks: "resourcepack", shaderpacks: "shader" };

/** Offene Instanz – für Dateien, die ins Fenster gezogen werden. */
let dropTarget: { p: Profile; act: DetailActions } | null = null;
let dropReady = false;

/** Einmal anmelden: Dateien, die auf das Fenster gezogen werden, landen in der offenen Instanz. */
async function listenForDrops(): Promise<void> {
  if (dropReady || !hasTauri) return;
  dropReady = true;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent(async (e) => {
    const view = document.querySelector(".inst-detail");
    const t = e.payload.type;
    if (!view || !dropTarget) return;
    if (t === "enter" || t === "over") {
      view.classList.add("drop");
      return;
    }
    view.classList.remove("drop");
    if (t !== "drop") return;
    const { p, act } = dropTarget;
    let last: InstanceFolder | null = null;
    for (const path of e.payload.paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      try {
        const r = await importInstanceFile(p.id, p.versionId, p.loader, path);
        last = r.folder;
        const twin = r.replacedBy;
        if (twin) {
          // NeoForge/Forge-Datei läuft mit Fabric nicht – stattdessen die Fabric-Fassung von Modrinth
          if (!p.content.some((c) => c.projectId === twin.projectId)) {
            p.content.push({ projectId: twin.projectId, title: twin.title, kind: "mod", source: "modrinth" });
            save();
            void installContent(p.id, p.versionId, twin.projectId, "mod", p.loader).catch(() => {});
          }
          toast(`„${name}“ ist für ${twin.loader} – stattdessen die ${LOADER_NAME[launchLoader(p.loader)]}-Fassung „${twin.title}“ hinzugefügt`);
        } else {
          toast(`„${name}“ zu „${p.name}“ hinzugefügt`);
        }
      } catch (err) {
        toast(`${err}`, "error");
      }
    }
    if (last && FOLDER_TAB[last]) tab = FOLDER_TAB[last];
    act.refresh();
  });
}

export function renderInstanceDetail(p: Profile, act: DetailActions): HTMLElement {
  const wide = document.querySelector(".panel")?.classList.contains("expanded") ?? false;
  const root = h("div", { class: `inst-detail ${wide ? "inst-wide" : ""}` });
  dropTarget = { p, act };
  void listenForDrops();
  root.append(header(p, act), stats(p));
  root.append(h("div", { class: "inst-cols" }, [listColumn(p, act), tabColumn(p, act)]));
  return root;
}

// ---- Kopf --------------------------------------------------------

function header(p: Profile, act: DetailActions): HTMLElement {
  const back = h("button", { class: "inst-back", type: "button", onclick: act.back }, [
    h("span", { textContent: "←" }),
    h("span", { textContent: "Zurück" }),
    h("span", { class: "inst-back-sep", textContent: "/" }),
    h("span", { class: "inst-back-name", textContent: p.name }),
  ]);

  const ico = h("button", {
    class: "inst-hero-ico",
    type: "button",
    title: "Profilbild ändern",
    onclick: () => openIconPicker(p, act.refresh),
  });
  if (p.icon) ico.append(h("img", { class: "inst-pix", src: p.icon, alt: p.iconName ?? "" }));
  else ico.innerHTML = icons.grid;
  ico.style.setProperty("--lc", LOADER_TINT[p.loader] ?? "#5b6b7b");

  const badges = h("div", { class: "inst-badges" }, [
    badge(p.versionId),
    badge(LOADER_NAME[p.loader] ?? p.loader),
    p.nutclient ? badge("NUTclient", "accent") : null,
    p.fromModpack ? badge(p.fromModpack) : null,
    accountBadge(),
  ].filter((x): x is HTMLElement => x !== null));

  const play = h("button", { class: "inst-play", type: "button", onclick: () => void playProfile(p) }, [
    h("i", { class: "inst-play-ico", html: icons.play }),
    h("span", { textContent: "Spielen" }),
  ]);

  const folder = h("button", {
    class: "inst-hero-gear",
    type: "button",
    "aria-label": "Ordner öffnen",
    title: "Ordner öffnen",
    html: icons.folder,
    onclick: () => openInstanceFolder(p.id).catch((e) => toast(`Ordner: ${e}`, "error")),
  });

  const gear = h("button", {
    class: "inst-hero-gear",
    type: "button",
    "aria-label": "Instanz-Einstellungen",
    title: "Einstellungen",
    html: icons.gear,
    onclick: act.edit,
  });

  return h("div", { class: "inst-head" }, [
    back,
    h("div", { class: "inst-hero" }, [
      ico,
      h("div", { class: "inst-hero-main" }, [h("h2", { class: "inst-hero-name", textContent: p.name }), badges]),
      h("div", { class: "inst-hero-act" }, [play, folder, gear]),
    ]),
  ]);
}

function badge(text: string, kind?: "accent"): HTMLElement {
  return h("span", { class: `inst-badge ${kind ?? ""}`, textContent: text });
}

function accountBadge(): HTMLElement | null {
  const a = activeAccount();
  return a ? h("span", { class: "inst-badge inst-acc", textContent: a.username }) : null;
}

// ---- Kennzahlen -------------------------------------------------

function stats(p: Profile): HTMLElement {
  return h("div", { class: "inst-stats" }, [
    stat("Zuletzt gespielt", p.lastPlayedAt ? ago(p.lastPlayedAt) : "noch nie"),
    stat("Erstellt", ago(p.createdAt)),
    stat("Inhalte", String(p.content.length)),
  ]);
}

function stat(label: string, value: string): HTMLElement {
  return h("div", { class: "inst-stat" }, [
    h("div", { class: "inst-stat-l", textContent: label }),
    h("div", { class: "inst-stat-v", textContent: value }),
  ]);
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0 || !ts) return "gerade";
  const m = 60_000;
  if (d < 45 * m) return "gerade";
  if (d < 22 * 60 * m) return `vor ${Math.round(d / (60 * m))} h`;
  if (d < 12 * 24 * 60 * m) return `vor ${Math.round(d / (24 * 60 * m))} Tagen`;
  if (d < 8 * 7 * 24 * 60 * m) return `vor ${Math.round(d / (7 * 24 * 60 * m))} Wochen`;
  return `vor ${Math.round(d / (30 * 24 * 60 * m))} Monaten`;
}

// ---- Linke Spalte: Inhalte mit Schaltern -------------------------

function listColumn(p: Profile, act: DetailActions): HTMLElement {
  if (adding && tab === "mod") return addColumn(p, act);
  const list = h("div", { class: "inst-list" });
  const input = h("input", { placeholder: "Inhalte durchsuchen…" }) as HTMLInputElement;
  input.value = search;
  const sb = searchBar(input, { small: true });

  const paint = () => {
    clear(list);
    const q = search.trim().toLowerCase();
    const items = p.content.filter((c) => c.kind === tab && (!q || c.title.toLowerCase().includes(q)));
    if (items.length === 0) {
      list.append(h("div", { class: "empty", textContent: q ? "Nichts gefunden." : EMPTY_HINT[tab] }));
      return;
    }
    for (const c of items) list.append(contentRow(c, () => {
      save();
      act.refresh();
    }, () => {
      p.content = p.content.filter((x) => x !== c);
      save();
      toast(`„${c.title}“ entfernt`);
      act.refresh();
    }));
    void paintFiles(q, items.length);
  };
  // eigene Dateien (hineingezogen) unter den Modrinth-Inhalten
  let fileSeq = 0;
  const paintFiles = async (q: string, shown: number) => {
    const folder = FOLDER[tab];
    if (!folder) return;
    const mine = ++fileSeq;
    let files: string[] = [];
    try {
      files = await listInstanceFiles(p.id, folder);
    } catch {
      return;
    }
    if (mine !== fileSeq) return;
    const hits = files.filter((n) => !q || n.toLowerCase().includes(q));
    if (hits.length === 0) return;
    // Mods: Name/Version aus der Jar (Modpacks!), sonst nur Dateinamen
    let rows: { file: string; name: string; sub: string; enabled: boolean; bad: boolean }[];
    if (folder === "mods") {
      const infos = await listInstanceMods(p.id, launchLoader(p.loader)).catch(() => []);
      if (mine !== fileSeq) return;
      rows = infos
        .filter((m) => !q || m.name.toLowerCase().includes(q) || m.file.toLowerCase().includes(q))
        .map((m) => ({
          file: m.file,
          name: m.name,
          enabled: m.enabled,
          bad: !!m.foreign,
          sub: m.foreign
            ? `${m.foreign}-Mod – passt nicht zum Loader dieser Instanz, wird nicht geladen`
            : [p.fromModpack ? `aus ${p.fromModpack}` : "Eigene Datei", m.version].filter(Boolean).join(" · "),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      rows = hits.map((n) => ({
        file: n,
        name: n.replace(/\.disabled$/i, ""),
        enabled: !n.toLowerCase().endsWith(".disabled"),
        bad: false,
        sub: "Eigene Datei",
      }));
    }
    ownCount.set(`${p.id}|${tab}`, rows.length);
    updateTabCount(tab, p);
    if (rows.length === 0) return;
    if (shown === 0) list.querySelector(".empty")?.remove();
    for (const r of rows) {
      list.append(fileRow(r, async (on) => {
        try {
          await setInstanceFileEnabled(p.id, folder, r.file, on);
        } catch (e) {
          toast(`${e}`, "error");
        }
        paint();
      }, async () => {
        try {
          await removeInstanceFile(p.id, folder, r.file);
          toast(`„${r.name}“ in den Papierkorb gelegt`);
        } catch (e) {
          toast(`${e}`, "error");
        }
        act.refresh();
      }));
    }
  };
  input.addEventListener("input", () => {
    search = input.value;
    paint();
  });
  paint();

  const bar = h("div", { class: "inst-leftbar" }, [sb.el]);
  if (tab === "mod") {
    bar.append(h("button", {
      class: "inst-add",
      type: "button",
      textContent: "＋ Mods hinzufügen",
      onclick: () => {
        adding = true;
        act.refresh();
      },
    }));
  }
  return h("div", { class: "inst-left" }, [bar, list]);
}

/** Hinzufügen-Modus: Modrinth-Suche, nur Fabric-Mods für die Version dieser Instanz. */
let adding = false;
let addQuery = "";

function addColumn(p: Profile, act: DetailActions): HTMLElement {
  const results = h("div", { class: "inst-list" });
  const input = h("input", { placeholder: `Mods für ${p.versionId} suchen…` }) as HTMLInputElement;
  input.value = addQuery;
  const sb = searchBar(input, { small: true });

  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    // alte Treffer bleiben stehen, bis die neuen da sind (kein Flackern beim Tippen)
    if (results.childElementCount === 0) results.append(h("div", { class: "empty", textContent: "Suche…" }));
    sb.setBusy(true);
    try {
      const page = await searchModrinth(addQuery, "mod", 0, 30, [
        [`versions:${p.versionId}`],
        [`categories:${launchLoader(p.loader)}`],
      ]);
      if (mine !== seq) return;
      sb.setBusy(false);
      sb.setCount(page.total_hits);
      clear(results);
      if (page.hits.length === 0) {
        results.append(h("div", { class: "empty", textContent: `Keine ${LOADER_NAME[launchLoader(p.loader)]}-Mods für ${p.versionId} gefunden.` }));
        return;
      }
      for (const hit of page.hits) results.append(addRow(p, hit));
    } catch (e) {
      if (mine !== seq) return;
      sb.setBusy(false);
      clear(results);
      results.append(h("div", { class: "empty", textContent: `Suche fehlgeschlagen: ${e}` }));
    }
  };
  let timer: number | undefined;
  input.addEventListener("input", () => {
    addQuery = input.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 300);
  });
  void run();

  const done = h("button", {
    class: "inst-add",
    type: "button",
    textContent: "Fertig",
    onclick: () => {
      adding = false;
      act.refresh();
    },
  });
  return h("div", { class: "inst-left" }, [
    h("div", { class: "inst-leftbar" }, [sb.el, done]),
    h("div", { class: "inst-add-hint", textContent: "Mods werden gleich heruntergeladen (mit Abhängigkeiten) – ein laufendes Spiel braucht einen Neustart." }),
    results,
  ]);
}

function addRow(p: Profile, hit: ModrinthHit): HTMLElement {
  const has = () => p.content.some((c) => c.projectId === hit.project_id);
  const btn = h("button", { class: `inst-add-btn ${has() ? "on" : ""}`, type: "button" });
  const paintBtn = () => {
    btn.textContent = has() ? "✓ Drin" : "Hinzufügen";
    btn.classList.toggle("on", has());
  };
  paintBtn();
  btn.addEventListener("click", () => {
    if (has()) {
      p.content = p.content.filter((c) => c.projectId !== hit.project_id);
    } else {
      p.content.push({ projectId: hit.project_id, title: hit.title, kind: "mod", source: "modrinth" });
      void installContent(p.id, p.versionId, hit.project_id, "mod", p.loader).catch((e) => toast(`„${hit.title}“: ${e}`, "error"));
    }
    save();
    paintBtn();
  });
  const ico = hit.icon_url
    ? h("img", { class: "inst-row-img", src: hit.icon_url, alt: "" })
    : h("div", { class: "inst-row-ico", textContent: hit.title.slice(0, 1).toUpperCase() });
  return h("div", { class: "inst-row" }, [
    ico,
    h("div", { class: "grow" }, [
      h("div", { class: "inst-row-title", textContent: hit.title }),
      h("div", { class: "inst-row-sub", textContent: `${hit.author} · ${hit.description}` }),
    ]),
    btn,
  ]);
}

/** Anzahl eigener Dateien je Instanz und Bereich (für die Zahl am Tab, wird nach dem Laden nachgetragen). */
const ownCount = new Map<string, number>();

function tabCount(p: Profile, key: TabKey): number {
  return p.content.filter((c) => c.kind === key).length + (ownCount.get(`${p.id}|${key}`) ?? 0);
}

function updateTabCount(key: TabKey, p: Profile): void {
  const btn = document.querySelector<HTMLElement>(`.inst-tab[data-key="${key}"]`);
  if (!btn) return;
  const n = tabCount(p, key);
  let badge = btn.querySelector<HTMLElement>(".inst-tab-n");
  if (n > 0 && !badge) {
    badge = h("span", { class: "inst-tab-n" });
    btn.append(badge);
  }
  if (badge) {
    if (n > 0) badge.textContent = String(n);
    else badge.remove();
  }
}

/** Eigene Datei (hineingezogen oder aus einem Modpack): Name, Version/Herkunft, Schalter, Entfernen. */
function fileRow(
  r: { file: string; name: string; sub: string; enabled: boolean; bad: boolean },
  toggle: (on: boolean) => void,
  remove: () => void,
): HTMLElement {
  const sw = h("button", {
    class: `inst-switch ${r.enabled ? "on" : ""}`,
    type: "button",
    role: "switch",
    "aria-checked": String(r.enabled),
    title: r.enabled ? "Aktiv" : "Aus",
    onclick: (e: Event) => {
      e.stopPropagation();
      toggle(!r.enabled);
    },
  }, [h("span", { class: "inst-switch-knob" })]);
  return h("div", { class: `inst-row ${r.bad ? "inst-bad" : ""} ${r.enabled ? "" : "off"}`, title: r.file }, [
    h("div", { class: "inst-row-ico", textContent: r.name.slice(0, 1).toUpperCase() }),
    h("div", { class: "grow" }, [
      h("div", { class: "inst-row-title", textContent: r.name }),
      h("div", { class: "inst-row-sub", textContent: r.sub }),
    ]),
    sw,
    removeButton(remove),
  ]);
}

function removeButton(remove: () => void): HTMLElement {
  return h("button", {
    class: "inst-remove",
    type: "button",
    title: "Entfernen",
    "aria-label": "Entfernen",
    html: icons.trash,
    onclick: (e: Event) => {
      e.stopPropagation();
      remove();
    },
  });
}

function contentRow(c: ContentEntry, changed: () => void, remove: () => void): HTMLElement {
  const on = c.enabled !== false;
  const sw = h("button", {
    class: `inst-switch ${on ? "on" : ""}`,
    type: "button",
    role: "switch",
    "aria-checked": String(on),
    title: on ? "Aktiv" : "Aus",
    onclick: (e: Event) => {
      e.stopPropagation();
      c.enabled = !on;
      changed();
    },
  }, [h("span", { class: "inst-switch-knob" })]);
  return h("div", { class: `inst-row ${on ? "" : "off"}` }, [
    h("div", { class: "inst-row-ico", textContent: c.title.slice(0, 1).toUpperCase() }),
    h("div", { class: "grow" }, [
      h("div", { class: "inst-row-title", textContent: c.title }),
      h("div", {
        class: "inst-row-sub",
        textContent: `${c.source === "curseforge" ? "CurseForge" : "Modrinth"} · ${TABS.find((t) => t.key === c.kind)?.label ?? c.kind}`,
      }),
    ]),
    sw,
    removeButton(remove),
  ]);
}

// ---- Rechte Spalte: Bereiche ---------------------------------------

function tabColumn(p: Profile, act: DetailActions): HTMLElement {
  const col = h("div", { class: "inst-tabs" });
  for (const t of TABS) {
    const count = tabCount(p, t.key);
    col.append(h("button", {
      class: `inst-tab ${tab === t.key ? "on" : ""}`,
      type: "button",
      "data-key": t.key,
      onclick: () => {
        tab = t.key;
        search = "";
        act.refresh();
      },
    }, [
      h("span", { class: "inst-tab-l", textContent: t.label }),
      ...(count > 0 ? [h("span", { class: "inst-tab-n", textContent: String(count) })] : []),
    ]));
  }
  return col;
}

// ---- Profilbild: Blocktextur aus Minecraft ---------------------------

let textures: { name: string; url: string }[] | null = null;

function openIconPicker(p: Profile, refresh: () => void): void {
  modal("Profilbild wählen", (body, close) => {
    const input = h("input", { placeholder: "Block suchen (z. B. grass, diamond, oak)…" }) as HTMLInputElement;
    const sb = searchBar(input, { small: true });
    const grid = h("div", { class: "inst-icon-grid" });
    const paint = () => {
      clear(grid);
      const q = input.value.trim().toLowerCase().replace(/\s+/g, "_");
      const list = (textures ?? []).filter((t) => !q || t.name.includes(q)).slice(0, 400);
      if (list.length === 0) {
        grid.append(h("div", { class: "empty", textContent: "Keine passende Textur." }));
        return;
      }
      for (const t of list) {
        grid.append(h("button", {
          class: `inst-icon-cell ${p.iconName === t.name ? "on" : ""}`,
          type: "button",
          title: t.name.replace(/_/g, " "),
          onclick: () => {
            p.icon = t.url;
            p.iconName = t.name;
            save();
            close();
            refresh();
          },
        }, [h("img", { class: "inst-pix", src: t.url, alt: t.name })]));
      }
    };
    input.addEventListener("input", paint);
    const none = h("button", {
      class: "inst-add",
      type: "button",
      textContent: "Kein Bild",
      onclick: () => {
        delete p.icon;
        delete p.iconName;
        save();
        close();
        refresh();
      },
    });
    body.append(h("div", { class: "inst-leftbar" }, [sb.el, none]), grid);
    if (textures) {
      paint();
      return;
    }
    grid.append(h("div", { class: "empty", textContent: hasTauri ? "Texturen werden geladen…" : "Nur in der Launcher-App verfügbar." }));
    blockTextures()
      .then((list) => {
        textures = list;
        if (list.length === 0) {
          clear(grid);
          grid.append(h("div", { class: "empty", textContent: hasTauri ? "Keine Texturen gefunden." : "Nur in der Launcher-App verfügbar." }));
          return;
        }
        paint();
      })
      .catch((e) => {
        clear(grid);
        grid.append(h("div", { class: "empty", textContent: String(e) }));
      });
  }, { wide: true });
}
