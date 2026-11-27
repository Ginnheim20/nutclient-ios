// iPhone: Touch-Steuerung über dem laufenden Minecraft (Handy-Edition). Eigener Code.
// Das Spiel zeichnet in eine Fläche UNTER der Launcher-Webansicht (ios-native/nutgl/glfw.m); die Webansicht wird
// durchsichtig und zeigt nur noch diese Steuerung. Eingaben gehen über den Befehl ios_input an das eigene GLFW.
//
//  Im Spiel (Maus gefangen):  ziehen = umsehen · kurz tippen = benutzen/setzen · halten = abbauen/angreifen
//                             Joystick links = laufen (ganz außen = sprinten) · Knöpfe rechts
//  Im Menü (Maus frei):       tippen = klicken · ziehen = Maus bewegen · zwei Finger = scrollen
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { h } from "./ui";
import { isIOS } from "./mobile";
import { hasTauri } from "./launcher/api";

// nut_input-Arten (glfw.m)
const EV_CURSOR = 1, EV_DELTA = 2, EV_BUTTON = 3, EV_KEY = 4, EV_CHAR = 5, EV_SCROLL = 6;
// GLFW-Tasten
const K = { W: 87, A: 65, S: 83, D: 68, SPACE: 32, SHIFT: 340, CTRL: 341, E: 69, Q: 81, T: 84, ESC: 256, ENTER: 257, BACK: 259, F5: 294 };

const send = (kind: number, a = 0, b = 0, c = 0, d = 0) => { if (hasTauri) void invoke("ios_input", { kind, a, b, c, d }).catch(() => {}); };
const key = (code: number, down: boolean) => send(EV_KEY, 0, 0, code, down ? 1 : 0);
const tapKey = (code: number) => { key(code, true); setTimeout(() => key(code, false), 60); };
const button = (b: number, down: boolean) => send(EV_BUTTON, 0, 0, b, down ? 1 : 0);

let grabbed = false;
let root: HTMLElement | null = null;

export function initIosGame(): void {
  // Vorschau im Browser: ?ingame zeigt die Steuerung ohne Spiel
  if (new URLSearchParams(location.search).has("ingame")) { enterGame(); return; }
  if (!(isIOS && hasTauri)) return;
  void listen("ios://game", () => enterGame());
}

function enterGame(): void {
  if (root) return;
  document.documentElement.classList.add("ingame");
  root = buildOverlay();
  document.body.append(root);
  void poll();
}

