/* NUTclient iOS – eigener GLSL-Umschreiber: Desktop-GLSL (150/330) → GLSL ES 3.00.
 *
 * GLSL ES kennt keine stillen Typumwandlungen (int → float), Minecrafts Shader verlassen sich aber darauf
 * („floor(x * 16) / 15“, „uv / 256.0“ mit ivec2 uv, „textureLod(s, uv, MipMapLevel)“ mit int-Level …).
 * Dieser Umschreiber liest den Shader (Variablen, Funktionen, Structs, Uniform-Blöcke), bestimmt für jeden
 * Ausdruck den Typ und setzt float(…)/vecN(…)/uint(…) genau dort ein, wo Desktop-GLSL still umwandeln würde.
 * Außerdem:
 *   - lokale Variablen, die wie eine Funktion heißen („vec3 notGamma = notGamma(color)“), werden umbenannt
 *   - samplerBuffer/isamplerBuffer/usamplerBuffer (gibt es in ES 3.00 nicht) → *sampler2D,
 *     texelFetch(buf, i) → texelFetch(buf, nut_buf(i), 0)  (Zeilen à 4096 Texel, siehe gl_overrides.c)
 * Unbekanntes bleibt unverändert; wenn etwas gar nicht passt, wird der Shader unverändert zurückgegeben.
 */
#include <ctype.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int glsl_fix_used_buffer; /* 1 = Hilfsfunktion nut_buf wird gebraucht */

/* ------------------------------------------------------------------ Speicher (eine Arena je Aufruf) */
typedef struct Blk { struct Blk *next; size_t used, cap; char data[]; } Blk;
static Blk *arena;
static void *amem(size_t n) {
    n = (n + 7) & ~(size_t)7;
    if (!arena || arena->used + n > arena->cap) {
        size_t c = n > 65536 ? n : 65536;
        Blk *b = malloc(sizeof(Blk) + c);
        b->next = arena; b->used = 0; b->cap = c; arena = b;
    }
    void *p = arena->data + arena->used;
    arena->used += n;
    return p;
}
static void afree(void) { while (arena) { Blk *n = arena->next; free(arena); arena = n; } }
static char *astr(const char *s, size_t n) { char *r = amem(n + 1); memcpy(r, s, n); r[n] = 0; return r; }
static char *cat(int n, ...) {
    va_list ap; size_t len = 0;
    va_start(ap, n); for (int i = 0; i < n; i++) len += strlen(va_arg(ap, const char *)); va_end(ap);
    char *r = amem(len + 1), *o = r;
    va_start(ap, n);
    for (int i = 0; i < n; i++) { const char *s = va_arg(ap, const char *); size_t l = strlen(s); memcpy(o, s, l); o += l; }
    va_end(ap);
    *o = 0;
    return r;
}

/* ------------------------------------------------------------------ Typen */
/* b: f float, i int, u uint, b bool, s Sampler, S Struct, v void, ? unbekannt; n = Zeilen/Vektorlänge, m = Spalten (Matrix) */
typedef struct { char b, n, m, arr; const char *nm; } T;
static const T TUNK = {'?', 1, 0, 0, NULL};
static T mk(char b, int n) { T t = {b, (char)n, 0, 0, NULL}; return t; }
static int isInt(T t) { return !t.arr && !t.m && (t.b == 'i' || t.b == 'u'); }

typedef struct { const char *name; int nm; const char *mn[64]; T mt[64]; } St;
static St sts[64];
static int nst;

static int typeOf(const char *s, T *t) {
    *t = mk('?', 1);
    if (!strcmp(s, "float")) { t->b = 'f'; return 1; }
    if (!strcmp(s, "int")) { t->b = 'i'; return 1; }
    if (!strcmp(s, "uint")) { t->b = 'u'; return 1; }
    if (!strcmp(s, "bool")) { t->b = 'b'; return 1; }
    if (!strcmp(s, "void")) { t->b = 'v'; return 1; }
    const char *v = NULL; char b = 0;
    if (!strncmp(s, "vec", 3)) { v = s + 3; b = 'f'; }
    else if (!strncmp(s, "ivec", 4)) { v = s + 4; b = 'i'; }
    else if (!strncmp(s, "uvec", 4)) { v = s + 4; b = 'u'; }
    else if (!strncmp(s, "bvec", 4)) { v = s + 4; b = 'b'; }
    if (v && v[0] >= '2' && v[0] <= '4' && !v[1]) { t->b = b; t->n = (char)(v[0] - '0'); return 1; }
    if (!strncmp(s, "mat", 3) && s[3] >= '2' && s[3] <= '4') {
        t->b = 'f';
        if (!s[4]) { t->n = t->m = (char)(s[3] - '0'); return 1; }
        if (s[4] == 'x' && s[5] >= '2' && s[5] <= '4' && !s[6]) { t->m = (char)(s[3] - '0'); t->n = (char)(s[5] - '0'); return 1; }
        return 0;
    }
    if ((!strncmp(s, "sampler", 7) && s[7]) || ((!strncmp(s, "isampler", 8) || !strncmp(s, "usampler", 8)) && s[8])) { t->b = 's'; t->nm = s; return 1; }
    for (int i = 0; i < nst; i++) if (!strcmp(sts[i].name, s)) { t->b = 'S'; t->nm = sts[i].name; return 1; }
    return 0;
}
static const char *tname(char b, int n) {
    static const char *F[] = {"", "float", "vec2", "vec3", "vec4"}, *I[] = {"", "int", "ivec2", "ivec3", "ivec4"},
                      *U[] = {"", "uint", "uvec2", "uvec3", "uvec4"};
    if (n < 1 || n > 4) n = 1;
    return b == 'f' ? F[n] : b == 'u' ? U[n] : I[n];
}

