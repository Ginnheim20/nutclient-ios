// NUTclient iOS – Generator für die eigene OpenGL-Brücke (nutgl).
// Liest die offizielle Funktionsliste gl.xml (Khronos-Registry, nur beim Bauen) und erzeugt:
//   gl_es.h   – GL-Typen + Zeiger auf die echten OpenGL-ES-3-Funktionen des iPhones (es_glXxx)
//   gl_gen.c  – JEDE Desktop-OpenGL-Funktion 1.0 … 4.6 als exportiertes Symbol:
//                 eigene Fassung in gl_overrides.c (ov_glXxx)  →  die wird gerufen
//                 sonst gleiche Funktion in OpenGL ES 3.0       →  direkt weiterreichen
//                 sonst                                         →  leere Fassung (einmal ins Protokoll)
// LWJGL holt sich jede Funktion per dlsym aus unserer Bibliothek; fehlen welche, meldet es OpenGL 3.3 als „nicht da“.
//
// Aufruf: node gen-gl.mjs <gl.xml> <gl_overrides.c> <ausgabe-ordner>
import fs from "node:fs";
import path from "node:path";

const [xmlPath, ovPath, outDir] = process.argv.slice(2);
const xml = fs.readFileSync(xmlPath, "utf8");
const overrides = new Set([...fs.readFileSync(ovPath, "utf8").matchAll(/\bov_(gl\w+)\s*\(/g)].map((m) => m[1]));

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ---- alle Befehle mit Rückgabetyp + Parametern
const commands = new Map();
const cmdBlock = xml.slice(xml.indexOf("<commands"), xml.indexOf("</commands>"));
for (const m of cmdBlock.matchAll(/<command\b[^>]*>([\s\S]*?)<\/command>/g)) {
  const body = m[1];
  const proto = body.match(/<proto\b[^>]*>([\s\S]*?)<\/proto>/)[1];
  const name = proto.match(/<name>(\w+)<\/name>/)[1];
  const ret = strip(proto.replace(/<name>\w+<\/name>/, ""));
  const params = [...body.matchAll(/<param\b[^>]*>([\s\S]*?)<\/param>/g)].map((p) => {
    const pname = p[1].match(/<name>(\w+)<\/name>/)[1];
    return { decl: strip(p[1]), name: pname };
  });
  commands.set(name, { name, ret, params });
}

// ---- welche Befehle gehören zu Desktop-GL (alle Versionen) und welche gibt es in OpenGL ES 3.0
const desktop = new Set();
const es3 = new Set();
for (const f of xml.matchAll(/<feature\b([^>]*)>([\s\S]*?)<\/feature>/g)) {
  const api = (f[1].match(/api="(\w+)"/) || [])[1];
  const num = parseFloat((f[1].match(/number="([\d.]+)"/) || [])[1] || "0");
  // nur <require>, nicht <remove>
  const req = [...f[2].matchAll(/<require\b[^>]*>([\s\S]*?)<\/require>/g)].map((r) => r[1]).join("\n");
  const names = [...req.matchAll(/<command name="(\w+)"/g)].map((c) => c[1]);
  if (api === "gl") names.forEach((n) => desktop.add(n));
  if (api === "gles2" && num <= 3.0) names.forEach((n) => es3.add(n));
}

const declParams = (c) => (c.params.length ? c.params.map((p) => p.decl).join(", ") : "void");
const callArgs = (c) => c.params.map((p) => p.name).join(", ");
const fnType = (c, star) => `${c.ret} (*${star})(${declParams(c)})`;

let h = `/* ERZEUGT von gen-gl.mjs – nicht von Hand ändern. */
#pragma once
#include <stdint.h>
#include <stddef.h>
typedef unsigned int GLenum; typedef unsigned char GLboolean; typedef unsigned int GLbitfield; typedef void GLvoid;
typedef signed char GLbyte; typedef unsigned char GLubyte; typedef short GLshort; typedef unsigned short GLushort;
typedef int GLint; typedef unsigned int GLuint; typedef int GLsizei; typedef float GLfloat; typedef float GLclampf;
typedef double GLdouble; typedef double GLclampd; typedef char GLchar; typedef ptrdiff_t GLintptr; typedef ptrdiff_t GLsizeiptr;
typedef int64_t GLint64; typedef uint64_t GLuint64; typedef struct __GLsync *GLsync; typedef unsigned short GLhalf; typedef int GLfixed;
typedef void (*GLDEBUGPROC)(GLenum, GLenum, GLuint, GLenum, GLsizei, const GLchar *, const void *);
/* Zeiger auf die echten OpenGL-ES-3-Funktionen (OpenGLES.framework) */
`;
const esList = [...es3].filter((n) => commands.has(n)).sort();
for (const n of esList) h += `extern ${fnType(commands.get(n), "es_" + n)};\n`;
h += `void nutgl_load(void);\nvoid nutgl_missing(const char *name);\n`;

let c = `/* ERZEUGT von gen-gl.mjs – nicht von Hand ändern. */
#include <dlfcn.h>
#include "gl_es.h"
#define EXPORT __attribute__((visibility("default")))
`;
for (const n of esList) c += `${fnType(commands.get(n), "es_" + n)};\n`;
c += `\nvoid nutgl_load(void) {\n  static int done = 0; if (done) return; done = 1;\n  void *h = dlopen("/System/Library/Frameworks/OpenGLES.framework/OpenGLES", RTLD_LAZY | RTLD_LOCAL);\n`;
for (const n of esList) c += `  es_${n} = (${fnType(commands.get(n), "")})dlsym(h, "${n}");\n`;
c += `}\n\n`;

// eigene Fassungen deklarieren
const all = [...desktop].filter((n) => commands.has(n)).sort();
let nOv = 0, nEs = 0, nStub = 0;
for (const n of all) {
  const cm = commands.get(n);
  const ret = cm.ret;
  const isVoid = ret === "void";
  if (overrides.has(n)) {
    c += `${ret} ov_${n}(${declParams(cm)});\n`;
  }
}
c += "\n";
for (const n of all) {
  const cm = commands.get(n);
  const ret = cm.ret;
  const isVoid = ret === "void";
  const r = isVoid ? "" : "return ";
  if (overrides.has(n)) {
    c += `EXPORT ${ret} ${n}(${declParams(cm)}) { ${r}ov_${n}(${callArgs(cm)}); }\n`;
    nOv++;
  } else if (es3.has(n)) {
    c += `EXPORT ${ret} ${n}(${declParams(cm)}) { ${r}es_${n}(${callArgs(cm)}); }\n`;
    nEs++;
  } else {
    const zero = isVoid ? "" : ret.includes("*") || ret === "GLsync" ? " return 0;" : ` return (${ret})0;`;
    c += `EXPORT ${ret} ${n}(${declParams(cm)}) { nutgl_missing("${n}");${zero} }\n`;
    nStub++;
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "gl_es.h"), h);
fs.writeFileSync(path.join(outDir, "gl_gen.c"), c);
const unknownOv = [...overrides].filter((n) => !desktop.has(n));
console.log(`nutgl: ${all.length} GL-Funktionen – ${nOv} eigene, ${nEs} direkt an OpenGL ES, ${nStub} leer` +
  (unknownOv.length ? ` | Hinweis: eigene Fassungen ohne GL-Befehl: ${unknownOv.join(", ")}` : ""));
