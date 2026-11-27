// Hintergrundvideo: läuft stumm in Dauerschleife hinter der Oberfläche.
// Zwei Quellen:
//  · Presets  – von uns mitgelieferte Videos (URL, remote oder /backgrounds/*),
//               für jeden auswählbar. Liste unten in PRESET_VIDEOS pflegen.
//  · Eigene   – vom Nutzer gewählte Dateien. Zu groß für localStorage →
//               als Blob in IndexedDB, nur die aktive ID steht in localStorage.

export interface PresetVideo {
  /** eindeutige Kennung, wird als aktive ID gespeichert */
  id: string;
  name: string;
  /** absolute URL (https://…) oder projektlokal (/backgrounds/datei.mp4) */
  src: string;
}

/**
 * Mitgelieferte Hintergrundvideos – sieht jeder, der den Launcher installiert.
 * Dateien liegen unter `public/backgrounds/` (auf 720p/stumm komprimiert,
 * zusammen < 10 MB). Ein gehostetes Video ginge auch: `src` einfach auf eine
 * `https://…`-URL setzen (die CSP erlaubt jede https-Quelle).
 */
export const PRESET_VIDEOS: PresetVideo[] = [
  { id: "preset:reef", name: "Korallenriff", src: "/backgrounds/bg-1.mp4" },
  { id: "preset:desert", name: "Wüste", src: "/backgrounds/bg-2.mp4" },
  { id: "preset:forest", name: "Wald", src: "/backgrounds/bg-3.mp4" },
  { id: "preset:amethyst", name: "Amethyst", src: "/backgrounds/bg-4.mp4" },
  { id: "preset:deepsea", name: "Tiefsee", src: "/backgrounds/bg-5.mp4" },
  { id: "preset:warped", name: "Warped Forest", src: "/backgrounds/bg-6.mp4" },
  { id: "preset:mine", name: "Mine", src: "/backgrounds/bg-7.mp4" },
  { id: "preset:night", name: "Sternennacht", src: "/backgrounds/bg-8.mp4" },
];

const DB_NAME = "mcl-bg-video";
const STORE = "videos";
const ACTIVE_KEY = "mcl.bgvid.active.v1";
const PRESET_PREFIX = "preset:";

export interface BgVideoMeta {
  id: string;
  name: string;
  preset: boolean;
}

