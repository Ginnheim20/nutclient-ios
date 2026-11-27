import { h, clear, toast, isPanelExpanded, contextMenu, searchBar } from "../ui";
import { icons } from "../icons";
import { store, save, uid, activeProfile, type ContentKind, type Profile } from "../state";
import {
  searchModrinth,
  getModrinthProject,
  getModrinthDependencies,
  getModrinthProjectsBulk,
  getModrinthTeam,
  installContent,
  hasTauri,
  type ModrinthHit,
  type ModrinthProject,
} from "../launcher/api";
import { renderMarkdown } from "../markdown";
import { startModpackInstall } from "../modpacks";

const KINDS: { key: ContentKind; label: string }[] = [
  { key: "mod", label: "Mods" },
  { key: "modpack", label: "Modpacks" },
  { key: "resourcepack", label: "Resource Packs" },
  { key: "shader", label: "Shaders" },
  { key: "datapack", label: "Data Packs" },
  { key: "world", label: "Welten" },
];

const PAGE = 20;
const ICON_FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44'><rect width='44' height='44' fill='%233a3a42'/></svg>`,
  );

let kind: ContentKind = "mod";
let source: "modrinth" | "curseforge" = "modrinth";
let detach: (() => void) | null = null;
/** offenes Detail (überlebt Panel breit/schmal). */
let openHit: ModrinthHit | null = null;
/** Suchbegriff (bleibt über Tabs, Detail und Schließen des Panels erhalten). */
let lastQuery = "";
/** Geladene Liste samt Scrollstelle – „Zurück“ aus dem Detail landet wieder genau dort. */
let memo: {
  key: string;
  query: string;
  hits: ModrinthHit[];
  offset: number;
  total: number;
  done: boolean;
  scroll: number;
} | null = null;
let searchGen = 0;

