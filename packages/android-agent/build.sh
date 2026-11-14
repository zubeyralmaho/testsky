#!/bin/bash
# Builds testsky-agent.jar: the agent's Java compiled against the platform's
# public API, then dexed so app_process can load it. Needs a JDK (17+) and the
# Android SDK's build-tools and one platform.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
D8="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/d8"
OUT="$HERE/build"
rm -rf "$OUT" && mkdir -p "$OUT/classes"
javac -source 17 -target 17 -Xlint:-options -cp "$PLATFORM/android.jar" -d "$OUT/classes" $(find "$HERE/java" -name '*.java')
"$D8" --min-api 28 --lib "$PLATFORM/android.jar" --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && zip -q testsky-agent.jar classes.dex)
echo "$OUT/testsky-agent.jar ($(wc -c < "$OUT/testsky-agent.jar") bytes, $(basename "$PLATFORM"))"
