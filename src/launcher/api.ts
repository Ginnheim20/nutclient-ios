// Wrapper um die Tauri-Commands (src-tauri/src/lib.rs). Läuft der Launcher im
// reinen Browser (vite ohne Tauri), gibt es `window.__TAURI_INTERNALS__` nicht –
// dann liefern die Funktionen Demo-Daten, damit die UI trotzdem bedienbar ist.
import type { Account, VersionSummary } from "./types";

export const hasTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri) return demo(cmd, args) as T;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function onEvent<T>(name: string, cb: (payload: T) => void): Promise<void> {
  if (!hasTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<T>(name, (e) => cb(e.payload));
}

export const listVersions = () => invoke<VersionSummary[]>("list_versions");
export const currentAccount = () => invoke<Account | null>("current_account");
export const login = () => invoke<Account>("login");
export const launch = (versionId: string) => invoke<void>("launch", { versionId });

/** Ergebnis einer Modpack-Installation (Rust `modpack::Installed`). */
export interface ModpackInstalled {
  mc: string;
  loader: "fabric" | "neoforge";
  name: string;
  version: string;
  files: number;
  /** Nicht gefundene Mods (CurseForge-Import ohne API-Schlüssel). */
  missing: string[];
}
export interface ModpackProgress {
  profileId: string;
  done: number;
  total: number;
  message: string;
}
/** Modrinth-Modpack in die Instanz laden; Fortschritt als Ereignis „modpack://progress“. */
export const installModpack = (profileId: string, projectId: string) =>
  invoke<ModpackInstalled>("install_modpack", { profileId, projectId });
/** Modpack aus einer Datei (.mrpack von Modrinth, .zip von CurseForge) in die Instanz laden. */
export const installModpackFile = (profileId: string, path: string) =>
  invoke<ModpackInstalled>("install_modpack_file", { profileId, path });

/** Minecraft-Versionen, für die der NUTclient mitgeliefert wird. */
export const NUTCLIENT_VERSIONS = ["26.3", "26.2", "1.21.11"];

/** Block-Texturen (16×16) aus der installierten Minecraft-Jar – für Profilbilder. Im Browser leer. */
export const blockTextures = () => invoke<{ name: string; url: string }[]>("block_textures");

/** Gerätesuche im WLAN starten (ausgeblendete Geräte; retry = schon gefragte noch einmal fragen). */
export const syncStart = (hidden: string[], retry: boolean) => invoke<void>("sync_start", { hidden, retry });

/** Antwort auf „Daten übertragen?“ samt den Launcher-Daten dieses Geräts (localStorage). */
export const syncAnswer = (peerId: string, yes: boolean, storage: string) =>
  invoke<void>("sync_answer", { peerId, yes, storage });

/** Unterordner einer Instanz für eigene Dateien. */
export type InstanceFolder = "" | "mods" | "resourcepacks" | "shaderpacks";

/** Ordner der Instanz (oder einen Unterordner) im Explorer öffnen. */
export const openInstanceFolder = (profileId: string, folder: InstanceFolder = "") =>
  invoke<void>("open_instance_folder", { profileId, folder });

/** Eigene Dateien eines Unterordners (hineingezogene Mods/Pakete, ohne die vom Launcher verwalteten). */
export const listInstanceFiles = (profileId: string, folder: InstanceFolder) =>
  invoke<string[]>("list_instance_files", { profileId, folder });

/** Datei in die Instanz legen (.jar → Mods, .zip → Shader oder Ressourcenpakete); gibt den Unterordner zurück.
 *  NeoForge/Forge-Mods kommen nicht in den Ordner: gibt es sie auf Modrinth für Fabric, steht das in `replacedBy`. */
export const importInstanceFile = (profileId: string, versionId: string, loader: string, path: string) =>
  invoke<{ folder: InstanceFolder; replacedBy: { projectId: string; title: string; loader: string } | null }>(
    "import_instance_file",
    { profileId, versionId, loader, path },
  );

/** Loader-Versionen für eine Minecraft-Version, neueste zuerst: [Version, stabil]. Im Browser leer. */
export const loaderVersions = (mc: string, loader: string) =>
  invoke<[string, boolean][]>("loader_versions", { mc, loader }).then((r) => r ?? []);

/** Instanz als .mrpack in den Downloads-Ordner exportieren; gibt den Dateipfad zurück. */
export const exportMrpack = (p: { profileId: string; name: string; mc: string; loader: string; loaderVersion?: string }) =>
  invoke<string>("export_mrpack", p);

/** Geteilte Ordner (saves, resourcepacks, shaderpacks, screenshots, schematics). */
export const sharedFolders = (profileId: string) => invoke<string[]>("shared_folders", { profileId }).then((r) => r ?? []);
export const setSharedFolder = (profileId: string, folder: string, share: boolean) =>
  invoke<void>("set_shared_folder", { profileId, folder, share });

/** Eigene Mods (z. B. aus einem Modpack) mit Name/Version aus der Jar, an/aus und ob sie zum Loader passen. */
export interface InstanceMod {
  file: string;
  name: string;
  version: string;
  enabled: boolean;
  foreign: string | null;
}
export const listInstanceMods = (profileId: string, loader: string) =>
  invoke<InstanceMod[]>("list_instance_mods", { profileId, loader }).then((r) => r ?? []);

/** Eigene Datei an-/ausschalten (`.disabled`); gibt den neuen Dateinamen zurück. */
export const setInstanceFileEnabled = (profileId: string, folder: InstanceFolder, name: string, enabled: boolean) =>
  invoke<string>("set_instance_file_enabled", { profileId, folder, name, enabled });

/** Eigene Mods der Instanz, die nicht für Fabric sind: [Dateiname, Loader]. */
export const foreignInstanceMods = (profileId: string, loader: string) =>
  invoke<[string, string][]>("foreign_instance_mods", { profileId, loader }).then((r) => r ?? []);

/** Inhalt gleich beim Hinzufügen herunterladen (Shader/Pakete sofort im Spiel wählbar). Im Browser nichts. */
export const installContent = (profileId: string, versionId: string, projectId: string, kind: string, loader: string) =>
  invoke<void>("install_content", { profileId, versionId, projectId, kind, loader });

/** Mod-Loader, mit dem der Launcher eine Instanz startet (NeoForge oder sonst Fabric). */
export const launchLoader = (loader: string): "neoforge" | "fabric" => (loader === "neoforge" ? "neoforge" : "fabric");

/** Eigene Datei aus der Instanz in den Papierkorb legen. */
export const removeInstanceFile = (profileId: string, folder: InstanceFolder, name: string) =>
  invoke<void>("remove_instance_file", { profileId, folder, name });

/** Profil starten (mit NUTclient: Fabric + Mods im eigenen Profilordner, Launcher-Farbe für den Client). */
export const launchProfile = (p: {
  profileId: string;
  versionId: string;
  nutclient: boolean;
  loader?: string;
  accent?: string;
  maxRamMb?: number;
  loaderVersion?: string;
  clientVariant?: string;
  jvmArgs?: string;
  width?: number;
  height?: number;
  fullscreen?: boolean;
  mods?: { projectId: string; enabled: boolean }[];
  packs?: { projectId: string; kind: "resourcepack" | "shader"; enabled: boolean }[];
}) =>
  invoke<void>("launch_profile", { profile: p });

/** Offline-UUID wie Vanilla: namensbasierte UUID v3 über MD5 von "OfflinePlayer:<name>". */
export async function offlineUuid(name: string): Promise<string> {
  const { md5 } = await import("../md5");
  const b = md5(`OfflinePlayer:${name}`)
    .match(/../g)!
    .map((x) => parseInt(x, 16));
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Offline-Konto anlegen (Backend speichert es; im Browser nur lokal berechnet). */
export async function offlineLogin(username: string): Promise<Account> {
  if (hasTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Account>("offline_login", { username });
  }
  return { username, uuid: await offlineUuid(username), offline: true };
}

function demo(cmd: string, _args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "loader_versions":
      return [["0.17.2", true], ["0.17.1", true], ["0.17.0-beta.1", false], ["0.16.14", true]];
    case "shared_folders":
      return [];
    case "export_mrpack":
      return "C:/Users/Demo/Downloads/Modpack.mrpack";
    case "set_shared_folder":
      return null;
    case "list_versions":
      return [
        { id: "1.21.4", type: "release", releaseTime: "2024-12-03" },
        { id: "1.21.1", type: "release", releaseTime: "2024-08-08" },
        { id: "1.20.6", type: "release", releaseTime: "2024-04-29" },
        { id: "1.20.1", type: "release", releaseTime: "2023-06-12" },
      ];
    case "current_account":
      return null;
    case "block_textures":
      return [];
    case "list_instance_files":
      return [];
    case "login":
      return { username: "Steve", uuid: "8667ba71b85a4004af54457a9734eed7" };
    default:
      return null;
  }
}

// ---- Modrinth (öffentliche API, CORS erlaubt) -------------------------------

const MODRINTH = "https://api.modrinth.com/v2";

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
}

