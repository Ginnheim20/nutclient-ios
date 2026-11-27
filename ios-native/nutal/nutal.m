/* NUTclient iOS – eigenes OpenAL 1.1 (gleiche C-Schnittstelle, damit LWJGL/Minecraft es laden können). Eigener Code.
 * Kleiner Software-Mischer: Quellen mit Puffern (auch Warteschlange fürs Musik-Streaming), Tonhöhe, Lautstärke,
 * Schleife, Entfernung (alle Distanzmodelle) und Stereo-Richtung zur Hörerposition. Ausgabe über Apples RemoteIO-AudioUnit
 * mit 48 kHz Stereo (Float). Minecraft nutzt Mono-Puffer für Geräusche (räumlich) und Stereo-Puffer für Musik.
 */
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>
#include <math.h>
#include <pthread.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <dlfcn.h>

/* eigene Funktionen finden: Java lädt die Bibliothek „lokal“ (RTLD_LOCAL), dann sieht RTLD_DEFAULT sie nicht */
static void *selfSym(const char *n) {
    static void *self;
    if (!self) { Dl_info i; if (dladdr((const void *)&selfSym, &i) && i.dli_fname) self = dlopen(i.dli_fname, RTLD_LAZY | RTLD_NOLOAD); }
    void *p = self ? dlsym(self, n) : NULL;
    return p ? p : dlsym(RTLD_DEFAULT, n);
}

#define EXPORT __attribute__((visibility("default")))
typedef char ALboolean; typedef char ALchar; typedef signed char ALbyte; typedef unsigned char ALubyte; typedef short ALshort;
typedef unsigned short ALushort; typedef int ALint; typedef unsigned int ALuint; typedef int ALsizei; typedef int ALenum;
typedef float ALfloat; typedef double ALdouble; typedef void ALvoid;
typedef char ALCboolean; typedef char ALCchar; typedef int ALCint; typedef unsigned int ALCuint; typedef int ALCsizei; typedef int ALCenum;
typedef void ALCvoid;
typedef struct ALCdevice { int open; } ALCdevice;
typedef struct ALCcontext { int alive; } ALCcontext;

/* ---- Konstanten */
#define AL_SOURCE_RELATIVE 0x202
#define AL_PITCH 0x1003
#define AL_POSITION 0x1004
#define AL_DIRECTION 0x1005
#define AL_VELOCITY 0x1006
#define AL_LOOPING 0x1007
#define AL_BUFFER 0x1009
#define AL_GAIN 0x100A
#define AL_MIN_GAIN 0x100D
#define AL_MAX_GAIN 0x100E
#define AL_ORIENTATION 0x100F
#define AL_SOURCE_STATE 0x1010
#define AL_INITIAL 0x1011
#define AL_PLAYING 0x1012
#define AL_PAUSED 0x1013
#define AL_STOPPED 0x1014
#define AL_BUFFERS_QUEUED 0x1015
#define AL_BUFFERS_PROCESSED 0x1016
#define AL_REFERENCE_DISTANCE 0x1020
#define AL_ROLLOFF_FACTOR 0x1021
#define AL_MAX_DISTANCE 0x1023
#define AL_SEC_OFFSET 0x1024
#define AL_SAMPLE_OFFSET 0x1025
#define AL_BYTE_OFFSET 0x1026
#define AL_SOURCE_TYPE 0x1027
#define AL_STATIC 0x1028
#define AL_STREAMING 0x1029
#define AL_UNDETERMINED 0x1030
#define AL_FORMAT_MONO8 0x1100
#define AL_FORMAT_MONO16 0x1101
#define AL_FORMAT_STEREO8 0x1102
#define AL_FORMAT_STEREO16 0x1103
#define AL_FORMAT_MONO_FLOAT32 0x10010
#define AL_FORMAT_STEREO_FLOAT32 0x10011
#define AL_FREQUENCY 0x2001
#define AL_BITS 0x2002
#define AL_CHANNELS 0x2003
#define AL_SIZE 0x2004
#define AL_NO_ERROR 0
#define AL_INVALID_NAME 0xA001
#define AL_INVALID_ENUM 0xA002
#define AL_INVALID_VALUE 0xA003
#define AL_INVALID_OPERATION 0xA004
#define AL_VENDOR 0xB001
#define AL_VERSION 0xB002
#define AL_RENDERER 0xB003
#define AL_EXTENSIONS 0xB004
#define AL_DOPPLER_FACTOR 0xC000
#define AL_DOPPLER_VELOCITY 0xC001
#define AL_SPEED_OF_SOUND 0xC003
#define AL_DISTANCE_MODEL 0xD000
#define AL_INVERSE_DISTANCE 0xD001
#define AL_INVERSE_DISTANCE_CLAMPED 0xD002
#define AL_LINEAR_DISTANCE 0xD003
#define AL_LINEAR_DISTANCE_CLAMPED 0xD004
#define AL_EXPONENT_DISTANCE 0xD005
#define AL_EXPONENT_DISTANCE_CLAMPED 0xD006
#define ALC_MAJOR_VERSION 0x1000
#define ALC_MINOR_VERSION 0x1001
#define ALC_ATTRIBUTES_SIZE 0x1002
#define ALC_ALL_ATTRIBUTES 0x1003
#define ALC_DEFAULT_DEVICE_SPECIFIER 0x1004
#define ALC_DEVICE_SPECIFIER 0x1005
#define ALC_EXTENSIONS 0x1006
#define ALC_FREQUENCY 0x1007
#define ALC_MONO_SOURCES 0x1010
#define ALC_STEREO_SOURCES 0x1011
#define ALC_DEFAULT_ALL_DEVICES_SPECIFIER 0x1012
#define ALC_ALL_DEVICES_SPECIFIER 0x1013
#define ALC_CAPTURE_DEVICE_SPECIFIER 0x310
#define ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER 0x311
#define ALC_CONNECTED 0x313

