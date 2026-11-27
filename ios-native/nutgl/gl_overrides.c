/* NUTclient iOS – eigene OpenGL-Brücke: Desktop-OpenGL 3.3 (Core) auf OpenGL ES 3.0 des iPhones.
 * Jede Funktion ov_glXxx ersetzt hier glXxx (gen-gl.mjs verdrahtet das). Alles andere geht 1:1 an OpenGL ES
 * oder ist eine leere Fassung. Eigener Code.
 *
 * Was hier passiert:
 *  - Versionsangaben: wir melden „OpenGL 3.3 Core, vorwärtskompatibel“, keine Erweiterungen
 *  - Standard-Framebuffer 0 = unser eigener Framebuffer (iOS hat keinen „Fenster-Framebuffer“)
 *  - Shader: GLSL 150/330 → GLSL ES 3.00 (Version, Genauigkeit, nicht vorhandene Qualifier)
 *  - Texturformate, Zustände und Parameter, die es in OpenGL ES nicht gibt, werden umgesetzt oder ignoriert
 *  - Zeichnen mit „baseVertex“ (gibt es erst ab ES 3.2) über das Verschieben der Attribut-Zeiger
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "gl_es.h"

#define EXPORT __attribute__((visibility("default")))

/* ---- Konstanten (aus der OpenGL-Spezifikation) */
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_EXTENSIONS 0x1F03
#define GL_SHADING_LANGUAGE_VERSION 0x8B8C
#define GL_MAJOR_VERSION 0x821B
#define GL_MINOR_VERSION 0x821C
#define GL_NUM_EXTENSIONS 0x821D
#define GL_CONTEXT_FLAGS 0x821E
#define GL_CONTEXT_PROFILE_MASK 0x9126
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_FRAMEBUFFER_BINDING 0x8CA6
#define GL_READ_FRAMEBUFFER_BINDING 0x8CAA
#define GL_TEXTURE_2D 0x0DE1
#define GL_NONE 0
#define GL_FRONT_LEFT 0x0400
#define GL_FRONT_RIGHT 0x0401
#define GL_BACK_LEFT 0x0402
#define GL_BACK_RIGHT 0x0403
#define GL_FRONT 0x0404
#define GL_BACK 0x0405
#define GL_FRONT_AND_BACK 0x0408
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_TEXTURE_LOD_BIAS 0x8501
#define GL_TEXTURE_BORDER_COLOR 0x1004
#define GL_CLAMP 0x2900
#define GL_CLAMP_TO_BORDER 0x812D
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_RED 0x1903
#define GL_RG 0x8227
#define GL_R8 0x8229
#define GL_RG8 0x822B
#define GL_RGBA8 0x8058
#define GL_RGB8 0x8051
#define GL_BGRA 0x80E1
#define GL_BGR 0x80E0
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_UNSIGNED_INT_8_8_8_8_REV 0x8367
#define GL_UNSIGNED_INT_8_8_8_8 0x8035
#define GL_DEPTH_COMPONENT 0x1902
#define GL_DEPTH_COMPONENT16 0x81A5
#define GL_DEPTH_COMPONENT24 0x81A6
#define GL_DEPTH_COMPONENT32 0x81A7
#define GL_DEPTH_COMPONENT32F 0x8CAC
#define GL_DEPTH_STENCIL 0x84F9
#define GL_DEPTH24_STENCIL8 0x88F0
#define GL_UNSIGNED_INT_24_8 0x84FA
#define GL_ARRAY_BUFFER 0x8892
#define GL_ARRAY_BUFFER_BINDING 0x8894
#define GL_BUFFER_SIZE 0x8764
#define GL_READ_ONLY 0x88B8
#define GL_WRITE_ONLY 0x88B9
#define GL_READ_WRITE 0x88BA
#define GL_MAP_READ_BIT 0x0001
#define GL_MAP_WRITE_BIT 0x0002
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_INFO_LOG_LENGTH 0x8B84
#define GL_VERTEX_SHADER 0x8B31
#define GL_SHADER_TYPE 0x8B4F
#define GL_PRIMITIVE_RESTART 0x8F9D
#define GL_PRIMITIVE_RESTART_FIXED_INDEX 0x8D69
#define GL_BLEND 0x0BE2
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867
#define GL_TIMESTAMP 0x8E28
#define GL_UNPACK_SWAP_BYTES 0x0CF0
#define GL_UNPACK_LSB_FIRST 0x0CF1
#define GL_PACK_SWAP_BYTES 0x0D00
#define GL_PACK_LSB_FIRST 0x0D01

/* ---- Protokoll (Datei im App-Ordner + stderr) */
static FILE *logf;
void nutgl_set_log(const char *path) { logf = fopen(path, "w"); }
void nutgl_log(const char *fmt, ...) {
    va_list a;
    va_start(a, fmt);
    vfprintf(stderr, fmt, a);
    va_end(a);
    fputc('\n', stderr);
    if (logf) {
        va_start(a, fmt);
        vfprintf(logf, fmt, a);
        va_end(a);
        fputc('\n', logf);
        fflush(logf);
    }
}

/* fehlende Funktionen nur einmal melden */
void nutgl_missing(const char *name) {
    static const char *seen[512];
    static int n = 0;
    for (int i = 0; i < n; i++)
        if (seen[i] == name) return;
    if (n < 512) seen[n++] = name;
    nutgl_log("NUTGL fehlt: %s", name);
}

/* ---- Standard-Framebuffer (gesetzt von glfw.m) */
EXPORT GLuint nutgl_default_fbo = 0;
static GLuint mapFbo(GLuint fb) { return fb == 0 ? nutgl_default_fbo : fb; }
static GLint unmapFbo(GLint fb) { return (GLuint)fb == nutgl_default_fbo ? 0 : fb; }

