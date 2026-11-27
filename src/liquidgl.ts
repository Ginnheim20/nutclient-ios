// WebGL-Glas: Die großen Glasflächen (Leiste, Topbar, Panels, Karten …) brechen
// den Hintergrund (Hintergrundvideo oder -bild) per Shader.
//  • Linsen-Verzerrung zum Rand hin (Lichtbrechung)
//  • weiche Unschärfe (9 Abtastungen)
//  • Farbspreizung am Rand (Rot/Blau leicht versetzt)
//  • Leuchten an hellen Stellen (z. B. Lava, Lampen)
//  • feste Kanten-Spiegelung oben
// Der Canvas liegt in .app unter dem Inhalt (z-index -1). Außerhalb der Glasflächen
// bleibt er transparent, sodass der Hintergrund wie bisher durchscheint.
// Fällt WebGL oder die Hintergrund-Quelle weg, bleibt die CSS-Glasoptik.

const GLASS_SEL = [
  ".rail", ".topbar", ".panel", ".dialog", ".menu", ".card", ".slime-glass",
  ".slime-shop", ".set-group", ".inst-card", ".content-card", ".mod-sec",
  ".account-chip", ".skin-viewer", ".play-btn", ".play-more", ".msg-bar",
].join(",");

const MAXG = 24;
const RENDER_SCALE = 0.6; // Canvas-Auflösung relativ zur CSS-Größe (Performance)

const VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FS = `
precision highp float;
#define MAXG ${MAXG}
uniform sampler2D uTex;
uniform vec2 uRes;        // Canvas in Device-Pixeln
uniform float uDpr;       // Canvas-Pixel je CSS-Pixel
uniform vec2 uCss;        // Größe in CSS-Pixeln
uniform vec2 uCover;      // Cover-Skalierung der Textur
uniform int uCount;
uniform vec4 uRect[MAXG]; // x, y, w, h in CSS-Pixeln (y nach unten)
uniform float uRad[MAXG];
uniform vec4 uTint[MAXG];   // rgb + Mischstärke je Fläche

vec2 texUV(vec2 p) {
  vec2 suv = vec2(p.x / uCss.x, 1.0 - p.y / uCss.y);
  return (suv - 0.5) * uCover + 0.5;
}

vec3 blur9(vec2 p, float r) {
  vec3 acc = texture2D(uTex, texUV(p + vec2(-r, -r))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(0.0, -r))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(r, -r))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(-r, 0.0))).rgb;
  acc += texture2D(uTex, texUV(p)).rgb;
  acc += texture2D(uTex, texUV(p + vec2(r, 0.0))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(-r, r))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(0.0, r))).rgb;
  acc += texture2D(uTex, texUV(p + vec2(r, r))).rgb;
  return acc / 9.0;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec4 outc = vec4(0.0);
  for (int i = 0; i < MAXG; i++) {
    if (i >= uCount) break;
    vec4 r = uRect[i];
    vec2 c = r.xy + r.zw * 0.5;
    vec2 hs = r.zw * 0.5;
    float rad = min(uRad[i], min(hs.x, hs.y));
    vec2 q = abs(p - c) - (hs - rad);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
    if (d < 1.0) {
      float cover = 1.0 - smoothstep(-0.5, 0.5, d);
      float edge = 1.0 - smoothstep(-22.0, 0.0, d);       // 1 am Rand, 0 im Inneren
      vec2 dir = normalize(p - c + vec2(0.0001));
      vec2 pp = p - dir * edge * 14.0;                     // Linsen-Brechung zum Rand
      vec3 base = blur9(pp, 2.5);
      float ca = edge * 2.5;                               // Farbspreizung am Rand
      float rr = texture2D(uTex, texUV(pp + dir * ca)).r;
      float bb = texture2D(uTex, texUV(pp - dir * ca)).b;
      vec3 col = vec3(rr, base.g, bb);
      vec3 bright = max(col - 0.6, 0.0);                   // Leuchten (Lava, Lampen)
      col += bright * 0.1;
      float top = 0.5 + 0.5 * (-dir.y);
      float rim = (1.0 - smoothstep(-2.0, 0.0, d)) * top * 0.04;
      col = mix(col, vec3(1.0), rim);
      vec4 tt = uTint[i];
      col = mix(col, tt.rgb, tt.a);
      float a = cover;
      outc = vec4(col * a, a);
    }
  }
  gl_FragColor = outc;
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("[liquid glass] Shader:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

/** Hintergrund-Quelle: Video (wenn aktiv) oder Bild (--bg-image), sonst null. */
function backgroundSource(
  cache: { url: string; img: HTMLImageElement | null },
): HTMLVideoElement | HTMLImageElement | null {
  const root = document.documentElement;
  if (root.classList.contains("has-bg-video")) {
    const v = document.getElementById("bg-video") as HTMLVideoElement | null;
    if (v && v.readyState >= 2 && v.videoWidth > 0) return v;
  }
  if (root.classList.contains("has-bg-image")) {
    const raw = getComputedStyle(root).getPropertyValue("--bg-image").trim();
    const m = /url\(["']?(.*?)["']?\)/.exec(raw);
    if (!m) return null;
    if (m[1] !== cache.url) {
      cache.url = m[1];
      cache.img = new Image();
      cache.img.src = m[1];
    }
    if (cache.img && cache.img.complete && cache.img.naturalWidth > 0) return cache.img;
  }
  return null;
}

export function initLiquidGlass(): void {
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) return;
  const canvas = document.createElement("canvas");
  canvas.className = "liquid-gl";
  canvas.setAttribute("aria-hidden", "true");
  app.prepend(canvas);

  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true });
  if (!gl) return;
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  if (!prog) return;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[liquid glass] Link:", gl.getProgramInfoLog(prog));
    return;
  }
  gl.useProgram(prog);

  // Vollflächiges Dreieckspaar
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const loc = {
    tex: gl.getUniformLocation(prog, "uTex"),
    res: gl.getUniformLocation(prog, "uRes"),
    dpr: gl.getUniformLocation(prog, "uDpr"),
    css: gl.getUniformLocation(prog, "uCss"),
    cover: gl.getUniformLocation(prog, "uCover"),
    count: gl.getUniformLocation(prog, "uCount"),
    rect: gl.getUniformLocation(prog, "uRect"),
    rad: gl.getUniformLocation(prog, "uRad"),
    tint: gl.getUniformLocation(prog, "uTint"),
  };

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const rects = new Float32Array(MAXG * 4);
  const rads = new Float32Array(MAXG);
  const tints = new Float32Array(MAXG * 4);
  const cache: { url: string; img: HTMLImageElement | null } = { url: "", img: null };
  let uploadedVideoTime = -1;
  let uploadedImg: HTMLImageElement | null = null;
  let glOn = false;
  let cssW = 0;
  let cssH = 0;

  function resize(): void {
    cssW = innerWidth;
    cssH = innerHeight;
    canvas.width = Math.max(1, Math.round(cssW * RENDER_SCALE));
    canvas.height = Math.max(1, Math.round(cssH * RENDER_SCALE));
    gl!.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  function collectRects(): number {
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>(GLASS_SEL)) {
      if (n >= MAXG) break;
      if (!el.getClientRects().length) continue; // ausgeblendet
      if (effectiveOpacity(el) < 0.05) continue; // unsichtbar (z. B. Topbar bei offenem Panel)
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > cssH || r.right < 0 || r.left > cssW) continue;
      rects[n * 4] = r.left;
      rects[n * 4 + 1] = r.top;
      rects[n * 4 + 2] = r.width;
      rects[n * 4 + 3] = r.height;
      const accent = el.matches(".play-btn, .play-more");
      const t = accent ? accentRgb(el) : NEUTRAL_TINT;
      tints[n * 4] = t[0];
      tints[n * 4 + 1] = t[1];
      tints[n * 4 + 2] = t[2];
      tints[n * 4 + 3] = accent ? 0.55 : 0.22;
      rads[n] = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12;
      n++;
    }
    return n;
  }

  function setGlOn(on: boolean): void {
    if (on === glOn) return;
    glOn = on;
    document.documentElement.classList.toggle("gl-on", on);
    canvas.hidden = !on;
  }

  function frame(): void {
    const src = backgroundSource(cache);
    if (!src) {
      setGlOn(false);
      setTimeout(frame, 400); // Quelle später prüfen
      return;
    }
    setGlOn(true);

    // Textur aktualisieren (Video nur bei neuem Frame, Bild einmal)
    if (src instanceof HTMLVideoElement) {
      if (src.currentTime !== uploadedVideoTime) {
        gl!.bindTexture(gl!.TEXTURE_2D, texture);
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, gl!.RGB, gl!.UNSIGNED_BYTE, src);
        uploadedVideoTime = src.currentTime;
      }
    } else if (src !== uploadedImg) {
      gl!.bindTexture(gl!.TEXTURE_2D, texture);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, gl!.RGB, gl!.UNSIGNED_BYTE, src);
      uploadedImg = src;
    }

    // Cover-Skalierung wie background-size: cover
    const texW = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth;
    const texH = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
    const sa = cssW / cssH;
    const ta = texW / texH;
    const cover: [number, number] = sa < ta ? [sa / ta, 1] : [1, ta / sa];

    const count = collectRects();
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    gl!.uniform1i(loc.tex, 0);
    gl!.uniform2f(loc.res, canvas.width, canvas.height);
    gl!.uniform1f(loc.dpr, canvas.width / cssW);
    gl!.uniform2f(loc.css, cssW, cssH);
    gl!.uniform2f(loc.cover, cover[0], cover[1]);
    gl!.uniform1i(loc.count, count);
    gl!.uniform4fv(loc.rect, rects);
    gl!.uniform1fv(loc.rad, rads);
    gl!.uniform4fv(loc.tint, tints);
    gl!.drawArrays(gl!.TRIANGLES, 0, 6);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Deckkraft inkl. aller Vorfahren – ausgeblendete Eltern blenden Glas mit aus. */
function effectiveOpacity(el: HTMLElement): number {
  let o = 1;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    o *= parseFloat(getComputedStyle(n).opacity) || 0;
    if (o < 0.01) break;
  }
  return o;
}

/** Neutrales, leicht dunkles Glas für alle Flächen außer dem Spielen-Button. */
const NEUTRAL_TINT: [number, number, number] = [0.12, 0.13, 0.15];

/** Gewählte Akzentfarbe (--accent, Hex) als RGB 0..1 – nur für den Spielen-Button. */
function accentRgb(el: HTMLElement): [number, number, number] {
  // Eigene Akzentfarbe des Elements (z. B. roter Stopp-Knopf) hat Vorrang vor der des Launchers
  const hex = getComputedStyle(el).getPropertyValue("--accent").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.25, 0.68, 0.3];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
