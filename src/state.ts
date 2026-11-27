// Lokaler Zustand des Launchers (localStorage).
// Profile/Freunde/Einstellungen liegen vorerst im Frontend; das Rust-Backend
// kümmert sich um Auth, Version-Download und Start.

export type ModLoader = "vanilla" | "fabric" | "forge" | "quilt" | "neoforge";

/** Woher eine Instanz stammt (für Anzeige + Import-Logik). */
export type InstanceOrigin =
  | "manual"
  | "modrinth"
  | "curseforge"
  | "mrpack"
  | "vanilla-launcher"
  | "modrinth-app"
  | "prism"
  | "multimc"
  | "labymod"
  | "lunar"
  | "noriskclient"
  | "fastclient";

export interface Profile {
  id: string;
  name: string;
  versionId: string;
  loader: ModLoader;
  loaderVersion?: string;
  /** Mit NUTclient (Fabric + NUTclient-Mod + Account Switcher, Farbe vom Launcher)? */
  nutclient?: boolean;
  /** Welcher Client: NUTclient, NUTclient Classic (neue Fassung) oder ohne. Fehlt er, gilt `nutclient`. */
  clientVariant?: ClientVariant;
  /** Von einem Modpack erzeugt? (Titel des Packs) */
  fromModpack?: string;
  /** Wie die Instanz entstanden ist. */
  origin: InstanceOrigin;
  /**
   * Bei Import aus einem anderen Client:
   *  · "wrapper" – Client bleibt wie er ist, wir starten ihn nur
   *  · "merged"  – Einstellungen/Inhalte in eine native Instanz übernommen
   */
  importMode?: "wrapper" | "merged";
  /** Hinzugefügte Inhalte (Mods, Resource Packs, …). */
  content: ContentEntry[];
  createdAt: number;
  /** Letzter Start (ms seit 1970), für „Zuletzt gespielt“. */
  lastPlayedAt?: number;
  /** Profil-Einstellungen (leer = Standard aus den Launcher-Einstellungen bzw. Minecraft). */
  ramMb?: number;
  jvmArgs?: string;
  width?: number;
  height?: number;
  fullscreen?: boolean;
  /** Modrinth-Projekt des Modpacks (für die Installation). */
  modpackId?: string;
  /** Oder: Modpack-Datei auf der Platte (.mrpack / CurseForge-.zip), per Ziehen ins Select-Fenster. */
  modpackFile?: string;
  /** Beim CurseForge-Import nicht gefundene Mods. */
  missingMods?: string[];
  /** Modpack wird gerade geladen – bis dahin nicht startbar (läuft nach einem Neustart des Launchers weiter). */
  installing?: boolean;
  /** Profilbild: Blocktextur als data-URL (16×16, wird pixelig vergrößert) und ihr Name. */
  icon?: string;
  iconName?: string;
}

/** Client-Fassung eines Profils. */
export type ClientVariant = "nutclient" | "classic" | "none";

/** Auswahl in „Client“ (Profil-Einstellungen und Instanz anlegen). */
export const CLIENT_OPTIONS: { value: ClientVariant; label: string; sub: string }[] = [
  { value: "nutclient", label: "NUTclient", sub: "Liquid Glass, Dynamic Island, Karte, Apps, Server-Hub … – startet mit Fabric." },
  { value: "classic", label: "NUTclient Classic", sub: "Alle Funktionen im Design von Dandelion X (Paket eingebaut), eckig, ohne Dynamic Island – Minecraft 26.3, Fabric." },
  { value: "none", label: "Ohne Client", sub: "Normales Minecraft – nur deine Mods bzw. Vanilla." },
];

/** Client eines Profils (ältere Profile kennen nur `nutclient`). */
export function clientOf(p: { clientVariant?: ClientVariant; nutclient?: boolean }): ClientVariant {
  return p.clientVariant ?? (p.nutclient ? "nutclient" : "none");
}

export interface SkinEntry {
  id: string;
  name: string;
  /** data-URL (Datei) oder Remote-URL (textures.minecraft.net / eigener Dienst). */
  src: string;
  variant: "classic" | "slim";
  source: "player" | "url" | "file" | "preset";
  addedAt: number;
}

