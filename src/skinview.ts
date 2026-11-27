// Skin-Anzeige in der Bühne. Nutzt skinview3d.
// Skin-Textur:
//  - eingeloggt + Tauri  -> Backend-Command `get_skin` (liefert data-URL, kein CORS)
//  - sonst               -> mitgelieferter Standard-Skin
// Der Name schwebt – wie in Minecraft – als Nametag über dem Kopf.
import steveUrl from "./assets/steve.png";
// Minecraft-Font für den 3D-Nametag (aus skinview3d).
import minecraftFontUrl from "skinview3d/assets/minecraft.woff2?url";
import { active, onAccountChange } from "./account";
import { store, onChange } from "./state";

const hasTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
let viewer: import("skinview3d").SkinViewer | null = null;
let resizeObserver: ResizeObserver | null = null;

let fontReady: Promise<void> | null = null;
function ensureFont(): Promise<void> {
  if (!fontReady) {
    fontReady = (async () => {
      try {
        const face = new FontFace("Minecraft", `url(${minecraftFontUrl})`);
        await face.load();
        (document as any).fonts.add(face);
      } catch {
        /* Fallback-Font ist ok */
      }
    })();
  }
  return fontReady;
}

let lastKey = "";

export function initSkinView(): void {
  void ensureFont();
  onAccountChange(render);
  // Skin-Wechsel aus der Bibliothek übernehmen (nur bei echter Änderung neu laden)
  onChange(() => {
    const key = `${store.activeSkinId ?? ""}|${store.activeCapeId ?? ""}|${active()?.uuid ?? ""}`;
    if (key !== lastKey) render();
  });
  render();

  const mount = document.getElementById("skin-viewer");
  if (mount && "ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      if (!viewer) return;
      const r = mount.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return; // ausgeblendet (Vollbild-Ansicht offen)
      viewer.setSize(r.width - 2, r.height - 2);
    });
    resizeObserver.observe(mount);
  }
}

async function skinUrlFor(uuid: string | null): Promise<string> {
  if (uuid && hasTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_skin", { uuid });
    } catch {
      /* fällt auf Standard zurück */
    }
  }
  return steveUrl;
}

async function render(): Promise<void> {
  const mount = document.getElementById("skin-viewer");
  const nameEl = document.getElementById("nametag");
  if (!mount || !nameEl) return;

  const acc = active();
  const label = acc ? acc.username : null;
  lastKey = `${store.activeSkinId ?? ""}|${store.activeCapeId ?? ""}|${acc?.uuid ?? ""}`;

  const cape = store.capes.find((c) => c.id === store.activeCapeId) ?? null;

  // Aus der Bibliothek gewählter Skin hat Vorrang vor dem Konto-Skin.
  const libSkin = store.skins.find((s) => s.id === store.activeSkinId) ?? null;
  const url = libSkin ? libSkin.src : await skinUrlFor(acc?.uuid ?? null);
  const model: "default" | "slim" | "auto-detect" = libSkin
    ? libSkin.variant === "slim"
      ? "slim"
      : "default"
    : "auto-detect";

  try {
    const skinview3d = await import("skinview3d");
    if (!viewer) {
      const canvas = document.createElement("canvas");
      mount.innerHTML = "";
      mount.append(canvas);
      const r = mount.getBoundingClientRect();
      viewer = new skinview3d.SkinViewer({
        canvas,
        width: Math.max(1, r.width - 2) || 258,
        height: Math.max(1, r.height - 2) || 396,
      });
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
      // Feste Blickrichtung – kein Dauer-Drehen. Nur ganz leichte Leerlauf-Bewegung.
      viewer.autoRotate = false;
      viewer.controls.enableRotate = true; // Ziehen mit der Maus bleibt möglich
      viewer.zoom = 0.78; // Kopffreiheit für den Nametag
      // Leichter 3/4-Winkel, damit die Figur nicht bretteben von vorn steht.
      viewer.playerObject.rotation.y = -0.32;
      const anim = new skinview3d.IdleAnimation();
      anim.speed = 0.6;
      viewer.animation = anim;
    }
    await viewer.loadSkin(url, { model });

    // Custom-Cape (aus der Cosmetics-Bibliothek)
    try {
      if (cape) await viewer.loadCape(cape.src);
      else viewer.loadCape(null);
    } catch {
      viewer.loadCape(null);
    }

    // Nametag im 3D-Raum über dem Kopf – DOM-Nametag nur als Fallback.
    if (label) {
      await ensureFont();
      viewer.nameTag = new skinview3d.NameTagObject(label, {
        font: "42px Minecraft",
        repaintAfterLoaded: true,
      });
      nameEl.hidden = true;
    } else {
      viewer.nameTag = null;
      nameEl.textContent = "Nicht angemeldet";
      nameEl.hidden = false;
    }
  } catch {
    fallback(mount, url);
    nameEl.textContent = label ?? "Nicht angemeldet";
    nameEl.hidden = false;
  }
}

function fallback(mount: HTMLElement, skinUrl: string): void {
  viewer?.dispose();
  viewer = null;
  const img = document.createElement("img");
  img.className = "skin-fallback";
  img.src = skinUrl;
  mount.innerHTML = "";
  mount.append(img);
}
