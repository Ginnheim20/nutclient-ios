// Fenster-Steuerung (Minimieren/Maximieren/Schließen) in der Topbar.
// Die native Windows-Titelleiste ist aus (tauri.conf.json: "decorations": false);
// gezogen wird an der Topbar (data-tauri-drag-region in index.html).
// Ohne Tauri (Browser-Preview) bleiben die Knöpfe ausgeblendet.
import { hasTauri } from "./launcher/api";
import { isMobileDevice } from "./mobile";

export async function initTitlebar(): Promise<void> {
  if (!hasTauri || isMobileDevice) return;   // iPhone/Android: keine Fenster
  document.documentElement.classList.add("has-titlebar");
  const controls = document.getElementById("win-controls");
  if (controls) controls.hidden = false;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();

  const on = (id: string, fn: () => void) =>
    document.getElementById(id)?.addEventListener("click", fn);

  on("tb-min", () => void win.minimize());
  on("tb-max", () => void win.toggleMaximize());
  on("tb-close", () => void win.close());

  const syncMaxState = async () => {
    try {
      document.documentElement.classList.toggle("win-maximized", await win.isMaximized());
    } catch {
      /* egal */
    }
  };
  void syncMaxState();
  await win.onResized(() => void syncMaxState());
}
