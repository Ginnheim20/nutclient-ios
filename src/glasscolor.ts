// Glasfarbe: färbt den Akzent (aktive/ausgewählte Elemente, Buttons) und die
// Glasflächen. Kurze Preset-Auswahl + „Eigene Farbe" (nativer Farbwähler /
// Hex-Code). Umgesetzt über CSS-Variablen auf :root, die styles.css auswertet.
import { store } from "./state";

export interface GlassColor {
  id: string;
  /** Anzeige-Name. */
  label: string;
  /** Aktive/ausgewählte Elemente + Tönung des Glases. */
  accent: string;
  /** Hover-Variante des Akzents. */
  hover: string;
}

// Bewusst kurz: eine gute Stufe je Farbton.
export const GLASS_PRESETS: GlassColor[] = [
  { id: "green-2", label: "Grün", accent: "#3fae4a", hover: "#4ec95a" },
  { id: "teal-2", label: "Türkis", accent: "#25b0a4", hover: "#3fc7ba" },
  { id: "blue-2", label: "Blau", accent: "#3d7be0", hover: "#5a95f0" },
  { id: "purple-2", label: "Lila", accent: "#8a4fe6", hover: "#a06ef0" },
  { id: "pink-2", label: "Pink", accent: "#ec5f97", hover: "#f57fae" },
  { id: "orange-2", label: "Orange", accent: "#f2882f", hover: "#ff9f4d" },
  { id: "slate-2", label: "Grau", accent: "#7c8aa0", hover: "#97a4b8" },
];

export const GLASS_COLORS: GlassColor[] = GLASS_PRESETS;
export const DEFAULT_GLASS_COLOR = "orange-2";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (s: string): boolean => HEX_RE.test(s);
/** „#abc" / „abcabc" / „#ABCABC" → „#aabbcc" bzw. null wenn ungültig. */
export function normalizeHex(raw: string): string | null {
  let h = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

function lighten(hex: string, amt = 0.16): string {
  const [r, g, b] = parse(hex);
  const up = (v: number) => Math.round(v + (255 - v) * amt);
  return `#${[up(r), up(g), up(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function glassColor(id: string = store.settings.glassColor): GlassColor {
  if (id && isHex(id)) return { id, label: "Eigene", accent: id, hover: lighten(id) };
  return (
    GLASS_PRESETS.find((c) => c.id === id) ??
    GLASS_PRESETS.find((c) => c.id === DEFAULT_GLASS_COLOR)!
  );
}

export function applyGlassColor(): void {
  const c = glassColor();
  const s = document.documentElement.style;
  s.setProperty("--accent", c.accent);
  s.setProperty("--accent-hover", c.hover);
  s.setProperty("--glass-tint", c.accent);
  applyGlassStrength();
}

type RGBA = [number, number, number, number];

function parse(c: string): RGBA {
  if (c[0] === "#") {
    const h = c.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const m = c.match(/[\d.]+/g) ?? ["0", "0", "0"];
  return [+m[0], +m[1], +m[2], m[3] != null ? +m[3] : 1];
}
/** t=0 → a, t=1 → b */
function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    +(a[3] + (b[3] - a[3]) * t).toFixed(3),
  ];
}
const rgba = (c: RGBA): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`;

/** Kein Kontext-Tönung mehr – Funktion bleibt als No-op, damit Aufrufer heil sind. */
export function setContextColor(_rgb: [number, number, number] | null): void {
  /* bewusst leer: das Glas soll wie im Original neutral bleiben */
}

/**
 * Glasstärke 0..1: 0 = durchsichtiges Glas (Original-Look), 1 = blickdichte Fläche.
 * Skaliert nur die Deckkraft der großen Flächen; alles andere macht styles.css
 * über `--glass-strength` (Blur) bzw. bleibt statisch wie im Original.
 */
export function applyGlassStrength(): void {
  const s = Math.max(0, Math.min(1, store.settings.glassStrength ?? 0.1));
  const st = document.documentElement.style;
  st.setProperty("--glass-strength", String(s));

  const dark = store.settings.theme !== "light";
  const tint = parse(glassColor().accent);
  // Original-Deckkraft der Flächen → blickdicht, mit einer Prise Glasfarbe.
  const railFrom: RGBA = dark ? [33, 33, 39, 0.24] : [255, 255, 255, 0.5];
  const panelFrom: RGBA = dark ? [38, 38, 44, 0.4] : [255, 255, 255, 0.62];
  const toOpaque = (base: RGBA): RGBA => {
    const t = mix([base[0], base[1], base[2], 1], tint, 0.08);
    return [t[0], t[1], t[2], 1];
  };
  const lerp = (from: RGBA) => rgba(mix(from, toOpaque(from), s));
  st.setProperty("--glass-panel", lerp(railFrom));
  st.setProperty("--glass-panel-strong", lerp(panelFrom));
}