/* ===================================================================== Versionsangaben */
static char renderer[256];
const GLubyte *ov_glGetString(GLenum name) {
    switch (name) {
    case GL_VERSION: return (const GLubyte *)"3.3.0 NUTclient iOS (OpenGL ES 3.0)";
    case GL_SHADING_LANGUAGE_VERSION: return (const GLubyte *)"3.30 NUTclient";
    case GL_EXTENSIONS: return (const GLubyte *)"";
    case GL_RENDERER:
        if (!renderer[0]) snprintf(renderer, sizeof renderer, "%s (NUTclient GL)", (const char *)es_glGetString(GL_RENDERER));
        return (const GLubyte *)renderer;
    default: return es_glGetString(name);
    }
}
const GLubyte *ov_glGetStringi(GLenum name, GLuint index) {
    (void)index;
    if (name == GL_EXTENSIONS) return NULL;
    return es_glGetStringi(name, index);
}
static int fakeInt(GLenum p, GLint *out) {
    switch (p) {
    case GL_MAJOR_VERSION: *out = 3; return 1;
    case GL_MINOR_VERSION: *out = 3; return 1;
    case GL_NUM_EXTENSIONS: *out = 0; return 1;
    case GL_CONTEXT_PROFILE_MASK: *out = 1; return 1;   /* Core */
    case GL_CONTEXT_FLAGS: *out = 1; return 1;          /* vorwärtskompatibel */
    }
    return 0;
}
void ov_glGetIntegerv(GLenum pname, GLint *data) {
    if (fakeInt(pname, data)) return;
    es_glGetIntegerv(pname, data);
    if (pname == GL_FRAMEBUFFER_BINDING || pname == GL_READ_FRAMEBUFFER_BINDING) *data = unmapFbo(*data);
}
void ov_glGetInteger64v(GLenum pname, GLint64 *data) {
    GLint v;
    if (fakeInt(pname, &v)) { *data = v; return; }
    es_glGetInteger64v(pname, data);
    if (pname == GL_FRAMEBUFFER_BINDING || pname == GL_READ_FRAMEBUFFER_BINDING) *data = unmapFbo((GLint)*data);
}
void ov_glGetBooleanv(GLenum pname, GLboolean *data) {
    GLint v;
    if (fakeInt(pname, &v)) { *data = v != 0; return; }
    es_glGetBooleanv(pname, data);
}
void ov_glGetFloatv(GLenum pname, GLfloat *data) {
    GLint v;
    if (fakeInt(pname, &v)) { *data = (GLfloat)v; return; }
    es_glGetFloatv(pname, data);
}
void ov_glGetDoublev(GLenum pname, GLdouble *data) {
    GLfloat f[16] = {0};
    ov_glGetFloatv(pname, f);
    *data = f[0];
}

/* ===================================================================== Framebuffer */
void ov_glBindFramebuffer(GLenum target, GLuint fb) { es_glBindFramebuffer(target, mapFbo(fb)); }
GLboolean ov_glIsFramebuffer(GLuint fb) { return fb == 0 ? 1 : es_glIsFramebuffer(fb); }
void ov_glFramebufferTexture(GLenum target, GLenum att, GLuint tex, GLint level) {
    es_glFramebufferTexture2D(target, att, GL_TEXTURE_2D, tex, level);
}
void ov_glFramebufferTexture1D(GLenum target, GLenum att, GLenum textarget, GLuint tex, GLint level) {
    (void)textarget;
    es_glFramebufferTexture2D(target, att, GL_TEXTURE_2D, tex, level);
}
static GLenum mapBuf(GLenum b) {
    switch (b) {
    case GL_BACK: case GL_FRONT: case GL_BACK_LEFT: case GL_FRONT_LEFT: case GL_FRONT_AND_BACK:
    case GL_BACK_RIGHT: case GL_FRONT_RIGHT: return GL_COLOR_ATTACHMENT0;
    }
    return b;
}
static int drawingToDefault(GLenum binding) {
    GLint fb = 0;
    es_glGetIntegerv(binding, &fb);
    return (GLuint)fb == nutgl_default_fbo;
}
void ov_glDrawBuffer(GLenum buf) {
    GLenum b = mapBuf(buf);
    if (b != GL_NONE && b != GL_COLOR_ATTACHMENT0 && drawingToDefault(GL_FRAMEBUFFER_BINDING)) b = GL_COLOR_ATTACHMENT0;
    es_glDrawBuffers(1, &b);
}
void ov_glDrawBuffers(GLsizei n, const GLenum *bufs) {
    GLenum m[16];
    if (n > 16) n = 16;
    for (int i = 0; i < n; i++) m[i] = mapBuf(bufs[i]);
    es_glDrawBuffers(n, m);
}
void ov_glReadBuffer(GLenum src) { es_glReadBuffer(mapBuf(src)); }

