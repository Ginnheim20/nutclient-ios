import { h, clear } from "../ui";
import { store, save } from "../state";

// Neuigkeiten. Vorerst statische Einträge; später aus einem Feed
// (z. B. Mojang-Blog / eigener Launcher-Kanal).

interface News {
  id: string;
  title: string;
  body: string;
  date: string;
}

const FEED: News[] = [
  {
    id: "welcome",
    title: "Willkommen im NUTclient Launcher",
    body: "Profile anlegen, Inhalte von Modrinth hinzufügen, mit Freunden schreiben – alles in dieser Seitenleiste.",
    date: "2026-08-30",
  },
  {
    id: "modrinth",
    title: "Modrinth-Suche aktiv",
    body: "Über das Plus-Symbol lassen sich Mods, Resource Packs und Shader direkt suchen und einem Profil zuordnen.",
    date: "2026-08-30",
  },
];

export function unreadCount(): number {
  return FEED.filter((n) => !store.readNews.includes(n.id)).length;
}

export function renderNotifications(mount: HTMLElement): void {
  clear(mount);
  const list = h("div", { class: "list" });
  for (const n of FEED) {
    const unread = !store.readNews.includes(n.id);
    list.append(
      h("div", { class: "card", style: "flex-direction:column;align-items:stretch;gap:4px" }, [
        h("div", { class: "row between" }, [
          h("div", { class: "title", textContent: n.title }),
          h("div", { class: "sub", textContent: n.date }),
        ]),
        h("div", { class: "sub", style: "white-space:normal", textContent: n.body }),
        unread ? h("div", { class: "hint", textContent: "• neu" }) : h("span"),
      ]),
    );
  }
  mount.append(list);

  store.readNews = FEED.map((n) => n.id);
  save();
  document.getElementById("notif-dot")?.remove();
}