export function renderContent(mount: HTMLElement): () => void {
  detach?.();
  detach = null;
  clear(mount);

  const expanded = isPanelExpanded();

  // Detail-Ansicht nur im Vollbild – beim Verkleinern zurück zur Liste.
  if (openHit && expanded) {
    renderDetail(mount, openHit);
    const onResize = () => renderContent(mount);
    mount.addEventListener("panelresize", onResize);
    detach = () => mount.removeEventListener("panelresize", onResize);
    return () => detach?.();
  }
  openHit = null;
  mount.classList.remove("mod-detail-mount");
  const results = h("div", { class: `list content-list ${expanded ? "content-grid" : ""}` });
  const search = h("input", {
    placeholder: `${KINDS.find((k) => k.key === kind)?.label ?? "Inhalte"} durchsuchen…`,
  }) as HTMLInputElement;
  search.value = lastQuery;
  const key = `${kind}|${source}`;

  // Suchleiste: Glas, bunter Rand (ui.ts searchBar), Trefferzahl, Leeren-Knopf
  const sb = searchBar(search);
  const bar = sb.el;
  const syncBar = () => bar.classList.toggle("has-text", search.value.length > 0);
  const setCount = (n: number) => sb.setCount(n);

  let query = "";
  let offset = 0;
  let total = Infinity;
  let loading = false;
  let done = false;

  const endMarker = () => {
    results.append(
      results.childElementCount === 0
        ? h("div", { class: "empty", textContent: "Nichts gefunden." })
        : h("div", { class: "hint content-end", textContent: "— Ende —" }),
    );
  };

  const loadMore = async () => {
    if (loading || done || source === "curseforge" || kind === "world") return;
    const gen = searchGen;
    loading = true;
    const first = offset === 0;
    bar.classList.add("busy");
    const row = first ? null : h("div", { class: "empty", textContent: "Lädt mehr…" });
    if (row) results.append(row);
    try {
      // Mods nur für Fabric oder NeoForge – Forge kann der Launcher nicht starten
      const page = await searchModrinth(query, kind, offset, PAGE, kind === "mod" ? [["categories:fabric", "categories:neoforge"]] : []);
      row?.remove();
      if (gen !== searchGen) return; // inzwischen weitergetippt – veraltete Antwort verwerfen
      if (first) {
        clear(results);
        results.classList.remove("stale");
      }
      total = page.total_hits;
      setCount(total);
      page.hits.forEach((hit, i) => {
        const card = resultCard(hit, expanded, mount);
        card.classList.add("content-in");
        card.style.animationDelay = `${Math.min(i, 12) * 28}ms`;
        results.append(card);
      });
      offset += page.hits.length;
      if (memo && memo.key === key) {
        memo.hits.push(...page.hits);
        memo.offset = offset;
        memo.total = total;
      }
      if (page.hits.length < PAGE || offset >= total) {
        done = true;
        if (memo) memo.done = true;
        endMarker();
      }
    } catch (e) {
      row?.remove();
      if (gen !== searchGen) return;
      if (first) {
        clear(results);
        results.classList.remove("stale");
      }
      results.append(h("p", { class: "hint", textContent: `Modrinth-Fehler: ${e}` }));
      done = true;
    } finally {
      if (gen === searchGen) {
        loading = false;
        bar.classList.remove("busy");
      }
    }
    if (gen === searchGen && !done && mount.scrollHeight <= mount.clientHeight + 200) void loadMore();
  };

  const runSearch = () => {
    searchGen++;
    query = search.value.trim();
    lastQuery = search.value;
    syncBar();
    offset = 0;
    total = Infinity;
    done = false;
    loading = false;
    setCount(Infinity);
    memo = { key, query, hits: [], offset: 0, total: Infinity, done: false, scroll: 0 };
    mount.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    // alte Treffer bleiben stehen (leicht abgeblendet), bis die neuen da sind – kein Flackern beim Tippen
    results.classList.add("stale");
    if (results.childElementCount === 0) {
      results.append(h("div", { class: "empty", textContent: "Suche läuft…" }));
    }
    if (source === "curseforge" || kind === "world") {
      clear(results);
      results.classList.remove("stale");
    }
    if (source === "curseforge") {
      done = true;
      results.append(
        h("p", {
          class: "hint",
          textContent:
            "CurseForge braucht einen API-Key. Trag ihn in den Einstellungen ein, dann steht die Suche hier zur Verfügung.",
        }),
      );
      return;
    }
    if (kind === "world") {
      done = true;
      results.append(
        h("p", { class: "hint", textContent: "Welten kommen als .zip – Import per Datei folgt." }),
      );
      return;
    }
    void loadMore();
  };

  const tabs = h("div", { class: "tabs" });
  for (const k of KINDS) {
    tabs.append(
      h("button", {
        class: `tab ${k.key === kind ? "active" : ""}`,
        textContent: k.label,
        onclick: () => {
          kind = k.key;
          renderContent(mount);
        },
      }),
    );
  }

  const seg = h("div", { class: "segmented" }, [
    h("button", {
      class: source === "modrinth" ? "active" : "",
      textContent: "Modrinth",
      onclick: () => {
        source = "modrinth";
        renderContent(mount);
      },
    }),
    h("button", {
      class: source === "curseforge" ? "active" : "",
      textContent: "CurseForge",
      onclick: () => {
        source = "curseforge";
        renderContent(mount);
      },
    }),
  ]);

  const target = activeProfile();
  const hintEl = h("p", { class: "hint content-target" });
  hintEl.innerHTML =
    kind === "modpack"
      ? "Modpacks legen eine <b>neue Instanz</b> an."
      : target
        ? `Beim Hinzufügen wählst du die Instanz (zuletzt: <b>${escapeHtml(target.name)}</b>).`
        : "Beim Hinzufügen wählst du die Instanz.";

  const searchRow = h("div", { class: "content-search-row" }, [bar]);

  mount.append(tabs, seg, searchRow, hintEl, results);
  if (expanded) {
    mount.append(
      h("p", { class: "hint content-hint", textContent: "Karte anklicken für alle Infos, Bilder & Videos." }),
    );
  }

  const onScroll = () => {
    if (memo && memo.key === key) memo.scroll = mount.scrollTop;
    if (mount.scrollTop + mount.clientHeight >= mount.scrollHeight - 500) void loadMore();
  };
  mount.addEventListener("scroll", onScroll, { passive: true });
  const onResize = () => renderContent(mount);
  mount.addEventListener("panelresize", onResize);

  // Live-Suche: kurz nach dem letzten Tastendruck, Enter sofort, Esc leert
  let timer = 0;
  search.addEventListener("input", () => {
    syncBar();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (search.value.trim() !== query) runSearch();
    }, 260);
  });
  search.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") {
      window.clearTimeout(timer);
      runSearch();
    }
  });
  detach = () => {
    window.clearTimeout(timer);
    mount.removeEventListener("scroll", onScroll);
    mount.removeEventListener("panelresize", onResize);
  };

  // gleiche Liste wie zuletzt (z. B. zurück aus dem Detail) → ohne neue Suche wiederherstellen, samt Scrollstelle
  const m = memo;
  if (m && m.key === key && m.query === search.value.trim() && m.hits.length > 0) {
    query = m.query;
    offset = m.offset;
    total = m.total;
    done = m.done;
    syncBar();
    setCount(total);
    for (const hit of m.hits) results.append(resultCard(hit, expanded, mount));
    if (done) endMarker();
    const y = m.scroll;
    mount.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
    requestAnimationFrame(() => {
      mount.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
    });
  } else {
    runSearch();
  }

  return () => detach?.();
}

