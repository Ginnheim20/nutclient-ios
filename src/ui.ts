// Kleine DOM-Helfer + Panel-/Toast-/Menü-Steuerung.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & {
    class?: string;
    html?: string;
    [k: `data-${string}`]: string;
    [k: `aria-${string}`]: string;
  } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v as string;
    else if (k === "html") el.innerHTML = v as string;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k.includes("-")) {
      // data-* / aria-* → echtes Attribut
      el.setAttribute(k, String(v));
    } else (el as any)[k] = v;
  }
  for (const c of children) el.append(c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---- Suchleiste ------------------------------------------------------------

export interface SearchBar {
  el: HTMLElement;
  /** Trefferzahl rechts im Feld (`null` = ausblenden). */
  setCount(n: number | null): void;
  /** Lichtstreifen unten, solange gesucht wird. */
  setBusy(on: boolean): void;
}

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></svg>';
const CLEAR_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * Suchleiste im Glasdesign um ein vorhandenes Eingabefeld: Glas-Kapsel mit buntem, kreisendem Rand, Lupe,
 * Leeren-Knopf (✕, auch Esc), Aufleuchten beim Tippen. Leeren löst ein normales `input`-Ereignis aus, die
 * Seite reagiert also wie beim Tippen. `small` = kompakte Fassung (z. B. Einstellungen).
 */
export function searchBar(input: HTMLInputElement, opts: { small?: boolean } = {}): SearchBar {
  input.type = "text";
  input.className = "msearch-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  const count = h("span", { class: "msearch-count" });
  const clearIt = () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  const el = h("div", { class: `msearch ${opts.small ? "small" : ""}` }, [
    h("span", { class: "msearch-icon", html: SEARCH_SVG }),
    input,
    count,
    h("button", { class: "msearch-clear", type: "button", title: "Leeren", html: CLEAR_SVG, onclick: clearIt }),
    h("span", { class: "msearch-load" }),
  ]);
  const sync = () => el.classList.toggle("has-text", input.value.length > 0);
  input.addEventListener("input", () => {
    sync();
    el.classList.remove("pulse");
    void el.offsetWidth; // Aufleuchten neu starten
    el.classList.add("pulse");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      clearIt();
    }
  });
  sync();
  return {
    el,
    setCount: (n) => {
      count.textContent = n == null || !Number.isFinite(n) ? "" : `${n.toLocaleString("de-DE")} Treffer`;
    },
    setBusy: (on) => el.classList.toggle("busy", on),
  };
}

// ---- Panel-Overlay -----------------------------------------------------
// Alle Bereiche (Freunde, Neuigkeiten, Select, Skins, Mods, Einstellungen)
// schieben sich als Seitenpanel über die Bühne. Oben ein Schließen-Icon,
// danach ist wieder das Hauptmenü (die Bühne) zu sehen.

const host = () => document.getElementById("panel-host")!;
const body = () => document.getElementById("panel-body")!;
const titleEl = () => document.getElementById("panel-title")!;

let currentPanel: string | null = null;
type PanelRenderer = (mount: HTMLElement) => void | (() => void);
let cleanup: (() => void) | void;

const WIDE_KEY = "mcl.panel.wide";
let panelWide = false;
try {
  panelWide = localStorage.getItem(WIDE_KEY) === "1";
} catch {
  /* kein Speicher */
}

/** Ist das aktuelle Seitenpanel auf volle Breite aufgeklappt? */
export function isPanelExpanded(): boolean {
  return panelWide;
}

function applyPanelWide(): void {
  document.getElementById("panel")?.classList.toggle("expanded", panelWide);
  const edge = document.getElementById("panel-edge");
  if (edge) edge.title = panelWide ? "Verkleinern" : "Vergrößern";
}

/** Panel zwischen schmal und voller Breite umschalten (Pfeil am Panel-Rand). */
export function togglePanelExpand(): void {
  panelWide = !panelWide;
  try {
    localStorage.setItem(WIDE_KEY, panelWide ? "1" : "0");
  } catch {
    /* egal */
  }
  applyPanelWide();
  peekEdge();
  body().dispatchEvent(new CustomEvent("panelresize", { detail: { expanded: panelWide } }));
}

export function openPanel(id: string, title: string, render: PanelRenderer): void {
  if (currentPanel === id) {
    closePanel();
    return;
  }
  currentPanel = id;
  titleEl().textContent = title;
  clear(body());
  if (typeof cleanup === "function") cleanup();
  cleanup = render(body() as HTMLElement);
  applyPanelWide();
  host().hidden = false;
  document.body.classList.add("panel-open");
  peekEdge();
  syncRail();
}

export function closePanel(): void {
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  currentPanel = null;
  host().hidden = true;
  document.body.classList.remove("panel-open");
  syncRail();
}

/** Einklapp-Pfeil kurz einblenden (z. B. nach dem Öffnen/Vergrößern). */
function peekEdge(): void {
  const edge = document.getElementById("panel-edge");
  if (!edge) return;
  edge.classList.add("near");
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    if (!edgeCursorNear) edge.classList.remove("near");
  }, 1600);
}
let peekTimer = 0;
let edgeCursorNear = false;

