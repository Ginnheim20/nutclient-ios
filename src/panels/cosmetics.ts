import { h, clear, toast, modal, tabbed, promptDialog } from "../ui";
import { active } from "../account";
import { store, save, uid, type SkinEntry, type CapeEntry } from "../state";
import { playerSkin, skinHeadUrl } from "../launcher/api";
import steveUrl from "../assets/steve.png";

// Skin & Cosmetics.
// Kein Inline-Formular mehr: die Skin-Bibliothek zeigt gesammelte Skins,
// ein Klick auf „Skin hinzufügen" öffnet das Auswahl-Popup
// (Spielername / URL / Durchsuchen). Custom-Capes analog darunter.

const SLOTS = ["Hut", "Rucksack", "Maske", "Flügel", "Haustier"] as const;

const PRESETS: { name: string; src: string; variant: "classic" | "slim" }[] = [
  { name: "Steve", src: steveUrl, variant: "classic" },
];

export function renderCosmetics(mount: HTMLElement): void {
  const acc = active();
  const draw = () => {
    clear(mount);

    mount.append(
      h("div", { class: "row between", style: "margin-bottom:14px" }, [
        h("div", {
          class: "hint",
          style: "margin:0",
          textContent: acc
            ? `Angemeldet als ${acc.username}`
            : "Ohne Konto kannst du Skins sammeln – anwenden geht dann nur mit Login.",
        }),
        h("button", {
          class: "btn",
          textContent: "＋ Skin hinzufügen",
          onclick: () => openSkinModal(draw),
        }),
      ]),
    );

    mount.append(skinLibrary(draw, acc?.uuid ?? null));

    mount.append(h("div", { class: "divider" }));
    mount.append(
      h("div", { class: "row between", style: "margin-bottom:10px" }, [
        h("h3", { textContent: "Custom-Capes", style: "margin:0;font-size:14px" }),
        h("button", {
          class: "btn sm",
          textContent: "＋ Umhang hinzufügen",
          onclick: () => openCapeModal(draw),
        }),
      ]),
    );
    mount.append(capeLibrary(draw));

    mount.append(h("div", { class: "divider" }));
    mount.append(h("h3", { textContent: "Weitere Cosmetics", style: "margin:0 0 10px;font-size:14px" }));
    mount.append(cosmeticGrid());
    mount.append(
      h("p", {
        class: "hint",
        textContent:
          "Cosmetics werden pro Konto gespeichert. Anbindung an einen Cosmetics-Dienst ist vorbereitet, aber noch nicht verdrahtet.",
      }),
    );
  };

  draw();
}

// ---- Bibliothek ---------------------------------------------------------

function skinLibrary(refresh: () => void, uuid: string | null): HTMLElement {
  const grid = h("div", { class: "skin-grid" });

  // Aktueller Konto-Skin als erste Kachel
  grid.append(
    skinCard(
      {
        id: "__account",
        name: "Konto-Skin",
        src: uuid ? skinHeadUrl(uuid) : steveUrl,
        variant: "classic",
        source: "preset",
        addedAt: 0,
      },
      store.activeSkinId === null,
      () => {
        store.activeSkinId = null;
        save();
        refresh();
      },
      null,
    ),
  );

  for (const s of store.skins) {
    grid.append(
      skinCard(
        s,
        store.activeSkinId === s.id,
        () => {
          store.activeSkinId = s.id;
          save();
          toast(`Skin „${s.name}" angewendet`);
          refresh();
        },
        () => {
          store.skins = store.skins.filter((x) => x.id !== s.id);
          if (store.activeSkinId === s.id) store.activeSkinId = null;
          save();
          refresh();
        },
      ),
    );
  }

  if (store.skins.length === 0) {
    grid.append(
      h("div", { class: "empty", style: "grid-column:1/-1", textContent: "Noch keine eigenen Skins." }),
    );
  }
  return grid;
}

