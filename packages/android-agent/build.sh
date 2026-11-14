#!/bin/bash
# Builds dist/testsky-agent.jar: the agent's Java compiled against the
# platform's public API, then dexed so app_process can load it. Needs a JDK
# (17+) and the Android SDK's build-tools and one platform. The jar is kept in
# the repository, so a rig that runs testsky needs neither.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
D8="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/d8"
WORK="$HERE/build"
rm -rf "$WORK" && mkdir -p "$WORK/classes" "$HERE/dist"
javac -source 17 -target 17 -Xlint:-options -cp "$PLATFORM/android.jar" -d "$WORK/classes" $(find "$HERE/java" -name '*.java')
"$D8" --release --min-api 28 --lib "$PLATFORM/android.jar" --output "$WORK" $(find "$WORK/classes" -name '*.class')
rm -f "$HERE/dist/testsky-agent.jar"
(cd "$WORK" && zip -q -X "$HERE/dist/testsky-agent.jar" classes.dex)
echo "$HERE/dist/testsky-agent.jar ($(wc -c < "$HERE/dist/testsky-agent.jar") bytes, $(basename "$PLATFORM"))"
