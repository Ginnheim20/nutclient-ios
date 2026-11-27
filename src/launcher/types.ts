// Gemeinsame Typen zwischen Frontend und Tauri-Backend.
// Müssen mit den serde-Strukturen in src-tauri/src/minecraft/manifest.rs übereinstimmen.

export interface VersionSummary {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface Account {
  username: string;
  uuid: string;
  offline?: boolean;
  // Access-Token bewusst NICHT ins Frontend geben – bleibt im Backend.
}

/** Absturzanalyse nach dem Spielende (`crash.rs`), Ereignis `launch://crash`. */
export interface CrashReport {
  title: string;
  cause: string;
  hint: string;
  detail: string;
  file: string;
}

export interface LaunchProgress {
  stage:
    | "manifest"
    | "libraries"
    | "assets"
    | "client"
    | "java"
    | "launching"
    | "running"
    | "fabric"
    | "mods"
    /** Hinweis, der als Fehler-Toast erscheint (z. B. Mods ohne Fabric-Fassung) */
    | "warn";
  completed: number;
  total: number;
  message: string;
}
