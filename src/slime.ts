// Idle-Game unten rechts: ein 3D-Minecraft-Schleim (kompakt).
//  • Klick sammelt „Schleim" (goo) – mit Krit-Chance, Squash & Tropfen.
//  • Shop mit ENDLICHEN Stufen und VERSCHIEDENEN Mechaniken (nicht nur Geld-
//    Booster): Klick, Auto-Klicker mit Material-Stufen (Kupfer→Netherit),
//    Krit-Chance, Krit-Faktor, Klick-/Auto-/Gesamt-Multiplikatoren. Beim
//    Rüberfahren zeigt jede Zeile eine kurze Beschreibung.
//  • Preis wächst + Untergrenze ≈ 95 s aktueller Produktion → am Ende wartet
//    man wieder ~2 min pro Upgrade statt „sofort".
//  • EVENTS: Liquid-Glass-Bühne hinter dem Schleim; gute UND schlechte Events
//    färben Schleim + Glas, streuen Partikel (Schnee, Münzen, Funken, Blätter,
//    Asche, Blasen, Sterne) und verändern die Produktion. Konsole: /event.
//  • Konsole (Einstellungen): runSlimeCommand("/reset") setzt alles zurück.
// Alles lokal in localStorage – unabhängig vom Launcher-Zustand.
import { h } from "./ui";

interface Upgrade {
  id: string;
  name: string;
  desc: string;
  /** längerer Beschreibungstext für das Hover-Tooltip */
  long?: string;
  /** Startpreis (= Preis der ganzen Preis-Stufe / des „Bandes") */
  base: number;
  /** welches Band (0..n) – für Farbe/Gruppierung */
  band: number;
  /** höchste kaufbare Stufe */
  max: number;
  click?: number; // +x pro Klick (additiv)
  auto?: number; // +x Auto-Klick-Hände
  cps?: number; // +x Schleim / Sek. (passiv)
  crit?: number; // +x Krit-Chance
  mult?: number; // ×x auf ALLES (pro Stufe)
  clickMult?: number; // ×x nur auf Klicks (pro Stufe)
  autoMult?: number; // ×x nur auf Auto-Klicker (pro Stufe)
  critX?: number; // +x auf den Krit-Faktor (Start ×5)
  /** Auto-Klick-Rate je Stufe (kumuliert) – für den Material-Auto-Klicker */
  steps?: number[];
  /** Name je Stufe – z. B. Kupfer … Netherit */
  stepNames?: string[];
}