interface BgVideoRecord {
  id: string;
  name: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  return new Promise<T>((resolve, reject) => {
    const t = conn.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let currentObjectUrl: string | null = null;
/** Vom Nutzer über das Wiedergabe-Widget pausiert (dann NICHT bei Fokus fortsetzen). */
let userPaused = false;
/** Anzeigedaten des laufenden Videos (für das „Now Playing"-Widget). */
let currentMeta: { id: string; name: string; poster: string | null } | null = null;

export interface BgNowPlaying {
  id: string;
  name: string;
  poster: string | null;
  playing: boolean;
  current: number;
  duration: number;
}

const npSubs = new Set<(np: BgNowPlaying | null) => void>();

/** Aktuellen Wiedergabestand abonnieren. Callback feuert sofort + bei Änderungen. */
export function onBgVideoChange(cb: (np: BgNowPlaying | null) => void): () => void {
  npSubs.add(cb);
  cb(bgNowPlaying());
  return () => npSubs.delete(cb);
}

function emitNp(): void {
  const np = bgNowPlaying();
  npSubs.forEach((cb) => cb(np));
}

export function bgNowPlaying(): BgNowPlaying | null {
  const v = el();
  if (!currentMeta || !v || v.hidden) return null;
  return {
    ...currentMeta,
    playing: !v.paused,
    current: v.currentTime || 0,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
  };
}

let videoEventsBound = false;
function bindVideoEvents(v: HTMLVideoElement): void {
  if (videoEventsBound) return;
  videoEventsBound = true;
  for (const ev of ["play", "pause", "timeupdate", "loadedmetadata", "durationchange", "emptied"]) {
    v.addEventListener(ev, emitNp);
  }
}

function el(): HTMLVideoElement | null {
  return document.getElementById("bg-video") as HTMLVideoElement | null;
}

export function activeBgVideoId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function setActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* egal */
  }
}

/** Aktives Video (falls vorhanden) laden und abspielen. */
export async function initBgVideo(): Promise<void> {
  const id = activeBgVideoId();
  if (!id) return;
  try {
    await playById(id);
  } catch {
    // Datensatz weg / URL tot → aufräumen
    setActiveId(null);
    hideVideo();
  }
}

async function playById(id: string): Promise<void> {
  const v = el();
  if (!v) throw new Error("kein <video>");

  let src: string;
  let name: string;
  let poster: string | null = null;
  if (id.startsWith(PRESET_PREFIX)) {
    const p = PRESET_VIDEOS.find((x) => x.id === id);
    if (!p) throw new Error("Preset nicht gefunden");
    src = p.src;
    name = p.name;
    poster = /^https?:/i.test(p.src) ? null : p.src.replace(/\.[^.]+$/, ".jpg");
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  } else {
    const rec = await tx<BgVideoRecord | undefined>(
      "readonly",
      (s) => s.get(id) as IDBRequest<BgVideoRecord | undefined>,
    );
    if (!rec) throw new Error("Video nicht gefunden");
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(rec.blob);
    src = currentObjectUrl;
    name = rec.name;
  }

  currentMeta = { id, name, poster };
  userPaused = false; // neue Auswahl → soll laufen
  v.src = src;
  v.hidden = false;
  v.muted = true; // Autoplay braucht stumm
  v.loop = true;
  document.documentElement.classList.add("has-bg-video");
  bindVideoEvents(v);
  bindGate();
  gate();
  emitNp();
}

// Wiedergabe nur, wenn das Fenster im Vordergrund ist. Klickt man den Launcher
// weg / minimiert ihn, bleibt das Video an der Stelle stehen und läuft beim
// Zurückkehren weiter.
function windowActive(): boolean {
  return !document.hidden && document.hasFocus();
}

function gate(): void {
  const v = el();
  if (!v || v.hidden || !v.getAttribute("src")) return;
  if (userPaused || !windowActive()) {
    if (!v.paused) v.pause();
  } else if (v.paused) {
    void v.play().catch(() => {});
  }
}

let gateBound = false;
function bindGate(): void {
  if (gateBound) return;
  gateBound = true;
  window.addEventListener("focus", gate);
  window.addEventListener("blur", gate);
  document.addEventListener("visibilitychange", gate);
  // erste Nutzer-Geste – falls die Autoplay-Politik den Start blockiert hat
  window.addEventListener("pointerdown", gate, { once: true });
  window.addEventListener("keydown", gate, { once: true });
}

function hideVideo(): void {
  const v = el();
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.hidden = true;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  currentMeta = null;
  userPaused = false;
  document.documentElement.classList.remove("has-bg-video");
  emitNp();
}

// ---- Steuerung fürs „Now Playing"-Widget ----------------------------------

/** Pause/Weiter über das Widget (überstimmt das Fokus-Gate bis zum nächsten Play). */
export function toggleBgVideoPlay(): void {
  const v = el();
  if (!v || v.hidden || !currentMeta) return;
  if (v.paused) {
    userPaused = false;
    void v.play().catch(() => {});
  } else {
    userPaused = true;
    v.pause();
  }
  emitNp();
}

/** Nächstes / vorheriges Video aus der Bibliothek (Presets + eigene), mit Umlauf. */
export async function stepBgVideo(dir: 1 | -1): Promise<void> {
  const lib = await listBgVideos();
  if (lib.length === 0) return;
  const cur = activeBgVideoId();
  let idx = lib.findIndex((x) => x.id === cur);
  if (idx < 0) idx = dir === 1 ? -1 : 0;
  const target = lib[(idx + dir + lib.length) % lib.length];
  await setActiveBgVideo(target.id);
}

/** Innerhalb des laufenden Videos springen (0..1). */
export function seekBgVideo(fraction: number): void {
  const v = el();
  if (!v || v.hidden || !Number.isFinite(v.duration) || v.duration <= 0) return;
  v.currentTime = Math.max(0, Math.min(1, fraction)) * v.duration;
  emitNp();
}

export async function listBgVideos(): Promise<BgVideoMeta[]> {
  const presets: BgVideoMeta[] = PRESET_VIDEOS.map((p) => ({ id: p.id, name: p.name, preset: true }));
  let own: BgVideoMeta[] = [];
  try {
    const all = await tx<BgVideoRecord[]>("readonly", (s) => s.getAll() as IDBRequest<BgVideoRecord[]>);
    own = all
      .map((r) => ({ id: r.id, name: r.name, preset: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    /* IndexedDB nicht verfügbar */
  }
  return [...presets, ...own];
}

/** Videodatei in die Bibliothek aufnehmen und sofort aktivieren. */
export async function addBgVideo(file: File): Promise<string> {
  const id = Math.random().toString(36).slice(2, 10);
  const name = file.name.replace(/\.[^.]+$/, "");
  await tx("readwrite", (s) => s.put({ id, name, blob: file } as BgVideoRecord));
  await setActiveBgVideo(id);
  return id;
}

export async function setActiveBgVideo(id: string | null): Promise<void> {
  setActiveId(id);
  if (id) await playById(id);
  else hideVideo();
}

export async function removeBgVideo(id: string): Promise<void> {
  if (id.startsWith(PRESET_PREFIX)) return; // Presets kann man nicht löschen
  await tx("readwrite", (s) => s.delete(id));
  if (activeBgVideoId() === id) await setActiveBgVideo(null);
}
