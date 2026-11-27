// Laufende Spiele (Profile): Liste vom Launcher-Backend, Ereignis „launch://running".
// Der große Play-Knopf wird im Lauf zum Stopp-Knopf (stoppt das zuerst gestartete),
// die Instanz-Liste zeigt pro Karte selbst einen Stopp.
import { hasTauri, onEvent, runningInstances, stopInstance } from "./launcher/api";

export interface RunningGame {
  profileId: string;
  pid: number;
}

let games: RunningGame[] = [];

export function runningGames(): RunningGame[] {
  return games;
}

export function isRunning(profileId: string): boolean {
  return games.some((g) => g.profileId === profileId);
}

/** Stoppt das zuerst gestartete Spiel (großer Knopf). */
export async function stopFirst(): Promise<void> {
  const first = games[0];
  if (first) await stopProfile(first.profileId);
}

export async function stopProfile(profileId: string): Promise<void> {
  try {
    await stopInstance(profileId);
  } catch (e) {
    console.warn("[running] Stopp fehlgeschlagen:", e);
  }
}

function set(list: { profile_id: string; pid: number }[]): void {
  games = list.map((g) => ({ profileId: g.profile_id, pid: g.pid }));
  document.dispatchEvent(new CustomEvent("running-change"));
}

/** Einmal beim Start aufrufen: Anfangszustand holen und auf Änderungen hören. */
export async function initRunning(): Promise<void> {
  if (!hasTauri) return;
  set(await runningInstances());
  await onEvent<{ profile_id: string; pid: number }[]>("launch://running", set);
}