// Preis-„Bänder": alle Upgrades eines Bandes haben denselben STARTPREIS.
// Man wählt also klug, welches man zuerst nimmt (danach wird es teurer als
// seine Band-Nachbarn). Mischung aus Klick / Auto / Passiv / Krit / Multi.
const BANDS: { base: number; ups: Omit<Upgrade, "base" | "band">[] }[] = [
  {
    base: 18,
    ups: [
      { id: "hand", name: "Klebrige Hand", desc: "+1 pro Klick", max: 12, click: 1,
        long: "Eine klebrige Handfläche legt sich um den Schleim – jeder Klick bringt 1 Schleim mehr." },
      { id: "mini", name: "Mini-Schleim", desc: "+Kumpel · +0,5/s", max: 8, cps: 0.5,
        long: "Ein kleiner Kumpel-Schleim hüpft mit und sammelt nebenbei 0,5 Schleim je Sekunde." },
      { id: "drip", name: "Schleimtropfen", desc: "+2 / Sek.", max: 10, cps: 2,
        long: "Ein undichter Hahn tropft Schleim – dauerhaft +2 pro Sekunde, ganz ohne Klicken." },
      { id: "finger", name: "Flinker Finger", desc: "Klick ×1,3", max: 5, clickMult: 1.3,
        long: "Fingertraining: jeder Klick wird pro Stufe um 30 % wertvoller (multiplikativ, nur auf Klicks)." },
      { id: "crown", name: "Schleim-Krone", desc: "Kupfer → Diamant · ×1,12", max: 4, mult: 1.12,
        stepNames: ["Kupfer", "Eisen", "Gold", "Diamant"],
        long: "Eine echte Krone auf Jeffs Kopf – aus Kupfer, dann Eisen, Gold und Diamant. Jede Material-Stufe gibt ×1,12 auf die gesamte Produktion." },
    ],
  },
  {
    base: 260,
    ups: [
      { id: "clicker", name: "Auto-Klicker", desc: "Kupfer → Netherit", max: 6,
        steps: [2, 6, 15, 38, 95, 240],
        stepNames: ["Kupfer", "Eisen", "Gold", "Smaragd", "Diamant", "Netherit"],
        long: "Ein automatischer Klick-Arm. Jede Material-Stufe – von Kupfer bis Netherit – klickt deutlich schneller (2 → 240 Klicks/s)." },
      { id: "fist", name: "Schleimfaust", desc: "+6 pro Klick", max: 12, click: 6,
        long: "Eine wuchtige Faust drückt tiefer in den Schleim – +6 Schleim pro Klick." },
      { id: "lucky", name: "Glücksklee", desc: "+4 % Krit", max: 10, crit: 0.04,
        long: "Ein Glücksklee am Handgelenk – +4 % Chance, dass ein Klick als Krit den vollen Faktor trifft." },
      { id: "sprout", name: "Schleimspross", desc: "+9 / Sek.", max: 12, cps: 9,
        long: "Ein wuchernder Spross zieht Schleim aus dem Boden – +9 pro Sekunde." },
      { id: "tower", name: "Schleim-Turm", desc: "+Turm · +16/s", max: 4, cps: 16,
        long: "Türmt Kumpel-Schleime am Bühnenrand auf – jede Stufe +16 pro Sekunde und ein Turm mehr." },
    ],
  },
  {
    base: 4200,
    ups: [
      { id: "cube", name: "Schleimwürfel", desc: "+40 / Sek.", max: 14, cps: 40,
        long: "Ein kompakter Schleimwürfel arbeitet leise vor sich hin – +40 pro Sekunde." },
      { id: "wrist", name: "Geöltes Handgelenk", desc: "Auto ×1,35", max: 6, autoMult: 1.35,
        long: "Frisch geölt: alle Auto-Klicker arbeiten pro Stufe 35 % schneller (nur Auto-Klick-Ertrag)." },
      { id: "grip", name: "Klebe-Griff", desc: "+26 pro Klick", max: 12, click: 26,
        long: "Ein rutschfester Griff holt mehr aus jedem Klick – +26 Schleim." },
      { id: "shard", name: "Kern-Splitter", desc: "×1,3 auf alles", max: 5, mult: 1.3,
        long: "Ein Splitter des Schleimkerns verstärkt ALLES – ×1,3 auf Klicks, Auto und Passiv, pro Stufe." },
      { id: "hammer", name: "Kritischer Hammer", desc: "Krit-Faktor +1", max: 5, critX: 1,
        long: "Ein schwerer Hammer macht Krits härter: +1 auf den Krit-Faktor (Start ×5, also ×6, ×7 …)." },
    ],
  },
  {
    base: 78_000,
    ups: [
      { id: "hive", name: "Schleimnest", desc: "+220 / Sek.", max: 12, cps: 220,
        long: "Ein summendes Nest voller Mini-Schleime – +220 pro Sekunde." },
      { id: "portal", name: "Schleimportal", desc: "+Portal · +400/s", max: 5, cps: 400,
        long: "Öffnet ein Portal hinter dem Schleim, aus dem Nachschub quillt – +400 pro Sekunde je Stufe." },
      { id: "forge", name: "Klick-Schmiede", desc: "Klick ×1,4", max: 5, clickMult: 1.4,
        long: "In der Schmiede wird jeder Klick geschärft – ×1,4 auf den Klickwert pro Stufe." },
      { id: "clover", name: "Vierblättrig", desc: "+6 % Krit", max: 8, crit: 0.06,
        long: "Ein echtes vierblättriges Kleeblatt – +6 % Krit-Chance pro Stufe." },
      { id: "crystal", name: "Energie-Kristall", desc: "+Kristall · ×1,28", max: 6, mult: 1.28,
        long: "Ein schwebender Kristall bündelt die Schleim-Energie – ×1,28 auf alles, pro Stufe." },
    ],
  },
  {
    base: 1_500_000,
    ups: [
      { id: "dim", name: "Schleim-Dimension", desc: "+3200 / Sek.", max: 14, cps: 3200,
        long: "Eine kleine Tasche-Dimension produziert im Hintergrund weiter – +3200 pro Sekunde." },
      { id: "turbo", name: "Turbo-Antrieb", desc: "Auto ×1,6", max: 6, autoMult: 1.6,
        long: "Ein Turbolader für die Auto-Klicker – ×1,6 auf den gesamten Auto-Klick-Ertrag pro Stufe." },
      { id: "gauntlet", name: "Panzerhand", desc: "+1200 pro Klick", max: 12, click: 1200,
        long: "Eine gepanzerte Faust – jeder Klick schlägt +1200 Schleim heraus." },
      { id: "prism", name: "Prisma-Kern", desc: "×1,42 auf alles", max: 5, mult: 1.42,
        long: "Bricht die Schleim-Energie in alle Farben und verstärkt sie – ×1,42 auf alles pro Stufe." },
      { id: "omen", name: "Böses Omen", desc: "Krit-Faktor +2", max: 5, critX: 2,
        long: "Ein dunkles Vorzeichen – Krits treffen viel härter: +2 auf den Krit-Faktor pro Stufe." },
    ],
  },
  {
    base: 34_000_000,
    ups: [
      { id: "nebula", name: "Schleim-Nebel", desc: "+52k / Sek.", max: 12, cps: 52_000,
        long: "Ein leuchtender Nebel kondensiert ständig zu Schleim – +52 000 pro Sekunde." },
      { id: "swarmc", name: "Klick-Schwarm", desc: "Auto ×1,9", max: 5, autoMult: 1.9,
        long: "Ein Schwarm winziger Klick-Hände – ×1,9 auf den Auto-Klick-Ertrag pro Stufe." },
      { id: "quartz", name: "Über-Kern", desc: "×1,55 auf alles", max: 5, mult: 1.55,
        long: "Ein überladener Kristallkern – ×1,55 auf die gesamte Produktion pro Stufe." },
      { id: "megacrit", name: "Schleim-Horoskop", desc: "+9 % Krit", max: 6, crit: 0.09,
        long: "Die Sterne stehen günstig – +9 % Krit-Chance pro Stufe." },
      { id: "flux", name: "Schleim-Fluss", desc: "+150k / Sek.", max: 12, cps: 150_000,
        long: "Ein reißender Schleimstrom – +150 000 pro Sekunde." },
    ],
  },
  {
    base: 900_000_000,
    ups: [
      { id: "cosmos", name: "Schleim-Kosmos", desc: "+900k / Sek.", max: 12, cps: 900_000,
        long: "Ein ganzer kleiner Kosmos aus Schleim – +900 000 pro Sekunde." },
      { id: "godhand", name: "Gott-Hand", desc: "Klick ×1,8", max: 5, clickMult: 1.8,
        long: "Die Hand eines Schleim-Gottes – ×1,8 auf jeden Klick pro Stufe." },
      { id: "singular", name: "Singularitäts-Kern", desc: "×1,75 auf alles", max: 4, mult: 1.75,
        long: "Ein Punkt unendlicher Schleim-Dichte – ×1,75 auf alles pro Stufe." },
      { id: "bigbang", name: "Urknall-Krit", desc: "Krit-Faktor +4", max: 4, critX: 4,
        long: "Jeder Krit ist ein kleiner Urknall – +4 auf den Krit-Faktor pro Stufe." },
      { id: "eternity", name: "Ewigkeits-Kern", desc: "×2 auf alles", max: 4, mult: 2,
        long: "Läuft für immer weiter – ×2 auf die gesamte Produktion pro Stufe." },
    ],
  },
];

const UPGRADES: Upgrade[] = BANDS.flatMap((b, bi) =>
  b.ups.map((u) => ({ ...u, base: b.base, band: bi })),
);
/** Auto-Klick-Quellen (steuern die kreisenden Hände). */
const HAND_IDS = ["clicker", "wrist", "turbo", "swarmc"];