// ---------------------------------------------------------------- Zustand abfragen (Maus gefangen? Island?)
type GameState = { running: boolean; window: boolean; grabbed: boolean; island: string | null };
async function poll(): Promise<void> {
  for (;;) {
    try {
      const s = hasTauri ? await invoke<GameState>("ios_game_state") : { running: true, window: true, grabbed: true, island: JSON.stringify({ title: "Vorschau", text: "Dynamic Island" }) };
      if (s.grabbed !== grabbed) {
        grabbed = s.grabbed;
        root?.classList.toggle("grabbed", grabbed);
        if (grabbed) releaseAll();
      }
      island(s.island);
    } catch {
      /* egal */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------- Dynamic Island (Inhalt kommt aus NUTclient)
let islandEl: HTMLElement | null = null;
function island(json: string | null): void {
  if (!islandEl) return;
  let data: { title?: string; text?: string; color?: string } | null = null;
  try { data = json ? JSON.parse(json) : null; } catch { data = null; }
  islandEl.classList.toggle("open", !!data && !!(data.title || data.text));
  if (!data) return;
  islandEl.style.setProperty("--isl", data.color || "var(--accent)");
  islandEl.querySelector(".isl-title")!.textContent = data.title || "";
  islandEl.querySelector(".isl-text")!.textContent = data.text || "";
}

// ---------------------------------------------------------------- Oberfläche
function buildOverlay(): HTMLElement {
  const look = h("div", { class: "ig-look" });
  const joy = joystick();
  const btn = (label: string, cls: string, down: () => void, up?: () => void) => {
    const b = h("button", { class: `ig-btn glass ${cls}`, type: "button", textContent: label });
    b.addEventListener("touchstart", (e) => { e.preventDefault(); e.stopPropagation(); b.classList.add("on"); down(); }, { passive: false });
    const end = (e: Event) => { e.preventDefault(); e.stopPropagation(); b.classList.remove("on"); up?.(); };
    b.addEventListener("touchend", end, { passive: false });
    b.addEventListener("touchcancel", end, { passive: false });
    return b;
  };
  let sneak = false;
  const sneakBtn = btn("⇩", "ig-sneak", () => { sneak = !sneak; key(K.SHIFT, sneak); sneakBtn.classList.toggle("lock", sneak); });
  const typing = h("input", { class: "ig-type", type: "text", autocapitalize: "off", autocomplete: "off" }) as HTMLInputElement;
  typing.addEventListener("input", () => {
    for (const ch of typing.value) send(EV_CHAR, 0, 0, ch.codePointAt(0)!);
    typing.value = "";
  });
  typing.addEventListener("keydown", (e) => {
    if (e.key === "Backspace") tapKey(K.BACK);
    if (e.key === "Enter") { tapKey(K.ENTER); typing.blur(); }
  });
  const kbd = btn("⌨", "ig-kbd", () => { typing.focus(); });
  islandEl = h("div", { class: "ig-island" }, [h("span", { class: "isl-dot" }), h("b", { class: "isl-title" }), h("span", { class: "isl-text" })]);

  const ov = h("div", { class: "ig-root", id: "ios-game" }, [
    look,
    islandEl,
    h("div", { class: "ig-top" }, [
      btn("❚❚", "ig-pause", () => tapKey(K.ESC)),
      btn("F5", "ig-view", () => tapKey(K.F5)),
      btn("Chat", "ig-chat", () => { tapKey(K.T); setTimeout(() => typing.focus(), 120); }),
      kbd,
    ]),
    joy,
    h("div", { class: "ig-right" }, [
      btn("‹", "ig-hot", () => send(EV_SCROLL, 0, 1)),
      btn("›", "ig-hot", () => send(EV_SCROLL, 0, -1)),
      btn("Q", "ig-drop", () => tapKey(K.Q)),
      btn("E", "ig-inv", () => tapKey(K.E)),
      sneakBtn,
      btn("⇧", "ig-jump", () => key(K.SPACE, true), () => key(K.SPACE, false)),
    ]),
    typing,
  ]);
  lookArea(look);
  return ov;
}

// ---------------------------------------------------------------- Umsehen / Tippen / Halten bzw. Maus im Menü
function lookArea(el: HTMLElement): void {
  const SENS = 2.2;               // Punkte → Mausbewegung
  let id: number | null = null, lx = 0, ly = 0, sx = 0, sy = 0, t0 = 0, moved = false;
  let hold: number | undefined, holding = false;
  let two: { y: number } | null = null;

  el.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && !grabbed) {
      two = { y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      return;
    }
    if (id !== null) return;
    const t = e.changedTouches[0];
    id = t.identifier; lx = sx = t.clientX; ly = sy = t.clientY; t0 = Date.now(); moved = false;
    if (grabbed) {
      // halten (ohne viel Bewegung) = abbauen
      hold = window.setTimeout(() => { if (!moved) { holding = true; button(0, true); } }, 300);
    } else {
      send(EV_CURSOR, t.clientX, t.clientY);
      button(0, true);
    }
  }, { passive: false });

  el.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (two && e.touches.length === 2) {
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dy = (y - two.y) / 24;
      if (Math.abs(dy) >= 1) { send(EV_SCROLL, 0, Math.round(dy)); two.y = y; }
      return;
    }
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== id) continue;
      const dx = t.clientX - lx, dy = t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) moved = true;
      if (grabbed) send(EV_DELTA, dx * SENS, dy * SENS);
      else send(EV_CURSOR, t.clientX, t.clientY);
    }
  }, { passive: false });

  const end = (e: TouchEvent) => {
    e.preventDefault();
    if (two && e.touches.length < 2) { two = null; return; }
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== id) continue;
      id = null;
      clearTimeout(hold);
      if (grabbed) {
        if (holding) { holding = false; button(0, false); }
        else if (!moved && Date.now() - t0 < 300) { button(1, true); setTimeout(() => button(1, false), 50); }   // tippen = benutzen
      } else {
        button(0, false);
      }
    }
  };
  el.addEventListener("touchend", end, { passive: false });
  el.addEventListener("touchcancel", end, { passive: false });
}

// ---------------------------------------------------------------- Joystick (W/A/S/D, außen = sprinten)
const held = new Set<number>();
function setKeys(want: Set<number>): void {
  for (const k of [K.W, K.A, K.S, K.D, K.CTRL]) {
    if (want.has(k) && !held.has(k)) { key(k, true); held.add(k); }
    if (!want.has(k) && held.has(k)) { key(k, false); held.delete(k); }
  }
}
function releaseAll(): void { setKeys(new Set()); }

function joystick(): HTMLElement {
  const knob = h("div", { class: "ig-knob glass" });
  const pad = h("div", { class: "ig-joy glass" }, [knob]);
  let id: number | null = null;
  const R = 56;
  const move = (t: Touch) => {
    const r = pad.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const want = new Set<number>();
    const nx = dx / R, ny = dy / R;
    if (ny < -0.35) want.add(K.W);
    if (ny > 0.35) want.add(K.S);
    if (nx < -0.35) want.add(K.A);
    if (nx > 0.35) want.add(K.D);
    if (ny < -0.92) want.add(K.CTRL);
    setKeys(want);
  };
  pad.addEventListener("touchstart", (e) => { e.preventDefault(); e.stopPropagation(); const t = e.changedTouches[0]; id = t.identifier; move(t); }, { passive: false });
  pad.addEventListener("touchmove", (e) => {
    e.preventDefault(); e.stopPropagation();
    for (const t of Array.from(e.changedTouches)) if (t.identifier === id) move(t);
  }, { passive: false });
  const end = (e: TouchEvent) => {
    e.preventDefault(); e.stopPropagation();
    for (const t of Array.from(e.changedTouches)) if (t.identifier === id) { id = null; knob.style.transform = ""; releaseAll(); }
  };
  pad.addEventListener("touchend", end, { passive: false });
  pad.addEventListener("touchcancel", end, { passive: false });
  return pad;
}