/* ===================================================================== Zustände */
static int esCap(GLenum c) {
    switch (c) {
    case 0x0BE2: case 0x0B44: case 0x0B71: case 0x0BD0: case 0x8037: case 0x8D69:
    case 0x8C89: case 0x809E: case 0x80A0: case 0x0C11: case 0x0B90: return 1;
    }
    return 0;
}
void ov_glEnable(GLenum cap) {
    if (cap == GL_PRIMITIVE_RESTART) cap = GL_PRIMITIVE_RESTART_FIXED_INDEX;
    if (esCap(cap)) es_glEnable(cap);
}
void ov_glDisable(GLenum cap) {
    if (cap == GL_PRIMITIVE_RESTART) cap = GL_PRIMITIVE_RESTART_FIXED_INDEX;
    if (esCap(cap)) es_glDisable(cap);
}
GLboolean ov_glIsEnabled(GLenum cap) { return esCap(cap) ? es_glIsEnabled(cap) : 0; }
void ov_glEnablei(GLenum cap, GLuint i) { if (i == 0) ov_glEnable(cap); }
void ov_glDisablei(GLenum cap, GLuint i) { if (i == 0) ov_glDisable(cap); }
void ov_glColorMaski(GLuint i, GLboolean r, GLboolean g, GLboolean b, GLboolean a) { if (i == 0) es_glColorMask(r, g, b, a); }
void ov_glClearDepth(GLdouble d) { es_glClearDepthf((GLfloat)d); }
void ov_glDepthRange(GLdouble n, GLdouble f) { es_glDepthRangef((GLfloat)n, (GLfloat)f); }
void ov_glPolygonMode(GLenum face, GLenum mode) { (void)face; (void)mode; }
void ov_glLogicOp(GLenum op) { (void)op; }
void ov_glPointSize(GLfloat s) { (void)s; }
void ov_glPrimitiveRestartIndex(GLuint i) { (void)i; }
void ov_glProvokingVertex(GLenum m) { (void)m; }
void ov_glClampColor(GLenum t, GLenum c) { (void)t; (void)c; }
void ov_glPixelStorei(GLenum p, GLint v) {
    if (p == GL_UNPACK_SWAP_BYTES || p == GL_UNPACK_LSB_FIRST || p == GL_PACK_SWAP_BYTES || p == GL_PACK_LSB_FIRST) return;
    es_glPixelStorei(p, v);
}

/* ===================================================================== Texturen */
static int texParamOk(GLenum p) { return p != GL_TEXTURE_LOD_BIAS && p != GL_TEXTURE_BORDER_COLOR; }
static GLint wrap(GLint v) { return (v == GL_CLAMP_TO_BORDER || v == GL_CLAMP) ? GL_CLAMP_TO_EDGE : v; }
void ov_glTexParameteri(GLenum t, GLenum p, GLint v) { if (texParamOk(p)) es_glTexParameteri(t, p, wrap(v)); }
void ov_glTexParameterf(GLenum t, GLenum p, GLfloat v) { if (texParamOk(p)) es_glTexParameterf(t, p, (GLfloat)wrap((GLint)v)); }
void ov_glTexParameteriv(GLenum t, GLenum p, const GLint *v) { if (texParamOk(p)) es_glTexParameteri(t, p, wrap(v[0])); }
void ov_glTexParameterfv(GLenum t, GLenum p, const GLfloat *v) { if (texParamOk(p)) es_glTexParameterf(t, p, v[0]); }
void ov_glSamplerParameteri(GLuint s, GLenum p, GLint v) { if (texParamOk(p)) es_glSamplerParameteri(s, p, wrap(v)); }
void ov_glSamplerParameterf(GLuint s, GLenum p, GLfloat v) { if (texParamOk(p)) es_glSamplerParameterf(s, p, v); }

