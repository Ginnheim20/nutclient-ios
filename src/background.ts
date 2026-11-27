// Dauerhaftes Hintergrundbild.
// Reihenfolge: vom Nutzer gewähltes Bild (localStorage) → public/background.*
// → farbiger Verlauf (Fallback in styles.css).

const KEY = "mcl.bg.v1";
const CANDIDATES = ["/background.jpg", "/background.png", "/background.jpeg", "/background.webp"];

export function initBackground(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* kein Speicher */
  }
  if (stored) {
    applyBg(stored);
    return;
  }
  tryNext(0);
}

function applyBg(url: string): void {
  document.documentElement.style.setProperty("--bg-image", `url("${url}")`);
  document.documentElement.classList.add("has-bg-image");
}

function tryNext(i: number): void {
  if (i >= CANDIDATES.length) return;
  const img = new Image();
  img.onload = () => applyBg(CANDIDATES[i]);
  img.onerror = () => tryNext(i + 1);
  img.src = CANDIDATES[i];
}

/** Vom Nutzer gewähltes Bild übernehmen: herunterskalieren, als JPEG in localStorage. */
export async function setBackgroundFromFile(file: File): Promise<void> {
  const dataUrl = await downscale(file, 2560, 0.85);
  try {
    localStorage.setItem(KEY, dataUrl);
  } catch {
    // zu groß – trotzdem für diese Sitzung anzeigen
  }
  applyBg(dataUrl);
}

export function clearBackground(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* egal */
  }
  document.documentElement.classList.remove("has-bg-image");
  document.documentElement.style.removeProperty("--bg-image");
  tryNext(0);
}

export function hasCustomBackground(): boolean {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

function downscale(file: File, maxSide: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("kein 2D-Kontext"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Bild konnte nicht gelesen werden"));
    };
    img.src = url;
  });
}