const facetForKind: Record<string, string> = {
  mod: "mod",
  modpack: "modpack",
  resourcepack: "resourcepack",
  shader: "shader",
  datapack: "datapack",
};

export interface ModrinthPage {
  hits: ModrinthHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export async function searchModrinth(
  query: string,
  kind: string,
  offset = 0,
  limit = 20,
  /** Weitere Filter, z. B. [["versions:26.3"], ["categories:fabric"]]. */
  extra: string[][] = [],
): Promise<ModrinthPage> {
  const project = facetForKind[kind];
  const groups = [...(project ? [[`project_type:${project}`]] : []), ...extra];
  const facets = JSON.stringify(groups);
  const url =
    `${MODRINTH}/search?limit=${limit}&offset=${offset}` +
    `&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Modrinth ${res.status}`);
  return (await res.json()) as ModrinthPage;
}

// ---- Modrinth Projekt-Detail (für die Vollbild-Ansicht) -------------------

export interface ModrinthGalleryItem {
  url: string;
  /** Originalgröße (url ist verkleinert). */
  raw_url?: string;
  featured: boolean;
  title: string | null;
  description: string | null;
}
export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  categories: string[];
  additional_categories: string[];
  client_side: "required" | "optional" | "unsupported" | "unknown";
  server_side: "required" | "optional" | "unsupported" | "unknown";
  game_versions: string[];
  loaders: string[];
  icon_url: string | null;
  gallery: ModrinthGalleryItem[];
  team: string;
  project_type: string;
  downloads: number;
  followers: number;
  source_url: string | null;
  issues_url: string | null;
  wiki_url: string | null;
}
export interface ModrinthDependency {
  project_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}