/** Jeffs Name – im Spiel selbst nicht sichtbar, nur im Tutorial (`tutorial.ts`). */
export const SLIME_NAME = "Jeff";
/** Kronen-Material je Stufe (1..4): Reif / Zacken / Edelstein. */
const CROWN_MAT: { band: string; main: string; gem: string }[] = [
  { band: "#5c3016", main: "#c87b3c", gem: "#ffd9a8" }, // Kupfer
  { band: "#7f8489", main: "#d3d7dc", gem: "#ffffff" }, // Eisen
  { band: "#a87a12", main: "#f2c744", gem: "#fff4c2" }, // Gold
  { band: "#1f8a99", main: "#5fe6e0", gem: "#ecffff" }, // Diamant
];
/** Pixel-Krone als SVG – tier = 1..4. */
function crownSvg(tier: number): string {
  const c = CROWN_MAT[Math.max(0, Math.min(3, tier - 1))];
  return (
    '<svg viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
    `<path d="M2 10 L2 3 L7 7 L12 1 L17 7 L22 3 L22 10 Z" fill="${c.main}" stroke="#1c1a10" stroke-width="1" stroke-linejoin="round"/>` +
    `<rect x="2" y="10" width="20" height="4" fill="${c.band}" stroke="#1c1a10" stroke-width="1"/>` +
    `<rect x="5" y="10.5" width="2.4" height="2.4" fill="${c.gem}"/>` +
    `<rect x="10.8" y="10.5" width="2.4" height="2.4" fill="${c.gem}"/>` +
    `<rect x="16.6" y="10.5" width="2.4" height="2.4" fill="${c.gem}"/>` +
    `<path d="M2 3 L7 7 L12 1 L17 7 L22 3 L22 4.6 L17 8.6 L12 2.6 L7 8.6 L2 4.6 Z" fill="#ffffff" opacity="0.4"/>` +
    "</svg>"
  );
}

/** Farbe des Schleims je Band-Stufe (letzte = Regenbogen). */
const TIER_RGB: [number, number, number][] = [
  [116, 196, 72], // 0 grün
  [150, 222, 74], // 1 limette
  [58, 198, 150], // 2 smaragd
  [46, 190, 214], // 3 cyan
  [92, 142, 242], // 4 blau
  [164, 104, 234], // 5 lila
  [230, 96, 176], // 6 magenta
  [244, 196, 66], // 7 gold
];

// ---- Events -------------------------------------------------------
type Particle = "snow" | "coin" | "spark" | "leaf" | "ash" | "bubble" | "star" | "none";
interface SlimeEvent {
  id: string;
  name: string;
  emoji: string;
  good: boolean;
  rgb: [number, number, number];
  particle: Particle;
  /** Multiplikatoren (1 = neutral): click, auto, cps, crit, all */
  mods: { click?: number; auto?: number; cps?: number; crit?: number; all?: number };
}
const EVENTS: SlimeEvent[] = [
  // — gute Events —
  { id: "winter", name: "Winterzauber", emoji: "❄️", good: true, rgb: [150, 205, 255],
    particle: "snow", mods: { cps: 1.7 } },
  { id: "goldrush", name: "Goldrausch", emoji: "🪙", good: true, rgb: [245, 198, 70],
    particle: "coin", mods: { click: 2.6 } },
  { id: "overclock", name: "Übertaktung", emoji: "⚡", good: true, rgb: [120, 240, 225],
    particle: "spark", mods: { auto: 2.4 } },
  { id: "bloom", name: "Schleimblüte", emoji: "🌸", good: true, rgb: [175, 235, 150],
    particle: "leaf", mods: { all: 1.45 } },
  { id: "luck", name: "Glückssträhne", emoji: "🍀", good: true, rgb: [90, 225, 150],
    particle: "star", mods: { crit: 3 } },
  { id: "feast", name: "Schleim-Schlemmerei", emoji: "🍭", good: true, rgb: [255, 150, 205],
    particle: "bubble", mods: { all: 1.25, click: 1.6 } },
  // — schlechte Events —
  { id: "drought", name: "Dürre", emoji: "🏜️", good: false, rgb: [214, 178, 120],
    particle: "ash", mods: { cps: 0.35 } },
  { id: "flu", name: "Schleim-Schnupfen", emoji: "🤧", good: false, rgb: [150, 190, 95],
    particle: "bubble", mods: { click: 0.45 } },
  { id: "blackout", name: "Blackout", emoji: "🌑", good: false, rgb: [95, 100, 120],
    particle: "ash", mods: { auto: 0 } },
  { id: "sludge", name: "Zäher Schlamm", emoji: "🐌", good: false, rgb: [120, 125, 95],
    particle: "bubble", mods: { all: 0.5 } },
  { id: "gloom", name: "Trübsinn", emoji: "👻", good: false, rgb: [125, 140, 165],
    particle: "none", mods: { crit: 0, cps: 0.8 } },
];
const PCOUNT: Record<Particle, number> = {
  snow: 22, coin: 16, spark: 14, leaf: 14, ash: 18, bubble: 14, star: 16, none: 0,
};

/** aktive Event-Multiplikatoren (global, damit die per*-Funktionen sie sehen) */
const ev = { click: 1, auto: 1, cps: 1, crit: 1, all: 1 };
let activeEvent: SlimeEvent | null = null;

const KEY = "mcl.slime.v1";
interface SlimeSave {
  goo: number;
  up: Record<string, number>;
  ts: number;
}

function load(): SlimeSave {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { goo: 0, up: {}, ts: Date.now(), ...raw };
  } catch {
    return { goo: 0, up: {}, ts: Date.now() };
  }
}
function persist(s: SlimeSave): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* egal */
  }
}

const owned = (s: SlimeSave, id: string): number => Math.max(0, Math.floor(s.up[id] ?? 0));

const globalMult = (s: SlimeSave): number =>
  UPGRADES.reduce((m, u) => (u.mult ? m * Math.pow(u.mult, owned(s, u.id)) : m), 1);
