/* NUTclient iOS – eigenes GLFW (gleiche C-Schnittstelle wie GLFW 3.4, damit LWJGL/Minecraft es laden können).
 * Eigener Code. Ein Fenster = eine Fläche (CAEAGLLayer) unter der Launcher-Oberfläche; die Launcher-Webansicht wird
 * dafür durchsichtig und zeigt darüber die Touch-Steuerung. Eingaben kommen über nut_input() aus dem Launcher (Rust)
 * in eine Warteschlange und werden in glfwPollEvents() im Spiel-Thread an Minecraft weitergegeben.
 */
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <OpenGLES/EAGL.h>
#import <OpenGLES/EAGLDrawable.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <dlfcn.h>

/* eigene Funktionen finden: Java lädt die Bibliothek „lokal“ (RTLD_LOCAL), dann sieht RTLD_DEFAULT sie nicht */
static void *selfSym(const char *n) {
    static void *self;
    if (!self) { Dl_info i; if (dladdr((const void *)&selfSym, &i) && i.dli_fname) self = dlopen(i.dli_fname, RTLD_LAZY | RTLD_NOLOAD); }
    void *p = self ? dlsym(self, n) : NULL;
    return p ? p : dlsym(RTLD_DEFAULT, n);
}
#include <unistd.h>
#include "gl_es.h"

#define EXPORT __attribute__((visibility("default")))

extern GLuint nutgl_default_fbo;
extern void nutgl_log(const char *fmt, ...);
extern void nutgl_set_log(const char *path);

/* ---- GLFW-Konstanten */
#define GLFW_TRUE 1
#define GLFW_FALSE 0
#define GLFW_PRESS 1
#define GLFW_RELEASE 0
#define GLFW_FOCUSED 0x00020001
#define GLFW_ICONIFIED 0x00020002
#define GLFW_RESIZABLE 0x00020003
#define GLFW_VISIBLE 0x00020004
#define GLFW_DECORATED 0x00020005
#define GLFW_HOVERED 0x0002000B
#define GLFW_CONTEXT_VERSION_MAJOR 0x00022002
#define GLFW_CONTEXT_VERSION_MINOR 0x00022003
#define GLFW_OPENGL_PROFILE 0x00022008
#define GLFW_OPENGL_CORE_PROFILE 0x00032001
#define GLFW_CLIENT_API 0x00022001
#define GLFW_OPENGL_API 0x00030001
#define GLFW_CURSOR 0x00033001
#define GLFW_CURSOR_NORMAL 0x00034001
#define GLFW_CURSOR_DISABLED 0x00034003
#define GLFW_PLATFORM_COCOA 0x00060002

/* ---- Typen */
typedef struct GLFWvidmode { int width, height, redBits, greenBits, blueBits, refreshRate; } GLFWvidmode;
typedef struct GLFWgammaramp { unsigned short *red, *green, *blue; unsigned int size; } GLFWgammaramp;
typedef struct GLFWimage { int width, height; unsigned char *pixels; } GLFWimage;
typedef struct GLFWgamepadstate { unsigned char buttons[15]; float axes[6]; } GLFWgamepadstate;
typedef struct GLFWmonitor { int dummy; void *user; } GLFWmonitor;
typedef struct GLFWcursor { int shape; } GLFWcursor;
typedef struct GLFWwindow GLFWwindow;

typedef void (*GLFWerrorfun)(int, const char *);
typedef void (*GLFWkeyfun)(GLFWwindow *, int, int, int, int);
typedef void (*GLFWcharfun)(GLFWwindow *, unsigned int);
typedef void (*GLFWcharmodsfun)(GLFWwindow *, unsigned int, int);
typedef void (*GLFWmousebuttonfun)(GLFWwindow *, int, int, int);
typedef void (*GLFWcursorposfun)(GLFWwindow *, double, double);
typedef void (*GLFWcursorenterfun)(GLFWwindow *, int);
typedef void (*GLFWscrollfun)(GLFWwindow *, double, double);
typedef void (*GLFWdropfun)(GLFWwindow *, int, const char **);
typedef void (*GLFWwindowposfun)(GLFWwindow *, int, int);
typedef void (*GLFWwindowsizefun)(GLFWwindow *, int, int);
typedef void (*GLFWwindowclosefun)(GLFWwindow *);
typedef void (*GLFWwindowrefreshfun)(GLFWwindow *);
typedef void (*GLFWwindowfocusfun)(GLFWwindow *, int);
typedef void (*GLFWwindowiconifyfun)(GLFWwindow *, int);
typedef void (*GLFWwindowmaximizefun)(GLFWwindow *, int);
typedef void (*GLFWframebuffersizefun)(GLFWwindow *, int, int);
typedef void (*GLFWwindowcontentscalefun)(GLFWwindow *, float, float);
typedef void (*GLFWmonitorfun)(GLFWmonitor *, int);
typedef void (*GLFWjoystickfun)(int, int);
typedef void (*GLFWglproc)(void);