/* ------------------------------------------------------------------ Symbole */
typedef struct { const char *name, *out; T t; int depth; } Sym;
static Sym syms[2048];
static int nsym, depth;
typedef struct { const char *name; T ret; int np; T p[16]; } Fn;
static Fn fns[512];
static int nfn;

static jmp_buf failJmp;
static const char *failWhy;
static void fail(const char *why) { failWhy = why; longjmp(failJmp, 1); }

static void addSym(const char *name, const char *out, T t) {
    if (nsym >= (int)(sizeof syms / sizeof *syms)) fail("zu viele Symbole");
    syms[nsym].name = name; syms[nsym].out = out; syms[nsym].t = t; syms[nsym].depth = depth; nsym++;
}
static Sym *lookup(const char *name) {
    for (int i = nsym - 1; i >= 0; i--) if (!strcmp(syms[i].name, name)) return &syms[i];
    return NULL;
}
static int fnExists(const char *name) {
    for (int i = 0; i < nfn; i++) if (!strcmp(fns[i].name, name)) return 1;
    return 0;
}
static void pushScope(void) { depth++; }
static void popScope(void) {
    while (nsym && syms[nsym - 1].depth >= depth) nsym--;
    if (depth > 0) depth--;
}

/* ------------------------------------------------------------------ Tokens */
enum { K_END, K_ID, K_NUM, K_OP, K_PP };
typedef struct { int k; const char *tx; const char *ws; } Tok; /* tx/ws: eigene Kopien */
static Tok *tk;
static int ntk, cap_tk, p;
static const char *tailWs; /* Leerraum/Kommentare am Ende */