// ---- Ergebnis-Karte -------------------------------------------------

function resultCard(hit: ModrinthHit, expanded: boolean, mount: HTMLElement): HTMLElement {
  const card = h("div", { class: `card ${expanded ? "content-card selectable" : ""}` }, [
    h("img", { class: "thumb", src: hit.icon_url || ICON_FALLBACK, alt: "", loading: "lazy" }),
    h("div", { class: "grow" }, [
      h("div", { class: "title", textContent: hit.title }),
      h("div", { class: "sub", textContent: hit.description }),
    ]),
    h("button", {
      class: "btn sm",
      textContent: kind === "modpack" ? "Als Profil" : "Hinzufügen",
      onclick: (e: Event) => {
        e.stopPropagation();
        addHit(hit, e.currentTarget as HTMLElement);
      },
    }),
  ]);
  if (expanded) {
    card.addEventListener("click", () => {
      if (memo) memo.scroll = mount.scrollTop;
      openHit = hit;
      renderContent(mount);
    });
  }
  return card;
}

// ---- Detail-Ansicht (nur Vollbild) --------------------------------

function renderDetail(mount: HTMLElement, hit: ModrinthHit): void {
  const back = h("button", {
    class: "btn ghost sm content-back",
    textContent: "← Zurück",
    onclick: () => {
      openHit = null;
      renderContent(mount);
    },
  });

  const head = h("div", { class: "mod-head" }, [
    h("img", { class: "mod-icon", src: hit.icon_url || ICON_FALLBACK, alt: "" }),
    h("div", { class: "grow" }, [
      h("div", { class: "mod-title", textContent: hit.title }),
      h("div", { class: "mod-desc", textContent: hit.description }),
      h("div", { class: "mod-tags" }, [tag(source === "modrinth" ? "Modrinth" : "CurseForge", "src")]),
    ]),
    h("button", {
      class: "btn",
      textContent: kind === "modpack" ? "Als Profil anlegen" : "Zur Instanz hinzufügen",
      onclick: (e: Event) => addHit(hit, e.currentTarget as HTMLElement),
    }),
  ]);

  const gallery = h("div", { class: "mod-gallery" });
  const body = h("div", { class: "mod-body" }, [h("div", { class: "empty", textContent: "Lädt…" })]);
  const side = h("div", { class: "mod-side" });

  mount.classList.add("mod-detail-mount");
  mount.append(back, head, gallery, h("div", { class: "mod-cols" }, [body, side]));
  mount.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });

  void loadDetail(hit.project_id, head, gallery, body, side);
}

