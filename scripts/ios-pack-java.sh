#!/bin/bash
# Packt die Java-Laufzeit (OpenJDK fürs iPhone, GPLv2 + Classpath-Ausnahme) in die fertige App: <App>/java/<Version>/
# Aufruf (nur auf dem Mac in .github/workflows/ios.yml): scripts/ios-pack-java.sh "<Pfad zur .app>" device|sim
# iOS lädt nur Bibliotheken, die mit der App signiert sind – deshalb kommt Java beim Bauen mit hinein, nicht zur Laufzeit.
# sim: die Bibliotheken sind fürs echte iPhone gebaut; für den Simulator wird die Plattform-Kennung umgeschrieben
# (vtool, Plattform 7 = iOS-Simulator) und neu signiert (ad hoc). Das echte iPhone bekommt sie unverändert.
set -e
APP="$(cd "$1" && pwd)"   # absolut – das Skript wechselt unterwegs den Ordner
MODE="$2"
VERSIONS="${JAVA_VERSIONS:-21}"
WORK="${RUNNER_TEMP:-/tmp}/nut-jre"

for V in $VERSIONS; do
  mkdir -p "$WORK/$V"
  pushd "$WORK/$V" >/dev/null
  [ -f jre.zip ] || curl -fsSL -o jre.zip "https://assets.angelauramc.dev/openjdk/ios-arm64/jre$V-ios-aarch64.zip"
  rm -rf x && mkdir x
  unzip -oq jre.zip -d z
  T=$(find z -name "*.tar.xz" | head -1)
  if [ -n "$T" ]; then tar xf "$T" -C x; else cp -R z/. x/; fi
  # falls alles in einem Unterordner steckt
  SRC=x
  if [ ! -d x/lib ] && [ "$(ls x | wc -l)" -eq 1 ]; then SRC="x/$(ls x)"; fi
  D="$APP/java/$V"
  rm -rf "$D" && mkdir -p "$D"
  cp -R "$SRC"/. "$D"/
  # Unnötiges raus – die Lizenztexte (legal/, LICENSE, ASSEMBLY_EXCEPTION) bleiben drin
  rm -rf "$D/bin" "$D/include" "$D/man" "$D/jmods" "$D/demo" "$D/sample" "$D/lib/src.zip" "$D/lib/ct.sym"
  popd >/dev/null
  echo "Java $V: $(du -sh "$D" | cut -f1)"
  find "$D" -name "libjvm.dylib"
done

if [ "$MODE" = "sim" ]; then
  n=0
  while IFS= read -r f; do
    if file "$f" | grep -q "Mach-O"; then
      xcrun vtool -set-build-version 7 14.0 17.0 -replace -output "$f.tmp" "$f" >/dev/null 2>&1 && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "vtool übersprungen: $f"; }
      codesign -f -s - "$f" >/dev/null 2>&1 || echo "codesign fehlgeschlagen: $f"
      n=$((n+1))
    fi
  done < <(find "$APP/java" -type f \( -name "*.dylib" -o -perm -u+x \))
  echo "Für den Simulator umgeschrieben: $n Dateien"
fi
