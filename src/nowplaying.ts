// „Dynamic Island" in der oberen Leiste (mittig über dem Skin).
// Drei Zustände, die weich ineinander morphen:
//   • Uhr    – wenn nichts läuft (immer sichtbar, auch bei sichtbarer Taskleiste)
//   • Medien – laufende System-Wiedergabe (Spotify / YouTube / Netflix …)
//   • Call   – Discord-Voice-Call
import { h } from "./ui";
import { icons } from "./icons";
import { store, onChange } from "./state";
import {
  mediaNowPlaying,
  mediaControl,
  discordCall,
  focusDiscord,
  type MediaNowPlaying,
} from "./media";
import { hasTauri } from "./launcher/api";

type State = "clock" | "media" | "discord";

export function initNowPlaying(): void {
  const host = document.getElementById("media-widget");
  if (!host) return;
  host.hidden = false;

  const island = h("div", { class: "mw-island" });
  host.append(island);

  // ---- Uhr-Zustand -------------------------------------------------
  const clockTime = h("div", { class: "mw-clock-time", textContent: "--:--" });
  const clockBox = h("div", { class: "mw-inner mw-clock on", "data-tauri-drag-region": "" }, [
    h("span", { class: "mw-clock-ico", html: icons.clock }),
    clockTime,
  ]);

  // ---- Medien-Zustand -------------------------------------------
  const thumb = h("div", { class: "mw-thumb" });
  const title = h("div", { class: "mw-title" });
  const artist = h("div", { class: "mw-artist" });
  const fill = h("div", { class: "mw-fill" });
  const bar = h("div", { class: "mw-bar" }, [fill]);

  const ctrl = (icon: keyof typeof icons, label: string, cls: string, action: () => void) =>
    h("button", {
      class: `mw-btn ${cls}`,
      "aria-label": label,
      title: label,
      html: icons[icon],
      onclick: action,
    });

  const prevBtn = ctrl("skipBack", "Vorheriges", "", () => void mediaControl("prev").then(refreshSoon));
  const playBtn = ctrl("play", "Abspielen", "mw-play", () =>
    void mediaControl("playpause").then(refreshSoon),
  );
  const nextBtn = ctrl("skipFwd", "Nächstes", "", () => void mediaControl("next").then(refreshSoon));

  const mediaBox = h("div", { class: "mw-inner mw-media" }, [
    thumb,
    h("div", { class: "mw-meta" }, [title, artist, bar]),
    h("div", { class: "mw-ctrls" }, [prevBtn, playBtn, nextBtn]),
  ]);

  // ---- Call-Zustand ------------------------------------------
  const dcTitle = h("div", { class: "mw-title", textContent: "Im Discord-Call" });
  const dcSub = h("div", { class: "mw-artist", textContent: "Öffnen" });
  const discordBox = h("div", {
    class: "mw-inner mw-discord",
    title: "Discord öffnen",
    onclick: () => void focusDiscord(),
  }, [
    h("span", { class: "mw-dc-ico", html: icons.discord }),
    h("div", { class: "mw-meta" }, [dcTitle, dcSub]),
    h("span", { class: "mw-dc-wave" }, [h("i"), h("i"), h("i")]),
  ]);

  island.append(clockBox, mediaBox, discordBox);
  const boxFor = (s: State): HTMLElement =>
    s === "media" ? mediaBox : s === "discord" ? discordBox : clockBox;

  // ---- Morph ----------------------------------------------
  let current: State = "clock";
  let morphRaf = 0;
  let morphT = 0;
  function measure(): void {
    const a = boxFor(current);
    island.style.width = `${a.offsetWidth}px`;
    island.style.height = `${a.offsetHeight}px`;
  }
  function morph(): void {
    cancelAnimationFrame(morphRaf);
    window.clearTimeout(morphT);
    morphRaf = requestAnimationFrame(measure);
    morphT = window.setTimeout(measure, 60); // Fallback, falls rAF gedrosselt ist
  }
  function setState(next: State): void {
    current = next;
    for (const s of ["clock", "media", "discord"] as State[]) {
      boxFor(s).classList.toggle("on", s === next);
    }
    island.classList.toggle("is-media", next === "media");
    island.classList.toggle("is-discord", next === "discord");
    morph();
  }

  // ---- Uhr-Ticker (immer aktiv) --------------------------
  async function tickClock(): Promise<void> {
    let hm = "";
    if (hasTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        hm = await invoke<string>("local_time");
      } catch {
        /* Fallback unten */
      }
    }
    if (!hm) {
      const d = new Date();
      hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    if (hm !== clockTime.textContent) {
      clockTime.textContent = hm;
      if (current === "clock") morph();
    }
  }
  void tickClock();
  window.setInterval(() => void tickClock(), 15_000);

  // ---- Medien / Call (nur im Tauri-Fenster) ---------------
  const enabled = () => store.settings.mediaWidget !== false;
  let lastMediaKey = "";
  let dcStreak = 0;
  let pollTimer = 0;

  function updateMedia(np: MediaNowPlaying): boolean {
    const has = np.active && (np.title !== "" || np.artist !== "");
    if (!has) {
      lastMediaKey = "";
      return false;
    }
    playBtn.innerHTML = np.playing ? icons.pause : icons.play;
    playBtn.setAttribute("aria-label", np.playing ? "Pause" : "Abspielen");
    prevBtn.toggleAttribute("disabled", !np.canPrev);
    nextBtn.toggleAttribute("disabled", !np.canNext);

    const key = `${np.title}|${np.artist}|${np.thumb ?? ""}`;
    if (key !== lastMediaKey) {
      lastMediaKey = key;
      title.textContent = np.title || np.artist || "Unbekannt";
      artist.textContent = np.artist;
      artist.hidden = !np.artist;
      if (np.thumb) {
        thumb.style.backgroundImage = `url("${np.thumb.replace(/"/g, '\\"')}")`;
        thumb.classList.remove("mw-thumb-empty");
        thumb.innerHTML = "";
      } else {
        thumb.style.backgroundImage = "";
        thumb.classList.add("mw-thumb-empty");
        thumb.innerHTML = icons.music;
      }
      if (current === "media") morph();
    }
    const hasTl = np.duration > 0;
    bar.hidden = !hasTl;
    if (hasTl) fill.style.width = `${Math.min(100, (np.position / np.duration) * 100)}%`;
    return true;
  }

  async function refresh(): Promise<void> {
    if (!hasTauri || !enabled()) {
      setState("clock");
      return;
    }
    const [np, dc] = await Promise.all([mediaNowPlaying(), discordCall()]);
    dcStreak = dc.inCall ? Math.min(dcStreak + 1, 4) : Math.max(dcStreak - 2, 0);
    const inCall = dcStreak >= 2;
    const hasMedia = updateMedia(np);

    if (inCall) {
      dcSub.textContent = dc.context || "Öffnen";
      setState("discord");
      if (current === "discord") morph();
    } else {
      setState(hasMedia ? "media" : "clock");
    }
  }
  function refreshSoon(): void {
    window.setTimeout(() => void refresh(), 250);
    window.setTimeout(() => void refresh(), 900);
  }
  function loop(): void {
    window.clearInterval(pollTimer);
    if (!hasTauri) return;
    pollTimer = window.setInterval(() => void refresh(), document.hasFocus() ? 900 : 4000);
  }

  window.addEventListener("resize", morph);
  window.addEventListener("focus", loop);
  window.addEventListener("blur", loop);
  onChange(() => void refresh());

  setState("clock");
  void refresh();
  loop();
}