async function loadDetail(
  id: string,
  head: HTMLElement,
  gallery: HTMLElement,
  body: HTMLElement,
  side: HTMLElement,
): Promise<void> {
  let proj: ModrinthProject;
  try {
    proj = await getModrinthProject(id);
  } catch (e) {
    clear(body);
    body.append(h("p", { class: "hint", textContent: `Konnte Projekt nicht laden: ${e}` }));
    return;
  }

  // Kategorien-Tags in den Kopf
  const tagRow = head.querySelector(".mod-tags") as HTMLElement;
  for (const c of [...proj.categories, ...proj.additional_categories]) {
    tagRow.append(tag(c));
  }

  // Galerie
  const imgs = [...proj.gallery].sort((a, b) => Number(b.featured) - Number(a.featured));
  if (imgs.length) {
    const shots = imgs.map((g) => ({ url: g.raw_url || g.url, caption: g.title ?? g.description ?? "" }));
    imgs.forEach((g, i) => {
      const im = h("img", {
        class: "mod-shot",
        src: g.url,
        alt: g.title ?? "",
        title: g.title ?? "",
        loading: "lazy",
      });
      im.addEventListener("click", () => lightbox(shots, i));
      gallery.append(im);
    });
  } else {
    gallery.remove();
  }

  // Beschreibung (Markdown, gerendert & entschärft)
  clear(body);
  body.append(renderMarkdown(proj.body || proj.description));

  // ---- Seitenleiste ----
  side.append(
    section("Kompatibilität", [
      kv("Minecraft", chips(proj.game_versions.slice(0, 12))),
      proj.loaders.length ? kv("Loader", chips(proj.loaders)) : null,
      kv("Client", h("span", { textContent: envLabel(proj.client_side) })),
      kv("Server", h("span", { textContent: envLabel(proj.server_side) })),
    ]),
  );

  // Abhängigkeiten
  const depSec = section("Abhängigkeiten", [h("div", { class: "hint", textContent: "Lädt…" })]);
  side.append(depSec);
  try {
    const deps = await getModrinthDependencies(id);
    const ids = deps.map((d) => d.project_id!).filter(Boolean);
    const infos = ids.length ? await getModrinthProjectsBulk(ids) : [];
    const byId = new Map(infos.map((p) => [p.id, p]));
    const list = depSec.querySelector(".mod-sec-body") as HTMLElement;
    clear(list);
    if (deps.length === 0) {
      list.append(h("div", { class: "hint", textContent: "keine" }));
    }
    for (const d of deps) {
      const info = byId.get(d.project_id!);
      list.append(
        h("div", { class: "mod-dep" }, [
          h("img", { src: info?.icon_url || ICON_FALLBACK, alt: "", loading: "lazy" }),
          h("span", { class: "grow", textContent: info?.title ?? d.project_id ?? "?" }),
          h("span", { class: "mod-dep-type", textContent: depLabel(d.dependency_type) }),
        ]),
      );
    }
  } catch {
    const list = depSec.querySelector(".mod-sec-body") as HTMLElement;
    clear(list);
    list.append(h("div", { class: "hint", textContent: "nicht verfügbar" }));
  }

  // Team
  if (proj.team) {
    const teamSec = section("Team", [h("div", { class: "hint", textContent: "Lädt…" })]);
    side.append(teamSec);
    try {
      const members = await getModrinthTeam(proj.team);
      const list = teamSec.querySelector(".mod-sec-body") as HTMLElement;
      clear(list);
      for (const m of members) {
        list.append(
          h("div", { class: "mod-dep" }, [
            h("img", { src: m.user.avatar_url || ICON_FALLBACK, alt: "", loading: "lazy" }),
            h("span", { class: "grow", textContent: m.user.name || m.user.username }),
            h("span", { class: "mod-dep-type", textContent: m.role }),
          ]),
        );
      }
    } catch {
      teamSec.remove();
    }
  }

  // Links
  const links: [string, string | null][] = [
    ["Modrinth-Seite", `https://modrinth.com/${proj.project_type}/${proj.slug}`],
    ["Quellcode", proj.source_url],
    ["Probleme", proj.issues_url],
    ["Wiki", proj.wiki_url],
  ];
  const linkSec = section(
    "Links",
    links
      .filter(([, u]) => u)
      .map(([t, u]) => {
        const a = h("a", { class: "mod-link", textContent: t }) as HTMLAnchorElement;
        a.href = u!;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
      }),
  );
  side.append(linkSec);
}