/** Zurück zum Startbildschirm (Bühne mit Skin) – schließt das Panel. */
export function goHome(): void {
  closePanel();
}

function syncRail(): void {
  document.querySelectorAll<HTMLElement>(".rail-btn").forEach((b) => {
    const key = b.dataset.panel;
    b.classList.toggle("active", !!key && key === currentPanel);
  });
  document
    .querySelector<HTMLElement>('.rail-btn[data-nav="home"]')
    ?.classList.toggle("active", !currentPanel);
}

export function initPanelHost(): void {
  host().addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#panel-edge")) {
      togglePanelExpand();
      return;
    }
    if (t.hasAttribute("data-close") || t.classList.contains("panel-backdrop")) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !host().hidden) closePanel();
  });

  // Einklapp-Pfeil nur zeigen, wenn die Maus in seiner Nähe ist (Vollbild-Panel).
  const edge = document.getElementById("panel-edge");
  document.addEventListener(
    "mousemove",
    (e) => {
      if (host().hidden || !panelWide || !edge) return;
      const r = edge.getBoundingClientRect();
      const near =
        e.clientX >= r.left - 120 &&
        e.clientX <= r.right + 30 &&
        e.clientY >= r.top - 90 &&
        e.clientY <= r.bottom + 90;
      edgeCursorNear = near;
      edge.classList.toggle("near", near);
    },
    { passive: true },
  );

  applyPanelWide();
  syncRail();
}

// ---- Toast --------------------------------------------------------------

export function toast(text: string, kind: "info" | "error" = "info"): void {
  const t = h("div", { class: `toast ${kind === "error" ? "error" : ""}`, textContent: text });
  document.getElementById("toast-host")!.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.3s";
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

// ---- Modal (großer Dialog mit eigenem Inhalt) -------------------------

/**
 * Öffnet ein Overlay-Modal. `build` bekommt den Inhaltscontainer und eine
 * `close`-Funktion. Rückgabe: `close` (z. B. für "fertig, schließen").
 */
export function modal(
  title: string,
  build: (body: HTMLElement, close: () => void) => void,
  opts: { wide?: boolean } = {},
): () => void {
  const body = h("div", { class: "modal-body" });
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey);
  };
  const box = h("div", { class: `dialog modal${opts.wide ? " wide" : ""}` }, [
    h("div", { class: "modal-head" }, [
      h("h3", { textContent: title, style: "margin:0;font-size:15px" }),
      h("button", { class: "panel-close", textContent: "✕", onclick: close, "aria-label": "Schließen" }),
    ]),
    body,
  ]);
  const back = h("div", { class: "dialog-back" }, [box]);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  document.body.append(back);
  build(body, close);
  return close;
}

/**
 * Reiterleiste für Modals: ruft `render(key, panel)` beim Wechsel auf.
 * Gibt das Wrapper-Element zurück (Leiste + Panel).
 */
export function tabbed(
  tabs: { key: string; label: string }[],
  render: (key: string, panel: HTMLElement) => void,
): HTMLElement {
  const bar = h("div", { class: "tabs" });
  const panel = h("div", { class: "tab-panel" });
  let active = tabs[0]?.key;
  const select = (key: string) => {
    active = key;
    bar.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.key === key);
    });
    clear(panel);
    render(key, panel);
  };
  for (const t of tabs) {
    bar.append(
      h("button", {
        class: `tab ${t.key === active ? "active" : ""}`,
        textContent: t.label,
        "data-key": t.key,
        onclick: () => select(t.key),
      }),
    );
  }
  const wrap = h("div", {}, [bar, panel]);
  if (active) select(active);
  return wrap;
}

// ---- Mini-Eingabedialog ------------------------------------------------

export function promptDialog(
  title: string,
  opts: { placeholder?: string; confirm?: string; initial?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", {
      type: "text",
      placeholder: opts.placeholder ?? "",
      value: opts.initial ?? "",
    }) as HTMLInputElement;

    const close = (val: string | null) => {
      back.remove();
      resolve(val);
    };
    const box = h("div", { class: "dialog" }, [
      h("h3", { textContent: title, style: "margin:0 0 12px;font-size:15px" }),
      input,
      h("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:14px" }, [
        h("button", { class: "btn ghost sm", textContent: "Abbrechen", onclick: () => close(null) }),
        h("button", {
          class: "btn sm",
          textContent: opts.confirm ?? "OK",
          onclick: () => close(input.value.trim() || null),
        }),
      ]),
    ]);
    const back = h("div", { class: "dialog-back" }, [box]);
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") close(input.value.trim() || null);
      if ((e as KeyboardEvent).key === "Escape") close(null);
    });
    document.body.append(back);
    input.focus();
  });
}

// ---- Kontextmenü (Konto/Profil-Kurzwahl) --------------------------------

export interface MenuItem {
  label: string;
  /** Bild-URL (z. B. Konto-Kopf) */
  icon?: string;
  /** Inline-SVG (z. B. aus icons.ts) */
  iconHtml?: string;
  danger?: boolean;
  onClick: () => void;
}