#define RATE 48000.0
#define MAXSRC 512
#define MAXBUF 8192
#define MAXQ 64

typedef struct { int used; float *data; int frames, channels; int freq; } Buffer;
typedef struct {
    int used;
    int state;
    ALuint queue[MAXQ]; int qn, qpos;      /* Warteschlange; qpos = aktueller Puffer */
    int processed;
    double cursor;                          /* Position im aktuellen Puffer (Frames, gebrochen) */
    float pitch, gain, minGain, maxGain, refDist, rolloff, maxDist;
    float pos[3], vel[3], dir[3];
    int relative, looping, isStatic;
    int distModel;                          /* AL_EXT_source_distance_model: eigenes Modell (0 = das allgemeine) */
} Source;

static Buffer buffers[MAXBUF];
static Source sources[MAXSRC];
static float lpos[3], lvel[3], lat[3] = {0, 0, -1}, lup[3] = {0, 1, 0}, lgain = 1;
static int distModel = AL_INVERSE_DISTANCE_CLAMPED;
static int srcDistModel;                     /* alEnable(AL_SOURCE_DISTANCE_MODEL) */
#define AL_SOURCE_DISTANCE_MODEL 0x200
static ALenum err;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;
static ALCdevice device;
static ALCcontext context;
static ALCcontext *current;
static AudioUnit unit;

static void setErr(ALenum e) { if (!err) err = e; }
static Source *src(ALuint id) { return (id > 0 && id < MAXSRC && sources[id].used) ? &sources[id] : NULL; }
static Buffer *buf(ALuint id) { return (id > 0 && id < MAXBUF && buffers[id].used) ? &buffers[id] : NULL; }

/* ======================================================================== Mischer */
static float distGain(Source *s) {
    float d;
    if (s->relative) d = sqrtf(s->pos[0] * s->pos[0] + s->pos[1] * s->pos[1] + s->pos[2] * s->pos[2]);
    else {
        float x = s->pos[0] - lpos[0], y = s->pos[1] - lpos[1], z = s->pos[2] - lpos[2];
        d = sqrtf(x * x + y * y + z * z);
    }
    float ref = s->refDist, mx = s->maxDist, r = s->rolloff, g = 1;
    switch (srcDistModel && s->distModel ? s->distModel : distModel) {
    case AL_LINEAR_DISTANCE_CLAMPED: d = fmaxf(ref, fminf(d, mx)); /* fallthrough */
    case AL_LINEAR_DISTANCE: g = mx > ref ? 1 - r * (d - ref) / (mx - ref) : 1; break;
    case AL_INVERSE_DISTANCE_CLAMPED: d = fmaxf(ref, fminf(d, mx)); /* fallthrough */
    case AL_INVERSE_DISTANCE: g = ref / (ref + r * (d - ref)); break;
    case AL_EXPONENT_DISTANCE_CLAMPED: d = fmaxf(ref, fminf(d, mx)); /* fallthrough */
    case AL_EXPONENT_DISTANCE: g = d > 0 && ref > 0 ? powf(d / ref, -r) : 1; break;
    default: g = 1;
    }
    return fmaxf(0, fminf(1, g));
}
/* Links/Rechts aus der Richtung zur Quelle (Hörer-„rechts“ = Blickrichtung × oben) */
static float panOf(Source *s) {
    float x, y, z;
    if (s->relative) { x = s->pos[0]; y = s->pos[1]; z = s->pos[2]; }
    else { x = s->pos[0] - lpos[0]; y = s->pos[1] - lpos[1]; z = s->pos[2] - lpos[2]; }
    float len = sqrtf(x * x + y * y + z * z);
    if (len < 1e-4f) return 0;
    float rx = lat[1] * lup[2] - lat[2] * lup[1], ry = lat[2] * lup[0] - lat[0] * lup[2], rz = lat[0] * lup[1] - lat[1] * lup[0];
    float rl = sqrtf(rx * rx + ry * ry + rz * rz);
    if (s->relative) { rx = 1; ry = 0; rz = 0; rl = 1; }
    return fmaxf(-1, fminf(1, (x * rx + y * ry + z * rz) / (len * rl)));
}