export interface ModrinthTeamMember {
  role: string;
  user: { username: string; name: string | null; avatar_url: string | null };
}

async function mfetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MODRINTH}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Modrinth ${res.status}`);
  return (await res.json()) as T;
}

export const getModrinthProject = (id: string) => mfetch<ModrinthProject>(`/project/${id}`);

/** Abhängigkeiten aus der neuesten Version des Projekts. */
export async function getModrinthDependencies(id: string): Promise<ModrinthDependency[]> {
  const versions = await mfetch<{ dependencies: ModrinthDependency[]; date_published: string }[]>(
    `/project/${id}/version`,
  );
  const latest = versions.sort(
    (a, b) => +new Date(b.date_published) - +new Date(a.date_published),
  )[0];
  const deps = latest?.dependencies ?? [];
  // doppelte project_ids entfernen
  const seen = new Set<string>();
  return deps.filter((d) => d.project_id && !seen.has(d.project_id) && seen.add(d.project_id));
}

/** Mehrere Projekte auf einmal (für Abhängigkeits-Namen). */
export async function getModrinthProjectsBulk(
  ids: string[],
): Promise<{ id: string; title: string; icon_url: string | null; slug: string }[]> {
  if (ids.length === 0) return [];
  return mfetch(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
}

export const getModrinthTeam = (teamId: string) =>
  mfetch<ModrinthTeamMember[]>(`/team/${teamId}/members`);

const HEAD_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='#5b8731'/><rect x='8' y='9' width='16' height='14' fill='#c98d6b'/></svg>`,
  );

export function skinHeadUrl(uuid: string | null): string {
  if (!uuid) return HEAD_PLACEHOLDER;
  return `https://crafatar.com/avatars/${uuid}?size=64&overlay`;
}

// ---- Spieler-Skins (Ashcon spiegelt die Mojang-API mit CORS) --------------

export interface PlayerSkin {
  uuid: string;
  username: string;
  skinUrl: string;
  variant: "classic" | "slim";
}

/** Skin eines Minecraft-Spielers anhand des Namens. */
export async function playerSkin(name: string): Promise<PlayerSkin> {
  const res = await fetch(`https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(name)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(res.status === 404 ? "Spieler nicht gefunden" : `Ashcon ${res.status}`);
  const j = (await res.json()) as {
    uuid: string;
    username: string;
    textures: { slim: boolean; skin: { url: string } };
  };
  return {
    uuid: j.uuid,
    username: j.username,
    skinUrl: j.textures.skin.url.replace(/^http:/, "https:"),
    variant: j.textures.slim ? "slim" : "classic",
  };
}

/** Laufende Profil-Spiele in Startreihenfolge (das erste stoppt der große Knopf). */
export const runningInstances = () =>
  invoke<{ profile_id: string; pid: number }[]>("running_instances");

/** Stoppt das laufende Spiel eines Profils. */
export const stopInstance = (profileId: string) => invoke<void>("stop_instance", { profileId });
