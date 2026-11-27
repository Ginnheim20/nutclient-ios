// Nachrichten-Leiste am rechten Bildschirmrand (unten): zeigt Absender, optional den
// Server und den Text. Verschwindet nach 3 s – außer die Maus ist darüber; dann
// bleibt sie, bis die Maus die Leiste verlässt.
import { h } from "./ui";

export interface MessageBarData {
  author: string;
  text: string;
  /** Servername bzw. Webseite – nur bei Nachrichten aus einem Server / einer Seite */
  server?: string | null;
  /** Akzentfarbe (`#rrggbb`) – färbt Rahmen, Absender und Glanz; sonst Akzentfarbe des Launchers */
  color?: string | null;
}

const SHOW_MS = 3000;

let bar: HTMLElement | null = null;
let authorEl: HTMLElement;
let serverEl: HTMLElement;
let textEl: HTMLElement;
let hideTimer = 0;
let hovered = false;

function ensureBar(): HTMLElement {
  if (bar) return bar;
  authorEl = h("span", { class: "msg-bar-author" });
  serverEl = h("span", { class: "msg-bar-server" });
  textEl = h("div", { class: "msg-bar-text" });
  bar = h("div", { class: "msg-bar", role: "status", "aria-live": "polite" }, [
    h("div", { class: "msg-bar-head" }, [authorEl, serverEl]),
    textEl,
  ]);
  bar.addEventListener("mouseenter", () => {
    hovered = true;
    window.clearTimeout(hideTimer);
  });
  bar.addEventListener("mouseleave", () => {
    hovered = false;
    scheduleHide();
  });
  document.body.append(bar);
  return bar;
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, SHOW_MS);
}

function hide(): void {
  bar?.classList.remove("show");
  document.body.classList.remove("msg-open");
}

export function showMessageBar(d: MessageBarData): void {
  const el = ensureBar();
  authorEl.textContent = d.author;
  serverEl.textContent = d.server ?? "";
  serverEl.hidden = !d.server;
  textEl.textContent = d.text;
  if (d.color) el.style.setProperty("--msg-color", d.color);
  else el.style.removeProperty("--msg-color");
  // Neu auslösen, damit die Einblend-Animation auch bei einer zweiten Nachricht läuft
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  document.body.classList.add("msg-open"); // Schleim weicht der Leiste aus
  if (!hovered) scheduleHide();
}