// ---- kleine Bausteine ---------------------------------------------

function tag(text: string, kind = ""): HTMLElement {
  return h("span", { class: `mod-tag ${kind}`, textContent: text });
}
function chips(items: string[]): HTMLElement {
  return h(
    "span",
    { class: "mod-chips" },
    items.map((i) => h("span", { class: "mod-chip", textContent: i })),
  );
}
function kv(label: string, value: Node): HTMLElement {
  return h("div", { class: "mod-kv" }, [h("span", { class: "mod-kv-k", textContent: label }), value]);
}
function section(title: string, children: (Node | null)[]): HTMLElement {
  return h("div", { class: "mod-sec" }, [
    h("div", { class: "mod-sec-h", textContent: title }),
    h(
      "div",
      { class: "mod-sec-body" },
      children.filter((c): c is Node => c != null),
    ),
  ]);
}
function envLabel(v: string): string {
  return { required: "erforderlich", optional: "optional", unsupported: "nein", unknown: "?" }[v] ?? v;
}
function depLabel(v: string): string {
  return (
    { required: "nötig", optional: "optional", incompatible: "inkompatibel", embedded: "enthalten" }[
      v
    ] ?? v
  );
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Galerie groß: füllt das ganze Panel (nicht die Leiste links), Bild so groß wie möglich. Liquid-Glass-Pfeile links/rechts
 * erscheinen nur, wenn die Maus in der jeweiligen Hälfte ist; Pfeiltasten blättern, Esc oder Klick daneben schließt.
 */
function lightbox(shots: { url: string; caption: string }[], start: number): void {
  const host = document.querySelector<HTMLElement>(".panel") ?? document.body;
  let i = start;
  const img = h("img", { class: "lightbox-img", alt: "" }) as HTMLImageElement;
  const cap = h("div", { class: "lightbox-cap" });
  const count = h("div", { class: "lightbox-count" });
  const arrow = (dir: -1 | 1) =>
    h("button", {
      class: `lightbox-arrow ${dir < 0 ? "prev" : "next"}`,
      type: "button",
      "aria-label": dir < 0 ? "Vorheriges Bild" : "Nächstes Bild",
      html: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}"/></svg>`,
      onclick: (e: Event) => {
        e.stopPropagation();
        show(i + dir);
      },
    });
  const prev = arrow(-1);
  const next = arrow(1);
  const close = h("button", {
    class: "lightbox-close",
    type: "button",
    "aria-label": "Schließen",
    html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  });
  const box = h("div", { class: "lightbox" }, [img, prev, next, close, count, cap]);
  const many = shots.length > 1;
  if (!many) {
    prev.remove();
    next.remove();
    count.remove();
  }

  // Pfeile an den Bildrand rücken (innen, 16 px), damit sie über dem Bild liegen und es brechen
  const place = () => {
    const b = box.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    if (!r.width) return;
    prev.style.left = `${Math.max(18, r.left - b.left + 16)}px`;
    next.style.right = `${Math.max(18, b.right - r.right + 16)}px`;
  };
  img.addEventListener("load", place);
  const ro = new ResizeObserver(place);
  ro.observe(box);

  function show(n: number): void {
    i = (n + shots.length) % shots.length;
    img.classList.remove("in");
    img.src = shots[i].url;
    void img.offsetWidth;
    img.classList.add("in");
    cap.textContent = shots[i].caption;
    count.textContent = `${i + 1} / ${shots.length}`;
  }
  const shut = () => {
    ro.disconnect();
    box.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") shut();
    else if (many && e.key === "ArrowLeft") show(i - 1);
    else if (many && e.key === "ArrowRight") show(i + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Pfeil nur zeigen, wenn die Maus auf seiner Seite ist
  box.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    prev.classList.toggle("show", x < 0.5);
    next.classList.toggle("show", x >= 0.5);
  });
  box.addEventListener("mouseleave", () => {
    prev.classList.remove("show");
    next.classList.remove("show");
  });
  box.addEventListener("click", (e) => {
    if (e.target !== img) shut();
  });
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    shut();
  });
  document.addEventListener("keydown", onKey, true);
  show(start);
  host.append(box);
}