/** Custom-Cape (lokal gesammelt, unabhängig vom Konto). */
export interface CapeEntry {
  id: string;
  name: string;
  /** data-URL (Datei) oder Remote-URL zu einer Cape-Textur (64×32). */
  src: string;
  source: "url" | "file" | "preset";
  addedAt: number;
}

export interface ContentEntry {
  projectId: string;
  title: string;
  kind: ContentKind;
  source: "modrinth" | "curseforge";
  /** Aus-geschaltet? (nur gesetzt, wenn der Schalter in der Instanz-Ansicht umgelegt wurde) */
  enabled?: boolean;
}

export type ContentKind =
  | "mod"
  | "modpack"
  | "resourcepack"
  | "shader"
  | "datapack"
  | "world";

export interface Friend {
  id: string;
  name: string;
  messages: { from: "me" | "them"; text: string; at: number }[];
}

export interface Settings {
  theme: "dark" | "light";
  /** Farbfeld-ID aus src/glasscolor.ts – färbt Glas + Akzent. */
  glassColor: string;
  /** Glasstärke 0..1: 0 = komplett durchsichtiges Liquid Glass, 1 = blickdicht. */
  glassStrength: number;
  /** Systemwiedergabe (Songs/Videos, Discord-Call) in der Topbar anzeigen. */
  mediaWidget: boolean;
  maxRamMb: number;
  javaPath: string;
  closeOnLaunch: boolean;
  gameDir: string;
}

interface Store {
  profiles: Profile[];
  activeProfileId: string | null;
  /** Zuletzt gestartete Instanz – der Stage-Play-Button startet diese direkt. */
  lastPlayedProfileId: string | null;
  /** Skin-Bibliothek (lokal gesammelt, unabhängig vom Konto). */
  skins: SkinEntry[];
  activeSkinId: string | null;
  /** Custom-Cape-Bibliothek. */
  capes: CapeEntry[];
  activeCapeId: string | null;
  friends: Friend[];
  settings: Settings;
  readNews: string[];
}

const KEY = "mcl.store.v1";

const defaults: Store = {
  profiles: [],
  activeProfileId: null,
  lastPlayedProfileId: null,
  skins: [],
  activeSkinId: null,
  capes: [],
  activeCapeId: null,
  friends: [],
  settings: {
    theme: "dark",
    glassColor: "orange-2",
    glassStrength: 0.1,
    mediaWidget: true,
    maxRamMb: 4096,
    javaPath: "",
    closeOnLaunch: true,
    gameDir: "",
  },
  readNews: [],
};

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaults);
    const s: Store = { ...structuredClone(defaults), ...JSON.parse(raw) };
    // Neu hinzugekommene Einstellungen (z. B. glassColor) auffüllen.
    s.settings = { ...defaults.settings, ...s.settings };
    // „Glas-Stil"-Schalter (dynamic/solid) → Glasstärke-Regler.
    const legacyStyle = (s.settings as unknown as { glassStyle?: string }).glassStyle;
    if (legacyStyle === "solid") s.settings.glassStrength = 1;
    else if (legacyStyle === "dynamic") s.settings.glassStrength = 0.1;
    if (typeof s.settings.glassStrength !== "number") s.settings.glassStrength = 0.1;
    s.settings.glassStrength = Math.max(0, Math.min(1, s.settings.glassStrength));
    // Ältere Instanzen kennen loader/origin noch nicht.
    for (const p of s.profiles) {
      p.loader ??= "vanilla";
      p.origin ??= p.fromModpack ? "modrinth" : "manual";
      p.content ??= [];
    }
    return s;
  } catch {
    return structuredClone(defaults);
  }
}

export const store: Store = load();

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    localStorage.setItem("mcl.changed.v1", String(Date.now()));   // für die Übertragung zwischen Geräten
  } catch {
    /* Speicher nicht verfügbar – dann eben nur für diese Sitzung. */
  }
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
export function onChange(fn: () => void): void {
  listeners.add(fn);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function activeProfile(): Profile | null {
  return store.profiles.find((p) => p.id === store.activeProfileId) ?? null;
}

/** Die vom Stage-Play-Button zu startende Instanz (zuletzt gespielt → aktiv → erste). */
export function lastPlayedProfile(): Profile | null {
  return (
    store.profiles.find((p) => p.id === store.lastPlayedProfileId) ??
    activeProfile() ??
    store.profiles[0] ??
    null
  );
}
