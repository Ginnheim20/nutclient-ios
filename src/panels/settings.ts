import { h, clear, toast, searchBar } from "../ui";
import { store, save } from "../state";
import { applyTheme } from "../theme";
import {
  GLASS_PRESETS,
  glassColor,
  isHex,
  normalizeHex,
  applyGlassColor,
  applyGlassStrength,
} from "../glasscolor";
import { runSlimeCommand } from "../slime";
import { startTutorial } from "../tutorial";
import { retryDeviceSearch } from "../devicesync";
import { clearBackground, hasCustomBackground, setBackgroundFromFile } from "../background";
import {
  addBgVideo,
  listBgVideos,
  activeBgVideoId,
  setActiveBgVideo,
  removeBgVideo,
} from "../bgvideo";

// ---- kleine Helfer ------------------------------------------------
const hint = (t: string): HTMLElement => h("span", { class: "hint", textContent: t });
/** Zeile mit Titel links und Bedienelement rechts (wie in den Einstellungen von Modrinth-Clients). */
const field = (label: string, body: (HTMLElement | string)[]): HTMLElement =>
  h("div", { class: "set-block" }, [h("div", { class: "set-row-title", textContent: label }), ...body]);
const toggleRow = (input: HTMLInputElement, label: string): HTMLElement =>
  h("div", { class: "set-row" }, [
    h("div", { class: "set-row-txt" }, [h("div", { class: "set-row-title", textContent: label })]),
    h("label", { class: "switch" }, [input, h("span")]),
  ]);