// ---- Hinzufügen --------------------------------------------------

function addHit(hit: ModrinthHit, anchor: HTMLElement): void {
  if (kind === "modpack") {
    if (source === "curseforge") {
      return toast("CurseForge-Modpacks gehen erst mit dem CurseForge-Zugang – bis dahin die .zip ins Select-Fenster ziehen", "error");
    }
    // echtes Profil: Mods, Version und Loader kommen aus dem Pack, Ladebalken im Select
    const p: Profile = {
      id: uid(),
      name: hit.title,
      versionId: "…",
      loader: "fabric",
      fromModpack: hit.title,
      origin: "modrinth",
      content: [],
      createdAt: Date.now(),
      modpackId: hit.project_id,
      installing: true,
      icon: hit.icon_url || undefined,
      iconName: hit.title,
    };
    store.profiles.push(p);
    store.activeProfileId = p.id;
    save();
    void startModpackInstall(p);
    toast(`Modpack „${hit.title}“ wird geladen – Fortschritt unter „Select“`);
    return;
  }
  // Instanz wählen (zuletzt gespielte oben); ein Haken zeigt, wo es schon drin ist
  if (store.profiles.length === 0) return toast("Noch keine Instanz – unter „Select“ eine anlegen", "error");
  const current = activeProfile();
  const list = [...store.profiles].sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt));
  if (current) list.sort((a, b) => (a.id === current.id ? -1 : b.id === current.id ? 1 : 0));
  contextMenu(anchor, list.map((p) => {
    const has = p.content.some((c) => c.projectId === hit.project_id);
    return {
      label: `${p.name} · ${p.versionId}${has ? "  ✓" : ""}`,
      iconHtml: has ? icons.check : icons.grid,
      onClick: () => addTo(p, hit),
    };
  }));
}

function addTo(profile: Profile, hit: ModrinthHit): void {
  if (profile.content.some((c) => c.projectId === hit.project_id)) {
    return toast(`Schon in „${profile.name}“`);
  }
  const k = kind;
  profile.content.push({ projectId: hit.project_id, title: hit.title, kind: k, source });
  save();
  toast(`„${hit.title}“ zu „${profile.name}“ hinzugefügt`);
  // gleich herunterladen – Shader/Ressourcenpakete sind dann sofort im Spiel wählbar (Iris kommt beim Start dazu)
  if (source !== "modrinth" || !["mod", "shader", "resourcepack"].includes(k)) return;
  installContent(profile.id, profile.versionId, hit.project_id, k, profile.loader)
    .then(() => {
      if (hasTauri && k !== "mod") toast(`„${hit.title}“ liegt bereit – im Spiel unter ${k === "shader" ? "Shader" : "Ressourcenpakete"} auswählen`);
    })
    .catch((e) => toast(`„${hit.title}“: ${e}`, "error"));
}
