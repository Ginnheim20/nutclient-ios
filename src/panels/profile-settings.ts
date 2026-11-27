// Profil-Einstellungen als großes Liquid-Glass-Fenster: füllt die Fläche rechts neben der Leiste, dahinter ist alles
// außer dem Hintergrundbild ausgeblendet (Skin, Spielen-Knopf, Panel, Schleim). Links Bereiche, rechts die Felder,
// unten Abbrechen / Änderungen speichern. Profilwerte werden erst mit „Änderungen speichern“ übernommen; Aktionen wie
// Ordner teilen, Exportieren oder Modpack neu laden passieren sofort.
import { h, clear, toast, pickBar } from "../ui";
import { icons } from "../icons";
import { store, save, clientOf, CLIENT_OPTIONS, type Profile, type ModLoader, type ClientVariant } from "../state";
import {
  listVersions,
  loaderVersions,
  openInstanceFolder,
  exportMrpack,
  sharedFolders,
  setSharedFolder,
  launchLoader,
  hasTauri,
  NUTCLIENT_VERSIONS,
} from "../launcher/api";
import type { VersionSummary } from "../launcher/types";
import { startModpackInstall } from "../modpacks";

const LOADERS: { key: ModLoader; label: string; note?: string }[] = [
  { key: "vanilla", label: "Vanilla" },
  { key: "fabric", label: "Fabric" },
  { key: "neoforge", label: "NeoForge" },
  { key: "quilt", label: "Quilt", note: "startet mit Fabric" },
  { key: "forge", label: "Forge", note: "nicht unterstützt" },
];

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  install: svg('<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
  nut: svg('<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="3"/>'),
  mem: svg('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7V4M11 7V4M15 7V4M19 7V4M7 17v3M11 17v3M15 17v3M19 17v3"/>'),
  win: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
};

/** Teilbare Ordner mit Erklärung. */
const SHARE_INFO: { key: string; label: string; sub: string }[] = [
  { key: "saves", label: "Welten", sub: "Einzelspieler-Welten – in allen geteilten Profilen dieselben." },
  { key: "resourcepacks", label: "Ressourcenpakete", sub: "Einmal hineinlegen, überall auswählbar." },
  { key: "shaderpacks", label: "Shader", sub: "Shader-Pakete für Iris/OptiFine." },
  { key: "screenshots", label: "Screenshots", sub: "Alle Bilder an einem Ort." },
  { key: "schematics", label: "Schematics", sub: "Litematica-/WorldEdit-Baupläne." },
];

let versionCache: VersionSummary[] = [];

/** Glas-Schalter wie in den Launcher-Einstellungen. */
function switchEl(checked: boolean, disabled = false): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", checked, disabled }) as HTMLInputElement;
  return { el: h("label", { class: "switch" }, [input, h("span")]), input };
}

const block = (title: string, hint: string | null, ...body: (HTMLElement | null)[]): HTMLElement =>
  h("div", { class: "pset-block" }, [
    h("div", { class: "pset-block-title", textContent: title }),
    ...(body.filter(Boolean) as HTMLElement[]),
    hint ? h("div", { class: "pset-hint", textContent: hint }) : h("span"),
  ]);

const row = (title: string, sub: string, control: HTMLElement, extra = ""): HTMLElement =>
  h("div", { class: `pset-row glass ${extra}` }, [
    h("div", { class: "grow" }, [
      h("div", { class: "pset-row-title", textContent: title }),
      h("div", { class: "pset-hint", textContent: sub }),
    ]),
    control,
  ]);

const glassBtn = (html: string, onclick: () => void, extra = ""): HTMLElement =>
  h("button", { class: `pset-gbtn glass ${extra}`, type: "button", html, onclick });