/* Desktop-Formate → gültige ES-3-Kombinationen (Format, Typ, internes Format) */
static void fixFormat(GLint *internal, GLenum *format, GLenum *type) {
    if (*type == GL_UNSIGNED_INT_8_8_8_8_REV) *type = GL_UNSIGNED_BYTE;
    switch (*internal) {
    case GL_RED: if (*type == GL_UNSIGNED_BYTE) *internal = GL_R8; break;
    case GL_RG: if (*type == GL_UNSIGNED_BYTE) *internal = GL_RG8; break;
    case GL_RGBA: if (*type == GL_UNSIGNED_BYTE) *internal = GL_RGBA8; break;
    case GL_RGB: if (*type == GL_UNSIGNED_BYTE) *internal = GL_RGB8; break;
    case GL_DEPTH_COMPONENT:
    case GL_DEPTH_COMPONENT32:
        if (*type == GL_FLOAT) *internal = GL_DEPTH_COMPONENT32F;
        else { *internal = GL_DEPTH_COMPONENT24; *type = GL_UNSIGNED_INT; }
        break;
    case GL_DEPTH_COMPONENT24: *type = GL_UNSIGNED_INT; break;
    case GL_DEPTH_STENCIL: *internal = GL_DEPTH24_STENCIL8; *type = GL_UNSIGNED_INT_24_8; break;
    }
    if (*format == GL_DEPTH_COMPONENT && *internal == GL_DEPTH_COMPONENT32F) *type = GL_FLOAT;
}
/* BGRA-Daten in RGBA umdrehen (gibt einen neuen Puffer zurück oder NULL) */
static void *swizzle(GLenum *format, GLenum type, GLsizei w, GLsizei h, const void *px) {
    if (*format != GL_BGRA && *format != GL_BGR) return NULL;
    int n = *format == GL_BGRA ? 4 : 3;
    *format = n == 4 ? GL_RGBA : GL_RGB;
    if (!px || type != GL_UNSIGNED_BYTE) return NULL;
    GLint pbo = 0;
    es_glGetIntegerv(0x88EF /* PIXEL_UNPACK_BUFFER_BINDING */, &pbo);
    if (pbo) return NULL;                       /* Daten liegen im Puffer – nichts zu tun */
    size_t len = (size_t)w * h * n;
    unsigned char *d = malloc(len);
    const unsigned char *s = px;
    for (size_t i = 0; i < len; i += n) { d[i] = s[i + 2]; d[i + 1] = s[i + 1]; d[i + 2] = s[i]; if (n == 4) d[i + 3] = s[i + 3]; }
    return d;
}
void ov_glTexImage2D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLint border, GLenum format, GLenum type, const void *px) {
    fixFormat(&internal, &format, &type);
    void *tmp = swizzle(&format, type, w, h, px);
    es_glTexImage2D(target, level, internal, w, h, border, format, type, tmp ? tmp : px);
    free(tmp);
}
void ov_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, const void *px) {
    if (type == GL_UNSIGNED_INT_8_8_8_8_REV) type = GL_UNSIGNED_BYTE;
    void *tmp = swizzle(&format, type, w, h, px);
    es_glTexSubImage2D(target, level, x, y, w, h, format, type, tmp ? tmp : px);
    free(tmp);
}
void ov_glTexImage1D(GLenum target, GLint level, GLint internal, GLsizei w, GLint border, GLenum format, GLenum type, const void *px) {
    (void)target;
    ov_glTexImage2D(GL_TEXTURE_2D, level, internal, w, 1, border, format, type, px);
}
void ov_glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, void *px) {
    if (type == GL_UNSIGNED_INT_8_8_8_8_REV) type = GL_UNSIGNED_BYTE;
    int bgra = format == GL_BGRA;
    if (bgra) format = GL_RGBA;
    es_glReadPixels(x, y, w, h, format, type, px);
    if (bgra && px && type == GL_UNSIGNED_BYTE) {
        unsigned char *p = px;
        for (size_t i = 0; i < (size_t)w * h * 4; i += 4) { unsigned char t = p[i]; p[i] = p[i + 2]; p[i + 2] = t; }
    }
}
/* glGetTexImage gibt es in ES nicht: Textur an einen Hilfs-Framebuffer hängen und auslesen */
void ov_glGetTexImage(GLenum target, GLint level, GLenum format, GLenum type, void *px) {
    GLint tex = 0, oldRead = 0, w = 0, h = 0;
    (void)target;
    es_glGetIntegerv(0x8069 /* TEXTURE_BINDING_2D */, &tex);
    es_glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &oldRead);
    static GLuint fbo = 0;
    if (!fbo) es_glGenFramebuffers(1, &fbo);
    es_glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
    es_glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, (GLuint)tex, level);
    /* Größe: aus dem Viewport-Trick nicht ermittelbar → über die Mip-Stufe des gebundenen Bildes */
    extern void nutgl_tex_size(GLuint tex, GLint level, GLint *w, GLint *h);
    nutgl_tex_size((GLuint)tex, level, &w, &h);
    if (w > 0 && h > 0) ov_glReadPixels(0, 0, w, h, format, type, px);
    es_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)oldRead);
}
/* Texturgrößen merken (für glGetTexImage / glGetTexLevelParameteriv) */
#define MAXTEX 65536
static GLint texW[MAXTEX], texH[MAXTEX];
void nutgl_tex_size(GLuint tex, GLint level, GLint *w, GLint *h) {
    if (tex < MAXTEX) { *w = texW[tex] >> level; *h = texH[tex] >> level; if (*w < 1) *w = 1; if (*h < 1) *h = 1; }
}
static void rememberSize(GLint level, GLsizei w, GLsizei h) {
    if (level != 0) return;
    GLint tex = 0;
    es_glGetIntegerv(0x8069, &tex);
    if (tex > 0 && tex < MAXTEX) { texW[tex] = w; texH[tex] = h; }
}
void ov_glTexStorage2D(GLenum target, GLsizei levels, GLenum internal, GLsizei w, GLsizei h) {
    GLint in = (GLint)internal; GLenum f = 0, t = 0;
    fixFormat(&in, &f, &t);
    es_glTexStorage2D(target, levels, (GLenum)in, w, h);
    rememberSize(0, w, h);
}
void ov_glGetTexLevelParameteriv(GLenum target, GLint level, GLenum p, GLint *v) {
    GLint tex = 0, w = 0, h = 0;
    (void)target;
    es_glGetIntegerv(0x8069, &tex);
    nutgl_tex_size((GLuint)tex, level, &w, &h);
    if (p == 0x1000 /* WIDTH */) *v = w;
    else if (p == 0x1001 /* HEIGHT */) *v = h;
    else if (p == 0x1003 /* INTERNAL_FORMAT */) *v = GL_RGBA8;
    else *v = 0;
}

/* ===================================================================== Puffer */
static void refreshBufTex(void);
static GLenum bufTarget(GLenum t); /* siehe „Puffer-Texturen“ */
void *ov_glMapBufferRange(GLenum target, GLintptr off, GLsizeiptr len, GLbitfield access);
void *ov_glMapBuffer(GLenum target, GLenum access) {
    GLint size = 0;
    es_glGetBufferParameteriv(bufTarget(target), GL_BUFFER_SIZE, &size);
    GLbitfield bits = access == GL_READ_ONLY ? GL_MAP_READ_BIT : access == GL_WRITE_ONLY ? GL_MAP_WRITE_BIT : (GL_MAP_READ_BIT | GL_MAP_WRITE_BIT);
    return ov_glMapBufferRange(target, 0, size, bits);
}
void ov_glGetBufferSubData(GLenum target, GLintptr off, GLsizeiptr size, void *data) {
    void *p = es_glMapBufferRange(bufTarget(target), off, size, GL_MAP_READ_BIT);
    if (p) { memcpy(data, p, (size_t)size); es_glUnmapBuffer(bufTarget(target)); }
}

