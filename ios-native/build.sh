#!/bin/bash
# NUTclient iOS – baut die eigene Bibliothek nutgl (GLFW + OpenGL-Brücke) und legt sie mit den LWJGL-Bausteinen in die App:
#   <App>/lwjgl/libnutgl.dylib        eigener Code (ios-native/nutgl)
#   <App>/lwjgl/liblwjgl*.dylib       offizielle LWJGL-3.3.3-Bausteine (BSD-Lizenz) von Maven Central, für iOS umgestempelt
# Aufruf (nur auf dem Mac): ios-native/build.sh "<Pfad zur .app>" device|sim
set -e
APP="$(cd "$1" && pwd)"
MODE="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/nutgl"
mkdir -p "$WORK" "$APP/lwjgl"

if [ "$MODE" = "sim" ]; then SDKN=iphonesimulator; TARGET=arm64-apple-ios15.0-simulator; PLAT=7
else SDKN=iphoneos; TARGET=arm64-apple-ios15.0; PLAT=2; fi
SDK="$(xcrun --sdk $SDKN --show-sdk-path)"

# ---- 1. OpenGL-Funktionsliste → eigene Brücke erzeugen
[ -f "$WORK/gl.xml" ] || curl -fsSL -o "$WORK/gl.xml" https://raw.githubusercontent.com/KhronosGroup/OpenGL-Registry/main/xml/gl.xml
node "$HERE/nutgl/gen-gl.mjs" "$WORK/gl.xml" "$HERE/nutgl/gl_overrides.c" "$WORK/gen"

# ---- 2. nutgl bauen
xcrun --sdk $SDKN clang -target $TARGET -isysroot "$SDK" -dynamiclib -O2 -fobjc-arc -fvisibility=hidden \
  -Wno-deprecated-declarations -Wno-incompatible-function-pointer-types -I "$WORK/gen" \
  "$WORK/gen/gl_gen.c" "$HERE/nutgl/gl_overrides.c" "$HERE/nutgl/glsl_fix.c" "$HERE/nutgl/glfw.m" \
  -framework UIKit -framework QuartzCore -framework OpenGLES -framework Foundation \
  -install_name @rpath/libnutgl.dylib -o "$APP/lwjgl/libnutgl.dylib"
echo "nutgl: $(du -h "$APP/lwjgl/libnutgl.dylib" | cut -f1), $(nm -gU "$APP/lwjgl/libnutgl.dylib" | grep -c ' _glfw') GLFW- und $(nm -gU "$APP/lwjgl/libnutgl.dylib" | grep -c ' _gl[A-Z]') GL-Funktionen"

# ---- 2b. eigenes OpenAL (Ton) bauen – statt OpenAL Soft, das auf iOS nicht läuft
xcrun --sdk $SDKN clang -target $TARGET -isysroot "$SDK" -dynamiclib -O2 -fobjc-arc -fvisibility=hidden   "$HERE/nutal/nutal.m" -framework AudioToolbox -framework AVFoundation -framework Foundation   -install_name @rpath/libnutal.dylib -o "$APP/lwjgl/libnutal.dylib"
rm -f "$APP/lwjgl/libopenal.dylib"
echo "nutal: $(nm -gU "$APP/lwjgl/libnutal.dylib" | grep -c " _al") OpenAL-Funktionen"

# ---- 3. LWJGL 3.3.3 (Minecraft 1.21.11): macOS-arm64-Bausteine holen und für iOS umstempeln
V=3.3.3
for M in lwjgl lwjgl-opengl lwjgl-stb lwjgl-freetype lwjgl-tinyfd lwjgl-jemalloc; do
  J="$WORK/$M-$V.jar"
  [ -f "$J" ] || curl -fsSL -o "$J" "https://repo1.maven.org/maven2/org/lwjgl/$M/$V/$M-$V-natives-macos-arm64.jar"
  unzip -o -j -q "$J" "*.dylib" -d "$APP/lwjgl/"
done
# JNA (Minecraft nutzt es über oshi und java-objc-bridge): dessen Mac-Baustein ebenso umstempeln
JNA=5.17.0
[ -f "$WORK/jna-$JNA.jar" ] || curl -fsSL -o "$WORK/jna-$JNA.jar" "https://repo1.maven.org/maven2/net/java/dev/jna/jna/$JNA/jna-$JNA.jar"
unzip -o -j -q "$WORK/jna-$JNA.jar" "com/sun/jna/darwin-aarch64/libjnidispatch.jnilib" -d "$WORK/"
cp "$WORK/libjnidispatch.jnilib" "$APP/lwjgl/libjnidispatch.dylib"
for f in "$APP"/lwjgl/*.dylib; do
  case "$f" in *libnutgl.dylib|*libnutal.dylib) ;; *)
    echo "== $(basename "$f")"; otool -L "$f" | tail -n +2 | sed 's/ (.*//'
    # Mehrfach-Bausteine (x86_64 + arm64) auf arm64 reduzieren
    if [ "$(lipo -archs "$f" 2>/dev/null)" != "arm64" ]; then lipo -thin arm64 "$f" -output "$f.tmp" && mv "$f.tmp" "$f"; fi
    xcrun vtool -set-build-version $PLAT 15.0 17.0 -replace -output "$f.tmp" "$f" >/dev/null && mv "$f.tmp" "$f"
    # macOS-Pfade der Systembibliotheken → iOS-Pfade (dort ohne „Versions/A“); ApplicationServices gibt es auf iOS nicht
    for dep in $(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep '^/System/Library/Frameworks/'); do
      fw=$(basename "$(dirname "$(dirname "$(dirname "$dep")")")" .framework)
      case "$dep" in */Versions/*) ;; *) fw=$(basename "$(dirname "$dep")" .framework) ;; esac
      [ "$fw" = "ApplicationServices" ] && fw=CoreFoundation
      new="/System/Library/Frameworks/$fw.framework/$fw"
      [ "$dep" != "$new" ] && install_name_tool -change "$dep" "$new" "$f" 2>/dev/null
    done
    otool -L "$f" | tail -n +2 | sed 's/ (.*//;s/^/   -> /' ;;
  esac
  codesign -f -s - "$f" >/dev/null 2>&1 || echo "codesign fehlgeschlagen: $f"
done
cp "$APP/lwjgl/libjnidispatch.dylib" "$APP/lwjgl/libjnidispatch.jnilib"

# ---- 4. eigener Ersatz für java-objc-bridge (die echte entpackt eine Mac-Bibliothek, die auf dem iPhone nicht lädt)
JB="${JAVA_HOME_21_arm64:-${JAVA_HOME:-}}"; JAVAC=javac; JARX=jar
[ -n "$JB" ] && [ -x "$JB/bin/javac" ] && JAVAC="$JB/bin/javac" && JARX="$JB/bin/jar"
rm -rf "$WORK/objc" && mkdir -p "$WORK/objc"
"$JAVAC" --release 17 -cp "$WORK/jna-$JNA.jar" -d "$WORK/objc" "$HERE"/objc-stub/ca/weblite/objc/*.java "$HERE"/objc-stub/nut/ios/*.java
"$JARX" cf "$APP/lwjgl/nut-objc.jar" -C "$WORK/objc" .
echo "nut-objc.jar: $(du -h "$APP/lwjgl/nut-objc.jar" | cut -f1)"
ls -la "$APP/lwjgl"
