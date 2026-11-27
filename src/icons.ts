// Inline-SVG-Icons (Stroke folgt currentColor via CSS `stroke: var(--text)`).
// Bewusst schlicht gehalten, damit alles einheitlich wirkt.

const wrap = (inner: string) =>
  `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const icons = {
  // Play (Bühne + „zuletzt gespielt")
  play: wrap('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),

  // Stopp (großer Knopf wird im Lauf rot)
  stop: wrap('<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'),

  // Startbildschirm: Haus
  home: wrap(
    '<path d="M3.5 11.5 12 4.5l8.5 7"/>' +
      '<path d="M5.5 10.2V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8.8"/>' +
      '<path d="M9.8 20v-4.6a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1V20"/>',
  ),

  // Skins & Cosmetics: Kleiderbügel
  hanger: wrap(
    '<path d="M12 8.2a2 2 0 1 1 1.8 2c-1 .3-1.8.7-1.8 1.7v.3"/>' +
      '<path d="M12 12.2 4.6 16.3a1 1 0 0 0 .5 1.9h13.8a1 1 0 0 0 .5-1.9L12 12.2Z"/>',
  ),

  // Inhalte hinzufügen: Paket mit Plus
  plus: wrap(
    '<rect x="4" y="4" width="16" height="16" rx="2.4"/>' +
      '<path d="M12 8.5v7M8.5 12h7"/>',
  ),

  // Freunde (zwei Personen)
  friends: wrap(
    '<circle cx="9" cy="8.4" r="3.1"/>' +
      '<path d="M3.4 19.2a5.6 5.6 0 0 1 11.2 0"/>' +
      '<path d="M16.4 5.9a2.8 2.8 0 0 1 .2 5.5"/>' +
      '<path d="M17.6 13.4a4.7 4.7 0 0 1 3 4.4"/>',
  ),

  // Umhang / Cape
  cape: wrap(
    '<path d="M8 4.5c-.5 2-2 3.2-3.5 4 1 5 2.2 8.5 3.5 11h8c1.3-2.5 2.5-6 3.5-11-1.5-.8-3-2-3.5-4"/>' +
      '<path d="M9.4 4.4a2.6 2.6 0 0 0 5.2 0"/>',
  ),

  // Grüner Bereich: Einstellungen (Zahnrad)
  gear: wrap(
    '<path fill="currentColor" stroke="none" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.48.48 0 0 0 13.5 2h-3a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.66 8.47a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>'
  ),

  // Blauer Bereich: Glocke
  bell: wrap(
    '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>'
  ),

  // Dunkelblauer Bereich: Konto / Person
  account: wrap('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),

  check: wrap('<path d="M5 12l5 5L20 7"/>'),
  trash: wrap('<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>'),
  pencil: wrap('<path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>'),
  copy: wrap('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  folder: wrap('<path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'),
  upload: wrap('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>'),
  sort: wrap('<path d="M7 5v14M7 5l-3 3M7 5l3 3M17 19V5M17 19l-3-3M17 19l3-3"/>'),
  search: wrap('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>'),
  clock: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>'),
  expand: wrap('<path d="M9 4H5v4M15 20h4v-4M20 9V5h-4M4 15v4h4"/>'),
  refresh: wrap('<path d="M20 11A8 8 0 0 0 6.3 5.7L4 8M4 4v4h4M4 13a8 8 0 0 0 13.7 5.3L20 16M20 20v-4h-4"/>'),

  // Instanzen (Raster aus Kacheln)
  grid: wrap(
    '<rect x="4" y="4" width="7" height="7" rx="1.4"/>' +
      '<rect x="13" y="4" width="7" height="7" rx="1.4"/>' +
      '<rect x="4" y="13" width="7" height="7" rx="1.4"/>' +
      '<rect x="13" y="13" width="7" height="7" rx="1.4"/>',
  ),

  // Chevron nach unten (Aufklapp-Pfeil am Play-Button)
  chevronDown: wrap('<path d="M6 9l6 6 6-6"/>'),

  // Wiedergabe-Widget
  music: wrap(
    '<path d="M9 17V5l11-2v12" fill="none"/>' +
      '<circle cx="6.5" cy="17.5" r="2.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="17.5" cy="15.5" r="2.6" fill="currentColor" stroke="none"/>',
  ),
  pause: wrap('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  skipBack: wrap('<path d="M18 6v12L9 12z" fill="currentColor" stroke="none"/><rect x="5" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>'),
  skipFwd: wrap('<path d="M6 6v12l9-6z" fill="currentColor" stroke="none"/><rect x="16.6" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>'),

  // Discord (vereinfachtes Logo)
  discord: wrap(
    '<path fill="currentColor" stroke="none" d="M19.3 5.4A17 17 0 0 0 15 4l-.3.5a13 13 0 0 1 3.8 1.9c-3.9-1.8-8.5-1.8-12.4 0A13 13 0 0 1 9.7 4.5L9.4 4A17 17 0 0 0 5 5.4C2.4 9.3 1.7 13 2 16.7a17 17 0 0 0 5.2 2.6l.6-1a11 11 0 0 1-1.8-.9l.4-.3c3.4 1.6 7.6 1.6 11 0l.4.3c-.6.4-1.2.7-1.8.9l.6 1a17 17 0 0 0 5.2-2.6c.4-4.3-.6-8-3.5-11.3zM9 14.3c-1 0-1.9-1-1.9-2.1 0-1.2.8-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.8 2.1-1.9 2.1zm6 0c-1 0-1.9-1-1.9-2.1 0-1.2.8-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.8 2.1-1.9 2.1z"/>',
  ),
};

export function setIcon(el: Element | null, name: keyof typeof icons): void {
  if (el) el.innerHTML = icons[name];
}
