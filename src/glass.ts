// Licht für die Glasflächen.
// Die Glanzkanten sind fest und wandern nicht mit dem Zeiger (siehe styles.css
// „Liquid Glass"). Hier werden nur die Licht-Variablen auf Ruhewerte gesetzt.

export function initGlass(): void {
  const s = document.documentElement.style;
  s.setProperty("--lx", "0");
  s.setProperty("--ly", "0");
  s.setProperty("--glow-x", "50%");
  s.setProperty("--glow-y", "36%");
  // Glanzkanten sind fest (nicht zeigergesteuert) – siehe styles.css „Liquid Glass".
}