function skinCard(
  s: SkinEntry,
  activeSkin: boolean,
  apply: () => void,
  remove: (() => void) | null,
): HTMLElement {
  const card = h("div", { class: `skin-card-lib ${activeSkin ? "selected" : ""}` }, [
    h("div", {
      class: `skin-thumb ${s.id === "__account" ? "is-head" : ""}`,
      style: `background-image:url("${s.src.replace(/"/g, '\\"')}")`,
    }),
    h("div", { class: "title", textContent: s.name, style: "font-size:12px;text-align:center" }),
    h("div", {
      class: "sub",
      style: "text-align:center",
      textContent: activeSkin ? "aktiv" : s.variant === "slim" ? "Slim" : "Classic",
    }),
  ]);
  card.addEventListener("click", apply);
  if (remove) {
    card.append(
      h("button", {
        class: "skin-del",
        textContent: "✕",
        title: "Entfernen",
        onclick: (e: Event) => {
          e.stopPropagation();
          remove();
        },
      }),
    );
  }
  return card;
}

// ---- Custom-Capes -----------------------------------------------------

function capeLibrary(refresh: () => void): HTMLElement {
  const grid = h("div", { class: "skin-grid" });

  // „Kein Umhang" als erste Kachel
  grid.append(
    capeCard(
      { id: "__none", name: "Kein Umhang", src: "", source: "preset", addedAt: 0 },
      store.activeCapeId === null,
      () => {
        store.activeCapeId = null;
        save();
        refresh();
      },
      null,
    ),
  );

  for (const c of store.capes) {
    grid.append(
      capeCard(
        c,
        store.activeCapeId === c.id,
        () => {
          store.activeCapeId = c.id;
          save();
          toast(`Umhang „${c.name}" angelegt`);
          refresh();
        },
        () => {
          store.capes = store.capes.filter((x) => x.id !== c.id);
          if (store.activeCapeId === c.id) store.activeCapeId = null;
          save();
          refresh();
        },
      ),
    );
  }

  if (store.capes.length === 0) {
    grid.append(
      h("div", { class: "empty", style: "grid-column:1/-1", textContent: "Noch keine eigenen Capes." }),
    );
  }
  return grid;
}

function capeCard(
  c: CapeEntry,
  activeCape: boolean,
  apply: () => void,
  remove: (() => void) | null,
): HTMLElement {
  const card = h("div", { class: `skin-card-lib ${activeCape ? "selected" : ""}` }, [
    h("div", {
      class: "skin-thumb cape-thumb",
      style: c.src
        ? `background-image:url("${c.src.replace(/"/g, '\\"')}")`
        : "background-image:none",
    }),
    h("div", { class: "title", textContent: c.name, style: "font-size:12px;text-align:center" }),
    h("div", {
      class: "sub",
      style: "text-align:center",
      textContent: activeCape ? "aktiv" : "Cape",
    }),
  ]);
  card.addEventListener("click", apply);
  if (remove) {
    card.append(
      h("button", {
        class: "skin-del",
        textContent: "✕",
        title: "Entfernen",
        onclick: (e: Event) => {
          e.stopPropagation();
          remove();
        },
      }),
    );
  }
  return card;
}

function addCape(entry: Omit<CapeEntry, "id" | "addedAt">, done: () => void): void {
  const c: CapeEntry = { ...entry, id: uid(), addedAt: Date.now() };
  store.capes.unshift(c);
  store.activeCapeId = c.id;
  save();
  toast(`Umhang „${c.name}" hinzugefügt & angewendet`);
  done();
}

function openCapeModal(refresh: () => void): void {
  modal(
    "Umhang hinzufügen",
    (body, close) => {
      const finish = () => {
        close();
        refresh();
      };
      body.append(
        tabbed(
          [
            { key: "url", label: "Von URL" },
            { key: "file", label: "Datei" },
          ],
          (key, panel) => {
            if (key === "url") panel.append(capeByUrl(finish));
            else panel.append(capeByFile(finish));
          },
        ),
      );
    },
    { wide: true },
  );
}