static void mix(float *out, int frames) {
    memset(out, 0, sizeof(float) * 2 * frames);
    pthread_mutex_lock(&lk);
    for (int i = 1; i < MAXSRC; i++) {
        Source *s = &sources[i];
        if (!s->used || s->state != AL_PLAYING || s->qn == 0) continue;
        Buffer *b0 = buf(s->queue[s->qpos]);
        int mono = b0 && b0->channels == 1;
        float g = s->gain * lgain;
        float l = 1, r = 1;
        if (mono) {
            g *= distGain(s);
            float pan = panOf(s), a = (pan + 1) * 0.25f * (float)M_PI;   /* gleiche Leistung */
            l = cosf(a) * 1.4142f; r = sinf(a) * 1.4142f;
        }
        g = fmaxf(s->minGain, fminf(s->maxGain, g));
        for (int f = 0; f < frames; f++) {
            Buffer *b = buf(s->queue[s->qpos]);
            if (!b || !b->frames) { s->state = AL_STOPPED; break; }
            double step = (double)b->freq / RATE * s->pitch;
            int k = (int)s->cursor;
            if (k >= b->frames) {
                /* Puffer zu Ende → nächster in der Warteschlange, Schleife oder Stopp */
                s->cursor -= b->frames;
                if (s->qpos + 1 < s->qn) { s->qpos++; if (!s->isStatic) s->processed++; continue; }
                if (s->looping) { s->qpos = 0; s->cursor = 0; continue; }
                if (!s->isStatic) s->processed = s->qn;
                s->state = AL_STOPPED; s->cursor = 0; s->qpos = 0;
                break;
            }
            if (b->channels == 1) {
                float v = b->data[k] * g;
                out[2 * f] += v * l; out[2 * f + 1] += v * r;
            } else {
                out[2 * f] += b->data[2 * k] * g; out[2 * f + 1] += b->data[2 * k + 1] * g;
            }
            s->cursor += step;
        }
    }
    pthread_mutex_unlock(&lk);
    for (int f = 0; f < frames * 2; f++) out[f] = fmaxf(-1, fminf(1, out[f]));
}

static OSStatus render(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts, UInt32 bus, UInt32 n,
                       AudioBufferList *io) {
    (void)ref; (void)flags; (void)ts; (void)bus;
    mix((float *)io->mBuffers[0].mData, (int)n);
    return noErr;
}

static int startOutput(void) {
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryAmbient error:nil];
    [[AVAudioSession sharedInstance] setActive:YES error:nil];
    AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
    AudioComponent c = AudioComponentFindNext(NULL, &d);
    if (!c || AudioComponentInstanceNew(c, &unit)) return 0;
    AudioStreamBasicDescription f = {0};
    f.mSampleRate = RATE; f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    f.mChannelsPerFrame = 2; f.mBitsPerChannel = 32; f.mFramesPerPacket = 1;
    f.mBytesPerFrame = 8; f.mBytesPerPacket = 8;
    AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f);
    AURenderCallbackStruct cb = {render, NULL};
    AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
    if (AudioUnitInitialize(unit) || AudioOutputUnitStart(unit)) return 0;
    return 1;
}

