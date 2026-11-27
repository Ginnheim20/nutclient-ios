// Winziger, sicherer Markdown-Renderer für Modrinth-Beschreibungen.
// Kein Fremd-Lib (CSP/Tauri). Baut echte DOM-Knoten – niemals rohes innerHTML
// aus fremdem Text – und lässt nur eine Whitelist an Tags/Attributen zu.

const OK_URL = /^https?:\/\//i;
const YT =
  /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;

function el(tag: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  return e;
}

/** HTML-Entities (&nbsp; &amp; &#39; …) zu echten Zeichen. Sicher: Textarea rendert kein Markup. */
function decode(s: string): string {
  if (!s.includes("&")) return s;
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

/** Inline-Auszeichnung (**fett** *kursiv* `code` [text](url)) in `parent` anhängen. */
function inline(parent: Node, raw: string): void {
  const s = decode(raw);
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/\S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
    if (m[1]) parent.appendChild(el("strong", m[2]));
    else if (m[3]) parent.appendChild(el("code", m[4]));
    else if (m[5]) {
      const url = m[7];
      if (OK_URL.test(url)) {
        const a = el("a", m[6]) as HTMLAnchorElement;
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(m[6]));
    } else if (m[8]) {
      const a = el("a", m[8]) as HTMLAnchorElement;
      a.href = m[8];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
    last = re.lastIndex;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
}

/** YouTube-Vorschaubild statt iframe (Frame-Einbettung ist per CSP gesperrt). */
function youtubeCard(id: string): HTMLElement {
  const a = el("a") as HTMLAnchorElement;
  a.className = "md-video";
  a.href = `https://www.youtube.com/watch?v=${id}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.src = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  img.alt = "Video auf YouTube ansehen";
  img.loading = "lazy";
  a.append(img, el("span", "▶ Video auf YouTube"));
  return a;
}

export function renderMarkdown(md: string): HTMLElement {
  const root = el("div");
  root.className = "md";
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  let list: HTMLElement | null = null;
  let code: HTMLElement | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = el("p");
    inline(p, para.join(" "));
    root.appendChild(p);
    para = [];
  };
  const flushList = () => {
    if (list) root.appendChild(list);
    list = null;
  };

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (code) {
        root.appendChild(code);
        code = null;
      } else {
        flushPara();
        flushList();
        code = el("pre");
      }
      continue;
    }
    if (code) {
      code.appendChild(document.createTextNode(raw + "\n"));
      continue;
    }

    const line = raw.trim();

    // rohes <img> / <iframe> aus HTML-Blöcken herausziehen
    const imgTag = line.match(/<img[^>]+src=["']([^"']+)["']/i);
    const frame = line.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (frame) {
      flushPara();
      flushList();
      const yt = frame[1].match(YT);
      if (yt) root.appendChild(youtubeCard(yt[1]));
      continue;
    }
    if (imgTag && OK_URL.test(imgTag[1])) {
      flushPara();
      flushList();
      const img = document.createElement("img");
      img.src = imgTag[1];
      img.alt = "";
      img.loading = "lazy";
      root.appendChild(img);
      continue;
    }

    if (!line) {
      flushPara();
      flushList();
      continue;
    }

    // eigenständiges Markdown-Bild  ![alt](url)
    const mdImg = line.match(/^!\[([^\]]*)\]\((\S+?)\)\s*$/);
    if (mdImg && OK_URL.test(mdImg[2])) {
      flushPara();
      flushList();
      const img = document.createElement("img");
      img.src = mdImg[2];
      img.alt = mdImg[1];
      img.loading = "lazy";
      root.appendChild(img);
      continue;
    }
    // reine YouTube-Zeile
    const ytLine = line.match(YT);
    if (ytLine && /^(https?:\/\/)?\S+$/.test(line)) {
      flushPara();
      flushList();
      root.appendChild(youtubeCard(ytLine[1]));
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flushPara();
      flushList();
      const n = Math.min(head[1].length + 2, 6);
      const hEl = el(`h${n}`);
      inline(hEl, head[2].replace(/#+\s*$/, ""));
      root.appendChild(hEl);
      continue;
    }

    if (/^([-*+])\s+/.test(line)) {
      flushPara();
      if (!list) list = el("ul");
      const li = el("li");
      inline(li, line.replace(/^([-*+])\s+/, ""));
      list.appendChild(li);
      continue;
    }
    if (/^(---+|\*\*\*+|___+)$/.test(line)) {
      flushPara();
      flushList();
      root.appendChild(el("hr"));
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      const bq = el("blockquote");
      inline(bq, line.replace(/^>\s?/, ""));
      root.appendChild(bq);
      continue;
    }

    // sonstige rohe HTML-Tags entfernen, Textinhalt behalten
    const txt = decode(line.replace(/<[^>]+>/g, "")).trim();
    if (txt) para.push(txt);
  }
  flushPara();
  flushList();
  if (code) root.appendChild(code);
  return root;
}