function capeByUrl(done: () => void): HTMLElement {
  const urlIn = h("input", { type: "text", placeholder: "https://…/cape.png (64×32)" }) as HTMLInputElement;
  const nameIn = h("input", { type: "text", placeholder: "Name" }) as HTMLInputElement;
  const pv = preview("");
  pv.classList.add("cape-thumb");
  urlIn.addEventListener("input", () => {
    pv.style.backgroundImage = urlIn.value.trim() ? `url("${urlIn.value.trim()}")` : "";
  });

  return h("div", { class: "skin-form" }, [
    h("div", { class: "field" }, [h("label", { textContent: "Cape-URL" }), urlIn]),
    h("div", { class: "field" }, [h("label", { textContent: "Name" }), nameIn]),
    h("div", { style: "margin-top:12px" }, [pv]),
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, [
      h("button", {
        class: "btn",
        textContent: "Hinzufügen",
        onclick: () => {
          const u = urlIn.value.trim();
          if (!u) return toast("URL fehlt", "error");
          addCape({ name: nameIn.value.trim() || "Cape von URL", src: u, source: "url" }, done);
        },
      }),
    ]),
  ]);
}

function capeByFile(done: () => void): HTMLElement {
  const file = h("input", { type: "file", accept: "image/png" }) as HTMLInputElement;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    const name = await promptDialog("Umhang benennen", {
      initial: f.name.replace(/\.png$/i, ""),
      confirm: "Hinzufügen",
    });
    const rd = new FileReader();
    rd.onload = () =>
      addCape({ name: name || f.name.replace(/\.png$/i, ""), src: String(rd.result), source: "file" }, done);
    rd.readAsDataURL(f);
  };

  return h("div", { class: "skin-form" }, [
    h("div", { class: "field" }, [
      h("label", { textContent: "Cape-Textur (PNG, 64×32)" }),
      file,
    ]),
    h("p", {
      class: "hint",
      textContent: "Die Textur wird lokal gespeichert und im Skin-Vorschaufenster angezeigt.",
    }),
  ]);
}

function cosmeticGrid(): HTMLElement {
  const grid = h("div", { class: "list" });
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "1fr 1fr";
  grid.style.gap = "8px";
  for (const slot of SLOTS) {
    grid.append(
      h("button", {
        class: "card selectable",
        style: "justify-content:center",
        textContent: slot,
        onclick: () => toast(`${slot}: Auswahl folgt`),
      }),
    );
  }
  return grid;
}

// ---- Popup „Skin hinzufügen" -----------------------------------------

function addSkin(entry: Omit<SkinEntry, "id" | "addedAt">, apply: boolean, done: () => void): void {
  const s: SkinEntry = { ...entry, id: uid(), addedAt: Date.now() };
  store.skins.unshift(s);
  if (apply) store.activeSkinId = s.id;
  save();
  toast(apply ? `Skin „${s.name}" hinzugefügt & angewendet` : `Skin „${s.name}" gespeichert`);
  done();
}

function openSkinModal(refresh: () => void): void {
  modal(
    "Skin hinzufügen",
    (body, close) => {
      const finish = () => {
        close();
        refresh();
      };
      body.append(
        tabbed(
          [
            { key: "player", label: "Spielername" },
            { key: "url", label: "Von URL" },
            { key: "browse", label: "Durchsuchen" },
          ],
          (key, panel) => {
            if (key === "player") panel.append(byPlayer(finish));
            else if (key === "url") panel.append(byUrl(finish));
            else panel.append(byBrowse(finish));
          },
        ),
      );
    },
    { wide: true },
  );
}

function preview(src: string): HTMLElement {
  return h("div", {
    class: "skin-preview",
    style: src ? `background-image:url("${src.replace(/"/g, '\\"')}")` : "",
  });
}