/* ======================================================================== ALC */
EXPORT ALCdevice *alcOpenDevice(const ALCchar *name) {
    (void)name;
    if (!device.open) device.open = startOutput() ? 1 : 2;
    return &device;
}
EXPORT ALCboolean alcCloseDevice(ALCdevice *d) { (void)d; return 1; }
EXPORT ALCcontext *alcCreateContext(ALCdevice *d, const ALCint *attr) { (void)d; (void)attr; context.alive = 1; return &context; }
EXPORT ALCboolean alcMakeContextCurrent(ALCcontext *c) { current = c; return 1; }
EXPORT void alcProcessContext(ALCcontext *c) { (void)c; }
EXPORT void alcSuspendContext(ALCcontext *c) { (void)c; }
EXPORT void alcDestroyContext(ALCcontext *c) { (void)c; }
EXPORT ALCcontext *alcGetCurrentContext(void) { return current; }
EXPORT ALCdevice *alcGetContextsDevice(ALCcontext *c) { (void)c; return &device; }
EXPORT ALCenum alcGetError(ALCdevice *d) { (void)d; return 0; }
EXPORT ALCboolean alcIsExtensionPresent(ALCdevice *d, const ALCchar *e) { (void)d; (void)e; return 0; }
EXPORT void *alcGetProcAddress(ALCdevice *d, const ALCchar *n) { (void)d; return selfSym(n); }
EXPORT ALCenum alcGetEnumValue(ALCdevice *d, const ALCchar *n) { (void)d; (void)n; return 0; }
EXPORT const ALCchar *alcGetString(ALCdevice *d, ALCenum p) {
    (void)d;
    switch (p) {
    case ALC_DEFAULT_DEVICE_SPECIFIER: case ALC_DEVICE_SPECIFIER: case ALC_DEFAULT_ALL_DEVICES_SPECIFIER:
    case ALC_ALL_DEVICES_SPECIFIER: return "iPhone\0";
    case ALC_CAPTURE_DEVICE_SPECIFIER: case ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER: return "\0";
    case ALC_EXTENSIONS: return "";
    }
    return "";
}
EXPORT void alcGetIntegerv(ALCdevice *d, ALCenum p, ALCsizei n, ALCint *v) {
    (void)d;
    if (!v || n < 1) return;
    switch (p) {
    case ALC_MAJOR_VERSION: *v = 1; break;
    case ALC_MINOR_VERSION: *v = 1; break;
    case ALC_FREQUENCY: *v = (ALCint)RATE; break;
    case ALC_MONO_SOURCES: *v = 255; break;
    case ALC_STEREO_SOURCES: *v = 8; break;
    case ALC_CONNECTED: *v = 1; break;
    case ALC_ATTRIBUTES_SIZE: *v = 1; break;
    case ALC_ALL_ATTRIBUTES: *v = 0; break;
    default: *v = 0;
    }
}
EXPORT ALCdevice *alcCaptureOpenDevice(const ALCchar *n, ALCuint f, ALCenum fmt, ALCsizei s) { (void)n; (void)f; (void)fmt; (void)s; return NULL; }
EXPORT ALCboolean alcCaptureCloseDevice(ALCdevice *d) { (void)d; return 0; }
EXPORT void alcCaptureStart(ALCdevice *d) { (void)d; }
EXPORT void alcCaptureStop(ALCdevice *d) { (void)d; }
EXPORT void alcCaptureSamples(ALCdevice *d, ALCvoid *b, ALCsizei s) { (void)d; (void)b; (void)s; }

/* ======================================================================== AL: allgemein */
EXPORT void alEnable(ALenum c) { if (c == AL_SOURCE_DISTANCE_MODEL) srcDistModel = 1; }
EXPORT void alDisable(ALenum c) { if (c == AL_SOURCE_DISTANCE_MODEL) srcDistModel = 0; }
EXPORT ALboolean alIsEnabled(ALenum c) { return c == AL_SOURCE_DISTANCE_MODEL ? (ALboolean)srcDistModel : 0; }
EXPORT const ALchar *alGetString(ALenum p) {
    switch (p) {
    case AL_VENDOR: return "NUTclient";
    case AL_VERSION: return "1.1 NUTclient iOS";
    case AL_RENDERER: return "NUTclient Software-Mischer";
    case AL_EXTENSIONS: return "AL_EXT_source_distance_model AL_EXT_LINEAR_DISTANCE AL_EXT_EXPONENT_DISTANCE AL_EXT_FLOAT32";
    }
    return NULL;
}
static float getf(ALenum p) {
    switch (p) {
    case AL_DOPPLER_FACTOR: return 1;
    case AL_DOPPLER_VELOCITY: return 1;
    case AL_SPEED_OF_SOUND: return 343.3f;
    case AL_DISTANCE_MODEL: return (float)distModel;
    }
    return 0;
}
EXPORT void alGetBooleanv(ALenum p, ALboolean *v) { if (v) *v = getf(p) != 0; }
EXPORT void alGetIntegerv(ALenum p, ALint *v) { if (v) *v = (ALint)getf(p); }
EXPORT void alGetFloatv(ALenum p, ALfloat *v) { if (v) *v = getf(p); }
EXPORT void alGetDoublev(ALenum p, ALdouble *v) { if (v) *v = getf(p); }
EXPORT ALboolean alGetBoolean(ALenum p) { return getf(p) != 0; }
EXPORT ALint alGetInteger(ALenum p) { return (ALint)getf(p); }
EXPORT ALfloat alGetFloat(ALenum p) { return getf(p); }
EXPORT ALdouble alGetDouble(ALenum p) { return getf(p); }
EXPORT ALenum alGetError(void) { ALenum e = err; err = 0; return e; }
EXPORT ALboolean alIsExtensionPresent(const ALchar *e) {
    static const char *have[] = {"AL_EXT_source_distance_model", "AL_EXT_LINEAR_DISTANCE", "AL_EXT_EXPONENT_DISTANCE", "AL_EXT_FLOAT32", NULL};
    for (int i = 0; e && have[i]; i++) if (!strcasecmp(e, have[i])) return 1;
    return 0;
}
EXPORT void *alGetProcAddress(const ALchar *n) { return selfSym(n); }
EXPORT ALenum alGetEnumValue(const ALchar *n) { (void)n; return 0; }
EXPORT void alDopplerFactor(ALfloat v) { (void)v; }
EXPORT void alDopplerVelocity(ALfloat v) { (void)v; }
EXPORT void alSpeedOfSound(ALfloat v) { (void)v; }
EXPORT void alDistanceModel(ALenum m) { distModel = m; }