/* ---- das eine Fenster */
struct GLFWwindow {
    void *user;
    int shouldClose;
    char title[256];
    GLFWkeyfun key; GLFWcharfun chr; GLFWcharmodsfun charmods; GLFWmousebuttonfun button; GLFWcursorposfun cursor;
    GLFWcursorenterfun enter; GLFWscrollfun scroll; GLFWdropfun drop; GLFWwindowposfun pos; GLFWwindowsizefun size;
    GLFWwindowclosefun close; GLFWwindowrefreshfun refresh; GLFWwindowfocusfun focus; GLFWwindowiconifyfun iconify;
    GLFWwindowmaximizefun maximize; GLFWframebuffersizefun fbsize; GLFWwindowcontentscalefun scale;
    int cursorMode;
    double cx, cy;
    unsigned char keys[512];
    unsigned char buttons[8];
    /* Darstellung */
    void *ctx;     /* EAGLContext (retained) */
    void *view;    /* NutGameView (retained) */
    GLuint fbo, color, depth;
    int fbw, fbh;          /* Pixel */
    int ww, wh;            /* Punkte */
    volatile int resized;
};

static GLFWwindow *win;
static GLFWmonitor monitor;
static GLFWmonitor *monitors[1] = {&monitor};
static GLFWvidmode mode = {0, 0, 8, 8, 8, 60};
static GLFWerrorfun errorCb;
static GLFWmonitorfun monitorCb;
static GLFWjoystickfun joystickCb;
static void *currentCtx;
static int hints[64][2], nhints;
static uint64_t timeBase;
static double timeOffset;
static mach_timebase_info_data_t tb;

/* ---- Hauptthread-Hilfe */
static void onMain(void (^block)(void)) {
    if ([NSThread isMainThread]) block();
    else dispatch_sync(dispatch_get_main_queue(), block);
}

static UIWindow *keyWindow(void) {
    for (UIScene *s in UIApplication.sharedApplication.connectedScenes) {
        if (![s isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)s).windows)
            if (w.isKeyWindow) return w;
        if (((UIWindowScene *)s).windows.count) return ((UIWindowScene *)s).windows.firstObject;
    }
    return nil;
}

/* Launcher-Webansicht durchsichtig machen (Touch-Steuerung liegt darin, das Spiel darunter) */
static void clearWebViews(UIView *v, int depth) {
    /* Tauri nutzt eine Unterklasse (WryWebView) – deshalb nach Klasse prüfen, nicht nach Namen */
    Class wk = NSClassFromString(@"WKWebView");
    BOOL isWeb = wk && [v isKindOfClass:wk];
    if (depth < 4) nutgl_log("NUTGLFW Ansicht %*s%s%s", depth * 2, "", NSStringFromClass(v.class).UTF8String, isWeb ? " (Web)" : "");
    if (isWeb || [v isKindOfClass:UIScrollView.class]) {
        v.opaque = NO;
        v.backgroundColor = UIColor.clearColor;
        if (isWeb && [v respondsToSelector:NSSelectorFromString(@"setUnderPageBackgroundColor:")])
            [v setValue:UIColor.clearColor forKey:@"underPageBackgroundColor"];
    }
    for (UIView *c in v.subviews) clearWebViews(c, depth + 1);
}

/* ---- Spielfläche */
@interface NutGameView : UIView
@end
@implementation NutGameView
+ (Class)layerClass { return CAEAGLLayer.class; }
- (void)layoutSubviews {
    [super layoutSubviews];
    if (win) {
        win->ww = (int)self.bounds.size.width;
        win->wh = (int)self.bounds.size.height;
        win->resized = 1;
    }
}
@end

/* ======================================================================== Eingabe-Warteschlange */
typedef struct { int type; double a, b; int c, d; } Ev;
#define QN 1024
static Ev queue[QN];
static int qhead, qtail;
static pthread_mutex_t qlock = PTHREAD_MUTEX_INITIALIZER;
enum { EV_CURSOR = 1, EV_DELTA = 2, EV_BUTTON = 3, EV_KEY = 4, EV_CHAR = 5, EV_SCROLL = 6, EV_FOCUS = 7 };

