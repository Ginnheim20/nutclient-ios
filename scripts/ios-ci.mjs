// iPhone-Version auf GitHub bauen/testen lassen – in einem ÖFFENTLICHEN Build-Repo (dort sind Mac-Minuten kostenlos).
// Aufruf (aus dem Projektordner):  node scripts/ios-ci.mjs <besitzer/repo> [ipa]
//   ohne „ipa“: schneller Test im iPhone-Simulator → Bilder + Protokolle nach release/ios/simulator/
//   mit „ipa“:  echte App → release/ios/NUTclient.ipa
// Öffentlich landet nur der Launcher-Code (src, src-tauri ohne .cargo/target/gen, ios-native, iOS-Skripte) – OHNE
// Mod-Quellcode, OHNE NUTclient-Jars (dort leere Platzhalter, Classic enthält Dandelion X), OHNE E-Mail-Adresse.
// Token: ~/.tauri/github-token.txt (braucht im Build-Repo Contents, Actions und Workflows: Lesen+Schreiben).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
const ipa = process.argv[3] === "ipa";
const nurHolen = process.argv[3] === "holen"; // nur die Ergebnisse des letzten fertigen Laufs herunterladen
if (!repo || !repo.includes("/")) {
  console.error("Aufruf: node scripts/ios-ci.mjs <besitzer/repo> [ipa]");
  process.exit(1);
}
const token = readFileSync(join(homedir(), ".tauri", "github-token.txt"), "utf8").replace(/\s+/g, "");
const api = (path, opts = {}) =>
  fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(opts.headers || {}) },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

let run;
if (!nurHolen) {
// ---- 1. Schnappschuss
const dir = mkdtempSync(join(tmpdir(), "nutclient-ios-"));
const skip = (p) => /[\\/](node_modules|target|gen|\.cargo)([\\/]|$)/.test(p) || /[\\/]resources[\\/]mods[\\/]/.test(p);
for (const f of ["index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "app-icon.png", ".gitignore"]) {
  if (existsSync(f)) cpSync(f, join(dir, f));
}
for (const d of ["src", "public", "src-tauri", "ios-native"]) cpSync(d, join(dir, d), { recursive: true, filter: (p) => !skip(p) });
mkdirSync(join(dir, "scripts"), { recursive: true });
for (const f of readdirSync("scripts").filter((f) => f.startsWith("ios-"))) cpSync(join("scripts", f), join(dir, "scripts", f));
// NUTclient-Jars: leere Platzhalter (Tauri prüft beim Bauen, dass die Ressourcen da sind)
mkdirSync(join(dir, "src-tauri", "resources", "mods"), { recursive: true });
for (const f of readdirSync(join("src-tauri", "resources", "mods"))) writeFileSync(join(dir, "src-tauri", "resources", "mods", f), "");
// keine persönliche E-Mail-Adresse
const cargo = join(dir, "src-tauri", "Cargo.toml");
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^authors\s*=.*$/m, 'authors = ["NUTclient"]'));
mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
cpSync(join(".github", "workflows", "ios.yml"), join(dir, ".github", "workflows", "ios.yml"));
writeFileSync(join(dir, "README.md"), "# NUTclient – iPhone-Build\n\nAutomatischer Schnappschuss des NUTclient-Launchers zum Bauen der iPhone-Version.\n");

const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
const git = (...args) => {
  try {
    execFileSync("git", ["-c", `http.extraheader=AUTHORIZATION: basic ${auth}`, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // nur die Ausgabe von git zeigen – die Fehlermeldung von Node enthielte den Zugang
    console.error(`git ${args[0]} fehlgeschlagen:`, String(e.stderr || "").trim());
    process.exit(1);
  }
};
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=NUTclient Build", "-c", "user.email=build@nutclient.invalid", "commit", "-q", "-m", `Launcher ${version}`);
git("push", "-q", "--force", `https://github.com/${repo}.git`, "main");
rmSync(dir, { recursive: true, force: true });
console.log(`Code ${version} nach ${repo} geschoben`);

// ---- 2. Build starten und abwarten
const started = Date.now();
await sleep(3000);
let res = await api("/actions/workflows/ios.yml/dispatches", {
  method: "POST",
  body: JSON.stringify({ ref: "main", inputs: { ipa } }),
});
if (res.status !== 204) {
  console.error("Build ließ sich nicht starten:", res.status, await res.text());
  process.exit(1);
}
for (;;) {
  await sleep(20000);
  // Netzwerkaussetzer beim Warten nicht als Abbruch werten
  const runs = await api("/actions/workflows/ios.yml/runs?per_page=1").then((r) => r.json()).catch(() => ({}));
  run = runs.workflow_runs?.[0];
  if (run && Date.parse(run.created_at) >= started - 60000 && run.status === "completed") break;
  process.stdout.write(".");
}
console.log(`\nBuild fertig: ${run.conclusion} (${Math.round((Date.now() - started) / 60000)} min) ${run.html_url}`);
} else {
  const runs = await (await api("/actions/workflows/ios.yml/runs?status=completed&per_page=1")).json();
  run = runs.workflow_runs?.[0];
  if (!run) { console.error("Kein fertiger Lauf gefunden"); process.exit(1); }
  console.log(`Letzter fertiger Lauf: ${run.conclusion} ${run.html_url}`);
}

// ---- 3. Ergebnisse holen
const arts = await (await api(`/actions/runs/${run.id}/artifacts`)).json();
for (const a of arts.artifacts || []) {
  const out = a.name === "launcher-iOS" ? join("release", "ios") : join("release", "ios", "simulator");
  // Ordner nur leeren, nicht löschen (unter Windows ist er sonst gesperrt, wenn eine Konsole darin steht)
  if (out === join("release", "ios")) rmSync(join(out, "NUTclient.ipa"), { force: true });
  else if (existsSync(out)) for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const zip = await fetch(a.archive_download_url, { headers: { Authorization: `Bearer ${token}` } });
  // relativer Pfad: das tar aus Git Bash hält „C:“ sonst für eine Server-Adresse
  const fwd = (p) => p.split("\\").join("/");
  const tmp = fwd(`${out}/nut-${a.id}.zip`);
  writeFileSync(tmp, Buffer.from(await zip.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", tmp, "-d", fwd(out)]);
  rmSync(tmp, { force: true });
  console.log(`${a.name} → ${out}`);
}
// Job-Protokoll für die Fehlersuche
const jobs = await (await api(`/actions/runs/${run.id}/jobs`)).json();
const job = jobs.jobs?.[0];
if (job) {
  const log = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, { headers: { Authorization: `Bearer ${token}` } });
  mkdirSync(join("release", "ios"), { recursive: true });
  writeFileSync(join("release", "ios", "job.log"), await log.text());
  for (const s of job.steps) if (s.conclusion !== "success" && s.conclusion !== "skipped") console.log(`  ! ${s.conclusion}: ${s.name}`);
}