/* ======================================================================== Hörer */
EXPORT void alListenerf(ALenum p, ALfloat v) { if (p == AL_GAIN) lgain = v; }
EXPORT void alListener3f(ALenum p, ALfloat a, ALfloat b, ALfloat c) {
    pthread_mutex_lock(&lk);
    if (p == AL_POSITION) { lpos[0] = a; lpos[1] = b; lpos[2] = c; }
    else if (p == AL_VELOCITY) { lvel[0] = a; lvel[1] = b; lvel[2] = c; }
    pthread_mutex_unlock(&lk);
}
EXPORT void alListenerfv(ALenum p, const ALfloat *v) {
    if (!v) return;
    if (p == AL_ORIENTATION) {
        pthread_mutex_lock(&lk);
        memcpy(lat, v, 3 * sizeof(float)); memcpy(lup, v + 3, 3 * sizeof(float));
        pthread_mutex_unlock(&lk);
    } else if (p == AL_GAIN) lgain = v[0];
    else alListener3f(p, v[0], v[1], v[2]);
}
EXPORT void alListeneri(ALenum p, ALint v) { alListenerf(p, (float)v); }
EXPORT void alListener3i(ALenum p, ALint a, ALint b, ALint c) { alListener3f(p, a, b, c); }
EXPORT void alListeneriv(ALenum p, const ALint *v) {
    if (!v) return;
    if (p == AL_ORIENTATION) { float f[6]; for (int i = 0; i < 6; i++) f[i] = (float)v[i]; alListenerfv(p, f); }
    else alListener3f(p, v[0], v[1], v[2]);
}
EXPORT void alGetListenerf(ALenum p, ALfloat *v) { if (v) *v = p == AL_GAIN ? lgain : 0; }
EXPORT void alGetListener3f(ALenum p, ALfloat *a, ALfloat *b, ALfloat *c) {
    float *s = p == AL_POSITION ? lpos : lvel;
    if (a) *a = s[0]; if (b) *b = s[1]; if (c) *c = s[2];
}
EXPORT void alGetListenerfv(ALenum p, ALfloat *v) {
    if (!v) return;
    if (p == AL_ORIENTATION) { memcpy(v, lat, 12); memcpy(v + 3, lup, 12); }
    else if (p == AL_GAIN) *v = lgain;
    else alGetListener3f(p, v, v + 1, v + 2);
}
EXPORT void alGetListeneri(ALenum p, ALint *v) { float f = 0; alGetListenerf(p, &f); if (v) *v = (ALint)f; }
EXPORT void alGetListener3i(ALenum p, ALint *a, ALint *b, ALint *c) {
    float x, y, z; alGetListener3f(p, &x, &y, &z);
    if (a) *a = (ALint)x; if (b) *b = (ALint)y; if (c) *c = (ALint)z;
}
EXPORT void alGetListeneriv(ALenum p, ALint *v) { float f[6] = {0}; alGetListenerfv(p, f); if (v) for (int i = 0; i < (p == AL_ORIENTATION ? 6 : 3); i++) v[i] = (ALint)f[i]; }

/* ======================================================================== Quellen */
static void resetSource(Source *s) {
    memset(s, 0, sizeof *s);
    s->used = 1; s->state = AL_INITIAL; s->pitch = 1; s->gain = 1; s->maxGain = 1;
    s->refDist = 1; s->rolloff = 1; s->maxDist = 3.4e38f;
}
EXPORT void alGenSources(ALsizei n, ALuint *ids) {
    pthread_mutex_lock(&lk);
    for (int k = 0; k < n; k++) {
        int i = 1;
        while (i < MAXSRC && sources[i].used) i++;
        if (i >= MAXSRC) { setErr(AL_INVALID_VALUE); ids[k] = 0; continue; }
        resetSource(&sources[i]);
        ids[k] = (ALuint)i;
    }
    pthread_mutex_unlock(&lk);
}
EXPORT void alDeleteSources(ALsizei n, const ALuint *ids) {
    pthread_mutex_lock(&lk);
    for (int k = 0; k < n; k++) if (src(ids[k])) sources[ids[k]].used = 0;
    pthread_mutex_unlock(&lk);
}
EXPORT ALboolean alIsSource(ALuint id) { return src(id) != NULL; }