/* ===================================================================== Abfragen (Zeitmessung gibt es nicht) */
void ov_glQueryCounter(GLuint id, GLenum target) { (void)id; (void)target; }
void ov_glGetQueryObjectiv(GLuint id, GLenum p, GLint *v) {
    GLuint u = 0;
    es_glGetQueryObjectuiv(id, p, &u);
    *v = (GLint)u;
}
void ov_glGetQueryObjecti64v(GLuint id, GLenum p, GLint64 *v) { (void)id; *v = p == GL_QUERY_RESULT_AVAILABLE ? 1 : 0; }
void ov_glGetQueryObjectui64v(GLuint id, GLenum p, GLuint64 *v) { (void)id; *v = p == GL_QUERY_RESULT_AVAILABLE ? 1 : 0; }

/* ===================================================================== Shader: GLSL 150/330 → GLSL ES 3.00 */
static const char *PRECISION =
    "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler3D;\n"
    "precision highp samplerCube;\nprecision highp sampler2DArray;\nprecision highp sampler2DShadow;\n"
    "precision highp isampler2D;\nprecision highp usampler2D;\n";

char *glsl_fix(const char *src, const char **why); /* glsl_fix.c */
extern int glsl_fix_used_buffer;
/* Puffer-Texturen liegen als 2D-Textur mit BUF_W Texeln je Zeile vor (siehe „Puffer-Texturen“ unten) */
#define BUF_W 4096
static const char *BUF_HELPER = "ivec2 nut_buf(int i) { return ivec2(i & 4095, i >> 12); }\n";

/* Ersetzt alle Vorkommen von „from“ durch „to“ (neuer Speicher) */
static char *replaceAll(char *src, const char *from, const char *to) {
    size_t fl = strlen(from), tl = strlen(to), n = 0;
    for (char *p = strstr(src, from); p; p = strstr(p + fl, from)) n++;
    if (!n) return src;
    char *out = malloc(strlen(src) + n * (tl > fl ? tl - fl : 0) + 1), *o = out, *s = src;
    for (char *p = strstr(s, from); p; p = strstr(s, from)) {
        memcpy(o, s, (size_t)(p - s)); o += p - s;
        memcpy(o, to, tl); o += tl;
        s = p + fl;
    }
    strcpy(o, s);
    free(src);
    return out;
}

static char *translate(const char *in) {
    /* Versionszeile + #extension-Zeilen raus, Rest übernehmen */
    size_t len = strlen(in);
    char *body = malloc(len + 1), *b = body;
    const char *p = in;
    while (*p) {
        const char *e = strchr(p, '\n');
        size_t l = e ? (size_t)(e - p + 1) : strlen(p);
        const char *q = p;
        while (*q == ' ' || *q == '\t') q++;
        if (!strncmp(q, "#version", 8) || !strncmp(q, "#extension", 10)) { p += l; continue; }
        memcpy(b, p, l); b += l;
        p += l;
    }
    *b = 0;
    body = replaceAll(body, "noperspective ", "");
    body = replaceAll(body, "texture2D(", "texture(");
    /* Typen prüfen + fehlende Umwandlungen einsetzen (glsl_fix.c) */
    const char *why = NULL;
    char *fixed = glsl_fix(body, &why);
    if (fixed) { free(body); body = fixed; }
    else nutgl_log("NUTGL Shader nicht umgeschrieben: %s", why ? why : "?");
    const char *helper = fixed && glsl_fix_used_buffer ? BUF_HELPER : "";
    size_t hl = strlen("#version 300 es\n") + strlen(PRECISION) + strlen(helper);
    char *out = malloc(hl + strlen(body) + 1);
    strcpy(out, "#version 300 es\n");
    strcat(out, PRECISION);
    strcat(out, helper);
    strcat(out, body);
    free(body);
    return out;
}

void ov_glShaderSource(GLuint shader, GLsizei count, const GLchar *const *strs, const GLint *lens) {
    size_t total = 0;
    for (int i = 0; i < count; i++) total += lens && lens[i] >= 0 ? (size_t)lens[i] : strlen(strs[i]);
    char *all = malloc(total + 1), *a = all;
    for (int i = 0; i < count; i++) {
        size_t l = lens && lens[i] >= 0 ? (size_t)lens[i] : strlen(strs[i]);
        memcpy(a, strs[i], l); a += l;
    }
    *a = 0;
    char *es = translate(all);
    free(all);
    const GLchar *one = es;
    es_glShaderSource(shader, 1, &one, NULL);
    free(es);
}

void ov_glCompileShader(GLuint shader) {
    es_glCompileShader(shader);
    GLint ok = 0;
    es_glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char logbuf[4096] = {0}, src[16384] = {0};
        GLsizei n = 0;
        es_glGetShaderInfoLog(shader, sizeof logbuf - 1, &n, logbuf);
        es_glGetShaderSource(shader, sizeof src - 1, &n, src);
        nutgl_log("NUTGL Shader-Fehler:\n%s\n--- Quelle ---\n%s\n-------------", logbuf, src);
    }
}
void ov_glLinkProgram(GLuint prog) {
    es_glLinkProgram(prog);
    GLint ok = 0;
    es_glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) {
        char logbuf[4096] = {0};
        GLsizei n = 0;
        es_glGetProgramInfoLog(prog, sizeof logbuf - 1, &n, logbuf);
        nutgl_log("NUTGL Link-Fehler: %s", logbuf);
    }
}
void ov_glBindFragDataLocation(GLuint prog, GLuint color, const GLchar *name) { (void)prog; (void)color; (void)name; }

/* ===================================================================== Zeichnen mit baseVertex
 * ES 3.0 kennt kein baseVertex. Wir merken uns je Vertex-Array die Attribut-Zeiger und verschieben sie
 * für den Aufruf um baseVertex × Schrittweite.                                                          */
