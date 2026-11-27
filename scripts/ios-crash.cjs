// Liest einen iOS-Absturzbericht (.ips) und druckt Ursache + Aufrufkette des abgestürzten Threads (für den Simulator-Test).
// Aufruf: node scripts/ios-crash.cjs <datei.ips>
const fs = require("fs");
const t = fs.readFileSync(process.argv[2], "utf8");
const body = JSON.parse(t.slice(t.indexOf("\n") + 1));
console.log("Ausnahme:", JSON.stringify(body.exception), JSON.stringify(body.termination || {}).slice(0, 400));
if (body.asi) console.log("Hinweis:", JSON.stringify(body.asi).slice(0, 800));
const th = body.threads.find((x) => x.triggered) || body.threads[body.faultingThread || 0];
console.log("Thread:", th.name || th.queue || "?");
for (const f of th.frames.slice(0, 40)) {
  const img = body.usedImages[f.imageIndex] || {};
  console.log("  ", (img.name || "?").padEnd(28), f.symbol || "", f.symbolLocation != null ? "+" + f.symbolLocation : "", f.sourceFile ? `(${f.sourceFile}:${f.sourceLine})` : "");
}