EXPORT void alSourcef(ALuint id, ALenum p, ALfloat v) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    switch (p) {
    case AL_PITCH: s->pitch = fmaxf(0.01f, v); break;
    case AL_GAIN: s->gain = v; break;
    case AL_MIN_GAIN: s->minGain = v; break;
    case AL_MAX_GAIN: s->maxGain = v; break;
    case AL_REFERENCE_DISTANCE: s->refDist = v; break;
    case AL_ROLLOFF_FACTOR: s->rolloff = v; break;
    case AL_MAX_DISTANCE: s->maxDist = v; break;
    case AL_SEC_OFFSET: { Buffer *b = buf(s->queue[s->qpos]); if (b) s->cursor = v * b->freq; break; }
    case AL_SAMPLE_OFFSET: s->cursor = v; break;
    }
    pthread_mutex_unlock(&lk);
}
EXPORT void alSource3f(ALuint id, ALenum p, ALfloat a, ALfloat b, ALfloat c) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    float *t = p == AL_POSITION ? s->pos : p == AL_VELOCITY ? s->vel : p == AL_DIRECTION ? s->dir : NULL;
    if (!t) return;
    pthread_mutex_lock(&lk);
    t[0] = a; t[1] = b; t[2] = c;
    pthread_mutex_unlock(&lk);
}
EXPORT void alSourcefv(ALuint id, ALenum p, const ALfloat *v) {
    if (!v) return;
    if (p == AL_POSITION || p == AL_VELOCITY || p == AL_DIRECTION) alSource3f(id, p, v[0], v[1], v[2]);
    else alSourcef(id, p, v[0]);
}
static void setBuffer(Source *s, ALuint b) {
    s->qn = 0; s->qpos = 0; s->cursor = 0; s->processed = 0;
    if (b) { s->queue[0] = b; s->qn = 1; s->isStatic = 1; } else s->isStatic = 0;
}
EXPORT void alSourcei(ALuint id, ALenum p, ALint v) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    switch (p) {
    case AL_SOURCE_RELATIVE: s->relative = v; break;
    case AL_LOOPING: s->looping = v; break;
    case AL_BUFFER: setBuffer(s, (ALuint)v); break;
    case AL_SAMPLE_OFFSET: s->cursor = v; break;
    case AL_DISTANCE_MODEL: s->distModel = v; break;
    default: pthread_mutex_unlock(&lk); alSourcef(id, p, (float)v); return;
    }
    pthread_mutex_unlock(&lk);
}
EXPORT void alSource3i(ALuint id, ALenum p, ALint a, ALint b, ALint c) { alSource3f(id, p, a, b, c); }
EXPORT void alSourceiv(ALuint id, ALenum p, const ALint *v) {
    if (!v) return;
    if (p == AL_POSITION || p == AL_VELOCITY || p == AL_DIRECTION) alSource3f(id, p, v[0], v[1], v[2]);
    else alSourcei(id, p, v[0]);
}
EXPORT void alGetSourcef(ALuint id, ALenum p, ALfloat *v) {
    Source *s = src(id);
    if (!s || !v) { setErr(AL_INVALID_NAME); return; }
    switch (p) {
    case AL_PITCH: *v = s->pitch; break;
    case AL_GAIN: *v = s->gain; break;
    case AL_MIN_GAIN: *v = s->minGain; break;
    case AL_MAX_GAIN: *v = s->maxGain; break;
    case AL_REFERENCE_DISTANCE: *v = s->refDist; break;
    case AL_ROLLOFF_FACTOR: *v = s->rolloff; break;
    case AL_MAX_DISTANCE: *v = s->maxDist; break;
    case AL_SEC_OFFSET: { Buffer *b = buf(s->queue[s->qpos]); *v = b ? (float)(s->cursor / b->freq) : 0; break; }
    case AL_SAMPLE_OFFSET: *v = (float)s->cursor; break;
    default: *v = 0;
    }
}
EXPORT void alGetSource3f(ALuint id, ALenum p, ALfloat *a, ALfloat *b, ALfloat *c) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    float *t = p == AL_POSITION ? s->pos : p == AL_VELOCITY ? s->vel : s->dir;
    if (a) *a = t[0]; if (b) *b = t[1]; if (c) *c = t[2];
}
EXPORT void alGetSourcefv(ALuint id, ALenum p, ALfloat *v) {
    if (!v) return;
    if (p == AL_POSITION || p == AL_VELOCITY || p == AL_DIRECTION) alGetSource3f(id, p, v, v + 1, v + 2);
    else alGetSourcef(id, p, v);
}
EXPORT void alGetSourcei(ALuint id, ALenum p, ALint *v) {
    Source *s = src(id);
    if (!s || !v) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    switch (p) {
    case AL_SOURCE_STATE: *v = s->state; break;
    case AL_BUFFERS_QUEUED: *v = s->qn; break;
    case AL_BUFFERS_PROCESSED: *v = s->isStatic ? 0 : (s->state == AL_STOPPED ? s->qn : s->processed); break;
    case AL_LOOPING: *v = s->looping; break;
    case AL_DISTANCE_MODEL: *v = s->distModel ? s->distModel : distModel; break;
    case AL_SOURCE_RELATIVE: *v = s->relative; break;
    case AL_BUFFER: *v = s->qn ? (ALint)s->queue[s->qpos] : 0; break;
    case AL_SOURCE_TYPE: *v = s->qn == 0 ? AL_UNDETERMINED : s->isStatic ? AL_STATIC : AL_STREAMING; break;
    case AL_SAMPLE_OFFSET: *v = (ALint)s->cursor; break;
    default: { float f = 0; pthread_mutex_unlock(&lk); alGetSourcef(id, p, &f); *v = (ALint)f; return; }
    }
    pthread_mutex_unlock(&lk);
}
EXPORT void alGetSource3i(ALuint id, ALenum p, ALint *a, ALint *b, ALint *c) {
    float x, y, z; alGetSource3f(id, p, &x, &y, &z);
    if (a) *a = (ALint)x; if (b) *b = (ALint)y; if (c) *c = (ALint)z;
}
EXPORT void alGetSourceiv(ALuint id, ALenum p, ALint *v) {
    if (!v) return;
    if (p == AL_POSITION || p == AL_VELOCITY || p == AL_DIRECTION) alGetSource3i(id, p, v, v + 1, v + 2);
    else alGetSourcei(id, p, v);
}