typedef struct { int set, integer; GLint size; GLenum type; GLboolean norm; GLsizei stride; uintptr_t off; GLuint buf; } Attr;
#define MAXVAO 4096
#define MAXATTR 16
static Attr attrs[MAXVAO][MAXATTR];
static GLuint curVao = 0, curArrayBuf = 0;

void ov_glBindVertexArray(GLuint vao) { curVao = vao; es_glBindVertexArray(vao); }
void ov_glBindBuffer(GLenum target, GLuint buf) {
    if (target == GL_ARRAY_BUFFER) curArrayBuf = buf;
    es_glBindBuffer(bufTarget(target), buf);
}
static int typeSize(GLenum t) {
    switch (t) {
    case 0x1400: case 0x1401: return 1;            /* BYTE, UNSIGNED_BYTE */
    case 0x1402: case 0x1403: case 0x140B: return 2; /* SHORT, UNSIGNED_SHORT, HALF_FLOAT */
    default: return 4;
    }
}
static void remember(GLuint i, int integer, GLint size, GLenum type, GLboolean norm, GLsizei stride, const void *ptr) {
    if (curVao >= MAXVAO || i >= MAXATTR) return;
    Attr *a = &attrs[curVao][i];
    a->set = 1; a->integer = integer; a->size = size; a->type = type; a->norm = norm;
    a->stride = stride ? stride : size * typeSize(type);
    a->off = (uintptr_t)ptr; a->buf = curArrayBuf;
}
void ov_glVertexAttribPointer(GLuint i, GLint size, GLenum type, GLboolean norm, GLsizei stride, const void *ptr) {
    remember(i, 0, size, type, norm, stride, ptr);
    es_glVertexAttribPointer(i, size, type, norm, stride, ptr);
}
void ov_glVertexAttribIPointer(GLuint i, GLint size, GLenum type, GLsizei stride, const void *ptr) {
    remember(i, 1, size, type, 0, stride, ptr);
    es_glVertexAttribIPointer(i, size, type, stride, ptr);
}
static void shiftAttrs(GLint base) {
    if (curVao >= MAXVAO) return;
    GLuint keep = curArrayBuf;
    for (int i = 0; i < MAXATTR; i++) {
        Attr *a = &attrs[curVao][i];
        if (!a->set) continue;
        es_glBindBuffer(GL_ARRAY_BUFFER, a->buf);
        const void *p = (const void *)(a->off + (uintptr_t)((intptr_t)base * a->stride));
        if (a->integer) es_glVertexAttribIPointer(i, a->size, a->type, a->stride, p);
        else es_glVertexAttribPointer(i, a->size, a->type, a->norm, a->stride, p);
    }
    es_glBindBuffer(GL_ARRAY_BUFFER, keep);
}
void ov_glDrawElementsBaseVertex(GLenum mode, GLsizei count, GLenum type, const void *idx, GLint base) {
    refreshBufTex();
    if (base) shiftAttrs(base);
    es_glDrawElements(mode, count, type, idx);
    if (base) shiftAttrs(0);
}
void ov_glDrawRangeElementsBaseVertex(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void *idx, GLint base) {
    (void)start; (void)end;
    ov_glDrawElementsBaseVertex(mode, count, type, idx, base);
}
void ov_glDrawElementsInstancedBaseVertex(GLenum mode, GLsizei count, GLenum type, const void *idx, GLsizei inst, GLint base) {
    refreshBufTex();
    if (base) shiftAttrs(base);
    es_glDrawElementsInstanced(mode, count, type, idx, inst);
    if (base) shiftAttrs(0);
}
void ov_glMultiDrawElementsBaseVertex(GLenum mode, const GLsizei *count, GLenum type, const void *const *idx, GLsizei n, const GLint *base) {
    for (int i = 0; i < n; i++) ov_glDrawElementsBaseVertex(mode, count[i], type, idx[i], base ? base[i] : 0);
}
void ov_glMultiDrawElements(GLenum mode, const GLsizei *count, GLenum type, const void *const *idx, GLsizei n) {
    for (int i = 0; i < n; i++) es_glDrawElements(mode, count[i], type, idx[i]);
}
void ov_glMultiDrawArrays(GLenum mode, const GLint *first, const GLsizei *count, GLsizei n) {
    for (int i = 0; i < n; i++) es_glDrawArrays(mode, first[i], count[i]);
}

/* ===================================================================== Puffer-Texturen
 * ES 3.00 kennt weder GL_TEXTURE_BUFFER noch samplerBuffer. Minecraft nutzt sie für die Wolken.
 * Nachbau: Puffer-Ziel TEXTURE_BUFFER → COPY_WRITE_BUFFER; die Textur wird als 2D-Textur (BUF_W Texel je Zeile)
 * angelegt und mit dem Pufferinhalt gefüllt – beim glTexBuffer und vor jedem Zeichnen, wenn der Puffer
 * inzwischen geändert wurde. Der Shader liest per nut_buf(i) (glsl_fix.c).                                  */
#define GL_TEXTURE_BUFFER 0x8C2A
#define GL_COPY_READ_BUFFER 0x8F36
#define GL_COPY_WRITE_BUFFER 0x8F37
#define GL_PIXEL_UNPACK_BUFFER 0x88EC
#define GL_PIXEL_UNPACK_BUFFER_BINDING 0x88EF
#define GL_TEXTURE_BINDING_2D 0x8069
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_UNPACK_ROW_LENGTH 0x0CF2
#define GL_UNPACK_SKIP_ROWS 0x0CF3
#define GL_UNPACK_SKIP_PIXELS 0x0CF4
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_NEAREST 0x2600
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_ELEMENT_ARRAY_BUFFER_BINDING 0x8895
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_UNIFORM_BUFFER_BINDING 0x8A28
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ED