export function openProfileSettings(p: Profile, refresh: () => void): void {
  document.querySelector(".pset")?.remove();

  // ---- Entwurf (wird erst beim Speichern übernommen) ----
  const d = {
    name: p.name,
    versionId: p.versionId,
    loader: p.loader,
    loaderVersion: p.loaderVersion ?? "",
    client: clientOf(p) as ClientVariant,
    ramMb: p.ramMb,
    jvmArgs: p.jvmArgs ?? "",
    width: p.width,
    height: p.height,
    fullscreen: !!p.fullscreen,
  };

  // ---- Allgemein ----
  const general = (): HTMLElement[] => {
    const name = h("input", { type: "text", class: "pset-input", value: d.name }) as HTMLInputElement;
    name.oninput = () => (d.name = name.value);
    const ico = p.icon
      ? h("img", { class: `pset-ico${p.icon.startsWith("data:") ? " pix" : ""}`, src: p.icon, alt: "" })
      : h("div", { class: "pset-ico", html: icons.grid });
    const facts: [string, string][] = [
      ["Minecraft", p.versionId],
      ["Loader", LOADERS.find((l) => l.key === p.loader)?.label ?? p.loader],
      ["Client", CLIENT_OPTIONS.find((o) => o.value === clientOf(p))?.label ?? "—"],
      ["Angelegt", new Date(p.createdAt).toLocaleDateString("de-DE")],
    ];
    if (p.lastPlayedAt) facts.push(["Zuletzt gespielt", new Date(p.lastPlayedAt).toLocaleString("de-DE")]);
    if (p.fromModpack) facts.push(["Modpack", p.fromModpack]);
    return [
      h("div", { class: "pset-head" }, [
        ico,
        h("div", { class: "grow" }, [h("div", { class: "pset-block-title", textContent: "Name" }), name]),
      ]),
      h("div", { class: "pset-facts" }, facts.map(([k, v]) =>
        h("div", { class: "pset-fact glass" }, [h("span", { textContent: k }), h("b", { textContent: v })]),
      )),
      h("div", { class: "pset-id", textContent: `Instanz-ID: ${p.id}` }),
    ];
  };

  // ---- Installation: Version, Loader, Loader-Version, Modpack ----
  const installation = (): HTMLElement[] => {
    const version = h("select", { class: "pset-input" }) as HTMLSelectElement;
    const fillVersions = () => {
      clear(version);
      const ids = versionCache.map((v) => v.id);
      if (!ids.includes(d.versionId)) ids.unshift(d.versionId);
      for (const id of ids) version.append(h("option", { value: id, textContent: id }));
      version.value = d.versionId;
    };
    fillVersions();
    if (versionCache.length === 0) {
      listVersions()
        .then((v) => {
          versionCache = v.filter((x) => x.type === "release");
          fillVersions();
        })
        .catch(() => {});
    }

    const loaderBox = h("div", { class: "pset-chips" });
    const paintLoaders = () => {
      clear(loaderBox);
      for (const l of LOADERS) {
        const locked = d.client !== "none" && l.key !== "fabric";
        loaderBox.append(h("button", {
          class: `pset-chip glass ${d.loader === l.key ? "on" : ""}`,
          type: "button",
          disabled: locked,
          title: locked ? "Mit NUTclient immer Fabric (unter „NUT“ ausschalten)" : l.note ?? "",
          textContent: l.label,
          onclick: () => {
            d.loader = l.key;
            d.loaderVersion = "";
            paintLoaders();
            void loadLoaderVersions();
          },
        }));
      }
    };
    paintLoaders();

    // eigene Loader-Version
    const own = switchEl(!!d.loaderVersion);
    const lv = h("select", { class: "pset-input" }) as HTMLSelectElement;
    const lvHint = h("div", { class: "pset-hint" });
    let seq = 0;
    const loadLoaderVersions = async () => {
      const mine = ++seq;
      const ld = launchLoader(d.loader);
      const usesLoader = d.loader !== "vanilla";
      own.input.disabled = !usesLoader;
      lv.disabled = !usesLoader || !own.input.checked;
      clear(lv);
      if (!usesLoader) {
        lvHint.textContent = "Vanilla hat keinen Loader.";
        return;
      }
      lv.append(h("option", { value: "", textContent: "Lädt …" }));
      const list = await loaderVersions(d.versionId, ld).catch(() => [] as [string, boolean][]);
      if (mine !== seq) return;
      clear(lv);
      if (list.length === 0) {
        lv.append(h("option", { value: "", textContent: hasTauri ? "Keine gefunden" : "Nur im Launcher" }));
      }
      for (const [v, stable] of list) lv.append(h("option", { value: v, textContent: stable ? v : `${v} (Beta)` }));
      if (d.loaderVersion && !list.some(([v]) => v === d.loaderVersion)) {
        lv.prepend(h("option", { value: d.loaderVersion, textContent: d.loaderVersion }));
      }
      lv.value = d.loaderVersion || (list.find(([, s]) => s)?.[0] ?? list[0]?.[0] ?? "");
      lvHint.textContent = own.input.checked
        ? "Diese Version wird beim Start benutzt."
        : `Aus = immer die neueste stabile ${ld === "neoforge" ? "NeoForge" : "Fabric"}-Version.`;
    };
    own.input.onchange = () => {
      d.loaderVersion = own.input.checked ? lv.value : "";
      void loadLoaderVersions();
    };
    lv.onchange = () => (d.loaderVersion = lv.value);
    version.onchange = () => {
      d.versionId = version.value;
      d.loaderVersion = "";
      own.input.checked = false;
      void loadLoaderVersions();
    };
    void loadLoaderVersions();

    const items: HTMLElement[] = [
      block("Minecraft-Version", null, version),
      block("Mod-Loader", d.client !== "none" ? "Mit NUTclient immer Fabric." : null, loaderBox),
      row("Eigene Loader-Version", "Bestimmte Fabric-/NeoForge-Version statt der neuesten benutzen.", own.el),
      h("div", {}, [lv, lvHint]),
      h("div", { class: "pset-sep" }),
      row(
        "Spielordner",
        "Mods, Welten, Screenshots und Einstellungen dieser Instanz.",
        glassBtn(`${icons.folder}<span>Ordner öffnen</span>`, () => void openInstanceFolder(p.id).catch((e) => toast(String(e), "error"))),
      ),
      row(
        "Als Modpack exportieren",
        "Speichert die Instanz als .mrpack in „Downloads“. Freunde ziehen die Datei in ihr Select-Fenster und bekommen alle Mods und Einstellungen. Konten und persönliche Daten kommen nicht mit.",
        glassBtn(`${ICON.share}<span>Exportieren</span>`, () => void doExport()),
      ),
    ];
    if (p.modpackId || p.modpackFile) {
      items.push(
        row(
          "Modpack neu laden",
          "Lädt fehlende oder beschädigte Dateien des Modpacks nach. Geänderte Configs aus dem Pack werden überschrieben.",
          glassBtn(`${icons.refresh}<span>Neu laden</span>`, () => {
            shut();
            void startModpackInstall(p);
            refresh();
          }),
        ),
      );
    }
    if (p.missingMods?.length) {
      items.push(
        block(
          `Nicht gefundene Mods (${p.missingMods.length})`,
          "Gibt es nur auf CurseForge – kommen mit dem CurseForge-Zugang dazu.",
          h("div", { class: "pset-list", textContent: p.missingMods.join(" · ") }),
        ),
      );
    }
    return items;
  };

  let exporting = false;
  async function doExport(): Promise<void> {
    if (exporting) return;
    exporting = true;
    toast(`„${p.name}“ wird exportiert …`);
    try {
      const path = await exportMrpack({
        profileId: p.id,
        name: p.name,
        mc: p.versionId,
        loader: launchLoader(p.loader),
        loaderVersion: p.loaderVersion || undefined,
      });
      toast(`Exportiert: ${path}`);
    } catch (e) {
      toast(`Export fehlgeschlagen: ${e}`, "error");
    } finally {
      exporting = false;
    }
  }

  // ---- NUT: welcher Client (Auswahlleiste wie die Suchleiste) ----
  const nut = (): HTMLElement[] => {
    const hint = h("div", { class: "pset-hint" });
    const paintHint = () => {
      const ok = NUTCLIENT_VERSIONS.includes(d.versionId);
      hint.classList.toggle("pset-warn", d.client !== "none" && !ok);
      hint.textContent =
        d.client === "none"
          ? "Startet ohne NUTclient – nur deine Mods bzw. Vanilla."
          : ok
            ? `Gibt es für ${NUTCLIENT_VERSIONS.join(", ")}. Startet immer mit Fabric.`
            : `Für Minecraft ${d.versionId} gibt es keinen NUTclient (nur ${NUTCLIENT_VERSIONS.join(", ")}). Unter „Installation“ eine passende Version wählen.`;
    };
    const pick = pickBar(CLIENT_OPTIONS, d.client, (v) => {
      d.client = v;
      if (v !== "none") d.loader = "fabric";
      paintHint();
    });
    paintHint();
    return [
      block("Client", null, pick.el),
      hint,
      row("Nur einzelne Funktionen", "Selbst aussuchen, welche Teile des NUTclient mitkommen.", h("span", { class: "pset-soon-inline", textContent: "bald" }), "soon"),
    ];
  };

  // ---- Java & Arbeitsspeicher ----
  const memory = (): HTMLElement[] => {
    const own = switchEl(d.ramMb != null);
    const ram = h("input", { type: "range", min: "1024", max: "16384", step: "512" }) as HTMLInputElement;
    const label = h("span", { class: "pset-value" });
    const sync = () => {
      const v = d.ramMb ?? store.settings.maxRamMb;
      ram.value = String(v);
      ram.disabled = d.ramMb == null;
      label.textContent = `${(v / 1024).toFixed(1)} GB${d.ramMb == null ? " (Standard)" : ""}`;
    };
    own.input.onchange = () => {
      d.ramMb = own.input.checked ? Number(ram.value) : undefined;
      sync();
    };
    ram.oninput = () => {
      d.ramMb = Number(ram.value);
      sync();
    };
    sync();
    const jvm = h("input", {
      type: "text",
      class: "pset-input",
      placeholder: "z. B. -XX:+UseG1GC -XX:MaxGCPauseMillis=50",
      value: d.jvmArgs,
    }) as HTMLInputElement;
    jvm.oninput = () => (d.jvmArgs = jvm.value);
    return [
      row("Eigener Arbeitsspeicher", "Aus = Wert aus Einstellungen → Spiel. Große Modpacks brauchen 6–8 GB.", own.el),
      h("div", { class: "pset-ram" }, [ram, label]),
      block("Java-Argumente", "Nur für Fortgeschrittene – zusätzliche Schalter für Java, mit Leerzeichen getrennt.", jvm),
    ];
  };

  // ---- Fenster ----
  const windowPage = (): HTMLElement[] => {
    const num = (v: number | undefined, ph: string, set: (n: number | undefined) => void) => {
      const i = h("input", { type: "number", class: "pset-input", min: "320", placeholder: ph }) as HTMLInputElement;
      if (v) i.value = String(v);
      i.oninput = () => set(i.value ? Math.max(0, Math.round(Number(i.value))) : undefined);
      return i;
    };
    const full = switchEl(d.fullscreen);
    full.input.onchange = () => (d.fullscreen = full.input.checked);
    return [
      h("div", { class: "pset-two" }, [
        block("Breite", null, num(d.width, "854", (n) => (d.width = n))),
        block("Höhe", null, num(d.height, "480", (n) => (d.height = n))),
      ]),
      h("div", { class: "pset-hint", textContent: "Leer = Minecraft-Standard. Gilt nur, wenn beide Werte gesetzt sind." }),
      row("Im Vollbild starten", "Minecraft öffnet direkt im Vollbild.", full.el),
    ];
  };

  // ---- Geteilte Ordner (Symlinks) ----
  const sharing = (): HTMLElement[] => {
    const list = h("div", { class: "pset-stack" });
    const paint = (on: string[]) => {
      clear(list);
      for (const f of SHARE_INFO) {
        const sw = switchEl(on.includes(f.key), !hasTauri);
        sw.input.onchange = async () => {
          sw.input.disabled = true;
          try {
            await setSharedFolder(p.id, f.key, sw.input.checked);
            toast(sw.input.checked ? `„${f.label}“ wird jetzt geteilt` : `„${f.label}“ ist wieder eigen (Inhalt kopiert)`);
          } catch (e) {
            sw.input.checked = !sw.input.checked;
            toast(String(e), "error");
          }
          sw.input.disabled = false;
        };
        list.append(row(f.label, f.sub, sw.el));
      }
    };
    paint([]);
    void sharedFolders(p.id).then(paint).catch(() => {});
    return [
      h("div", {
        class: "pset-hint pset-lead",
        textContent:
          "Geteilte Ordner sind für alle Profile gleich, die denselben Ordner teilen (Verknüpfung auf einen gemeinsamen Ordner). Beim Einschalten wandert der Inhalt dorthin, beim Ausschalten bekommt das Profil eine Kopie. Wirkt sofort.",
      }),
      list,
    ];
  };

  const pages: { key: string; label: string; icon: string; render: () => HTMLElement[] }[] = [
    { key: "general", label: "Allgemein", icon: icons.gear, render: general },
    { key: "install", label: "Installation", icon: ICON.install, render: installation },
    { key: "nut", label: "NUT", icon: ICON.nut, render: nut },
    { key: "memory", label: "Java & Arbeitsspeicher", icon: ICON.mem, render: memory },
    { key: "window", label: "Fenster", icon: ICON.win, render: windowPage },
    { key: "links", label: "Geteilte Ordner", icon: ICON.link, render: sharing },
  ];

  const nav = h("nav", { class: "pset-nav" });
  const body = h("div", { class: "pset-body" });
  const show = (key: string) => {
    for (const b of nav.children) {
      const on = (b as HTMLElement).dataset.key === key;
      (b as HTMLElement).classList.toggle("on", on);
      (b as HTMLElement).classList.toggle("glass", on);
    }
    clear(body);
    const page = pages.find((x) => x.key === key)!;
    body.append(h("h3", { class: "pset-page-title", textContent: page.label }), ...page.render());
    body.scrollTop = 0;
  };
  for (const pg of pages) {
    nav.append(
      h("button", { class: "pset-tab", type: "button", "data-key": pg.key, onclick: () => show(pg.key) }, [
        h("i", { html: pg.icon }),
        h("span", { textContent: pg.label }),
      ]),
    );
  }

  const saveBtn = h("button", { class: "pset-gbtn glass accent", type: "button", textContent: "Änderungen speichern" });
  const card = h("div", { class: "pset-card dialog" }, [
    h("div", { class: "pset-top" }, [
      h("div", { class: "pset-title", textContent: "Profil-Einstellungen" }),
      h("div", { class: "pset-sub", textContent: p.name }),
      h("button", {
        class: "pset-x glass",
        type: "button",
        "aria-label": "Schließen",
        html: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
        onclick: () => shut(),
      }),
    ]),
    h("div", { class: "pset-main" }, [nav, body]),
    h("div", { class: "pset-foot" }, [
      h("button", { class: "pset-gbtn glass", type: "button", textContent: "Abbrechen", onclick: () => shut() }),
      saveBtn,
    ]),
  ]);
  const overlay = h("div", { class: "pset" }, [card]);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) shut();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      shut();
    }
  };
  function shut(): void {
    if (overlay.classList.contains("closing")) return;
    // weich zuklappen, dann entfernen
    overlay.classList.add("closing");
    window.setTimeout(() => overlay.remove(), 260);
    document.body.classList.remove("pset-open");
    document.removeEventListener("keydown", onKey, true);
  }

  saveBtn.onclick = () => {
    const name = d.name.trim();
    if (!name) {
      show("general");
      return toast("Name fehlt", "error");
    }
    if (d.client !== "none" && !NUTCLIENT_VERSIONS.includes(d.versionId)) {
      show("nut");
      return toast(`NUTclient gibt es für: ${NUTCLIENT_VERSIONS.join(", ")} – unter „Installation“ eine davon wählen oder NUTclient ausschalten`, "error");
    }
    const label = CLIENT_OPTIONS.find((o) => o.value === d.client)?.label ?? "";
    if (d.client !== clientOf(p) && d.client !== "none") toast(`${label} kommt beim nächsten Start von „${name}“ dazu`);
    p.name = name;
    p.versionId = d.versionId;
    p.clientVariant = d.client;
    p.nutclient = d.client !== "none";
    p.loader = d.client !== "none" ? "fabric" : d.loader;
    p.loaderVersion = d.loaderVersion.trim() || undefined;
    p.ramMb = d.ramMb;
    p.jvmArgs = d.jvmArgs.trim() || undefined;
    p.width = d.width && d.width >= 320 ? d.width : undefined;
    p.height = d.height && d.height >= 240 ? d.height : undefined;
    p.fullscreen = d.fullscreen || undefined;
    save();
    toast(`„${name}“ gespeichert`);
    shut();
    refresh();
  };

  document.addEventListener("keydown", onKey, true);
  document.body.classList.add("pset-open");
  document.body.append(overlay);
  show("general");
}