const clickMultP = (s: SlimeSave): number =>
  UPGRADES.reduce((m, u) => (u.clickMult ? m * Math.pow(u.clickMult, owned(s, u.id)) : m), 1);
const autoMultP = (s: SlimeSave): number =>
  UPGRADES.reduce((m, u) => (u.autoMult ? m * Math.pow(u.autoMult, owned(s, u.id)) : m), 1);
const critMult = (s: SlimeSave): number =>
  5 + UPGRADES.reduce((t, u) => t + (u.critX ?? 0) * owned(s, u.id), 0);

/** Auto-Klick-Rate eines gestuften Upgrades (Material-Auto-Klicker). */
const stepVal = (s: SlimeSave, u: Upgrade): number => {
  if (!u.steps) return 0;
  const n = owned(s, u.id);
  return n > 0 ? u.steps[Math.min(n, u.steps.length) - 1] : 0;
};

const rawClick = (s: SlimeSave): number =>
  (1 + UPGRADES.reduce((t, u) => t + (u.click ?? 0) * owned(s, u.id), 0)) *
  clickMultP(s) * globalMult(s);
const rawAutoRate = (s: SlimeSave): number =>
  UPGRADES.reduce((t, u) => t + (u.auto ?? 0) * owned(s, u.id) + stepVal(s, u), 0) * autoMultP(s);
const rawPassive = (s: SlimeSave): number =>
  UPGRADES.reduce((t, u) => t + (u.cps ?? 0) * owned(s, u.id), 0) * globalMult(s);

const perClick = (s: SlimeSave): number => rawClick(s) * ev.click * ev.all;
const autoPerSec = (s: SlimeSave): number => rawAutoRate(s) * ev.auto;
const passivePerSec = (s: SlimeSave): number => rawPassive(s) * ev.cps * ev.all;
const critChance = (s: SlimeSave): number =>
  Math.min(0.85, UPGRADES.reduce((t, u) => t + (u.crit ?? 0) * owned(s, u.id), 0)) * ev.crit;
const perSec = (s: SlimeSave): number => passivePerSec(s) + autoPerSec(s) * perClick(s);
/** Produktion OHNE Events – Basis für die Preis-Untergrenze (stabil während Events). */
const baseProd = (s: SlimeSave): number => rawPassive(s) + rawAutoRate(s) * rawClick(s);

// Preis: Kurve × 1.15^Stufe ODER ~90 s aktueller (event-freier) Produktion –
// je nachdem, was größer ist. KEINE Deckelung mehr: sobald man Einkommen hat,
// kostet JEDER Kauf spürbar Wartezeit, man kann nicht mehr durchklicken.
const WAIT_SEC = 90;
const cost = (u: Upgrade, n: number, prod: number): number => {
  if (n >= u.max) return Infinity;
  const curve = u.base * Math.pow(1.15, n);
  return Math.ceil(Math.max(curve, prod * WAIT_SEC));
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.floor(n));
  const units = ["K", "Mio", "Mrd", "Bio", "Brd", "Trd", "Qa", "Qi"];
  let i = -1;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  const str = n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : String(Math.floor(n));
  return `${str.replace(".", ",")} ${units[i]}`;
}
function fmtRate(n: number): string {
  if (n > 0 && n < 100) return (Math.round(n * 10) / 10).toString().replace(".", ",");
  return fmt(n);
}

const FACE =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
  '<g fill="#123d0a">' +
  '<rect x="3.5" y="4.5" width="2.6" height="3.6"/><rect x="9.9" y="4.5" width="2.6" height="3.6"/>' +
  '<rect x="5.6" y="10.4" width="1.5" height="1.5"/><rect x="7.1" y="11.6" width="1.8" height="1.5"/>' +
  '<rect x="8.9" y="10.4" width="1.5" height="1.5"/></g></svg>';

const HAND =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
  '<path fill="#ffd7a6" stroke="#5b3a1d" stroke-width="1" stroke-linejoin="round" ' +
  'd="M6 2h2v5h1V4h2v4h1V6h2v7l-3 2H7l-3-4V8h2z"/></svg>';

/** Sechs Cube-Faces mit `<cls>-f <cls>-<seite>` (front optional mit Gesicht). */
function cube(cls: string, withFace = false): HTMLElement {
  return h(
    "div",
    { class: cls },
    ["front", "back", "left", "right", "top", "bottom"].map((f) =>
      h(
        "div",
        { class: `${cls}-f ${cls}-${f}` },
        withFace && f === "front" ? [h("div", { class: "slime-face", html: FACE })] : [],
      ),
    ),
  );
}
/** durchsichtige Hülle + opaker Kern mit Gesicht – für Haupt- und Kumpel-Schleim. */
export function slimeBody(): HTMLElement {
  return h("div", { class: "slime-cube" }, [cube("slime-shell"), cube("slime-core", true)]);
}

// Positionen (%) der Kumpel-Schleime – dicht um den Fuß des großen Schleims,
// ohne ihn zu verdecken (50/50 = Mitte).
const MINI_SPOTS = [
  [20, 94], [50, 102], [80, 94], [4, 74], [96, 72], [34, 86], [66, 86], [50, 116],
];
// Portale – hinter dem Schleim, oben, weit gestreut.
const PORTAL_SPOTS = [
  [4, 22], [96, 18], [22, 4], [78, 6],
];
// Schleim-Türme – seitlich am Boden.
const TOWER_SPOTS = [
  [-14, 96], [112, 92], [-6, 66], [104, 62],
];
// Energie-Kristalle – schweben um den Schleim.
const CRYSTAL_SPOTS = [
  [-10, 42], [110, 38], [12, -12], [88, -14], [-4, 14], [102, 12],
];

let commandHandler: ((line: string) => string) | null = null;
/** Konsolen-Befehl ausführen (siehe Einstellungen → Konsole). Gibt die Antwort-Zeile(n) zurück. */
export function runSlimeCommand(line: string): string {
  return commandHandler ? commandHandler(line) : "Schleim-Spiel ist noch nicht geladen.";
}