static GLenum bufTarget(GLenum t) { return t == GL_TEXTURE_BUFFER ? GL_COPY_WRITE_BUFFER : t; }
static GLenum bindingOf(GLenum t) {
    switch (bufTarget(t)) {
    case GL_ARRAY_BUFFER: return GL_ARRAY_BUFFER_BINDING;
    case GL_ELEMENT_ARRAY_BUFFER: return GL_ELEMENT_ARRAY_BUFFER_BINDING;
    case GL_UNIFORM_BUFFER: return GL_UNIFORM_BUFFER_BINDING;
    case GL_PIXEL_UNPACK_BUFFER: return GL_PIXEL_UNPACK_BUFFER_BINDING;
    case GL_PIXEL_PACK_BUFFER: return GL_PIXEL_PACK_BUFFER_BINDING;
    case GL_COPY_READ_BUFFER: return GL_COPY_READ_BUFFER;
    case GL_COPY_WRITE_BUFFER: return GL_COPY_WRITE_BUFFER;
    default: return 0;
    }
}
static GLuint boundBuffer(GLenum t) {
    GLenum b = bindingOf(t);
    GLint v = 0;
    if (b) es_glGetIntegerv(b, &v);
    return (GLuint)v;
}

typedef struct { GLuint tex, buf; GLenum fmt; GLintptr off; GLsizeiptr len; int dirty; } BufTex;
#define MAXBUFTEX 64
static BufTex bufTex[MAXBUFTEX];
static int nBufTex, anyDirty;
static GLuint curBufTexName;

/* internes Format → (Format, Typ), Rückgabe = Bytes je Texel */
static int texelInfo(GLenum f, GLenum *fmt, GLenum *type) {
    const GLenum RI = 0x8D94, RGI = 0x8228, RGBAI = 0x8D99;
    switch (f) {
    case 0x8229: *fmt = GL_RED; *type = GL_UNSIGNED_BYTE; return 1;   /* R8 */
    case 0x8231: *fmt = RI; *type = 0x1400; return 1;                  /* R8I */
    case 0x8232: *fmt = RI; *type = GL_UNSIGNED_BYTE; return 1;        /* R8UI */
    case 0x8233: *fmt = RI; *type = 0x1402; return 2;                  /* R16I */
    case 0x8234: *fmt = RI; *type = 0x1403; return 2;                  /* R16UI */
    case 0x8235: *fmt = RI; *type = 0x1404; return 4;                  /* R32I */
    case 0x8236: *fmt = RI; *type = GL_UNSIGNED_INT; return 4;         /* R32UI */
    case 0x822E: *fmt = GL_RED; *type = GL_FLOAT; return 4;            /* R32F */
    case 0x822B: *fmt = GL_RG; *type = GL_UNSIGNED_BYTE; return 2;     /* RG8 */
    case 0x8230: *fmt = GL_RG; *type = GL_FLOAT; return 8;             /* RG32F */
    case 0x823B: *fmt = RGI; *type = 0x1404; return 8;                 /* RG32I */
    case 0x823C: *fmt = RGI; *type = GL_UNSIGNED_INT; return 8;        /* RG32UI */
    case 0x8815: *fmt = GL_RGB; *type = GL_FLOAT; return 12;           /* RGB32F */
    case GL_RGBA8: *fmt = GL_RGBA; *type = GL_UNSIGNED_BYTE; return 4;
    case 0x8D8E: *fmt = RGBAI; *type = 0x1400; return 4;               /* RGBA8I */
    case 0x8D7C: *fmt = RGBAI; *type = GL_UNSIGNED_BYTE; return 4;     /* RGBA8UI */
    case 0x8814: *fmt = GL_RGBA; *type = GL_FLOAT; return 16;          /* RGBA32F */
    case 0x8D82: *fmt = RGBAI; *type = 0x1404; return 16;              /* RGBA32I */
    case 0x8D70: *fmt = RGBAI; *type = GL_UNSIGNED_INT; return 16;     /* RGBA32UI */
    default: return 0;
    }
}