/* vom Launcher (Rust) aufgerufen – beliebiger Thread */
EXPORT void nut_input(int type, double a, double b, int c, int d) {
    pthread_mutex_lock(&qlock);
    int next = (qtail + 1) % QN;
    if (next != qhead) { queue[qtail] = (Ev){type, a, b, c, d}; qtail = next; }
    pthread_mutex_unlock(&qlock);
}
EXPORT int nut_cursor_grabbed(void) { return win && win->cursorMode == GLFW_CURSOR_DISABLED; }
EXPORT int nut_window_open(void) { return win != NULL; }

static void deliver(Ev e) {
    if (!win) return;
    switch (e.type) {
    case EV_CURSOR:
        win->cx = e.a; win->cy = e.b;
        if (win->cursor) win->cursor(win, win->cx, win->cy);
        break;
    case EV_DELTA:
        win->cx += e.a; win->cy += e.b;
        if (win->cursor) win->cursor(win, win->cx, win->cy);
        break;
    case EV_BUTTON:
        if (e.c >= 0 && e.c < 8) win->buttons[e.c] = (unsigned char)e.d;
        if (win->button) win->button(win, e.c, e.d, 0);
        break;
    case EV_KEY:
        if (e.c >= 0 && e.c < 512) win->keys[e.c] = e.d != GLFW_RELEASE;
        if (win->key) win->key(win, e.c, e.c, e.d, 0);
        break;
    case EV_CHAR:
        if (win->chr) win->chr(win, (unsigned int)e.c);
        if (win->charmods) win->charmods(win, (unsigned int)e.c, 0);
        break;
    case EV_SCROLL:
        if (win->scroll) win->scroll(win, e.a, e.b);
        break;
    case EV_FOCUS:
        if (win->focus) win->focus(win, e.c);
        break;
    }
}

/* ======================================================================== Framebuffer */
static void makeFramebuffer(void) {
    EAGLContext *ctx = (__bridge EAGLContext *)win->ctx;
    NutGameView *view = (__bridge NutGameView *)win->view;
    if (!win->fbo) {
        es_glGenFramebuffers(1, &win->fbo);
        es_glGenRenderbuffers(1, &win->color);
        es_glGenRenderbuffers(1, &win->depth);
    }
    es_glBindFramebuffer(0x8D40, win->fbo);
    es_glBindRenderbuffer(0x8D41, win->color);
    [ctx renderbufferStorage:0x8D41 fromDrawable:(CAEAGLLayer *)view.layer];
    es_glFramebufferRenderbuffer(0x8D40, 0x8CE0, 0x8D41, win->color);
    GLint w = 0, h = 0;
    es_glGetRenderbufferParameteriv(0x8D41, 0x8D42, &w);
    es_glGetRenderbufferParameteriv(0x8D41, 0x8D43, &h);
    win->fbw = w; win->fbh = h;
    es_glBindRenderbuffer(0x8D41, win->depth);
    es_glRenderbufferStorage(0x8D41, 0x88F0 /* DEPTH24_STENCIL8 */, w, h);
    es_glFramebufferRenderbuffer(0x8D40, 0x8D00 /* DEPTH */, 0x8D41, win->depth);
    es_glFramebufferRenderbuffer(0x8D40, 0x8D20 /* STENCIL */, 0x8D41, win->depth);
    GLenum st = es_glCheckFramebufferStatus(0x8D40);
    nutgl_default_fbo = win->fbo;
    nutgl_log("NUTGLFW Framebuffer %dx%d (Status 0x%x)", w, h, st);
    win->resized = 0;
}

/* ======================================================================== Init / Version / Fehler */
EXPORT int glfwInit(void) {
    mach_timebase_info(&tb);
    timeBase = mach_absolute_time();
    NSString *dir = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject];
    nutgl_set_log([[dir stringByAppendingPathComponent:@"nutgl.log"] UTF8String]);
    nutgl_load();
    onMain(^{
        CGSize s = UIScreen.mainScreen.bounds.size;
        CGFloat k = MIN(UIScreen.mainScreen.scale, 2.0);
        /* Querformat: lange Seite = Breite */
        mode.width = (int)(MAX(s.width, s.height) * k);
        mode.height = (int)(MIN(s.width, s.height) * k);
        mode.refreshRate = (int)UIScreen.mainScreen.maximumFramesPerSecond;
    });
    nutgl_log("NUTGLFW glfwInit – Bildschirm %dx%d @%d Hz", mode.width, mode.height, mode.refreshRate);
    return GLFW_TRUE;
}
EXPORT void glfwTerminate(void) {}
EXPORT void glfwInitHint(int hint, int value) { (void)hint; (void)value; }
EXPORT void glfwInitAllocator(const void *a) { (void)a; }
EXPORT void glfwInitVulkanLoader(void *l) { (void)l; }
EXPORT void glfwGetVersion(int *major, int *minor, int *rev) { if (major) *major = 3; if (minor) *minor = 4; if (rev) *rev = 0; }
EXPORT const char *glfwGetVersionString(void) { return "3.4.0 NUTclient iOS"; }
EXPORT int glfwGetError(const char **desc) { if (desc) *desc = NULL; return 0; }
EXPORT GLFWerrorfun glfwSetErrorCallback(GLFWerrorfun cb) { GLFWerrorfun o = errorCb; errorCb = cb; return o; }
EXPORT int glfwGetPlatform(void) { return GLFW_PLATFORM_COCOA; }
EXPORT int glfwPlatformSupported(int p) { return p == GLFW_PLATFORM_COCOA; }