const sectionId = (title: string): string => `set-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
const section = (title: string, items: HTMLElement[]): HTMLElement =>
  h("section", { class: "set-group", id: sectionId(title) }, [
    h("h3", { class: "set-group-title", textContent: title }),
    ...items,
  ]);

export function renderSettings(mount: HTMLElement): void {
  clear(mount);
  const s = store.settings;

  const theme = h("select", {}, [
    h("option", { value: "dark", textContent: "Dunkel" }),
    h("option", { value: "light", textContent: "Hell" }),
  ]) as HTMLSelectElement;
  theme.value = s.theme;
  theme.onchange = () => {
    s.theme = theme.value as "dark" | "light";
    save();
    applyTheme();
    applyGlassStrength(); // Glas-Grundfarben hängen am Theme
  };

  // ---- Glasfarbe: kurze Presets + eigene Farbe / Hex ----
  const curId = s.glassColor;
  const setColor = (id: string, rerender = true): void => {
    s.glassColor = id;
    save();
    applyGlassColor();
    if (rerender) renderSettings(mount);
  };

  const swatchRow = h("div", { class: "swatch-row" });
  for (const c of GLASS_PRESETS) {
    const sw = h("button", {
      class: `swatch ${curId === c.id ? "active" : ""}`,
      type: "button",
      title: c.label,
      "aria-label": c.label,
      onclick: () => setColor(c.id),
    });
    sw.style.setProperty("--sw", c.accent);
    swatchRow.append(sw);
  }

  const colorInput = h("input", { type: "color" }) as HTMLInputElement;
  colorInput.value = isHex(curId) ? curId : glassColor().accent;
  colorInput.oninput = () => {
    s.glassColor = colorInput.value;
    applyGlassColor();
  };
  colorInput.onchange = () => setColor(colorInput.value);
  const customSw = h("button", {
    class: `swatch swatch-custom ${isHex(curId) ? "active" : ""}`,
    type: "button",
    title: "Eigene Farbe",
    "aria-label": "Eigene Farbe wählen",
    onclick: () => colorInput.click(),
  }, [colorInput]);
  swatchRow.append(customSw);

  const hexInput = h("input", {
    class: "swatch-hex",
    type: "text",
    placeholder: "#33aa55",
    spellcheck: false,
    autocomplete: "off",
  }) as HTMLInputElement;
  hexInput.value = isHex(curId) ? curId : "";
  hexInput.onchange = () => {
    const n = normalizeHex(hexInput.value);
    if (!n) {
      toast("Ungültiger Farbcode – z. B. #33aa55", "error");
      hexInput.value = isHex(s.glassColor) ? s.glassColor : "";
      return;
    }
    setColor(n);
  };
  const hexRow = h("div", { class: "swatch-row" }, [
    h("span", { class: "swatch-hue", textContent: "Hex" }),
    hexInput,
  ]);

  const glassStrength = h("input", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.02",
  }) as HTMLInputElement;
  glassStrength.value = String(s.glassStrength ?? 0.1);
  glassStrength.style.flex = "1";
  const glassStrengthLabel = h("span", { class: "hint", textContent: `${Math.round((s.glassStrength ?? 0.1) * 100)} %` });
  glassStrengthLabel.style.cssText = "margin:0;min-width:5.5ch;text-align:right";
  glassStrength.oninput = () => {
    s.glassStrength = Number(glassStrength.value);
    glassStrengthLabel.textContent = `${Math.round(s.glassStrength * 100)} %`;
    applyGlassStrength();
  };
  glassStrength.onchange = () => save();
  const lo = hint("Durchsichtig");
  const hi = hint("Blickdicht");
  lo.style.margin = "0";
  hi.style.margin = "0";
  const strengthRow = h("div", { class: "row" }, [lo, glassStrength, hi, glassStrengthLabel]);

  const mediaWidget = h("input", { type: "checkbox" }) as HTMLInputElement;
  mediaWidget.checked = s.mediaWidget !== false;
  mediaWidget.onchange = () => {
    s.mediaWidget = mediaWidget.checked;
    save();
  };

  const ram = h("input", { type: "range", min: "1024", max: "16384", step: "512" }) as HTMLInputElement;
  ram.value = String(s.maxRamMb);
  ram.style.flex = "1";
  const ramLabel = h("span", { textContent: `${(s.maxRamMb / 1024).toFixed(1)} GB` });
  ram.oninput = () => {
    s.maxRamMb = Number(ram.value);
    ramLabel.textContent = `${(s.maxRamMb / 1024).toFixed(1)} GB`;
  };
  ram.onchange = () => save();

  const java = h("input", { type: "text", placeholder: "Automatisch", value: s.javaPath }) as HTMLInputElement;
  java.onchange = () => {
    s.javaPath = java.value.trim();
    save();
  };

  const dir = h("input", { type: "text", placeholder: "Standard-Verzeichnis", value: s.gameDir }) as HTMLInputElement;
  dir.onchange = () => {
    s.gameDir = dir.value.trim();
    save();
  };

  const close = h("input", { type: "checkbox" }) as HTMLInputElement;
  close.checked = s.closeOnLaunch;
  close.onchange = () => {
    s.closeOnLaunch = close.checked;
    save();
  };

  const bgFile = h("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
  bgFile.onchange = async () => {
    const f = bgFile.files?.[0];
    if (!f) return;
    try {
      await setBackgroundFromFile(f);
      toast("Hintergrundbild gesetzt");
      renderSettings(mount);
    } catch (e) {
      toast(`${e}`, "error");
    }
  };
  const bgReset = hasCustomBackground()
    ? h("button", {
        class: "btn ghost sm",
        type: "button",
        textContent: "Auf Standard zurücksetzen",
        onclick: () => {
          clearBackground();
          toast("Hintergrund zurückgesetzt");
          renderSettings(mount);
        },
      })
    : hint("oder Datei als public/background.jpg ablegen");
  if (bgReset instanceof HTMLButtonElement) bgReset.style.cssText = "align-self:flex-start;margin-top:6px";

  // --- Hintergrundvideo (stumme Dauerschleife) ---
  const vidList = h("div", { class: "list" });
  vidList.style.marginTop = "8px";
  const vidFile = h("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  vidFile.onchange = async () => {
    const f = vidFile.files?.[0];
    if (!f) return;
    vidFile.value = "";
    try {
      await addBgVideo(f);
      toast(`Hintergrundvideo „${f.name}" läuft`);
      await fillVideoList();
    } catch (e) {
      toast(`${e}`, "error");
    }
  };

  async function fillVideoList(): Promise<void> {
    clear(vidList);
    const vids = await listBgVideos();
    const activeId = activeBgVideoId();

    const row = (label: string, on: boolean, activate: () => void, opts: { del?: () => void; tag?: string } = {}) => {
      const tagEl = on
        ? h("span", { class: "hint", textContent: "aktiv" })
        : opts.tag
          ? h("span", { class: "hint", textContent: opts.tag })
          : h("span");
      if (tagEl.classList.contains("hint")) tagEl.style.margin = "0";
      const card = h("div", { class: `card selectable ${on ? "selected" : ""}` }, [
        h("div", { class: "grow" }, [h("div", { class: "title", textContent: label })]),
        tagEl,
      ]);
      card.addEventListener("click", activate);
      if (opts.del) {
        card.append(
          h("button", {
            class: "btn ghost sm",
            textContent: "✕",
            title: "Entfernen",
            onclick: (e: Event) => {
              e.stopPropagation();
              opts.del!();
            },
          }),
        );
      }
      return card;
    };

    vidList.append(
      row("Kein Video", !activeId, () => {
        void setActiveBgVideo(null).then(fillVideoList);
      }),
    );
    for (const v of vids) {
      vidList.append(
        row(v.name, v.id === activeId, () => void setActiveBgVideo(v.id).then(fillVideoList), {
          tag: v.preset ? "Standard" : undefined,
          del: v.preset ? undefined : () => void removeBgVideo(v.id).then(fillVideoList),
        }),
      );
    }
  }
  void fillVideoList();

  const syncBtn = h("button", {
    class: "btn ghost sm",
    type: "button",
    textContent: "Gerätesuche wiederholen",
    onclick: () => void retryDeviceSearch(),
  });
  syncBtn.style.alignSelf = "flex-start";

  const tutBtn = h("button", {
    class: "btn ghost sm",
    type: "button",
    textContent: "Jeffs Tour noch mal zeigen",
    onclick: () => startTutorial(),
  });
  tutBtn.style.alignSelf = "flex-start";

  const cfKey = h("input", {
    type: "text",
    placeholder: "$2a$10$…",
    onchange: () => toast("Key-Speicher folgt (verschlüsselt im Backend)"),
  });

  // ---- Aufbau: links Navigation + Suche, rechts die Abschnitte ----
  const groupsEl = h("div", { class: "set-groups" }, [
      section("Darstellung", [
        field("Design", [theme]),
        field("Glasfarbe", [
          swatchRow,
          hexRow,
          hint("Kurze Auswahl oder eigene Farbe / Hex-Code. Färbt Glas sowie ausgewählte und aktive Symbole."),
        ]),
        field("Glasstärke", [
          strengthRow,
          hint("Regler nach rechts macht das Glas dicker – bis komplett blickdicht, ohne Durchsicht und Reflexe."),
        ]),
      ]),
      section("Hintergrund", [
        field("Hintergrundbild", [bgFile, bgReset]),
        field("Hintergrundvideo", [
          vidFile,
          hint("Läuft stumm in Dauerschleife hinter der Oberfläche. Mehrere Videos möglich – eines auswählen."),
          vidList,
        ]),
      ]),
      section("Leiste", [
        field("Systemwiedergabe", [
          toggleRow(mediaWidget, "Songs/Videos & Discord-Call in der Leiste zeigen"),
          hint("Zeigt, was gerade auf dem PC läuft (Spotify/YouTube/…) und ob du in einem Discord-Call bist."),
        ]),
      ]),
      section("Spiel", [
        field("Arbeitsspeicher (max.)", [h("div", { class: "row" }, [ram, ramLabel])]),
        field("Java-Pfad", [java]),
        field("Spielverzeichnis", [dir]),
        toggleRow(close, "Launcher beim Start schließen"),
      ]),
      section("Hilfe", [
        field("Tutorial", [tutBtn, hint("Jeff hüpft durch den Launcher und erklärt kurz das Wichtigste.")]),
        field("Geräte im WLAN", [
          syncBtn,
          hint("Läuft der Launcher auf einem zweiten Gerät im selben WLAN, fragt er, ob Profile, Konten und Einstellungen übertragen werden sollen. Ausgeblendete Geräte erscheinen hiermit wieder."),
        ]),
        field("Konsole", [
          buildConsole(),
          hint("Befehle fürs Schleim-Spiel: /reset setzt es komplett zurück, /help zeigt alle."),
        ]),
      ]),
      section("Erweitert", [
        field("CurseForge API-Key", [cfKey]),
        h("p", { class: "hint", textContent: "Version: 0.1.0 · Grundgerüst" }),
      ]),
  ]);

  const titles = ["Darstellung", "Hintergrund", "Leiste", "Spiel", "Hilfe", "Erweitert"];
  const search = h("input", { placeholder: "Suchen…" }) as HTMLInputElement;
  const sb = searchBar(search, { small: true });
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const sec of groupsEl.querySelectorAll<HTMLElement>(".set-group")) {
      let any = false;
      for (const child of sec.querySelectorAll<HTMLElement>(":scope > .set-block, :scope > .set-row")) {
        const hit = !q || child.textContent!.toLowerCase().includes(q);
        child.hidden = !hit;
        any = any || hit;
      }
      sec.hidden = !any && !!q;
    }
  });
  const nav = h("nav", { class: "set-nav" }, [
    sb.el,
    ...titles.map((t) =>
      h("button", {
        class: "set-nav-item",
        type: "button",
        textContent: t,
        onclick: () => document.getElementById(sectionId(t))?.scrollIntoView({ behavior: "smooth", block: "start" }),
      }),
    ),
  ]);

  mount.append(h("div", { class: "set-shell" }, [nav, groupsEl]));
}