static void uploadBufTex(BufTex *t) {
    t->dirty = 0;
    GLenum fmt, type;
    int bpt = texelInfo(t->fmt, &fmt, &type);
    if (!bpt || !t->buf) { nutgl_log("NUTGL Puffer-Textur: Format 0x%x nicht unterstützt", t->fmt); return; }
    GLint keepRead = 0, keepTex = 0, keepUnpack = 0, align = 4, rowLen = 0, skipRows = 0, skipPix = 0;
    es_glGetIntegerv(GL_COPY_READ_BUFFER, &keepRead);
    es_glGetIntegerv(GL_TEXTURE_BINDING_2D, &keepTex);
    es_glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &keepUnpack);
    es_glGetIntegerv(GL_UNPACK_ALIGNMENT, &align);
    es_glGetIntegerv(GL_UNPACK_ROW_LENGTH, &rowLen);
    es_glGetIntegerv(GL_UNPACK_SKIP_ROWS, &skipRows);
    es_glGetIntegerv(GL_UNPACK_SKIP_PIXELS, &skipPix);
    es_glBindBuffer(GL_COPY_READ_BUFFER, t->buf);
    GLint size = 0;
    es_glGetBufferParameteriv(GL_COPY_READ_BUFFER, GL_BUFFER_SIZE, &size);
    GLsizeiptr len = t->len > 0 ? t->len : size - t->off;
    if (t->off + len > size) len = size - t->off;
    long n = len > 0 ? (long)(len / bpt) : 0;
    long w = n < BUF_W ? (n > 0 ? n : 1) : BUF_W, h = n > 0 ? (n + BUF_W - 1) / BUF_W : 1;
    unsigned char *pix = calloc((size_t)(w * h), (size_t)bpt);
    if (n > 0) {
        void *src = es_glMapBufferRange(GL_COPY_READ_BUFFER, t->off, len, GL_MAP_READ_BIT);
        if (src) { memcpy(pix, src, (size_t)(n * bpt)); es_glUnmapBuffer(GL_COPY_READ_BUFFER); }
    }
    es_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    es_glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    es_glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    es_glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
    es_glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    es_glBindTexture(GL_TEXTURE_2D, t->tex);
    es_glTexImage2D(GL_TEXTURE_2D, 0, (GLint)t->fmt, (GLsizei)w, (GLsizei)h, 0, fmt, type, pix);
    es_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    es_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    free(pix);
    es_glBindTexture(GL_TEXTURE_2D, (GLuint)keepTex);
    es_glPixelStorei(GL_UNPACK_ALIGNMENT, align);
    es_glPixelStorei(GL_UNPACK_ROW_LENGTH, rowLen);
    es_glPixelStorei(GL_UNPACK_SKIP_ROWS, skipRows);
    es_glPixelStorei(GL_UNPACK_SKIP_PIXELS, skipPix);
    es_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)keepUnpack);
    es_glBindBuffer(GL_COPY_READ_BUFFER, (GLuint)keepRead);
}
static void markDirty(GLuint buf) {
    if (!buf) return;
    for (int i = 0; i < nBufTex; i++) if (bufTex[i].buf == buf) { bufTex[i].dirty = 1; anyDirty = 1; }
}
static void refreshBufTex(void) {
    if (!anyDirty) return;
    anyDirty = 0;
    for (int i = 0; i < nBufTex; i++) if (bufTex[i].dirty) uploadBufTex(&bufTex[i]);
}

void ov_glBindTexture(GLenum target, GLuint tex) {
    if (target == GL_TEXTURE_BUFFER) { curBufTexName = tex; es_glBindTexture(GL_TEXTURE_2D, tex); return; }
    es_glBindTexture(target, tex);
}
static void texBuffer(GLenum fmt, GLuint buf, GLintptr off, GLsizeiptr len) {
    GLuint tex = curBufTexName;
    BufTex *t = NULL;
    for (int i = 0; i < nBufTex; i++) if (bufTex[i].tex == tex) t = &bufTex[i];
    if (!t) {
        if (nBufTex >= MAXBUFTEX) { nutgl_log("NUTGL zu viele Puffer-Texturen"); return; }
        t = &bufTex[nBufTex++];
    }
    t->tex = tex; t->buf = buf; t->fmt = fmt; t->off = off; t->len = len;
    uploadBufTex(t);
}
void ov_glTexBuffer(GLenum target, GLenum fmt, GLuint buf) { (void)target; texBuffer(fmt, buf, 0, 0); }
void ov_glTexBufferRange(GLenum target, GLenum fmt, GLuint buf, GLintptr off, GLsizeiptr len) { (void)target; texBuffer(fmt, buf, off, len); }

void ov_glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
    es_glBufferData(bufTarget(target), size, data, usage);
    markDirty(boundBuffer(target));
}
void ov_glBufferSubData(GLenum target, GLintptr off, GLsizeiptr size, const void *data) {
    es_glBufferSubData(bufTarget(target), off, size, data);
    markDirty(boundBuffer(target));
}
void *ov_glMapBufferRange(GLenum target, GLintptr off, GLsizeiptr len, GLbitfield access) {
    return es_glMapBufferRange(bufTarget(target), off, len, access);
}
GLboolean ov_glUnmapBuffer(GLenum target) {
    markDirty(boundBuffer(target));
    return es_glUnmapBuffer(bufTarget(target));
}
void ov_glFlushMappedBufferRange(GLenum target, GLintptr off, GLsizeiptr len) {
    es_glFlushMappedBufferRange(bufTarget(target), off, len);
}
void ov_glGetBufferParameteriv(GLenum target, GLenum p, GLint *v) { es_glGetBufferParameteriv(bufTarget(target), p, v); }
void ov_glCopyBufferSubData(GLenum r, GLenum w, GLintptr ro, GLintptr wo, GLsizeiptr n) {
    es_glCopyBufferSubData(bufTarget(r), bufTarget(w), ro, wo, n);
    markDirty(boundBuffer(w));
}
void ov_glBindBufferBase(GLenum target, GLuint i, GLuint buf) { es_glBindBufferBase(bufTarget(target), i, buf); }
void ov_glBindBufferRange(GLenum target, GLuint i, GLuint buf, GLintptr off, GLsizeiptr n) { es_glBindBufferRange(bufTarget(target), i, buf, off, n); }

/* Zeichnen: vorher geänderte Puffer-Texturen nachladen */
void ov_glDrawArrays(GLenum mode, GLint first, GLsizei count) { refreshBufTex(); es_glDrawArrays(mode, first, count); }
void ov_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *idx) { refreshBufTex(); es_glDrawElements(mode, count, type, idx); }
void ov_glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei n) { refreshBufTex(); es_glDrawArraysInstanced(mode, first, count, n); }
void ov_glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *idx, GLsizei n) { refreshBufTex(); es_glDrawElementsInstanced(mode, count, type, idx, n); }
void ov_glDrawRangeElements(GLenum mode, GLuint s, GLuint e, GLsizei count, GLenum type, const void *idx) { refreshBufTex(); es_glDrawRangeElements(mode, s, e, count, type, idx); }
