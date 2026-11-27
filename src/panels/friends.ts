import { h, clear, toast, searchBar } from "../ui";
import { store, save, uid, type Friend } from "../state";

// Freunde + Chat. Ohne Backend-Server ist der Chat lokal (nur Vorschau der UI).

let openFriendId: string | null = null;

export function renderFriends(mount: HTMLElement): void {
  clear(mount);
  const friend = store.friends.find((f) => f.id === openFriendId);
  if (friend) mount.append(chatView(friend, mount));
  else mount.append(listView(mount));
}

function listView(mount: HTMLElement): HTMLElement {
  const wrap = h("div", {});
  // Glas-Suchleiste: filtert beim Tippen die Freundesliste, Enter/„Hinzufügen“ fügt den Spieler hinzu
  const nameInput = h("input", { placeholder: "Spieler suchen oder hinzufügen…" }) as HTMLInputElement;
  const sb = searchBar(nameInput);
  const add = () => {
    const n = nameInput.value.trim();
    if (!n) return;
    if (store.friends.some((f) => f.name.toLowerCase() === n.toLowerCase()))
      return toast("Schon in der Liste");
    const f: Friend = { id: uid(), name: n, messages: [] };
    store.friends.push(f);
    save();
    nameInput.value = "";
    renderFriends(mount);
    toast(`Freundschaftsanfrage an ${n} gesendet`);
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });

  wrap.append(
    h("div", { class: "row", style: "gap:8px;margin-bottom:14px" }, [
      sb.el,
      h("button", { class: "btn", textContent: "Hinzufügen", onclick: add }),
    ]),
  );

  const list = h("div", { class: "list" });
  if (store.friends.length === 0) {
    list.append(h("div", { class: "empty", textContent: "Noch keine Freunde hinzugefügt." }));
  }
  for (const f of store.friends) {
    list.append(
      h("div", { class: "card selectable", "data-name": f.name.toLowerCase() }, [
        h("div", {
          class: "account-head",
          style: "background:#3a3a42;display:grid;place-items:center;font-size:12px",
          textContent: f.name.slice(0, 2).toUpperCase(),
        }),
        h("div", { class: "grow" }, [
          h("div", { class: "title", textContent: f.name }),
          h("div", {
            class: "sub",
            textContent: f.messages.at(-1)?.text ?? "offline",
          }),
        ]),
        h("button", {
          class: "btn sm",
          textContent: "Chat",
          onclick: () => {
            openFriendId = f.id;
            renderFriends(mount);
          },
        }),
        h("button", {
          class: "btn ghost sm",
          textContent: "✕",
          onclick: () => {
            store.friends = store.friends.filter((x) => x.id !== f.id);
            save();
            renderFriends(mount);
          },
        }),
      ]),
    );
  }
  nameInput.addEventListener("input", () => {
    const q = nameInput.value.trim().toLowerCase();
    let shown = 0;
    for (const card of list.querySelectorAll<HTMLElement>("[data-name]")) {
      card.hidden = !!q && !card.dataset.name!.includes(q);
      if (!card.hidden) shown++;
    }
    sb.setCount(q && store.friends.length ? shown : null);
  });
  wrap.append(list);
  return wrap;
}

function chatView(friend: Friend, mount: HTMLElement): HTMLElement {
  const log = h("div", { class: "chat-log" });
  for (const m of friend.messages) {
    log.append(h("div", { class: `msg ${m.from === "me" ? "me" : "them"}`, textContent: m.text }));
  }
  const input = h("input", { type: "text", placeholder: `Nachricht an ${friend.name}` }) as HTMLInputElement;

  const send = () => {
    const t = input.value.trim();
    if (!t) return;
    friend.messages.push({ from: "me", text: t, at: Date.now() });
    save();
    input.value = "";
    renderFriends(mount);
  };
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") send();
  });

  const view = h("div", { class: "chat", style: "height:calc(100vh - 140px)" }, [
    h("button", {
      class: "btn ghost sm",
      textContent: "← Zurück",
      style: "align-self:flex-start;margin-bottom:10px",
      onclick: () => {
        openFriendId = null;
        renderFriends(mount);
      },
    }),
    log,
    h("div", { class: "chat-input" }, [
      Object.assign(input, { style: "flex:1" }),
      h("button", { class: "btn", textContent: "Senden", onclick: send }),
    ]),
  ]);
  setTimeout(() => (log.scrollTop = log.scrollHeight));
  return view;
}