static void setState(ALuint id, int st) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    if (st == AL_PLAYING && s->state != AL_PAUSED) { s->cursor = 0; s->qpos = 0; s->processed = 0; }
    if (st == AL_INITIAL) { s->cursor = 0; s->qpos = 0; s->processed = 0; }
    if (st == AL_STOPPED && !s->isStatic) s->processed = s->qn;
    s->state = st;
    pthread_mutex_unlock(&lk);
}
EXPORT void alSourcePlay(ALuint id) { setState(id, AL_PLAYING); }
EXPORT void alSourceStop(ALuint id) { setState(id, AL_STOPPED); }
EXPORT void alSourceRewind(ALuint id) { setState(id, AL_INITIAL); }
EXPORT void alSourcePause(ALuint id) { setState(id, AL_PAUSED); }
EXPORT void alSourcePlayv(ALsizei n, const ALuint *ids) { for (int i = 0; i < n; i++) alSourcePlay(ids[i]); }
EXPORT void alSourceStopv(ALsizei n, const ALuint *ids) { for (int i = 0; i < n; i++) alSourceStop(ids[i]); }
EXPORT void alSourceRewindv(ALsizei n, const ALuint *ids) { for (int i = 0; i < n; i++) alSourceRewind(ids[i]); }
EXPORT void alSourcePausev(ALsizei n, const ALuint *ids) { for (int i = 0; i < n; i++) alSourcePause(ids[i]); }

EXPORT void alSourceQueueBuffers(ALuint id, ALsizei n, const ALuint *ids) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    if (s->isStatic) { s->qn = 0; s->qpos = 0; s->isStatic = 0; }
    for (int i = 0; i < n && s->qn < MAXQ; i++) s->queue[s->qn++] = ids[i];
    pthread_mutex_unlock(&lk);
}
EXPORT void alSourceUnqueueBuffers(ALuint id, ALsizei n, ALuint *ids) {
    Source *s = src(id);
    if (!s) { setErr(AL_INVALID_NAME); return; }
    pthread_mutex_lock(&lk);
    int done = s->state == AL_STOPPED ? s->qn : s->processed;
    if (n > done) { n = done; setErr(AL_INVALID_VALUE); }
    for (int i = 0; i < n; i++) ids[i] = s->queue[i];
    memmove(s->queue, s->queue + n, sizeof(ALuint) * (size_t)(s->qn - n));
    s->qn -= n;
    s->qpos = s->qpos >= n ? s->qpos - n : 0;
    s->processed -= n;
    if (s->processed < 0) s->processed = 0;
    pthread_mutex_unlock(&lk);
}