export function initSlime(): void {
  const s = load();
  activeEvent = null;
  ev.click = ev.auto = ev.cps = ev.crit = ev.all = 1;

  const away = Math.min((Date.now() - s.ts) / 1000, 8 * 3600);
  if (away > 5) s.goo += away * perSec(s);
  s.ts = Date.now();

  // ---- DOM ----------------------------------------------------------
  const cursors = h("div", { class: "slime-cursors" });
  const slime = h("button", { class: "slime", type: "button", "aria-label": "Schleim klicken" }, [
    slimeBody(),
    cursors,
  ]);
  const extras = h("div", { class: "slime-extras" });
  const particles = h("div", { class: "slime-particles" });
  const glass = h("div", { class: "slime-glass" }, [particles]);

  const evEmoji = h("span", { class: "slime-event-emoji" });
  const evName = h("span", { class: "slime-event-name" });
  const evBarFill = h("i");
  const evBanner = h("div", { class: "slime-event", hidden: true }, [
    evEmoji,
    evName,
    h("span", { class: "slime-event-bar" }, [evBarFill]),
  ]);

  const stage = h("div", { class: "slime-stage" }, [glass, extras, slime, evBanner]);

  const num = h("div", { class: "slime-num" });
  const rate = h("div", { class: "slime-rate", hidden: true });
  const countBtn = h("button", { class: "slime-count", type: "button", title: "Upgrades öffnen" }, [
    num,
    rate,
  ]);

  const shopList = h("div", { class: "slime-shop-list" });
  const shopRate = h("span", { class: "slime-shop-rate" });
  const shop = h("div", { class: "slime-shop", hidden: true }, [
    h("div", { class: "slime-shop-head" }, [h("span", { textContent: "Upgrades" }), shopRate]),
    shopList,
  ]);

  // Zahl + Klicks/Sek. sitzen UNTER dem Schleim
  // Pfeil unter der Zähler-Pille: erscheint nur bei Annäherung, schiebt alles nach unten weg
  const chevDown = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>`;
  const chevUp = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5 6 4l3.5 3.5"/></svg>`;
  const hideBtn = h("button", { class: "slime-hide", type: "button", title: "Schleim ausblenden", "aria-label": "Schleim ausblenden", html: chevDown });
  const dock = h("div", { class: "slime-dock" }, [hideBtn]);
  const widget = h("div", { class: "slime-widget", id: "slime-widget" }, [shop, stage, countBtn, dock]);
  const tip = h("div", { class: "slime-tip", hidden: true });
  widget.append(tip);
  document.body.append(widget);

  // Rückholen: kleiner Pfeil am unteren Bildschirmrand, erscheint bei Annäherung
  const peekBtn = h("button", { class: "slime-peek", type: "button", title: "Schleim einblenden", "aria-label": "Schleim einblenden", html: chevUp });
  document.body.append(peekBtn);

  const HIDE_KEY = "mcl.slime.hidden";
  let hidden = false;
  try {
    hidden = localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    /* Storage nicht verfügbar – dann eben sichtbar */
  }
  function setHidden(v: boolean): void {
    hidden = v;
    widget.classList.toggle("slime-away", v);
    peekBtn.classList.toggle("show", v);
    if (v) setShop(false);
    try {
      localStorage.setItem(HIDE_KEY, v ? "1" : "0");
    } catch {
      /* ignorieren */
    }
  }
  hideBtn.addEventListener("click", () => setHidden(true));
  peekBtn.addEventListener("click", () => setHidden(false));

  // ---- Shop -------------------------------------------------------
  let shopOpen = false;
  function setShop(open: boolean): void {
    if (open === shopOpen) return;
    shopOpen = open;
    shop.hidden = !open;
    tip.hidden = true;
    countBtn.classList.toggle("open", open);
    if (open) {
      renderShop();
      setTimeout(() => document.addEventListener("pointerdown", outsideClose), 0);
    } else {
      document.removeEventListener("pointerdown", outsideClose);
    }
    updateDeal();
  }
  function outsideClose(e: PointerEvent): void {
    const t = e.target as Node;
    if (!shop.contains(t) && !countBtn.contains(t)) setShop(false);
  }
  countBtn.addEventListener("click", () => setShop(!shopOpen));

  interface Row {
    u: Upgrade;
    el: HTMLButtonElement;
    cost: HTMLElement;
    tag: HTMLElement;
  }
  const rows: Row[] = [];

  function tagFor(u: Upgrade, n: number): string {
    if (u.stepNames) return n ? `${u.stepNames[n - 1]} · ${n}/${u.max}` : `neu · 0/${u.max}`;
    return n ? `Stufe ${n}/${u.max}` : `neu · 0/${u.max}`;
  }
  function effectLine(u: Upgrade, n: number): string {
    if (n >= u.max) return "Maximalstufe erreicht.";
    const p: string[] = [];
    if (u.steps) p.push(`nächste Stufe: ${u.stepNames?.[n]} · ${fmtRate(u.steps[n])} Klicks/s`);
    if (u.click) p.push(`+${fmt(u.click)} pro Klick`);
    if (u.cps) p.push(`+${fmtRate(u.cps)} / Sek.`);
    if (u.auto) p.push(`+${u.auto} Auto-Hand${u.auto > 1 ? "e" : ""}`);
    if (u.crit) p.push(`+${Math.round(u.crit * 100)} % Krit-Chance`);
    if (u.critX) p.push(`Krit-Faktor ×${critMult(s)} → ×${critMult(s) + u.critX}`);
    if (u.clickMult) p.push(`Klickwert ×${String(u.clickMult).replace(".", ",")}`);
    if (u.autoMult) p.push(`Auto-Klicker ×${String(u.autoMult).replace(".", ",")}`);
    if (u.mult) p.push(`Gesamt ×${String(u.mult).replace(".", ",")}`);
    return p.join(" · ");
  }
  function showTip(u: Upgrade, anchor: HTMLElement): void {
    const n = owned(s, u.id);
    const c = cost(u, n, baseProd(s));
    const parts: HTMLElement[] = [
      h("div", { class: "slime-tip-name", textContent: u.name }),
      h("div", { class: "slime-tip-body", textContent: u.long ?? u.desc }),
    ];
    const eff = effectLine(u, n);
    if (eff) parts.push(h("div", { class: "slime-tip-eff", textContent: eff }));
    if (Number.isFinite(c)) {
      const ps = perSec(s);
      const wait = ps > 0 ? Math.max(0, Math.round((c - s.goo) / ps)) : -1;
      parts.push(
        h("div", {
          class: "slime-tip-cost",
          textContent: wait >= 0 ? `Kosten ${fmt(c)} · noch ~${wait}s` : `Kosten ${fmt(c)}`,
        }),
      );
    }
    tip.textContent = "";
    tip.append(...parts);
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.top + r.height / 2 - tr.height / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
    let left = r.left - tr.width - 10;
    if (left < 8) left = r.right + 10;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  function renderShop(): void {
    shopList.textContent = "";
    rows.length = 0;
    for (const u of UPGRADES) {
      const costEl = h("span", { class: "slime-up-cost" });
      const tag = h("span", { class: "slime-up-tag" });
      const glyph =
        u.id === "crown"
          ? crownGlyph()
          : u.steps || u.auto || u.autoMult
            ? HAND
            : u.crit || u.critX
              ? boltGlyph()
              : u.mult || u.clickMult
                ? multGlyph()
                : slimeGlyph();
      const el = h("button", {
        class: `slime-up slime-up-b${u.band % 7}`,
        type: "button",
        onclick: () => buy(u),
      }, [
        h("span", { class: "slime-up-ico", html: glyph }),
        h("div", { class: "grow" }, [
          h("div", { class: "slime-up-name" }, [h("span", { textContent: u.name }), tag]),
          h("div", { class: "slime-up-desc", textContent: u.desc }),
        ]),
        costEl,
      ]) as HTMLButtonElement;
      el.addEventListener("pointerenter", () => showTip(u, el));
      el.addEventListener("pointerleave", () => {
        tip.hidden = true;
      });
      rows.push({ u, el, cost: costEl, tag });
      shopList.append(el);
    }
    refreshShop();
  }
  // Reihenfolge ist FEST (Band-Reihenfolge, wie in UPGRADES deklariert) – es
  // wird nie umsortiert. Sonst springen Zeilen beim Kauf/Tick weg, Klicks
  // gehen daneben und maximierte Upgrades „verschwinden" nach hinten.
  function refreshShop(): void {
    const prod = baseProd(s);
    for (const r of rows) {
      const n = owned(s, r.u.id);
      const c = cost(r.u, n, prod);
      const maxed = n >= r.u.max;
      r.el.disabled = maxed || s.goo < c;
      r.el.classList.toggle("maxed", maxed);
      r.el.classList.toggle("afford", !maxed && s.goo >= c);
      r.cost.textContent = maxed ? "MAX" : fmt(c);
      r.tag.textContent = tagFor(r.u, n);
    }
    shopRate.textContent = perSec(s) > 0 ? `+${fmtRate(perSec(s))}/s` : "";
  }
  function buy(u: Upgrade): void {
    const n = owned(s, u.id);
    const c = cost(u, n, baseProd(s));
    if (n >= u.max || s.goo < c) return;
    s.goo -= c;
    s.up[u.id] = n + 1;
    persist(s);
    tip.hidden = true;
    render();
    applyLook();
    refreshShop();
  }

  function slimeGlyph(): string {
    return (
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="3" y="4" width="10" height="9" rx="2" fill="currentColor"/>' +
      '<rect x="6" y="7" width="1.6" height="1.6" fill="#123"/>' +
      '<rect x="9" y="7" width="1.6" height="1.6" fill="#123"/></svg>'
    );
  }
  function multGlyph(): string {
    return (
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M5 5l6 6M11 5l-6 6"/></svg>'
    );
  }
  function boltGlyph(): string {
    return (
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
      '<path d="M9 1 3 9h4l-1 6 7-9H9z"/></svg>'
    );
  }
  function crownGlyph(): string {
    // im Shop: Material der aktuell gekauften Stufe (mind. Kupfer)
    return crownSvg(Math.max(1, owned(s, "crown")));
  }

  // ---- Optik an den Fortschritt anpassen ------------------------
  function tierNow(): number {
    let t = 0;
    for (const b of BANDS) if (b.ups.some((u) => owned(s, u.id) > 0)) t++;
    return Math.min(t, TIER_RGB.length - 1);
  }
  /** Farbe von Schleim + Glas – folgt der Band-Stufe oder dem aktiven Event. */
  function paint(): void {
    const [r, g, b] = activeEvent ? activeEvent.rgb : TIER_RGB[tierNow()];
    widget.style.setProperty("--sr", String(r));
    widget.style.setProperty("--sg", String(g));
    widget.style.setProperty("--sb", String(b));
    widget.classList.toggle("slime-rainbow", !activeEvent && tierNow() >= TIER_RGB.length - 1);
    widget.classList.toggle("slime-evt", !!activeEvent);
    widget.classList.toggle("slime-evt-bad", !!activeEvent && !activeEvent.good);
  }

  let lastLook = "";
  function applyLook(): void {
    paint();

    const total = Object.values(s.up).reduce((a, b) => a + Math.max(0, b), 0);
    const scale = 1 + Math.min(0.22, total * 0.005);
    const miniN = Math.min(MINI_SPOTS.length, owned(s, "mini"));
    const portalN = Math.min(PORTAL_SPOTS.length, owned(s, "portal"));
    const towerN = Math.min(TOWER_SPOTS.length, owned(s, "tower"));
    const crystalN = Math.min(CRYSTAL_SPOTS.length, owned(s, "crystal"));
    const crownN = Math.min(4, owned(s, "crown"));
    const handN = Math.min(
      8,
      HAND_IDS.reduce((t, id) => t + owned(s, id), 0),
    );

    const key = `${tierNow()}|${scale.toFixed(2)}|${miniN}|${portalN}|${towerN}|${crystalN}|${crownN}|${handN}`;
    if (key === lastLook) return;
    lastLook = key;

    widget.style.setProperty("--slime-scale", scale.toFixed(3));

    // Krone sitzt IN der Haupt-Würfel-Ebene → macht jede Squash-/Idle-Animation mit.
    slime.querySelector(".slime-crown")?.remove();
    if (crownN > 0) {
      const host = slime.querySelector(".slime-cube") ?? slime;
      host.append(h("div", { class: "slime-crown", html: crownSvg(crownN) }));
    }

    extras.textContent = "";
    for (let i = 0; i < portalN; i++) {
      const p = h("div", { class: "slime-portal" });
      p.style.left = `${PORTAL_SPOTS[i][0]}%`;
      p.style.top = `${PORTAL_SPOTS[i][1]}%`;
      p.style.setProperty("--d", `${(i * 0.7).toFixed(2)}s`);
      extras.append(p);
    }
    for (let i = 0; i < crystalN; i++) {
      const c = h("div", { class: "slime-crystal" });
      c.style.left = `${CRYSTAL_SPOTS[i][0]}%`;
      c.style.top = `${CRYSTAL_SPOTS[i][1]}%`;
      c.style.setProperty("--d", `${(i * 0.43).toFixed(2)}s`);
      extras.append(c);
    }
    for (let i = 0; i < towerN; i++) {
      const t = h("div", { class: "slime-tower" }, [slimeBody(), slimeBody(), slimeBody()]);
      t.style.left = `${TOWER_SPOTS[i][0]}%`;
      t.style.top = `${TOWER_SPOTS[i][1]}%`;
      t.style.setProperty("--d", `${(i * 0.29).toFixed(2)}s`);
      extras.append(t);
    }
    for (let i = 0; i < miniN; i++) {
      const m = h("div", { class: "slime-mini" }, [slimeBody()]);
      m.style.left = `${MINI_SPOTS[i][0]}%`;
      m.style.top = `${MINI_SPOTS[i][1]}%`;
      m.style.setProperty("--d", `${(i * 0.37).toFixed(2)}s`);
      m.style.setProperty("--sc", (0.8 + ((i * 41) % 34) / 100).toFixed(2));
      extras.append(m);
    }

    cursors.textContent = "";
    cursors.classList.toggle("on", handN > 0);
    if (handN > 0) {
      cursors.style.setProperty("--spin", `${Math.max(2.2, 6.5 - handN * 0.5).toFixed(1)}s`);
      for (let i = 0; i < handN; i++) {
        const c = h("div", { class: "slime-cursor", html: HAND });
        c.style.setProperty("--a", `${Math.round((360 / handN) * i)}deg`);
        c.style.setProperty("--pd", `${((i / handN) * 0.9).toFixed(2)}s`);
        cursors.append(c);
      }
    }
  }

  // ---- Events ---------------------------------------------------
  let evTimer = 0;
  let evEndAt = 0;

  function renderParticles(type: Particle): void {
    particles.textContent = "";
    particles.classList.toggle("on", type !== "none");
    const n = PCOUNT[type];
    for (let i = 0; i < n; i++) {
      const p = h("div", { class: `slime-particle p-${type}` });
      p.style.setProperty("--x", `${Math.round(Math.random() * 100)}%`);
      p.style.setProperty("--y", `${Math.round(Math.random() * 100)}%`);
      const sz = type === "spark" ? 2 + Math.random() * 2 : 3 + Math.random() * 4;
      p.style.setProperty("--sz", `${sz.toFixed(1)}px`);
      p.style.setProperty("--dur", `${(2.2 + Math.random() * 3.6).toFixed(2)}s`);
      p.style.setProperty("--del", `${(Math.random() * 4.5).toFixed(2)}s`);
      p.style.setProperty("--drift", `${((Math.random() * 2 - 1) * 30).toFixed(0)}px`);
      p.style.setProperty("--o", (0.5 + Math.random() * 0.5).toFixed(2));
      particles.append(p);
    }
  }
  function renderEventBanner(): void {
    if (!activeEvent) {
      evBanner.hidden = true;
      return;
    }
    evEmoji.textContent = activeEvent.emoji;
    evName.textContent = activeEvent.name;
    evBanner.classList.toggle("good", activeEvent.good);
    evBanner.classList.toggle("bad", !activeEvent.good);
    evBanner.hidden = false;
    evBanner.style.animation = "none";
    void evBanner.offsetWidth;
    evBanner.style.animation = "";
    const ms = Math.max(0, evEndAt - Date.now());
    evBarFill.style.transition = "none";
    evBarFill.style.width = "100%";
    void evBarFill.offsetWidth;
    evBarFill.style.transition = `width ${ms}ms linear`;
    evBarFill.style.width = "0%";
  }
  function setEvent(e: SlimeEvent | null): void {
    activeEvent = e;
    ev.click = e?.mods.click ?? 1;
    ev.auto = e?.mods.auto ?? 1;
    ev.cps = e?.mods.cps ?? 1;
    ev.crit = e?.mods.crit ?? 1;
    ev.all = e?.mods.all ?? 1;
    widget.classList.toggle("slime-noauto", ev.auto === 0);
    paint();
    renderEventBanner();
    renderParticles(e ? e.particle : "none");
    render();
    if (shopOpen) refreshShop();
  }
  function scheduleEvent(first?: number): void {
    window.clearTimeout(evTimer);
    evTimer = window.setTimeout(startRandomEvent, first ?? 95_000 + Math.random() * 80_000);
  }
  function startRandomEvent(): void {
    const good = Math.random() < 0.56;
    let pool = EVENTS.filter((e) => e.good === good && e.id !== activeEvent?.id);
    if (!pool.length) pool = EVENTS.filter((e) => e.id !== activeEvent?.id);
    const e = pool[Math.floor(Math.random() * pool.length)];
    const dur = 26_000 + Math.random() * 26_000;
    evEndAt = Date.now() + dur;
    setEvent(e);
    window.clearTimeout(evTimer);
    evTimer = window.setTimeout(() => {
      setEvent(null);
      scheduleEvent();
    }, dur);
  }

  // ---- Klick-Feedback ------------------------------------------
  function squish(soft: boolean): void {
    const cls = soft ? "squish-soft" : "squish";
    slime.classList.remove(cls);
    void slime.offsetWidth;
    slime.classList.add(cls);
  }
  function bump(): void {
    countBtn.classList.remove("bump");
    void countBtn.offsetWidth;
    countBtn.classList.add("bump");
  }
  function pop(amount: number, x: number, y: number, kind = ""): void {
    const el = h("div", { class: `slime-pop${kind ? " " + kind : ""}` });
    if (kind === "crit") {
      el.append(
        h("span", { class: "slime-pop-crit-lbl", textContent: "KRIT!" }),
        h("span", { textContent: `+${fmt(amount)}` }),
      );
    } else {
      el.textContent = `+${fmt(amount)}`;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    slime.append(el);
    setTimeout(() => el.remove(), kind === "soft" ? 700 : 1100);
  }
  function splash(x: number, y: number): void {
    for (let i = 0; i < 6; i++) {
      const d = h("div", { class: "slime-drop" });
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      d.style.setProperty("--dx", `${(Math.random() * 2 - 1) * 40}px`);
      d.style.setProperty("--dy", `${(Math.random() * 2 - 1) * 30 - 8}px`);
      slime.append(d);
      setTimeout(() => d.remove(), 620);
    }
  }

  slime.addEventListener("click", (e) => {
    let g = perClick(s);
    const crit = Math.random() < critChance(s);
    if (crit) g *= critMult(s);
    s.goo += g;
    persist(s);
    render();
    if (shopOpen) refreshShop(); // sonst bleiben die Upgrades „nicht kaufbar"
    bump();
    squish(false);
    slime.classList.toggle("crit", crit);
    const r = slime.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (crit) {
      // Krit gut sichtbar: mittig über dem Schleim
      pop(g, slime.clientWidth / 2, slime.clientHeight * 0.28, "crit");
    } else {
      pop(g, x + (Math.random() * 14 - 7), y - 4, "");
    }
    splash(x, y);
  });

  // ---- Anzeige -------------------------------------------------
  function render(): void {
    num.textContent = fmt(s.goo);
    const ps = perSec(s);
    rate.hidden = ps <= 0;
    rate.textContent = ps > 0 ? `+${fmtRate(ps)}/s` : "";
    updateDeal();
  }
  function updateDeal(): void {
    const prod = baseProd(s);
    const deal =
      !shopOpen &&
      UPGRADES.some((u) => {
        const n = owned(s, u.id);
        return n < u.max && s.goo >= cost(u, n, prod);
      });
    countBtn.classList.toggle("deal", deal);
  }

  // ---- Schleifen ---------------------------------------------
  window.setInterval(() => {
    const inc = perSec(s) / 4;
    if (inc > 0) {
      s.goo += inc;
      render();
    }
    // Shop IMMER auffrischen solange offen – auch ohne Passiv-Einkommen,
    // damit „kaufbar/nicht kaufbar" nach reinen Klicks stimmt.
    if (shopOpen) refreshShop();
  }, 250);

  let acc = 0;
  window.setInterval(() => {
    const aps = autoPerSec(s);
    if (aps <= 0) return;
    acc += Math.min(aps, 6) * 0.22;
    while (acc >= 1) {
      acc -= 1;
      squish(true);
      pop(perClick(s), 22 + Math.random() * 40, 8 + Math.random() * 14, "soft");
    }
  }, 220);

  const flush = () => {
    s.ts = Date.now();
    persist(s);
  };
  window.setInterval(flush, 5000);
  window.addEventListener("beforeunload", flush);

  // ---- Konsole ----------------------------------------------
  commandHandler = (raw: string): string => {
    const parts = raw.trim().replace(/^\//, "").split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const arg = parts[1];
    switch (cmd) {
      case "":
        return "";
      case "help":
        return [
          "/reset            – Spiel komplett zurücksetzen",
          "/goo              – Kontostand & Rate",
          "/add <zahl>       – Schleim hinzufügen",
          "/max              – alle Upgrades auf Maximalstufe",
          "/event [id|off]   – Event starten/beenden (winter, goldrush, blackout …)",
          "/clear            – Konsole leeren",
        ].join("\n");
      case "reset":
        s.goo = 0;
        s.up = {};
        s.ts = Date.now();
        persist(s);
        setShop(false);
        lastLook = "";
        setEvent(null);
        scheduleEvent();
        render();
        applyLook();
        return "Schleim-Spiel komplett zurückgesetzt.";
      case "goo":
        return `Schleim: ${fmt(s.goo)}  ·  ${fmtRate(perSec(s))}/s  ·  ${fmt(perClick(s))}/Klick  ·  Krit ×${critMult(s)}`;
      case "add": {
        const n = Number((arg || "").replace(",", "."));
        if (!Number.isFinite(n)) return "Zahl fehlt – z. B. /add 10000";
        s.goo = Math.max(0, s.goo + n);
        persist(s);
        render();
        if (shopOpen) refreshShop();
        return `${n >= 0 ? "+" : ""}${fmt(n)}  →  ${fmt(s.goo)}`;
      }
      case "max":
        for (const u of UPGRADES) s.up[u.id] = u.max;
        persist(s);
        lastLook = "";
        render();
        applyLook();
        if (shopOpen) renderShop();
        return "Alle Upgrades auf Maximalstufe.";
      case "event": {
        if (arg === "off" || arg === "aus") {
          window.clearTimeout(evTimer);
          setEvent(null);
          scheduleEvent();
          return "Event beendet.";
        }
        const e = arg
          ? EVENTS.find((x) => x.id === arg.toLowerCase())
          : EVENTS[Math.floor(Math.random() * EVENTS.length)];
        if (!e) return `Unbekannt. Verfügbar: ${EVENTS.map((x) => x.id).join(", ")}`;
        window.clearTimeout(evTimer);
        evEndAt = Date.now() + 40_000;
        setEvent(e);
        evTimer = window.setTimeout(() => {
          setEvent(null);
          scheduleEvent();
        }, 40_000);
        return `${e.good ? "Gutes" : "Schlechtes"} Event: ${e.emoji} ${e.name}`;
      }
      default:
        return `Unbekannter Befehl: ${cmd}  –  /help`;
    }
  };

  render();
  applyLook();
  if (hidden) setHidden(true);
  scheduleEvent(45_000 + Math.random() * 45_000);
}