function byPlayer(done: () => void): HTMLElement {
  const nameIn = h("input", { type: "text", placeholder: "z. B. Notch" }) as HTMLInputElement;
  const pv = preview("");
  const info = h("div", { class: "hint" });
  let found: { src: string; variant: "classic" | "slim"; username: string } | null = null;

  const addBtn = h("button", { class: "btn", textContent: "Zur Bibliothek", disabled: true });
  const load = async () => {
    const n = nameIn.value.trim();
    if (!n) return;
    info.textContent = "Suche…";
    try {
      const r = await playerSkin(n);
      found = { src: r.skinUrl, variant: r.variant, username: r.username };
      pv.style.backgroundImage = `url("${r.skinUrl}")`;
      info.textContent = `${r.username} · ${r.variant === "slim" ? "Slim" : "Classic"}`;
      (addBtn as HTMLButtonElement).disabled = false;
    } catch (e) {
      found = null;
      pv.style.backgroundImage = "";
      info.textContent = String(e instanceof Error ? e.message : e);
      (addBtn as HTMLButtonElement).disabled = true;
    }
  };
  nameIn.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void load();
  });
  addBtn.addEventListener("click", () => {
    if (!found) return;
    addSkin(
      { name: found.username, src: found.src, variant: found.variant, source: "player" },
      true,
      done,
    );
  });

  return h("div", { class: "skin-form" }, [
    h("div", { class: "row", style: "gap:8px" }, [
      Object.assign(nameIn, { style: "flex:1" }),
      h("button", { class: "btn ghost", textContent: "Laden", onclick: () => void load() }),
    ]),
    h("div", { class: "row", style: "gap:14px;align-items:flex-start;margin-top:12px" }, [pv, info]),
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, [addBtn]),
  ]);
}

function byUrl(done: () => void): HTMLElement {
  const urlIn = h("input", { type: "text", placeholder: "https://…/skin.png (64×64)" }) as HTMLInputElement;
  const nameIn = h("input", { type: "text", placeholder: "Name" }) as HTMLInputElement;
  const variant = h("select", {}, [
    h("option", { value: "classic", textContent: "Classic (Steve)" }),
    h("option", { value: "slim", textContent: "Slim (Alex)" }),
  ]) as HTMLSelectElement;
  const pv = preview("");
  urlIn.addEventListener("input", () => {
    pv.style.backgroundImage = urlIn.value.trim() ? `url("${urlIn.value.trim()}")` : "";
  });

  return h("div", { class: "skin-form" }, [
    h("div", { class: "field" }, [h("label", { textContent: "Skin-URL" }), urlIn]),
    h("div", { class: "row", style: "gap:8px" }, [
      h("div", { class: "field", style: "flex:1;margin:0" }, [h("label", { textContent: "Name" }), nameIn]),
      h("div", { class: "field", style: "margin:0" }, [h("label", { textContent: "Modell" }), variant]),
    ]),
    h("div", { style: "margin-top:12px" }, [pv]),
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, [
      h("button", {
        class: "btn",
        textContent: "Zur Bibliothek",
        onclick: () => {
          const u = urlIn.value.trim();
          if (!u) return toast("URL fehlt", "error");
          addSkin(
            {
              name: nameIn.value.trim() || "Skin von URL",
              src: u,
              variant: variant.value as "classic" | "slim",
              source: "url",
            },
            true,
            done,
          );
        },
      }),
    ]),
  ]);
}

function byBrowse(done: () => void): HTMLElement {
  const file = h("input", { type: "file", accept: "image/png" }) as HTMLInputElement;
  file.onchange = () => {
    const f = file.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () =>
      addSkin(
        { name: f.name.replace(/\.png$/i, ""), src: String(rd.result), variant: "classic", source: "file" },
        true,
        done,
      );
    rd.readAsDataURL(f);
  };

  const gallery = h("div", { class: "skin-grid" });
  for (const p of PRESETS) {
    const card = h("div", { class: "skin-card-lib" }, [
      h("div", { class: "skin-thumb", style: `background-image:url("${p.src}")` }),
      h("div", { class: "title", textContent: p.name, style: "font-size:12px;text-align:center" }),
    ]);
    card.addEventListener("click", () =>
      addSkin({ name: p.name, src: p.src, variant: p.variant, source: "preset" }, true, done),
    );
    gallery.append(card);
  }

  return h("div", { class: "skin-form" }, [
    h("h4", { textContent: "Vorlagen", style: "margin:4px 0 8px;font-size:13px" }),
    gallery,
    h("div", { class: "field", style: "margin-top:14px" }, [
      h("label", { textContent: "Eigene Datei (PNG 64×64)" }),
      file,
    ]),
    h("p", {
      class: "hint",
      textContent:
        "Ein durchsuchbarer Online-Skin-Katalog hängt am Skin-Dienst (siehe client-readme.md) und kommt separat dazu.",
    }),
  ]);
}