static void tokenize(const char *s) {
    ntk = 0;
    const char *wsStart = s;
    int lineStart = 1;
    while (*s) {
        /* Leerraum + Kommentare sammeln */
        if (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n' || *s == '\f' || *s == '\v') { if (*s == '\n') lineStart = 1; s++; continue; }
        if (s[0] == '/' && s[1] == '/') { while (*s && *s != '\n') s++; continue; }
        if (s[0] == '/' && s[1] == '*') { const char *e = strstr(s + 2, "*/"); s = e ? e + 2 : s + strlen(s); continue; }
        if (ntk + 1 >= cap_tk) { cap_tk = cap_tk ? cap_tk * 2 : 1024; tk = realloc(tk, sizeof(Tok) * (size_t)cap_tk); }
        Tok *t = &tk[ntk++];
        t->ws = astr(wsStart, (size_t)(s - wsStart));
        const char *b = s;
        if (*s == '#' && lineStart) {
            while (*s && *s != '\n') { if (*s == '\\' && s[1] == '\n') s++; s++; }
            t->k = K_PP;
        } else if (isalpha((unsigned char)*s) || *s == '_') {
            while (isalnum((unsigned char)*s) || *s == '_') s++;
            t->k = K_ID;
        } else if (isdigit((unsigned char)*s) || (*s == '.' && isdigit((unsigned char)s[1]))) {
            int hex = s[0] == '0' && (s[1] == 'x' || s[1] == 'X');
            s += hex ? 2 : 0;
            while (isalnum((unsigned char)*s) || *s == '.' ||
                   (!hex && (*s == '+' || *s == '-') && (s[-1] == 'e' || s[-1] == 'E'))) s++;
            t->k = K_NUM;
        } else {
            static const char *ops[] = {"<<=", ">>=", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "^^",
                                        "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", NULL};
            int l = 1;
            for (int i = 0; ops[i]; i++) if (!strncmp(s, ops[i], strlen(ops[i]))) { l = (int)strlen(ops[i]); break; }
            s += l;
            t->k = K_OP;
        }
        t->tx = astr(b, (size_t)(s - b));
        lineStart = 0;
        wsStart = s;
    }
    tailWs = astr(wsStart, strlen(wsStart));
    if (ntk + 1 >= cap_tk) { cap_tk = cap_tk ? cap_tk * 2 : 1024; tk = realloc(tk, sizeof(Tok) * (size_t)cap_tk); }
    tk[ntk].k = K_END; tk[ntk].tx = ""; tk[ntk].ws = "";
}
static Tok *cur(void) { return &tk[p]; }
static Tok *at(int i) { return &tk[p + i < ntk ? p + i : ntk]; }
static int isop(const char *o) { return tk[p].k == K_OP && !strcmp(tk[p].tx, o); }
static int isid(const char *o) { return tk[p].k == K_ID && !strcmp(tk[p].tx, o); }
static char *full(Tok *t) { return cat(2, t->ws, t->tx); }

/* ------------------------------------------------------------------ Ausgabe */
static char *out;
static size_t outLen, outCap;
static void emit(const char *s) {
    size_t l = strlen(s);
    if (outLen + l + 1 > outCap) { outCap = (outLen + l + 1) * 2; out = realloc(out, outCap); }
    memcpy(out + outLen, s, l); outLen += l; out[outLen] = 0;
}
static void emitTok(void) { emit(full(cur())); p++; }
static void expectOp(const char *o) { if (!isop(o)) fail(o); emitTok(); }
static char *takeOp(const char *o) { if (!isop(o)) fail(o); char *s = full(cur()); p++; return s; }

/* ------------------------------------------------------------------ Ausdrücke */
typedef struct { char *s; T t; } Ex;

static Ex wrap(Ex e, char b) {
    if (e.t.arr || e.t.m) return e;
    size_t w = 0;
    while (e.s[w] == ' ' || e.s[w] == '\t' || e.s[w] == '\n' || e.s[w] == '\r') w++;
    e.s = cat(5, astr(e.s, w), tname(b, e.t.n), "(", e.s + w, ")");
    e.t.b = b;
    return e;
}
static Ex convTo(Ex e, T t) {
    if (t.arr || e.t.arr) return e;
    if (t.b == 'f' && isInt(e.t)) return wrap(e, 'f');
    if (t.b == 'u' && e.t.b == 'i' && !e.t.m) return wrap(e, 'u');
    return e;
}

static Ex parseExpr(void);
static Ex parseAssign(void);

static int binPrec(void) {
    Tok *t = cur();
    if (t->k != K_OP) return 0;
    const char *o = t->tx;
    if (!strcmp(o, "||")) return 1;
    if (!strcmp(o, "^^")) return 2;
    if (!strcmp(o, "&&")) return 3;
    if (!strcmp(o, "|")) return 4;
    if (!strcmp(o, "^")) return 5;
    if (!strcmp(o, "&")) return 6;
    if (!strcmp(o, "==") || !strcmp(o, "!=")) return 7;
    if (!strcmp(o, "<") || !strcmp(o, ">") || !strcmp(o, "<=") || !strcmp(o, ">=")) return 8;
    if (!strcmp(o, "<<") || !strcmp(o, ">>")) return 9;
    if (!strcmp(o, "+") || !strcmp(o, "-")) return 10;
    if (!strcmp(o, "*") || !strcmp(o, "/") || !strcmp(o, "%")) return 11;
    return 0;
}

static T resType(T a, T b, int mul) {
    if (a.b == '?' || b.b == '?' || a.arr || b.arr) return TUNK;
    if (mul && a.m && b.m) { T r = mk('f', a.n); r.m = b.m; return r; }
    if (mul && a.m && !b.m && b.n > 1) return mk('f', a.n);
    if (mul && !a.m && a.n > 1 && b.m) return mk('f', b.m);
    if (a.m) return a;
    if (b.m) return b;
    return mk(a.b == 'f' || b.b == 'f' ? 'f' : a.b, a.n > b.n ? a.n : b.n);
}

static Ex binop(Ex a, const char *opFull, const char *op, Ex b, int pr) {
    if (pr >= 4 && pr != 9) {
        if (a.t.b == 'f' && isInt(b.t)) b = wrap(b, 'f');
        else if (b.t.b == 'f' && isInt(a.t)) a = wrap(a, 'f');
        else if (a.t.b == 'u' && b.t.b == 'i' && !b.t.arr) b = wrap(b, 'u');
        else if (b.t.b == 'u' && a.t.b == 'i' && !a.t.arr) a = wrap(a, 'u');
    }
    Ex e;
    e.s = cat(3, a.s, opFull, b.s);
    if (pr <= 3 || pr == 7 || pr == 8) e.t = mk('b', 1);
    else if (pr == 9) e.t = a.t;
    else e.t = resType(a.t, b.t, op[0] == '*');
    return e;
}

static T sampRet(T s, const char *fn) {
    if (s.b != 's' || !s.nm) return TUNK;
    if (!strcmp(fn, "textureSize")) {
        if (strstr(s.nm, "Buffer")) return mk('i', 1);
        return mk('i', strstr(s.nm, "3D") || strstr(s.nm, "Array") ? 3 : 2);
    }
    if (s.nm[0] == 'i') return mk('i', 4);
    if (s.nm[0] == 'u') return mk('u', 4);
    if (strstr(s.nm, "Shadow")) return mk('f', 1);
    return mk('f', 4);
}

static int inList(const char *n, const char *const *l) {
    for (; *l; l++) if (!strcmp(n, *l)) return 1;
    return 0;
}

/* Aufruf zusammenbauen: name ( a0 sep0 a1 … ) */
static char *joinCall(const char *head, Ex *a, char **sep, int na, const char *close) {
    char *s = (char *)head;
    for (int i = 0; i < na; i++) s = cat(3, s, a[i].s, i < na - 1 ? sep[i] : "");
    return cat(2, s, close);
}

static Ex call(const char *head, const char *name, Ex *a, char **sep, int na, const char *close) {
    Ex e; e.t = TUNK;
    /* eigene Funktionen */
    for (int f = 0; f < nfn; f++) {
        Fn *F = &fns[f];
        if (strcmp(F->name, name) || F->np != na) continue;
        int ok = 1;
        for (int i = 0; i < na && ok; i++) {
            T pt = F->p[i], at = a[i].t;
            if (pt.b == '?' || at.b == '?') continue;
            if (pt.b == at.b && pt.n == at.n && pt.m == at.m) continue;
            if (pt.b == 'f' && isInt(at) && pt.n == at.n) continue;
            if (pt.b == at.b && (pt.b == 's' || pt.b == 'S')) continue;
            ok = 0;
        }
        if (!ok) continue;
        for (int i = 0; i < na; i++) a[i] = convTo(a[i], F->p[i]);
        e.s = joinCall(head, a, sep, na, close);
        e.t = F->ret;
        return e;
    }
    static const char *F1[] = {"sin", "cos", "tan", "asin", "acos", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
                               "exp", "log", "exp2", "log2", "sqrt", "inversesqrt", "floor", "ceil", "fract", "round",
                               "roundEven", "trunc", "normalize", "radians", "degrees", "dFdx", "dFdy", "fwidth", NULL};
    static const char *G[] = {"min", "max", "clamp", "mix", "step", "smoothstep", "mod", "pow", "atan", "abs", "sign", NULL};
    static const char *SC[] = {"length", "distance", "dot", "determinant", NULL};
    static const char *VE[] = {"cross", "reflect", "refract", "faceforward", NULL};
    static const char *CMP[] = {"lessThan", "lessThanEqual", "greaterThan", "greaterThanEqual", "equal", "notEqual", NULL};
    static const char *TEX[] = {"texture", "textureProj", "textureLod", "textureOffset", "textureLodOffset", "textureGrad",
                                "textureGradOffset", "textureProjLod", "textureProjOffset", "textureProjLodOffset",
                                "textureProjGrad", NULL};
    int f1 = inList(name, F1), g = inList(name, G), sc = inList(name, SC), ve = inList(name, VE), cmp = inList(name, CMP);
    if (f1 || g || sc || ve || cmp) {
        int anyF = f1 || sc || ve;
        for (int i = 0; i < na; i++) if (a[i].t.b == 'f') anyF = 1;
        int big = 0;
        for (int i = 0; i < na; i++) {
            if (anyF && isInt(a[i].t)) a[i] = wrap(a[i], 'f');
            if (a[i].t.b != 'b' && a[i].t.n > a[big].t.n) big = i;
        }
        int known = 1;
        for (int i = 0; i < na; i++) if (a[i].t.b == '?') known = 0;
        e.s = joinCall(head, a, sep, na, close);
        if (!known || !na) e.t = TUNK;
        else if (sc) e.t = mk('f', 1);
        else if (cmp) e.t = mk('b', a[0].t.n);
        else if (f1 || ve) { e.t = a[0].t; e.t.b = 'f'; }
        else e.t = a[big].t;
        return e;
    }
    if (inList(name, TEX) && na >= 2) {
        if (isInt(a[1].t)) a[1] = wrap(a[1], 'f');
        if (na >= 3 && (!strcmp(name, "textureLod") || !strcmp(name, "texture") || !strcmp(name, "textureProj")) && isInt(a[2].t))
            a[2] = wrap(a[2], 'f');
        e.s = joinCall(head, a, sep, na, close);
        e.t = sampRet(a[0].t, name);
        return e;
    }
    if ((!strcmp(name, "texelFetch") || !strcmp(name, "textureSize")) && na >= 1) {
        if (!strcmp(name, "texelFetch") && na == 2 && a[0].t.b == 's' && a[0].t.nm && strstr(a[0].t.nm, "Buffer")) {
            glsl_fix_used_buffer = 1;
            e.s = cat(7, head, a[0].s, sep[0], " nut_buf(", a[1].s, "), 0", close);
        } else e.s = joinCall(head, a, sep, na, close);
        e.t = sampRet(a[0].t, name);
        return e;
    }
    e.s = joinCall(head, a, sep, na, close);
    if (na >= 1) {
        T a0 = a[0].t;
        if (!strcmp(name, "floatBitsToInt")) e.t = mk('i', a0.n);
        else if (!strcmp(name, "floatBitsToUint")) e.t = mk('u', a0.n);
        else if (!strcmp(name, "intBitsToFloat") || !strcmp(name, "uintBitsToFloat")) e.t = mk('f', a0.n);
        else if (!strcmp(name, "any") || !strcmp(name, "all")) e.t = mk('b', 1);
        else if (!strcmp(name, "not")) e.t = a0;
        else if (!strcmp(name, "isnan") || !strcmp(name, "isinf")) e.t = mk('b', a0.n);
        else if (!strcmp(name, "transpose") || !strcmp(name, "inverse") || !strcmp(name, "matrixCompMult")) {
            e.t = a0;
            if (!strcmp(name, "transpose") && a0.m) { e.t.n = a0.m; e.t.m = a0.n; }
        } else if (!strncmp(name, "pack", 4)) e.t = mk('u', 1);
        else if (!strcmp(name, "unpackUnorm2x16") || !strcmp(name, "unpackSnorm2x16") || !strcmp(name, "unpackHalf2x16")) e.t = mk('f', 2);
        else if (!strcmp(name, "unpackUnorm4x8") || !strcmp(name, "unpackSnorm4x8")) e.t = mk('f', 4);
    }
    return e;
}

/* Argumentliste ab „(“ lesen */
static int parseArgs(Ex *a, char **sep, char **open, char **close) {
    *open = takeOp("(");
    int na = 0;
    if (isop(")")) { *close = takeOp(")"); return 0; }
    if (isid("void") && at(1)->k == K_OP && !strcmp(at(1)->tx, ")")) {
        a[na].s = full(cur()); a[na].t = TUNK; p++; na++;
        *close = takeOp(")");
        return na;
    }
    for (;;) {
        if (na >= 32) fail("zu viele Argumente");
        a[na++] = parseAssign();
        if (isop(",")) { sep[na - 1] = takeOp(","); continue; }
        *close = takeOp(")");
        return na;
    }
}

static Ex parsePrimary(void) {
    Tok *t = cur();
    Ex e;
    if (t->k == K_NUM) {
        e.s = full(t); p++;
        const char *x = t->tx;
        int hex = x[0] == '0' && (x[1] == 'x' || x[1] == 'X');
        size_t l = strlen(x);
        if (!hex && (strchr(x, '.') || strchr(x, 'e') || strchr(x, 'E') || x[l - 1] == 'f' || x[l - 1] == 'F')) e.t = mk('f', 1);
        else if (x[l - 1] == 'u' || x[l - 1] == 'U') e.t = mk('u', 1);
        else e.t = mk('i', 1);
        return e;
    }
    if (t->k == K_OP && !strcmp(t->tx, "(")) {
        char *o = takeOp("(");
        Ex in = parseExpr();
        char *c = takeOp(")");
        e.s = cat(3, o, in.s, c); e.t = in.t;
        return e;
    }
    if (t->k != K_ID) fail("Ausdruck erwartet");
    const char *name = t->tx;
    if (!strcmp(name, "true") || !strcmp(name, "false")) { e.s = full(t); p++; e.t = mk('b', 1); return e; }
    T ty;
    Ex args[32]; char *sep[32], *open, *close;
    if (typeOf(name, &ty)) {
        /* Konstruktor (auch Array: vec3[](…) / vec3[6](…)) */
        char *head = full(t); p++;
        if (isop("[")) {
            head = cat(2, head, takeOp("["));
            while (!isop("]")) { if (cur()->k == K_END) fail("]"); head = cat(2, head, full(cur())); p++; }
            head = cat(2, head, takeOp("]"));
            ty.arr = 1;
        }
        if (!isop("(")) fail("Konstruktor ohne (");
        int na = parseArgs(args, sep, &open, &close);
        if (ty.b == 'S') { /* Struct-Konstruktor: Felder anpassen */
            for (int s = 0; s < nst; s++)
                if (!strcmp(sts[s].name, ty.nm) && sts[s].nm == na)
                    for (int i = 0; i < na; i++) args[i] = convTo(args[i], sts[s].mt[i]);
        }
        e.s = joinCall(cat(2, head, open), args, sep, na, close);
        e.t = ty;
        return e;
    }
    if (at(1)->k == K_OP && !strcmp(at(1)->tx, "(")) {
        char *head = full(t); p++;
        int na = parseArgs(args, sep, &open, &close);
        return call(cat(2, head, open), name, args, sep, na, close);
    }
    Sym *s = lookup(name);
    p++;
    if (s) { e.s = cat(2, t->ws, s->out); e.t = s->t; }
    else { e.s = full(t); e.t = TUNK; }
    return e;
}

static Ex parsePostfix(Ex e) {
    for (;;) {
        if (isop("[")) {
            char *o = takeOp("[");
            Ex i = parseExpr();
            char *c = takeOp("]");
            e.s = cat(4, e.s, o, i.s, c);
            if (e.t.arr) e.t.arr = 0;
            else if (e.t.m) { e.t = mk('f', e.t.n); }
            else if (e.t.b != '?' && e.t.b != 's' && e.t.b != 'S' && e.t.n > 1) e.t.n = 1;
            else e.t = TUNK;
        } else if (isop(".")) {
            char *d = takeOp(".");
            if (cur()->k != K_ID) fail("Feldname");
            Tok *f = cur(); p++;
            e.s = cat(3, e.s, d, full(f));
            if (!strcmp(f->tx, "length") && isop("(")) {
                e.s = cat(2, e.s, takeOp("("));
                e.s = cat(2, e.s, takeOp(")"));
                e.t = mk('i', 1);
            } else if (e.t.b == 'S' && !e.t.arr) {
                T mt = TUNK;
                for (int s = 0; s < nst; s++)
                    if (!strcmp(sts[s].name, e.t.nm))
                        for (int i = 0; i < sts[s].nm; i++)
                            if (!strcmp(sts[s].mn[i], f->tx)) mt = sts[s].mt[i];
                e.t = mt;
            } else if ((e.t.b == 'f' || e.t.b == 'i' || e.t.b == 'u' || e.t.b == 'b') && !e.t.m && !e.t.arr &&
                       strlen(f->tx) <= 4 && strspn(f->tx, "xyzwrgbastpq") == strlen(f->tx)) {
                e.t = mk(e.t.b, (int)strlen(f->tx));
            } else e.t = TUNK;
        } else if (isop("++") || isop("--")) {
            e.s = cat(2, e.s, full(cur())); p++;
        } else return e;
    }
}

static Ex parseUnary(void) {
    if (isop("-") || isop("+") || isop("!") || isop("~") || isop("++") || isop("--")) {
        int notOp = isop("!");
        char *o = full(cur()); p++;
        Ex e = parseUnary();
        e.s = cat(2, o, e.s);
        if (notOp) e.t = mk('b', 1);
        return e;
    }
    return parsePostfix(parsePrimary());
}

static Ex parseBin(int minp) {
    Ex l = parseUnary();
    for (;;) {
        int pr = binPrec();
        if (!pr || pr < minp) return l;
        const char *op = cur()->tx;
        char *of = full(cur()); p++;
        Ex r = parseBin(pr + 1);
        l = binop(l, of, op, r, pr);
    }
}

static Ex parseCond(void) {
    Ex c = parseBin(1);
    if (!isop("?")) return c;
    char *q = takeOp("?");
    Ex a = parseAssign();
    char *k = takeOp(":");
    Ex b = parseAssign();
    if (a.t.b == 'f' && isInt(b.t)) b = wrap(b, 'f');
    else if (b.t.b == 'f' && isInt(a.t)) a = wrap(a, 'f');
    Ex e;
    e.s = cat(5, c.s, q, a.s, k, b.s);
    e.t = a.t.b != '?' ? a.t : b.t;
    return e;
}

static int isAssignOp(void) {
    static const char *ops[] = {"=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^=", NULL};
    if (cur()->k != K_OP) return 0;
    return inList(cur()->tx, ops);
}

static Ex parseAssign(void) {
    Ex l = parseCond();
    if (!isAssignOp()) return l;
    int plain = isop("=");
    char *o = full(cur()); p++;
    Ex r = parseAssign();
    if (plain) r = convTo(r, l.t);
    else if (l.t.b == 'f' && isInt(r.t)) r = wrap(r, 'f');
    else if (l.t.b == 'u' && r.t.b == 'i' && !r.t.arr) r = wrap(r, 'u');
    Ex e;
    e.s = cat(3, l.s, o, r.s);
    e.t = l.t;
    return e;
}

static Ex parseExpr(void) {
    Ex e = parseAssign();
    while (isop(",")) {
        char *c = takeOp(",");
        Ex r = parseAssign();
        e.s = cat(3, e.s, c, r.s);
        e.t = r.t;
    }
    return e;
}

/* ------------------------------------------------------------------ Deklarationen + Anweisungen */
static int isQual(const char *s) {
    static const char *q[] = {"const", "in", "out", "inout", "uniform", "flat", "smooth", "centroid", "highp", "mediump",
                              "lowp", "invariant", "precise", "attribute", "varying", "noperspective", "buffer", "shared", NULL};
    return inList(s, q);
}
/* ab Position i Qualifier (inkl. layout(…)) überspringen, gibt neue Position zurück */
static int skipQuals(int i, int *count) {
    *count = 0;
    for (;;) {
        Tok *t = &tk[i < ntk ? i : ntk];
        if (t->k == K_ID && isQual(t->tx)) { i++; (*count)++; continue; }
        if (t->k == K_ID && !strcmp(t->tx, "layout") && tk[i + 1].k == K_OP && !strcmp(tk[i + 1].tx, "(")) {
            int d = 0;
            for (i++; i < ntk; i++) {
                if (tk[i].k == K_OP && !strcmp(tk[i].tx, "(")) d++;
                if (tk[i].k == K_OP && !strcmp(tk[i].tx, ")") && --d == 0) { i++; break; }
            }
            (*count)++;
            continue;
        }
        return i;
    }
}
/* 0 = keine Deklaration, 1 = Variable/Funktion, 2 = Uniform-Block */
static int declKind(void) {
    int nq, i = skipQuals(p, &nq);
    Tok *t = &tk[i < ntk ? i : ntk];
    if (t->k != K_ID) return 0;
    T ty;
    if (typeOf(t->tx, &ty)) {
        int j = i + 1;
        if (tk[j].k == K_OP && !strcmp(tk[j].tx, "[")) {
            while (j < ntk && !(tk[j].k == K_OP && !strcmp(tk[j].tx, "]"))) j++;
            j++;
        }
        return j < ntk && tk[j].k == K_ID ? 1 : 0;
    }
    if (nq > 0 && i + 1 < ntk && tk[i + 1].k == K_OP && !strcmp(tk[i + 1].tx, "{")) return 2;
    return 0;
}

static T curRet;
static int bodyOwnsScope; /* nächste „{“ gehört zu den schon geöffneten Parametern */

static void emitQuals(void) {
    int nq, end = skipQuals(p, &nq);
    while (p < end) emitTok();
}

static void copyBrackets(T *t) {
    while (isop("[")) {
        emitTok();
        while (!isop("]")) { if (cur()->k == K_END) fail("]"); emitTok(); }
        emitTok();
        t->arr = 1;
    }
}

static const char *bufType(const char *tn) {
    if (!strcmp(tn, "samplerBuffer")) return "sampler2D";
    if (!strcmp(tn, "isamplerBuffer")) return "isampler2D";
    if (!strcmp(tn, "usamplerBuffer")) return "usampler2D";
    return NULL;
}

static void parseDecl(int kind) {
    emitQuals();
    if (kind == 2) { /* uniform Name { … } [inst]; */
        const char *bname = cur()->tx;
        emitTok();
        expectOp("{");
        int first = nsym;
        while (!isop("}")) {
            if (cur()->k == K_END) fail("}");
            if (cur()->k == K_PP) { emitTok(); continue; }
            if (isop(";")) { emitTok(); continue; }
            if (declKind() != 1) fail("Block-Feld");
            parseDecl(1);
        }
        emitTok();
        if (cur()->k == K_ID) {
            if (nst >= 64) fail("zu viele Structs");
            St *s = &sts[nst++];
            s->name = cat(2, "__blk_", bname); s->nm = 0;
            for (int i = first; i < nsym && s->nm < 64; i++) { s->mn[s->nm] = syms[i].name; s->mt[s->nm] = syms[i].t; s->nm++; }
            nsym = first;
            const char *inst = cur()->tx;
            emitTok();
            T t = mk('S', 1); t.nm = s->name;
            copyBrackets(&t);
            addSym(inst, inst, t);
        }
        return;
    }
    Tok *tt = cur();
    T ty;
    typeOf(tt->tx, &ty);
    const char *bt = bufType(tt->tx);
    emit(cat(2, tt->ws, bt ? bt : tt->tx)); p++;
    copyBrackets(&ty);
    if (cur()->k != K_ID) fail("Name erwartet");
    /* Funktion? */
    if (depth == 0 && at(1)->k == K_OP && !strcmp(at(1)->tx, "(")) {
        Fn f; memset(&f, 0, sizeof f);
        f.name = cur()->tx; f.ret = ty;
        emitTok();
        expectOp("(");
        pushScope();
        while (!isop(")")) {
            if (cur()->k == K_END) fail(")");
            if (isop(",")) { emitTok(); continue; }
            emitQuals();
            if (cur()->k != K_ID) fail("Parametertyp");
            T pt;
            typeOf(cur()->tx, &pt);
            const char *pb = bufType(cur()->tx);
            int isVoid = pt.b == 'v';
            emit(cat(2, cur()->ws, pb ? pb : cur()->tx)); p++;
            copyBrackets(&pt);
            if (cur()->k == K_ID) {
                const char *pn = cur()->tx;
                emitTok();
                copyBrackets(&pt);
                addSym(pn, pn, pt);
            }
            if (!isVoid && f.np < 16) f.p[f.np++] = pt;
        }
        emitTok(); /* ) */
        if (nfn < 512) fns[nfn++] = f;
        if (isop("{")) { curRet = ty; bodyOwnsScope = 1; }
        else popScope(); /* nur Prototyp */
        return;
    }
    /* Variablen */
    for (;;) {
        if (cur()->k != K_ID) fail("Variablenname");
        Tok *nt = cur();
        const char *name = nt->tx, *o = name;
        if (depth > 0 && fnExists(name)) o = cat(2, name, "_nutv");
        emit(cat(2, nt->ws, o)); p++;
        T vt = ty;
        copyBrackets(&vt);
        if (isop("=")) {
            emitTok();
            Ex e = parseAssign();
            e = convTo(e, vt);
            emit(e.s);
        }
        addSym(name, o, vt);
        if (isop(",")) { emitTok(); continue; }
        return;
    }
}

static void parseStruct(void) {
    emitTok(); /* struct */
    if (cur()->k != K_ID) fail("Struct-Name");
    if (nst >= 64) fail("zu viele Structs");
    St *s = &sts[nst];
    s->name = cur()->tx; s->nm = 0;
    emitTok();
    expectOp("{");
    while (!isop("}")) {
        if (cur()->k == K_END) fail("}");
        emitQuals();
        T mt;
        if (cur()->k != K_ID || !typeOf(cur()->tx, &mt)) fail("Feldtyp");
        emitTok();
        copyBrackets(&mt);
        for (;;) {
            if (cur()->k != K_ID) fail("Feldname");
            T ft = mt;
            const char *fn = cur()->tx;
            emitTok();
            copyBrackets(&ft);
            if (s->nm < 64) { s->mn[s->nm] = fn; s->mt[s->nm] = ft; s->nm++; }
            if (isop(",")) { emitTok(); continue; }
            break;
        }
        expectOp(";");
    }
    nst++;
    emitTok(); /* } */
    T st = mk('S', 1); st.nm = s->name;
    while (cur()->k == K_ID) { /* struct S {…} a, b; */
        const char *vn = cur()->tx;
        emitTok();
        T vt = st;
        copyBrackets(&vt);
        addSym(vn, vn, vt);
        if (isop(",")) emitTok();
    }
}

static void handlePP(Tok *t) {
    /* #define NAME 1.0  → Typ für NAME merken (nur einfache Konstanten) */
    const char *s = t->tx + 1;
    while (*s == ' ' || *s == '\t') s++;
    if (strncmp(s, "define", 6)) return;
    s += 6;
    while (*s == ' ' || *s == '\t') s++;
    const char *n = s;
    while (isalnum((unsigned char)*s) || *s == '_') s++;
    if (s == n || *s == '(') return;
    char *name = astr(n, (size_t)(s - n));
    while (*s == ' ' || *s == '\t') s++;
    while (*s == '(') s++;
    T t2 = TUNK;
    if (isdigit((unsigned char)*s) || (*s == '.' && isdigit((unsigned char)s[1])) || (*s == '-' && (isdigit((unsigned char)s[1]) || s[1] == '.'))) {
        const char *v = *s == '-' ? s + 1 : s;
        size_t l = strspn(v, "0123456789.eE+-xXabcdefABCDEFuU");
        int fl = 0, un = 0, hex = v[0] == '0' && (v[1] == 'x' || v[1] == 'X');
        for (size_t i = 0; i < l; i++) {
            if (v[i] == '.' || (!hex && (v[i] == 'e' || v[i] == 'E'))) fl = 1;
            if (v[i] == 'u' || v[i] == 'U') un = 1;
        }
        if (!hex && (v[l] == 'f' || v[l] == 'F')) fl = 1;
        t2 = mk(fl ? 'f' : un ? 'u' : 'i', 1);
    }
    addSym(name, name, t2);
}

static void statement(void) {
    Tok *t = cur();
    if (t->k == K_PP) { handlePP(t); emitTok(); return; }
    if (t->k == K_OP) {
        if (!strcmp(t->tx, ";")) { emitTok(); return; }
        if (!strcmp(t->tx, "{")) { emitTok(); if (bodyOwnsScope) bodyOwnsScope = 0; else pushScope(); return; }
        if (!strcmp(t->tx, "}")) { emitTok(); popScope(); return; }
    }
    if (t->k == K_ID) {
        const char *w = t->tx;
        if (!strcmp(w, "if") || !strcmp(w, "while") || !strcmp(w, "switch")) {
            emitTok();
            expectOp("(");
            emit(parseExpr().s);
            expectOp(")");
            return;
        }
        if (!strcmp(w, "else") || !strcmp(w, "do") || !strcmp(w, "break") || !strcmp(w, "continue") || !strcmp(w, "discard")) {
            emitTok();
            return;
        }
        if (!strcmp(w, "default")) { emitTok(); expectOp(":"); return; }
        if (!strcmp(w, "case")) { emitTok(); emit(parseExpr().s); expectOp(":"); return; }
        if (!strcmp(w, "for")) {
            emitTok();
            expectOp("(");
            int k = declKind();
            if (k == 1) parseDecl(1);
            else if (!isop(";")) emit(parseExpr().s);
            expectOp(";");
            if (!isop(";")) emit(parseExpr().s);
            expectOp(";");
            if (!isop(")")) emit(parseExpr().s);
            expectOp(")");
            return;
        }
        if (!strcmp(w, "return")) {
            emitTok();
            if (!isop(";")) emit(convTo(parseExpr(), curRet).s);
            return;
        }
        if (!strcmp(w, "precision")) {
            while (!isop(";")) { if (cur()->k == K_END) fail(";"); emitTok(); }
            return;
        }
        if (!strcmp(w, "struct")) { parseStruct(); return; }
        int k = declKind();
        if (k) { parseDecl(k); return; }
    }
    if (t->k == K_END) fail("Ende");
    emit(parseExpr().s);
}

static void addBuiltins(void) {
    addSym("gl_VertexID", "gl_VertexID", mk('i', 1));
    addSym("gl_InstanceID", "gl_InstanceID", mk('i', 1));
    addSym("gl_Position", "gl_Position", mk('f', 4));
    addSym("gl_PointSize", "gl_PointSize", mk('f', 1));
    addSym("gl_FragCoord", "gl_FragCoord", mk('f', 4));
    addSym("gl_FrontFacing", "gl_FrontFacing", mk('b', 1));
    addSym("gl_PointCoord", "gl_PointCoord", mk('f', 2));
    addSym("gl_FragDepth", "gl_FragDepth", mk('f', 1));
}

/* Gibt neuen Text zurück (malloc) oder NULL, wenn der Shader nicht verstanden wurde (*why = Grund) */
char *glsl_fix(const char *src, const char **why) {
    nsym = depth = nfn = nst = 0;
    bodyOwnsScope = 0;
    curRet = TUNK;
    glsl_fix_used_buffer = 0;
    outLen = 0;
    if (!out) { outCap = 4096; out = malloc(outCap); }
    out[0] = 0;
    char *volatile res = NULL;
    if (setjmp(failJmp) == 0) {
        tokenize(src);
        p = 0;
        addBuiltins();
        while (cur()->k != K_END) statement();
        emit(tailWs);
        res = malloc(outLen + 1);
        memcpy(res, out, outLen + 1);
        if (why) *why = NULL;
    } else {
        static char buf[160];
        snprintf(buf, sizeof buf, "%s bei Token %d „%s“", failWhy, p, p < ntk ? tk[p].tx : "Ende");
        if (why) *why = buf;
        glsl_fix_used_buffer = 0;
    }
    afree();
    return res;
}

#ifdef GLSL_FIX_TEST
/* Test auf dem PC: glsl_fix_test <datei> → umgeschriebener Shader auf stdout */
int main(int argc, char **argv) {
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 2;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *s = malloc((size_t)n + 1); fread(s, 1, (size_t)n, f); s[n] = 0; fclose(f);
    const char *why;
    char *r = glsl_fix(s, &why);
    if (!r) { fprintf(stderr, "FEHLER %s: %s\n", argv[1], why); return 1; }
    fputs(r, stdout);
    if (glsl_fix_used_buffer) fputs("\n// [nut_buf benutzt]\n", stdout);
    return 0;
}
#endif