/** Kleine Konsole: Eingabezeile + Ausgabe-Log, leitet an runSlimeCommand weiter. */
function buildConsole(): HTMLElement {
  const out = h("div", { class: "mcl-console-out" });
  const inp = h("input", {
    class: "mcl-console-in",
    type: "text",
    placeholder: "/help",
    spellcheck: false,
    autocomplete: "off",
  }) as HTMLInputElement;

  const log = (text: string, cls = "res"): void => {
    if (!text) return;
    for (const ln of text.split("\n")) {
      out.append(h("div", { class: `mcl-console-line ${cls}`, textContent: ln }));
    }
    out.scrollTop = out.scrollHeight;
  };

  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = inp.value.trim();
    inp.value = "";
    if (!v) return;
    log(`> ${v}`, "cmd");
    if (v === "/clear" || v === "clear") {
      out.textContent = "";
      return;
    }
    log(runSlimeCommand(v));
  });

  const body = h("div", { class: "mcl-console", hidden: true }, [out, inp]);
  const toggle = h("button", {
    class: "btn ghost sm mcl-console-toggle",
    type: "button",
    textContent: "Konsole öffnen",
  });
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? "Konsole öffnen" : "Konsole schließen";
    if (!body.hidden && !out.childElementCount) log("NUTclient-Konsole – /help für Befehle.");
    if (!body.hidden) inp.focus();
  });

  return h("div", { class: "mcl-console-wrap" }, [toggle, body]);
}