/* ======================================================================== Puffer */
EXPORT void alGenBuffers(ALsizei n, ALuint *ids) {
    pthread_mutex_lock(&lk);
    for (int k = 0; k < n; k++) {
        int i = 1;
        while (i < MAXBUF && buffers[i].used) i++;
        if (i >= MAXBUF) { setErr(AL_INVALID_VALUE); ids[k] = 0; continue; }
        memset(&buffers[i], 0, sizeof(Buffer));
        buffers[i].used = 1; buffers[i].freq = 44100; buffers[i].channels = 1;
        ids[k] = (ALuint)i;
    }
    pthread_mutex_unlock(&lk);
}
EXPORT void alDeleteBuffers(ALsizei n, const ALuint *ids) {
    pthread_mutex_lock(&lk);
    for (int k = 0; k < n; k++) {
        Buffer *b = buf(ids[k]);
        if (b) { free(b->data); memset(b, 0, sizeof *b); }
    }
    pthread_mutex_unlock(&lk);
}
EXPORT ALboolean alIsBuffer(ALuint id) { return buf(id) != NULL; }
EXPORT void alBufferData(ALuint id, ALenum fmt, const ALvoid *data, ALsizei size, ALsizei freq) {
    Buffer *b = buf(id);
    if (!b) { setErr(AL_INVALID_NAME); return; }
    int ch, bytes;
    switch (fmt) {
    case AL_FORMAT_MONO8: ch = 1; bytes = 1; break;
    case AL_FORMAT_MONO16: ch = 1; bytes = 2; break;
    case AL_FORMAT_STEREO8: ch = 2; bytes = 1; break;
    case AL_FORMAT_STEREO16: ch = 2; bytes = 2; break;
    case AL_FORMAT_MONO_FLOAT32: ch = 1; bytes = 4; break;
    case AL_FORMAT_STEREO_FLOAT32: ch = 2; bytes = 4; break;
    default: setErr(AL_INVALID_ENUM); return;
    }
    int samples = size / bytes;
    float *f = malloc(sizeof(float) * (size_t)(samples > 0 ? samples : 1));
    for (int i = 0; i < samples; i++) {
        if (bytes == 1) f[i] = (((const unsigned char *)data)[i] - 128) / 128.0f;
        else if (bytes == 2) f[i] = ((const short *)data)[i] / 32768.0f;
        else f[i] = ((const float *)data)[i];
    }
    pthread_mutex_lock(&lk);
    free(b->data);
    b->data = f; b->channels = ch; b->frames = samples / ch; b->freq = freq > 0 ? freq : 44100;
    pthread_mutex_unlock(&lk);
}
EXPORT void alBufferf(ALuint id, ALenum p, ALfloat v) { (void)id; (void)p; (void)v; }
EXPORT void alBuffer3f(ALuint id, ALenum p, ALfloat a, ALfloat b, ALfloat c) { (void)id; (void)p; (void)a; (void)b; (void)c; }
EXPORT void alBufferfv(ALuint id, ALenum p, const ALfloat *v) { (void)id; (void)p; (void)v; }
EXPORT void alBufferi(ALuint id, ALenum p, ALint v) { (void)id; (void)p; (void)v; }
EXPORT void alBuffer3i(ALuint id, ALenum p, ALint a, ALint b, ALint c) { (void)id; (void)p; (void)a; (void)b; (void)c; }
EXPORT void alBufferiv(ALuint id, ALenum p, const ALint *v) { (void)id; (void)p; (void)v; }
EXPORT void alGetBufferi(ALuint id, ALenum p, ALint *v) {
    Buffer *b = buf(id);
    if (!b || !v) { setErr(AL_INVALID_NAME); return; }
    switch (p) {
    case AL_FREQUENCY: *v = b->freq; break;
    case AL_BITS: *v = 16; break;
    case AL_CHANNELS: *v = b->channels; break;
    case AL_SIZE: *v = b->frames * b->channels * 2; break;
    default: *v = 0;
    }
}
EXPORT void alGetBufferf(ALuint id, ALenum p, ALfloat *v) { ALint i = 0; alGetBufferi(id, p, &i); if (v) *v = (float)i; }
EXPORT void alGetBuffer3f(ALuint id, ALenum p, ALfloat *a, ALfloat *b, ALfloat *c) { (void)id; (void)p; if (a) *a = 0; if (b) *b = 0; if (c) *c = 0; }
EXPORT void alGetBufferfv(ALuint id, ALenum p, ALfloat *v) { alGetBufferf(id, p, v); }
EXPORT void alGetBuffer3i(ALuint id, ALenum p, ALint *a, ALint *b, ALint *c) { (void)id; (void)p; if (a) *a = 0; if (b) *b = 0; if (c) *c = 0; }
EXPORT void alGetBufferiv(ALuint id, ALenum p, ALint *v) { alGetBufferi(id, p, v); }