/* ======================================================================== Bildschirm */
EXPORT GLFWmonitor **glfwGetMonitors(int *count) { if (count) *count = 1; return monitors; }
EXPORT GLFWmonitor *glfwGetPrimaryMonitor(void) { return &monitor; }
EXPORT void glfwGetMonitorPos(GLFWmonitor *m, int *x, int *y) { (void)m; if (x) *x = 0; if (y) *y = 0; }
EXPORT void glfwGetMonitorWorkarea(GLFWmonitor *m, int *x, int *y, int *w, int *h) {
    (void)m; if (x) *x = 0; if (y) *y = 0; if (w) *w = mode.width; if (h) *h = mode.height;
}
EXPORT void glfwGetMonitorPhysicalSize(GLFWmonitor *m, int *w, int *h) { (void)m; if (w) *w = 150; if (h) *h = 70; }
EXPORT void glfwGetMonitorContentScale(GLFWmonitor *m, float *x, float *y) { (void)m; if (x) *x = 1; if (y) *y = 1; }
EXPORT const char *glfwGetMonitorName(GLFWmonitor *m) { (void)m; return "iPhone"; }
EXPORT void glfwSetMonitorUserPointer(GLFWmonitor *m, void *p) { m->user = p; }
EXPORT void *glfwGetMonitorUserPointer(GLFWmonitor *m) { return m->user; }
EXPORT GLFWmonitorfun glfwSetMonitorCallback(GLFWmonitorfun cb) { GLFWmonitorfun o = monitorCb; monitorCb = cb; return o; }
EXPORT const GLFWvidmode *glfwGetVideoModes(GLFWmonitor *m, int *count) { (void)m; if (count) *count = 1; return &mode; }
EXPORT const GLFWvidmode *glfwGetVideoMode(GLFWmonitor *m) { (void)m; return &mode; }
EXPORT void glfwSetGamma(GLFWmonitor *m, float g) { (void)m; (void)g; }
EXPORT const GLFWgammaramp *glfwGetGammaRamp(GLFWmonitor *m) { (void)m; return NULL; }
EXPORT void glfwSetGammaRamp(GLFWmonitor *m, const GLFWgammaramp *r) { (void)m; (void)r; }

/* ======================================================================== Fenster */
EXPORT void glfwDefaultWindowHints(void) { nhints = 0; }
EXPORT void glfwWindowHint(int hint, int value) { if (nhints < 64) { hints[nhints][0] = hint; hints[nhints][1] = value; nhints++; } }
EXPORT void glfwWindowHintString(int hint, const char *value) { (void)hint; (void)value; }

