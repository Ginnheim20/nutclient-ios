// Konto-Verwaltung im Frontend. Das Backend hält aktuell genau ein Konto
// (login/current_account); die Mehrfach-Konto-Liste hier ist ein lokaler Cache,
// bis das Backend Kontowechsel unterstützt.
import { currentAccount, login, offlineLogin } from "./launcher/api";
import type { Account } from "./launcher/types";

const KEY = "mcl.accounts.v1";

interface AccountCache {
  known: Account[];
  activeUuid: string | null;
}

function load(): AccountCache {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "") as AccountCache;
  } catch {
    return { known: [], activeUuid: null };
  }
}

let cache = load();
const listeners = new Set<() => void>();

function persist(): void {
  localStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((f) => f());
}

export function onAccountChange(fn: () => void): void {
  listeners.add(fn);
}

export function knownAccounts(): Account[] {
  return cache.known;
}

export function active(): Account | null {
  return cache.known.find((a) => a.uuid === cache.activeUuid) ?? cache.known[0] ?? null;
}

export async function refresh(): Promise<void> {
  const acc = await currentAccount().catch(() => null);
  if (acc) mergeAccount(acc);
}

function mergeAccount(acc: Account): void {
  const i = cache.known.findIndex((a) => a.uuid === acc.uuid);
  if (i >= 0) cache.known[i] = acc;
  else cache.known.push(acc);
  cache.activeUuid = acc.uuid;
  persist();
}

export async function addAccount(): Promise<Account> {
  const acc = await login();
  mergeAccount(acc);
  return acc;
}

export async function addOfflineAccount(username: string): Promise<Account> {
  const acc = await offlineLogin(username);
  mergeAccount({ ...acc, offline: true });
  return acc;
}

export function switchTo(uuid: string): void {
  cache.activeUuid = uuid;
  persist();
}

export function removeAccount(uuid: string): void {
  cache.known = cache.known.filter((a) => a.uuid !== uuid);
  if (cache.activeUuid === uuid) cache.activeUuid = cache.known[0]?.uuid ?? null;
  persist();
}
