// Jeff-Tutorial: beim allerersten Start hüpft der Schleim „Jeff" über den
// Bildschirm und erklärt in ein paar Sprechblasen (Liquid-Glass, schleimgrün
// umrandet) das Wichtigste. Überspringbar; in den Einstellungen erneut abrufbar.
import { h } from "./ui";
import { slimeBody, SLIME_NAME } from "./slime";

const KEY = "mcl.tutorial.v1";

export function tutorialDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return true;
  }
}
function markDone(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    /* egal */
  }
}

interface Step {
  /** CSS-Selektor des Ziels – null = Bildschirmmitte. */
  sel: string | null;
  title: string;
  text: string;
}
const STEPS: Step[] = [
  {
    sel: null,
    title: `Hi, ich bin ${SLIME_NAME}! 👋`,
    text: "Willkommen im NUTclient Launcher. Ich zeig dir in 20 Sekunden das Wichtigste – oder klick unten auf Überspringen.",
  },
  {
    sel: '.rail-btn[data-panel="instances"]',
    title: "Instanzen & Import",
    text: "Unter Select legst du Spiel-Instanzen an, wählst Version und Mod-Loader – und importierst Profile aus anderen Launchern.",
  },
  {
    sel: '.rail-btn[data-panel="content"]',
    title: "Mods",
    text: "Hier suchst du Mods direkt von Modrinth und fügst sie einer Instanz hinzu. Im großen Fenster gibt's Bilder, Videos und alle Infos.",
  },
  {
    sel: '.rail-btn[data-panel="settings"]',
    title: "Einstellungen",
    text: "Arbeitsspeicher hoch/runter, Glasfarbe & -stärke, Hintergrundbild oder -video – alles hier drin. Diese Tour kannst du hier auch neu starten.",
  },
  {
    sel: "#btn-play",
    title: "Losspielen",
    text: "Der große Knopf startet deine zuletzt gespielte Instanz. Der kleine Pfeil daneben öffnet die Instanz-Liste.",
  },
  {
    sel: "#slime-widget",
    title: "Und ich?",
    text: "Ich häng hier unten rechts rum. Klick mich an – dann kannst du mein kleines Schleim-Spiel mit Upgrades und Events spielen. Viel Spaß!",
  },
];

let active = false;

export function startTutorial(): void {
  if (active) return;
  active = true;

  const backdrop = h("div", { class: "jeff-backdrop" });
  const ring = h("div", { class: "jeff-ring", hidden: true });
  const jeff = h("div", { class: "jeff-avatar" }, [slimeBody()]);

  const bTitle = h("div", { class: "jeff-bubble-title" });
  const bText = h("div", { class: "jeff-bubble-text" });
  const dots = h("div", { class: "jeff-dots" });
  const backBtn = h("button", { class: "btn ghost sm", type: "button", textContent: "Zurück" }) as HTMLButtonElement;
  const nextBtn = h("button", { class: "btn sm", type: "button", textContent: "Weiter" });
  const skipBtn = h("button", { class: "jeff-skip", type: "button", textContent: "Überspringen" });
  const bubble = h("div", { class: "jeff-bubble" }, [
    skipBtn,
    bTitle,
    bText,
    h("div", { class: "jeff-bubble-foot" }, [
      dots,
      h("div", { class: "row-end" }, [backBtn, nextBtn]),
    ]),
  ]);

  const host = h("div", { class: "jeff-tour", id: "jeff-tour" }, [backdrop, ring, jeff, bubble]);
  document.body.append(host);

  let i = 0;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  function place(): void {
    const st = STEPS[i];
    dots.textContent = "";
    STEPS.forEach((_, k) => dots.append(h("i", { class: k === i ? "on" : "" })));
    bTitle.textContent = st.title;
    bText.textContent = st.text;
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === STEPS.length - 1 ? "Fertig" : "Weiter";

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const el = st.sel ? document.querySelector<HTMLElement>(st.sel) : null;
    let tx = vw / 2;
    let ty = vh / 2;

    if (el) {
      const r = el.getBoundingClientRect();
      tx = r.left + r.width / 2;
      ty = r.top + r.height / 2;
      ring.hidden = false;
      ring.style.left = `${r.left - 6}px`;
      ring.style.top = `${r.top - 6}px`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;
    } else {
      ring.hidden = true;
    }

    // Jeff neben das Ziel setzen (zur freien Seite hin)
    const toLeft = tx > vw / 2;
    const jx = clamp(tx + (toLeft ? -80 : 80), 54, vw - 54);
    const jy = clamp(ty, 54, vh - 54);
    jeff.style.left = `${jx}px`;
    jeff.style.top = `${jy}px`;
    jeff.classList.remove("hop");
    void jeff.offsetWidth;
    jeff.classList.add("hop");

    // Sprechblase neben Jeff, im Viewport gehalten
    bubble.style.left = "-9999px";
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const bx = clamp(toLeft ? jx - bw - 46 : jx + 46, 12, vw - bw - 12);
    const by = clamp(jy - bh / 2, 12, vh - bh - 12);
    bubble.style.left = `${bx}px`;
    bubble.style.top = `${by}px`;
  }

  function end(): void {
    markDone();
    window.removeEventListener("resize", place);
    host.remove();
    active = false;
  }

  backBtn.onclick = () => {
    if (i > 0) {
      i--;
      place();
    }
  };
  nextBtn.onclick = () => {
    if (i < STEPS.length - 1) {
      i++;
      place();
    } else {
      end();
    }
  };
  skipBtn.onclick = end;
  window.addEventListener("resize", place);

  requestAnimationFrame(place);
}

export function initTutorial(): void {
  if (!tutorialDone()) window.setTimeout(startTutorial, 900);
}
