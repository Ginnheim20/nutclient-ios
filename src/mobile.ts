// Handy-Modus: iPhone/Android-App (Tauri mobil) oder schmales Fenster bzw. ?mobile in der Vorschau.
// Setzt sofort beim Laden <html class="mobile"> (+ "ios" auf dem iPhone) – das CSS macht daraus die kompakte Ansicht:
// Leiste unten wie eine App-Tableiste, Panels über den ganzen Bildschirm, keine Fensterknöpfe, kein Auto-Update.

const ua = navigator.userAgent;
/** Läuft auf einem iPhone/iPad (auch iPadOS, das sich als Mac ausgibt). */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
/** Läuft auf einem Handy/Tablet (echtes Gerät, nicht nur schmales Fenster). */
export const isMobileDevice = isIOS || /Android/.test(ua);
const forced = new URLSearchParams(location.search).has("mobile");

/** Handy-Ansicht aktiv? (Gerät, ?mobile oder sehr schmales Fenster in der Browser-Vorschau) */
export function isMobile(): boolean {
  return isMobileDevice || forced || window.innerWidth < 560;
}

function apply(): void {
  const root = document.documentElement;
  root.classList.toggle("mobile", isMobile());
  root.classList.toggle("ios", isIOS);
}

apply();
window.addEventListener("resize", apply);