EXPORT GLFWwindow *glfwCreateWindow(int width, int height, const char *title, GLFWmonitor *m, GLFWwindow *share) {
    (void)width; (void)height; (void)m; (void)share;
    if (win) return win;
    win = calloc(1, sizeof(GLFWwindow));
    win->cursorMode = GLFW_CURSOR_NORMAL;
    if (title) strncpy(win->title, title, sizeof win->title - 1);
    __block NutGameView *view = nil;
    onMain(^{
        UIWindow *w = keyWindow();
        /* Querformat anfordern */
        if (@available(iOS 16.0, *)) {
            UIWindowSceneGeometryPreferencesIOS *pref =
                [[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:UIInterfaceOrientationMaskLandscape];
            [w.windowScene requestGeometryUpdateWithPreferences:pref errorHandler:^(NSError *e) {
                nutgl_log("NUTGLFW Querformat abgelehnt: %s", e.localizedDescription.UTF8String);
            }];
            [w.rootViewController setNeedsUpdateOfSupportedInterfaceOrientations];
        }
        view = [[NutGameView alloc] initWithFrame:w.bounds];
        view.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        view.contentScaleFactor = MIN(UIScreen.mainScreen.scale, 2.0);
        view.userInteractionEnabled = NO;   /* Touches gehen an die Touch-Steuerung darüber */
        CAEAGLLayer *layer = (CAEAGLLayer *)view.layer;
        layer.opaque = YES;
        layer.drawableProperties = @{ kEAGLDrawablePropertyRetainedBacking : @NO,
                                      kEAGLDrawablePropertyColorFormat : kEAGLColorFormatRGBA8 };
        /* Spielfläche direkt ins Fenster, HINTER die Launcher-Ansicht (Tauri: rootViewController.view = WKWebView) */
        UIView *root = w.rootViewController.view;
        if (root && root.superview == w) [w insertSubview:view belowSubview:root];
        else [(root ?: w) insertSubview:view atIndex:0];
        w.backgroundColor = UIColor.blackColor;
        clearWebViews(w, 0);
        if (root) { root.opaque = NO; root.backgroundColor = UIColor.clearColor; }
        win->ww = (int)view.bounds.size.width;
        win->wh = (int)view.bounds.size.height;
    });
    win->view = (__bridge_retained void *)view;
    EAGLContext *ctx = [[EAGLContext alloc] initWithAPI:kEAGLRenderingAPIOpenGLES3];
    if (!ctx) { nutgl_log("NUTGLFW kein OpenGL-ES-3-Kontext"); return NULL; }
    win->ctx = (__bridge_retained void *)ctx;
    nutgl_log("NUTGLFW Fenster „%s“ %dx%d Punkte", win->title, win->ww, win->wh);
    return win;
}
EXPORT void glfwDestroyWindow(GLFWwindow *w) { (void)w; }
EXPORT int glfwWindowShouldClose(GLFWwindow *w) { return w ? w->shouldClose : 0; }
EXPORT void glfwSetWindowShouldClose(GLFWwindow *w, int v) { if (w) w->shouldClose = v; }
EXPORT const char *glfwGetWindowTitle(GLFWwindow *w) { return w ? w->title : ""; }
EXPORT void glfwSetWindowTitle(GLFWwindow *w, const char *t) { if (w && t) strncpy(w->title, t, sizeof w->title - 1); }
EXPORT void glfwSetWindowIcon(GLFWwindow *w, int n, const GLFWimage *i) { (void)w; (void)n; (void)i; }
EXPORT void glfwGetWindowPos(GLFWwindow *w, int *x, int *y) { (void)w; if (x) *x = 0; if (y) *y = 0; }
EXPORT void glfwSetWindowPos(GLFWwindow *w, int x, int y) { (void)w; (void)x; (void)y; }
EXPORT void glfwGetWindowSize(GLFWwindow *w, int *x, int *y) { if (x) *x = w ? w->ww : 0; if (y) *y = w ? w->wh : 0; }
EXPORT void glfwSetWindowSizeLimits(GLFWwindow *w, int a, int b, int c, int d) { (void)w; (void)a; (void)b; (void)c; (void)d; }
EXPORT void glfwSetWindowAspectRatio(GLFWwindow *w, int a, int b) { (void)w; (void)a; (void)b; }
EXPORT void glfwSetWindowSize(GLFWwindow *w, int x, int y) { (void)w; (void)x; (void)y; }
EXPORT void glfwGetFramebufferSize(GLFWwindow *w, int *x, int *y) {
    int fw = w ? w->fbw : 0, fh = w ? w->fbh : 0;
    if (w && !fw) { fw = (int)(w->ww * 2); fh = (int)(w->wh * 2); }
    if (x) *x = fw; if (y) *y = fh;
}
EXPORT void glfwGetWindowFrameSize(GLFWwindow *w, int *l, int *t, int *r, int *b) {
    (void)w; if (l) *l = 0; if (t) *t = 0; if (r) *r = 0; if (b) *b = 0;
}
EXPORT void glfwGetWindowContentScale(GLFWwindow *w, float *x, float *y) { (void)w; if (x) *x = 1; if (y) *y = 1; }
EXPORT float glfwGetWindowOpacity(GLFWwindow *w) { (void)w; return 1; }
EXPORT void glfwSetWindowOpacity(GLFWwindow *w, float o) { (void)w; (void)o; }
EXPORT void glfwIconifyWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwRestoreWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwMaximizeWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwShowWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwHideWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwFocusWindow(GLFWwindow *w) { (void)w; }
EXPORT void glfwRequestWindowAttention(GLFWwindow *w) { (void)w; }
EXPORT GLFWmonitor *glfwGetWindowMonitor(GLFWwindow *w) { (void)w; return NULL; }
EXPORT void glfwSetWindowMonitor(GLFWwindow *w, GLFWmonitor *m, int x, int y, int a, int b, int r) {
    (void)w; (void)m; (void)x; (void)y; (void)a; (void)b; (void)r;
}
EXPORT int glfwGetWindowAttrib(GLFWwindow *w, int attrib) {
    (void)w;
    switch (attrib) {
    case GLFW_FOCUSED: case GLFW_VISIBLE: case GLFW_HOVERED: return 1;
    case GLFW_CONTEXT_VERSION_MAJOR: return 3;
    case GLFW_CONTEXT_VERSION_MINOR: return 3;
    case GLFW_OPENGL_PROFILE: return GLFW_OPENGL_CORE_PROFILE;
    case GLFW_CLIENT_API: return GLFW_OPENGL_API;
    }
    return 0;
}
EXPORT void glfwSetWindowAttrib(GLFWwindow *w, int a, int v) { (void)w; (void)a; (void)v; }
EXPORT void glfwSetWindowUserPointer(GLFWwindow *w, void *p) { if (w) w->user = p; }
EXPORT void *glfwGetWindowUserPointer(GLFWwindow *w) { return w ? w->user : NULL; }

#define SETCB(fn, type, field) \
    EXPORT type fn(GLFWwindow *w, type cb) { if (!w) return NULL; type o = w->field; w->field = cb; return o; }
SETCB(glfwSetWindowPosCallback, GLFWwindowposfun, pos)
SETCB(glfwSetWindowSizeCallback, GLFWwindowsizefun, size)
SETCB(glfwSetWindowCloseCallback, GLFWwindowclosefun, close)
SETCB(glfwSetWindowRefreshCallback, GLFWwindowrefreshfun, refresh)
SETCB(glfwSetWindowFocusCallback, GLFWwindowfocusfun, focus)
SETCB(glfwSetWindowIconifyCallback, GLFWwindowiconifyfun, iconify)
SETCB(glfwSetWindowMaximizeCallback, GLFWwindowmaximizefun, maximize)
SETCB(glfwSetFramebufferSizeCallback, GLFWframebuffersizefun, fbsize)
SETCB(glfwSetWindowContentScaleCallback, GLFWwindowcontentscalefun, scale)
SETCB(glfwSetKeyCallback, GLFWkeyfun, key)
SETCB(glfwSetCharCallback, GLFWcharfun, chr)
SETCB(glfwSetCharModsCallback, GLFWcharmodsfun, charmods)
SETCB(glfwSetMouseButtonCallback, GLFWmousebuttonfun, button)
SETCB(glfwSetCursorPosCallback, GLFWcursorposfun, cursor)
SETCB(glfwSetCursorEnterCallback, GLFWcursorenterfun, enter)
SETCB(glfwSetScrollCallback, GLFWscrollfun, scroll)
SETCB(glfwSetDropCallback, GLFWdropfun, drop)

/* ======================================================================== Ereignisse */
EXPORT void glfwPollEvents(void) {
    if (!win) return;
    if (win->resized && currentCtx) {
        int ow = win->fbw, oh = win->fbh;
        makeFramebuffer();
        if ((ow != win->fbw || oh != win->fbh) && win->fbsize) win->fbsize(win, win->fbw, win->fbh);
        if ((ow != win->fbw || oh != win->fbh) && win->size) win->size(win, win->ww, win->wh);
    }
    for (;;) {
        pthread_mutex_lock(&qlock);
        if (qhead == qtail) { pthread_mutex_unlock(&qlock); break; }
        Ev e = queue[qhead];
        qhead = (qhead + 1) % QN;
        pthread_mutex_unlock(&qlock);
        deliver(e);
    }
}
EXPORT void glfwWaitEvents(void) { usleep(4000); glfwPollEvents(); }
EXPORT void glfwWaitEventsTimeout(double t) { usleep((useconds_t)(MIN(t, 0.01) * 1e6)); glfwPollEvents(); }
EXPORT void glfwPostEmptyEvent(void) {}

/* ======================================================================== Eingabe */
EXPORT int glfwGetInputMode(GLFWwindow *w, int m) { return (w && m == GLFW_CURSOR) ? w->cursorMode : 0; }
EXPORT void glfwSetInputMode(GLFWwindow *w, int m, int v) {
    if (w && m == GLFW_CURSOR) {
        w->cursorMode = v;
        nutgl_log("NUTGLFW Maus %s", v == GLFW_CURSOR_DISABLED ? "gefangen (Spiel)" : "frei (Menü)");
    }
}
EXPORT int glfwRawMouseMotionSupported(void) { return 0; }
EXPORT const char *glfwGetKeyName(int key, int scancode) { (void)key; (void)scancode; return NULL; }
EXPORT int glfwGetKeyScancode(int key) { return key; }
EXPORT int glfwGetKey(GLFWwindow *w, int key) { return (w && key >= 0 && key < 512) ? w->keys[key] : 0; }
EXPORT int glfwGetMouseButton(GLFWwindow *w, int b) { return (w && b >= 0 && b < 8) ? w->buttons[b] : 0; }
EXPORT void glfwGetCursorPos(GLFWwindow *w, double *x, double *y) { if (x) *x = w ? w->cx : 0; if (y) *y = w ? w->cy : 0; }
EXPORT void glfwSetCursorPos(GLFWwindow *w, double x, double y) { if (w) { w->cx = x; w->cy = y; } }
static GLFWcursor cursors[8];
EXPORT GLFWcursor *glfwCreateCursor(const GLFWimage *i, int x, int y) { (void)i; (void)x; (void)y; return &cursors[0]; }
EXPORT GLFWcursor *glfwCreateStandardCursor(int shape) { (void)shape; return &cursors[1]; }
EXPORT void glfwDestroyCursor(GLFWcursor *c) { (void)c; }
EXPORT void glfwSetCursor(GLFWwindow *w, GLFWcursor *c) { (void)w; (void)c; }

EXPORT int glfwJoystickPresent(int j) { (void)j; return 0; }
EXPORT const float *glfwGetJoystickAxes(int j, int *n) { (void)j; if (n) *n = 0; return NULL; }
EXPORT const unsigned char *glfwGetJoystickButtons(int j, int *n) { (void)j; if (n) *n = 0; return NULL; }
EXPORT const unsigned char *glfwGetJoystickHats(int j, int *n) { (void)j; if (n) *n = 0; return NULL; }
EXPORT const char *glfwGetJoystickName(int j) { (void)j; return NULL; }
EXPORT const char *glfwGetJoystickGUID(int j) { (void)j; return NULL; }
EXPORT void glfwSetJoystickUserPointer(int j, void *p) { (void)j; (void)p; }
EXPORT void *glfwGetJoystickUserPointer(int j) { (void)j; return NULL; }
EXPORT int glfwJoystickIsGamepad(int j) { (void)j; return 0; }
EXPORT GLFWjoystickfun glfwSetJoystickCallback(GLFWjoystickfun cb) { GLFWjoystickfun o = joystickCb; joystickCb = cb; return o; }
EXPORT int glfwUpdateGamepadMappings(const char *s) { (void)s; return 1; }
EXPORT const char *glfwGetGamepadName(int j) { (void)j; return NULL; }
EXPORT int glfwGetGamepadState(int j, GLFWgamepadstate *s) { (void)j; (void)s; return 0; }

static char clip[65536];
EXPORT void glfwSetClipboardString(GLFWwindow *w, const char *s) {
    (void)w;
    if (!s) return;
    NSString *str = [NSString stringWithUTF8String:s];
    onMain(^{ UIPasteboard.generalPasteboard.string = str; });
}
EXPORT const char *glfwGetClipboardString(GLFWwindow *w) {
    (void)w;
    __block NSString *s = nil;
    onMain(^{ s = UIPasteboard.generalPasteboard.string; });
    strncpy(clip, s ? s.UTF8String : "", sizeof clip - 1);
    return clip;
}

/* ======================================================================== Zeit */
static double now(void) { return (double)(mach_absolute_time() - timeBase) * tb.numer / tb.denom / 1e9; }
EXPORT double glfwGetTime(void) { return now() + timeOffset; }
EXPORT void glfwSetTime(double t) { timeOffset = t - now(); }
EXPORT uint64_t glfwGetTimerValue(void) { return mach_absolute_time(); }
EXPORT uint64_t glfwGetTimerFrequency(void) { return (uint64_t)(1e9 * tb.denom / tb.numer); }

/* ======================================================================== Kontext */
EXPORT void glfwMakeContextCurrent(GLFWwindow *w) {
    if (!w) { [EAGLContext setCurrentContext:nil]; currentCtx = NULL; return; }
    [EAGLContext setCurrentContext:(__bridge EAGLContext *)w->ctx];
    currentCtx = w->ctx;
    if (!w->fbo || w->resized) makeFramebuffer();
    es_glBindFramebuffer(0x8D40, w->fbo);
    if (w->focus) w->focus(w, 1);
}
EXPORT GLFWwindow *glfwGetCurrentContext(void) { return currentCtx ? win : NULL; }
EXPORT void glfwSwapInterval(int i) { (void)i; }
EXPORT int glfwExtensionSupported(const char *e) { (void)e; return 0; }
EXPORT GLFWglproc glfwGetProcAddress(const char *name) { return (GLFWglproc)selfSym(name); }

static long frames;
/* Test: Bild direkt aus dem Grafikspeicher als PPM nach Library/Caches/gl-frame-N.ppm (halbe Größe) –
   zeigt, was Minecraft zeichnet, unabhängig davon, ob etwas darüber liegt */
static void dumpFrame(GLFWwindow *w, long n) {
    GLint keepRead = 0, keepPack = 0, rb = 0, fw = 0, fh = 0;
    es_glGetIntegerv(0x8CAA /* READ_FRAMEBUFFER_BINDING */, &keepRead);
    es_glGetIntegerv(0x88ED /* PIXEL_PACK_BUFFER_BINDING */, &keepPack);
    es_glGetIntegerv(0x8CA7 /* RENDERBUFFER_BINDING */, &rb);
    es_glBindRenderbuffer(0x8D41, w->color);
    es_glGetRenderbufferParameteriv(0x8D41, 0x8D42, &fw);
    es_glGetRenderbufferParameteriv(0x8D41, 0x8D43, &fh);
    es_glBindRenderbuffer(0x8D41, (GLuint)rb);
    if (fw <= 0 || fh <= 0) return;
    unsigned char *px = malloc((size_t)fw * (size_t)fh * 4);
    es_glBindFramebuffer(0x8CA8 /* READ_FRAMEBUFFER */, w->fbo);
    es_glBindBuffer(0x88EB /* PIXEL_PACK_BUFFER */, 0);
    es_glReadPixels(0, 0, fw, fh, 0x1908 /* RGBA */, 0x1401, px);
    es_glBindBuffer(0x88EB, (GLuint)keepPack);
    es_glBindFramebuffer(0x8CA8, (GLuint)keepRead);
    NSString *dir = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
    NSString *path = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"gl-frame-%ld.ppm", n]];
    FILE *f = fopen(path.fileSystemRepresentation, "wb");
    if (f) {
        int ow = fw / 2, oh = fh / 2;
        fprintf(f, "P6\n%d %d\n255\n", ow, oh);
        for (int y = oh - 1; y >= 0; y--)          /* GL zählt Zeilen von unten */
            for (int x = 0; x < ow; x++) fwrite(px + ((size_t)(y * 2) * (size_t)fw + (size_t)(x * 2)) * 4, 1, 3, f);
        fclose(f);
        nutgl_log("NUTGLFW Testbild %s (%dx%d)", path.lastPathComponent.UTF8String, fw, fh);
    }
    free(px);
}
EXPORT void glfwSwapBuffers(GLFWwindow *w) {
    if (!w || !w->ctx) return;
    EAGLContext *ctx = (__bridge EAGLContext *)w->ctx;
    GLint rb = 0;
    es_glGetIntegerv(0x8CA7 /* RENDERBUFFER_BINDING */, &rb);
    if (getenv("NUT_FRAME_DUMPS") && (frames + 1 == 40 || frames + 1 == 80 || frames + 1 == 120 || frames + 1 == 160))
        dumpFrame(w, frames + 1);
    es_glBindRenderbuffer(0x8D41, w->color);
    [ctx presentRenderbuffer:0x8D41];
    es_glBindRenderbuffer(0x8D41, (GLuint)rb);
    /* Bild 1, danach alle 10 s mit Bildrate */
    static double lastT; static long lastF;
    double tnow = glfwGetTime();
    if (++frames == 1 || tnow - lastT >= 10) {
        nutgl_log("NUTGLFW Bild %ld (%.1f Bilder/s)", frames, lastT > 0 ? (frames - lastF) / (tnow - lastT) : 0.0);
        lastT = tnow; lastF = frames;
    }
}

/* ======================================================================== Vulkan / Plattform-Zugriffe (gibt es hier nicht) */
EXPORT int glfwVulkanSupported(void) { return 0; }
EXPORT const char **glfwGetRequiredInstanceExtensions(unsigned int *n) { if (n) *n = 0; return NULL; }
EXPORT void *glfwGetInstanceProcAddress(void *i, const char *n) { (void)i; (void)n; return NULL; }
EXPORT int glfwGetPhysicalDevicePresentationSupport(void *i, void *d, unsigned int q) { (void)i; (void)d; (void)q; return 0; }
EXPORT int glfwCreateWindowSurface(void *i, GLFWwindow *w, const void *a, void *s) { (void)i; (void)w; (void)a; (void)s; return -7; }
EXPORT uint32_t glfwGetCocoaMonitor(GLFWmonitor *m) { (void)m; return 0; }
EXPORT void *glfwGetCocoaWindow(GLFWwindow *w) { (void)w; return NULL; }
EXPORT void *glfwGetCocoaView(GLFWwindow *w) { (void)w; return NULL; }
EXPORT void *glfwGetNSGLContext(GLFWwindow *w) { (void)w; return NULL; }
