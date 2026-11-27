import { store } from "./state";

export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", store.settings.theme);
}