export function contextMenu(anchor: HTMLElement, items: (MenuItem | "sep")[]): void {
  document.querySelector(".menu")?.remove();
  const menu = h("div", { class: "menu" });
  for (const it of items) {
    if (it === "sep") {
      menu.append(h("div", { class: "sep" }));
      continue;
    }
    const ico = it.iconHtml
      ? `<i class="mi">${it.iconHtml}</i>`
      : it.icon
        ? `<img src="${it.icon}" alt="">`
        : "";
    menu.append(
      h("button", {
        class: it.danger ? "danger" : "",
        html: ico + `<span>${it.label}</span>`,
        onclick: () => {
          menu.remove();
          it.onClick();
        },
      }),
    );
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const top = r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${top}px`;
  const off = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) {
      menu.remove();
      document.removeEventListener("mousedown", off);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", off));
}

// ---- Auswahlleiste (wie die Suchleiste geformt) ---------------------------------------------------------------

export interface PickOption<T extends string> {
  value: T;
  label: string;
  sub?: string;
  /** Noch nicht wählbar (z. B. „bald“). */
  disabled?: boolean;
  badge?: string;
}

/**
 * Auswahl in der Form der Suchleiste (`.msearch`: Glas-Kapsel mit buntem Rand). Zeigt die aktuelle Wahl; ein Klick
 * klappt darunter eine Glas-Liste auf, in der man scrollt und einen Eintrag anklickt. Esc oder Klick daneben schließt.
 */
export function pickBar<T extends string>(
  options: PickOption<T>[],
  value: T,
  onChange: (v: T) => void,
  opts: { icon?: string; placeholder?: string } = {},
): { el: HTMLElement; set: (v: T) => void } {
  let current = value;
  const label = h("div", { class: "pick-label" });
  const sub = h("div", { class: "pick-sub" });
  const list = h("div", { class: "pick-list", role: "listbox" });
  const el = h("div", { class: "msearch pick", tabIndex: 0, role: "combobox", "aria-expanded": "false" }, [
    h("span", { class: "msearch-icon", html: opts.icon ?? `<svg viewBox="0 0 24 24"><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="3"/></svg>` }),
    h("div", { class: "pick-text" }, [label, sub]),
    h("span", { class: "pick-chev", html: `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>` }),
  ]);
  const paint = () => {
    const o = options.find((x) => x.value === current);
    label.textContent = o?.label ?? opts.placeholder ?? "Auswählen …";
    sub.textContent = o?.sub ?? "";
    sub.hidden = !o?.sub;
    clear(list);
    for (const opt of options) {
      list.append(
        h("button", {
          class: `pick-item ${opt.value === current ? "on" : ""}`,
          type: "button",
          role: "option",
          disabled: !!opt.disabled,
          onclick: (e: Event) => {
            e.stopPropagation();
            if (opt.disabled) return;
            current = opt.value;
            paint();
            close();
            onChange(opt.value);
          },
        }, [
          h("div", { class: "pick-item-txt" }, [
            h("div", { class: "pick-item-label", textContent: opt.label }),
            opt.sub ? h("div", { class: "pick-item-sub", textContent: opt.sub }) : h("span"),
          ]),
          opt.badge ? h("span", { class: "pick-badge", textContent: opt.badge }) : h("span"),
          h("span", { class: "pick-check", textContent: opt.value === current ? "✓" : "" }),
        ]),
      );
    }
  };
  const onDoc = (e: Event) => {
    if (!el.contains(e.target as Node) && !list.contains(e.target as Node)) close();
  };
  // Liste liegt beim Aufklappen direkt im <body> (fixed) – sonst schneiden Fenster/Scrollbereiche sie ab
  const place = () => {
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const up = below < 200 && r.top > below;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.maxHeight = `${Math.max(140, Math.min(320, (up ? r.top : below) - 12))}px`;
    list.style.top = up ? "" : `${r.bottom + 8}px`;
    list.style.bottom = up ? `${window.innerHeight - r.top + 8}px` : "";
  };
  const onMove = () => (el.isConnected ? place() : close());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  function open(): void {
    el.classList.add("open");
    el.setAttribute("aria-expanded", "true");
    document.body.append(list);
    place();
    requestAnimationFrame(() => list.classList.add("show"));
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    list.querySelector<HTMLElement>(".pick-item.on")?.scrollIntoView({ block: "nearest" });
  }
  function close(): void {
    el.classList.remove("open");
    el.setAttribute("aria-expanded", "false");
    list.classList.remove("show");
    window.setTimeout(() => {
      if (!el.classList.contains("open")) list.remove();
    }, 220);
    window.removeEventListener("resize", onMove);
    document.removeEventListener("scroll", onMove, true);
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  el.addEventListener("click", () => (el.classList.contains("open") ? close() : open()));
  el.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === el) {
      e.preventDefault();
      if (el.classList.contains("open")) close();
      else open();
    }
  });
  paint();
  return {
    el,
    set: (v: T) => {
      current = v;
      paint();
    },
  };
}
